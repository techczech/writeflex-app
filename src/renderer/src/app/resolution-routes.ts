/**
 * The resolutions of a change that make main write an open document, as routes of the document owner
 * (document-owner-plan.md, parcel 2a): accepting a change (`acceptThroughOwner`) and redoing an undone
 * accept (`replayAcceptRedo`). Each runs in the owner's queue for the document's path, so no save of the
 * document interleaves with main's write and main receives every resolution in the order asked for, and
 * each takes main's text only through the owner's `replaceFromMain`, from the receipt of its own write.
 *
 * Accepting: the accept takes its place in the path's queue in the turn it is pressed (review F2: main
 * receives resolutions in the order pressed), the buffer is written until saved there (`withFlushed`), then
 * main applies the change holding the queue. Every outcome reaches the owner with the accept's receipt
 * (review F3): the receipt is the baseline, and a readback that differs from it, or none (review F4),
 * leaves the disk unknown. Typing that arrived while main applied the change is never rewritten (review
 * F1): the change is applied onto the typed text as the range it changed, or, where the two touch, the
 * buffer keeps the typing on the old baseline and main's version is asked about with the banner.
 *
 * Redoing an undone accept (quit-and-window-close-spec.md, review round 3, finding 1):
 * The redo writes the document's file through main: the pre-accept text is put back (with the buffer's
 * baseline as its basis: over any other version main refuses it, the redo is not applied and the
 * changed-on-disk banner is raised), then main applies the change to it. It runs in the path's queue, so a
 * save of the document never interleaves with it, and so main receives it, and every other resolution of
 * a change in that document (undo, reject, accept), in the order they were asked for. A hold in the unsaved
 * registry stands from the turn it is asked for until it ends, so a close waits for it.
 *
 * It ends in one of three ways: main returned the file (the owner's `replaceFromMain`, the receipt of the
 * accept's own write as the baseline); nothing was written (a refusal of the first write, or main
 * declining with nothing put back); or the disk is not known (a call threw, or main declined after the
 * pre-accept text was put back, or the file was not read back), and then the document's text is kept in
 * the registry as after a save of unknown outcome. An accept applied and not read back still sets the
 * baseline from its receipt (or the put-back's) through `replaceFromMain`, as the accept route does.
 *
 * Pure: no React, no IPC of its own.
 */
import type { FileReadResult, WriteFlexApi } from '../../../preload'
import type { ScratchPlacementReceipt } from '../../../shared/scratchpad-items'
import type { SuggestionResolutionEffect } from '../editor/suggestion-resolution-history'
import { editorTextOf, isTextChange } from '../../../shared/line-endings'
import { minimalReplace } from '../editor/reconcile'
import { basisFromBaseline } from '../../../shared/save-basis'
import type { DocumentOwner } from './document-owner'

export type AcceptRedoPorts = {
  owner: Pick<DocumentOwner, 'inQueue' | 'baselineDiskOf' | 'replaceFromMain' | 'mainWriteUnknown' | 'markUnsaved'>
  /** The document's buffer as it is now, or null when the window has none to read (its tab is not
   *  resident, or the app is unmounted). */
  bufferOf(path: string): string | null
  /** The text the registry holds for the document, if any. */
  heldText(path: string): string | undefined
  /** The unsaved registry's hold: a close waits until the release is called. */
  hold(path: string): () => void
  /** Main refused the redo's write: the disk holds `diskText` (null: no file), not the baseline. Raise the
   *  changed-on-disk banner over `buffer`; nothing was written. */
  diskChanged(path: string, diskText: string | null, buffer: string): void
  /** Main refused the accept because the file changed after it read it: read the disk and raise the
   *  changed-on-disk notice (the owner's `refusedOnDisk`). */
  changedOnDisk(path: string, options: { now: boolean }): Promise<void>
  /** False once the app has been unmounted by an error. */
  editorPresent(): boolean
  api: Pick<WriteFlexApi, 'saveFile' | 'resolveChange'>
  flash(message: string): void
  /** e2e only: holds the calls to main until released, inside the hold. */
  gate?(): Promise<void>
}

const NOT_REPLAYED = 'Could not replay that suggestion resolution.'

