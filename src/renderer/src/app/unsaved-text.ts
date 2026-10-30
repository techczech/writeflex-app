import { hasRoomPending, flushRoomPending } from '../folio-room-pending'
/**
 * The page's record of text that is not confirmed on disk, kept outside the React tree, and the one
 * place from which a window is told it may close.
 *
 * The editor's buffers live in components. A renderer error replaces or unmounts the app (main.tsx, the
 * error boundary) and the buffers go with it, along with the app's close handler. This module outlives
 * both: it holds the registry (unsaved-registry.ts, where the rule for what counts as unsaved is), can
 * write what the registry holds, and answers a close request when the app cannot.
 *
 * What holds (quit-and-window-close-spec.md, rules R-A and R-B):
 * - `window:close` is sent by `closeWindowIfClean` and by nothing else in the renderer. It sends only
 *   when the registry has no entry and no write in flight, read in the same turn as the send. The
 *   mounted app closes through `closeWithEditor`, an unmounted page through `closeWithoutEditor`.
 * - With the app unmounted, a close that is not clean after one more attempt to write ends in
 *   `window:close-unsaved`, where main asks the person. Never a silent close.
 * - Every write carries the version its text was based on (setSaveBasisSource). A file that changed on
 *   disk is never written over from here: the text goes to a recovery copy beside it instead.
 *
 * No React, no editor imports (line-endings.ts is pure string code): the error path must be able to
 * run this when either is broken.
 */
import { isTextChange } from '../../../shared/line-endings'
import type { SaveBasis } from '../../../shared/save-basis'
import { RECOVERY_COPY_ATTEMPTS, recoveryCopyPath } from '../../../shared/conflict-copy'
import { createUnsavedRegistry } from './unsaved-registry'

type SaveResult = { refused: true } | { refused: 'disk-changed' } | { refused: 'name-taken' } | { content: string; written?: string } | Record<string, unknown>

export type UnsavedTextApi = {
  saveFile(path: string, content: string, basis: SaveBasis): Promise<SaveResult>
  onCloseRequested(fn: () => void): () => void
  acknowledgeClose(): Promise<void>
  closeWindow(options?: { checkpoint?: string[] }): Promise<void>
  closeUnsaved(): Promise<void>
  /** Main called off the close it asked for (the vault switcher's bound, window-switch.ts). */
  onAbandonClose?(fn: () => void): () => void
  /** This page has dropped the abandoned close. */
  acknowledgeAbandonClose?(): Promise<void>
}

export type UnsavedDocument = { path: string; text: string }
/** Text that could not go to its file because the file changed on disk, written beside it instead. */
export type RecoveryCopy = { path: string; copyPath: string }

const watchers = new Set<() => void>()
const notify = (): void => { for (const watcher of [...watchers]) { try { watcher() } catch { /* a watcher that failed changes nothing */ } } }

/** The registry of this page. The app reports to it: `typed`, `matchesDisk`, `discard`, `beginWrite`. */
export let unsaved = createUnsavedRegistry(notify)

let page: UnsavedTextApi | null = null
/** The app is mounted: it answers a close request itself, with its own flush. */
let editorPresent = false
/** One save run at a time. */
let saving: Promise<unknown> = Promise.resolve()
let savesRunning = 0
/** The close of a page whose app is not mounted, while it runs. */
let closingWithoutEditor: Promise<void> | null = null
/** Bumped when main calls off the close it asked for: a close that began under an older number sends
 *  nothing when its flush ends (no `window:close`, no `window:close-unsaved`, no cancel). */
let closeGeneration = 0
/** A close request that arrived while the mounted app's close ran (round 3, S1): the generation it
 *  arrived under. It runs once the running close ends abandoned, and only if no call-off came since. */
let queuedCloseRetry: number | null = null
/** The mounted app's close that sent `window:close` and detached its documents (round 3, S2): if main
 *  calls that close off, it has dropped the `window:close`, and the documents are attached again. */
