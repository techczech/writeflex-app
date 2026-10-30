// The floating Scratchpad's write paths in the renderer (ticket 01, spec §6): Send a copy, Cut, Insert a
// copy and Put back. The ordering rule is the whole point: a cut keeps the words in the document until
// the Scratchpad holds them, and removes them only if the same window, folder, document and untouched
// span are still in front of the writer. A failure leaves the text where it is and says so.
import type { EditorState } from '@codemirror/state'
import { selectCurrentSection } from '@app-patterns/outline'
import { anchorDiff, beginCapture, captureIsCurrent, finishCut, forgetCapture, insertInlineTracked, insertWithAnchor, insertAssetWithAnchor, insertionPoint, liveAnchors, removeAnchorText, removeTrackedInline, writableState, type EditorPort } from './scratchpad-editor'
import { canPutBack, type ScratchItem, type ScratchReferenceAction, type ScratchpadBridge } from '../../../shared/scratchpad-items'

export type ControllerPorts = {
  bridge: ScratchpadBridge
  /** The editor showing the active document, or null. */
  view: () => EditorPort | null
  /** The folder this window is bound to now. */
  root: () => string | null
  /** The workspace-relative path of the document in the editor now. */
  activePath: () => string | null
  /** The status line, with an optional Undo. */
  say: (message: string, action?: { label: string; run: () => void }) => void
  /** How a document is named to the writer (a Folio part's title, or the file name). */
  partName: (path: string) => string
  /** The editor shows the live, editable document now: not a saved version, a past session's recall or
   *  a detached document. Asked together with the state's own read-only facet before every write. */
  editable?: () => boolean
  /** The Scratchpad is suspended (the widget workbench covers the ordinary editor): no Scratchpad
   *  action may select, capture or write in the hidden editor. Asked again after every await, so an
   *  action started before the suspension cannot land in the covered editor either. */
  suspended?: () => boolean
}

export type CutOutcome = 'cut' | 'cut-recorded-as-copy' | 'kept-as-copy' | 'failed' | 'nothing'
export type InsertOutcome = 'inserted' | 'refused'

