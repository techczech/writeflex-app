import type {
  AdoptGroupResult,
  ApprovalRequest,
  BridleLane,
  BridleEvent,
  ContextItem,
  Proposal,
  ProposalFilter,
  ProposalPreview,
  ProposalSettlementResult,
  TurnId,
  TurnReceipt,
} from "@bridle/core";
import type { AuthTransport, AuthUiEvent } from "./contract.ts";

export type BridleEventGapReason = "tail-truncated" | "delivery-failed";
export type BridleEventResetReason = "epoch-reset" | "sequence-reset";
export type BridleEventCursor = { epoch: string; seq: number };
export type SyntheticApprovalSettlementEvent = {
  id: string;
  timestamp: number;
  type: "approval_settled";
  turnId: null;
  requestId: string;
  decision: "allow" | "deny";
  synthetic: true;
};
export type BridleBridgeEvent = BridleEvent | SyntheticApprovalSettlementEvent;
export type BridleEventFrame =
  | { kind: "event"; epoch: string; seq: number; event: BridleBridgeEvent }
  /** A gap means events were genuinely unavailable to this subscriber. */
  | { kind: "gap"; epoch: string; fromSeq: number; toSeq: number; reason: BridleEventGapReason }
  /** A reset is informational: the following replay is the complete current tail. */
  | { kind: "reset"; epoch: string; fromSeq: number; toSeq: number; reason: BridleEventResetReason }
  | { kind: "disconnect"; epoch: string; reason: "delivery-failed"; lastDeliveredSeq: number }
  | { kind: "error"; message: string; recoverable: true };

export type ApprovalResponseResult =
  | { outcome: "settled"; decision: "approved" | "denied" }
  | { outcome: "refused"; decision: "denied" }
  | { outcome: "expired" }
  | { outcome: "unknown-id" }
  | { outcome: "unknown"; retryable: true; reason: "timeout" | "transport-error" };

export type BridleTransportOptions = {
  /** Maximum time to wait for an approval response invoke before the card becomes retryable. */
  approvalResponseTimeoutMs?: number;
};

export type BridleChannels = ReturnType<typeof bridleChannels>;

export function bridleChannels(namespace = "bridle") {
  return {
    prompt: `${namespace}.agent:prompt`,
    abort: `${namespace}.agent:abort`,
    lane: `${namespace}.agent:lane`,
    eventSubscribe: `${namespace}.events:subscribe`,
    eventUnsubscribe: `${namespace}.events:unsubscribe`,
    event: `${namespace}.events:event`,
    approvalsPending: `${namespace}.approvals:pending`,
    approvalsRespond: `${namespace}.approvals:respond`,
    proposalsList: `${namespace}.proposals:list`,
    proposalsPreview: `${namespace}.proposals:preview`,
    proposalsAdopt: `${namespace}.proposals:adopt`,
    proposalsReject: `${namespace}.proposals:reject`,
    proposalsAdoptGroup: `${namespace}.proposals:adopt-group`,
    proposalsDismissAll: `${namespace}.proposals:dismiss-all`,
    proposalsSubscribe: `${namespace}.proposals:subscribe`,
    proposalsUnsubscribe: `${namespace}.proposals:unsubscribe`,
    proposalsChanged: `${namespace}.proposals:changed`,
    auth: {
      providers: `${namespace}.auth:providers`,
      login: `${namespace}.auth:login`,
      cancel: `${namespace}.auth:cancel`,
      respond: `${namespace}.auth:respond`,
      setApiKey: `${namespace}.auth:set-api-key`,
      logout: `${namespace}.auth:logout`,
      event: `${namespace}.auth:event`,
    },
  } as const;
}

export type BridleTransport = {
  lane(): Promise<BridleLane>;
  prompt(text: string, context?: ContextItem[]): Promise<TurnReceipt>;
  abort(turnId: TurnId): Promise<boolean>;
  events: {
    /** The cursor names the registration epoch and last sequence number already received. */
    subscribe(listener: (frame: BridleEventFrame) => void, cursor?: BridleEventCursor | number): () => void;
  };
  approvals: {
    pending(): Promise<ApprovalRequest[]>;
    respond(id: string, approved: boolean): Promise<ApprovalResponseResult>;
  };
  proposals: {
    list(filter?: ProposalFilter): Promise<Proposal[]>;
    preview(id: string): Promise<ProposalPreview>;
    adopt(id: string): Promise<Proposal>;
    reject(id: string): Promise<ProposalSettlementResult>;
    adoptGroup(groupId: string): Promise<AdoptGroupResult>;
    dismissAll(filter?: ProposalFilter): Promise<ProposalSettlementResult[]>;
    subscribe(listener: (proposals: Proposal[]) => void): () => void;
  };
  auth: AuthTransport;
};

export type NamespacedAuthEvent = AuthUiEvent;