let detachedClose: { generation: number; reopen: () => void } | null = null
/** Documents written from the registry in this page, by any save run: a close owes them a checkpoint. */
const writtenHere = new Set<string>()
/** Recovery copies written in this page, for the error screen. */
const recoveryCopies: RecoveryCopy[] = []
/** The version of each document its text was based on (the app's saved baseline). Every write from here
 *  carries it, so main refuses one over an outside change. Until the app says, nothing was on disk. */
let basisOf: (path: string) => SaveBasis = () => ({ kind: 'new' })

/** The app gives this module its saved baselines (read at the time of each write, also after the app is
 *  unmounted: the source reads a store that outlives it). */
export function setSaveBasisSource(source: (path: string) => SaveBasis): void {
  basisOf = source
}

const refusedAs = (result: unknown, reason: string): boolean =>
  !!result && typeof result === 'object' && (result as { refused?: unknown }).refused === reason
const refusedForDiskChange = (result: unknown): boolean => refusedAs(result, 'disk-changed')

/**
 * Write `text` beside `path` under the conflict-copy convention, as a file created exclusively (basis
 * `create`: main never replaces anything there, an empty file or a folder included). A taken name is
 * refused by main and the next is tried (Sol S7). The copy's path, or null when none was written.
 */
async function writeRecoveryCopy(api: UnsavedTextApi, path: string, text: string): Promise<string | null> {
  for (let attempt = 1; attempt <= RECOVERY_COPY_ATTEMPTS; attempt += 1) {
    const copyPath = recoveryCopyPath(path, attempt)
    let result: SaveResult
    try { result = await api.saveFile(copyPath, text, { kind: 'create' }) } catch { return null }
    if (refusedAs(result, 'name-taken') || refusedForDiskChange(result)) continue // that name is taken
    if (!result || typeof result !== 'object' || 'refused' in result) return null
    const readBack = (result as { content?: unknown }).content
    return typeof readBack === 'string' && !isTextChange(readBack, text) ? copyPath : null
  }
  return null
}

/** The app mounted (true) or was unmounted (false: by an error, the only way it leaves a live page). */
export function setEditorPresent(present: boolean): void {
  editorPresent = present
}
export function editorIsPresent(): boolean {
  return editorPresent
}

/**
 * The gate (R-B): every close this page asks for goes through here. Sends `window:close` only if no
 * document is unsaved and no write is in flight, both read now, in the turn of the send. False: not
 * sent, and the caller keeps the window (the mounted app) or has main ask (`closeWithoutEditor`).
 */
export function closeWindowIfClean(options?: { checkpoint?: string[] }): boolean {
  if (!page || !unsaved.clean() || hasRoomPending()) return false
  void page.closeWindow(options)
  return true
}

/**
 * Write every entry of the registry, each behind the writes already in flight for its path so that an
 * older text cannot land after it. Never rejects. `left`: the documents still not confirmed on disk.
 */
