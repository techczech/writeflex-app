import { createAgentSession, ModelRuntime, SessionManager, buildSessionContext } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { open as openFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { RecorderIntegrityError } from "./store.ts";
import type { BridleLane } from "../types.ts";
import { completeExecutionJournalJsonl } from "../execution-journal/torn-tail.ts";

const PAGE_SIZE = 50;
export const RECORDER_QUERY_ITEM_MAX_BYTES = 32 * 1024;
export const RECORDER_QUERY_RESPONSE_MAX_BYTES = 256 * 1024;

export type RecorderPage<T> = { items: T[]; nextPage?: number; continuation?: string };
export type RecorderRange = { from?: number; to?: number; page?: number; continuation?: string; groupContinuation?: string };

export interface TurnSummary {
  turnId: string;
  sessionId: string;
  lane: BridleLane | "legacy";
  promptPreview: string;
  trigger?: unknown;
  receipt?: unknown;
  /** ADR-0024: the model's recorded reasoning for this turn, if any. */
  reasoning?: string;
  toolCalls: Array<{ capability?: string; result?: string; paths?: string[]; toolCallId?: string }>;
  entryIds: string[];
}

export interface RecorderSearchResult { store: "audit" | "ledger" | "session" | "execution"; entryId: string; preview: string }
export interface RecorderTreeItem { entryId: string; parentId: string | null; type: string; depth: number }

type IndexedEntry = { entryId: string; value: Record<string, unknown> };

export interface RecorderQueries {
  turns(filter?: RecorderRange & { sessionId?: string }): Promise<RecorderPage<TurnSummary>>;
  contextAt(sessionId: string, entryId: string, page?: number, continuation?: string): Promise<{ messages: unknown[]; envelope?: unknown; entryIds: string[]; nextPage?: number; continuation?: string }>;
  searchRecord(query: string, filter?: RecorderRange): Promise<RecorderPage<RecorderSearchResult>>;
  egress(range: RecorderRange): Promise<{ items: Array<Record<string, unknown>>; groups: Array<{ destination: string; calls: number; costUsd: number }>; nextPage?: number; continuation?: string; groupContinuation?: string }>;
  costs(range: RecorderRange): Promise<RecorderPage<{ day: string; model: string; usage: Record<string, number>; costUsd: number; entryIds: string[] }>>;
  providersSeen(range?: RecorderRange): Promise<string[]>;
  tree(sessionId: string, page?: number, continuation?: string): Promise<RecorderPage<RecorderTreeItem>>;
  branch(entryId: string, page?: number, continuation?: string): Promise<RecorderPage<RecorderTreeItem>>;
  exportHtml(sessionId: string, outPath: string): Promise<string>;
  getBlob(hash: string): Promise<{ hash: string; bytes: number; content: Uint8Array; sizeWarning?: string }>;
}

export async function openRecorder(appDataDir: string): Promise<RecorderQueries> {
  const recorderDir = join(appDataDir, "recorder");
  const manifest = JSON.parse(await readFile(join(recorderDir, "MANIFEST.json"), "utf8")) as { recorderVersion?: unknown };
  if (manifest.recorderVersion !== 1) throw new Error(`Unsupported recorder version: ${String(manifest.recorderVersion)}`);

  const auditEntries = async (): Promise<IndexedEntry[]> => {
    const dir = join(recorderDir, "audit");
    if (!existsSync(dir)) return [];
    const output: IndexedEntry[] = [];
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort()) {
      const sessionId = file.slice(0, -6);
      output.push(...await readIndexedJsonl(join(dir, file), `audit:${sessionId}`, recorderDir));
    }
    return output;
  };
  const ledgerEntries = () => readIndexedJsonl(join(recorderDir, "model-access.jsonl"), "ledger", recorderDir);
  const sessionEntries = async (): Promise<IndexedEntry[]> => {
    const dir = join(appDataDir, "sessions");
    if (!existsSync(dir)) return [];
    const output: IndexedEntry[] = [];
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort()) {
      const sessionId = file.slice(0, -6);
      output.push(...await readIndexedJsonl(join(dir, file), `session:${sessionId}`, recorderDir));
    }
    return output;
  };
  const executionEntries = async (): Promise<IndexedEntry[]> => {
    const path = join(appDataDir, "executions", "execution-journal.jsonl");
    if (!existsSync(path)) return [];
    const complete = completeExecutionJournalJsonl(await readFile(path));
    const records = complete.bytes.toString("utf8").trimEnd().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const stateByAttempt = new Map<string, string>();
    for (const record of records) {
      if (typeof record.attemptId !== "string") continue;
      if (record.type === "registered") stateByAttempt.set(record.attemptId, "registered");
      if (record.type === "intent") stateByAttempt.set(record.attemptId, "unknown");
      if (record.type === "outcome" && typeof record.disposition === "string") stateByAttempt.set(record.attemptId, record.disposition);
    }
    return records.map((value, index) => ({
      entryId: `execution:${index}`,
      value: {
        ...(value.type === "identity-conflict"
          ? { state: "identity-conflict" }
          : typeof value.attemptId === "string"
            ? { state: stateByAttempt.get(value.attemptId) }
            : {}),
        ...value,
      },
    }));
  };

  return {
    async turns(filter = {}) {
      const byTurn = new Map<string, TurnSummary & { timestamp: number }>();
      for (const entry of await auditEntries()) {
        const value = entry.value;
        const turnId = typeof value.turnId === "string" ? value.turnId : undefined;
        const sessionId = typeof value.sessionId === "string" ? value.sessionId : undefined;
        if (!turnId || !sessionId || filter.sessionId && filter.sessionId !== sessionId) continue;
        const timestamp = typeof value.timestamp === "number" ? value.timestamp : 0;
        if (filter.from !== undefined && timestamp < filter.from || filter.to !== undefined && timestamp > filter.to) continue;
        const recordedLane = value.lane === "live" || value.lane === "mock" ? value.lane : undefined;
        const summary = byTurn.get(turnId) ?? {
          turnId, sessionId, lane: recordedLane ?? "legacy", promptPreview: "", toolCalls: [], entryIds: [], timestamp,
        };
        if (recordedLane) summary.lane = recordedLane;
        summary.entryIds.push(entry.entryId);
        if (value.type === "turn.start") {
          summary.promptPreview = typeof value.prompt === "string" ? value.prompt.slice(0, 200) : "";
          summary.trigger = value.trigger;
          summary.timestamp = timestamp;
        } else if (value.type === "turn.end") {
          summary.receipt = value.receipt;
          if (typeof value.reasoning === "string") summary.reasoning = value.reasoning;
        } else if (value.type === "capability.executed" || value.type === "capability.failed") {
          const inputPath = value.input && typeof value.input === "object" && typeof (value.input as { path?: unknown }).path === "string"
            ? [(value.input as { path: string }).path] : undefined;
          summary.toolCalls.push({
            ...(typeof value.capability === "string" ? { capability: value.capability } : {}),
            ...(typeof value.resultText === "string" ? { result: value.resultText } : {}),
            ...((Array.isArray(value.paths) ? value.paths : inputPath) ? { paths: (Array.isArray(value.paths) ? value.paths : inputPath) as string[] } : {}),
            ...(typeof value.toolCallId === "string" ? { toolCallId: value.toolCallId } : {}),
          });
        }
        byTurn.set(turnId, summary);
      }
      return page([...byTurn.values()].sort((a, b) => a.timestamp - b.timestamp).map(({ timestamp: _, ...item }) => item), filter.page, "turns", filter.continuation);
    },

    async contextAt(sessionId, entryId, pageNumber = 1, continuation) {
      const manager = await openSession(appDataDir, sessionId);
      if (!manager.getEntry(entryId)) throw new Error(`Unknown session entry: ${entryId}`);
      const branch = manager.getBranch(entryId);
      const context = buildSessionContext(manager.getEntries(), entryId);
      const envelopes = branch.filter((entry): entry is Extract<typeof entry, { type: "custom" }> => entry.type === "custom" && entry.customType === "bridle.envelope");
      const envelope = envelopes.at(-1)?.data;
      const envelopePrimitive = `contextAt-envelope:${sessionId}:${entryId}`;
      const entryIdsPrimitive = `contextAt-entryIds:${sessionId}:${entryId}`;
      const continuationState = continuation ? decodeContinuationToken(continuation) : undefined;
      if (continuationState?.primitive === envelopePrimitive || continuationState?.primitive === entryIdsPrimitive) {
        const continuingEnvelope = continuationState.primitive === envelopePrimitive;
        const boundedEnvelope = envelope === undefined ? undefined : boundValue(envelope, envelopePrimitive, continuingEnvelope ? continuationState.offset : 0);
        const boundedEntryIds = boundValue(branch.map((entry) => entry.id), entryIdsPrimitive, continuingEnvelope ? 0 : continuationState.offset);
        const nested = continuingEnvelope ? boundedEnvelope : boundedEntryIds;
        const nestedContinuation = isTruncated(nested) ? nested.continuation : undefined;
        const result = { messages: [], ...(boundedEnvelope !== undefined ? { envelope: boundedEnvelope } : {}), entryIds: boundedEntryIds, ...(nestedContinuation ? { continuation: nestedContinuation } : {}) };
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > RECORDER_QUERY_RESPONSE_MAX_BYTES) throw new Error("Unable to fit contextAt continuation within recorder byte budget");
        return result as Awaited<ReturnType<RecorderQueries["contextAt"]>>;
      }
      const boundedEnvelope = envelope === undefined ? undefined : boundValue(envelope, envelopePrimitive);
      const boundedEntryIds = boundValue(branch.map((entry) => entry.id), entryIdsPrimitive);
      const fixed = { ...(boundedEnvelope !== undefined ? { envelope: boundedEnvelope } : {}), entryIds: boundedEntryIds };
      let messageBudget = RECORDER_QUERY_RESPONSE_MAX_BYTES - Buffer.byteLength(JSON.stringify({ messages: [], ...fixed }), "utf8") - 1024;
      let result: { messages: unknown[]; envelope?: unknown; entryIds: unknown; nextPage?: number; continuation?: string };
      do {
        const paged = page(context.messages as unknown as Record<string, unknown>[], pageNumber, `contextAt:${sessionId}:${entryId}`, continuation, Math.max(RECORDER_QUERY_ITEM_MAX_BYTES, messageBudget));
        result = { messages: paged.items, ...fixed, ...(paged.nextPage ? { nextPage: paged.nextPage } : {}), ...(paged.continuation ? { continuation: paged.continuation } : {}) };
        if (Buffer.byteLength(JSON.stringify(result), "utf8") <= RECORDER_QUERY_RESPONSE_MAX_BYTES) return result as Awaited<ReturnType<RecorderQueries["contextAt"]>>;
        messageBudget -= 1024;
      } while (messageBudget >= RECORDER_QUERY_ITEM_MAX_BYTES);
      throw new Error("Unable to fit contextAt response within recorder byte budget");
    },

    async searchRecord(query, filter = {}) {
      const needle = query.toLowerCase();
      if (!needle) return { items: [] };
      const results: RecorderSearchResult[] = [];
      for (const entry of [...await auditEntries(), ...await ledgerEntries(), ...await sessionEntries(), ...await executionEntries()]) {
        const timestamp = typeof entry.value.timestamp === "number"
          ? entry.value.timestamp
          : typeof entry.value.ts === "number"
            ? entry.value.ts
            : typeof entry.value.at === "string"
              ? Date.parse(entry.value.at)
              : 0;
        if (filter.from !== undefined && timestamp < filter.from || filter.to !== undefined && timestamp > filter.to) continue;
        const text = JSON.stringify(entry.value);
        const index = text.toLowerCase().indexOf(needle);
        if (index === -1) continue;
        results.push({
          store: entry.entryId.startsWith("audit:")
            ? "audit"
            : entry.entryId.startsWith("session:")
              ? "session"
              : entry.entryId.startsWith("execution:")
                ? "execution"
                : "ledger",
          entryId: entry.entryId,
          preview: text.slice(Math.max(0, index - 80), index + needle.length + 120),
        });
      }
      return page(results, filter.page, "search", filter.continuation);
    },

    async egress(range) {
      const items: Array<Record<string, unknown>> = [];
      for (const entry of await ledgerEntries()) {
        if (!inRange(entry.value.ts, range)) continue;
        items.push({ ...entry.value, entryId: entry.entryId, destination: ledgerDestination(entry.value) });
      }
      for (const entry of await auditEntries()) {
        if (entry.value.type !== "turn.end" || !inRange(entry.value.timestamp, range)) continue;
        const receipt = entry.value.receipt as { egress?: { providerId?: string; modelId?: string }; usage?: { costUsd?: number } } | undefined;
        if (!receipt?.egress) continue;
        items.push({ entryId: entry.entryId, kind: "turn", destination: `${receipt.egress.providerId ?? "unknown"}/${receipt.egress.modelId ?? "unknown"}`, costUsd: receipt.usage?.costUsd ?? 0, receipt });
      }
      const paged = page(items, range.page, "egress", range.continuation, RECORDER_QUERY_RESPONSE_MAX_BYTES / 2);
      const pagedGroups = page(groupEgress(items), range.page, "egress-groups", range.groupContinuation, RECORDER_QUERY_RESPONSE_MAX_BYTES / 2);
      return { ...paged, groups: pagedGroups.items, ...(pagedGroups.continuation ? { groupContinuation: pagedGroups.continuation } : {}) };
    },

    async costs(range) {
      const grouped = new Map<string, { day: string; model: string; usage: Record<string, number>; costUsd: number; entryIds: string[] }>();
      const add = (entryId: string, ts: number, model: string, usage: unknown, costUsd: number) => {
        const day = new Date(ts).toISOString().slice(0, 10);
        const key = `${day}\0${model}`;
        const item = grouped.get(key) ?? { day, model, usage: {}, costUsd: 0, entryIds: [] };
        if (usage && typeof usage === "object") for (const [name, value] of Object.entries(usage)) if (typeof value === "number" && name !== "costUsd") item.usage[name] = (item.usage[name] ?? 0) + value;
        item.costUsd += costUsd;
        item.entryIds.push(entryId);
        grouped.set(key, item);
      };
      for (const entry of await ledgerEntries()) if (inRange(entry.value.ts, range)) add(entry.entryId, entry.value.ts as number, String(entry.value.model ?? entry.value.adapterId ?? "unknown"), entry.value.usage, Number(entry.value.costUsd ?? 0));
      for (const entry of await auditEntries()) {
        if (entry.value.type !== "turn.end" || !inRange(entry.value.timestamp, range)) continue;
        const receipt = entry.value.receipt as { egress?: { modelId?: string }; usage?: Record<string, number> } | undefined;
        add(entry.entryId, entry.value.timestamp as number, receipt?.egress?.modelId ?? "unknown", receipt?.usage, Number(receipt?.usage?.costUsd ?? 0));
      }
      return page([...grouped.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model)), range.page, "costs", range.continuation);
    },

    async providersSeen(range = {}) {
      const providers = new Set<string>();
      for (const entry of await ledgerEntries()) {
        if (!inRange(entry.value.ts, range)) continue;
        const destination = ledgerDestination(entry.value);
        providers.add(destination.split("/", 1)[0]!);
      }
      for (const entry of await auditEntries()) {
        if (entry.value.type !== "turn.end" || !inRange(entry.value.timestamp, range)) continue;
        const receipt = entry.value.receipt as { egress?: { providerId?: string } } | undefined;
        if (receipt?.egress?.providerId) providers.add(receipt.egress.providerId);
      }
      return [...providers].sort();
    },

    async tree(sessionId, pageNumber = 1, continuation) {
      const manager = await openSession(appDataDir, sessionId);
      const flattened: RecorderTreeItem[] = [];
      const visit = (nodes: ReturnType<typeof manager.getTree>, depth: number) => {
        for (const node of nodes) {
          flattened.push({ entryId: node.entry.id, parentId: node.entry.parentId, type: node.entry.type, depth });
          visit(node.children, depth + 1);
        }
      };
      visit(manager.getTree(), 0);
      return page(flattened, pageNumber, `tree:${sessionId}`, continuation);
    },

    async branch(entryId, pageNumber = 1, continuation) {
      const manager = await findSessionForEntry(appDataDir, entryId);
      return page(manager.getBranch(entryId).map((entry, depth) => ({ entryId: entry.id, parentId: entry.parentId, type: entry.type, depth })), pageNumber, `branch:${entryId}`, continuation);
    },

    async exportHtml(sessionId, outPath) {
      const manager = await openSession(appDataDir, sessionId);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        modelsStore: new InMemoryModelsStore(),
      });
      const { session } = await createAgentSession({
        cwd: manager.getCwd(), agentDir: appDataDir, modelRuntime,
        sessionManager: manager, noTools: "all",
      });
      try {
        return await session.exportToHtml(outPath);
      } finally {
        session.dispose();
      }
    },

    async getBlob(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new RecorderIntegrityError(`Invalid or missing recorder blob: ${hash}`);
      const path = join(recorderDir, "blobs", hash);
      if (!existsSync(path)) throw new RecorderIntegrityError(`Missing recorder blob ${hash}`);
      const info = await stat(path);
      const content = new Uint8Array(await readFile(path));
      return { hash, bytes: info.size, content, ...(info.size > 16 * 1024 ? { sizeWarning: `Blob is ${info.size} bytes.` } : {}) };
    },
  };
}

