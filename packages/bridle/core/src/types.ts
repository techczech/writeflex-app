import type { TSchema } from "typebox";

export type ToolRisk = "read" | "write" | "sync" | "destructive";
export type BridleLane = "live" | "mock";

export type ApprovalDenialReason = {
  /** Stable host-defined code for UI and audit handling. */
  code: string;
  /** Exact model-facing denial text. */
  message: string;
};

export type StageValidationResult =
  | { decision: "pass" }
  | { decision: "deny"; reason: ApprovalDenialReason };

export type AgentTrigger = {
  id: string;
  source: "user" | "app" | "schedule" | "system";
  trust: "interactive" | "trusted_app" | "background";
  label?: string;
};

export type AuditEvent = {
  type: string;
  timestamp: number;
  sessionId: string;
  /** The sealed Bridle instance lane that produced this evidence. */
  lane?: BridleLane;
  turnId?: string;
  capability?: string;
  risk?: ToolRisk;
  toolCallId?: string;
  attemptId?: string;
  message?: string;
  input?: unknown;
  resultText?: string;
  resultIsError?: boolean;
  prompt?: string;
  trigger?: AgentTrigger;
  receipt?: unknown;
  metadata?: Record<string, unknown>;
};

export type AuditLog = {
  record(event: AuditEvent): void | Promise<void>;
};

export type TraceEvent = {
  id: string;
  type: string;
  timestamp: number;
  title: string;
  summary?: string;
  metadata?: Record<string, unknown>;
};

export type CapabilityContext = {
  trigger: AgentTrigger;
  sessionId: string;
  /**
   * Stable executor-owned identity only when this call is protected by the
   * execution journal. It is absent on direct capability invocations that do
   * not own durable journal identity and must not be synthesised for provider
   * deduplication.
   */
  attemptId?: string;
  /** Stable provider idempotency identity when attemptId is present. */
  idempotencyKey?: string;
  /**
   * The executor-owned, frozen path evidence for this call. It is always
   * present for write and destructive capabilities, including as an empty
   * array when snapshotless execution legitimately skips discovery. A
   * capability that derives its write targets from workspace state must write
   * exactly this set instead of resolving the workspace again in execute().
   */
  resolvedTouchedPaths?: readonly string[];
  signal?: AbortSignal;
  audit: (event: Omit<AuditEvent, "timestamp" | "sessionId">) => void;
};

export type CapabilityResult<TOutput = unknown> = {
  text: string;
  details?: TOutput;
  isError?: boolean;
  /** Executor-only. Values returned by a Capability are ignored; the executor
   * derives and relays denial reasons from its own policy or validation state. */
  denialReason?: ApprovalDenialReason;
  remoteOutcome?: RemoteExecutionOutcome;
};

export type RemoteExecutionOutcome =
  | { state: "accepted"; system: string; transactionId: string; requestId?: string }
  | { state: "completed"; system: string; transactionId: string; remoteId?: string; requestId?: string }
  | { state: "rejected"; system: string; transactionId: string; code: string; requestId?: string }
  | { state: "unknown"; system: string; transactionId: string; requestId?: string };

/**
 * A reversal step for a structural (rename/create/delete) operation whose undo
 * cannot be a content rewind (ADR-0028 typed-ops path). Recorded into the turn's
 * restore point after a successful op; applied in reverse by `restoreTo`.
 * - `rename`: move `from` back to `to` (undoes a move, or a move-to-trash delete)
 * - `remove`: delete `path` (undoes a folder/file creation) — never follows into it
 */
export type UndoAction =
  | { do: "rename"; from: string; to: string }
  | { do: "remove"; path: string };

export type Capability<TInput = any, TOutput = unknown> = {
  /** lower-case dotted name, e.g. "markdown.write_file" */
  name: string;
  label?: string;
  description: string;
  risk: ToolRisk;
  /** TypeBox schema handed to Pi verbatim */
  parameters: TSchema;
  /** Human-readable title source for approval cards and staged Proposals. */
  preview?: (input: TInput) => string | Promise<string>;
  /**
   * Validate a call only when policy stages it, before Proposal creation or
   * approval UI. Adoption does not call this hook again: baseline comparison
   * guards declared touchedPaths, while an Action Proposal without touchedPaths
   * must perform any execution-time validation inside execute().
   */
  validateStage?: (input: TInput) => StageValidationResult | Promise<StageValidationResult>;
  /** Maximum validation wait; defaults to 5,000 ms. */
  stageValidationTimeoutMs?: number;
  /** Host-declared Proposal semantics. Change is opt-in; Action is the default. */
  proposalKind?: "change" | "action";
  /** Keep same-capability, same-primary-path Proposals as reviewable alternatives. */
  allowSiblingProposals?: boolean;
  /** Declared network destination class for Action Proposal previews. */
  egress?: "none" | "loopback" | "remote";
  /** Exact resulting content for Change Proposal preview derivation. */
  renderChange?: (input: TInput) => { path: string; after: string }[];
  /** Exact proposed file operations for Change Proposal preview derivation. */
  renderOps?: (input: TInput) => { op: "create" | "modify" | "delete" | "rename"; path: string; toPath?: string }[];
  /**
   * Absolute paths a call may modify — REQUIRED for write/destructive snapshot
   * targets. Core may invoke this resolver during staging, Adoption, and every
   * Proposal preview render. It must therefore be side-effect-free, cheap, and
   * tolerant of repeated invocation; render-time calls add a per-render cost.
   * Adoption accepts a shrunken set, but any newly resolved path absent from the
   * staged baseline makes the Proposal stale before execution.
   */
  touchedPaths?: (input: TInput) => string[] | Promise<string[]>;
  /**
   * Deterministic reversal steps for a structural op whose undo is not a content
   * rewind (a folder move/delete/create). Declared from input (like touchedPaths),
   * host-side; the executor records them into the restore point AFTER the op
   * succeeds, and `restoreTo` applies them in reverse. Absolute paths.
   */
  renderUndo?: (input: TInput) => UndoAction[];
  execute: (input: TInput, ctx: CapabilityContext) => Promise<CapabilityResult<TOutput>>;
  undo?: (details: TOutput, ctx: CapabilityContext) => void | Promise<void>;
};

export type ManifestDefinition = {
  appId: string;
  /** Absolute path; when set, generated system prompt scopes the agent's world to it */
  workspaceRoot?: string;
  capabilities: Capability[];
  /** Named read-risk Capability used to resolve file and image Context Items. */
  contextReader?: string;
  /** Prepended to the generated system prompt */
  systemPromptPreamble?: string;
  /**
   * ADR-0025: the generated prompt carries a minimal plan-first / ask-when-unsure
   * working-guidance layer by default. Set true only for an app that genuinely
   * wants bare tool mechanics.
   */
  omitWorkingGuidance?: boolean;
};

export type Manifest = Readonly<ManifestDefinition> & { readonly validated: true };

export type ApprovalDecision =
  | "allow"
  | "deny"
  | "stage"
  | "ask"
  | { decision: "deny"; reason?: ApprovalDenialReason };

export type ApprovalPolicy = (call: {
  capability: Pick<Capability, "name" | "risk">;
  input: unknown;
  trigger: AgentTrigger;
}) => ApprovalDecision | Promise<ApprovalDecision>;

export type ApprovalRequest = {
  id: string;
  capabilityName: string;
  risk: ToolRisk;
  input: unknown;
  preview?: string;
  requestedAt: number;
};
