/**
 * Bridle's snapshot store for a Collection (`<Collection>/.bridle`), as this app's own code is handed
 * it: every call that writes asks the shared Collection write gate first (collection-write-gate.ts).
 * The store's journal and objects, and the files `restoreTo` puts back, all lie inside the Collection,
 * so they are written only while this app holds it. A refused call throws `WritesPausedError`, as a
 * refused document save does. Reads go on.
 *
 * This covers the calls THIS APP makes (the agent, the Board's material desk, the Plan proposal desk,
 * version saves, checkpoints). Bridle's own runtime keeps its own reference to the store and is not
 * reached from here: the restore point it begins for each agent turn, the snapshot its executor takes
 * before a capability writes, and the restore points its proposal store begins and discards.
 */
import type { JournalEntry } from '@bridle/core'
import { assertCollectionWritable } from './collection-write-gate'
import { snapshotBytes, type SnapshotBytesMeta } from './snapshot-bytes'
import { guardRestorePlans, refuseRestoreOverLaterWriting, type WrittenFile } from './restore-keeps-later-writing'

type StoreRestoreOptions = { origin?: 'turn' | 'host' }
type SnapshotMeta = { sessionId?: string; capability?: string; toolCallId?: string; attemptId?: string; origin?: 'turn' | 'host' }

/** The part of Bridle's SnapshotStore this app calls. */
export type CollectionSnapshots = {
  entries(): Promise<JournalEntry[]>
  readSnapshotContent(entryId: string): Promise<string | null>
  beginRestorePoint(label: string, sessionId?: string, meta?: { proposalId?: string }): Promise<string>
  snapshotFile(absPath: string, meta: SnapshotMeta): Promise<JournalEntry>
  /** `snapshotFile` for bytes already in hand: stores exactly these bytes and never reads the file (snapshot-bytes.ts). */
  snapshotBytes(absPath: string, bytes: Uint8Array, meta: SnapshotBytesMeta): Promise<JournalEntry>
  /**
   * Put the restore point back. Refused whole, before any file changes, when it would delete a file
   * holding writing added after the point (restore-keeps-later-writing.ts). `written` (this app's own
   * option, not passed to Bridle): files the caller wrote, with the bytes it wrote, that it has just
   * checked are unchanged, so a created file still holding them is deleted.
   */
  restoreTo(restorePointId: string, opts?: { origin?: 'turn' | 'host'; written?: readonly WrittenFile[] }): Promise<string[]>
}

/** `store`, with every write refused while the Collection at `root` may not be written. */
export function gatedSnapshots(
  root: string,
  store: Omit<CollectionSnapshots, 'snapshotBytes' | 'restoreTo'> & { restoreTo(restorePointId: string, opts?: StoreRestoreOptions): Promise<string[]> },
): CollectionSnapshots {
  const asked = guardRestorePlans(store)
  return {
    entries: () => store.entries(),
    readSnapshotContent: (entryId) => store.readSnapshotContent(entryId),
    beginRestorePoint: async (label, sessionId, meta) => {
      assertCollectionWritable(root)
      return store.beginRestorePoint(label, sessionId, meta)
    },
    snapshotFile: async (absPath, meta) => {
      assertCollectionWritable(root)
      return store.snapshotFile(absPath, meta)
    },
    snapshotBytes: async (absPath, bytes, meta) => {
      assertCollectionWritable(root)
      return snapshotBytes(store, absPath, bytes, meta)
    },
    restoreTo: async (restorePointId, opts) => {
      assertCollectionWritable(root)
      const { written = [], ...storeOpts } = opts ?? {}
      // Judged inside Bridle's own planning step when the store has one, else from the journal just before.
      if (asked === null) await refuseRestoreOverLaterWriting(await store.entries(), restorePointId, { ...storeOpts, written })
      asked?.set(restorePointId, written)
      try {
        return await store.restoreTo(restorePointId, opts === undefined ? undefined : storeOpts)
      } finally {
        asked?.delete(restorePointId)
      }
    },
  }
}
