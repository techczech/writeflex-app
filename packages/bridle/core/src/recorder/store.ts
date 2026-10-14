import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RECORDER_VERSION = 1;
export const RECORDER_INLINE_LIMIT_BYTES = 16 * 1024;

export type RecordingMode = "full" | { retainDays: number };
export type BlobRef = { $blob: string; bytes: number; preview: string };

type RecorderManifest = {
  recorderVersion: number;
  appId?: string;
  mode: RecordingMode;
  createdAt: string;
};

export class RecorderIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecorderIntegrityError";
  }
}

export type RecorderStoreOptions = {
  appId?: string;
  onWarning?: (warning: string) => void;
  /** Test-only write observation; never persisted. */
  onWrite?: (path: string) => void;
  /** Test-only journal append injection. */
  appendFile?: (path: string, content: string) => Promise<void>;
};

function sameMode(a: RecordingMode, b: RecordingMode): boolean {
  return a === "full" && b === "full"
    || typeof a === "object" && typeof b === "object" && a.retainDays === b.retainDays;
}

function isBlobRef(value: unknown): value is BlobRef {
  return !!value && typeof value === "object"
    && typeof (value as { $blob?: unknown }).$blob === "string"
    && typeof (value as { bytes?: unknown }).bytes === "number"
    && typeof (value as { preview?: unknown }).preview === "string";
}

