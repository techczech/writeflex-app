import type { BridleLane, ToolRisk } from "../types.ts";

export type ProposalKind = "change" | "action";
export type ProposalStatus = "proposed" | "adopted" | "rejected" | "stale" | "superseded";
export type ProposalBaseline = { path: string; hash: string };
export type ProposalSettler = "user" | "policy" | "agent" | "host";
export const UNPREVIEWED_TOUCHED_PATH_REASON = "unpreviewed-touched-path";
export type CoreProposalSettlementReason = typeof UNPREVIEWED_TOUCHED_PATH_REASON;
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
};

/**
 * A settlement call returns the current Proposal plus this marker when it
 * cannot take the proposal's exactly-once claim. An Adoption claim refuses
 * immediately. A concurrent settlement loser waits for the winner, receives
 * the winning Proposal, and is marked so it can distinguish losing the claim.
 */
export type ProposalSettlementResult = Proposal & {
  refused?: "adoption-in-flight" | "already-settled";
};

export type ProposalFilter = Partial<
  Pick<Proposal, "lane" | "status" | "kind" | "groupId" | "capability" | "sessionId" | "turnId">
>;

export type ProposalPreview =
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
    };

export type AdoptGroupResult = {
  adopted: string[];
  outcomes: {
    id: string;
    status: ProposalStatus;
    settlementReason?: ProposalSettlementReason;
    refused?: NonNullable<ProposalSettlementResult["refused"]>;
  }[];
  stopped?: { id: string; reason: "stale" | "error" };
  restorePointId: string;
};

export interface ProposalStore {
  list(filter?: ProposalFilter): Promise<Proposal[]>;
  get(id: string): Promise<Proposal | undefined>;
  adopt(id: string): Promise<Proposal>;
  reject(id: string, by?: ProposalSettler): Promise<ProposalSettlementResult>;
  settleAsHost(id: string, settlement: HostProposalSettlement): Promise<ProposalSettlementResult>;
  adoptGroup(groupId: string): Promise<AdoptGroupResult>;
  /** Returns one result per attempted dismissal. Count dismissed Proposals by
   * filtering out results with a `refused` marker. */
  dismissAll(filter?: ProposalFilter): Promise<ProposalSettlementResult[]>;
  preview(id: string): Promise<ProposalPreview>;
  subscribe(fn: (proposals: Proposal[]) => void): () => void;
}
