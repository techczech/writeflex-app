import type { BridleLane, ToolRisk } from "../types.ts";

export type ProposalStoreState =
  | { status: "writable"; renewing?: true }
  | { status: "read-only"; reason: "store-locked" | "store-in-use-in-process" | "lease-lost" };

export type ProposalKind = "change" | "action";
export type ProposalStatus = "proposed" | "adopted" | "rejected" | "stale" | "superseded";
export type DirectoryBaselineEntry = {
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  hash: string;
  mode?: number;
};
export type DirectoryMetadataEntry = {
  path: string;
  kind: DirectoryBaselineEntry["kind"];
  size: number;
  mtimeMs: number;
  mode: number;
  ino: number;
  dev: number;
  ctimeMs: number;
  linkTarget?: string;
};
export type DirectoryBaseline =
  | {
      baseline: "complete";
      /** Absent in previously stored content records. */
      tier?: "content";
      /** Bounded preview only; hash and entryCount describe the entire folder. */
      entries: DirectoryBaselineEntry[];
      entryCount?: number;
      bytes?: number;
    }
  | {
      baseline: "complete";
      tier: "metadata";
      /** Bounded preview only; hash and entryCount describe the entire folder. */
      entries: DirectoryMetadataEntry[];
      entryCount: number;
      bytes: number;
    }
  | {
      /** Legacy overflow records need fresh consent; new oversized captures refuse. */
      baseline: "too-large";
      entryCount: number;
      bytes: number;
      entries?: never;
    };
export type ProposalBaseline = { path: string; hash: string; directory?: DirectoryBaseline };
export type ProposalSettler = "user" | "policy" | "agent" | "host";
export const UNPREVIEWED_TOUCHED_PATH_REASON = "unpreviewed-touched-path";
export type CoreProposalSettlementReason = typeof UNPREVIEWED_TOUCHED_PATH_REASON | "aborted" | "corrupt-journal" | "interrupted" | "attempt-failed" | "outcome-unknown";
export type HostProposalSettlementReason = "superseded-by-host";
export type ProposalSettlementReason =
  | HostProposalSettlementReason
  | "superseded-by-sibling"
  | CoreProposalSettlementReason;
export type HostProposalSettlement = {
  status: "rejected" | "superseded";
  reason: HostProposalSettlementReason;
};

export type ActionOutcome = {
  at: string;
  resultText: string;
  isError: boolean;
  auditRef?: string;
};

export type Proposal<TPayload = unknown> = {
  id: string;
  /** Records written before 0.10.0 are labelled legacy when folded. */
  lane: BridleLane | "legacy";
  kind: ProposalKind;
  sessionId: string;
  turnId: string;
  toolCallId?: string;
  groupId: string;
  capability: string;
  risk: ToolRisk;
  title: string;
  payload: TPayload;
  baseline?: ProposalBaseline[];
  allowSiblings?: boolean;
  supplements?: { markdown: string; source: "host-rendered" | "agent-authored" }[];
  status: ProposalStatus;
  outcome?: ActionOutcome;
  restorePointId?: string;
  supersedes?: string;
  /** True when create could not itself supersede its target. When supersededBy
   * is absent, this deliberately conflates an in-flight Adoption with an
   * already-completed competing supersession that was not discoverable. */
  supersedeRefused?: true;
  /** The competing Proposal that superseded this create's target, when a re-fold can identify it. */
  supersededBy?: string;
  createdAt: string;
  settledAt?: string;
  settledBy?: ProposalSettler;
  settlementReason?: ProposalSettlementReason;
  mayHaveApplied?: true;
};

/**
 * A settlement call returns the current Proposal plus this marker when it
 * cannot take the proposal's exactly-once claim. An Adoption claim refuses
 * immediately. A concurrent settlement loser waits for the winner, receives
 * the winning Proposal, and is marked so it can distinguish losing the claim.
 */
export type ProposalSettlementResult = Proposal & {
  refused?: "adoption-in-flight" | "already-settled" | "store-locked";
  /** Refusal cause; interrupted shutdown results may exist only in memory. */
  refusalReason?: Extract<ProposalStoreState, { status: "read-only" }>["reason"] | "fenced-write";
};

export type ProposalFilter = Partial<
  Pick<Proposal, "lane" | "status" | "kind" | "groupId" | "capability" | "sessionId" | "turnId">
>;

export type ProposalPreview = (
  | { kind: "text-diff"; before: string; after: string; stale: boolean }
  | { kind: "file-ops"; ops: { op: "create" | "modify" | "delete" | "rename"; path: string; toPath?: string }[]; inferred: boolean; stale: boolean }
  | {
      kind: "invocation";
      capability: string;
      description: string;
      input: unknown;
      risk: ToolRisk;
      egress: "none" | "loopback" | "remote";
      reversible: boolean;
      stale: boolean;
    }) & { directories?: (DirectoryBaseline & { path: string; message?: string })[] };

export type AdoptGroupResult = {
  adopted: string[];
  outcomes: {
    id: string;
    status: ProposalStatus;
    settlementReason?: ProposalSettlementReason;
    refused?: NonNullable<ProposalSettlementResult["refused"]>;
    refusalReason?: NonNullable<ProposalSettlementResult["refusalReason"]>;
  }[];
  stopped?: { id: string; reason: "stale" | "error" | "store-locked" | "conflict" };
  restorePointId: string;
};

export interface ProposalStore {
  list(filter?: ProposalFilter): Promise<Proposal[]>;
  get(id: string): Promise<Proposal | undefined>;
  /** Explicitly re-verify a proposal against disk. Optional on older adapters.
   * Folder list/preview calls show stored state; Adoption always rechecks. */
  recheck?(id: string): Promise<ProposalSettlementResult>;
  adopt(id: string): Promise<ProposalSettlementResult>;
  reject(id: string, by?: ProposalSettler): Promise<ProposalSettlementResult>;
  settleAsHost(id: string, settlement: HostProposalSettlement): Promise<ProposalSettlementResult>;
  adoptGroup(groupId: string): Promise<AdoptGroupResult>;
  /** Returns one result per attempted dismissal. Count dismissed Proposals by
   * filtering out results with a `refused` marker. */
  dismissAll(filter?: ProposalFilter): Promise<ProposalSettlementResult[]>;
  preview(id: string): Promise<ProposalPreview>;
  subscribe(fn: (proposals: Proposal[]) => void): () => void;
}
