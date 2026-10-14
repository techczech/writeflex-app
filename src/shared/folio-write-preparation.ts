/**
 * What the renderer does before it asks main to change a Folio's running order, and how the request
 * joins the editor's save queue. Pure: the buffers and the queue are passed in, so the rule is tested
 * without an editor.
 *
 * The rule: every open buffer that belongs to the Folio's folder (its Index Note, its pieces) first has
 * no save in flight, then is saved if it has unsaved edits. If a save fails, or a buffer is still
 * unsaved afterwards, main is not called and the message names the file. The request then runs through
 * the same per-file queue the saves use, for all of those buffers, so a save queued later for any of
 * them waits for the running-order write instead of interleaving with it.
 *
 * Typing does not stop for any of that. So, once the queue is held and in the very turn main is called,
 * every open buffer of the Folio is looked at again, including one opened since the first look. If one
 * has unsaved edits, or is not among the buffers whose queue is held, main is not called: the hold is
 * given up, the buffers are saved again and the request tries once more. After a few tries the change is
 * refused with a sentence that names the file, and nothing is written.
 *
 * A save that was queued while the running-order write held the queue runs after it. The buffer it would
 * write was read before the write, so it holds the old running order: `saveQueuedBehindFolioWriteMayRun`
 * is the rule that stops it when the file on disk is no longer the text the buffer was last saved as.
 */

export type FolioWriteBuffers = {
  /** The paths of the open buffers, and of any path that holds unsaved text. */
  open: () => readonly string[]
  isDirty: (path: string) => boolean
  /** Settles once no save of this path is in flight or queued. */
  settled: (path: string) => Promise<unknown>
  /** Save one buffer through the queue. False = it could not be saved. */
  save: (path: string) => Promise<boolean>
  /** Run `call` as the next entry of the save queue of every one of `paths`. */
  exclusive: <T>(paths: readonly string[], call: () => Promise<T>) => Promise<T>
  /**
   * Called while the queue is still held, once main has answered (or failed): bring these buffers in line
   * with what is on disk now (an unedited buffer takes the new text; an edited one is marked as changed
   * on disk and its pending automatic save is dropped).
   */
  afterWrite?: (paths: readonly string[]) => Promise<unknown>
  /** The name a message uses for a file; its file name without the extension when absent. */
  nameOf?: (path: string) => string
}

/** A file of the Folio's folder ('' = the workspace root, which holds every file). */
export function inFolioFolder(path: string, dir: string): boolean {
  return dir === '' || path.startsWith(`${dir}/`)
}

export function saveFirstMessage(path: string, nameOf?: (path: string) => string): string {
  const name = nameOf?.(path) ?? (path.split('/').at(-1) ?? path).replace(/\.(md|markdown)$/i, '')
  return `Save "${name}" first.`
}

export type FolioWritePrepared = { ok: true; paths: string[] } | { ok: false; message: string }

/** Wait for saves in flight, then save every unsaved buffer of the Folio. Nothing else is touched. */
export async function prepareFolioWrite(dir: string, buffers: FolioWriteBuffers): Promise<FolioWritePrepared> {
  const mine = [...new Set(buffers.open())].filter((path) => inFolioFolder(path, dir))
  await Promise.all(mine.map((path) => Promise.resolve(buffers.settled(path)).catch(() => undefined)))
  for (const path of mine) {
    if (!buffers.isDirty(path)) continue
    let saved = false
    try { saved = await buffers.save(path) } catch { saved = false }
    if (!saved) return { ok: false, message: saveFirstMessage(path, buffers.nameOf) }
  }
  const unsaved = mine.find((path) => buffers.isDirty(path))
  if (unsaved !== undefined) return { ok: false, message: saveFirstMessage(unsaved, buffers.nameOf) }
  return { ok: true, paths: mine }
}

/** The Folio's open buffers, as they are at this instant. */
function folioBuffersNow(dir: string, buffers: FolioWriteBuffers): string[] {
  return [...new Set(buffers.open())].filter((path) => inFolioFolder(path, dir))
}

/** How many times the buffers are saved and looked at again before the change is refused. */
export const FOLIO_WRITE_ATTEMPTS = 3

export function openedMeanwhileMessage(path: string, nameOf?: (path: string) => string): string {
  const name = nameOf?.(path) ?? (path.split('/').at(-1) ?? path).replace(/\.(md|markdown)$/i, '')
  return `"${name}" was opened while this was being prepared. Try again.`
}

/**
 * Prepare, then make the request through the save queue. `call` is run only in a turn in which every open
 * buffer of the Folio is saved and has its queue held; otherwise it is not run and nothing is written.
 */
export async function writeFolioThroughSaveQueue<T>(dir: string, buffers: FolioWriteBuffers, call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  let refusal = ''
  for (let attempt = 0; attempt < FOLIO_WRITE_ATTEMPTS; attempt += 1) {
    const prepared = await prepareFolioWrite(dir, buffers)
    if (!prepared.ok) return prepared
    const held = new Set(prepared.paths)
    const answer = await buffers.exclusive(prepared.paths, async (): Promise<{ made: true; value: T } | { made: false; message: string }> => {
      // No await between this look and the call: main is asked in the turn the buffers were found saved.
      const now = folioBuffersNow(dir, buffers)
      const unsaved = now.find((path) => buffers.isDirty(path))
      if (unsaved !== undefined) return { made: false, message: saveFirstMessage(unsaved, buffers.nameOf) }
      const unheld = now.find((path) => !held.has(path))
      if (unheld !== undefined) return { made: false, message: openedMeanwhileMessage(unheld, buffers.nameOf) }
      try {
        return { made: true, value: await call() }
      } finally {
        try { await buffers.afterWrite?.(now) } catch { /* the change-on-disk event reconciles the buffers as well */ }
      }
    })
    if (answer.made) return { ok: true, value: answer.value }
    refusal = answer.message
  }
  return { ok: false, message: refusal }
}

/**
 * Whether a save may write, when it was queued while a running-order write held the file's queue. It may
 * only if the file on disk is still the text the buffer was last saved as (`baseline`): otherwise the
 * buffer predates the write and saving it would put the old running order back. `differs` is the editor's
 * own text comparison (line endings aside). A file that cannot be read is not written over.
 */
export async function saveQueuedBehindFolioWriteMayRun(
  baseline: string | undefined,
  readDisk: () => Promise<string>,
  differs: (saved: string, disk: string) => boolean,
): Promise<boolean> {
  if (baseline === undefined) return true
  try {
    return !differs(baseline, await readDisk())
  } catch {
    return false
  }
}
