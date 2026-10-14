import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { contentHashOf } from "../hashing.ts";
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
} from "./types.ts";
import type { BridleLane } from "../types.ts";
import { UNPREVIEWED_TOUCHED_PATH_REASON } from "./types.ts";

type StoredBlobRef = { $blob: string; bytes: number; preview: string };
type ProposalWrite = Omit<Proposal, "lane"> & { lane: BridleLane };

type ProposalEvent =
  | { type: "created"; at: string; proposal: Omit<Proposal, "payload"> & { payload: unknown } }
  | { type: "attempted"; id: string; at: string; outcome: ActionOutcome }
  | {
      type: "settled";
      id: string;
      at: string;
      status: Exclude<ProposalStatus, "proposed">;
      settledBy?: ProposalSettler;
      settlementReason?: ProposalSettlementReason;
      outcome?: ActionOutcome;
      restorePointId?: string;
    };

type Settlement = {
  status: Exclude<ProposalStatus, "proposed">;
  settledBy?: ProposalSettler;
  settlementReason?: ProposalSettlementReason;
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
  adopt(proposal: Proposal): Promise<AdoptionExecution>;
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
  create(proposal: ProposalWrite): Promise<Proposal>;
  settle(id: string, settlement: Settlement): Promise<ProposalSettlementResult>;
  bind(bindings: ProposalStoreBindings): void;
};

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

async function staleEntries(proposal: Proposal): Promise<StaleEntry[]> {
  if (proposal.status !== "proposed" || !proposal.baseline?.length) return [];
  const mismatches: StaleEntry[] = [];
  for (const baseline of proposal.baseline) {
    // Directory-safe: a folder baseline must never read the folder as a file.
    const currentHash = await contentHashOf(baseline.path);
    if (currentHash !== baseline.hash) mismatches.push({ ...baseline, currentHash });
  }
  return mismatches;
}

