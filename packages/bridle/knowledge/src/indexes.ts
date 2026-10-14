import { basename } from "node:path";
import type { BundleEntry } from "./bundle.ts";
import { houseIndexName } from "./naming.ts";
import type { KnowledgeDoc } from "./types.ts";

function docTitle(doc: KnowledgeDoc): string {
  return doc.frontmatter?.title ?? basename(doc.path);
}

function docDescription(doc: KnowledgeDoc): string {
  return doc.frontmatter?.description ?? "";
}

function relativeDocLink(path: string): string {
  return basename(path);
}

function folderIndexLink(entry: Extract<BundleEntry, { kind: "folder" }>): string {
  return entry.hasIndex ? `${entry.name}/${houseIndexName(entry.name)}` : `${entry.name}/`;
}

export function renderIndex(folderName: string, entries: BundleEntry[], docs: KnowledgeDoc[]): { path: string; content: string } {
  const lines = [`# ${houseIndexName(folderName).replace(/\.md$/, "")}`, ""];

  for (const doc of docs) {
    lines.push(`- [${docTitle(doc)}](${relativeDocLink(doc.path)}) — ${docDescription(doc)}`);
  }

  const folders = entries.filter((entry): entry is Extract<BundleEntry, { kind: "folder" }> => entry.kind === "folder");
  if (folders.length > 0) {
    lines.push("", "## Folders", "");
    for (const folder of folders) lines.push(`- [${folder.name}](${folderIndexLink(folder)})`);
  }

  lines.push("");
  return { path: houseIndexName(folderName), content: lines.join("\n") };
}