function page<T extends object>(items: T[], pageNumber = 1, primitive = "page", continuation?: string, responseBudget = RECORDER_QUERY_RESPONSE_MAX_BYTES): RecorderPage<T> {
  const current = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
  const decoded = continuation ? decodeContinuation(continuation, primitive) : undefined;
  const start = decoded?.index ?? (current - 1) * PAGE_SIZE;
  const limit = decoded ? items.length : Math.min(items.length, start + PAGE_SIZE);
  const output: T[] = [];
  let next: { index: number; offset: number } | undefined;
  for (let index = start; index < limit; index += 1) {
    const bounded = boundValue(items[index]!, primitive, decoded?.index === index ? decoded.offset : 0) as T;
    const boundedContinuation = isTruncated(bounded) ? bounded.continuation : undefined;
    const candidateContinuation = boundedContinuation
      ? encodeContinuation(primitive, index, continuationOffset(boundedContinuation))
      : undefined;
    const candidateBytes = Buffer.byteLength(JSON.stringify({ items: [...output, bounded], ...(candidateContinuation ? { continuation: candidateContinuation } : {}) }), "utf8");
    if (output.length && candidateBytes > responseBudget) {
      next = { index, offset: 0 };
      break;
    }
    output.push(bounded);
    if (candidateContinuation) {
      next = { index, offset: continuationOffset(boundedContinuation!) };
      break;
    }
  }
  if (!next && limit < items.length) next = { index: limit, offset: 0 };
  return {
    items: output,
    ...(!decoded && !next && limit < items.length ? { nextPage: current + 1 } : {}),
    ...(next ? { continuation: encodeContinuation(primitive, next.index, next.offset) } : {}),
  };
}

