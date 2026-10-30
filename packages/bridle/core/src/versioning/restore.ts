import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ABSENT_PATH, DIRECTORY_PATH, safeRelativePath, turnPathIdentity, workspaceRelativePath } from "../turn-paths.ts";
import { RestoreIncompleteError, RestoreRefusedError } from "../snapshots.ts";
import type { VersionStore } from "./store.ts";
import { takeCheckpointUnlocked } from "./checkpoint.ts";
import {
  isOsJunkRelPath,
  walkWorkspace,
  type WalkOptions,
} from "./walk.ts";
import type {
  NotRolledBackPath,
  CheckpointEntry,
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
  /** Exact workspace-relative paths to restore; omission retains whole-folder restore. */
  paths?: readonly string[];
  /** Turn-start source checkpoint for each selected path in a multi-turn undo. */
  sourceCheckpoints?: Readonly<Record<string, string>>;
  /** Turn undo rechecks user drift under the store lock, before mutations. */
  beforeRestore?: () => Promise<void>;
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
 * Whole-folder rewrites are deliberately non-atomic. Scoped turn restores first
 * refuse unselected children that would block removal, and recover touched paths
 * from the before-checkpoint if a later write or report fails.
 * Once the complete before-checkpoint
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
  recoverPartial = true,
  allowWrite?: (path: string) => Promise<boolean>,
): Promise<RestoreResult> {
  const target = await store.checkpoint(targetId);
  if (!target) throw new Error(`Unknown checkpoint: ${targetId}`);
  const selected = opts.paths ? new Set(opts.paths) : undefined;
  if (selected && [...selected].some((path) => !safeRelativePath(path))) {
    throw new Error("Restore paths must be plain workspace-relative paths.");
  }
  const targetEntries: CheckpointEntry[] = [];
  if (selected) {
    const sources = new Map([[targetId, target]]);
    for (const path of selected) {
      const sourceId = opts.sourceCheckpoints?.[path] ?? targetId;
      let source = sources.get(sourceId);
      if (!source) {
        const loaded = await store.checkpoint(sourceId);
        if (!loaded) throw new Error(`Unknown checkpoint: ${sourceId}`);
        source = loaded;
        sources.set(sourceId, source);
      }
      const entry = source.entries.find((candidate) => candidate.relPath === path);
      if (entry && !isOsJunkRelPath(path)) targetEntries.push(entry);
    }
  } else {
    targetEntries.push(...target.entries.filter((entry) => !isOsJunkRelPath(entry.relPath)));
  }
  const affectsSelectedPath = (path: string): boolean => !selected || [...selected].some((candidate) => candidate === path || candidate.startsWith(`${path}/`));
  const now = opts.createdAt ?? Date.now();

  // The rollback baseline belongs to the state that passed the guard.
  await opts.beforeRestore?.();
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

  let mutationsStarted = false;
  const written = new Map<string, string>();
  const createdDirectories = new Set<string>();
  const skippedRollback = new Set<string>();
  const leftBehindDirectories = new Set<string>();
  const markWrite = (path: string, identity: string): void => { written.set(path, identity); };
  const markDirectory = (path: string): void => { createdDirectories.add(path); };
  const rollback = async (): Promise<void> => {
    if (!selected || !recoverPartial || !written.size) return;
    const baseline = await store.checkpoint(before.id);
    if (!baseline) throw new Error(`Before-restore checkpoint disappeared: ${before.id}`);
    const baselinePaths = new Set(baseline.entries.map((entry) => entry.relPath));
    const cleanupDirectories = [...createdDirectories].filter((path) => !baselinePaths.has(path));
    const stillOurs = async (path: string): Promise<boolean> => {
      const absolute = join(root, path);
      const inside = workspaceRelativePath(root, dirname(absolute)) !== undefined;
      if (inside && await turnPathIdentity(absolute) === written.get(path)) return true;
      skippedRollback.add(path);
      return false;
    };
    const paths: string[] = [];
    for (const path of written.keys()) {
      if (!cleanupDirectories.includes(path) && await stillOurs(path)) paths.push(path);
    }
    // Reuse the restore engine under the same lock, with the preserved current
    // state as its target. Recheck identities immediately before each mutation,
    // including after object reads; recovery must not erase a concurrent edit.
    if (paths.length) {
      const recovered = await restoreToUnlocked(store, root, before.id, {
        paths, largeFileCeiling: opts.largeFileCeiling, label: "recover failed turn undo",
      }, false, stillOurs);
      const incomplete = [...recovered.report.uncaptured, ...recovered.report.notRolledBack];
      if (incomplete.length) throw new Error(`Undo rollback incomplete: ${incomplete.map((entry) => entry.relPath).join(", ")}`);
    }
    for (const path of cleanupDirectories.sort((left, right) => right.length - left.length)) {
      if (await stillOurs(path) && !await safeRemove(join(root, path))) leftBehindDirectories.add(path);
    }
  };
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
    const wanted = new Map(targetEntries.map((entry) => [entry.relPath, entry]));

    // 2. Remove anything present now that the target didn't have (deepest paths
    //    first so directories empty before removal). Explicitly uncaptured
    //    entries are left untouched: they are mount or unreadable-dir boundaries.
    const currentTree = await walkWorkspace(root, {
      ...(opts.lstat ? { lstat: opts.lstat } : {}),
      ...(opts.readdir ? { readdir: opts.readdir } : {}),
    });
    const current = currentTree.filter((entry) => !selected || selected.has(entry.relPath));
    if (selected) {
      const blockers = current.filter((entry) => {
        const targetKind = wanted.get(entry.relPath)?.kind;
        const removesFolder = entry.kind === "dir" && targetKind !== "dir";
        return removesFolder && currentTree.some((child) =>
          child.relPath.startsWith(`${entry.relPath}/`) && !selected.has(child.relPath));
      });
      if (blockers.length) {
        throw new RestoreRefusedError(targetId, blockers.map((entry) => ({
          path: entry.relPath, reason: "changed-after-turn",
        })));
      }
    }
    const protectedEntries: UncapturedPath[] = currentTree
      .filter((entry) => entry.uncaptured && affectsSelectedPath(entry.relPath))
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
    mutationsStarted = true;
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
        if (allowWrite && !await allowWrite(e.relPath)) continue;
        const removed = await safeRemove(join(root, e.relPath));
        if (removed) markWrite(e.relPath, ABSENT_PATH);
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
        if (allowWrite && !await allowWrite(e.relPath)) continue;
        await ensureRealDirChain(root, e.relPath, markWrite, markDirectory);
      } else if (e.kind === "symlink") {
        if (allowWrite && !await allowWrite(e.relPath)) continue;
        await ensureRealDirChain(root, dirname(e.relPath), markWrite, markDirectory);
        const abs = join(root, e.relPath);
        await removeAtPath(abs);
        markWrite(e.relPath, ABSENT_PATH);
        if (e.linkTarget) {
          await symlink(e.linkTarget, abs);
          markWrite(e.relPath, `symlink-sha256:${createHash("sha256").update(e.linkTarget).digest("hex")}`);
        }
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
        if (allowWrite && !await allowWrite(e.relPath)) continue;
        await ensureRealDirChain(root, dirname(e.relPath), markWrite, markDirectory);
        await safeWriteFile(join(root, e.relPath), bytes, (identity) => markWrite(e.relPath, identity));
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
      uncaptured: restored.report.uncaptured.filter((entry) => affectsSelectedPath(entry.relPath)),
      notRolledBack: [...notRolledBack.values()]
        .sort((left, right) => left.relPath.localeCompare(right.relPath)),
    };
    const incomplete = [...report.uncaptured, ...report.notRolledBack];
    if (selected && incomplete.length) {
      throw new Error(`Scoped restore incomplete: ${incomplete.map((entry) => `${entry.relPath} (${entry.reason})`).join(", ")}`);
    }
    return restored.noop
      ? { ...restored, beforeCheckpointId: null, report }
      : { ...restored, beforeCheckpointId: before.id, report };
  } catch (error) {
    if (error instanceof RestoreRefusedError && !mutationsStarted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    try {
      await rollback();
    } catch (rollbackError) {
      const recoveryMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      if (selected) throw new RestoreIncompleteError(targetId, [], [...written.keys()], `${message}; rollback failed: ${recoveryMessage}`, { cause: rollbackError });
      throw new VersioningRestoreError(`${message}; rollback failed: ${recoveryMessage}`, before.id);
    }
    if (selected) {
      const reportedPaths = new Set([...selected, ...skippedRollback, ...leftBehindDirectories]);
      throw new RestoreRefusedError(targetId, [...reportedPaths].map((path) => ({
        path, reason: leftBehindDirectories.has(path) ? "rollback-directory-left-behind"
          : skippedRollback.has(path) ? "changed-after-turn" : "restore-failed-rolled-back",
      })), { cause: error, changesRemain: leftBehindDirectories.size > 0 });
    }
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
async function ensureRealDirChain(
  root: string, relDir: string,
  onWrite: (path: string, identity: string) => void,
  onCreate: (path: string) => void,
): Promise<void> {
  let cur = root;
  let relative = "";
  for (const part of relDir.split(/[\\/]/).filter((p) => p && p !== ".")) {
    cur = join(cur, part);
    relative = relative ? `${relative}/${part}` : part;
    const stat = await lstat(cur).catch(() => null);
    if (stat?.isDirectory()) continue;
    if (stat) {
      await rm(cur, { recursive: true, force: true });
      onWrite(relative, ABSENT_PATH);
    }
    await mkdir(cur);
    onWrite(relative, DIRECTORY_PATH);
    onCreate(relative);
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
async function safeWriteFile(abs: string, bytes: Buffer, onWrite: (identity: string) => void): Promise<void> {
  await removeAtPath(abs);
  onWrite(ABSENT_PATH);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.bridle-tmp-${randomUUID()}`;
  await writeFile(tmp, bytes);
  await rename(tmp, abs); // atomic publish into a path we just cleared
  onWrite(createHash("sha256").update(bytes).digest("hex"));
}