export async function openProposalStore(options: {
  appDataDir: string;
  recorder: RecorderStore | null;
  snapshots?: import("../snapshots.ts").SnapshotStore;
  onLifecycle?: (event: ProposalLifecycleEvent) => void | Promise<void>;
}): Promise<{ store: ProposalStore; controller: ProposalStoreController }> {
  const proposalsDir = join(options.appDataDir, "proposals");
  const journalPath = join(proposalsDir, "proposals.jsonl");
  await mkdir(proposalsDir, { recursive: true });
  const listeners = new Set<(proposals: Proposal[]) => void>();
  // Process-local exactly-once claim: a crash clears the claim while leaving a
  // still-proposed durable Proposal available for a fresh baseline check.
  const inFlightClaims = new Map<string, {
    kind: "adoption" | "settlement";
    promise: Promise<Proposal>;
  }>();
  const groupAdoptionWriteHashes = new Map<string, Map<string, string>>();
  let bindings: ProposalStoreBindings | undefined;

  const hydratePayload = async (payload: unknown): Promise<unknown> => {
    if (!isBlobRef(payload)) return payload;
    if (!options.recorder) throw new Error(`Proposal payload references unavailable recorder blob ${payload.$blob}`);
    const bytes = await readFile(join(options.recorder.blobsDir, payload.$blob));
    if (bytes.byteLength !== payload.bytes) throw new Error(`Proposal payload blob size mismatch: ${payload.$blob}`);
    return JSON.parse(bytes.toString("utf8"));
  };

  const events = async (): Promise<ProposalEvent[]> => {
    if (!existsSync(journalPath)) return [];
    const raw = await readFile(journalPath, "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ProposalEvent);
  };

  const fold = async (): Promise<Proposal[]> => {
    const current = new Map<string, Proposal>();
    for (const event of await events()) {
      if (event.type === "created") {
        current.set(event.proposal.id, {
          ...event.proposal,
          lane: event.proposal.lane ?? "legacy",
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
        ...(event.outcome ? { outcome: event.outcome } : {}),
        ...(event.restorePointId ? { restorePointId: event.restorePointId } : {}),
      });
    }
    return [...current.values()];
  };

  const append = async (event: ProposalEvent): Promise<void> => {
    await appendFile(journalPath, `${JSON.stringify(event)}\n`, "utf8");
  };

  const notify = (proposals: Proposal[]): void => {
    for (const listener of listeners) listener(proposals);
  };

  const performSettlement = async (id: string, settlement: Settlement): Promise<ProposalSettlementResult> => {
    const existing = (await fold()).find((proposal) => proposal.id === id);
    if (!existing) throw new Error(`Unknown proposal: ${id}`);
    if (existing.status !== "proposed") return { ...existing, refused: "already-settled" };
    await append({
      type: "settled",
      id,
      at: new Date().toISOString(),
      ...settlement,
    });
    const settled = (await fold()).find((proposal) => proposal.id === id)!;
    await options.onLifecycle?.({ type: "proposal_settled", proposal: settled });
    notify(await fold());
    return settled;
  };

  const settle = (id: string, settlement: Settlement): Promise<ProposalSettlementResult> => {
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
    });
    inFlightClaims.set(id, { kind: "settlement", promise: settlementPromise });
    return settlementPromise;
  };

  const settleStaleBatch = async (candidates: Proposal[], current: Proposal[]): Promise<Proposal[]> => {
    const claims = new Map<string, {
      promise: Promise<Proposal>;
      resolve: (proposal: Proposal) => void;
      reject: (reason?: unknown) => void;
    }>();
    for (const candidate of candidates) {
      if (inFlightClaims.has(candidate.id)) continue;
      let resolve!: (proposal: Proposal) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<Proposal>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      // The claim promise is consumed by competing settlers, but it may have no
      // consumer when this batch fails. Observe its rejection in either case.
      void promise.catch(() => {});
      claims.set(candidate.id, { promise, resolve, reject });
      inFlightClaims.set(candidate.id, { kind: "settlement", promise });
    }
    if (!claims.size) return current;

    try {
      // Every candidate is re-checked only after the batch owns all available claims.
      const claimedFold = await fold();
      const stillProposed = claimedFold.filter(
        (proposal) => claims.has(proposal.id) && proposal.status === "proposed",
      );
      if (!stillProposed.length) {
        for (const [id, claim] of claims) {
          claim.resolve(claimedFold.find((proposal) => proposal.id === id)!);
        }
        return claimedFold;
      }
      const at = new Date().toISOString();
      for (const candidate of stillProposed) {
        // INVARIANT: No settlement event reaches the journal except through a path
        // that (1) holds the per-proposal claim and (2) has verified folded status
        // === "proposed" AFTER acquiring that claim.
        await append({ type: "settled", id: candidate.id, at, status: "stale" });
      }
      const lifecycleFold = await fold();
      for (const candidate of stillProposed) {
        const settled = lifecycleFold.find((proposal) => proposal.id === candidate.id)!;
        await options.onLifecycle?.({ type: "proposal_settled", proposal: settled });
      }
      const postLifecycleFold = await fold();
      notify(postLifecycleFold);
      for (const [id, claim] of claims) {
        claim.resolve(postLifecycleFold.find((proposal) => proposal.id === id)!);
      }
      return postLifecycleFold;
    } catch (error) {
      for (const claim of claims.values()) claim.reject(error);
      throw error;
    } finally {
      for (const [id, claim] of claims) {
        if (inFlightClaims.get(id)?.promise === claim.promise) inFlightClaims.delete(id);
      }
    }
  };

  const list = async (filter?: ProposalFilter): Promise<Proposal[]> => {
    let proposals = await fold();
    const newlyStale: Proposal[] = [];
    for (const proposal of proposals) {
      if ((await staleEntries(proposal)).length) newlyStale.push(proposal);
    }
    proposals = await settleStaleBatch(newlyStale, proposals);
    return proposals.filter((proposal) => matches(proposal, filter));
  };

  const controller: ProposalStoreController = {
    async create(input) {
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
      return stored;
    },
    settle,
    bind(value) {
      bindings = value;
    },
  };

  const performAdoptOne = async (id: string, groupRestorePointId?: string): Promise<Proposal> => {
    const proposal = (await fold()).find((candidate) => candidate.id === id);
    if (!proposal) throw new Error(`Unknown proposal: ${id}`);
    if (proposal.status !== "proposed") return proposal;
    if (!bindings) throw new Error("Proposal adoption is not configured");
    if ((await staleEntries(proposal)).length) return performSettlement(id, { status: "stale" });
    const individualRestorePointId = groupRestorePointId === undefined
      ? await options.snapshots?.beginRestorePoint(
        `proposal adoption: ${id}`,
        proposal.sessionId,
        { proposalId: id },
      )
      : undefined;
    const restorePointId = groupRestorePointId ?? individualRestorePointId;
    const execution = await bindings.adopt(proposal);
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
      });
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
      const written = new Map<string, string>();
      // Accepted residual: a third writer between the sibling write and this hash
      // capture can be misattributed. The blast radius is a wrong sibling label
      // plus a missed stop, never an incorrect write by Bridle.
      for (const path of new Set(execution.touchedPaths ?? [])) {
        written.set(path, await contentHashOf(path));
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

  const adoptOne = (id: string, groupRestorePointId?: string): Promise<Proposal> => {
    const existing = inFlightClaims.get(id);
    if (existing) return existing.promise;
    const adoption = performAdoptOne(id, groupRestorePointId).finally(() => {
      if (inFlightClaims.get(id)?.promise === adoption) inFlightClaims.delete(id);
    });
    inFlightClaims.set(id, { kind: "adoption", promise: adoption });
    return adoption;
  };

  const store: ProposalStore = {
    list,
    async get(id) {
      return (await list()).find((proposal) => proposal.id === id);
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
      const restorePointId = await options.snapshots?.beginRestorePoint(`group adoption: ${groupId}`, members[0]?.sessionId ?? groupId) ?? "";
      const adopted: string[] = [];
      const outcomes: AdoptGroupResult["outcomes"] = [];
      const freshAtStart = new Set(members.filter((member) => member.status === "proposed").map((member) => member.id));
      const adoptedSiblingHashes = new Map<string, string>();
      for (const member of members) {
        let current = (await fold()).find((candidate) => candidate.id === member.id);
        const mismatches = current ? await staleEntries(current) : [];
        if (current?.status === "proposed" && mismatches.length) {
          const explainedBySibling = current.allowSiblings && freshAtStart.has(current.id)
            && mismatches.every((entry) => adoptedSiblingHashes.get(entry.path) === entry.currentHash);
          if (explainedBySibling) {
            const siblingSettlement = await settle(current.id, {
              status: "superseded",
              settlementReason: "superseded-by-sibling",
            });
            if (siblingSettlement.refused) {
              outcomes.push({
                id: siblingSettlement.id,
                status: siblingSettlement.status,
                refused: siblingSettlement.refused,
              });
              continue;
            }
            outcomes.push({
              id: siblingSettlement.id,
              status: siblingSettlement.status,
              settlementReason: "superseded-by-sibling",
            });
            continue;
          }
          const staleSettlement = await settle(current.id, { status: "stale" });
          if (staleSettlement.refused) {
            outcomes.push({
              id: staleSettlement.id,
              status: staleSettlement.status,
              refused: staleSettlement.refused,
            });
            return {
              adopted,
              outcomes,
              stopped: { id: member.id, reason: "stale" },
              restorePointId,
            };
          }
          current = staleSettlement;
        }
        if (current?.status === "stale") {
          outcomes.push({ id: current.id, status: "stale" });
          return { adopted, outcomes, stopped: { id: member.id, reason: "stale" }, restorePointId };
        }
        if (current?.status !== "proposed") continue;
        const settled = await adoptOne(member.id, restorePointId);
        if (settled.status !== "proposed") {
          outcomes.push({
            id: settled.id,
            status: settled.status,
            ...(settled.settlementReason ? { settlementReason: settled.settlementReason } : {}),
          });
        }
        if (settled.status === "adopted") {
          adopted.push(member.id);
          if (member.allowSiblings) {
            for (const [path, writtenHash] of groupAdoptionWriteHashes.get(member.id) ?? []) {
              adoptedSiblingHashes.set(path, writtenHash);
            }
          }
        }
        groupAdoptionWriteHashes.delete(member.id);
        if (settled.status === "proposed" && settled.outcome?.isError) {
          return { adopted, outcomes, stopped: { id: member.id, reason: "error" }, restorePointId };
        }
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

  return { store, controller };
}