function boundValue(value: unknown, primitive: string, offset = 0): unknown {
  const serialised = JSON.stringify(value);
  if (Buffer.byteLength(serialised, "utf8") <= RECORDER_QUERY_ITEM_MAX_BYTES && offset === 0) return value;
  const chunkBytes = RECORDER_QUERY_ITEM_MAX_BYTES - 1024;
  const bytes = Buffer.from(serialised, "utf8");
  let end = Math.min(bytes.byteLength, offset + chunkBytes);
  while (end > offset && end < bytes.byteLength && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  const chunk = bytes.subarray(offset, end).toString("utf8");
  const nextOffset = end;
  return {
    ...identityOf(value),
    truncated: true,
    chunk,
    ...(nextOffset < bytes.byteLength ? { continuation: encodeContinuation(primitive, 0, nextOffset) } : {}),
  };
}

function identityOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(["entryId", "turnId", "sessionId", "destination", "day", "model"].flatMap((key) => key in record ? [[key, record[key]]] : []));
}

function isTruncated(value: unknown): value is { truncated: true; continuation?: string } {
  return !!value && typeof value === "object" && (value as { truncated?: unknown }).truncated === true;
}

function encodeContinuation(primitive: string, index: number, offset: number): string {
  return Buffer.from(JSON.stringify({ primitive, index, offset }), "utf8").toString("base64url");
}

