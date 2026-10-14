import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import type { Capability, CapabilityContext, CapabilityResult } from "@bridle/core";
import { listLevel, readDoc, type Bundle } from "./bundle.ts";
import { renderIndex } from "./indexes.ts";
import { renderLogAppend } from "./log.ts";
import { isReservedFile, resolveLogFile } from "./naming.ts";
import { serializeDoc } from "./frontmatter.ts";
import type { KnowledgeDoc } from "./types.ts";

export type WriteOp =
  | { op: "write_doc"; path: string; doc: KnowledgeDoc }
  | { op: "write_raw"; path: string; content: string }
  | { op: "delete_doc"; path: string };

const WRITE_PARAMETERS = {
  type: "object",
  properties: {
    op: { type: "string" },
    path: { type: "string" },
    content: { type: "string" },
    doc: { type: "object" },
  },
  required: ["op", "path"],
} as Capability<WriteOp, { path: string }>["parameters"];

const DELETE_PARAMETERS = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
} as Capability<{ path: string }, { path: string }>["parameters"];

export function writeDoc(path: string, doc: KnowledgeDoc): WriteOp {
  return { op: "write_doc", path, doc };
}

export function writeRaw(path: string, content: string): WriteOp {
  return { op: "write_raw", path, content };
}

export function deleteDoc(path: string): WriteOp {
  return { op: "delete_doc", path };
}

function insideRoot(root: string, target: string): boolean {
  return target !== root && target.startsWith(`${root}${sep}`);
}

function targetPath(bundleRoot: string, inputPath: string): string {
  const root = resolve(bundleRoot);
  const target = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  if (!insideRoot(root, target)) throw new Error(`Path is outside the bundle root: ${inputPath}`);
  return target;
}

function safeTouchedPath(bundleRoot: string, inputPath: string): string[] {
  try {
    return [targetPath(bundleRoot, inputPath)];
  } catch {
    return [];
  }
}

function errorResult(message: string): CapabilityResult<{ path: string }> {
  return { text: message, isError: true };
}

async function applyWriteOp(bundleRoot: string, op: WriteOp): Promise<CapabilityResult<{ path: string }>> {
  if (op.op === "delete_doc") {
    return errorResult("delete_doc must be executed through the destructive delete capability.");
  }

  let target: string;
  try {
    target = targetPath(bundleRoot, op.path);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }

  if (op.op === "write_doc") {
    if (isReservedFile(basename(op.path))) return errorResult("Reserved index/log files must be written with write_raw.");
    if (!op.doc.frontmatter?.type.trim()) return errorResult("write_doc requires frontmatter.type.");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, serializeDoc(op.doc), "utf8");
    return { text: `Wrote ${op.path}`, details: { path: target } };
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, op.content, "utf8");
  return { text: `Wrote ${op.path}`, details: { path: target } };
}

export function createBundleWriteCapability(bundleRoot: string): Capability<WriteOp, { path: string }> {
  return {
    name: "knowledge.write_bundle",
    label: "Write knowledge bundle file",
    description: "Write a document or raw reserved file inside one knowledge bundle.",
    risk: "write",
    parameters: WRITE_PARAMETERS,
    touchedPaths: (input) => safeTouchedPath(bundleRoot, input.path),
    preview: (input) => `${input.op}: ${input.path}`,
    execute: async (input) => applyWriteOp(bundleRoot, input),
  };
}

export function createBundleDeleteCapability(bundleRoot: string): Capability<{ path: string }, { path: string }> {
  return {
    name: "knowledge.delete_doc",
    label: "Delete knowledge bundle file",
    description: "Delete a document inside one knowledge bundle.",
    risk: "destructive",
    parameters: DELETE_PARAMETERS,
    touchedPaths: (input) => safeTouchedPath(bundleRoot, input.path),
    preview: (input) => `delete: ${input.path}`,
    execute: async (input) => {
      let target: string;
      try {
        target = targetPath(bundleRoot, input.path);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
      await unlink(target);
      return { text: `Deleted ${input.path}`, details: { path: target } };
    },
  };
}

function cleanRelPath(relPath: string): string {
  if (relPath === "/" || relPath === "") return "";
  return relPath.replace(/^\/+/, "").replace(/\/+$/, "");
}

function folderNameFor(bundle: Bundle, folderPath: string): string {
  const clean = cleanRelPath(folderPath);
  return clean ? posix.basename(clean) : basename(bundle.root);
}

function inFolder(folderPath: string, fileName: string): string {
  const clean = cleanRelPath(folderPath);
  return [clean, fileName].filter(Boolean).join("/");
}

async function existingLog(bundle: Bundle, folderPath: string, folderName: string): Promise<string | null> {
  const entries = await listLevel(bundle, folderPath);
  const logName = resolveLogFile(entries.filter((entry) => entry.kind === "log").map((entry) => entry.name), folderName);
  if (!logName) return null;
  return readFile(join(bundle.root, inFolder(folderPath, logName)), "utf8");
}

export async function commitFolderUpdate(args: {
  bundle: Bundle;
  folderPath: string;
  date: string;
  logEntries: string[];
  execute: (op: WriteOp) => Promise<CapabilityResult<{ path: string }>>;
}): Promise<void> {
  const entries = await listLevel(args.bundle, args.folderPath);
  const docs = await Promise.all(entries.filter((entry) => entry.kind === "doc").map((entry) => readDoc(args.bundle, entry.path)));
  const folderName = folderNameFor(args.bundle, args.folderPath);
  const index = renderIndex(folderName, entries, docs);
  const log = renderLogAppend(await existingLog(args.bundle, args.folderPath, folderName), folderName, args.date, args.logEntries);

  for (const op of [writeRaw(inFolder(args.folderPath, index.path), index.content), writeRaw(inFolder(args.folderPath, log.path), log.content)]) {
    const result = await args.execute(op);
    if (result.isError) throw new Error(result.text);
  }
}
