import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { baselineHash, captureBaseline, FolderTooLargeError, boundedBaselinePreview } from "../hashing.ts";
import { acquireVersioningLock, VersioningLockError, type VersioningLockLease } from "../versioning/lock.ts";
import { discardUnappliedProposalRestorePoint } from "../snapshots.ts";
import { RECORDER_INLINE_LIMIT_BYTES, type RecorderStore } from "../recorder/store.ts";
import type {
  ActionOutcome,
  AdoptGroupResult,
  Proposal,
  ProposalBaseline,
  ProposalFilter,
  HostProposalSettlement,
  CoreProposalSettlementReason,
  ProposalPreview,
  ProposalSettlementReason,
  ProposalSettlementResult,
  ProposalSettler,
  ProposalStatus,
  ProposalStore,
  ProposalStoreState,
} from "./types.ts";
import type { BridleLane } from "../types.ts";
import { ProposalJournal, type ProposalEvent } from "./journal.ts";
import { UNPREVIEWED_TOUCHED_PATH_REASON } from "./types.ts";

export const PROPOSAL_CLOSE_TIMEOUT_MS = 1_000;

type StoredBlobRef = { $blob: string; bytes: number; preview: string };
type ProposalWrite = Omit<Proposal, "lane"> & { lane: BridleLane };


type Settlement = {
  status: Exclude<ProposalStatus, "proposed">;
  settledBy?: ProposalSettler;
  settlementReason?: ProposalSettlementReason;
  mayHaveApplied?: true;
  outcome?: ActionOutcome;
  restorePointId?: string;
};

type AdoptionExecution = {
  result: { text: string; isError?: boolean };
  denied: boolean;
  stale?: boolean;
  staleCause?: CoreProposalSettlementReason;
  aborted?: boolean;
  touchedPaths?: readonly string[];
};

type ProposalStoreBindings = {
  adopt(proposal: Proposal, signal: AbortSignal): Promise<AdoptionExecution>;
  preview(proposal: Proposal): Promise<ProposalPreview>;
};

type ProposalLifecycleEvent =
  | { type: "proposal_created" | "proposal_settled"; proposal: Proposal }
  | {
      type: "proposal_attempted";
      proposal: Proposal;
      outcome: ActionOutcome;
    };

export type ProposalStoreController = {
  close(): Promise<void>;
  create(proposal: ProposalWrite): Promise<Proposal>;
  settle(id: string, settlement: Settlement): Promise<ProposalSettlementResult>;
  bind(bindings: ProposalStoreBindings): void;
  ensureWritable(): Promise<boolean>;
  cancelTurn(turnId: string): Promise<ProposalSettlementResult[]>;
  beginTurn(turnId: string): AbortSignal;
  signalForTurn(turnId: string): AbortSignal;
  finishTurn(turnId: string): Promise<void>;
  waitForTurn(turnId: string): Promise<void>;
};

class ProposalAppendRefused extends Error {
  constructor(readonly refusalReason: NonNullable<ProposalSettlementResult["refusalReason"]>) {
    super(refusalReason === "fenced-write" ? "Proposal fenced-write: the append belongs to an earlier claim." : `Proposal store-locked: ${refusalReason}.`);
  }
}

function isBlobRef(value: unknown): value is StoredBlobRef {
  return !!value && typeof value === "object"
    && typeof (value as { $blob?: unknown }).$blob === "string"
    && typeof (value as { bytes?: unknown }).bytes === "number";
}

function matches(proposal: Proposal, filter?: ProposalFilter): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => proposal[key as keyof Proposal] === value);
}

type StaleEntry = ProposalBaseline & { currentHash: string };

async function staleEntries(proposal: Proposal, hashes?: Map<string, Promise<string>>, includeFolders = true): Promise<StaleEntry[]> {
  if (proposal.status !== "proposed" || !proposal.baseline?.length) return [];
  const mismatches: StaleEntry[] = [];
  for (const baseline of proposal.baseline) {
    if (!includeFolders && baseline.directory) continue;
    // Directory-safe: a folder baseline must never read the folder as a file.
    const key = JSON.stringify(baseline);
    let current = hashes?.get(key);
    if (!current) {
      current = baselineHash(baseline);
      hashes?.set(key, current);
    }
    const currentHash = await current;
    if (currentHash !== baseline.hash) mismatches.push({ ...baseline, currentHash });
  }
  return mismatches;
}

