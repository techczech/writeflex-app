import { existsSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { parseDoc } from "./frontmatter.ts";
import { isReservedFile, resolveIndexFile } from "./naming.ts";
import type { KnowledgeDoc } from "./types.ts";

export type BundleEntry =
  | { kind: "folder"; name: string; path: string; hasIndex: boolean }
  | { kind: "doc"; name: string; path: string }
  | { kind: "index" | "log"; name: string; path: string };

export type Bundle = { root: string };

export function openBundle(root: string): Bundle {
  const absolute = resolve(root);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`Bundle root not found: ${root}`);
  }
  return { root: absolute };
}

function cleanRelPath(relPath: string): string {
  if (relPath === "/" || relPath === "") return "";
  return relPath.replace(/^\/+/, "").replace(/\/+$/, "");
}

function fsPath(bundle: Bundle, relPath: string): string {
  const target = resolve(bundle.root, cleanRelPath(relPath));
  if (target !== bundle.root && !target.startsWith(`${bundle.root}${sep}`)) {
    throw new Error(`Bundle path escapes root: ${relPath}`);
  }
  return target;
}

function bundlePath(relPath: string, name: string, kind: "file" | "folder"): string {
  const base = cleanRelPath(relPath);
  const joined = `/${[base, name].filter(Boolean).join("/")}`;
  return kind === "folder" ? `${joined}/` : joined;
}

function reservedKind(fileName: string): "index" | "log" | null {
  if (fileName === "index.md" || fileName.startsWith("_INDEX-")) return "index";
  if (fileName === "log.md" || fileName.startsWith("_LOG-")) return "log";
  return null;
}

export async function listLevel(bundle: Bundle, relPath: string): Promise<BundleEntry[]> {
  const dir = fsPath(bundle, relPath);
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: BundleEntry[] = [];

  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    if (dirent.isDirectory()) {
      const childNames = (await readdir(resolve(dir, dirent.name), { withFileTypes: true })).map((entry) => entry.name);
      entries.push({
        kind: "folder",
        name: dirent.name,
        path: bundlePath(relPath, dirent.name, "folder"),
        hasIndex: resolveIndexFile(childNames, dirent.name) !== null,
      });
      continue;
    }
    if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;

    const kind = reservedKind(dirent.name);
    entries.push({
      kind: kind ?? "doc",
      name: dirent.name,
      path: bundlePath(relPath, dirent.name, "file"),
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readDoc(bundle: Bundle, relPath: string): Promise<KnowledgeDoc> {
  const path = fsPath(bundle, relPath);
  const raw = await readFile(path, "utf8");
  const docPath = bundlePath(cleanRelPath(relPath).split("/").slice(0, -1).join("/"), basename(path), "file");
  if (isReservedFile(basename(path))) return { path: docPath, frontmatter: null, body: raw };
  return parseDoc(raw, docPath);
}
