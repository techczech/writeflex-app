import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CapabilityResult } from "../types.ts";
import { fingerprintRequest } from "./canonical.ts";
import type {
  ExecutionAttempt,
  ExecutionDisposition,
  ExecutionFilter,
  ExecutionJournal,
  ExecutionJournalFaults,
  ExecutionOutcome,
  ExecutionRecordType,
  ExecutionRequest,
  OpenExecutionJournalOptions,
  UnknownExecution,
} from "./types.ts";
import { unknownExecutionResult } from "./types.ts";
import { completeExecutionJournalJsonl } from "./torn-tail.ts";

const JOURNAL_VERSION = 1 as const;
const INLINE_RESULT_LIMIT = 16 * 1024;
const EXECUTION_DIR = "executions";
const JOURNAL_FILE = "execution-journal.jsonl";

type Header = {
  journalVersion: 1;
  type: "header";
  appId: string;
  installationId: string;
  createdAt: string;
  migration: "new" | "existing-install-no-backfill";
};

type BlobRef = { $blob: string; bytes: number };
type StoredResult = CapabilityResult | BlobRef;

type RegisteredRecord = {
  journalVersion: 1;
  type: "registered";
  attemptId: string;
  at: string;
  appId: string;
  lane: ExecutionRequest["lane"];
  originKey: string;
  requestFingerprint: string;
  capability: string;
  risk: ExecutionRequest["risk"];
  egress: ExecutionRequest["egress"];
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  proposalId?: string;
  groupId?: string;
  idempotencyKey: string;
  remoteTransactionId?: string;
};

type IntentRecord = {
  journalVersion: 1;
  type: "intent";
  attemptId: string;
  at: string;
  policy: "allow";
  checkpointId?: string;
};

type OutcomeRecord = {
  journalVersion: 1;
  type: "outcome";
  attemptId: string;
  at: string;
  disposition: ExecutionOutcome["disposition"];
  result: StoredResult;
  remoteOutcome?: ExecutionOutcome["remoteOutcome"];
  classification?: ExecutionOutcome["classification"];
};

type ConflictRecord = {
  journalVersion: 1;
  type: "identity-conflict";
  attemptId: string;
  at: string;
  observedFingerprint: string;
  sessionId: string;
  toolCallId?: string;
  proposalId?: string;
};

type RecordLine = Header | RegisteredRecord | IntentRecord | OutcomeRecord | ConflictRecord;

type FoldedAttempt = {
  registered: RegisteredRecord;
  intent?: IntentRecord;
  outcome?: OutcomeRecord;
  hydratedResult?: CapabilityResult;
};

type Deferred = {
  promise: Promise<ExecutionDisposition>;
  resolve: (value: ExecutionDisposition) => void;
  reject: (reason: unknown) => void;
};
type LiveOwner = { waiters: Deferred[] };

type SharedEntry = { journal: FileExecutionJournal; references: number };
const shared = new Map<string, Promise<SharedEntry>>();

