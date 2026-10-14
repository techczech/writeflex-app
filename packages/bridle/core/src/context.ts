import sharp from "sharp";
import { randomUUID } from "node:crypto";
import type { ContextItem } from "./events.ts";
import { executeCapability, type ExecutorDeps } from "./executor.ts";
import type { AgentTrigger, Capability, Manifest } from "./types.ts";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { UserContextSplit } from "./transcript-user-context.ts";

export type ContextReadResult =
  | { kind: "text"; text: string }
  | { kind: "binary"; base64: string; mime: string };

export type NormalizedImage = { base64: string; mime: string; width: number; height: number };

export interface ImageNormalizer {
  normalize(input: { base64: string; mime: string }): Promise<NormalizedImage>;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export class SharpImageNormalizer implements ImageNormalizer {
  async normalize(input: { base64: string; mime: string }): Promise<NormalizedImage> {
    const source = Buffer.from(input.base64, "base64");
    const pipeline = sharp(source).rotate().resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true });
    const jpeg = await pipeline.clone().jpeg({ quality: 82 }).toBuffer();
    let bytes = jpeg;
    let mime = "image/jpeg";
    if (input.mime === "image/png") {
      const png = await pipeline.clone().png().toBuffer();
      if (png.byteLength <= jpeg.byteLength) {
        bytes = png;
        mime = "image/png";
      }
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Normalised image exceeds 5 MB (${bytes.byteLength} bytes).`);
    }
    const metadata = await sharp(bytes).metadata();
    if (!metadata.width || !metadata.height) throw new Error("Normalised image has no dimensions.");
    return { base64: bytes.toString("base64"), mime, width: metadata.width, height: metadata.height };
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function appendContextBlock(text: string, items: Array<ContextItem & { resolvedContent?: string }>): string {
  if (items.length === 0) return text;
  return `${text}\n\n${contextBlocks(items)}`;
}

function contextBlocks(items: Array<ContextItem & { resolvedContent?: string }>): string {
  return items.map((item) => (
    `<bridle-context label="${escapeAttribute(item.label)}" kind="${item.kind}" transcript="${item.transcript}">`
      + `${item.resolvedContent ?? item.content ?? ""}</bridle-context>`
  )).join("\n");
}

function isContextReadResult(value: unknown): value is ContextReadResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ContextReadResult>;
  return (result.kind === "text" && typeof result.text === "string")
    || (result.kind === "binary" && typeof result.base64 === "string" && typeof result.mime === "string");
}

function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || /^(application\/(json|xml|yaml|javascript)|[^/]+\+json|[^/]+\+xml)$/i.test(mime);
}

export async function resolveContextItems(opts: {
  text: string;
  items: ContextItem[];
  manifest: Manifest;
  capabilities: Map<string, Capability>;
  trigger: AgentTrigger;
  sessionId: string;
  deps: ExecutorDeps;
  modelInput: readonly string[];
  imageNormalizer: ImageNormalizer;
}): Promise<{ providerText: string; images: ImageContent[]; filesRead: string[]; split: UserContextSplit }> {
  if (opts.items.some((item) => item.kind === "image") && !opts.modelInput.includes("image")) {
    throw new Error("Image Context Items are not supported by the selected model.");
  }
  const resolved: Array<ContextItem & { resolvedContent?: string }> = [];
  const images: ImageContent[] = [];
  const filesRead: string[] = [];
  for (const item of opts.items) {
    if (item.kind === "text") {
      resolved.push({ ...item, resolvedContent: item.content ?? "" });
      continue;
    }
    if (!item.path) throw new Error(`${item.kind} Context Item "${item.label}" requires a path.`);
    const reader = opts.manifest.contextReader ? opts.capabilities.get(opts.manifest.contextReader) : undefined;
    if (!reader || reader.risk !== "read") throw new Error("No context reader granted for path Context Items.");
    const toolCallId = `ctx-${randomUUID()}`;
    const result = await executeCapability(reader, { path: item.path }, {
      trigger: opts.trigger, sessionId: opts.sessionId, toolCallId,
    }, opts.deps);
    if (result.isError || !isContextReadResult(result.details)) {
      throw new Error(`Context reader failed for ${item.path}: expected ContextReadResult details.`);
    }
    await opts.deps.audit.record({
      type: "context.read", timestamp: Date.now(), sessionId: opts.sessionId,
      capability: reader.name, risk: "read", toolCallId, metadata: { path: item.path },
    });
    filesRead.push(item.path);
    if (item.kind === "file") {
      if (result.details.kind === "text") {
        resolved.push({ ...item, resolvedContent: result.details.text });
      } else if (isTextMime(result.details.mime)) {
        resolved.push({ ...item, resolvedContent: Buffer.from(result.details.base64, "base64").toString("utf8") });
      } else {
        throw new Error(`File Context Item ${item.path} returned non-text binary content (${result.details.mime}).`);
      }
      continue;
    }
    if (result.details.kind !== "binary") {
      throw new Error(`Image Context Item ${item.path} requires a binary ContextReadResult.`);
    }
    const normalized = item.raw
      ? result.details
      : await opts.imageNormalizer.normalize({ base64: result.details.base64, mime: result.details.mime });
    if (Buffer.from(normalized.base64, "base64").byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image Context Item ${item.path} exceeds 5 MB.`);
    }
    images.push({ type: "image", data: normalized.base64, mimeType: normalized.mime });
    resolved.push({ ...item, resolvedContent: `[image: ${normalized.mime}]` });
  }
  return {
    providerText: appendContextBlock(opts.text, resolved), images, filesRead,
    split: {
      userText: opts.text,
      hiddenContext: contextBlocks(resolved.filter((item) => item.transcript === "hidden")),
      visibleContext: contextBlocks(resolved.filter((item) => item.transcript === "visible")),
    },
  };
}
