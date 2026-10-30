import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { physicalWorkspacePath } from "./workspace-containment.ts";

export const ABSENT_PATH = "ABSENT";
export const DIRECTORY_PATH = "directory";

/** A portable, normalised workspace-relative path with no traversal components. */
export function safeRelativePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes("\\")
    && path.split("/").every((part) => part !== "." && part !== ".." && part !== "");
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** No link targets or file contents cross this identity seam. */
export async function turnPathIdentity(path: string): Promise<string> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return ABSENT_PATH;
  if (stat.isSymbolicLink()) return `symlink-sha256:${hash(await readlink(path))}`;
  if (stat.isDirectory()) return DIRECTORY_PATH;
  if (!stat.isFile()) return `special:${stat.mode}`;
  return hash(await readFile(path));
}

/** Expand declared folder targets into individual paths, without following links. */
export async function captureTurnPaths(paths: readonly string[]): Promise<Map<string, string>> {
  const identities = new Map<string, string>();
  async function visit(path: string): Promise<void> {
    if (identities.has(path)) return;
    const identity = await turnPathIdentity(path);
    identities.set(path, identity);
    if (identity !== DIRECTORY_PATH) return;
    for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  for (const path of paths) await visit(path);
  return identities;
}

/** Undefined means the declared target resolves outside the workspace. */
export function workspaceRelativePath(root: string | undefined, path: string): string | undefined {
  if (!root || !isAbsolute(path)) return undefined;
  const physical = physicalWorkspacePath(root, path);
  if (!physical) return undefined;
  const { canonicalRoot } = physical;
  const isOutside = (path: string) => isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`);
  let lexical = relative(resolve(root), resolve(path));
  // Content tools report canonical paths, even when the host supplied a root
  // beneath an aliased parent (for example macOS /var and /private/var).
  if (isOutside(lexical)) lexical = relative(canonicalRoot, resolve(path));
  if (isOutside(lexical)) return undefined;
  return lexical.split(sep).join("/");
}
