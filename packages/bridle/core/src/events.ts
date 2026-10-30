import { randomUUID } from "node:crypto";
import type {
  ActionOutcome,
  Proposal,
  ProposalKind,
  ProposalSettler,
  ProposalSettlementReason,
  ProposalStatus,
} from "./proposals/types.ts";
import type { AgentTrigger, ApprovalDenialReason, ApprovalRequest, BridleLane, ToolRisk, TraceEvent } from "./types.ts";

export type TurnId = string;
export type TurnEndReason = "provider-error" | "auth" | "network" | "aborted" | "tool-error" | "truncated" | "no-answer" | "no-text" | "checkpoint-failed";
/** @deprecated Use TurnEndReason; successful turns can carry a reason too. */
export type TurnFailureReason = TurnEndReason;
export type TurnAuthLane = "oauth" | "apikey" | "env" | "none";
export type TurnResponder = {
  providerId: string;
  modelId: string;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  authLane: TurnAuthLane;
};
export type TurnOutcome = "completed" | "aborted" | "error";

export type EgressSummary = {
  providerId: string;
  modelId: string;
  egressClass: "remote";
  dataSent: { contextItems: number; filesReadCount: number; promptChars: number };
};

export type TurnUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
};

export type TurnToolError = { capability?: string; toolCallId?: string; message: string };

export type TurnReceipt = {
  turnId: TurnId;
  lane: BridleLane;
  outcome: TurnOutcome;
  /** Present on all newly recorded turns; optional for pre-0.15 receipts. */
  responder?: TurnResponder;
  reason?: TurnEndReason;
  /** Reasoning level captured when this turn began. */
  thinkingLevel: "minimal" | "low" | "medium" | "high";
  filesRead: string[];
  filesWritten: string[];
  callsDenied: number;
  callsStaged: number;
  usage?: TurnUsage;
  toolErrors?: TurnToolError[];
  writesAfterStop?: string[];
  capabilitiesAfterStop?: string[];
  truncated?: boolean;
  egress: EgressSummary;
  durationMs: number;
};

export type TurnResult = {
  turnId: TurnId;
  outcome: TurnOutcome;
  reason?: TurnEndReason;
  answerText: string;
  receipt: TurnReceipt;
};

export type ContextItem = {
  kind: "text" | "file" | "image";
  label: string;
  content?: string;
  path?: string;
  raw?: boolean;
  transcript: "hidden" | "visible";
};

export type BridleEventPayload =
  | { type: "turn.activity"; turnId: TurnId; activity: import("./turns.ts").TurnActivity }
  | { type: "turn_start"; turnId: TurnId; lane: BridleLane; trigger: AgentTrigger; promptPreview: string; activeSkillId?: string }
  | { type: "assistant_delta"; turnId: TurnId; text: string }
  | { type: "assistant_message"; turnId: TurnId; text: string }
  | { type: "thinking_summary"; turnId: TurnId; summary: string }
  | { type: "tool_start"; turnId: TurnId; toolCallId: string; capability: string; risk: ToolRisk; inputPreview: string; paths?: readonly string[] }
  | { type: "tool_end"; turnId: TurnId; toolCallId: string; capability: string; risk: ToolRisk; result: "ok" | "error" | "denied" | "staged"; message?: string; denialReason?: ApprovalDenialReason; paths?: readonly string[] }
  | { type: "approval_requested"; turnId: TurnId; request: ApprovalRequest }
  | { type: "approval_settled"; turnId: TurnId; requestId: string; decision: "allow" | "deny" }
  | { type: "proposal_created"; turnId: TurnId; proposalId: string; groupId: string; capability: string; kind: ProposalKind }
  | { type: "proposal_attempted"; turnId: TurnId; proposalId: string; proposal: Proposal; outcome: ActionOutcome }
  | { type: "proposal_settled"; turnId: TurnId; proposalId: string; status: Exclude<ProposalStatus, "proposed">; settledBy?: ProposalSettler; settlementReason?: ProposalSettlementReason }
  /** `proposalId` is the caller's, or one this handle's Proposal store confirms for the Restore Point.
   *  `untrustedSource` is what the snapshot journal says of the Restore Point: a claim, never attribution. */
  | { type: "restore"; restorePointId: string; proposalId?: string; paths: string[]; untrustedSource?: { sessionId: string; proposalId?: string } }
  | { type: "compaction"; turnId?: TurnId; tokensBefore: number; summaryPreview: string }
  | { type: "turn_end"; turnId: TurnId; receipt: TurnReceipt }
  | { type: "turn_error"; turnId: TurnId; message: string; recoverable: boolean };

export type BridleEvent = BridleEventPayload & { id: string; timestamp: number };
export type BridleEventListener = (event: BridleEvent) => void;

export class BridleEventEmitter {
  readonly #listeners = new Set<BridleEventListener>();
  readonly #trace?: (event: Omit<TraceEvent, "id" | "timestamp">) => void;

  constructor(trace?: (event: Omit<TraceEvent, "id" | "timestamp">) => void) {
    this.#trace = trace;
  }

  subscribe(listener: BridleEventListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  emit(payload: BridleEventPayload): BridleEvent {
    const event = { ...payload, id: randomUUID(), timestamp: Date.now() } as BridleEvent;
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#trace?.({
          type: "events.listener_error",
          title: "Bridle event listener failed",
          metadata: { eventType: event.type, message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    return event;
  }
}
