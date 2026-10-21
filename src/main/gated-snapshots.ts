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

type SnapshotMeta = { sessionId?: string; capability?: string; toolCallId?: string; attemptId?: string; origin?: 'turn' | 'host' }

/** The part of Bridle's SnapshotStore this app calls. */
export type CollectionSnapshots = {
  entries(): Promise<JournalEntry[]>
  readSnapshotContent(entryId: string): Promise<string | null>
  beginRestorePoint(label: string, sessionId?: string, meta?: { proposalId?: string }): Promise<string>
  snapshotFile(absPath: string, meta: SnapshotMeta): Promise<JournalEntry>
  restoreTo(restorePointId: string, opts?: { origin?: 'turn' | 'host' }): Promise<string[]>
}

/** `store`, with every write refused while the Collection at `root` may not be written. */
export function gatedSnapshots(root: string, store: CollectionSnapshots): CollectionSnapshots {
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
    restoreTo: async (restorePointId, opts) => {
      assertCollectionWritable(root)
      return store.restoreTo(restorePointId, opts)
    },
  }
}
