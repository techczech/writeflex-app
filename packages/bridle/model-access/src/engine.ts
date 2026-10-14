import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { route } from "./routing.ts";
import type { AdapterRegistry, TaskRegistry } from "./registry.ts";
import type { EgressClass, ManifestGrants, ModelAccessError, ModelAccessResult, RoutingConfig, RunContext, TransportClass } from "./types.ts";

const MEDIA_RETENTION_CAP_BYTES = 100 * 1024 * 1024;

export interface LedgerMediaReference {
  path: string;
  sha256: string;
  bytes: number;
  blobHash?: string;
  notRetained?: true;
}

export interface LedgerEntry {
  ts: number;
  task: string;
  adapterId?: string;
  transport?: TransportClass;
  egress?: EgressClass;
  model?: string;
  durationMs: number;
  usage?: unknown;
  costUsd?: number;
  input: unknown;
  output?: unknown;
  error?: string;
}

export interface LedgerRecorder {
  appendLedger(entry: LedgerEntry): void;
  putBlob(bytes: Uint8Array, preview: string): { hash: string; bytes: number };
}

export interface ModelAccess {
  run(taskId: string, input: unknown, ctx?: RunContext): Promise<ModelAccessResult>;
}

export interface ModelAccessOptions {
  tasks: TaskRegistry;
  adapters: AdapterRegistry;
  config?: RoutingConfig;
  grants?: ManifestGrants;
  recorder?: LedgerRecorder;
}

const NO_GRANTS: ManifestGrants = { granted: [] };

export function createModelAccess(opts: ModelAccessOptions): ModelAccess {
  const config = opts.config ?? {};
  const grants = opts.grants ?? NO_GRANTS;

  return {
    async run(taskId, input, ctx = {}) {
      const startedAt = Date.now();
      const recordedInput = opts.recorder ? await prepareLedgerPayload(input, opts.recorder) : input;
      const append = (entry: Omit<LedgerEntry, "ts" | "task" | "durationMs" | "input">) => {
        opts.recorder?.appendLedger({ ts: Date.now(), task: taskId, durationMs: Date.now() - startedAt, input: recordedInput, ...entry });
      };
      if (!opts.tasks.has(taskId)) {
        const result = fail(taskId, "unknown-task", `No such task: ${taskId}.`, "Define the task on the registry before running it.");
        append({ error: result.error.detail });
        return result;
      }
      if (!opts.tasks.checkInput(taskId, input)) {
        const result = fail(taskId, "input-invalid", `Input does not match the schema for task ${taskId}.`, "Correct the input to match the task's declared input schema.");
        append({ error: result.error.detail });
        return result;
      }

      const outcome = await route(taskId, opts.adapters, config, grants);
      if (!outcome.adapter) {
        if (outcome.reason === "egress-denied") {
          const result = fail(taskId, "egress-denied", `Every adapter for ${taskId} needs an egress grant the Manifest does not give.`, "Grant a provider for this task in the Manifest, or add a local adapter (egress none/loopback).");
          append({ error: result.error.detail });
          return result;
        }
        if (outcome.reason === "unavailable") {
          const result = fail(taskId, "no-adapter", `No adapter for ${taskId} is currently available.`, "Start the local server/model, or add a reachable adapter.");
          append({ error: result.error.detail });
          return result;
        }
        const result = fail(taskId, "no-adapter", `No adapter serves task ${taskId}.`, "Register an adapter whose tasks include this task.");
        append({ error: result.error.detail });
        return result;
      }

      const adapter = outcome.adapter;
      let output: unknown;
      try {
        output = await adapter.execute(taskId, input, ctx);
      } catch (error) {
        const result = fail(taskId, "adapter-error", `Adapter ${adapter.id} failed: ${errorMessage(error)}.`, "Check the provider, or route the task to another adapter.");
        append({ adapterId: adapter.id, transport: adapter.transport, egress: adapter.egress, error: result.error.detail });
        return result;
      }

      if (!opts.tasks.checkOutput(taskId, output)) {
        const result = fail(taskId, "output-invalid", `Adapter ${adapter.id} returned output that does not match the schema for task ${taskId}.`, "Fix the adapter to return the task's declared output shape.");
        append({
          adapterId: adapter.id, transport: adapter.transport, egress: adapter.egress,
          output: opts.recorder ? await prepareLedgerPayload(output, opts.recorder) : output,
          error: result.error.detail,
        });
        return result;
      }

      append({
        adapterId: adapter.id, transport: adapter.transport, egress: adapter.egress,
        output: opts.recorder ? await prepareLedgerPayload(output, opts.recorder) : output,
      });
      return { ok: true, taskId, adapterId: adapter.id, egress: adapter.egress, output };
    },
  };
}

async function prepareLedgerPayload(value: unknown, recorder: LedgerRecorder): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => prepareLedgerPayload(item, recorder)));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.path === "string") {
    try {
      const info = await stat(record.path);
      if (info.isFile()) return recordMedia(record.path, info.size, recorder);
    } catch {
      // A non-file path remains ordinary structured text.
    }
  }
  return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, item]) => [key, await prepareLedgerPayload(item, recorder)])));
}

async function recordMedia(path: string, bytes: number, recorder: LedgerRecorder): Promise<LedgerMediaReference> {
  if (bytes <= MEDIA_RETENTION_CAP_BYTES) {
    const content = new Uint8Array(await readFile(path));
    const sha256 = createHash("sha256").update(content).digest("hex");
    const blob = recorder.putBlob(content, `media/${basename(path)}`);
    return { path, sha256, bytes, blobHash: blob.hash };
  }
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return { path, sha256: hash.digest("hex"), bytes, notRetained: true };
}

function fail(taskId: string, kind: ModelAccessError["kind"], detail: string, remedy?: string): Extract<ModelAccessResult, { ok: false }> {
  return { ok: false, taskId, error: { kind, detail, remedy } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