/** What main answers an accept (preload `resolveChange`, in the shape read here). */
export type AcceptAnswer = { applied: boolean; file?: FileReadResult; written?: string; message?: string; changedOnDisk?: { path: string; diskText: string | null }; scratchPlacement?: ScratchPlacementReceipt }

/** Main refused the write because the file changed after main read it (`changedOnDisk`): the owner reads
 *  the disk and the writer is asked with the changed-on-disk notice (Reload or Keep mine), whether or not
 *  the watcher delivers the change (final review round 2, finding 2). `now`: the route holds the path's
 *  queue. Not awaited for another path, whose queue the route does not hold. */
function askAboutRefusal(ask: (path: string, options: { now: boolean }) => Promise<void>, held: string, answer: Pick<AcceptAnswer, 'changedOnDisk'>): Promise<void> {
  const refused = answer.changedOnDisk?.path
  if (refused === undefined) return Promise.resolve()
  if (refused === held) return ask(refused, { now: true })
  void ask(refused, { now: false })
  return Promise.resolve()
}
export type AcceptRouteResult<A> = { status: 'acted'; result: A; recorded: boolean } | { status: 'not-saved'; message: string }

export type AcceptPorts = {
  owner: Pick<DocumentOwner, 'withFlushed' | 'replaceFromMain' | 'generationsOf' | 'baselineDiskOf'>
  /** The document's buffer as it is now (the live editor or the tab's cache), or null when none is held. */
  bufferOf(path: string): string | null
  /** The editor takes `resolvedContent` as an undoable edit of the document (the smallest replacement
   *  from the text it holds now); false when it did not (the document is not the live one, or the live
   *  one is a historical view). */
  recordInEditor(path: string, id: string, resolvedContent: string | undefined, scratchPlacement?: ScratchPlacementReceipt): boolean
  /** Typing arrived while main applied the change and the change cannot be applied onto it as the range
   *  it changed: the buffer is kept, on its old baseline, and `diskText` (main's version) is asked about
   *  with the changed-on-disk banner. */
  askAbout(path: string, diskText: string): void
  /** Why the last save of the path was refused, in the words the writer was shown, if it was. */
  refusalReason(path: string): string | undefined
  /** Main refused the accept because the file changed after it read it: read the disk and raise the
   *  changed-on-disk notice (the owner's `refusedOnDisk`). */
  changedOnDisk(path: string, options: { now: boolean }): Promise<void>
}

/**
 * The accepted change applied onto text typed while main applied it (review F1), in the editor's form.
 * `before` is the buffer main applied the change to, `accepted` what main wrote, `live` the buffer now.
 * The change is the one range in which `before` and `accepted` differ; the typing the one range in which
 * `before` and `live` differ. When the two ranges are apart (at least one character between them), the
 * result is `live` with the change applied at its range; when they touch or overlap, which goes first is
 * not known: null.
 */
export function acceptOntoTyping(before: string, accepted: string, live: string): string | null {
  const a = editorTextOf(before)
  const change = minimalReplace(a, editorTextOf(accepted))
  const l = editorTextOf(live)
  if (!change) return l
  const typed = minimalReplace(a, l)
  if (!typed) return editorTextOf(accepted)
  if (typed.to < change.from) return a.slice(0, typed.from) + typed.insert + a.slice(typed.to, change.from) + change.insert + a.slice(change.to)
  if (change.to < typed.from) return a.slice(0, change.from) + change.insert + a.slice(change.to, typed.from) + typed.insert + a.slice(typed.to)
  return null
}

