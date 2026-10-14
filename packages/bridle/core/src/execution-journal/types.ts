import type {
  BridleLane,
  CapabilityResult,
  RemoteExecutionOutcome,
  ToolRisk,
} from "../types.ts";

export type ExecutionRecordType = "header" | "registered" | "intent" | "outcome" | "identity-conflict";

export type ExecutionJournalFaults = {
  beforeAppend?: (type: ExecutionRecordType) => void | Promise<void>;
  afterAppend?: (type: ExecutionRecordType) => void | Promise<void>;
  beforeSync?: (type: ExecutionRecordType) => void | Promise<void>;
  afterSync?: (type: ExecutionRecordType) => void | Promise<void>;
};

export type ExecutionRequest = {
  lane: BridleLane;
  originKey: string;
  capability: string;
  risk: ToolRisk;
  egress: "none" | "loopback" | "remote";
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  proposalId?: string;
  groupId?: string;
  remoteTransactionId?: string;
  input: unknown;
};

export type ExecutionIntentFacts = {
  policy: "allow";
  checkpointId?: string;
};

export type ExecutionOutcomeDisposition =
  | "returned"
  | "threw"
  | "refused"
  | "staged"
  | "stale"
  | "precondition-failed"
  | "unknown";

export type ExecutionClassification = Readonly<{
  relay: "ok" | "error" | "denied" | "staged";
  denied: boolean;
  aborted?: boolean;
  stale?: boolean;
}>;

export type ExecutionOutcome = {
  disposition: ExecutionOutcomeDisposition;
  result: CapabilityResult;
  remoteOutcome?: RemoteExecutionOutcome;
  /** Executor classification persisted for observationally equivalent replay. */
  classification?: ExecutionClassification;
};

export type ExecutionAttempt = Readonly<{
  attemptId: string;
  appId: string;
  lane: BridleLane;
  originKey: string;
  requestFingerprint: string;
  capability: string;
  risk: ToolRisk;
  egress: "none" | "loopback" | "remote";
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  proposalId?: string;
  groupId?: string;
  idempotencyKey: string;
  remoteTransactionId?: string;
  registeredAt: string;
  intent?: Readonly<ExecutionIntentFacts & { at: string }>;
  outcome?: Readonly<ExecutionOutcome & { at: string }>;
}>;

export type UnknownExecution = Readonly<{
  attemptId: string;
  capability: string;
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  proposalId?: string;
  groupId?: string;
  firstIntentAt: string;
  idempotencyKey: string;
  remoteTransactionId?: string;
  warning: string;
}>;

export type ExecutionFilter = {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  proposalId?: string;
};

export function unknownExecutionResult(capability: string, attemptId: string): CapabilityResult {
  return {
    text: `Unknown outcome: ${capability} may have completed before the previous process stopped. Bridle will not run attempt ${attemptId} again automatically. Verify the external state or ask the user before creating a new attempt.`,
    isError: true,
  };
}

export type ExecutionDisposition =
  | { state: "new"; attempt: ExecutionAttempt }
  | { state: "registered"; attempt: ExecutionAttempt }
  | { state: "replay"; attempt: ExecutionAttempt; result: CapabilityResult }
  | { state: "unknown"; attempt: ExecutionAttempt; result: CapabilityResult }
  | { state: "identity-conflict"; attemptId: string; result: CapabilityResult };

export interface ExecutionJournal {
  register(request: ExecutionRequest): Promise<ExecutionDisposition>;
  recordIntent(attemptId: string, facts: ExecutionIntentFacts): Promise<void>;
  recordOutcome(attemptId: string, outcome: ExecutionOutcome): Promise<void>;
  get(attemptId: string): Promise<ExecutionAttempt | undefined>;
  unknown(filter?: ExecutionFilter): Promise<readonly UnknownExecution[]>;
  /** Releases this caller's reference to the shared, long-lived journal handle. */
  close(): Promise<void>;
}

export type OpenExecutionJournalOptions = {
  appDataDir: string;
  appId: string;
  workspaceRoot?: string;
  faults?: ExecutionJournalFaults;
};