const describe = (markdown: string): string => {
  const words = markdown.trim().split(/\s+/).filter(Boolean).length
  return words === 1 ? '1 word' : `${words} words`
}
let useCounter = 0
const newUseId = (): string => `u_${Date.now().toString(36)}${(useCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

const READ_ONLY = 'This is a saved version, not the current text, so the Scratchpad did not change it. Return to the current text first.'
export const SCRATCHPAD_SUSPENDED = 'The Scratchpad is paused while the widget workbench is open, so nothing was changed in the covered text. Go back to the document to use it.'

export function createScratchpadController(ports: ControllerPorts) {
  const where = () => ({ view: ports.view(), root: ports.root(), path: ports.activePath() })
  const suspended = (): boolean => ports.suspended?.() ?? false
  /** Why this editor must not be written now, naming the suspension when that is the cause. */
  const notWritable = (): string => (suspended() ? SCRATCHPAD_SUSPENDED : READ_ONLY)
  /** The live editable document is in front of the writer now (asked again after every await). */
  const writable = (view: EditorPort | null): view is EditorPort => !!view && !suspended() && writableState(view.state) && (ports.editable?.() ?? true)
  const unchanged = (then: ReturnType<typeof where>): boolean => {
    const now = where()
    return now.view === then.view && now.root === then.root && now.path === then.path
  }

  /**
   * Select the section (the selection bubble's first step): extend the selection to the heading at
   * the caret and everything under it, up to the next heading of the same or higher level. The same
   * editor command the registered `outline.selectCurrentSection` runs — one behaviour, two surfaces.
   * Selection only: nothing is captured or written until Send a copy or Cut is pressed.
   */
  function selectSection(): boolean {
    if (suspended()) { ports.say(SCRATCHPAD_SUSPENDED); return false }
    const then = where()
    if (!then.view || !then.path) { ports.say('Open a document first.'); return false }
    if (!writable(then.view)) { ports.say('This is a saved version, so nothing was selected for the Scratchpad. Return to the current text first.'); return false }
    const done = selectCurrentSection({ state: then.view.state, dispatch: (spec) => then.view!.dispatch(spec) })
    if (!done) ports.say('Put the caret in a heading or under one, then select the section.')
    return done
  }

  async function sendCopy(): Promise<'copied' | 'failed' | 'nothing'> {
    if (suspended()) { ports.say(SCRATCHPAD_SUSPENDED); return 'nothing' }
    const then = where()
    if (!then.view || !then.root || !then.path) { ports.say('Open a document and select text first.'); return 'nothing' }
    // A saved version's words are not the current document's; sending them would credit the wrong source.
    if (!writable(then.view)) { ports.say('This is a saved version, so nothing was sent: the Scratchpad would record it as text from the current document. Return to the current text, or Restore the version first.'); return 'nothing' }
    const capture = beginCapture(then.view, then.path)
    if (!capture) { ports.say('Select text first, then send a copy to the Scratchpad.'); return 'nothing' }
    forgetCapture(then.view, capture)
    const root = then.root
    const reply = await ports.bridge.sendText({ root, origin: capture.path, markdown: capture.markdown, heading: capture.heading })
    if (!reply.ok) { ports.say(`Nothing was sent: ${reply.error}`); return 'failed' }
    const id = reply.item.id
    ports.say(`Copied ${describe(capture.markdown)} to the Scratchpad. Your text is unchanged.`, {
      label: 'Undo',
      run: () => {
        void ports.bridge.discardCopy({ root, id }).then((undone) => ports.say(undone.ok ? 'Removed the new copy from the Scratchpad. Your document is unchanged.' : `The copy was kept: ${undone.error}`))
      },
    })
    return 'copied'
  }

  async function cut(): Promise<CutOutcome> {
    const then = where()
    if (!then.view || !then.root || !then.path) { ports.say('Open a document and select text first.'); return 'nothing' }
    if (!writable(then.view)) { ports.say(notWritable()); return 'nothing' }
    const capture = beginCapture(then.view, then.path)
    if (!capture) { ports.say('Select text first, then cut it to the Scratchpad.'); return 'nothing' }
    const root = then.root
    let reply: Awaited<ReturnType<ScratchpadBridge['sendText']>>
    try {
      reply = await ports.bridge.sendText({ root, origin: capture.path, markdown: capture.markdown, heading: capture.heading })
    } catch (error) {
      reply = { ok: false, error: error instanceof Error ? error.message : 'The Scratchpad did not answer.' }
    }
    if (!reply.ok) {
      if (ports.view() === then.view) forgetCapture(then.view, capture)
      ports.say(`Nothing was cut: ${reply.error} Your text is still in the document.`)
      return 'failed'
    }
    // The copy is durable. The words leave the document only if nothing moved under the capture.
    if (!unchanged(then) || !writable(then.view)) {
      if (ports.view() === then.view && writable(then.view)) forgetCapture(then.view, capture)
      ports.say(suspended()
        ? 'Saved a copy in the Scratchpad. The text was not removed, because the widget workbench opened while it was being saved.'
        : 'Saved a copy in the Scratchpad. The text was not removed, because the document changed while it was being saved.')
      return 'kept-as-copy'
    }
    if (!captureIsCurrent(then.view.state, capture)) {
      forgetCapture(then.view, capture)
      ports.say('Saved a copy in the Scratchpad. The text was not removed, because it was edited while it was being saved.')
      return 'kept-as-copy'
    }
    // A private reservation blocks withdrawal without claiming the text has already left the editor.
    const reserved = await ports.bridge.reserveCut({ root, id: reply.item.id }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : 'No answer.' }))
    if (!reserved.ok) {
      forgetCapture(then.view, capture)
      ports.say(`Nothing was cut: ${reserved.error} Your text is still in the document.`)
      return 'failed'
    }
    if (!unchanged(then) || !writable(then.view) || !captureIsCurrent(then.view.state, capture)) {
      forgetCapture(then.view, capture)
      await ports.bridge.cancelCut({ root, id: reply.item.id }).catch(() => undefined)
      ports.say(suspended()
        ? 'Saved a copy in the Scratchpad. The text was not removed, because the widget workbench opened while the cut was being prepared.'
        : 'Saved a copy in the Scratchpad. The text was not removed, because the document changed while the cut was being prepared.')
      return 'kept-as-copy'
    }
    if (finishCut(then.view, capture) === 'stale') {
      await ports.bridge.cancelCut({ root, id: reply.item.id }).catch(() => undefined)
      ports.say('Saved a copy in the Scratchpad. The text was not removed, because it was edited while the cut was being prepared.')
      return 'kept-as-copy'
    }
    const confirmed = await ports.bridge.confirmCut({ root, id: reply.item.id }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : 'No answer.' }))
    if (!confirmed.ok) {
      // Keep the reservation: its retained copy may now be the only durable text. Editor Undo remains.
      ports.say(`Cut ${describe(capture.markdown)} to the Scratchpad, where it is kept as a copy (${confirmed.error}). Undo in the text puts it back.`)
      return 'cut-recorded-as-copy'
    }
    ports.say(`Cut ${describe(capture.markdown)} to the Scratchpad. Undo in the text puts it back, and the scrap stays here.`)
    return 'cut'
  }

  async function insert(item: ScratchItem, mode: 'copy' | 'put-back'): Promise<InsertOutcome> {
    if (item.kind === 'ref' || item.kind === 'evidence') { ports.say('A reference is cited, linked or attached, not inserted. Use Cite, Insert link, Insert quote with citation or Attach to part.'); return 'refused' }
    if (mode === 'put-back' && !canPutBack(item)) { ports.say('Put back is only for text cut to the Scratchpad. Use Insert a copy.'); return 'refused' }
    const then = where()
    if (!then.view || !then.root || !then.path) { ports.say('Open a document to insert into.'); return 'refused' }
    if (!writable(then.view)) { ports.say(notWritable()); return 'refused' }
    const destinationState = then.view.state
    // A collected external candidate first copies its checked source bytes into this
    // document's assets/ in main (revalidated there: pointer, shown version, still-on
    // switch, destination); the returned Markdown names that local copy. Direct insert may
    // perform the import after the click — collecting never did.
    let copiedIn = false
    const reply = item.external
      ? await ports.bridge.externalImport({ root: then.root, id: item.id, destination: then.path }).then((done) => {
          if (done.ok) copiedIn = done.copied
          return done.ok ? { ok: true as const, markdown: done.markdown, rewritten: 0 } : done
        }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : 'No answer.' }))
      : await ports.bridge.prepareInsert({ root: then.root, id: item.id, destination: then.path }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : 'No answer.' }))
    if (!reply.ok) { ports.say(`Nothing was inserted: ${reply.error}`); return 'refused' }
    const copiedNote = copiedIn ? ' The file was copied into assets/ and stays recorded on the item.' : ''
    if (!unchanged(then)) { ports.say(`Nothing was inserted, because another document is open now. Insert again where you want it.${copiedNote}`); return 'refused' }
    if (!writable(then.view)) { ports.say(`Nothing was inserted. ${notWritable()}${copiedNote}`); return 'refused' }
    if (then.view.state.doc !== destinationState.doc || !then.view.state.selection.eq(destinationState.selection)) {
      ports.say(`Nothing was inserted, because the text or caret changed while the item was prepared. Insert again at the place you want.${copiedNote}`)
      return 'refused'
    }
    const view = then.view
    const useId = newUseId()
    try {
      if (item.kind === 'text') insertWithAnchor(view, insertionPoint(view.state), reply.markdown, { itemId: item.id, useId, mode })
      else insertAssetWithAnchor(view, item.kind, reply.markdown, { itemId: item.id, useId, mode })
    } catch (error) { ports.say(`Nothing was inserted: ${(error as Error).message}`); return 'refused' }
    const part = ports.partName(then.path)
    const undoInsert = (): void => {
      if (ports.view() !== view || ports.activePath() !== then.path || !writable(view)) { ports.say(`Nothing was taken out. ${notWritable()}`); return }
      const outcome = removeAnchorText(view, useId)
      if (outcome === 'edited') { ports.say('You have edited inside that insert since, so it was left as it is. Use Undo in the text (⌘Z) to step back through your edits.'); return }
      if (outcome !== 'removed') { ports.say('That insert is no longer where it was; use Undo in the text.'); return }
      ports.say(mode === 'put-back' ? 'Put back undone. The item is a candidate again.' : `Took the copy out of ${part}.`)
    }
    ports.say(
      mode === 'put-back' ? `Put back in ${part}. It left the Candidates list and appears under In this document.`
        : copiedIn ? 'Copied the file into assets/ and inserted it. The source is recorded on the item.'
        : `Inserted a copy in ${part}. The item stays in the Scratchpad.`,
      { label: 'Undo', run: undoInsert },
    )
    return 'inserted'
  }

  /**
   * The distinct reference acts (ticket 03, spec §5/§6). Main prepares the exact Markdown from the
   * canonical evidence as it stands; the editor writes it as ONE transaction in the part that is
   * open now, and only if window, folder, document, text and caret are unchanged since the click.
   * The candidate stays in the Scratchpad. Attach writes no text at all: it is main's evidence
   * operation, undone with the token that operation returns.
   */
  async function reference(item: ScratchItem, action: ScratchReferenceAction): Promise<InsertOutcome> {
    if (item.kind !== 'ref' && item.kind !== 'evidence') { ports.say('That item is not a reference or evidence.'); return 'refused' }
    const then = where()
    if (!then.view || !then.root || !then.path) { ports.say('Open a document first.'); return 'refused' }
    if (!writable(then.view)) { ports.say(notWritable()); return 'refused' }
    const part = ports.partName(then.path)
    if (action === 'attach') {
      const reply = await ports.bridge.attachReference({ root: then.root, id: item.id, destination: then.path }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : 'No answer.' }))
      if (!reply.ok) { ports.say(`Nothing was attached: ${reply.error}`); return 'refused' }
      const token = reply.token
      ports.say(`Attached ${reply.label} to ${reply.part} as evidence. The text is unchanged.`, token ? {
        label: 'Undo',
        run: () => {
          void ports.bridge.undoAttach({ root: then.root!, id: item.id, token, destination: then.path! })
            .then((undone) => ports.say(undone.ok ? `Undone. ${reply.label} is no longer attached to ${reply.part}.` : `That attach was kept: ${undone.error}`))
            .catch(() => ports.say('That attach was kept: the Scratchpad did not answer.'))
        },
      } : undefined)
      return 'inserted'
    }
    const destinationState = then.view.state
    const reply = await ports.bridge.prepareReference({ root: then.root, id: item.id, action, destination: then.path }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : 'No answer.' }))
    if (!reply.ok) { ports.say(`Nothing was written: ${reply.error}`); return 'refused' }
    if (!unchanged(then)) { ports.say('Nothing was written, because another document is open now. Try again where you want it.'); return 'refused' }
    if (!writable(then.view)) { ports.say(`Nothing was written. ${notWritable()}`); return 'refused' }
    if (then.view.state.doc !== destinationState.doc || !then.view.state.selection.eq(destinationState.selection)) {
      ports.say('Nothing was written, because the text or caret changed while it was prepared. Try again at the place you want.')
      return 'refused'
    }
    const view = then.view
    const useId = newUseId()
    try {
      if (reply.style === 'block') insertWithAnchor(view, insertionPoint(view.state), reply.markdown, { itemId: item.id, useId, mode: 'copy' })
      else insertInlineTracked(view, reply.markdown, useId)
    } catch (error) { ports.say(`Nothing was written: ${(error as Error).message}`); return 'refused' }
    const undoReference = (): void => {
      if (ports.view() !== view || ports.activePath() !== then.path || !writable(view)) { ports.say(`Nothing was taken out. ${notWritable()}`); return }
      const outcome = reply.style === 'block' ? removeAnchorText(view, useId) : removeTrackedInline(view, useId)
      if (outcome === 'edited') { ports.say('You have edited inside that insert since, so it was left as it is. Use Undo in the text (⌘Z).'); return }
      if (outcome !== 'removed') { ports.say('That insert is no longer where it was; use Undo in the text.'); return }
      ports.say(`Took the ${action === 'quote' ? 'quote' : action === 'cite' ? 'citation' : 'link'} out of ${part}.`)
    }
    ports.say(
      action === 'quote' ? `Inserted a quote from ${reply.label} in ${part}, with its citation.`
        : action === 'cite' ? `Cited ${reply.label} in ${part}.`
        : `Inserted a link to ${reply.label} in ${part}.`,
      { label: 'Undo', run: undoReference },
    )
    return 'inserted'
  }

  /** Persist the explicit uses the editor's anchors say exist: gained ones are recorded, lost ones dropped. */
  function syncAnchors(before: EditorState, after: EditorState): void {
    const root = ports.root()
    const path = ports.activePath()
    if (!root || !path) return
    const { added, removed } = anchorDiff(before, after)
    for (const anchor of added) {
      void ports.bridge.recordUse({ root, id: anchor.itemId, use: { useId: anchor.useId, path, mode: anchor.mode } }).then((reply) => {
        if (!reply.ok) ports.say(`The text is in the document, but the Scratchpad could not record where: ${reply.error}`)
      })
    }
    for (const anchor of removed) {
      void ports.bridge.dropUse({ root, id: anchor.itemId, useId: anchor.useId }).then((reply) => {
        if (!reply.ok) ports.say(`The Scratchpad could not update where its text is used: ${reply.error}`)
      })
    }
  }

  /**
   * The editor holds `path` afresh (opened, reopened, reloaded): the uses this window recorded there whose
   * anchors are not in the live state any more are dropped by main (it knows the window). Skipped in a
   * read-only state: a saved version holds no anchors, while the live state it stands in for still does.
   */
  function documentShown(): void {
    const root = ports.root()
    const path = ports.activePath()
    const view = ports.view()
    if (!root || !path || !writable(view)) return
    const keep = liveAnchors(view.state).map((anchor) => anchor.useId)
    void ports.bridge.releaseUses({ root, path, keep }).catch(() => undefined)
  }

  return { selectSection, sendCopy, cut, insert, reference, syncAnchors, documentShown }
}

export type ScratchpadController = ReturnType<typeof createScratchpadController>