/** Accept a change in `path`: in its place in the queue, written until saved, then `resolve` holding it. */
export async function acceptThroughOwner<A extends AcceptAnswer>(ports: AcceptPorts, path: string, id: string, resolve: () => Promise<A>): Promise<AcceptRouteResult<A>> {
  const flushed = await ports.owner.withFlushed([path], async (snapshots) => {
    const snapshot = snapshots.get(path)!
    const since = snapshot.gen
    const result = await resolve()
    if (!result.applied) {
      await askAboutRefusal(ports.changedOnDisk, path, result)
      return { result, recorded: false }
    }
    if (result.written === undefined) {
      // Review S2: applied with no receipt (main wrote nothing: the change was already applied). The file
      // read back is not this accept's text and never goes into the editor: the buffer is kept, and the
      // readback reaches the owner as a read of the disk by another hand (the baseline stays; a readback
      // that differs from it is asked about, over typing or not, and the disk is then unknown; with no
      // readback either, nothing is known of the disk and it is unknown, review F4).
      if (ports.owner.baselineDiskOf(path) !== undefined) {
        const outcome = ports.owner.replaceFromMain(path, { content: result.file?.content }, { since, mode: 'replace' })
        if (outcome.kind === 'moved') ports.askAbout(path, outcome.diskText)
      }
      return { result, recorded: false }
    }
    // The receipt of the accept's own write, and the readback (absent when the read after it failed).
    const answer = { written: result.written, content: result.file?.content }
    // The buffer takes what main wrote (`written`), not the file read back after: a readback that differs
    // is another program's version, asked about by the banner (Muse M2, round 2).
    const mainText = result.written ?? result.file?.content
    const typedSince = (ports.owner.generationsOf(path)?.gen ?? since) !== since
    let resolvedContent = mainText
    if (typedSince && mainText !== undefined) {
      // Review F1: the writer typed while main applied the change. The editor is never rewritten to main's
      // text wholesale: the change goes onto the typing as the range it changed, or not at all.
      const live = ports.bufferOf(path)
      const merged = snapshot.text !== null && live !== null ? acceptOntoTyping(snapshot.text, mainText, live) : null
      if (merged === null) {
        // The change touches the typing: the buffer keeps the typing on the version it was typed over, and
        // main's version is an outside change to it (as a goal or restore over typing, replace mode).
        const outcome = ports.owner.replaceFromMain(path, answer, { since, mode: 'replace' })
        if (outcome.kind === 'moved') ports.askAbout(path, outcome.diskText)
        return { result, recorded: false }
      }
      resolvedContent = merged
    }
    const recorded = ports.recordInEditor(path, id, resolvedContent, result.scratchPlacement?.path === path ? result.scratchPlacement : undefined)
    // A document this window never read (not open here) has no baseline to set: nothing to reconcile.
    if (!recorded && ports.owner.baselineDiskOf(path) === undefined) return { result, recorded }
    // Review F3: every outcome reaches the owner with its receipt. Taken by the editor as an edit of its
    // own (`integrated`); otherwise (another tab is live, or a historical view) the buffer takes the
    // receipt only if nothing was typed since the snapshot (`replace`), and a readback that differs from
    // the receipt leaves the disk unknown and raises the banner, never a clean baseline.
    const outcome = ports.owner.replaceFromMain(path, answer, { since, mode: recorded ? 'integrated' : 'replace' })
    if (outcome.kind === 'moved') ports.askAbout(path, outcome.diskText)
    return { result, recorded }
  }, { inOrder: true })
  if (flushed.status === 'acted') return { status: 'acted', ...flushed.result }
  return { status: 'not-saved', message: `Nothing was applied. ${ports.refusalReason(path) ?? `Could not save ${path.split('/').at(-1) ?? path} first.`}` }
}

