import { createHash } from "node:crypto";
import { constants, existsSync, type Dir } from "node:fs";
import { lstat, open, opendir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { DirectoryBaselineEntry, DirectoryMetadataEntry, ProposalBaseline } from "./proposals/types.ts";
import { ABSENT_HASH } from "./snapshots.ts";

/**
 * Baseline identity for a path that is not a regular file (a directory, symlink,
 * or special file). We never read its bytes — a directory read throws EISDIR and
 * a symlink read would follow the link out of the workspace. Its identity in a
 * legacy baseline is simply "not a content-hashable file". Folder consent uses
 * captureBaseline below to include every child.
 */
export const NON_FILE_HASH = "NONFILE";
export const DIRECTORY_HASH_PREFIX = "DIRECTORY:";
export const DIRECTORY_METADATA_HASH_PREFIX = "DIRECTORY_METADATA:";
export const DIRECTORY_TOO_LARGE_HASH = "DIRECTORY_TOO_LARGE";

/**
 * Directory-safe content identity. A regular file hashes to sha256 of its bytes;
 * anything else (missing / directory / symlink / fifo / socket / device) maps to
 * a stable marker without ever reading through it. Every baseline, staleness, and
 * preview check of a plain file uses this — reading a folder is an EISDIR crash and
 * reading a symlink follows it outside the workspace.
 */
export async function contentHashOf(path: string): Promise<string> {
  if (!existsSync(path)) return ABSENT_HASH;
  const stat = await lstat(path);
  if (!stat.isFile()) return NON_FILE_HASH;
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export const APPROVAL_LISTING_MAX_ENTRIES = 50;
export const DIRECTORY_BASELINE_MAX_ENTRIES = 1_000;
export const DIRECTORY_BASELINE_MAX_BYTES = 16 * 1024 * 1024;
export const DIRECTORY_METADATA_MAX_ENTRIES = 100_000;
export const FOLDER_TOO_LARGE_MESSAGE = "This folder has more than 100,000 items; move or delete it yourself";

export class FolderTooLargeError extends Error {
  readonly code = "folder-too-large";
  constructor() { super(FOLDER_TOO_LARGE_MESSAGE); this.name = "FolderTooLargeError"; }
}

type BaselineTier = "content" | "metadata";
type WalkLimits = { tier: BaselineTier; maxEntries?: number; maxBytes?: number };

/** Fresh captures choose a tier without reading any oversized folder's contents. */
export async function captureBaseline(path: string, limits?: WalkLimits): Promise<ProposalBaseline> {
  let root;
  try { root = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, hash: ABSENT_HASH };
    throw error;
  }
  if (!root.isDirectory()) return { path, hash: await contentHashOf(path) };
  // Rechecks keep the stored tier and bounds; they never fall back to a weaker identity.
  if (limits) return walkDirectory(path, limits);
  const metadata = await walkDirectory(path, { tier: "metadata" });
  if (metadata.directory?.baseline !== "complete") throw new FolderTooLargeError();
  if (metadata.directory.entryCount! > DIRECTORY_BASELINE_MAX_ENTRIES
    || metadata.directory.bytes! > DIRECTORY_BASELINE_MAX_BYTES) return metadata;
  const content = await walkDirectory(path, { tier: "content" });
  if (content.directory?.baseline === "complete") return content;
  // A writer may grow the folder between preflight and the content walk.
  const refreshed = await walkDirectory(path, { tier: "metadata" });
  if (refreshed.directory?.baseline !== "complete") throw new FolderTooLargeError();
  return refreshed;
}

async function walkDirectory(path: string, limits: WalkLimits): Promise<ProposalBaseline> {
  const { tier } = limits;
  const entryCap = tier === "content" ? DIRECTORY_BASELINE_MAX_ENTRIES : DIRECTORY_METADATA_MAX_ENTRIES;
  const maxEntries = Math.min(limits.maxEntries ?? entryCap, entryCap);
  const maxBytes = tier === "content"
    ? Math.min(limits.maxBytes ?? DIRECTORY_BASELINE_MAX_BYTES, DIRECTORY_BASELINE_MAX_BYTES)
    : limits.maxBytes ?? Infinity;
  const entries: (DirectoryBaselineEntry | DirectoryMetadataEntry)[] = [];
  const pending = [""];
  let bytes = 0;
  let entryCount = 0;
  let tooLarge = false;
  scan: while (pending.length) {
    const relative = pending.pop()!;
    const directoryPath = join(path, relative);
    const looked = await lstat(directoryPath);
    if (!looked.isDirectory()) throw new Error("Folder changed while capturing its consent baseline");
    const handle = await open(directoryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    let directory: Dir | undefined;
    try {
      const opened = await handle.stat();
      const isOpenedDirectory = (stat: typeof looked) =>
        stat.isDirectory() && stat.dev === opened.dev && stat.ino === opened.ino;
      if (!isOpenedDirectory(looked)) throw new Error("Folder changed before it could be opened");
      // Node/Bun opendir accepts a path, and Dir exposes no portable fd/stat
      // API for handle-relative enumeration. Keep the no-follow handle pinned;
      // check the path immediately before/after opendir and before each child.
      // Residual window: another process can replace the path between a check
      // and the next path-based syscall; these checks narrow, not remove, it.
      if (!isOpenedDirectory(await lstat(directoryPath))) throw new Error("Folder changed before enumeration");
      directory = await opendir(directoryPath);
      if (!isOpenedDirectory(await lstat(directoryPath))) throw new Error("Folder changed while being opened");
      for await (const child of directory) {
        // fstat on the pinned handle cannot detect replacement of the pathname
        // used by child lstat/open. Retain this check despite its syscall cost
        // to refuse a swapped parent before reading a child through that name.
        if (!isOpenedDirectory(await lstat(directoryPath))) throw new Error("Folder changed before reading a child");
        entryCount += 1;
        if (entryCount > maxEntries) { tooLarge = true; break scan; }
        const childPath = relative ? `${relative}/${child.name}` : child.name;
        const absolute = join(path, childPath);
        const stat = await lstat(absolute);
        const kind: DirectoryBaselineEntry["kind"] = stat.isSymbolicLink() ? "symlink"
          : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
        if (kind === "directory") pending.push(childPath);
        if (tier === "metadata") {
          if (kind === "file") bytes += stat.size;
          if (bytes > maxBytes) { tooLarge = true; break scan; }
          entries.push({ path: childPath, kind, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o7777,
            ino: stat.ino, dev: stat.dev, ctimeMs: stat.ctimeMs,
            ...(kind === "symlink" ? { linkTarget: await readlink(absolute) } : {}),
          });
          continue;
        }
        let hash = NON_FILE_HASH;
        if (kind === "symlink") {
          hash = createHash("sha256").update(await readlink(absolute)).digest("hex");
        } else if (kind === "file") {
          if (bytes + stat.size > maxBytes) { bytes += stat.size; tooLarge = true; break scan; }
          const digest = createHash("sha256");
          const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - bytes + 1));
            while (true) {
              const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1));
              if (!bytesRead) break;
              bytes += bytesRead;
              if (bytes > maxBytes) { tooLarge = true; break scan; }
              digest.update(buffer.subarray(0, bytesRead));
            }
          } finally { await file.close(); }
          hash = digest.digest("hex");
        }
        entries.push({ path: childPath, kind, hash, mode: stat.mode & 0o7777 });
      }
      if (!isOpenedDirectory(await lstat(directoryPath))) throw new Error("Folder changed during its baseline walk");
    } finally {
      try { await directory?.close(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error; }
      finally { await handle.close(); }
    }
  }
  if (tooLarge) return { path, hash: DIRECTORY_TOO_LARGE_HASH, directory: { baseline: "too-large", entryCount, bytes } };
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const prefix = tier === "metadata" ? DIRECTORY_METADATA_HASH_PREFIX : DIRECTORY_HASH_PREFIX;
  return {
    path,
    hash: prefix + createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    directory: tier === "metadata"
      ? { baseline: "complete", tier, entries: entries.slice(0, APPROVAL_LISTING_MAX_ENTRIES) as DirectoryMetadataEntry[], entryCount, bytes }
      : { baseline: "complete", tier, entries: entries.slice(0, APPROVAL_LISTING_MAX_ENTRIES) as DirectoryBaselineEntry[], entryCount, bytes },
  };
}

