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
 *
 * No React, no editor imports (line-endings.ts is pure string code): the error path must be able to
 * run this when either is broken.
 */
import { isTextChange } from '../../../shared/line-endings'
import { createUnsavedRegistry } from './unsaved-registry'

type SaveResult = { refused: true } | { content: string } | Record<string, unknown>

export type UnsavedTextApi = {
  saveFile(path: string, content: string): Promise<SaveResult>
  onCloseRequested(fn: () => void): () => void
  acknowledgeClose(): Promise<void>
  closeWindow(options?: { checkpoint?: string[] }): Promise<void>
  closeUnsaved(): Promise<void>
}

export type UnsavedDocument = { path: string; text: string }

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
/** Documents written from the registry in this page, by any save run: a close owes them a checkpoint. */
const writtenHere = new Set<string>()

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
  if (!page || !unsaved.clean()) return false
  void page.closeWindow(options)
  return true
}

/**
 * Write every entry of the registry, each behind the writes already in flight for its path so that an
 * older text cannot land after it. Never rejects. `left`: the documents still not confirmed on disk.
 */
export function saveUnsavedText(): Promise<{ written: string[]; left: string[] }> {
  const api = page
  savesRunning += 1
  notify()
  const run = saving.then(async () => {
    const written: string[] = []
    if (!api) return { written, left: unsaved.pending() }
    for (const path of unsaved.pending()) {
      await unsaved.settled(path)
      const text = unsaved.textOf(path)
      if (text === undefined) continue
      const write = unsaved.beginWrite(path, text)
      try {
        const result = await api.saveFile(path, text)
        const readBack = (result as { content?: unknown } | null)?.content
        if (result && typeof result === 'object' && 'refused' in result) write.failed()
        // What was read back is not what was written: another program wrote the file in between. The
        // text held is not on disk, so the entry stays and a close asks. Compared as documents: a
        // save restores the file's line endings and BOM, which is not a difference. The disk now
        // holds text the app's saved baseline does not, so the document is not clean by comparison
        // with that baseline either (`unknown`).
        else if (typeof readBack === 'string' && isTextChange(readBack, text)) write.unknown()
        else { write.succeeded(); written.push(path); writtenHere.add(path) }
        // A save that threw may have been made all the same (main's SavedButNotReadBack: written, not
        // read back). Whether it was is not known here, so the disk is unknown for the document.
      } catch { write.unknown() }
    }
    return { written, left: unsaved.pending() }
  }).catch(() => ({ written: [] as string[], left: unsaved.pending() }))
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
  const run = saveUnsavedText().then(() => {
    closingWithoutEditor = null
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
}): Promise<{ outcome: EditorCloseOutcome; failed: number }> {
  const { flushed, failed } = await ports.flush()
  if (!editorPresent) {
    void closeWithoutEditor()
    return { outcome: 'handed-over', failed }
  }
  if (failed > 0) return { outcome: 'save-failed', failed }
  return { outcome: closeWindowIfClean({ checkpoint: ports.checkpoint(flushed) }) ? 'closed' : 'still-unsaved', failed: 0 }
}

/**
 * Give this module the page's API and install the page's standing answer to a close request, for when
 * the app is not mounted to give its own. Call once, before the app mounts. The listener acknowledges
 * (the renderer is alive) and closes as `closeWithoutEditor` does; it steps aside while the app is
 * mounted.
 */
export function installUnsavedText(api: UnsavedTextApi): () => void {
  page = api
  return api.onCloseRequested(() => {
    if (editorPresent) return
    void api.acknowledgeClose()
    void closeWithoutEditor()
  })
}

/** For the error screen: whether a save run is going, and what is held. `safe` is the gate's own
 *  condition and is false while a write is in flight. */
export function unsavedStatus(): { saving: boolean; safe: boolean; documents: UnsavedDocument[] } {
  const documents = unsaved.paths().map((path) => ({ path, text: unsaved.textOf(path) ?? '' }))
  return { saving: savesRunning > 0, safe: unsaved.clean(), documents }
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
  writtenHere.clear()
  watchers.clear()
}