function decodeContinuation(token: string, primitive: string): { index: number; offset: number } {
  try {
    const decoded = decodeContinuationToken(token);
    if (decoded.primitive !== primitive) throw new Error();
    return { index: decoded.index, offset: decoded.offset };
  } catch {
    throw new Error("Invalid recorder continuation token");
  }
}

function decodeContinuationToken(token: string): { primitive: string; index: number; offset: number } {
  const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { primitive?: unknown; index?: unknown; offset?: unknown };
  if (typeof decoded.primitive !== "string" || !Number.isInteger(decoded.index) || !Number.isInteger(decoded.offset) || (decoded.index as number) < 0 || (decoded.offset as number) < 0) {
    throw new Error("Invalid recorder continuation token");
  }
  return { primitive: decoded.primitive, index: decoded.index as number, offset: decoded.offset as number };
}

function continuationOffset(token: string): number {
  const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { offset: number };
  return decoded.offset;
}

function inRange(value: unknown, range: RecorderRange): boolean {
  if (typeof value !== "number") return false;
  return !(range.from !== undefined && value < range.from || range.to !== undefined && value > range.to);
}

async function openSession(appDataDir: string, sessionId: string): Promise<SessionManager> {
  const dir = join(appDataDir, "sessions");
  if (!existsSync(dir)) throw new Error(`Unknown recorder session: ${sessionId}`);
  const legacy = `${sessionId}.jsonl`;
  const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  files.sort((a, b) => Number(b === legacy) - Number(a === legacy) || a.localeCompare(b));
  for (const file of files) {
    const path = join(dir, file);
    if (await readSessionHeaderId(path) === sessionId) return SessionManager.open(path, dir);
  }
  throw new Error(`Unknown recorder session: ${sessionId}`);
}

