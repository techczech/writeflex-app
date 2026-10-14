import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { VersionStore } from "./store.ts";
import { takeCheckpointUnlocked } from "./checkpoint.ts";
import {
  isOsJunkRelPath,
  walkWorkspace,
  type WalkOptions,
} from "./walk.ts";
import type {
  NotRolledBackPath,
  RestoreReport,
  RestoreResult,
  UncapturedPath,
} from "./types.ts";

export class VersioningRestoreError extends Error {
  constructor(message: string, readonly beforeCheckpointId: string) {
    super(`Version restore failed after preserving checkpoint ${beforeCheckpointId}: ${message}`);
    this.name = "VersioningRestoreError";
  }
}

export type RestoreOptions = {
  createdAt?: number;
  label?: string;
  largeFileCeiling?: number;
  /** Narrow test seams for cross-device and traversal-race restore coverage. */
  lstat?: WalkOptions["lstat"];
  readdir?: WalkOptions["readdir"];
};

/**
 * Restore the whole folder to an earlier checkpoint (PRD Decision 4, ticket T6).
 * Non-destructive: it first checkpoints the CURRENT state (so the restore itself
 * is undoable), then rewrites the folder to the target, then checkpoints the
 * result so the timeline records the restore.
 *
 * The rewrite is deliberately non-atomic. Once the complete before-checkpoint
 * exists, any later failure throws `VersioningRestoreError` carrying its id.
 * From the partial tree, callers can recover by restoring the requested target
 * again or by restoring `beforeCheckpointId` to return to the original bytes.
 * That id recovers everything the before-checkpoint captured. `notRolledBack`
 * names what this restore did not roll back and why: bytes nothing captured
 * (`unrestorable`, `unrecoverable-overwrite`), subtrees no checkpoint can see
 * (`mount`, `unreadable-dir`), captured bytes whose store object has since been
 * collected (`missing-content`), and removals that failed (`left-behind`).
 *
 * Safety (the ADR-0028 review lessons): the rewrite is the one place we write into
 * a user folder the agent can shape, so every write is remove-then-atomic-create —
 * we lstat each target path, delete any symlink / shared-inode / wrong-type sitting
 * there (deleting the LINK, never following it), and publish the new content by
 * renaming a fresh temp file into place. We never write THROUGH a symlink and never
 * mutate a shared inode.
 */
export async function restoreTo(
  store: VersionStore,
  root: string,
  targetId: string,
  opts: RestoreOptions = {},
): Promise<RestoreResult> {
  return store.withLock(() => restoreToUnlocked(store, root, targetId, opts));
}

