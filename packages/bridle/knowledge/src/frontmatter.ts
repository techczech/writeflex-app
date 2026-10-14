import { parse, stringify } from "yaml";
import type { Frontmatter, KnowledgeDoc } from "./types.ts";

const RESERVED_KEYS = new Set(["type", "title", "description", "resource", "tags", "timestamp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? value : undefined;
}

function toFrontmatter(parsed: unknown): Frontmatter | null {
  if (!isRecord(parsed)) return null;

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!RESERVED_KEYS.has(key)) extra[key] = value;
  }

  return {
    type: asString(parsed.type) ?? "",
    ...(asString(parsed.title) !== undefined ? { title: asString(parsed.title) } : {}),
    ...(asString(parsed.description) !== undefined ? { description: asString(parsed.description) } : {}),
    ...(asString(parsed.resource) !== undefined ? { resource: asString(parsed.resource) } : {}),
    ...(asStringArray(parsed.tags) !== undefined ? { tags: asStringArray(parsed.tags) } : {}),
    ...(asString(parsed.timestamp) !== undefined ? { timestamp: asString(parsed.timestamp) } : {}),
    extra,
  };
}

function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
  if (!raw.startsWith("---\n")) return null;
  const closing = raw.indexOf("\n---", 4);
  if (closing === -1) return null;

  const delimiterEnd = closing + "\n---".length;
  const next = raw[delimiterEnd];
  if (next !== "\n" && next !== "\r" && next !== undefined) return null;

  const bodyStart = next === "\r" && raw[delimiterEnd + 1] === "\n" ? delimiterEnd + 2 : delimiterEnd + (next ? 1 : 0);
  return { yaml: raw.slice(4, closing), body: raw.slice(bodyStart) };
}

export function parseDoc(raw: string, path: string): KnowledgeDoc {
  const split = splitFrontmatter(raw);
  if (!split) return { path, frontmatter: null, body: raw };

  try {
    const frontmatter = toFrontmatter(parse(split.yaml));
    if (!frontmatter) return { path, frontmatter: null, body: raw };
    return { path, frontmatter, body: split.body };
  } catch {
    return { path, frontmatter: null, body: raw };
  }
}

export function serializeDoc(doc: KnowledgeDoc): string {
  if (!doc.frontmatter) return doc.body;

  const data: Record<string, unknown> = { type: doc.frontmatter.type };
  if (doc.frontmatter.title !== undefined) data.title = doc.frontmatter.title;
  if (doc.frontmatter.description !== undefined) data.description = doc.frontmatter.description;
  if (doc.frontmatter.resource !== undefined) data.resource = doc.frontmatter.resource;
  if (doc.frontmatter.tags !== undefined) data.tags = doc.frontmatter.tags;
  if (doc.frontmatter.timestamp !== undefined) data.timestamp = doc.frontmatter.timestamp;
  for (const [key, value] of Object.entries(doc.frontmatter.extra)) data[key] = value;

  return `---\n${stringify(data)}---\n${doc.body}`;
}
