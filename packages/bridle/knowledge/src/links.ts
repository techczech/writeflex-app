import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { posix } from "node:path";
import type { Bundle } from "./bundle.ts";
import { readDoc } from "./bundle.ts";
import type { KnowledgeDoc } from "./types.ts";

export type LinkEdge = { from: string; to: string; text: string };

const LINK_PATTERN = /(!)?\[([^\]]+)\]\(([^)]+)\)/g;
const EXTERNAL_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

function normalizeTarget(from: string, target: string): string | null {
  if (EXTERNAL_PATTERN.test(target)) return null;
  if (target.startsWith("#")) return null;
  const raw = target.split("#")[0]?.split("?")[0] ?? "";
  if (!raw) return null;
  if (raw.startsWith("/")) return posix.normalize(raw);
  return posix.normalize(posix.join(posix.dirname(from), raw)).replace(/^([^/])/, "/$1");
}

export function extractLinks(doc: KnowledgeDoc): LinkEdge[] {
  const edges: LinkEdge[] = [];
  for (const match of doc.body.matchAll(LINK_PATTERN)) {
    const [, imageMarker, text, target] = match;
    if (imageMarker || !text || !target) continue;
    const to = normalizeTarget(doc.path, target);
    if (!to) continue;
    edges.push({ from: doc.path, to, text });
  }
  return edges;
}

async function walkMarkdown(bundle: Bundle, fsDir: string, relDir: string, visit: (relPath: string) => Promise<void>): Promise<void> {
  const entries = (await readdir(fsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const childFs = join(fsDir, entry.name);
    const childRel = `${relDir}/${entry.name}`.replace(/\/+/g, "/");
    if (entry.isDirectory()) {
      await walkMarkdown(bundle, childFs, childRel, visit);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      await visit(childRel);
    }
  }
}

export async function buildGraph(bundle: Bundle): Promise<LinkEdge[]> {
  const edges: LinkEdge[] = [];
  await walkMarkdown(bundle, bundle.root, "", async (relPath) => {
    const doc = await readDoc(bundle, relPath);
    if (doc.frontmatter === null) return;
    edges.push(...extractLinks(doc));
  });
  return edges;
}