export function saveUnsavedText(): Promise<{ written: string[]; left: string[]; copied: RecoveryCopy[] }> {
  const api = page
  savesRunning += 1
  notify()
  const run = saving.then(async () => {
    const written: string[] = []
    const copied: RecoveryCopy[] = []
    if (!api) return { written, left: unsaved.pending(), copied }
    for (const path of unsaved.pending()) {
      await unsaved.settled(path)
      const text = unsaved.textOf(path)
      if (text === undefined) continue
      const write = unsaved.beginWrite(path, text)
      try {
        const result = await api.saveFile(path, text, basisOf(path))
        const readBack = (result as { content?: unknown } | null)?.content
        const wrote: unknown = (result as { written?: unknown } | null)?.written
        if (refusedForDiskChange(result)) {
          // The file holds another version than the one this text was based on (an outside change, the
          // banner perhaps still up): it is left as it is, and the text goes to a copy beside it. Once
          // the copy is on disk the text is safe and the document no longer holds the close.
          write.failed()
          const copyPath = await writeRecoveryCopy(api, path, text)
          if (copyPath && unsaved.textOf(path) === text) {
            unsaved.discard(path)
            const copy = { path, copyPath }
            copied.push(copy)
            recoveryCopies.push(copy)
          }
        }
        else if (result && typeof result === 'object' && 'refused' in result) write.failed()
        // What was read back is not what was written: another program wrote the file in between. The
        // text held is not on disk, so the entry stays and a close asks. Compared as documents: a
        // save restores the file's line endings and BOM, which is not a difference. The disk now
        // holds text the app's saved baseline does not, so the document is not clean by comparison
        // with that baseline either (`unknown`).
        // Byte for byte against what main says it wrote (Sol M1): any other bytes are another program's.
        else if (typeof readBack === 'string' && (typeof wrote === 'string' ? readBack !== wrote : isTextChange(readBack, text))) write.unknown()
        else { write.succeeded(); written.push(path); writtenHere.add(path) }
        // A save that threw may have been made all the same (main's SavedButNotReadBack: written, not
        // read back). Whether it was is not known here, so the disk is unknown for the document.
      } catch { write.unknown() }
    }
    return { written, left: unsaved.pending(), copied }
  }).catch(() => ({ written: [] as string[], left: unsaved.pending(), copied: [] as RecoveryCopy[] }))
  saving = run
  void run.then(() => { savesRunning -= 1; notify() })
  return run
}

/**
 * Close a page whose app is not mounted: write what is held, then let the window go if that left
 * nothing unsaved, or have main ask the person. One at a time; a call during a run joins it. Used by
 * the standing listener below and by a close the app began before it was unmounted.
 */
export function closeWithoutEditor(): Promise<void> {
  if (closingWithoutEditor) return closingWithoutEditor
  const api = page
  const generation = closeGeneration
  const run = saveUnsavedText().then(() => flushRoomPending()).then(() => {
    closingWithoutEditor = null
    if (generation !== closeGeneration) return // called off by main while the text was written
    if (!closeWindowIfClean(writtenHere.size > 0 ? { checkpoint: [...writtenHere] } : undefined)) void api?.closeUnsaved()
  })
  closingWithoutEditor = run
  return run
}

export type EditorCloseOutcome =
  /** `window:close` was sent: nothing was unsaved. */
  | 'closed'
  /** A write failed: the window stays, the caller says so and cancels the close. */
  | 'save-failed'
  /** Text is still unsaved or being written after the flush: the window stays, likewise. */
  | 'still-unsaved'
  /** The app was unmounted while the flush ran: this page's own close has taken over and will send
   *  `window:close` or `window:close-unsaved`. The caller does nothing more. */
  | 'handed-over'
  /** Main called the close off while the flush ran (the vault switcher's bound): nothing was sent and
   *  the window stays. The caller sends nothing either (no cancel: main has already ended it). */
  | 'abandoned'

/**
 * The mounted app's close: run its flush, then decide. The decision is not the flush's ("my writes
 * succeeded") nor the app's (its dirty dots): it is the gate's. A close that began before the app was
 * unmounted ends here like any close of an unmounted page, and can never treat a buffer it can no
 * longer read as saved.
 */
export async function closeWithEditor(ports: {
  /** Write every unsaved buffer (close-flush.ts). */
  flush(): Promise<{ flushed: string[]; failed: number }>
  /** The documents the close owes a checkpoint, given what the flush wrote. Read after the flush. */
  checkpoint(flushed: string[]): string[]
  /** Called in the turn `window:close` is sent (the document owner detaches every document). */
  closing?(): void
  /** Undo `closing` (round 3, S2): main called this close off after `window:close` was sent, dropped
   *  it, and the window stays. Called from the call-off. */
  reopen?(): void
}): Promise<{ outcome: EditorCloseOutcome; failed: number }> {
  const generation = closeGeneration
  const { flushed, failed } = await ports.flush()
  if (generation !== closeGeneration) return { outcome: 'abandoned', failed }
  if (!editorPresent) {
    void closeWithoutEditor()
    return { outcome: 'handed-over', failed }
  }
  if (failed > 0) return { outcome: 'save-failed', failed }
  const closed = closeWindowIfClean({ checkpoint: ports.checkpoint(flushed) })
  if (closed) {
    ports.closing?.()
    detachedClose = { generation, reopen: () => ports.reopen?.() }
  }
  return { outcome: closed ? 'closed' : 'still-unsaved', failed: 0 }
}

