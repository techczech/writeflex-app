/**
 * A snapshot of BYTES already in hand, in Bridle's snapshot store (`.bridle/journal.jsonl`, `.bridle/objects/<sha256>`).
 *
 * Why. Bridle's `snapshotFile(absPath, meta)` reads the file again BY NAME and stores what it finds. A caller that has already judged some bytes
 * (a file version: read, capped, hashed, compared with the newest version) therefore stores bytes it never judged whenever the file changes between
 * its read and the snapshot's: a file that grew past the cap, or A→B→A between two reads. This stores exactly the buffer it is given.
 *
 * How. The same two steps `snapshotFile` takes, with the bytes in place of the read: the object is put at its hash name by the store's own
 * `storeObject` (content-addressed; an object already standing there is read back and must hash to its name, never overwritten; one that does not is
 * refused), then the store's own `append` writes ONE journal line of the shape `snapshotFile` writes (`kind snapshot`, `id`, `ts`, `sessionId`, `file`,
 * `hash`, the optional `capability`/`toolCallId`/`attemptId`, `origin`), so the journal format and the backup projection of it are unchanged.
 * Bridle's published types hide `storeObject` and `append` (private); the vendored release is immutable, so they are reached here, at one place, and
 * their presence is checked before use. If a later Bridle release renames either, this throws a sentence instead of writing something else.
 *
 * This NEVER deletes an object. Nothing in WriteFlex removes history bytes.
 *
 * Electron-free; imports nothing from Bridle at run time.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { JournalEntry } from '@bridle/core'

export type SnapshotBytesMeta = { sessionId: string; capability?: string; toolCallId?: string; attemptId?: string; origin?: 'turn' | 'host' }

type StoreInternals = {
  dir: string
  storeObject(hash: string, content: Buffer): Promise<void>
  append(entry: JournalEntry): Promise<void>
  appendNow(entry: JournalEntry): Promise<void>
}

function internalsOf(store: object): StoreInternals {
  const candidate = store as Partial<StoreInternals>
  if (typeof candidate.dir !== 'string' || typeof candidate.storeObject !== 'function' || typeof candidate.append !== 'function' || typeof candidate.appendNow !== 'function') {
    throw new Error('This build of the history store cannot snapshot bytes it already holds, so nothing was saved.')
  }
  return candidate as StoreInternals
}

/** Store `bytes` (as the file at `absPath` held them) and record the snapshot; resolves with the journal entry written, as `snapshotFile` does. */
export async function snapshotBytes(store: object, absPath: string, bytes: Uint8Array, meta: SnapshotBytesMeta): Promise<JournalEntry> {
  const internals = internalsOf(store)
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const hash = createHash('sha256').update(content).digest('hex')
  const entry = {
    kind: 'snapshot',
    id: randomUUID(),
    ts: Date.now(),
    sessionId: meta.sessionId,
    file: absPath,
    hash,
    ...(meta.capability !== undefined ? { capability: meta.capability } : {}),
    ...(meta.toolCallId !== undefined ? { toolCallId: meta.toolCallId } : {}),
    ...(meta.attemptId !== undefined ? { attemptId: meta.attemptId } : {}),
    origin: meta.origin ?? 'host',
  } as JournalEntry
  // ONE turn of Bridle's per-store write order for both steps, as `snapshotFile` holds it from the object to the journal line: otherwise another
  // snapshot of the same store can append between this object and this line, and a named version's restore point then leads first to another
  // write than its own snapshot (the backup projection refuses that history). Bridle's queue is module-private; its `append` enters it by
  // `this.dir` and runs `this.appendNow` inside, so it is called with a receiver whose `appendNow` stores the object first, on the real store.
  const turn = {
    dir: internals.dir,
    appendNow: async (line: JournalEntry): Promise<void> => {
      await internals.storeObject.call(store, hash, content)
      await internals.appendNow.call(store, line)
    },
  }
  await internals.append.call(turn, entry)
  return entry
}
