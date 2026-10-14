import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { ABSENT_HASH } from "./snapshots.ts";

/**
 * Baseline identity for a path that is not a regular file (a directory, symlink,
 * or special file). We never read its bytes — a directory read throws EISDIR and
 * a symlink read would follow the link out of the workspace. Its identity in a
 * baseline is simply "not a content-hashable file", which is enough for staleness.
 */
export const NON_FILE_HASH = "NONFILE";

/**
 * Directory-safe content identity. A regular file hashes to sha256 of its bytes;
 * anything else (missing / directory / symlink / fifo / socket / device) maps to
 * a stable marker without ever reading through it. Every baseline, staleness, and
 * preview check must use THIS — reading a folder as a file is an EISDIR crash and
 * reading a symlink follows it outside the workspace.
 */
export async function contentHashOf(path: string): Promise<string> {
  if (!existsSync(path)) return ABSENT_HASH;
  const stat = await lstat(path);
  if (!stat.isFile()) return NON_FILE_HASH;
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