async function restoreToUnlocked(
  store: VersionStore,
  root: string,
  targetId: string,
  opts: RestoreOptions,
): Promise<RestoreResult> {
  const target = await store.checkpoint(targetId);
  if (!target) throw new Error(`Unknown checkpoint: ${targetId}`);
  const now = opts.createdAt ?? Date.now();

  // 1. Preserve the current state so going back is itself reversible.
  const before = await takeCheckpointUnlocked(store, root, {
    label: opts.label ?? "before restore",
    trigger: "restore",
    createdAt: now,
    origin: "restore",
    fullRehash: true,
    ...(opts.largeFileCeiling !== undefined
      ? { largeFileCeiling: opts.largeFileCeiling }
      : {}),
    ...(opts.lstat ? { lstat: opts.lstat } : {}),
    ...(opts.readdir ? { readdir: opts.readdir } : {}),
  });

  try {
    const beforeCheckpoint = await store.checkpoint(before.id);
    if (!beforeCheckpoint) {
      throw new Error(`Before-restore checkpoint disappeared: ${before.id}`);
    }
    const beforeByPath = new Map(
      beforeCheckpoint.entries.map((entry) => [entry.relPath, entry]),
    );
    const unrecoverableOverwritePaths = beforeCheckpoint.entries
      .filter((entry) => entry.unrestorable)
      .map((entry) => entry.relPath);
    const targetEntries = target.entries.filter((entry) =>
      !isOsJunkRelPath(entry.relPath)
    );
    const wanted = new Map(targetEntries.map((entry) => [entry.relPath, entry]));

    // 2. Remove anything present now that the target didn't have (deepest paths
    //    first so directories empty before removal). Explicitly uncaptured
    //    entries are left untouched: they are mount or unreadable-dir boundaries.
    const current = await walkWorkspace(root, {
      ...(opts.lstat ? { lstat: opts.lstat } : {}),
      ...(opts.readdir ? { readdir: opts.readdir } : {}),
    });
    const protectedEntries: UncapturedPath[] = current
      .filter((entry) => entry.uncaptured)
      .map((entry) => ({
        relPath: entry.relPath,
        reason: entry.uncaptured!.reason,
      }));
    const protectedPaths = protectedEntries.map((entry) => entry.relPath);
    const notRolledBack = new Map<string, NotRolledBackPath>(
      protectedEntries.map((entry): [string, NotRolledBackPath] => [
        entry.relPath,
        entry,
      ]),
    );
    for (const e of [...current].sort((a, b) => b.relPath.length - a.relPath.length)) {
      const protectedSubtree = protectedPaths.some((protectedPath) =>
        e.relPath === protectedPath || e.relPath.startsWith(`${protectedPath}/`)
      );
      if (!protectedSubtree && !wanted.has(e.relPath)) {
        if (beforeByPath.get(e.relPath)?.unrestorable) {
          notRolledBack.set(e.relPath, {
            relPath: e.relPath,
            reason: "unrecoverable-overwrite",
          });
          continue;
        }
        const removed = await safeRemove(join(root, e.relPath));
        if (!removed) {
          const protectingChild = [...notRolledBack.values()].find((entry) =>
            entry.relPath.startsWith(`${e.relPath}/`)
          );
          if (protectingChild) {
            notRolledBack.set(e.relPath, {
              relPath: e.relPath,
              reason: protectingChild.reason,
            });
          } else {
            notRolledBack.set(e.relPath, {
              relPath: e.relPath,
              reason: "left-behind",
            });
          }
        }
      }
    }

    // 3. Bring every wanted path back, shallowest first (parents before children).
    //    CRITICAL: every ancestor directory is forced to be a REAL directory inside
    //    the folder first (ensureRealDirChain) — otherwise an agent that swapped an
    //    in-workspace sub-directory for a symlink would redirect the write/delete
    //    below to outside the folder, with no race needed. lstat-of-the-leaf alone
    //    does not defend against a symlinked ANCESTOR component.
    for (const e of [...targetEntries].sort((a, b) => a.relPath.length - b.relPath.length)) {
      if (protectedPaths.some((protectedPath) =>
        e.relPath === protectedPath
        || e.relPath.startsWith(`${protectedPath}/`)
      )) {
        continue;
      }
      const unrecoverableOverwritePath = e.kind === "special"
        ? undefined
        : unrecoverableOverwritePaths.find((relPath) =>
          e.relPath === relPath
          || e.relPath.startsWith(`${relPath}/`)
          || (e.kind !== "dir" && relPath.startsWith(`${e.relPath}/`))
        );
      if (unrecoverableOverwritePath) {
        notRolledBack.set(unrecoverableOverwritePath, {
          relPath: unrecoverableOverwritePath,
          reason: "unrecoverable-overwrite",
        });
        continue;
      }
      if (e.kind === "dir") {
        await ensureRealDirChain(root, e.relPath);
      } else if (e.kind === "symlink") {
        await ensureRealDirChain(root, dirname(e.relPath));
        const abs = join(root, e.relPath);
        await removeAtPath(abs);
        if (e.linkTarget) await symlink(e.linkTarget, abs);
      } else if (e.kind === "file") {
        if (e.unrestorable || !e.hash) {
          notRolledBack.set(e.relPath, {
            relPath: e.relPath,
            reason: "unrestorable",
          });
          continue; // bytes we deliberately didn't keep
        }
        let bytes: Buffer;
        try {
          bytes = await store.readObject(e.hash);
        } catch (error) {
          if (
            error
            && typeof error === "object"
            && "code" in error
            && error.code === "ENOENT"
          ) {
            notRolledBack.set(e.relPath, {
              relPath: e.relPath,
              reason: "missing-content",
            });
            continue;
          }
          throw error;
        }
        await ensureRealDirChain(root, dirname(e.relPath));
        await safeWriteFile(join(root, e.relPath), bytes);
      }
      // special/cross-device: present-but-unread; never reconstruct or write through.
    }

    // 4. Record the restored state as the new head (dedup means no new objects).
    const restored = await takeCheckpointUnlocked(store, root, {
      label: opts.label ? `restored: ${opts.label}` : `restored to ${targetId.slice(0, 8)}`,
      trigger: "restore",
      createdAt: now,
      origin: "restore",
      ...(opts.largeFileCeiling !== undefined
        ? { largeFileCeiling: opts.largeFileCeiling }
        : {}),
      ...(opts.lstat ? { lstat: opts.lstat } : {}),
      ...(opts.readdir ? { readdir: opts.readdir } : {}),
    });
    const report: RestoreReport = {
      uncaptured: restored.report.uncaptured,
      notRolledBack: [...notRolledBack.values()]
        .sort((left, right) => left.relPath.localeCompare(right.relPath)),
    };
    return restored.noop
      ? { ...restored, beforeCheckpointId: null, report }
      : { ...restored, beforeCheckpointId: before.id, report };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new VersioningRestoreError(message, before.id);
  }
}