function deferred(): Deferred {
  let resolve!: Deferred["resolve"];
  let reject!: Deferred["reject"];
  const promise = new Promise<ExecutionDisposition>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function isBlobRef(value: StoredResult): value is BlobRef {
  return !!value && typeof value === "object" && "$blob" in value;
}

function unknownResult(attempt: FoldedAttempt): CapabilityResult {
  return unknownExecutionResult(attempt.registered.capability, attempt.registered.attemptId);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function uuidToBytes(uuid: string): Buffer {
  const compact = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(compact)) throw new Error(`Invalid execution-journal installation UUID: ${uuid}`);
  return Buffer.from(compact, "hex");
}

function uuidV5(namespace: string, name: string): string {
  const bytes = createHash("sha1").update(uuidToBytes(namespace)).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hasLegacyState(appDataDir: string, workspaceRoot?: string): boolean {
  return ["sessions", "recorder", "proposals", "snapshots", "versioning", "auth.json", "model-catalog.json"]
    .some((name) => existsSync(join(appDataDir, name)))
    || Boolean(workspaceRoot && existsSync(join(workspaceRoot, ".bridle")));
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function validateHeader(value: unknown, appId: string): Header {
  if (!value || typeof value !== "object") throw new Error("Execution journal header is malformed.");
  const header = value as Partial<Header>;
  if (header.type !== "header" || header.journalVersion !== JOURNAL_VERSION
    || typeof header.appId !== "string" || typeof header.installationId !== "string"
    || typeof header.createdAt !== "string"
    || (header.migration !== "new" && header.migration !== "existing-install-no-backfill")) {
    throw new Error("Execution journal header is malformed.");
  }
  uuidToBytes(header.installationId);
  if (header.appId !== appId) throw new Error(`Execution journal appId mismatch: expected ${appId}, found ${header.appId}.`);
  return header as Header;
}

function requireString(record: Record<string, unknown>, key: string): string {
  if (typeof record[key] !== "string" || record[key] === "") throw new Error(`Execution journal record has invalid ${key}.`);
  return record[key] as string;
}

function parseRecord(value: unknown): RecordLine {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Execution journal record is malformed.");
  const record = value as Record<string, unknown>;
  if (record.journalVersion !== JOURNAL_VERSION) throw new Error("Execution journal record has an unsupported version.");
  if (record.type === "header") return record as Header;
  requireString(record, "attemptId");
  requireString(record, "at");
  if (record.type === "registered") {
    for (const key of ["appId", "originKey", "requestFingerprint", "capability", "sessionId", "idempotencyKey"]) requireString(record, key);
    if (!(["live", "mock"] as unknown[]).includes(record.lane)
      || !(["read", "write", "sync", "destructive"] as unknown[]).includes(record.risk)
      || !(["none", "loopback", "remote"] as unknown[]).includes(record.egress)) throw new Error("Execution registered record is malformed.");
    return record as RegisteredRecord;
  }
  if (record.type === "intent") {
    if (record.policy !== "allow") throw new Error("Execution intent record is malformed.");
    return record as IntentRecord;
  }
  if (record.type === "outcome") {
    if (!(["returned", "threw", "refused", "staged", "stale", "precondition-failed", "unknown"] as unknown[]).includes(record.disposition)
      || !record.result || typeof record.result !== "object") throw new Error("Execution outcome record is malformed.");
    if (record.classification !== undefined) {
      const classification = record.classification as Record<string, unknown>;
      if (!classification || typeof classification !== "object"
        || !(classification.relay === "ok" || classification.relay === "error"
          || classification.relay === "denied" || classification.relay === "staged")
        || typeof classification.denied !== "boolean"
        || (classification.aborted !== undefined && typeof classification.aborted !== "boolean")
        || (classification.stale !== undefined && typeof classification.stale !== "boolean")) {
        throw new Error("Execution outcome classification is malformed.");
      }
    }
    return record as OutcomeRecord;
  }
  if (record.type === "identity-conflict") {
    requireString(record, "observedFingerprint");
    requireString(record, "sessionId");
    return record as ConflictRecord;
  }
  throw new Error(`Unknown execution journal record type: ${String(record.type)}`);
}

class FileExecutionJournal implements ExecutionJournal {
  readonly #appId: string;
  readonly #blobDir: string;
  readonly #path: string;
  readonly #header: Header;
  readonly #faults?: ExecutionJournalFaults;
  readonly #attempts = new Map<string, FoldedAttempt>();
  readonly #byOrigin = new Map<string, string>();
  readonly #liveOwners = new Map<string, LiveOwner>();
  #handle: Awaited<ReturnType<typeof open>>;
  #serial: Promise<void> = Promise.resolve();
  #closed = false;
  #release?: () => Promise<void>;

  private constructor(opts: OpenExecutionJournalOptions, header: Header, handle: Awaited<ReturnType<typeof open>>) {
    this.#appId = opts.appId;
    this.#blobDir = join(opts.appDataDir, EXECUTION_DIR, "blobs");
    this.#path = join(opts.appDataDir, EXECUTION_DIR, JOURNAL_FILE);
    this.#header = header;
    this.#handle = handle;
    this.#faults = opts.faults;
  }

  static async create(opts: OpenExecutionJournalOptions): Promise<FileExecutionJournal> {
    const dir = join(opts.appDataDir, EXECUTION_DIR);
    const blobDir = join(dir, "blobs");
    const path = join(dir, JOURNAL_FILE);
    const dirExisted = existsSync(dir);
    const existed = existsSync(path);
    if (dirExisted && !existed) {
      throw new Error("Execution journal is missing from an existing execution-safety directory.");
    }
    if (!dirExisted) {
      await mkdir(dir, { recursive: true });
      await syncDirectory(dirname(dir));
    }
    if (!existsSync(blobDir)) {
      await mkdir(blobDir);
      await syncDirectory(dir);
    }
    if (!existed) {
      const header: Header = {
        journalVersion: JOURNAL_VERSION,
        type: "header",
        appId: opts.appId,
        installationId: randomUUID(),
        createdAt: new Date().toISOString(),
        migration: hasLegacyState(opts.appDataDir, opts.workspaceRoot) ? "existing-install-no-backfill" : "new",
      };
      await opts.faults?.beforeAppend?.("header");
      await writeFile(path, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
      await opts.faults?.afterAppend?.("header");
      const created = await open(path, "r+");
      try {
        await opts.faults?.beforeSync?.("header");
        await created.sync();
        await opts.faults?.afterSync?.("header");
      } finally { await created.close(); }
      await syncDirectory(dir);
    }

    const complete = completeExecutionJournalJsonl(await readFile(path));
    if (complete.repaired) {
      await truncate(path, complete.bytes.length);
      const repaired = await open(path, "r+");
      try { await repaired.sync(); } finally { await repaired.close(); }
    }
    const lines = complete.bytes.toString("utf8").trimEnd().split("\n");
    let headerValue: unknown;
    try { headerValue = JSON.parse(lines[0]!); } catch { throw new Error("Execution journal header is malformed."); }
    const header = validateHeader(headerValue, opts.appId);
    const handle = await open(path, "a+");
    const journal = new FileExecutionJournal(opts, header, handle);
    await journal.#fold(lines.slice(1));
    return journal;
  }

  setRelease(release: () => Promise<void>): void { this.#release = release; }
  assertAppId(appId: string): void {
    if (appId !== this.#appId) throw new Error(`Execution journal appId mismatch: expected ${appId}, found ${this.#appId}.`);
  }

  async refresh(): Promise<void> {
    await this.#exclusive(async () => {
      if (this.#liveOwners.size > 0) return;
      const complete = completeExecutionJournalJsonl(await readFile(this.#path));
      if (complete.repaired) {
        await truncate(this.#path, complete.bytes.length);
        await this.#handle.close();
        this.#handle = await open(this.#path, "a+");
      }
      const lines = complete.bytes.toString("utf8").trimEnd().split("\n");
      validateHeader(JSON.parse(lines[0]!), this.#appId);
      this.#attempts.clear();
      this.#byOrigin.clear();
      await this.#fold(lines.slice(1));
    });
  }

  async #fold(lines: string[]): Promise<void> {
    for (const line of lines) {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { throw new Error("Execution journal contains a malformed complete record."); }
      const record = parseRecord(parsed);
      if (record.type === "header") throw new Error("Execution journal contains a duplicate header.");
      if (record.type === "registered") {
        if (this.#attempts.has(record.attemptId) || this.#byOrigin.has(record.originKey)) throw new Error("Execution journal contains a duplicate registration.");
        if (record.appId !== this.#appId || record.idempotencyKey !== record.attemptId) throw new Error("Execution journal registration identity is inconsistent.");
        this.#attempts.set(record.attemptId, { registered: record });
        this.#byOrigin.set(record.originKey, record.attemptId);
      } else if (record.type === "intent") {
        const attempt = this.#attempts.get(record.attemptId);
        if (!attempt || attempt.intent || attempt.outcome) throw new Error("Execution journal contains an impossible intent transition.");
        attempt.intent = record;
      } else if (record.type === "outcome") {
        const attempt = this.#attempts.get(record.attemptId);
        if (!attempt || attempt.outcome) throw new Error("Execution journal contains an impossible outcome transition.");
        if (["returned", "threw", "unknown"].includes(record.disposition) && !attempt.intent) {
          throw new Error("Execution journal contains an outcome that requires a prior intent.");
        }
        attempt.hydratedResult = await this.#hydrate(record.result);
        attempt.outcome = record;
      } else if (!this.#attempts.has(record.attemptId)) {
        throw new Error("Execution journal identity conflict references an unknown attempt.");
      }
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#serial;
    let release!: () => void;
    this.#serial = new Promise<void>((resolveSerial) => { release = resolveSerial; });
    await prior;
    try {
      if (this.#closed) throw new Error("Execution journal is closed.");
      return await operation();
    } finally { release(); }
  }

  async #append(record: Exclude<RecordLine, Header>): Promise<void> {
    const type = record.type as ExecutionRecordType;
    await this.#faults?.beforeAppend?.(type);
    await this.#handle.write(`${JSON.stringify(record)}\n`);
    await this.#faults?.afterAppend?.(type);
    await this.#faults?.beforeSync?.(type);
    await this.#handle.sync();
    await this.#faults?.afterSync?.(type);
  }

  #publicAttempt(attempt: FoldedAttempt): ExecutionAttempt {
    return Object.freeze({
      attemptId: attempt.registered.attemptId,
      appId: attempt.registered.appId,
      lane: attempt.registered.lane,
      originKey: attempt.registered.originKey,
      requestFingerprint: attempt.registered.requestFingerprint,
      capability: attempt.registered.capability,
      risk: attempt.registered.risk,
      egress: attempt.registered.egress,
      sessionId: attempt.registered.sessionId,
      ...(attempt.registered.turnId ? { turnId: attempt.registered.turnId } : {}),
      ...(attempt.registered.toolCallId ? { toolCallId: attempt.registered.toolCallId } : {}),
      ...(attempt.registered.proposalId ? { proposalId: attempt.registered.proposalId } : {}),
      ...(attempt.registered.groupId ? { groupId: attempt.registered.groupId } : {}),
      idempotencyKey: attempt.registered.idempotencyKey,
      ...(attempt.registered.remoteTransactionId ? { remoteTransactionId: attempt.registered.remoteTransactionId } : {}),
      registeredAt: attempt.registered.at,
      ...(attempt.intent ? { intent: { policy: attempt.intent.policy, at: attempt.intent.at, ...(attempt.intent.checkpointId ? { checkpointId: attempt.intent.checkpointId } : {}) } } : {}),
      ...(attempt.outcome ? { outcome: { disposition: attempt.outcome.disposition, result: clone(attempt.hydratedResult!), at: attempt.outcome.at, ...(attempt.outcome.remoteOutcome ? { remoteOutcome: clone(attempt.outcome.remoteOutcome) } : {}), ...(attempt.outcome.classification ? { classification: clone(attempt.outcome.classification) } : {}) } } : {}),
    });
  }

  async #hydrate(stored: StoredResult): Promise<CapabilityResult> {
    if (!isBlobRef(stored)) return clone(stored);
    if (!/^[a-f0-9]{64}$/.test(stored.$blob) || !Number.isInteger(stored.bytes) || stored.bytes < 0) throw new Error("Execution journal contains an invalid result blob reference.");
    const path = join(this.#blobDir, stored.$blob);
    let bytes: Buffer;
    try { bytes = await readFile(path); } catch { throw new Error(`Execution journal result blob is missing: ${stored.$blob}`); }
    if (bytes.length !== stored.bytes || createHash("sha256").update(bytes).digest("hex") !== stored.$blob) throw new Error(`Execution journal result blob failed integrity validation: ${stored.$blob}`);
    try { return JSON.parse(bytes.toString("utf8")) as CapabilityResult; } catch { throw new Error(`Execution journal result blob is malformed: ${stored.$blob}`); }
  }

  async #storeResult(result: CapabilityResult): Promise<StoredResult> {
    const bytes = Buffer.from(JSON.stringify(result), "utf8");
    if (bytes.length <= INLINE_RESULT_LIMIT) return clone(result);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const path = join(this.#blobDir, hash);
    if (!existsSync(path)) {
      const temporary = join(this.#blobDir, `.${hash}.${randomUUID()}.tmp`);
      await writeFile(temporary, bytes, { flag: "wx" });
      const handle = await open(temporary, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      const final = await open(path, "r+");
      try { await final.sync(); } finally { await final.close(); }
      await syncDirectory(this.#blobDir);
    }
    return { $blob: hash, bytes: bytes.length };
  }

  async register(request: ExecutionRequest): Promise<ExecutionDisposition> {
    const fingerprint = fingerprintRequest(request.capability, request.input);
    const attemptId = uuidV5(this.#header.installationId, request.originKey);
    const claim = await this.#exclusive(async (): Promise<ExecutionDisposition | Deferred> => {
      const existingId = this.#byOrigin.get(request.originKey);
      const existing = existingId ? this.#attempts.get(existingId) : undefined;
      if (existing) {
        if (existing.registered.requestFingerprint !== fingerprint) {
          const conflict: ConflictRecord = {
            journalVersion: JOURNAL_VERSION,
            type: "identity-conflict",
            attemptId: existing.registered.attemptId,
            at: new Date().toISOString(),
            observedFingerprint: fingerprint,
            sessionId: request.sessionId,
            ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
            ...(request.proposalId ? { proposalId: request.proposalId } : {}),
          };
          await this.#append(conflict);
          return {
            state: "identity-conflict",
            attemptId: existing.registered.attemptId,
            result: { text: `Execution identity conflict for ${request.capability}; Bridle will not run the call.`, isError: true },
          };
        }
        const owner = this.#liveOwners.get(attemptId);
        if (owner) {
          // Live ownership outranks the folded intent state: a duplicate waits
          // for the real terminal result instead of receiving a false crash unknown.
          const waiter = deferred();
          owner.waiters.push(waiter);
          return waiter;
        }
        if (existing.outcome) {
          const result = await this.#hydrate(existing.outcome.result);
          return existing.outcome.disposition === "unknown"
            ? { state: "unknown", attempt: this.#publicAttempt(existing), result }
            : { state: "replay", attempt: this.#publicAttempt(existing), result };
        }
        if (existing.intent) return { state: "unknown", attempt: this.#publicAttempt(existing), result: unknownResult(existing) };
        this.#liveOwners.set(attemptId, { waiters: [] });
        return { state: "registered", attempt: this.#publicAttempt(existing) };
      }

      const attemptCollision = this.#attempts.get(attemptId);
      if (attemptCollision) {
        const conflict: ConflictRecord = {
          journalVersion: JOURNAL_VERSION,
          type: "identity-conflict",
          attemptId,
          at: new Date().toISOString(),
          observedFingerprint: fingerprint,
          sessionId: request.sessionId,
          ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
          ...(request.proposalId ? { proposalId: request.proposalId } : {}),
        };
        await this.#append(conflict);
        return {
          state: "identity-conflict",
          attemptId,
          result: { text: `Execution identity conflict for ${request.capability}; Bridle will not run the call.`, isError: true },
        };
      }

      const at = new Date().toISOString();
      const registered: RegisteredRecord = {
        journalVersion: JOURNAL_VERSION,
        type: "registered",
        attemptId,
        at,
        appId: this.#appId,
        lane: request.lane,
        originKey: request.originKey,
        requestFingerprint: fingerprint,
        capability: request.capability,
        risk: request.risk,
        egress: request.egress,
        sessionId: request.sessionId,
        ...(request.turnId ? { turnId: request.turnId } : {}),
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        ...(request.proposalId ? { proposalId: request.proposalId } : {}),
        ...(request.groupId ? { groupId: request.groupId } : {}),
        idempotencyKey: attemptId,
        ...(request.remoteTransactionId ? { remoteTransactionId: request.remoteTransactionId } : {}),
      };
      await this.#append(registered);
      const folded = { registered };
      this.#attempts.set(attemptId, folded);
      this.#byOrigin.set(request.originKey, attemptId);
      this.#liveOwners.set(attemptId, { waiters: [] });
      return { state: "new", attempt: this.#publicAttempt(folded) };
    });
    return "promise" in claim ? claim.promise : claim;
  }

  async recordIntent(attemptId: string, facts: { policy: "allow"; checkpointId?: string }): Promise<void> {
    try {
      await this.#exclusive(async () => {
        const attempt = this.#attempts.get(attemptId);
        if (!attempt || attempt.intent || attempt.outcome) throw new Error(`Cannot record execution intent for attempt ${attemptId}.`);
        const intent: IntentRecord = {
          journalVersion: JOURNAL_VERSION,
          type: "intent",
          attemptId,
          at: new Date().toISOString(),
          policy: facts.policy,
          ...(facts.checkpointId ? { checkpointId: facts.checkpointId } : {}),
        };
        await this.#append(intent);
        attempt.intent = intent;
      });
    } catch (error) {
      // Restores the live-ownership invariant: no register() waiter can outlive
      // its owner, including when durable intent cannot be recorded.
      this.#releaseOwnerWithError(attemptId, error);
      throw error;
    }
  }

  async recordOutcome(attemptId: string, outcome: ExecutionOutcome): Promise<void> {
    try {
      await this.#exclusive(async () => {
        const attempt = this.#attempts.get(attemptId);
        if (!attempt || attempt.outcome) throw new Error(`Cannot record execution outcome for attempt ${attemptId}.`);
        if (["returned", "threw", "unknown"].includes(outcome.disposition) && !attempt.intent) throw new Error(`Execution outcome ${outcome.disposition} requires durable intent.`);
        const stored = await this.#storeResult(outcome.result);
        const record: OutcomeRecord = {
          journalVersion: JOURNAL_VERSION,
          type: "outcome",
          attemptId,
          at: new Date().toISOString(),
          disposition: outcome.disposition,
          result: stored,
          ...(outcome.remoteOutcome ? { remoteOutcome: clone(outcome.remoteOutcome) } : {}),
          ...(outcome.classification ? { classification: clone(outcome.classification) } : {}),
        };
        await this.#append(record);
        attempt.outcome = record;
        const result = await this.#hydrate(stored);
        attempt.hydratedResult = result;
        const disposition: ExecutionDisposition = outcome.disposition === "unknown"
          ? { state: "unknown", attempt: this.#publicAttempt(attempt), result }
          : { state: "replay", attempt: this.#publicAttempt(attempt), result };
        for (const waiter of this.#liveOwners.get(attemptId)?.waiters ?? []) waiter.resolve(disposition);
        this.#liveOwners.delete(attemptId);
      });
    } catch (error) {
      // A failed terminal append ends this owner even though durable state could
      // not advance. Waiters receive the same determinate storage error.
      this.#releaseOwnerWithError(attemptId, error);
      throw error;
    }
  }

  #releaseOwnerWithError(attemptId: string, error: unknown): void {
    const owner = this.#liveOwners.get(attemptId);
    if (!owner) return;
    this.#liveOwners.delete(attemptId);
    const attempt = this.#attempts.get(attemptId);
    if (attempt?.intent && !attempt.outcome) {
      const result = unknownResult(attempt);
      const disposition: ExecutionDisposition = {
        state: "unknown",
        attempt: this.#publicAttempt(attempt),
        result,
      };
      for (const waiter of owner.waiters) waiter.resolve(disposition);
      return;
    }
    for (const waiter of owner.waiters) waiter.reject(error);
  }

  async get(attemptId: string): Promise<ExecutionAttempt | undefined> {
    return this.#exclusive(async () => {
      const attempt = this.#attempts.get(attemptId);
      if (!attempt) return undefined;
      return this.#publicAttempt(attempt);
    });
  }

  async unknown(filter: ExecutionFilter = {}): Promise<readonly UnknownExecution[]> {
    return this.#exclusive(async () => {
      const output: UnknownExecution[] = [];
      for (const attempt of this.#attempts.values()) {
        const isUnknown = attempt.intent && (!attempt.outcome || attempt.outcome.disposition === "unknown");
        if (!isUnknown || filter.sessionId && filter.sessionId !== attempt.registered.sessionId
          || filter.turnId && filter.turnId !== attempt.registered.turnId
          || filter.toolCallId && filter.toolCallId !== attempt.registered.toolCallId
          || filter.proposalId && filter.proposalId !== attempt.registered.proposalId) continue;
        output.push(Object.freeze({
          attemptId: attempt.registered.attemptId,
          capability: attempt.registered.capability,
          sessionId: attempt.registered.sessionId,
          ...(attempt.registered.turnId ? { turnId: attempt.registered.turnId } : {}),
          ...(attempt.registered.toolCallId ? { toolCallId: attempt.registered.toolCallId } : {}),
          ...(attempt.registered.proposalId ? { proposalId: attempt.registered.proposalId } : {}),
          ...(attempt.registered.groupId ? { groupId: attempt.registered.groupId } : {}),
          firstIntentAt: attempt.intent!.at,
          idempotencyKey: attempt.registered.idempotencyKey,
          ...(attempt.registered.remoteTransactionId ? { remoteTransactionId: attempt.registered.remoteTransactionId } : {}),
          warning: attempt.outcome?.disposition === "unknown"
            ? attempt.hydratedResult!.text
            : unknownResult(attempt).text,
        }));
      }
      return Object.freeze(output);
    });
  }

  async close(): Promise<void> {
    if (this.#release) return this.#release();
  }

  async closeSharedHandle(): Promise<void> {
    await this.#serial;
    this.#closed = true;
    const error = new Error("Execution journal is closed.");
    for (const [attemptId] of this.#liveOwners) this.#releaseOwnerWithError(attemptId, error);
    await this.#handle.close();
  }
}

export async function openFileExecutionJournal(opts: OpenExecutionJournalOptions): Promise<ExecutionJournal> {
  const key = resolve(opts.appDataDir, EXECUTION_DIR, JOURNAL_FILE);
  let entryPromise = shared.get(key);
  if (!entryPromise) {
    entryPromise = FileExecutionJournal.create(opts).then((journal) => ({ journal, references: 0 }));
    shared.set(key, entryPromise);
    entryPromise.catch(() => shared.delete(key));
  }
  const entry = await entryPromise;
  entry.journal.assertAppId(opts.appId);
  await entry.journal.refresh();
  entry.references += 1;
  let released = false;
  const facade: ExecutionJournal = {
    register: (request) => entry.journal.register(request),
    recordIntent: (attemptId, facts) => entry.journal.recordIntent(attemptId, facts),
    recordOutcome: (attemptId, outcome) => entry.journal.recordOutcome(attemptId, outcome),
    get: (attemptId) => entry.journal.get(attemptId),
    unknown: (filter) => entry.journal.unknown(filter),
    async close() {
      if (released) return;
      released = true;
      entry.references -= 1;
      if (entry.references === 0) {
        shared.delete(key);
        await entry.journal.closeSharedHandle();
      }
    },
  };
  return facade;
}