function blobRefs(value: unknown): BlobRef[] {
  if (isBlobRef(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(blobRefs);
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(blobRefs);
}

export class RecorderStore {
  readonly recorderDir: string;
  readonly blobsDir: string;
  readonly auditDir: string;
  readonly ledgerPath: string;
  readonly proposalsEventsPath: string;
  readonly manifestPath: string;
  private pending = new Map<string, string[]>();
  private queuedSnapshots: Array<Map<string, string[]>> = [];
  private flushChain: Promise<void> = Promise.resolve();

  private constructor(
    readonly appDataDir: string,
    readonly mode: RecordingMode,
    private readonly opts: RecorderStoreOptions,
  ) {
    this.recorderDir = join(appDataDir, "recorder");
    this.blobsDir = join(this.recorderDir, "blobs");
    this.auditDir = join(this.recorderDir, "audit");
    this.ledgerPath = join(this.recorderDir, "model-access.jsonl");
    this.proposalsEventsPath = join(this.recorderDir, "proposals-events.jsonl");
    this.manifestPath = join(this.recorderDir, "MANIFEST.json");
  }

  static async open(appDataDir: string, mode: RecordingMode, opts: RecorderStoreOptions = {}): Promise<RecorderStore> {
    if (typeof mode === "object" && (!Number.isInteger(mode.retainDays) || mode.retainDays <= 0)) {
      throw new Error("recording.retainDays must be a positive integer");
    }
    const store = new RecorderStore(appDataDir, mode, opts);
    await mkdir(store.auditDir, { recursive: true });
    await mkdir(store.blobsDir, { recursive: true });
    if (existsSync(store.manifestPath)) {
      const manifest = JSON.parse(await readFile(store.manifestPath, "utf8")) as RecorderManifest;
      if (manifest.recorderVersion !== RECORDER_VERSION) {
        throw new Error(`Unsupported recorder version: ${manifest.recorderVersion}`);
      }
      if (!sameMode(manifest.mode, mode)) {
        throw new Error(`Recording mode mismatch: existing ${JSON.stringify(manifest.mode)}, requested ${JSON.stringify(mode)}`);
      }
      if (opts.appId && manifest.appId && opts.appId !== manifest.appId) {
        throw new Error(`Recorder appId mismatch: existing ${manifest.appId}, requested ${opts.appId}`);
      }
    } else {
      const manifest: RecorderManifest = {
        recorderVersion: RECORDER_VERSION,
        ...(opts.appId ? { appId: opts.appId } : {}),
        mode,
        createdAt: new Date().toISOString(),
      };
      await store.writeNow(store.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
    if (typeof mode === "object") await store.expireRetainedSessions(mode.retainDays);
    return store;
  }

  putBlob(value: string | Uint8Array, _preview: string): { hash: string; bytes: number } {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const path = join(this.blobsDir, hash);
    if (!existsSync(path)) {
      try {
        writeFileSync(path, bytes, { flag: "wx" });
        this.opts.onWrite?.(path);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      }
    }
    return { hash, bytes: bytes.byteLength };
  }

  async appendAudit(sessionId: string, entry: Record<string, unknown>): Promise<void> {
    this.append(join(this.auditDir, `${sessionId}.jsonl`), entry);
  }

  appendLedger(entry: Record<string, unknown>): void {
    this.append(this.ledgerPath, entry);
  }

  appendProposalEvent(entry: Record<string, unknown>): void {
    this.append(this.proposalsEventsPath, entry);
  }

  async flush(): Promise<void> {
    const snapshot = this.pending;
    this.pending = new Map<string, string[]>();
    this.queuedSnapshots.push(snapshot);
    const writeSnapshot = async (): Promise<void> => {
      if (this.queuedSnapshots[0] !== snapshot) throw new Error("Recorder flush queue order violated");
      this.queuedSnapshots.shift();
      const settlements = await Promise.allSettled([...snapshot].map(async ([path, lines]) => {
        if (!lines.length) return;
        try {
          await this.appendNow(path, lines.join(""));
        } catch (error) {
          const reinstateInto = this.queuedSnapshots[0] ?? this.pending;
          const newer = reinstateInto.get(path) ?? [];
          reinstateInto.set(path, [...lines, ...newer]);
          throw error;
        }
      }));
      const rejection = settlements.find((settlement): settlement is PromiseRejectedResult => settlement.status === "rejected");
      if (rejection) {
        throw rejection.reason;
      }
    };
    const flush = this.flushChain.then(writeSnapshot, writeSnapshot);
    this.flushChain = flush.catch(() => undefined);
    return flush;
  }

  async readJsonl(path: string): Promise<unknown[]> {
    if (!existsSync(path)) return [];
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n");
    const entries: unknown[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch (error) {
        const finalNonEmptyLine = lines.slice(index + 1).every((candidate) => candidate === "");
        if (!finalNonEmptyLine) throw error;
        this.opts.onWarning?.(`Skipped torn final JSONL line in ${path}`);
        break;
      }
    }
    for (const ref of entries.flatMap(blobRefs)) {
      const path = join(this.blobsDir, ref.$blob);
      try {
        const blob = await stat(path);
        if (blob.size !== ref.bytes) {
          throw new RecorderIntegrityError(`Blob size mismatch for ${ref.$blob}: journal ${ref.bytes}, file ${blob.size}`);
        }
      } catch (error) {
        if (error instanceof RecorderIntegrityError) throw error;
        throw new RecorderIntegrityError(`Missing recorder blob ${ref.$blob} referenced by ${path}`);
      }
    }
    return entries;
  }

  private append(path: string, entry: Record<string, unknown>): void {
    const prepared = this.externalise(entry);
    const lines = this.pending.get(path) ?? [];
    lines.push(`${JSON.stringify(prepared)}\n`);
    this.pending.set(path, lines);
  }

  private externalise(value: unknown): unknown {
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") <= RECORDER_INLINE_LIMIT_BYTES) return value;
      const blob = this.putBlob(value, value.slice(0, 200));
      return { $blob: blob.hash, bytes: blob.bytes, preview: value.slice(0, 200) } satisfies BlobRef;
    }
    if (value instanceof Uint8Array) {
      if (value.byteLength <= RECORDER_INLINE_LIMIT_BYTES) return Array.from(value);
      const preview = `binary ${value.byteLength} bytes`;
      const blob = this.putBlob(value, preview);
      return { $blob: blob.hash, bytes: blob.bytes, preview } satisfies BlobRef;
    }
    if (Array.isArray(value)) return value.map((item) => this.externalise(item));
    if (!value || typeof value !== "object") return value;
    if (isBlobRef(value)) return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, this.externalise(item)]));
  }

  private async writeNow(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    this.opts.onWrite?.(path);
  }

  private async appendNow(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (this.opts.appendFile) await this.opts.appendFile(path, content);
    else await appendFile(path, content, "utf8");
    this.opts.onWrite?.(path);
  }

  private async expireRetainedSessions(retainDays: number): Promise<void> {
    const sessionsDir = join(this.appDataDir, "sessions");
    if (!existsSync(sessionsDir)) return;
    const expiredBefore = new Date(Date.now() - retainDays * 86_400_000);
    const files = await readdir(sessionsDir, { withFileTypes: true });
    const expired: Array<{ sessionId: string; sessionPath: string; auditPath: string }> = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const sessionPath = join(sessionsDir, file.name);
      const firstLine = (await readFile(sessionPath, "utf8")).split("\n", 1)[0];
      if (!firstLine) continue;
      let header: { id?: unknown; timestamp?: unknown };
      try {
        header = JSON.parse(firstLine) as { id?: unknown; timestamp?: unknown };
      } catch {
        continue;
      }
      const timestamp = typeof header.timestamp === "string" ? new Date(header.timestamp) : undefined;
      if (!timestamp || Number.isNaN(timestamp.valueOf()) || timestamp >= expiredBefore) continue;
      const sessionId = typeof header.id === "string" ? header.id : file.name.slice(0, -".jsonl".length);
      expired.push({ sessionId, sessionPath, auditPath: join(this.auditDir, `${sessionId}.jsonl`) });
    }
    if (!expired.length) return;

    for (const session of expired) {
      await rm(session.sessionPath, { force: true });
      await rm(session.auditPath, { force: true });
    }

    const referenced = new Set<string>();
    if (existsSync(this.auditDir)) {
      for (const file of await readdir(this.auditDir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        for (const entry of await this.readJsonl(join(this.auditDir, file.name))) {
          for (const ref of blobRefs(entry)) referenced.add(ref.$blob);
        }
      }
    }
    for (const entry of await this.readJsonl(this.ledgerPath)) {
      for (const ref of blobRefs(entry)) referenced.add(ref.$blob);
    }
    for (const path of [
      this.proposalsEventsPath,
      join(this.appDataDir, "proposals", "proposals.jsonl"),
    ]) {
      for (const entry of await this.readJsonl(path)) {
        for (const ref of blobRefs(entry)) referenced.add(ref.$blob);
      }
    }
    for (const file of await readdir(this.blobsDir, { withFileTypes: true })) {
      if (file.isFile() && !referenced.has(file.name)) await rm(join(this.blobsDir, file.name), { force: true });
    }

    await this.appendNow(join(this.recorderDir, "tombstones.jsonl"), `${JSON.stringify({
      expiredBefore: expiredBefore.toISOString(), sessionIds: expired.map((session) => session.sessionId), at: new Date().toISOString(),
    })}\n`);
  }
}