/** True when main holds the accept. */
export function replayAcceptRedo(ports: AcceptRedoPorts, effect: Pick<SuggestionResolutionEffect, 'id' | 'path' | 'beforeContent'>): Promise<boolean> {
  const { id, path, beforeContent } = effect
  const { owner } = ports
  // Read in the turn of the redo, while the editor is certainly there: the redone text.
  const atStart = ports.bufferOf(path)
  // Taken in this turn: from now until the redo ends, a close waits for it.
  const release = ports.hold(path)
  // The latest text of the document there is to keep. With the app unmounted that is what the registry
  // holds, or else the text read at the start. With the app mounted and no buffer, the tab was closed
  // meanwhile and there is no text of it in the window.
  const latestText = (): string | null => ports.bufferOf(path) ?? (ports.editorPresent() ? null : ports.heldText(path) ?? atStart)
  const diskUnknown = (): void => {
    const text = latestText()
    if (text != null) owner.mainWriteUnknown(path, text)
  }
  // A buffer that is not `base` is unsaved text: held, while the buffer is there to read or nothing holds it.
  const keepIfNotOnDisk = (base: string, buffer: string): void => {
    if (!isTextChange(base, buffer)) return
    if (ports.bufferOf(path) != null || ports.heldText(path) === undefined) owner.markUnsaved(path, buffer)
  }
  const lastKnown = (): { lastKnown?: string } => (!ports.editorPresent() && atStart != null ? { lastKnown: atStart } : {})
  return owner.inQueue(path, async (since) => {
    // What the redo's own write put on disk: what the file holds if main's accept then writes nothing.
    let putBack: string | undefined
    try {
      if (ports.gate) await ports.gate()
      if (beforeContent !== undefined) {
        // Read now, in the queue: the version the buffer is based on, which no save of ours moves meanwhile.
        const basis = basisFromBaseline(owner.baselineDiskOf(path))
        const restored = await ports.api.saveFile(path, beforeContent, basis)
        if ('refused' in restored && restored.refused === 'disk-changed') {
          // Another version is on disk: the redo is not applied, the change stays resolvable, and the
          // writer is asked as for any outside change. The redone buffer is not on disk: it is held (the
          // redo's edit may have reported no document change), so no close passes it by.
          const buffer = latestText()
          if (buffer != null) {
            keepIfNotOnDisk(basis.kind === 'disk' ? basis.text : '', buffer)
            ports.diskChanged(path, restored.diskText, buffer)
          }
          return false
        }
        if ('refused' in restored) {
          ports.flash(restored.message) // refused before anything was written: the disk is as it was
          return false
        }
        if (restored.content !== restored.written) {
          // Another program wrote the file between the put-back and its readback (Muse S3): main would
          // apply the change over that version. The redo is not applied; the baseline is the text that was
          // put back (its receipt), and the writer is asked about the other version.
          owner.replaceFromMain(path, { written: restored.written, content: restored.written }, { since, mode: 'integrated', ...lastKnown() })
          const buffer = latestText()
          if (buffer != null) {
            keepIfNotOnDisk(restored.written, buffer)
            ports.diskChanged(path, restored.content, buffer)
          }
          return false
        }
        putBack = restored.written
      }
      const result = await ports.api.resolveChange(id, 'accept')
      if (!result.applied) {
        if (beforeContent !== undefined) diskUnknown() // the pre-accept text was put back: not what the baseline says
        await askAboutRefusal(ports.changedOnDisk, path, result)
        ports.flash(result.message ?? NOT_REPLAYED)
        return false
      }
      // The accept's own receipt, or else (it wrote nothing) the put-back's.
      const written = result.written ?? putBack
      if (!result.file) {
        // Applied, and not read back (as an accept's, review F4): the receipt is the baseline and the disk is
        // unknown, the latest text held. With no receipt either, nothing is known of the disk.
        const latest = latestText()
        if (written === undefined || latest === null) diskUnknown()
        else owner.replaceFromMain(path, { written }, { since, mode: 'integrated', lastKnown: latest })
      } else {
        owner.replaceFromMain(path, { written, content: result.file.content }, { since, mode: 'integrated', ...lastKnown() })
      }
      return true
    } catch {
      // A call that threw may have written all the same.
      diskUnknown()
      ports.flash(`Could not save ${path.split('/').at(-1) ?? path}.`)
      return false
    } finally {
      release()
    }
  })
}

/** What the Agent notes pane is told about a proposal it resolved. */
export type ProposalResolution = { applied: boolean; message?: string }

/**
 * A proposal accepted or discarded from the Agent notes pane (residual c of parcel 2a round 4): the same
 * routes as from the margin, so the document's owner orders it with the saves of that document. An accept
 * goes through `acceptThroughOwner` (written until saved, then main writes holding the queue, the receipt
 * the baseline); a discard runs in the document's queue and writes no document.
 */
export async function resolveProposalThroughOwner(
  ports: {
    accept(path: string, id: string, resolve: () => Promise<AcceptAnswer>): Promise<AcceptRouteResult<AcceptAnswer>>
    inQueue<T>(path: string, run: () => Promise<T>): Promise<T>
    resolveChange(id: string, action: 'accept' | 'reject'): Promise<AcceptAnswer>
  },
  change: { id: string; path: string },
  action: 'accept' | 'reject',
): Promise<ProposalResolution> {
  if (action === 'reject') return ports.inQueue(change.path, () => ports.resolveChange(change.id, 'reject'))
  const accepted = await ports.accept(change.path, change.id, () => ports.resolveChange(change.id, 'accept'))
  if (accepted.status !== 'acted') return { applied: false, message: accepted.message }
  return accepted.result
}