/** All proposal/consent checks use the captured baseline's identity scheme. */
export async function baselineHash(entry: ProposalBaseline): Promise<string> {
  if (!entry.directory) return contentHashOf(entry.path);
  if (entry.directory.baseline === "too-large") {
    // This is explicitly NOT a content baseline. Keep it actionable only while
    // still a folder; the executor must ask again and obtain a bounded complete baseline.
    try { return (await lstat(entry.path)).isDirectory() ? entry.hash : await contentHashOf(entry.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ABSENT_HASH;
      throw error;
    }
  }
  const tier = entry.directory.tier ?? "content";
  return (await captureBaseline(entry.path, {
    tier,
    maxEntries: entry.directory.entryCount ?? entry.directory.entries.length,
    maxBytes: entry.directory.bytes ?? (tier === "content" ? DIRECTORY_BASELINE_MAX_BYTES : Infinity),
  })).hash;
}


/** A directory-only record, including a pre-listing legacy record, is not consent. */
export async function baselineNeedsFolderConsent(entry: ProposalBaseline): Promise<boolean> {
  if (entry.directory?.baseline === "too-large") return true;
  if (entry.directory || entry.hash !== NON_FILE_HASH) return false;
  try { return (await lstat(entry.path)).isDirectory(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}


export function metadataBaselineNotice(entryCount: number): string {
  return `Large folder: ${entryCount.toLocaleString("en-GB")} ${entryCount === 1 ? "item" : "items"} checked by name, size and dates; file contents were not read.`;
}


/** Trim legacy/caller-supplied listings at every storage and delivery boundary. */
export function boundedBaselinePreview(entry: ProposalBaseline): ProposalBaseline {
  const directory = entry.directory;
  if (!directory) return entry;
  if (directory.baseline === "too-large") {
    return { ...entry, directory: { baseline: "too-large", entryCount: directory.entryCount, bytes: directory.bytes } };
  }
  const entryCount = directory.entryCount ?? directory.entries.length;
  // Slicing preserves the content/metadata variant's entry type.
  const preview = { ...directory, entryCount, entries: directory.entries.slice(0, APPROVAL_LISTING_MAX_ENTRIES) } as typeof directory;
  return { ...entry, directory: preview };
}