/** Read only Pi's first JSONL entry before opening the matching session manager. */
async function readSessionHeaderId(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    handle = await openFile(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (end < 0) return undefined;
    const header = JSON.parse(buffer.subarray(0, end).toString("utf8")) as { type?: unknown; id?: unknown };
    return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function findSessionForEntry(appDataDir: string, entryId: string): Promise<SessionManager> {
  const dir = join(appDataDir, "sessions");
  for (const file of (await readdir(dir)).filter((name) => name.endsWith(".jsonl"))) {
    const path = join(dir, file);
    if (await readSessionHeaderId(path) && await containsSessionEntry(path, entryId)) return SessionManager.open(path, dir);
  }
  throw new Error(`Unknown session entry: ${entryId}`);
}

/** Validate candidate session entries without letting Pi open or repair unrelated files. */
async function containsSessionEntry(path: string, entryId: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { id?: unknown };
      if (entry.id === entryId) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function readIndexedJsonl(path: string, prefix: string, recorderDir: string): Promise<IndexedEntry[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n");
  const output: IndexedEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      if (lines.slice(index + 1).every((candidate) => candidate === "")) break;
      throw error;
    }
    validateBlobRefs(value, recorderDir, path);
    output.push({ entryId: `${prefix}:${index + 1}`, value });
  }
  return output;
}

function validateBlobRefs(value: unknown, recorderDir: string, journalPath: string): void {
  if (!value || typeof value !== "object") return;
  if (typeof (value as { $blob?: unknown }).$blob === "string") {
    const hash = (value as { $blob: string }).$blob;
    if (!existsSync(join(recorderDir, "blobs", hash))) throw new RecorderIntegrityError(`Missing recorder blob ${hash} referenced by ${journalPath}`);
    return;
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) validateBlobRefs(nested, recorderDir, journalPath);
}

function ledgerDestination(entry: Record<string, unknown>): string {
  const adapter = String(entry.adapterId ?? "unknown");
  const provider = adapter.includes(":") ? adapter.split(":").at(-1)! : adapter;
  return `${provider}/${String(entry.model ?? "unknown")}`;
}

function groupEgress(items: Array<Record<string, unknown>>): Array<{ destination: string; calls: number; costUsd: number }> {
  const groups = new Map<string, { destination: string; calls: number; costUsd: number }>();
  for (const item of items) {
    const destination = String(item.destination ?? "unknown/unknown");
    const group = groups.get(destination) ?? { destination, calls: 0, costUsd: 0 };
    group.calls += 1;
    group.costUsd += Number(item.costUsd ?? 0);
    groups.set(destination, group);
  }
  return [...groups.values()].sort((a, b) => a.destination.localeCompare(b.destination));
}
