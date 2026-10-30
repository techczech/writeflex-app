import type { FolioRoomModel } from '../../../shared/folio-room'

/**
 * One read of a Folio's room, shared (spec docs/design/2026-10-24-folio-workspace § 5: one refresh per action).
 *
 * The room, the sidebar's binder and the Collection wrapper around the room each used to read the room (or the Plan)
 * themselves on every Collection change and every change on disk: after one removal that was ten reads. Here every
 * reason to read again (the room's own write, the Collection's change notice, the change-on-disk notice) asks for a
 * refresh of the Folio, the asks that arrive within one short window become ONE `folio-room:read`, and its answer
 * goes to every subscriber. A refresh asked while a read is in flight runs once more after it, so the last answer is
 * never older than the last change. Reading writes nothing (I-4).
 */

export type RoomAnswer = { model: FolioRoomModel | null } | { error: true }
type Listener = (answer: RoomAnswer) => void
type Entry = { listeners: Set<Listener>; last: RoomAnswer | null; timer: ReturnType<typeof setTimeout> | null; reading: boolean; again: boolean; revision: number }

/** The window in which several asks become one read: two notices of one write arrive within it. */
export const ROOM_REFRESH_COALESCE_MS = 24

const entries = new Map<string, Entry>()
let wired = false
let reads = 0

/** How many room reads this window has made (tests and the benchmark's renderer count). */
export function roomReadCount(): number { return reads }

function wire(): void {
  if (wired) return
  wired = true
  const all = (): void => { for (const dir of entries.keys()) refreshRoom(dir) }
  window.writeflex.onCollectionChanged(all)
  window.writeflex.onFileChangedOnDisk(all)
}

async function read(dir: string, entry: Entry): Promise<void> {
  const revision = entry.revision
  const first = entry.last === null
  entry.reading = true
  const current = (): boolean => entries.get(dir) === entry && entry.revision === revision
  const publish = (answer: RoomAnswer): void => {
    entry.last = answer
    for (const listener of [...entry.listeners]) listener(answer)
  }
  try {
    // Partial data is only useful on first entry. Refreshes retain the complete model and mounted drafts.
    if (first) {
      reads += 1
      const model = await window.writeflex.folioRoom.read(dir, true)
      if (!current()) return
      publish({ model })
      if (model?.enrichment !== 'pending') return
    }
    reads += 1
    const model = await window.writeflex.folioRoom.read(dir)
    if (current() && !entry.again) publish({ model })
  } catch {
    if (!current() || entry.again) return
    const previous = entry.last
    // A failed refresh cannot destroy loaded evidence, map state, forms or notes still being edited.
    if (previous && 'model' in previous && previous.model && !previous.model.enrichment) return
    publish(previous && 'model' in previous && previous.model
      ? { model: { ...previous.model, enrichment: 'failed' } }
      : { error: true })
  } finally {
    if (entries.get(dir) === entry) {
      entry.reading = false
      if (entry.again || entry.revision !== revision) {
        entry.again = false
        refreshRoom(dir)
      }
    }
  }
}

/** Read the Folio at `dir` again soon (`now`: at once), once for every ask in the window. Nothing when nobody shows it. */
export function refreshRoom(dir: string, now = false): void {
  const entry = entries.get(dir)
  if (!entry) return
  if (entry.reading) { entry.again = true; return }
  if (entry.timer) return
  entry.timer = setTimeout(() => {
    entry.timer = null
    void read(dir, entry)
  }, now ? 0 : ROOM_REFRESH_COALESCE_MS)
}

/**
 * Receive every read of the room at `dir`: the last one at once when there is one, else the first read is asked
 * for. Answers the unsubscribe; when the last subscriber leaves, the Folio's entry goes with it.
 */
export function subscribeRoom(dir: string, listener: Listener): () => void {
  wire()
  let entry = entries.get(dir)
  if (!entry) {
    entry = { listeners: new Set(), last: null, timer: null, reading: false, again: false, revision: 0 }
    entries.set(dir, entry)
  }
  const mine = entry
  mine.listeners.add(listener)
  if (mine.last) listener(mine.last)
  else if (!mine.reading && !mine.timer) refreshRoom(dir, true)
  return () => {
    mine.listeners.delete(listener)
    if (mine.listeners.size > 0) return
    if (mine.timer) clearTimeout(mine.timer)
    if (entries.get(dir) === mine) entries.delete(dir)
  }
}

/**
 * One Undo toast at a time per Folio (spec folio-workspace I-2): the room's removal toast and the binder's Restore
 * toast each own ⌘Z while shown. Showing one announces it here, and the other, on hearing it, closes its own (its
 * Undo would now be refused anyway: the change after it is newer).
 */
export const ROOM_UNDO_TOAST_EVENT = 'writeflex:room-undo-toast'
export type UndoToastOwner = 'room' | 'binder'

/** Say that `owner` now shows the Undo toast of the Folio at `dir`. */
export function announceUndoToast(dir: string, owner: UndoToastOwner): void {
  window.dispatchEvent(new CustomEvent(ROOM_UNDO_TOAST_EVENT, { detail: { dir, owner } }))
}

/** Call `close` when another owner than `owner` shows an Undo toast for `dir`; answers the unsubscribe. */
export function onOtherUndoToast(dir: string, owner: UndoToastOwner, close: () => void): () => void {
  const heard = (event: Event): void => {
    const detail = (event as CustomEvent<{ dir: string; owner: UndoToastOwner }>).detail
    if (detail && detail.dir === dir && detail.owner !== owner) close()
  }
  window.addEventListener(ROOM_UNDO_TOAST_EVENT, heard)
  return () => window.removeEventListener(ROOM_UNDO_TOAST_EVENT, heard)
}

/** Publish only the order main has confirmed; retain all other room facts until reconciliation. */
export function confirmRoomOrder(dir: string, order: readonly { title: string; path: string | null }[]): void {
  const entry = entries.get(dir)
  if (!entry?.last || !('model' in entry.last) || !entry.last.model) return
  const model = entry.last.model
  const available = [...model.parts]
  const parts = order.map((key, index) => {
    const at = available.findIndex(part => part.key.title === key.title && part.key.path === key.path)
    if (at < 0) return null
    const [part] = available.splice(at, 1)
    return { ...part, index }
  })
  if (parts.some(part => part === null) || parts.length !== model.parts.length) return
  entry.revision += 1
  if (entry.reading) entry.again = true
  entry.last = { model: { ...model, parts: parts as FolioRoomModel['parts'] } }
  for (const listener of [...entry.listeners]) listener(entry.last)
}
