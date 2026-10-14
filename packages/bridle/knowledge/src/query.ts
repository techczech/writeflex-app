import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Bundle } from "./bundle.ts";
import { readDoc } from "./bundle.ts";
import type { Frontmatter, KnowledgeDoc } from "./types.ts";

export type DocQuery = { type?: string; tag?: string; where?: (fm: Frontmatter) => boolean };

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

function matches(doc: KnowledgeDoc, q: DocQuery): boolean {
  const fm = doc.frontmatter;
  if (!fm) return false;
  if (q.type !== undefined && fm.type !== q.type) return false;
  if (q.tag !== undefined && !(fm.tags ?? []).includes(q.tag)) return false;
  if (q.where !== undefined && !q.where(fm)) return false;
  return true;
}

export async function queryDocs(bundle: Bundle, q: DocQuery): Promise<KnowledgeDoc[]> {
  const docs: KnowledgeDoc[] = [];
  await walkMarkdown(bundle, bundle.root, "", async (relPath) => {
    const doc = await readDoc(bundle, relPath);
    if (matches(doc, q)) docs.push(doc);
  });
  return docs;
}