export async function openProposalStore(options: {
  appDataDir: string;
  recorder: RecorderStore | null;
  snapshots?: import("../snapshots.ts").SnapshotStore;
  closeTimeoutMs?: number;
  onLifecycle?: (event: ProposalLifecycleEvent) => void | Promise<void>;
  onRecovery?: (warning: { code: "torn-final-line" | "invalid-line" | "interrupted-adoption" | "store-locked" | "store-in-use-in-process" | "lease-lost" | "fenced-write"; line: number; offset?: number; proposalIds?: string[]; settlementReason?: "corrupt-journal" | "interrupted" | "attempt-failed" | "outcome-unknown"; mayHaveApplied?: true }) => void | Promise<void>;
  onCancellationRefused?: (proposal: Proposal, reason: "adoption-in-flight") => void | Promise<void>;
  onAdoptionRefused?: (proposal: Proposal, reason: "aborted" | "store-locked") => void | Promise<void>;
}): Promise<{ store: ProposalStore; controller: ProposalStoreController; readonly state: ProposalStoreState }> {
  const proposalsDir = join(options.appDataDir, "proposals");
  const journalPath = join(proposalsDir, "proposals.jsonl");
  await mkdir(proposalsDir, { recursive: true });
  const turns = new Map<string, { controller: AbortController; active: boolean }>();
  const turnState = (turnId: string) => {
    let state = turns.get(turnId);
    if (!state) { state = { controller: new AbortController(), active: false }; turns.set(turnId, state); }
    return state;
  };
  const cancelled = (proposal: Proposal) => turns.get(proposal.turnId)?.controller.signal.aborted || proposal.settlementReason === "aborted";
  const listeners = new Set<(proposals: Proposal[]) => void>();
  // Process-local claims serialize callers; durable adoption intents fail closed after a crash.
  const inFlightClaims = new Map<string, {
    kind: "adoption" | "settlement";
    promise: Promise<ProposalSettlementResult>;
    interrupt?: (proposal: ProposalSettlementResult) => void;
  }>();
  const abandoned = new Map<string, Promise<ProposalSettlementResult>>();
  const groupAdoptionWriteHashes = new Map<string, Map<string, ProposalBaseline>>();
  let bindings: ProposalStoreBindings | undefined;

  const hydratePayload = async (payload: unknown): Promise<unknown> => {
    if (!isBlobRef(payload)) return payload;
    if (!options.recorder) throw new Error(`Proposal payload references unavailable recorder blob ${payload.$blob}`);
    const bytes = await readFile(join(options.recorder.blobsDir, payload.$blob));
    if (bytes.byteLength !== payload.bytes) throw new Error(`Proposal payload blob size mismatch: ${payload.$blob}`);
    return JSON.parse(bytes.toString("utf8"));
  };

  const reportRecovery = async (report: Parameters<NonNullable<typeof options.onRecovery>>[0]) => {
    try {
      if (options.onRecovery) await options.onRecovery(report);
      else console.warn(`Bridle proposals: recovered ${report.code} at line ${report.line}.`);
    } catch { console.warn(`Bridle proposals: recovery observer failed for line ${report.line}; continuing.`); }
  };
  let needsSeparator = false;
  let effectiveGeneration = 0;
  const reportedFences = new Set<string>();
  const journal = new ProposalJournal(journalPath);
  const reportFences = async () => {
    for (const record of journal.drainFenced()) {
      const key = `${record.epoch}:${record.offset}`;
      if (reportedFences.has(key)) continue;
      reportedFences.add(key);
      await reportRecovery({ code: "fenced-write", line: record.line, offset: record.offset });
    }
  };
  let releaseLock: VersioningLockLease | undefined;
  let readOnlyReason: Extract<ProposalStoreState, { status: "read-only" }>["reason"] = "store-locked";
  try { releaseLock = await acquireVersioningLock(proposalsDir, { onLost: async () => {
    readOnlyReason = "lease-lost";
    await reportRecovery({ code: "lease-lost", line: 0 });
  }, onClaim: async (lockGeneration) => {
    const generation = Math.max(lockGeneration, effectiveGeneration, await journal.latestGeneration()) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error("Proposal fencing generation exhausted.");
    // The claim and later events share one append order. Always frame a claim so
    // a torn tail cannot hide it, and make it durable before admitting a writer.
    const handle = await open(journalPath, "a");
    try {
      await handle.writeFile(`\n${JSON.stringify({ type: "writer-claim", at: new Date().toISOString(), generation })}\n`, "utf8");
      await handle.sync();
      effectiveGeneration = generation;
      needsSeparator = false;
    } catch (error) { needsSeparator = true; throw error; }
    finally { await handle.close(); }
  } }); }
  catch (error) {
    if (!(error instanceof VersioningLockError)) throw error;
    readOnlyReason = error.reason === "in-process-holder" ? "store-in-use-in-process" : "store-locked";
    await reportRecovery({ code: readOnlyReason, line: 0 });
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  const pendingAppends = new Set<Promise<void>>();
  const isWritable = (draining = false) => releaseLock?.isHeld() === true && !closed && (draining || !closing);
  const ensureWritable = async (draining = false) => {
    if (closed || (!draining && closing) || !releaseLock) return false;
    await releaseLock.ensureHeld();
    return isWritable(draining);
  };
  // A lost writer cannot journal its shutdown, but its callers must still settle.
  const volatileSettlements = new Map<string, ProposalSettlementResult>();
  const locked = (proposal: Proposal): ProposalSettlementResult => ({ ...proposal, refused: "store-locked", refusalReason: readOnlyReason });
  const append = (event: ProposalEvent, draining = false): Promise<void> => {
    const pending = (async () => {
      if (!isWritable(draining) && !await ensureWritable(draining)) throw new ProposalAppendRefused(readOnlyReason);
      const generation = effectiveGeneration;
      const eventId = randomUUID();
      const text = `${needsSeparator ? "\n" : ""}${JSON.stringify({ ...event, generation, eventId })}\n`;
      const confirm = async () => {
        if (!await releaseLock!.ensureHeld()) throw new ProposalAppendRefused("lease-lost");
        // A same-writer renewal may fence an append already inside the OS. An
        // ignored intent must never authorise host execution, even with a live lease.
        const valid = await journal.contains(eventId);
        await reportFences();
        if (!valid) throw new ProposalAppendRefused("fenced-write");
      };
      if (event.type !== "adoption-start") {
        await appendFile(journalPath, text, "utf8");
        needsSeparator = false;
        await confirm();
        return;
      }
      const handle = await open(journalPath, "a");
      try {
        // Preserve historical bytes; the intent must reach disk before host code runs.
        await handle.writeFile(text, "utf8");
        needsSeparator = false;
        await handle.sync();
      } finally { await handle.close(); }
      await confirm();
    })().catch((error: unknown) => { needsSeparator = true; throw error; });
    pendingAppends.add(pending);
    return pending.finally(() => { pendingAppends.delete(pending); });
  };

  // Parsing and folding never repair the journal. Recovery belongs exclusively to open.
  const readEvents = async () => {
    const snapshot = await journal.read();
    await reportFences();
    return snapshot;
  };
  const recover = async () => {
    const { needsSeparator: separator, records, skipped, fenced, last } = await readEvents();
    needsSeparator = separator;
    const current = new Map<string, { offset: number; status: ProposalStatus }>();
    const settled = new Set<string>();
    const intents = new Map<string, { line: number; attempted: boolean }>();
    for (const { event, line } of records) {
      if (event.type === "created") current.set(event.proposal.id, { offset: line, status: event.proposal.status });
      else if (event.type === "adoption-start") intents.set(event.id, { line, attempted: false });
      else if (event.type === "attempted") { const intent = intents.get(event.id); if (intent) intent.attempted = true; }
      else if (event.type === "settled") {
        settled.add(event.id);
        intents.delete(event.id);
        const proposal = current.get(event.id);
        if (proposal) current.set(event.id, { ...proposal, status: event.status });
      }
    }
    const acknowledged = new Set(records.flatMap(({ event }) => event.type === "recovery-ack" ? [event.offset] : []));
    const acknowledgements: Extract<ProposalEvent, { type: "recovery-ack" }>[] = fenced.filter((record) => !acknowledged.has(record.offset))
      .map((record) => ({ type: "recovery-ack", at: new Date().toISOString(), offset: record.offset, line: record.line, code: "fenced-write" }));
    const rejected = new Map<string, "corrupt-journal" | "interrupted" | "attempt-failed" | "outcome-unknown">();
    const reports: Array<Parameters<NonNullable<typeof options.onRecovery>>[0]> = [];
    for (const skippedLine of skipped) {
      if (acknowledged.has(skippedLine.offset)) continue;
      const code = !skippedLine.invalidClaim && skippedLine.line === last ? "torn-final-line" : "invalid-line";
      acknowledgements.push({ type: "recovery-ack", at: new Date().toISOString(), offset: skippedLine.offset, line: skippedLine.line, code });
      const named = [...current.keys()].filter((id) => skippedLine.raw.includes(id));
      const ids = (named.length ? named : [...current].filter(([, proposal]) => proposal.offset < skippedLine.line).map(([id]) => id))
        .filter((id) => { const proposal = current.get(id)!; return !settled.has(id) && (proposal.status === "proposed" || intents.has(id)); });
      const uncertain = ids.filter((id) => intents.has(id));
      const corrupt = ids.filter((id) => !intents.has(id));
      for (const id of ids) rejected.set(id, intents.has(id) ? "outcome-unknown" : "corrupt-journal");
      if (corrupt.length || !ids.length) reports.push({ code, line: skippedLine.line, ...(corrupt.length ? { proposalIds: corrupt, settlementReason: "corrupt-journal" } : {}) });
      if (uncertain.length) reports.push({ code, line: skippedLine.line, proposalIds: uncertain, settlementReason: "outcome-unknown", mayHaveApplied: true });
    }
    for (const [id, intent] of intents) {
      const proposal = current.get(id);
      if (!proposal || settled.has(id) || rejected.has(id)) continue;
      const reason = intent.attempted ? "attempt-failed" : "interrupted";
      rejected.set(id, reason);
      reports.push({ code: "interrupted-adoption", line: intent.line, proposalIds: [id], settlementReason: reason, ...(reason === "interrupted" ? { mayHaveApplied: true as const } : {}) });
    }
    for (const [id, reason] of rejected) {
      await append({ type: "settled", id, at: new Date().toISOString(), status: "rejected", settledBy: "policy", settlementReason: reason, ...((reason === "outcome-unknown" || reason === "interrupted") ? { mayHaveApplied: true as const } : {}) });
    }
    for (const ack of acknowledgements) await append(ack);
    for (const report of reports) await reportRecovery(report);
  };
  try { if (isWritable(true)) await recover(); }
  catch (error) { await releaseLock?.(); throw error; }

  const fold = async (): Promise<Proposal[]> => {
    const current = new Map<string, Proposal>();
    for (const { event } of (await readEvents()).records) {
      if (event.type === "writer-claim" || event.type === "adoption-start" || event.type === "recovery-ack") continue;
      if (event.type === "created") {
        current.set(event.proposal.id, {
          ...event.proposal,
          lane: event.proposal.lane ?? "legacy",
          baseline: event.proposal.baseline?.map(boundedBaselinePreview),
          payload: await hydratePayload(event.proposal.payload),
        });
        continue;
      }
      const proposal = current.get(event.id);
      if (!proposal) continue;
      if (event.type === "attempted") {
        current.set(event.id, {
          ...proposal,
          outcome: event.outcome,
        });
        continue;
      }
      const { outcome: _previousAttempt, ...proposalWithoutAttempt } = proposal;
      current.set(event.id, {
        ...proposalWithoutAttempt,
        status: event.status,
        settledAt: event.at,
        ...(event.settledBy ? { settledBy: event.settledBy } : {}),
        ...(event.settlementReason ? { settlementReason: event.settlementReason } : {}),
        ...(event.mayHaveApplied ? { mayHaveApplied: true as const } : {}),
        ...(event.outcome ? { outcome: event.outcome } : {}),
        ...(event.restorePointId ? { restorePointId: event.restorePointId } : {}),
      });
    }
    for (const [id, result] of volatileSettlements) {
      const { refused: _refused, refusalReason: _refusalReason, ...proposal } = result;
      current.set(id, proposal);
    }
    return [...current.values()];
  };

  const pruneTurn = async (turnId: string): Promise<void> => {
    if (!turns.has(turnId)) return;
    if (turns.get(turnId)?.active || inFlightClaims.size && (await fold()).some((proposal) => proposal.turnId === turnId && inFlightClaims.has(proposal.id))) return;
    if (!(await fold()).some((proposal) => proposal.turnId === turnId && proposal.status === "proposed")) turns.delete(turnId);
  };

  const notify = (proposals: Proposal[]): void => {
    for (const listener of listeners) listener(proposals);
  };

  const performSettlement = async (id: string, settlement: Settlement): Promise<ProposalSettlementResult> => {
    const existing = (await fold()).find((proposal) => proposal.id === id);
    if (!existing) throw new Error(`Unknown proposal: ${id}`);
    if (abandoned.has(id)) return abandoned.get(id)!;
    if (!isWritable(true) && !await ensureWritable(true)) return locked(existing);
    if (existing.status !== "proposed") return { ...existing, refused: "already-settled" };
    await append({
      type: "settled",
      id,
      at: new Date().toISOString(),
      ...settlement,
    }, true);
    const settled = (await fold()).find((proposal) => proposal.id === id)!;
    await options.onLifecycle?.({ type: "proposal_settled", proposal: settled });
    notify(await fold());
    return settled;
  };

  const lockedProposal = async (id: string): Promise<ProposalSettlementResult> => {
    const proposal = (await fold()).find((candidate) => candidate.id === id);
    if (!proposal) throw new Error(`Unknown proposal: ${id}`);
    return locked(proposal);
  };

  const settle = (id: string, settlement: Settlement): Promise<ProposalSettlementResult> => {
    if (!isWritable()) return ensureWritable().then((writable) => writable ? settle(id, settlement) : lockedProposal(id));
    const claim = inFlightClaims.get(id);
    if (claim?.kind === "adoption") {
      return fold().then((proposals) => {
        const existing = proposals.find((proposal) => proposal.id === id);
        if (!existing) throw new Error(`Unknown proposal: ${id}`);
        return { ...existing, refused: "adoption-in-flight" as const };
      });
    }
    if (claim?.kind === "settlement") {
      return claim.promise.then((winner) => ({ ...winner, refused: "already-settled" as const }));
    }
    let settlementPromise!: Promise<Proposal>;
    settlementPromise = performSettlement(id, settlement).finally(() => {
      if (inFlightClaims.get(id)?.promise === settlementPromise) inFlightClaims.delete(id);
      if (!turns.size) return;
      return fold().then((proposals) => {
        const settled = proposals.find((proposal) => proposal.id === id);
        return settled ? pruneTurn(settled.turnId) : undefined;
      });
    });
    inFlightClaims.set(id, { kind: "settlement", promise: settlementPromise });
    return settlementPromise;
  };

  const list = async (filter?: ProposalFilter, includeFolders = false): Promise<Proposal[]> => {
    const stale = new Set<string>();
    // Folder listings are stored views, not repeated filesystem scans. The
    // explicit recheck method and every Adoption verify folders afresh. Plain
    // file checks are shared, and list never journals a settlement.
    const hashes = new Map<string, Promise<string>>();
    for (const proposal of await fold()) {
      if ((await staleEntries(proposal, hashes, includeFolders)).length) stale.add(proposal.id);
    }
    return (await fold()).map((proposal): Proposal => proposal.status === "proposed" && stale.has(proposal.id)
      ? { ...proposal, status: "stale" } : proposal).filter((proposal) => matches(proposal, filter));
  };

  const controller: ProposalStoreController = {
    close() {
      return closing ??= (async () => {
        const cancelledTurns = new Set([...turns].filter(([, turn]) => turn.active || turn.controller.signal.aborted).map(([id]) => id));
        for (const { controller } of turns.values()) controller.abort();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const drained = await Promise.race([
          Promise.allSettled([...inFlightClaims.values()].map((claim) => claim.promise)).then(() => true),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), options.closeTimeoutMs ?? PROPOSAL_CLOSE_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timer));
        try {
          if (!drained) {
            const stuck = [...inFlightClaims].filter(([, claim]) => claim.kind === "adoption");
            for (const [id, claim] of stuck) abandoned.set(id, claim.promise);
            // A settlement write already submitted before the fence remains authoritative.
            await Promise.allSettled([...pendingAppends]);
            for (const [id, claim] of stuck) {
              const proposal = (await fold()).find((entry) => entry.id === id);
              if (!proposal) continue;
              if (proposal.status === "proposed") {
                const settlement = { type: "settled", id, at: new Date().toISOString(), status: "rejected", settledBy: "policy", settlementReason: "interrupted", mayHaveApplied: true } as const;
                if (await ensureWritable(true)) await append(settlement, true);
                else volatileSettlements.set(id, locked({ ...proposal, status: settlement.status, settledBy: settlement.settledBy, settlementReason: settlement.settlementReason, mayHaveApplied: true, settledAt: settlement.at }));
              }
              const interrupted = volatileSettlements.get(id) ?? (await fold()).find((entry) => entry.id === id)!;
              claim.interrupt?.(interrupted);
              inFlightClaims.delete(id);
              // A host observer must not extend the shutdown deadline.
              if (proposal.status === "proposed") void Promise.resolve().then(() => options.onLifecycle?.({ type: "proposal_settled", proposal: interrupted })).catch(() => {});
            }
          }
          await Promise.allSettled([...pendingAppends]);
          if (await ensureWritable(true)) for (const proposal of await fold()) {
            if (proposal.status !== "proposed" || !cancelledTurns.has(proposal.turnId)) continue;
            await append({ type: "settled", id: proposal.id, at: new Date().toISOString(), status: "rejected", settledBy: "policy", settlementReason: "aborted" }, true);
            const cancelled = (await fold()).find((entry) => entry.id === proposal.id)!;
            void Promise.resolve().then(() => options.onLifecycle?.({ type: "proposal_settled", proposal: cancelled })).catch(() => {});
          }
          closed = true;
        } finally { closed = true; await releaseLock?.(); }
      })();
    },
    async create(input) {
      if (!isWritable() && !await ensureWritable()) throw new Error("Proposal store-locked: this handle is read-only.");
      const pending = (await fold()).filter((candidate) => candidate.status === "proposed");
      const primaryPath = input.baseline?.[0]?.path;
      const replaced = primaryPath && !input.allowSiblings
        ? pending.find((candidate) => candidate.capability === input.capability && candidate.baseline?.[0]?.path === primaryPath)
        : undefined;
      let replacedId: string | undefined;
      let supersedeRefused = false;
      let supersededBy: string | undefined;
      if (replaced) {
        const superseded = await settle(replaced.id, { status: "superseded" });
        supersedeRefused = Boolean(superseded.refused);
        if (!superseded.refused && superseded.status === "superseded") replacedId = replaced.id;
        if (supersedeRefused) {
          supersededBy = (await fold()).find((candidate) => candidate.supersedes === replaced.id)?.id;
        }
      }
      const frozen = structuredClone(input);
      frozen.baseline = frozen.baseline?.map(boundedBaselinePreview);
      const created = {
        ...frozen,
        ...(replacedId ? { supersedes: replacedId } : {}),
        ...(supersedeRefused ? { supersedeRefused: true as const } : {}),
        ...(supersededBy ? { supersededBy } : {}),
      };
      const encoded = JSON.stringify(created.payload);
      let payload: unknown = created.payload;
      if (options.recorder && Buffer.byteLength(encoded, "utf8") > RECORDER_INLINE_LIMIT_BYTES) {
        const blob = options.recorder.putBlob(encoded, encoded.slice(0, 200));
        payload = { $blob: blob.hash, bytes: blob.bytes, preview: encoded.slice(0, 200) } satisfies StoredBlobRef;
      }
      await append({ type: "created", at: new Date().toISOString(), proposal: { ...created, payload } });
      const stored = (await fold()).find((proposal) => proposal.id === created.id)!;
      await options.onLifecycle?.({ type: "proposal_created", proposal: stored });
      notify(await fold());
      if (cancelled(stored)) return settle(stored.id, { status: "rejected", settledBy: "policy", settlementReason: "aborted" });
      return stored;
    },
    settle,
    beginTurn(turnId) { const state = turnState(turnId); state.active = true; return state.controller.signal; },
    signalForTurn(turnId) { return turnState(turnId).controller.signal; },
    async finishTurn(turnId) {
      const state = turns.get(turnId);
      if (state) state.active = false;
      await pruneTurn(turnId);
    },
    async waitForTurn(turnId) {
      for (;;) {
        const ids = new Set((await fold()).filter((proposal) => proposal.turnId === turnId).map((proposal) => proposal.id));
        const claims = [...inFlightClaims].filter(([id]) => ids.has(id)).map(([, claim]) => claim.promise);
        if (!claims.length) return;
        await Promise.allSettled(claims);
      }
    },
    ensureWritable,
    async cancelTurn(turnId) {
      turnState(turnId).controller.abort();
      const pending = (await fold()).filter((proposal) => proposal.turnId === turnId && proposal.status === "proposed");
      const results = await Promise.all(pending.map(async (proposal) => {
        const result = await settle(proposal.id, { status: "rejected", settledBy: "policy", settlementReason: "aborted" });
        if (result.refused === "adoption-in-flight") await options.onCancellationRefused?.(proposal, result.refused);
        return result;
      }));
      await pruneTurn(turnId);
      return results;
    },
    bind(value) {
      bindings = value;
    },
  };

  const performAdoptOne = async (id: string, groupRestorePointId?: string, onAttempt?: () => void): Promise<ProposalSettlementResult> => {
    const proposal = (await fold()).find((candidate) => candidate.id === id);
    if (!proposal) throw new Error(`Unknown proposal: ${id}`);
    if (!isWritable(true) && !await ensureWritable(true)) {
      await options.onAdoptionRefused?.(proposal, "store-locked");
      return locked(proposal);
    }
    if (proposal.status === "proposed") onAttempt?.();
    if (cancelled(proposal)) {
      const cancelled = proposal.status === "proposed"
        ? await performSettlement(id, { status: "rejected", settledBy: "policy", settlementReason: "aborted" }) : proposal;
      await options.onAdoptionRefused?.(cancelled, "aborted");
      return cancelled;
    }
    if (proposal.status !== "proposed") return proposal;
    if (!bindings) throw new Error("Proposal adoption is not configured");
    const signal = turnState(proposal.turnId).controller.signal;
    if ((await staleEntries(proposal)).length) return performSettlement(id, { status: "stale" });
    const individualRestorePointId = groupRestorePointId === undefined
      ? await options.snapshots?.beginRestorePoint(
        `proposal adoption: ${id}`,
        proposal.sessionId,
        { proposalId: id },
      )
      : undefined;
    const restorePointId = groupRestorePointId ?? individualRestorePointId;
    // Cancellation may have arrived during staleness checks or restore-point creation.
    if (signal.aborted) {
      if (individualRestorePointId) await options.snapshots?.discardRestorePoint(individualRestorePointId);
      return performSettlement(id, { status: "rejected", settledBy: "policy", settlementReason: "aborted" });
    }
    try {
      await append({ type: "adoption-start", id, at: new Date().toISOString() }, true);
    } catch (error) {
      if (!(error instanceof ProposalAppendRefused)) throw error;
      if (individualRestorePointId) await options.snapshots?.discardRestorePoint(individualRestorePointId);
      const refused: ProposalSettlementResult = { ...proposal, refused: "store-locked", refusalReason: error.refusalReason };
      await options.onAdoptionRefused?.(refused, "store-locked");
      return refused;
    }
    // Writing the intent can suspend too; Stop must still prevent execution.
    if (signal.aborted) {
      if (individualRestorePointId) await options.snapshots?.discardRestorePoint(individualRestorePointId);
      return performSettlement(id, { status: "rejected", settledBy: "policy", settlementReason: "aborted" });
    }
    const execution = await bindings.adopt(proposal, signal);
    if (abandoned.has(id)) return abandoned.get(id)!;
    if (execution.aborted && signal.aborted) {
      if (individualRestorePointId) await options.snapshots?.discardRestorePoint(individualRestorePointId);
      return performSettlement(id, { status: "rejected", settledBy: "policy", settlementReason: "aborted" });
    }
    if (execution.stale) {
      if (individualRestorePointId) {
        if (options.snapshots) {
          await discardUnappliedProposalRestorePoint(options.snapshots, individualRestorePointId);
        }
      }
      switch (execution.staleCause) {
        case UNPREVIEWED_TOUCHED_PATH_REASON:
          return performSettlement(id, {
            status: "stale",
            settlementReason: UNPREVIEWED_TOUCHED_PATH_REASON,
          });
        default:
          return performSettlement(id, { status: "stale" });
      }
    }
    if (execution.denied) {
      if (individualRestorePointId) await options.snapshots?.discardRestorePoint(individualRestorePointId);
      return performSettlement(id, { status: "rejected", settledBy: "policy" });
    }
    if (execution.aborted) {
      const outcome: ActionOutcome = {
        at: new Date().toISOString(),
        resultText: execution.result.text,
        isError: Boolean(execution.result.isError),
      };
      await append({
        type: "attempted",
        id,
        at: outcome.at,
        outcome,
      }, true);
      if (individualRestorePointId) {
        await options.snapshots?.discardRestorePoint(individualRestorePointId);
      }
      const attempted = (await fold()).find((candidate) => candidate.id === id)!;
      await options.onLifecycle?.({
        type: "proposal_attempted",
        proposal: attempted,
        outcome,
      });
      notify(await fold());
      return attempted;
    }
    if (groupRestorePointId !== undefined) {
      const written = new Map<string, ProposalBaseline>();
      // Accepted residual: a third writer between the sibling write and this hash
      // capture can be misattributed. The blast radius is a wrong sibling label
      // plus a missed stop, never an incorrect write by Bridle.
      for (const path of new Set(execution.touchedPaths ?? [])) {
        let baseline: ProposalBaseline;
        try { baseline = await captureBaseline(path); }
        catch (error) {
          // Execution has already happened. An oversized post-write inventory
          // supplies no exact sibling evidence, but cannot turn it into refusal.
          if (error instanceof FolderTooLargeError) continue;
          throw error;
        }
        // An overflow marker is not evidence of a sibling's exact write.
        if (baseline.directory?.baseline !== "too-large" && await baselineHash(baseline) === baseline.hash) {
          written.set(path, baseline);
        }
      }
      groupAdoptionWriteHashes.set(id, written);
    }
    return performSettlement(id, {
      status: "adopted",
      ...(restorePointId ? { restorePointId } : {}),
      ...(proposal.kind === "action" ? {
        outcome: {
          at: new Date().toISOString(),
          resultText: execution.result.text,
          isError: Boolean(execution.result.isError),
        },
      } : {}),
    });
  };

  const adoptOne = (id: string, groupRestorePointId?: string, onAttempt?: () => void): Promise<ProposalSettlementResult> => {
    if (!isWritable()) return ensureWritable().then(async (writable) => {
      if (writable) return adoptOne(id, groupRestorePointId, onAttempt);
      const proposal = await lockedProposal(id);
      await options.onAdoptionRefused?.(proposal, "store-locked");
      return proposal;
    });
    const existing = inFlightClaims.get(id);
    if (existing) return existing.promise;
    let interrupt!: (proposal: ProposalSettlementResult) => void;
    const interrupted = new Promise<ProposalSettlementResult>((resolve) => { interrupt = resolve; });
    const work = performAdoptOne(id, groupRestorePointId, onAttempt).finally(() => { abandoned.delete(id); });
    const adoption = Promise.race([work, interrupted]).finally(() => {
      if (inFlightClaims.get(id)?.promise === adoption) inFlightClaims.delete(id);
      return fold().then((proposals) => {
        const settled = proposals.find((proposal) => proposal.id === id);
        return settled ? pruneTurn(settled.turnId) : undefined;
      });
    });
    inFlightClaims.set(id, { kind: "adoption", promise: adoption, interrupt });
    return adoption;
  };

  const store: ProposalStore = {
    list,
    async get(id) {
      return (await list()).find((proposal) => proposal.id === id);
    },
    async recheck(id) {
      const proposals = await fold();
      const candidate = proposals.find((proposal) => proposal.id === id);
      if (!candidate) throw new Error(`Unknown proposal: ${id}`);
      if (!isWritable() && !await ensureWritable()) {
        const observed = (await list(undefined, true)).find((proposal) => proposal.id === id)!;
        return locked(observed);
      }
      if ((await staleEntries(candidate)).length) return settle(id, { status: "stale" });
      return (await fold()).find((proposal) => proposal.id === id)!;
    },
    adopt(id) {
      return adoptOne(id);
    },
    reject(id, by = "user") {
      return settle(id, { status: "rejected", settledBy: by });
    },
    async settleAsHost(id, settlement: HostProposalSettlement) {
      if (settlement.reason !== "superseded-by-host") {
        throw new TypeError(`Invalid host proposal settlement reason: ${String(settlement.reason)}`);
      }
      return settle(id, {
        status: settlement.status,
        settledBy: "host",
        settlementReason: settlement.reason,
      });
    },
    async adoptGroup(groupId): Promise<AdoptGroupResult> {
      const members = (await list({ groupId })).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      if (!isWritable() && !await ensureWritable()) {
        for (const member of members) await options.onAdoptionRefused?.(member, "store-locked");
        return { adopted: [], outcomes: members.map((member) => ({ id: member.id, status: member.status, refused: "store-locked" as const })),
          ...(members[0] ? { stopped: { id: members[0].id, reason: "store-locked" as const } } : {}), restorePointId: "" };
      }
      const restorePointId = await options.snapshots?.beginRestorePoint(`group adoption: ${groupId}`, members[0]?.sessionId ?? groupId) ?? "";
      const adopted: string[] = [];
      const outcomes: AdoptGroupResult["outcomes"] = [];
      const stop = (result: ProposalSettlementResult, reason: NonNullable<AdoptGroupResult["stopped"]>["reason"]): AdoptGroupResult => {
        groupAdoptionWriteHashes.delete(result.id);
        outcomes.push({ id: result.id, status: result.status,
          ...(result.refused ? { refused: result.refused } : {}),
          ...(result.refusalReason ? { refusalReason: result.refusalReason } : {}),
          ...(result.settlementReason ? { settlementReason: result.settlementReason } : {}),
        });
        return { adopted, outcomes, stopped: { id: result.id, reason }, restorePointId };
      };
      const stopRefused = (result: ProposalSettlementResult): AdoptGroupResult =>
        stop(result, result.refused === "store-locked" ? "store-locked" : "conflict");
      const freshAtStart = new Set(members.filter((member) => member.status === "proposed").map((member) => member.id));
      const adoptedSiblingHashes = new Map<string, ProposalBaseline>();
      for (const member of members) {
        let current = (await fold()).find((candidate) => candidate.id === member.id);
        if (current && current.status !== member.status && current.status !== "proposed" && current.status !== "adopted") return stop(current, "conflict");
        const mismatches = current ? await staleEntries(current) : [];
        if (current?.status === "proposed" && mismatches.length) {
          const explainedBySibling = current.allowSiblings && freshAtStart.has(current.id)
            && (await Promise.all(mismatches.map(async (entry) => {
              const written = adoptedSiblingHashes.get(entry.path);
              if (!written) return false;
              // The sibling may have grown beyond this proposal's old bounds.
              // Verify against its actual bounded post-write folder baseline,
              // never against the shared overflow marker from the old bounds.
              return written.directory
                ? await baselineHash(written) === written.hash
                : written.hash === entry.currentHash;
            }))).every(Boolean);
          if (explainedBySibling) {
            const siblingSettlement = await settle(current.id, {
              status: "superseded",
              settlementReason: "superseded-by-sibling",
            });
            if (siblingSettlement.refused) return stopRefused(siblingSettlement);
            outcomes.push({
              id: siblingSettlement.id,
              status: siblingSettlement.status,
              settlementReason: "superseded-by-sibling",
            });
            continue;
          }
          const staleSettlement = await settle(current.id, { status: "stale" });
          if (staleSettlement.refused) return stopRefused(staleSettlement);
          current = staleSettlement;
        }
        if (current?.status === "stale") {
          outcomes.push({ id: current.id, status: "stale" });
          return { adopted, outcomes, stopped: { id: member.id, reason: "stale" }, restorePointId };
        }
        if (current?.status !== "proposed") continue;
        // A joined claim or an already-settled member is another caller's result,
        // rather than an unsuccessful attempt made by this group.
        let attempted = false;
        const settled = await adoptOne(member.id, restorePointId, () => { attempted = true; });
        if (settled.refused) return stopRefused(settled);
        if (settled.status !== "adopted") {
          const reason = !attempted ? "conflict" : settled.status === "stale" ? "stale" : "error";
          return stop(settled, reason);
        }
        outcomes.push({ id: settled.id, status: settled.status,
          ...(settled.settlementReason ? { settlementReason: settled.settlementReason } : {}),
        });
        if (settled.status === "adopted") {
          adopted.push(member.id);
          if (member.allowSiblings) {
            for (const [path, writtenHash] of groupAdoptionWriteHashes.get(member.id) ?? []) {
              adoptedSiblingHashes.set(path, writtenHash);
            }
          }
        }
        groupAdoptionWriteHashes.delete(member.id);
        if (settled.kind === "action" && settled.outcome?.isError) {
          return { adopted, outcomes, stopped: { id: member.id, reason: "error" }, restorePointId };
        }
      }
      return { adopted, outcomes, restorePointId };
    },
    async dismissAll(filter) {
      const dismissed: ProposalSettlementResult[] = [];
      for (const proposal of await list({ ...filter, status: "proposed" })) {
        dismissed.push(await settle(proposal.id, { status: "rejected", settledBy: "user" }));
      }
      return dismissed;
    },
    async preview(id) {
      const proposal = await store.get(id);
      if (!proposal) throw new Error(`Unknown proposal: ${id}`);
      if (!bindings) throw new Error("Proposal preview is not configured");
      return bindings.preview(proposal);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };

  return { store, controller, get state(): ProposalStoreState { return isWritable() ? { status: "writable" } : !closed && !closing && releaseLock?.isRenewing() ? { status: "writable", renewing: true } : { status: "read-only", reason: readOnlyReason }; } };
}
