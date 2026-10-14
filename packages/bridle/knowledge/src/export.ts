import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Bundle } from "./bundle.ts";

type ExportCounts = { files: number; aliased: number };

function stockAliasFor(fileName: string, siblingNames: Set<string>): string | null {
  if (fileName.startsWith("_INDEX-") && fileName.endsWith(".md") && !siblingNames.has("index.md")) return "index.md";
  if (fileName.startsWith("_LOG-") && fileName.endsWith(".md") && !siblingNames.has("log.md")) return "log.md";
  return null;
}

async function copyTree(srcDir: string, destDir: string): Promise<ExportCounts> {
  await mkdir(destDir, { recursive: true });
  const entries = (await readdir(srcDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const siblingNames = new Set(entries.map((entry) => entry.name));
  const counts: ExportCounts = { files: 0, aliased: 0 };

  for (const entry of entries) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      const child = await copyTree(src, dest);
      counts.files += child.files;
      counts.aliased += child.aliased;
      continue;
    }
    if (!entry.isFile()) continue;

    await copyFile(src, dest);
    counts.files++;

    const alias = stockAliasFor(entry.name, siblingNames);
    if (alias) {
      await copyFile(src, join(destDir, alias));
      counts.aliased++;
    }
  }

  return counts;
}

export async function exportStrictOkf(bundle: Bundle, destRoot: string): Promise<{ files: number; aliased: number }> {
  if (existsSync(destRoot)) throw new Error(`Destination already exists: ${destRoot}`);
  return copyTree(bundle.root, destRoot);
}
