import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VersionStore } from "./store.ts";
import { walkWorkspace, type WalkOptions } from "./walk.ts";
import type {
  Checkpoint,
  CheckpointEntry,
  CheckpointResult,
  StatIndex,
  VersioningReport,
} from "./types.ts";

export type CheckpointOptions = {
  label: string;
  trigger: Checkpoint["trigger"];
  createdAt?: number;
  exclude?: Set<string>;
  /** A changed file larger than this is checkpointed but its bytes are NOT stored —
   *  marked "unrestorable" instead of forcing a pathological copy (PRD Decision 2,
   *  fail-loud). Clonefile (APFS CoW) will later lift this cheaply; unset = no limit. */
  largeFileCeiling?: number;
  /** Ignore the stat index and verify every regular file's bytes. */
  fullRehash?: boolean;
  /** Append a checkpoint even when its manifest matches the current head. */
  force?: boolean;
  origin?: Checkpoint["origin"];
  capability?: string;
  toolCallId?: string;
  attemptId?: string;
  sessionId?: string;
  /** Narrow test seams used by restore's cross-device and traversal-race coverage. */
  lstat?: WalkOptions["lstat"];
  readdir?: WalkOptions["readdir"];
};

/** Sentinel stat-index hash for a file whose bytes we deliberately did not store. */
const UNRESTORABLE = "UNRESTORABLE";

/**
 * Take a whole-folder checkpoint (PRD tickets T1, T2, T8). Near-free: it stats
 * every file but only RE-READS files whose (size, mtime, inode) changed since the
 * last checkpoint — an untouched 4 GB video costs a stat, not a read. Changed
 * bytes are stored content-addressed + deduplicated; the checkpoint itself is a
 * small manifest of path -> object hash.
 */
export async function takeCheckpoint(store: VersionStore, root: string, opts: CheckpointOptions): Promise<CheckpointResult> {
  return store.withLock(() => takeCheckpointUnlocked(store, root, opts));
}

/** Restore holds the operation lock across its whole rewrite and calls this path
 *  for its before/after checkpoints without attempting to acquire it again. */
export async function takeCheckpointUnlocked(
  store: VersionStore,
  root: string,
  opts: CheckpointOptions,
): Promise<CheckpointResult> {
  const prev = await store.head();
  const { savedAt, index } = await store.loadIndex();
  const nextIndex: StatIndex = new Map();
  const walked = await walkWorkspace(root, {
    ...(opts.exclude ? { exclude: opts.exclude } : {}),
    ...(opts.lstat ? { lstat: opts.lstat } : {}),
    ...(opts.readdir ? { readdir: opts.readdir } : {}),
  });
  const entries: CheckpointEntry[] = [];

  const ceiling = opts.largeFileCeiling ?? Number.POSITIVE_INFINITY;
  for (const e of walked) {
    if (e.kind === "file") {
      const known = index.get(e.relPath);
      // Trust "unchanged" only when the stat matches AND the file was last modified
      // strictly before the index was written — otherwise it's racily clean (could
      // have been overwritten in the same tick at the same size) and must be re-read.
      //
      // Residual D4 limitation: a backwards wall-clock jump between index save and
      // a same-size write can make changed bytes look clean (git shares this edge).
      // Callers can opt into `fullRehash` when they need byte-for-byte verification.
      const unchanged = !opts.fullRehash
        && known
        && known.size === e.size
        && known.mtimeMs === e.mtimeMs
        && known.ino === e.ino
        && e.mtimeMs < savedAt;
      if (unchanged) {
        nextIndex.set(e.relPath, known);
        if (known.hash === UNRESTORABLE) entries.push({ relPath: e.relPath, kind: "file", size: e.size, unrestorable: true });
        else entries.push({ relPath: e.relPath, kind: "file", size: e.size, hash: known.hash });
      } else if (e.size > ceiling) {
        // Too large to preserve cheaply — record it, but don't force a giant copy.
        nextIndex.set(e.relPath, { size: e.size, mtimeMs: e.mtimeMs, ino: e.ino, hash: UNRESTORABLE });
        entries.push({ relPath: e.relPath, kind: "file", size: e.size, unrestorable: true });
      } else {
        const hash = await store.putBytes(await readFile(join(root, e.relPath))); // changed — read + store
        nextIndex.set(e.relPath, { size: e.size, mtimeMs: e.mtimeMs, ino: e.ino, hash });
        entries.push({ relPath: e.relPath, kind: "file", size: e.size, hash });
      }
    } else if (e.kind === "symlink") {
      entries.push({ relPath: e.relPath, kind: "symlink", size: 0, linkTarget: e.linkTarget });
    } else if (e.kind === "dir") {
      entries.push({
        relPath: e.relPath,
        kind: "dir",
        size: 0,
        ...(e.uncaptured ? { uncaptured: e.uncaptured } : {}),
      });
    } else {
      entries.push({
        relPath: e.relPath,
        kind: "special",
        size: 0,
        ...(e.uncaptured ? { uncaptured: e.uncaptured } : {}),
      });
    }
  }

  const report: VersioningReport = {
    uncaptured: entries.flatMap((entry) =>
      entry.uncaptured
        ? [{ relPath: entry.relPath, reason: entry.uncaptured.reason }]
        : []),
  };

  if (prev && !opts.force && JSON.stringify(entries) === JSON.stringify(prev.entries)) {
    await store.saveIndex(nextIndex);
    return { id: prev.id, noop: true, report };
  }

  const checkpoint: Checkpoint = {
    id: randomUUID(),
    parentId: prev?.id ?? null,
    createdAt: opts.createdAt ?? Date.now(),
    label: opts.label,
    trigger: opts.trigger,
    entries,
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(opts.capability ? { capability: opts.capability } : {}),
    ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    ...(opts.attemptId ? { attemptId: opts.attemptId } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  };
  await store.appendCheckpoint(checkpoint);
  await store.saveIndex(nextIndex);
  return { ...checkpoint, report };
}
