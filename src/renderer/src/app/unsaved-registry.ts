/**
 * Which documents hold text that is not confirmed on disk, and what that text is. The one authority a
 * window's close decision reads (quit-and-window-close-spec.md, rule R-A).
 *
 * An entry for a path means: the latest text the writer produced for it is not yet known to be on
 * disk. Three things remove an entry, and nothing else does (not unmounting the app, not a "saved"
 * report, not a write of older text):
 *
 * 1. A write of exactly the entry's current text succeeds while no other write of that path is in
 *    flight. (With another in flight, which lands last is unknown, so the entry stays.)
 * 2. The app reports that the buffer equals what is on disk (`matchesDisk`: an undo back to the saved
 *    text, a reload from disk) while no write of other text for that path is in flight. With one in
 *    flight the claim cannot be trusted, since that write will change the disk: the entry is kept with
 *    the text given, so a write of it follows the one in flight. (A write in flight of the same text
 *    leaves the disk as claimed whether it succeeds or fails.)
 * 3. The document leaves the window (`discard`: its tab was closed, it was deleted or renamed).
 *
 * Rule 2 rests on the app's saved baseline, which is the content the last save read back. A write
 * whose outcome is not known (`unknown`: it threw, or it was made and could not be read back) may
 * have changed the disk without the baseline following it. From then on the disk is unknown for that
 * document: the document has an entry (the one it had, or the text that write carried), and
 * `matchesDisk` does not remove it; it only records the text given, as with a write of other text in
 * flight. The disk is known again when a write succeeds with no other write of the document in
 * flight, which removes the entry under rule 1 if the text written is still the latest.
 *
 * A hold (`hold`) is not an entry and not a write: it says that calls which write the document's file
 * outside a save are in flight (the redo of an undone suggestion, resolution-routes.ts). It
 * claims nothing about text and changes no entry; while it stands the document is pending and not
 * settled, so a close waits for it.
 *
 * Pure: no IO, no React, no timers. A write is announced with `beginWrite` in the same turn in which
 * its text is read, and settled once with `succeeded` or `failed`.
 */

export type WriteInFlight = {
  /** The write completed and the text given to `beginWrite` is on disk. */
  succeeded(): void
  /** The write is known not to have put its text on disk, and what was on disk before is still there
   *  (it was refused before anything was written). */
  failed(): void
  /** The write may or may not have reached the disk: it threw, or it was made and could not be read
   *  back, or what was read back is other text. The disk is unknown for the document from now on. */
  unknown(): void
}

export type UnsavedRegistry = {
  /** The writer's latest text for a document, which differs from what is on disk. */
  typed(path: string, text: string): void
  /** The buffer now equals what the app believes is on disk (rule 2 above). Not believed while the
   *  disk is unknown for the document: the entry stays, holding `text`. */
  matchesDisk(path: string, text: string): void
  /** The document has left the window (rule 3 above). */
  discard(path: string): void
  /** A write of `text` starts now. If the document has an entry, `text` becomes its latest text: the
   *  writer of a mounted editor reads its buffer, which is the latest there is. */
  beginWrite(path: string, text: string): WriteInFlight
  /** Calls that write the document's file are in flight. Returns the release, which counts once. */
  hold(path: string): () => void
  /** The latest unconfirmed text, or undefined when the document has no entry. */
  textOf(path: string): string | undefined
  /** A write of unknown outcome left the disk unknown for the document (until a write succeeds). Then
   *  "the buffer equals the saved baseline" does not make it clean: no automatic reload may replace it. */
  diskIsUnknown(path: string): boolean
  /** Documents with an entry. */
  paths(): string[]
  /** Documents with an entry, a write in flight or a hold: everything a close must wait for. */
  pending(): string[]
  /** No entry, no write in flight and no hold. The only state in which a window may close unasked. */
  clean(): boolean
  /** Resolves when no write of the path is in flight and no hold stands (at once when neither). */
  settled(path: string): Promise<void>
  /** A write of the path is in flight or a hold stands (what `settled` waits for). */
  busy(path: string): boolean
}

export function createUnsavedRegistry(onChange: () => void = () => {}): UnsavedRegistry {
  const latest = new Map<string, string>()
  /** The writes in flight, per path: the text of each, and whether the document left the window
   *  (`discard`) while it was in flight. */
  const inFlight = new Map<string, Array<{ text: string; left: boolean }>>()
  /** Documents whose content on disk is unknown since a write of unknown outcome. */
  const diskUnknown = new Set<string>()
  /** How many holds stand, per path. */
  const holds = new Map<string, number>()
  const waiters = new Map<string, Array<() => void>>()

  const changed = (): void => { try { onChange() } catch { /* a listener that failed changes nothing here */ } }
  const writing = (path: string): boolean => inFlight.has(path) || holds.has(path)
  const wake = (path: string): void => {
    if (writing(path)) return
    for (const resolve of waiters.get(path) ?? []) resolve()
    waiters.delete(path)
  }
  const settle = (path: string, write: { text: string; left: boolean }, outcome: 'succeeded' | 'failed' | 'unknown'): void => {
    const { text } = write
    const writes = inFlight.get(path) ?? []
    const at = writes.indexOf(write)
    if (at >= 0) writes.splice(at, 1)
    // The text this write carried may not be on disk and the baseline cannot say. A document that
    // left the window meanwhile has no text here to keep: no mark, and no entry comes back for it.
    if (outcome === 'unknown' && !write.left) {
      diskUnknown.add(path)
      if (!latest.has(path)) latest.set(path, text)
    }
    if (writes.length === 0) {
      inFlight.delete(path)
      if (outcome === 'succeeded') {
        diskUnknown.delete(path)
        if (latest.get(path) === text) latest.delete(path)
      }
      wake(path)
    }
    changed()
  }

  return {
    typed(path, text) {
      latest.set(path, text)
      changed()
    },
    matchesDisk(path, text) {
      if (diskUnknown.has(path) || (inFlight.get(path) ?? []).some((write) => write.text !== text)) latest.set(path, text)
      else if (!latest.delete(path)) return
      changed()
    },
    discard(path) {
      for (const write of inFlight.get(path) ?? []) write.left = true
      const marked = diskUnknown.delete(path)
      if (latest.delete(path) || marked) changed()
    },
    beginWrite(path, text) {
      const write = { text, left: false }
      inFlight.set(path, [...(inFlight.get(path) ?? []), write])
      if (latest.has(path)) latest.set(path, text)
      changed()
      let open = true
      const end = (outcome: 'succeeded' | 'failed' | 'unknown') => (): void => {
        if (!open) return
        open = false
        settle(path, write, outcome)
      }
      return { succeeded: end('succeeded'), failed: end('failed'), unknown: end('unknown') }
    },
    hold(path) {
      holds.set(path, (holds.get(path) ?? 0) + 1)
      changed()
      let open = true
      return () => {
        if (!open) return
        open = false
        const left = (holds.get(path) ?? 1) - 1
        if (left > 0) holds.set(path, left)
        else holds.delete(path)
        wake(path)
        changed()
      }
    },
    textOf: (path) => latest.get(path),
    diskIsUnknown: (path) => diskUnknown.has(path),
    paths: () => [...latest.keys()],
    pending: () => [...new Set([...latest.keys(), ...inFlight.keys(), ...holds.keys()])],
    clean: () => latest.size === 0 && inFlight.size === 0 && holds.size === 0,
    busy: (path) => writing(path),
    settled(path) {
      if (!writing(path)) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const list = waiters.get(path) ?? []
        list.push(resolve)
        waiters.set(path, list)
      })
    },
  }
}