/**
 * Give this module the page's API and install the page's standing answer to a close request, for when
 * the app is not mounted to give its own. Call once, before the app mounts. The listener acknowledges
 * (the renderer is alive) and closes as `closeWithoutEditor` does; it steps aside while the app is
 * mounted.
 */
export function installUnsavedText(api: UnsavedTextApi): () => void {
  page = api
  const offClose = api.onCloseRequested(() => {
    if (editorPresent) return
    void api.acknowledgeClose()
    void closeWithoutEditor()
  })
  // Installed here, before the app mounts and whether or not it is mounted, so a called-off close is
  // always dropped and acknowledged: main ignores this page's close answers until it is.
  const offAbandon = api.onAbandonClose?.(() => {
    abandonPendingClose()
    void api.acknowledgeAbandonClose?.()
  })
  return () => { offClose(); offAbandon?.() }
}

/** Drop the close in flight (main called it off): when its flush ends it sends nothing. A close begun
 *  after this is a new one. */
export function abandonPendingClose(): void {
  // A close of this generation already sent `window:close`: main has dropped it (it called the close
  // off before taking it, else it would not call it off), so the window stays and must be editable.
  const detached = detachedClose
  detachedClose = null
  if (detached && detached.generation === closeGeneration) detached.reopen()
  closeGeneration += 1
}

/** A close request arrived while the mounted app's close runs: remember it under the current
 *  generation, to run when that close ends abandoned (`takeCloseRetry`). */
export function queueCloseRetry(): void {
  queuedCloseRetry = closeGeneration
}

/** Whether the queued close request is still wanted, and forget it either way. It is not wanted when
 *  none was queued, or when main called a close off after it was queued: the request belonged to the
 *  switch that was called off (round 3, S1). */
export function takeCloseRetry(): boolean {
  const queuedAt = queuedCloseRetry
  queuedCloseRetry = null
  return queuedAt !== null && queuedAt === closeGeneration
}

/** For the error screen: whether a save run is going, and what is held. `safe` is the gate's own
 *  condition and is false while a write is in flight. */
export function unsavedStatus(): { saving: boolean; safe: boolean; documents: UnsavedDocument[]; copies: RecoveryCopy[] } {
  const documents = unsaved.paths().map((path) => ({ path, text: unsaved.textOf(path) ?? '' }))
  return { saving: savesRunning > 0, safe: unsaved.clean() && !hasRoomPending(), documents, copies: [...recoveryCopies] }
}

/** Told whenever `unsavedStatus()` may have changed. */
export function watchUnsaved(watcher: () => void): () => void {
  watchers.add(watcher)
  return () => { watchers.delete(watcher) }
}

const baseName = (path: string): string => path.split('/').at(-1) ?? path

/** File names of the held documents, for a sentence: "one.md", "one.md and two.md", "a.md, b.md and c.md". */
export function unsavedFileNames(documents: UnsavedDocument[]): string {
  const names = documents.map((document) => baseName(document.path))
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** The held text as one string for the clipboard: one document as it is, several under their file names. */
export function unsavedTextForClipboard(documents: UnsavedDocument[]): string {
  if (documents.length === 1) return documents[0].text
  return documents.map((document) => `${baseName(document.path)}\n\n${document.text}`).join('\n\n\n')
}

/** Test-only: forget everything. */
export function resetUnsavedTextForTests(): void {
  unsaved = createUnsavedRegistry(notify)
  page = null
  editorPresent = false
  saving = Promise.resolve()
  savesRunning = 0
  closingWithoutEditor = null
  queuedCloseRetry = null
  detachedClose = null
  writtenHere.clear()
  recoveryCopies.length = 0
  basisOf = () => ({ kind: 'new' })
  watchers.clear()
}
