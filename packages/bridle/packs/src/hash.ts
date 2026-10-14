import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { isPackHashExcludedName } from "./filesystem-policy.ts";

/**
 * Pack hashes are computed over a deterministic filesystem walk, not git
 * state, so authoring checkouts, clean clones, and app bundle copies agree.
 */
export { PACK_HASH_EXCLUDED_NAMES } from "./filesystem-policy.ts";

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

async function listHashableFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (isPackHashExcludedName(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listHashableFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
  return files;
}

export async function computePackContentHash(root: string): Promise<string> {
  const files = (await listHashableFiles(root)).sort();
  const hash = createHash("sha256");

  for (const file of files) {
    if (!isSafeRelativePath(file)) continue;
    const bytes = await readFile(join(root, file));
    hash.update(file);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }

  return `sha256:${hash.digest("hex")}`;
}
