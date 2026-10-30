/** Room files join the app's ordinary close handshake, including a write whose view has just unmounted. */
type Port = { path: string; dirty: () => boolean; flush: () => Promise<boolean> }
type Entry = { port: Port; pending: Promise<boolean> | null; disposed: boolean }
const entries = new Set<Entry>()
function run(entry: Entry): Promise<boolean> {
  if (entry.pending) return entry.pending
  entry.pending = Promise.resolve().then(entry.port.flush).catch(() => false).finally(() => {
    entry.pending = null
    if (entry.disposed && !entry.port.dirty()) entries.delete(entry)
  })
  return entry.pending
}
export function registerRoomPending(port: Port): () => void {
  const entry: Entry = { port, pending: null, disposed: false }
  entries.add(entry)
  return () => {
    entry.disposed = true
    if (entry.pending || entry.port.dirty()) void run(entry)
    else entries.delete(entry)
  }
}
export async function flushRoomPending(): Promise<{ flushed: string[]; failed: string[] }> {
  const flushed = new Set<string>()
  for (let pass = 0; pass < 5; pass++) {
    const pending = [...entries].filter(entry => entry.pending || entry.port.dirty())
    if (!pending.length) return { flushed: [...flushed], failed: [] }
    const results = await Promise.all(pending.map(async entry => { flushed.add(entry.port.path); return { entry, ok: await run(entry) } }))
    const failed = results.filter(result => !result.ok).map(result => result.entry.port.path)
    if (failed.length) return { flushed: [...flushed], failed: [...new Set(failed)] }
  }
  return { flushed: [...flushed], failed: [...new Set([...entries].filter(entry => entry.port.dirty()).map(entry => entry.port.path))] }
}
export type RoomNotesDraft = { text: string; basis: string | null; error?: string }
const notes = new Map<string, RoomNotesDraft>()
export const roomNotesDraft = (key: string): RoomNotesDraft | undefined => notes.get(key)
export const rememberRoomNotes = (key: string, draft: RoomNotesDraft): void => { notes.set(key, draft) }
export const forgetRoomNotes = (key: string): void => { notes.delete(key) }

/** Read in the same event-loop turn as the final window-close send. */
export const hasRoomPending = (): boolean => [...entries].some(entry => entry.pending !== null || entry.port.dirty())
