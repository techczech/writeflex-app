import { lstat, readdir, readlink } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join } from "node:path";

/**
 * The confined, metadata-only tree walk (PRD Decision 7, tickets T1+T4).
 *
 * This is the one place the versioning engine touches the user's folder, so it
 * is deliberately paranoid:
 *  - it uses `lstat`, never `stat`, so a symlink is seen AS a symlink and is
 *    never followed — a link to `~/.ssh/id_rsa` is recorded as a link, never read;
 *  - it never descends into a symlinked directory, so the walk cannot be steered
 *    out of the folder;
 *  - special files (fifo/socket/device) are recorded present-but-not-read (reading
 *    one can hang or transmit data);
 *  - it reads no file *contents* at all — only size / mtime / inode, which is what
 *    makes a checkpoint near-free even for gigabytes of media (PRD Decision 2).
 */

export type WalkEntryKind = "file" | "dir" | "symlink" | "special";
export type WalkUncapturedReason = "mount" | "unreadable-dir";

export class VersioningWorkspaceMissingError extends Error {
  constructor(readonly workspacePath: string) {
    super(`Versioning workspace does not exist: ${workspacePath}`);
    this.name = "VersioningWorkspaceMissingError";
  }
}

export class VersioningWorkspaceUnreadableError extends Error {
  readonly cause: unknown;

  constructor(readonly workspacePath: string, cause: unknown) {
    super(`Versioning workspace cannot be read: ${workspacePath}`);
    this.name = "VersioningWorkspaceUnreadableError";
    this.cause = cause;
  }
}

export type WalkEntry = {
  /** POSIX-style path relative to the walk root. */
  relPath: string;
  kind: WalkEntryKind;
  /** Byte size for a regular file; 0 otherwise. */
  size: number;
  mtimeMs: number;
  /** Inode — part of the stat-index change key, and hardlink detection. */
  ino: number;
  /** Hardlink count; > 1 means the inode is shared (PRD Decision 7). */
  nlink: number;
  /** For a symlink only: the raw link target string. Never resolved/followed. */
  linkTarget?: string;
  /** The path exists, but traversal stopped before its subtree could be captured. */
  uncaptured?: { reason: WalkUncapturedReason };
};

const OS_JUNK_NAMES = new Set([
  ".DS_Store",
  ".localized",
  "Thumbs.db",
  "desktop.ini",
  "Icon\r",
]);

/** Names excluded by default: root bookkeeping plus OS junk at any depth. */
const DEFAULT_EXCLUDES = new Set([
  ".bridle-workspace",
  ".bridle",
  ".bridle-trash",
  ...OS_JUNK_NAMES,
]);

function isOsJunkName(name: string): boolean {
  return OS_JUNK_NAMES.has(name);
}

/** Historical manifests can contain junk captured before the default exclusion. */
export function isOsJunkRelPath(relPath: string): boolean {
  return isOsJunkName(relPath.slice(relPath.lastIndexOf("/") + 1));
}

export type WalkLstat = (path: string) => Promise<Stats>;
export type WalkReaddir = (path: string) => Promise<Dirent[]>;

export type WalkOptions = {
  exclude?: Set<string>;
  /** Narrow test seam for cross-device traversal without requiring a real mount. */
  lstat?: WalkLstat;
  /** Narrow test seam for root and nested scandir failures. */
  readdir?: WalkReaddir;
};

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export async function walkWorkspace(root: string, opts: WalkOptions = {}): Promise<WalkEntry[]> {
  const exclude = opts.exclude ?? DEFAULT_EXCLUDES;
  const lstatPath = opts.lstat ?? lstat;
  const readdirPath = opts.readdir
    ?? ((path: string) => readdir(path, { withFileTypes: true }));
  let rootDevice: number;
  try {
    rootDevice = (await lstatPath(root)).dev;
  } catch (error) {
    if (isNotFound(error)) throw new VersioningWorkspaceMissingError(root);
    throw error;
  }
  const entries: WalkEntry[] = [];

  const visit = async (absDir: string, relDir: string): Promise<boolean> => {
    let dirents;
    try {
      dirents = await readdirPath(absDir);
    } catch (error) {
      if (relDir === "") {
        if (isNotFound(error)) throw new VersioningWorkspaceMissingError(root);
        throw new VersioningWorkspaceUnreadableError(root, error);
      }
      return false;
    }
    for (const dirent of dirents) {
      if (
        isOsJunkName(dirent.name)
        || (relDir === "" && exclude.has(dirent.name))
      ) {
        continue;
      }
      const abs = join(absDir, dirent.name);
      const relPath = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
      let stat;
      try {
        stat = await lstatPath(abs); // never follows a symlink
      } catch {
        continue; // vanished between readdir and lstat
      }
      const base = { relPath, size: 0, mtimeMs: stat.mtimeMs, ino: stat.ino, nlink: stat.nlink };
      if (stat.isSymbolicLink()) {
        const linkTarget = await readlink(abs).catch(() => "");
        entries.push({ ...base, kind: "symlink", linkTarget });
      } else if (stat.dev !== rootDevice) {
        // A mounted/FUSE child is in the namespace but outside this workspace's
        // device boundary. Record it present-but-unread and never descend/hash.
        entries.push({ ...base, kind: "special", uncaptured: { reason: "mount" } });
      } else if (stat.isDirectory()) {
        const entry: WalkEntry = { ...base, kind: "dir" };
        entries.push(entry);
        if (!await visit(abs, relPath)) {
          entry.uncaptured = { reason: "unreadable-dir" };
        }
      } else if (stat.isFile()) {
        entries.push({ ...base, kind: "file", size: stat.size });
      } else {
        entries.push({ ...base, kind: "special" }); // fifo / socket / device — never read
      }
    }
    return true;
  };

  await visit(root, "");
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return entries;
}