/**
 * Force every component of `relDir` under `root` to be a REAL directory that lives
 * inside `root` — walking one component at a time with lstat, never following a
 * link. A component that is a symlink (or a file where a directory must be) is
 * removed and recreated as a real directory. After this, a write to any path under
 * `relDir` cannot be redirected outside the folder by a swapped-in ancestor symlink.
 */
async function ensureRealDirChain(root: string, relDir: string): Promise<void> {
  let cur = root;
  for (const part of relDir.split(/[\\/]/).filter((p) => p && p !== ".")) {
    cur = join(cur, part);
    const stat = await lstat(cur).catch(() => null);
    if (!stat) await mkdir(cur);
    else if (stat.isDirectory()) continue; // a real directory (lstat: a symlink-to-dir is NOT isDirectory)
    else { await rm(cur, { recursive: true, force: true }); await mkdir(cur); }
  }
}

/** Delete whatever is AT a path — a file, symlink, or special file — never
 *  following a symlink to its target. Empty dirs are removed with rmdir. */
async function safeRemove(abs: string): Promise<boolean> {
  const stat = await lstat(abs).catch(() => null);
  if (!stat) return true;
  if (stat.isDirectory()) {
    return rmdir(abs).then(() => true).catch(() => false); // deepest-first pass empties it first
  }
  await rm(abs, { force: true }); // unlink of a file/symlink/special — never follows
  return true;
}

/** Remove any entry currently at a path (so a fresh write/symlink can replace it),
 *  deleting the link itself, never its target. */
async function removeAtPath(abs: string): Promise<void> {
  const stat = await lstat(abs).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) await rm(abs, { recursive: true, force: true });
  else await rm(abs, { force: true });
}

/** Write bytes to a path safely: remove anything there first (so we never write
 *  through a symlink or into a shared inode), then publish via a temp + rename. */
async function safeWriteFile(abs: string, bytes: Buffer): Promise<void> {
  await removeAtPath(abs);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.bridle-tmp-${randomUUID()}`;
  await writeFile(tmp, bytes);
  await rename(tmp, abs); // atomic publish into a path we just cleared
}
