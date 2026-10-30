import { open } from "node:fs/promises";
import type { ActionOutcome, Proposal, ProposalSettler, ProposalSettlementReason, ProposalStatus } from "./types.ts";

export type ProposalEvent = { generation?: number; eventId?: string } & (
  | { type: "writer-claim"; generation: number; at: string }
  | { type: "created"; at: string; proposal: Omit<Proposal, "payload"> & { payload: unknown } }
  | { type: "adoption-start"; id: string; at: string }
  | { type: "recovery-ack"; at: string; offset: number; line: number; code: "torn-final-line" | "invalid-line" | "fenced-write" }
  | { type: "attempted"; id: string; at: string; outcome: ActionOutcome }
  | {
      type: "settled";
      id: string;
      at: string;
      status: Exclude<ProposalStatus, "proposed">;
      settledBy?: ProposalSettler;
      settlementReason?: ProposalSettlementReason;
      mayHaveApplied?: true;
      outcome?: ActionOutcome;
      restorePointId?: string;
    });


type RecordLine = { event: ProposalEvent; line: number; offset: number };
type DamagedLine = { raw: string; line: number; offset: number; invalidClaim?: true };
type ParsedLine = { kind: "valid" | "fenced"; record: RecordLine } | { kind: "damaged"; record: DamagedLine };
type Identity = { ino: number | bigint; dev: number | bigint };
const JOURNAL_BOUNDARY_BYTES = 64;

function safeGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** One parser owns generation validation, fencing and the last verified byte boundary. */
export class ProposalJournal {
  #identity?: Identity;
  #size = -1;
  #mtime?: bigint;
  #offset = 0;
  #boundary = Buffer.alloc(0);
  #line = 1;
  #last = 0;
  #generation = 0;
  #epoch = 0;
  #records: RecordLine[] = [];
  #skipped: DamagedLine[] = [];
  #fenced: RecordLine[] = [];
  #ids = new Set<string>();
  #acknowledged = new Set<number>();
  #reports: Array<RecordLine & { epoch: number }> = [];
  #partial?: ParsedLine;
  #queue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  read() {
    return this.#run(() => ({
      records: [...this.#records, ...(this.#partial?.kind === "valid" ? [this.#partial.record] : [])],
      skipped: [...this.#skipped, ...(this.#partial?.kind === "damaged" ? [this.#partial.record] : [])],
      fenced: [...this.#fenced, ...(this.#partial?.kind === "fenced" ? [this.#partial.record] : [])],
      last: this.#partial && (this.#partial.kind === "damaged" || this.#partial.record.event.type !== "writer-claim") ? this.#partial.record.line : this.#last,
      needsSeparator: this.#size > this.#offset,
    }));
  }

  contains(eventId: string): Promise<boolean> {
    return this.#run(() => this.#ids.has(eventId) || this.#partial?.kind === "valid" && this.#partial.record.event.eventId === eventId);
  }

  latestGeneration(): Promise<number> {
    return this.#run(() => this.#partial?.kind === "valid" && this.#partial.record.event.type === "writer-claim" ? this.#partial.record.event.generation : this.#generation);
  }

  drainFenced(): Array<RecordLine & { epoch: number }> {
    const reports = this.#reports;
    this.#reports = [];
    const partialAck = this.#partial?.kind === "valid" && this.#partial.record.event.type === "recovery-ack" ? this.#partial.record.event.offset : undefined;
    return reports.filter((record) => !this.#acknowledged.has(record.offset) && record.offset !== partialAck);
  }

  #run<T>(project: () => T): Promise<T> {
    // Queue callers instead of sharing an old in-flight snapshot: a confirmation
    // must observe writes submitted after an earlier reader started.
    const result = this.#queue.then(async () => { await this.#refresh(); return project(); });
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  #reset(identity?: Identity): void {
    this.#identity = identity;
    this.#size = -1;
    this.#mtime = undefined;
    this.#offset = 0;
    this.#boundary = Buffer.alloc(0);
    this.#line = 1;
    this.#last = 0;
    this.#generation = 0;
    this.#epoch++;
    this.#records = [];
    this.#skipped = [];
    this.#fenced = [];
    this.#ids = new Set();
    this.#acknowledged = new Set();
    this.#reports = [];
    this.#partial = undefined;
  }

  async #refresh(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let handle;
      try { handle = await open(this.path, "r"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (this.#identity) this.#reset();
        this.#size = 0;
        return;
      }
      try {
        const stat = await handle.stat({ bigint: true });
        const size = Number(stat.size);
        const mtime = stat.mtimeNs ?? stat.mtimeMs;
        if (stat.ino !== this.#identity?.ino || stat.dev !== this.#identity?.dev || size < this.#size
          || size === this.#size && mtime !== this.#mtime) this.#reset(stat);
        if (size === this.#size) return;
        if (this.#boundary.length) {
          // Growth can hide a truncate-and-regrow on the same inode.
          const boundary = Buffer.alloc(this.#boundary.length);
          const { bytesRead } = await handle.read(boundary, 0, boundary.length, this.#offset - boundary.length);
          if (bytesRead !== boundary.length || !boundary.equals(this.#boundary)) this.#reset(stat);
        }
        const bytes = Buffer.alloc(size - this.#offset);
        let count = 0;
        while (count < bytes.length) {
          const { bytesRead } = await handle.read(bytes, count, bytes.length - count, this.#offset + count);
          if (!bytesRead) break;
          count += bytesRead;
        }
        if ((await handle.stat({ bigint: true })).size < stat.size) { this.#reset(stat); continue; }
        if (count !== bytes.length) throw new Error("Proposal journal ended during read.");
        let cursor = 0;
        let newline: number;
        while ((newline = bytes.indexOf(10, cursor)) !== -1) {
          this.#commit(this.#parse(bytes.subarray(cursor, newline).toString("utf8"), this.#offset + cursor, this.#line++));
          cursor = newline + 1;
        }
        if (cursor >= JOURNAL_BOUNDARY_BYTES) this.#boundary = Buffer.from(bytes.subarray(cursor - JOURNAL_BOUNDARY_BYTES, cursor));
        else if (cursor) this.#boundary = Buffer.concat([this.#boundary, bytes.subarray(0, cursor)]).subarray(-JOURNAL_BOUNDARY_BYTES);
        this.#offset += cursor;
        // An unterminated line can still grow, including inside a UTF-8 codepoint.
        // Never commit it to the cache until its newline has been observed.
        this.#partial = this.#parse(bytes.subarray(cursor).toString("utf8"), this.#offset, this.#line);
        if (this.#partial?.kind === "fenced") this.#reports.push({ ...this.#partial.record, epoch: this.#epoch });
        this.#size = size;
        this.#mtime = mtime;
        return;
      } finally { await handle.close(); }
    }
    throw new Error("Proposal journal kept shrinking during read.");
  }

  #parse(raw: string, offset: number, line: number): ParsedLine | undefined {
    if (!raw.trim()) return;
    let event: ProposalEvent;
    try {
      event = JSON.parse(raw) as ProposalEvent;
      if (!event || typeof event !== "object") throw new Error("Invalid journal record.");
    } catch { return { kind: "damaged", record: { raw, offset, line } }; }
    if (event.type === "writer-claim" && !safeGeneration(event.generation)) return { kind: "damaged", record: { raw, offset, line, invalidClaim: true } };
    return { kind: (event.generation ?? 0) < this.#generation ? "fenced" : "valid", record: { event, offset, line } };
  }

  #commit(parsed: ParsedLine | undefined): void {
    if (!parsed) return;
    if (parsed.kind === "damaged") {
      this.#skipped.push(parsed.record);
      this.#last = parsed.record.line;
      return;
    }
    const record = parsed.record;
    if (record.event.type !== "writer-claim") this.#last = record.line;
    if (parsed.kind === "fenced") {
      this.#fenced.push(record);
      this.#reports.push({ ...record, epoch: this.#epoch });
      return;
    }
    this.#records.push(record);
    if (record.event.type === "writer-claim") this.#generation = record.event.generation;
    if (record.event.type === "recovery-ack") this.#acknowledged.add(record.event.offset);
    if (record.event.eventId) this.#ids.add(record.event.eventId);
  }
}
