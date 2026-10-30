import { callAsks } from "./capability-asks.ts";
import type { ApprovalBroker } from "./approval.ts";
import type { SnapshotStore } from "./snapshots.ts";
import { randomUUID } from "node:crypto";
import { baselineHash, baselineNeedsFolderConsent, captureBaseline, contentHashOf, FolderTooLargeError, metadataBaselineNotice, APPROVAL_LISTING_MAX_ENTRIES } from "./hashing.ts";
import { lstatSync } from "node:fs";
import { physicalWorkspacePath } from "./workspace-containment.ts";
import { modeApprovalDecision } from "./policy.ts";
import { captureTurnPaths } from "./turn-paths.ts";
import type { ProposalStoreController } from "./proposals/store.ts";
import { UNPREVIEWED_TOUCHED_PATH_REASON, type CoreProposalSettlementReason, type ProposalBaseline } from "./proposals/types.ts";
import { unknownExecutionResult, type ExecutionClassification, type ExecutionJournal, type ExecutionOutcomeDisposition } from "./execution-journal/index.ts";
import type {
  AgentTrigger, ApprovalDecision, ApprovalDenialReason, ApprovalPolicy, AuditEvent, AuditLog,
  BridleLane, BridleMode, Capability, CapabilityResult, StageValidationResult, TraceEvent,
} from "./types.ts";

const DEFAULT_STAGE_VALIDATION_TIMEOUT_MS = 5_000;
export { APPROVAL_LISTING_MAX_ENTRIES } from "./hashing.ts";

export type ExecutorDeps = {
  lane: BridleLane;
  mode?: () => BridleMode;
  workspaceRoot?: string;
  activity?: (cap: Capability, input: unknown, ctx: ExecutorCallContext, paths: readonly string[], before: Map<string, string>, snapshotIds: string[], succeeded: boolean) => Promise<void>;
  activeTurn?: () => { turnId: string; signal: AbortSignal } | undefined;
  onExecution?: (event: { turnId?: string; toolCallId?: string; capability: string; risk: Capability["risk"]; paths: readonly string[]; afterStop: boolean; phase: "start" | "end"; succeeded?: boolean }) => void;
  policy: ApprovalPolicy;
  broker: ApprovalBroker;
  proposals?: ProposalStoreController;
  snapshots: SnapshotStore | null;
  audit: AuditLog;
  trace: (e: Omit<TraceEvent, "id" | "timestamp">) => void;
  executionJournal?: ExecutionJournal;
  versioning?: {
    takeCheckpoint(options: {
      origin: "pre-write";
      capability: string;
      toolCallId?: string;
      sessionId: string;
      turnId?: string;
      attemptId?: string;
    }): Promise<{ id: string }>;
  };
  /** Test seam for deterministic adoption-boundary race coverage. */
  beforeAdoptionExecute?: () => void | Promise<void>;
};

export type ExecutorCallContext = {
  trigger: AgentTrigger;
  sessionId: string;
  turnId?: string;
  signal?: AbortSignal;
  toolCallId?: string;
  /**
   * Permanent one-shot idempotency claim supplied by an exported executor
   * caller. Reusing a key replays its first result forever, or permanently
   * conflicts when the input changes. Without a key, each call receives an
   * ephemeral identity that cannot correlate a separately constructed retry.
   */
  executionKey?: string;
  /** Runtime-adapter classification for this individual tool-call response. */
  toolCallIdentity?: "verified-unique" | "untrusted";
  adoption?: true;
  proposalId?: string;
  proposalBaseline?: ProposalBaseline[];
  /** Fresh consent baseline, also checked after checkpoint/snapshot preparation. */
  approvalBaseline?: ProposalBaseline[];
  /** Runtime relay pre-resolution for this tool call; avoids rediscovering paths during staging. */
  touchedPathsResolution?: readonly string[] | Promise<readonly string[]>;
};

export function freezeTouchedPaths(paths: readonly string[]): readonly string[] {
  return Object.freeze([...paths]);
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

function ensureFrozenTouchedPaths(paths: readonly string[]): readonly string[] {
  return Object.isFrozen(paths) ? paths : freezeTouchedPaths(paths);
}

async function renderPreview(cap: Capability, input: unknown): Promise<string | undefined> {
  try {
    return cap.preview ? await cap.preview(input) : undefined;
  } catch {
    return undefined;
  }
}

function decisionKind(decision: ApprovalDecision): "allow" | "deny" | "stage" | "ask" | undefined {
  if (typeof decision === "string") {
    return decision === "allow" || decision === "deny" || decision === "stage" || decision === "ask"
      ? decision
      : undefined;
  }
  return decision?.decision === "deny" ? "deny" : undefined;
}

function denialReason(decision: ApprovalDecision): ApprovalDenialReason | undefined {
  if (typeof decision !== "object" || decision?.decision !== "deny") return undefined;
  const reason = decision.reason;
  return reason && typeof reason.code === "string" && typeof reason.message === "string"
    ? reason
    : undefined;
}

async function validateStagedCall(
  cap: Capability,
  input: unknown,
  timeoutMs: number,
): Promise<StageValidationResult> {
  if (!cap.validateStage) return { decision: "pass" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(cap.validateStage(input)),
      new Promise<StageValidationResult>((resolve) => {
        timer = setTimeout(() => resolve({
          decision: "deny",
          reason: {
            code: "stage-validation-timeout",
            message: `Call to ${cap.name} was denied because stage validation did not complete within ${timeoutMs} ms.`,
          },
        }), timeoutMs);
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      decision: "deny",
      reason: {
        code: "stage-validation-failed",
        message: `Call to ${cap.name} was denied because stage validation failed: ${message}`,
      },
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function baselineFor(paths: readonly string[] | undefined): Promise<ProposalBaseline[] | undefined> {
  if (!paths?.length) return undefined;
  return Promise.all(paths.map((path) => captureBaseline(path)));
}

async function snapshotTouched(
  cap: Capability,
  paths: readonly string[] | undefined,
  ctx: ExecutorCallContext,
  deps: ExecutorDeps,
  attemptId?: string,
): Promise<void> {
  if (!deps.snapshots) return;
  // A capability that declares renderUndo reverses itself structurally (a folder
  // move/delete/create — undone by reversing the rename), so it must NOT also be
  // content-snapshotted: that would double-undo and would try to read a directory.
  if (cap.renderUndo) return;
  // Otherwise snapshot whenever touchedPaths is declared, regardless of risk tier:
  // write/destructive MUST declare it (manifest invariant); a sync capability MAY
  // declare it for local files it touches (remote state is not snapshot-able).
  for (const path of paths ?? []) {
    await deps.snapshots.snapshotFile(path, {
      sessionId: ctx.sessionId,
      capability: cap.name,
      toolCallId: ctx.toolCallId,
      ...(attemptId ? { attemptId } : {}),
      origin: "turn",
    });
  }
}

async function baselineIsCurrent(baseline: ProposalBaseline[]): Promise<boolean> {
  for (const entry of baseline) {
    if (entry.directory?.baseline === "too-large" || await baselineHash(entry) !== entry.hash) return false;
  }
  return true;
}

function containsUnpreviewedPath(
  paths: readonly string[],
  baseline: readonly { path: string; hash: string }[] | undefined,
): boolean {
  const staged = new Set((baseline ?? []).map((entry) => entry.path));
  return paths.some((path) => !staged.has(path));
}

type JournalExecution = {
  journal: ExecutionJournal;
  attemptId: string;
  intentRecorded: boolean;
  journalFailed?: boolean;
  terminal?: { disposition: ExecutionOutcomeDisposition; result: CapabilityResult; classification: ExecutionClassification };
};

async function journalOutcome(
  execution: JournalExecution | undefined,
  disposition: ExecutionOutcomeDisposition,
  result: CapabilityResult,
  classification: ExecutionClassification,
): Promise<void> {
  if (!execution) return;
  try {
    await execution.journal.recordOutcome(execution.attemptId, {
      disposition,
      result,
      ...(result.remoteOutcome ? { remoteOutcome: result.remoteOutcome } : {}),
      classification,
    });
  } catch (error) {
    execution.journalFailed = true;
    throw error;
  }
  execution.terminal = { disposition, result, classification };
}

async function settleUnexpectedExit(
  cap: Capability,
  error: unknown,
  execution: JournalExecution | undefined,
): Promise<{ result: CapabilityResult; relay: ExecutionClassification["relay"]; denied: boolean; stale?: boolean; aborted?: boolean }> {
  if (!execution) throw error;
  if (execution.terminal) {
    return {
      result: execution.terminal.result,
      ...execution.terminal.classification,
    };
  }
  if (execution.intentRecorded) {
    const result = unknownExecutionResult(cap.name, execution.attemptId);
    if (!execution.journalFailed) {
      try { await journalOutcome(execution, "unknown", result, { relay: "error", denied: false, aborted: true }); } catch { /* storage failure already released the owner */ }
    }
    return { result, relay: "error", denied: false, aborted: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  const result = { text: `Call to ${cap.name} did not run because execution bookkeeping failed: ${message}`, isError: true };
  if (!execution.journalFailed) {
    try { await journalOutcome(execution, "precondition-failed", result, { relay: "denied", denied: true, aborted: true }); } catch { /* storage failure already released the owner */ }
  }
  return { result, relay: "denied", denied: true, aborted: true };
}

/** Shared fail-closed result for cancellation and reason-bearing policy refusal. */
function refuseCall(cap: Capability, ctx: ExecutorCallContext, deps: ExecutorDeps, execution?: JournalExecution, opts: { force?: boolean; denialReason?: ApprovalDenialReason } = {}) {
  if (!opts.force && !opts.denialReason && !ctx.signal?.aborted) return undefined;
  return (async () => {
    const aborted = opts.denialReason === undefined;
    const reason = opts.denialReason ?? { code: "aborted", message: "The turn was stopped." };
    const result: CapabilityResult = { text: aborted ? `Call to ${cap.name} was cancelled.` : reason.message, isError: true, denialReason: reason };
    const classification = { relay: "denied" as const, denied: true, ...(aborted ? { aborted: true } : {}) };
    await journalOutcome(execution, "refused", result, classification);
    if (aborted) await deps.audit.record({ type: "capability.cancelled", timestamp: Date.now(), sessionId: ctx.sessionId, turnId: ctx.turnId, capability: cap.name, metadata: { reason } });
    return { result, ...classification, stale: false };
  })();
}

async function runExecute(
  cap: Capability,
  input: unknown,
  discoverTouchedPaths: () => readonly string[] | Promise<readonly string[]> | undefined,
  ctx: ExecutorCallContext,
  deps: ExecutorDeps,
  journalExecution?: JournalExecution,
): Promise<{
  result: CapabilityResult;
  relay: ExecutionClassification["relay"];
  stale: boolean;
  staleCause?: CoreProposalSettlementReason;
  aborted?: boolean;
  touchedPaths?: readonly string[];
}> {
  // Reject already-stale Adoption before checkpointing or snapshotting. The
  // second check below remains load-bearing: it closes the interval in which
  // the filesystem can drift while pre-write snapshots are being captured.
  const staleResult = async () => {
    const result = { text: `Proposal ${ctx.proposalId ?? cap.name} became stale before execution; nothing was applied.`, isError: true };
    await journalOutcome(journalExecution, "stale", result, { relay: "error", denied: false, stale: true });
    return { result, relay: "error" as const, stale: true };
  };
  const consentBaseline = [
    ...(ctx.adoption ? ctx.proposalBaseline ?? [] : []).filter((entry) =>
      !(ctx.approvalBaseline && entry.directory?.baseline === "too-large")),
    ...(ctx.approvalBaseline ?? []),
  ];
  if (consentBaseline?.length && !await baselineIsCurrent(consentBaseline)) {
    return staleResult();
  }
  let touchedPaths: readonly string[] | undefined =
    cap.risk === "write" || cap.risk === "destructive" ? freezeTouchedPaths([]) : undefined;
  // Discovery is execution evidence as well as snapshot input. Structural
  // writes therefore resolve it too; renderUndo gates only the snapshot write.
  // Snapshotless direct-executor consumers still receive empty path evidence;
  // the pre-approval safety check separately discovers paths to refuse folders.
  if (deps.snapshots) {
    try {
      const discovered = discoverTouchedPaths();
      const resolved = discovered && !Array.isArray(discovered) ? await discovered : discovered;
      touchedPaths = resolved === undefined ? touchedPaths : ensureFrozenTouchedPaths(resolved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = {
        text: `Tool ${cap.name} did not run because touched-path discovery failed: ${message}`,
        isError: true,
      };
      await journalOutcome(journalExecution, "precondition-failed", result, { relay: "error", denied: false, aborted: true });
      await deps.audit.record({
        type: "capability.failed",
        timestamp: Date.now(),
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        capability: cap.name,
        risk: cap.risk,
        message,
        input,
        resultText: result.text,
        resultIsError: true,
        ...(journalExecution ? { attemptId: journalExecution.attemptId } : {}),
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        ...(ctx.proposalId ? { metadata: { proposalId: ctx.proposalId } } : {}),
      });
      return { result, relay: "error", stale: false, aborted: true };
    }
    if (ctx.adoption && cap.touchedPaths && containsUnpreviewedPath(touchedPaths ?? [], ctx.proposalBaseline)) {
      const result = {
        text: `Proposal ${ctx.proposalId ?? cap.name} now touches files that were not included in its preview; nothing was applied.`,
        isError: true,
      };
      await journalOutcome(journalExecution, "stale", result, { relay: "error", denied: false, stale: true });
      return { result, relay: "error", stale: true, staleCause: UNPREVIEWED_TOUCHED_PATH_REASON, touchedPaths };
    }
  }
  let checkpointId: string | undefined;
  if (cap.risk !== "read" && deps.versioning) {
    try {
      const checkpoint = await deps.versioning.takeCheckpoint({
        origin: "pre-write",
        capability: cap.name,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        ...(journalExecution ? { attemptId: journalExecution.attemptId } : {}),
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      });
      checkpointId = checkpoint.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const resultText = `Tool ${cap.name} did not run because its versioning checkpoint failed: ${message}`;
      const result = { text: resultText, isError: true };
      await journalOutcome(journalExecution, "precondition-failed", result, { relay: "error", denied: false, aborted: true });
      await deps.audit.record({
        type: "capability.failed",
        timestamp: Date.now(),
        sessionId: ctx.sessionId,
        capability: cap.name,
        risk: cap.risk,
        message,
        input,
        resultText,
        resultIsError: true,
        ...(journalExecution ? { attemptId: journalExecution.attemptId } : {}),
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        ...(ctx.proposalId ? { metadata: { proposalId: ctx.proposalId } } : {}),
      });
      return {
        result,
        relay: "error",
        stale: false,
        aborted: true,
      };
    }
  }
  const priorSnapshotIds = deps.activity && deps.snapshots ? new Set((await deps.snapshots.entries()).map((entry) => entry.id)) : undefined;
  const before = deps.activity ? await captureTurnPaths(touchedPaths ?? []) : new Map<string, string>();
  try {
    await snapshotTouched(cap, touchedPaths, ctx, deps, journalExecution?.attemptId);
  } catch (error) {
    if (!journalExecution) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const result = { text: `Tool ${cap.name} did not run because its snapshot preparation failed: ${message}`, isError: true };
    await journalOutcome(journalExecution, "precondition-failed", result, { relay: "error", denied: false, aborted: true });
    return { result, relay: "error", stale: false, aborted: true };
  }
  const capabilityContext = {
    trigger: ctx.trigger,
    sessionId: ctx.sessionId,
    ...(journalExecution ? {
      attemptId: journalExecution.attemptId,
      idempotencyKey: journalExecution.attemptId,
    } : {}),
    ...(touchedPaths !== undefined ? { resolvedTouchedPaths: touchedPaths } : {}),
    signal: ctx.signal,
    audit: (e: Omit<AuditEvent, "timestamp" | "sessionId">) =>
      void deps.audit.record({
        ...e,
        timestamp: Date.now(),
        sessionId: ctx.sessionId,
        ...(journalExecution ? { attemptId: journalExecution.attemptId } : {}),
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      }),
  };
  if (ctx.adoption) await deps.beforeAdoptionExecute?.();
  if (consentBaseline.length && !await baselineIsCurrent(consentBaseline)) return staleResult();
  if (journalExecution) {
    try {
      await journalExecution.journal.recordIntent(journalExecution.attemptId, {
        policy: "allow",
        ...(checkpointId ? { checkpointId } : {}),
      });
    } catch (error) {
      journalExecution.journalFailed = true;
      throw error;
    }
    journalExecution.intentRecorded = true;
  }
  const cancelled = refuseCall(cap, ctx, deps, journalExecution);
  if (cancelled) return cancelled;
  const executionEvent = { turnId: ctx.turnId, toolCallId: ctx.toolCallId, capability: cap.name, risk: cap.risk, paths: touchedPaths ?? [] };
  deps.onExecution?.({ ...executionEvent, afterStop: false, phase: "start" });
  const completed = (succeeded: boolean) => deps.onExecution?.({ ...executionEvent, phase: "end", succeeded, afterStop: ctx.signal?.aborted === true });
  let result: CapabilityResult;
  const recordActivity = async (succeeded: boolean) => {
    const ids = priorSnapshotIds && deps.snapshots ? (await deps.snapshots.entries()).filter((entry) => !priorSnapshotIds.has(entry.id) && (entry.kind === "snapshot" || entry.kind === "undo-action") && (entry.origin ?? "turn") === "turn").map((entry) => entry.id) : [];
    await deps.activity?.(cap, input, ctx, touchedPaths ?? [], before, ids, succeeded);
  };
  try {
    result = await cap.execute(input, capabilityContext);
    completed(!result.isError);
  } catch (error) {
    completed(false);
    await recordActivity(false);
    const message = error instanceof Error ? error.message : String(error);
    const result = { text: `Tool ${cap.name} failed: ${message}`, isError: true };
    await journalOutcome(journalExecution, "threw", result, { relay: "error", denied: false });
    await deps.audit.record({
      type: "capability.failed", timestamp: Date.now(), sessionId: ctx.sessionId,
      capability: cap.name, risk: cap.risk, message,
      input, resultText: result.text, resultIsError: true,
      ...(journalExecution ? { attemptId: journalExecution.attemptId } : {}),
      ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      ...(ctx.proposalId ? { metadata: { proposalId: ctx.proposalId } } : {}),
    });
    return { result, relay: "error", stale: false, ...(touchedPaths ? { touchedPaths } : {}) };
  }
  if (result.remoteOutcome?.state === "unknown") result = { ...result, isError: true };
  // A structural op (folder move/delete/create) declares its reversal from
  // input; record it only once the op actually succeeded, so Undo never tries
  // to reverse something that did not happen (ADR-0028 typed-ops path).
  if (!result.isError && deps.snapshots && cap.renderUndo) {
    for (const action of cap.renderUndo(input)) {
      await deps.snapshots.recordUndoAction(action, {
        sessionId: ctx.sessionId,
        capability: cap.name,
        toolCallId: ctx.toolCallId,
        ...(journalExecution ? { attemptId: journalExecution.attemptId } : {}),
        origin: "turn",
      });
    }
  }
  await recordActivity(!result.isError);
  await journalOutcome(
    journalExecution,
    result.remoteOutcome?.state === "unknown" ? "unknown" : "returned",
    result,
    { relay: result.isError ? "error" : "ok", denied: false },
  );
  await deps.audit.record({
    type: "capability.executed", timestamp: Date.now(), sessionId: ctx.sessionId,
    capability: cap.name, risk: cap.risk,
    input, resultText: result.text, resultIsError: Boolean(result.isError),
    ...(journalExecution ? { attemptId: journalExecution.attemptId } : {}),
    ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
    ...(ctx.proposalId ? { metadata: { proposalId: ctx.proposalId } } : {}),
  });
  return { result, relay: result.isError ? "error" : "ok", stale: false, ...(touchedPaths ? { touchedPaths } : {}) };
}

/** ADR-0003/0004/0008 pipeline: policy → deny/stage/ask → snapshot → execute → audit. */
export async function executeCapability(
  cap: Capability, input: unknown, ctx: ExecutorCallContext, deps: ExecutorDeps,
): Promise<CapabilityResult> {
  return (await executeCapabilityDetailed(cap, input, ctx, deps)).result;
}

export async function executeCapabilityDetailed(
  cap: Capability, input: unknown, ctx: ExecutorCallContext, deps: ExecutorDeps,
): Promise<{
  result: CapabilityResult;
  relay: ExecutionClassification["relay"];
  denied: boolean;
  stale?: boolean;
  staleCause?: CoreProposalSettlementReason;
  aborted?: boolean;
  touchedPaths?: readonly string[];
}> {
  const turn = deps.activeTurn?.();
  if (turn && (!ctx.turnId || ctx.turnId === turn.turnId)) {
    ctx = { ...ctx, turnId: ctx.turnId ?? turn.turnId, signal: ctx.signal ? AbortSignal.any([ctx.signal, turn.signal]) : turn.signal };
  }
  const audit = deps.audit;
  deps = { ...deps, audit: { record: (event) => audit.record({ ...event, ...(ctx.turnId ? { turnId: ctx.turnId } : {}) }) } };
  let journalExecution: JournalExecution | undefined;
  if (deps.executionJournal && !ctx.adoption) {
    const originKey = ctx.executionKey
      ? `caller/${ctx.executionKey}`
      : ctx.toolCallId && ctx.toolCallIdentity === "verified-unique"
        ? `tool/${ctx.sessionId}/${ctx.toolCallId}`
        : `ephemeral/${randomUUID()}`;
    let disposition;
    try {
      disposition = await deps.executionJournal.register({
        lane: deps.lane,
        originKey,
        capability: cap.name,
        risk: cap.risk,
        egress: cap.egress ?? "none",
        sessionId: ctx.sessionId,
        ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        input,
      });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return {
        result: { text: `Call to ${cap.name} was not executed because its input is not JSON-safe: ${error.message}`, isError: true },
        relay: "denied",
        denied: true,
        aborted: true,
      };
    }
    if (disposition.state === "replay" || disposition.state === "unknown") {
      const outcome = disposition.attempt.outcome?.disposition;
      const classification = disposition.attempt.outcome?.classification ?? {
        relay: outcome === "staged" ? "staged" as const
          : outcome === "refused" || outcome === "precondition-failed" ? "denied" as const
            : disposition.result.isError ? "error" as const : "ok" as const,
        denied: outcome === "refused" || outcome === "precondition-failed",
        ...(outcome === "stale" ? { stale: true } : {}),
      };
      return {
        result: disposition.result,
        ...classification,
      };
    }
    if (disposition.state === "identity-conflict") {
      return { result: disposition.result, relay: "denied", denied: true, aborted: true };
    }
    journalExecution = { journal: deps.executionJournal, attemptId: disposition.attempt.attemptId, intentRecorded: false };
  }
  const attemptEvidence = journalExecution ? { attemptId: journalExecution.attemptId } : {};
  const finishBeforeExecution = async (
    result: CapabilityResult,
    disposition: ExecutionOutcomeDisposition,
    rest: { denied: boolean; stale?: boolean; staleCause?: CoreProposalSettlementReason; aborted?: boolean; touchedPaths?: readonly string[] },
  ) => {
    const classification: ExecutionClassification = {
      relay: disposition === "staged" ? "staged" : rest.denied ? "denied" : result.isError ? "error" : "ok",
      denied: rest.denied,
      ...(rest.aborted !== undefined ? { aborted: rest.aborted } : {}),
      ...(rest.stale !== undefined ? { stale: rest.stale } : {}),
    };
    await journalOutcome(journalExecution, disposition, result, classification);
    return { result, ...classification, ...(rest.staleCause ? { staleCause: rest.staleCause } : {}), ...(rest.touchedPaths ? { touchedPaths: rest.touchedPaths } : {}) };
  };
  let touchedPathsResolution: readonly string[] | Promise<readonly string[]> | undefined =
    ctx.touchedPathsResolution === undefined
      ? undefined
      : Promise.resolve(ctx.touchedPathsResolution).then(ensureFrozenTouchedPaths);
  let touchedPathsStarted = ctx.touchedPathsResolution !== undefined;
  const discoverTouchedPaths = (): readonly string[] | Promise<readonly string[]> | undefined => {
    if (touchedPathsStarted) return touchedPathsResolution;
    touchedPathsStarted = true;
    const discovered = cap.touchedPaths?.(input);
    if (discovered && !Array.isArray(discovered)) {
      touchedPathsResolution = discovered.then((paths) => {
        const frozen = freezeTouchedPaths(paths);
        touchedPathsResolution = frozen;
        return frozen;
      });
    } else {
      touchedPathsResolution = discovered ? freezeTouchedPaths(discovered) : discovered;
    }
    return touchedPathsResolution;
  };
  const failTouchedPaths = async (error: unknown) => {
    if (error instanceof FolderTooLargeError) {
      return finishBeforeExecution({ text: error.message, isError: true,
        denialReason: { code: error.code, message: error.message },
      }, "refused", { denied: true });
    }
    const message = error instanceof Error ? error.message : String(error);
    const result = {
      text: `Tool ${cap.name} did not run because touched-path discovery failed: ${message}`,
      isError: true,
    };
    await deps.audit.record({
      type: "capability.failed",
      timestamp: Date.now(),
      sessionId: ctx.sessionId,
      capability: cap.name,
      risk: cap.risk,
      message,
      input,
      resultText: result.text,
      resultIsError: true,
      ...attemptEvidence,
      ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      ...(ctx.proposalId ? { metadata: { proposalId: ctx.proposalId } } : {}),
    });
    return finishBeforeExecution(result, "precondition-failed", { denied: false, aborted: true });
  };
  try {
  let decision: ApprovalDecision;
  try {
    if (deps.mode) {
      let outside = false;
      if (cap.risk !== "read" && deps.workspaceRoot && deps.mode() !== "read-only" && ctx.trigger.trust !== "background") {
        let paths: readonly string[] | undefined;
        try { paths = await discoverTouchedPaths(); }
        catch (error) { return failTouchedPaths(error); }
        outside = (paths ?? []).some((path) => physicalWorkspacePath(deps.workspaceRoot!, path) === undefined);
      }
      decision = await modeApprovalDecision(deps.mode(), cap, input, ctx.trigger, deps.policy, outside);
    } else decision = await deps.policy({ capability: { name: cap.name, risk: cap.risk }, input, trigger: ctx.trigger });
  } catch (error) {
    if (!journalExecution) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return finishBeforeExecution(
      { text: `Call to ${cap.name} was not executed because policy evaluation failed: ${message}`, isError: true },
      "precondition-failed",
      { denied: true, aborted: true },
    );
  }
  const alwaysAsks = ["allow", "stage", "ask"].includes(decisionKind(decision) ?? "") && await callAsks(cap, input);
  if (alwaysAsks) {
    decision = "ask";
  }
  const policyDecision = decisionKind(decision);
  const policyDenialReason = denialReason(decision);
  const decisionLabel = policyDecision ?? (typeof decision === "string" ? decision : "unrecognized");
  deps.trace({
    type: "policy.decision",
    title: `${cap.name}: ${decisionLabel}`,
    metadata: { capability: cap.name, decision, ...attemptEvidence, ...(policyDenialReason ? { denialReason: policyDenialReason } : {}) },
  });
  await deps.audit.record({
    type: "policy.decision", timestamp: Date.now(), sessionId: ctx.sessionId,
    capability: cap.name, risk: cap.risk, message: decisionLabel,
    ...attemptEvidence,
    ...(policyDenialReason ? { metadata: { denialReason: policyDenialReason } } : {}),
    ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
    ...(ctx.proposalId ? {
      metadata: { ...(policyDenialReason ? { denialReason: policyDenialReason } : {}), proposalId: ctx.proposalId },
    } : {}),
  });

  const cancelled = refuseCall(cap, ctx, deps, journalExecution);
  if (cancelled) return cancelled;
  const needsFolderConsent = ctx.adoption && (await Promise.all(
    (ctx.proposalBaseline ?? []).map(baselineNeedsFolderConsent),
  )).some(Boolean);
  // Adoption normally supplies consent for policy ask/stage. A too-large or
  // legacy directory-only baseline never did: even policy allow must request
  // fresh folder consent. Policy deny (and invalid decisions) still wins.
  const effectiveDecision = ctx.adoption && !alwaysAsks && (policyDecision === "ask" || policyDecision === "stage" || policyDecision === "allow")
    ? (needsFolderConsent ? "ask" : "allow")
    : policyDecision;

  // Folder writes require structural undo and a store that can retain it. Check
  // before staging or asking, including direct callers without snapshot storage.
  if (["allow", "ask", "stage"].includes(effectiveDecision ?? "")
    && (cap.risk === "write" || cap.risk === "destructive")
    && (!cap.renderUndo || !deps.snapshots)) {
    try {
      const paths = await discoverTouchedPaths();
      if ((paths ?? []).some(isDirectory)) {
        const reason: ApprovalDenialReason = {
          code: "folder-not-undoable",
          message: "This folder cannot be changed without a stored restore point and structural undo; nothing was applied.",
        };
        return finishBeforeExecution({ text: reason.message, isError: true, denialReason: reason }, "refused", { denied: true });
      }
    } catch (error) { return failTouchedPaths(error); }
  }

  if (effectiveDecision === "stage") {
    if (cap.validateStage) {
      const configuredTimeout = cap.stageValidationTimeoutMs;
      const timeoutMs = configuredTimeout === undefined
        || !Number.isFinite(configuredTimeout)
        || configuredTimeout <= 0
        ? DEFAULT_STAGE_VALIDATION_TIMEOUT_MS
        : configuredTimeout;
      if (configuredTimeout !== undefined && timeoutMs === DEFAULT_STAGE_VALIDATION_TIMEOUT_MS
        && configuredTimeout !== DEFAULT_STAGE_VALIDATION_TIMEOUT_MS) {
        deps.trace({
          type: "stage.validation.config",
          title: `${cap.name}: invalid stage validation timeout; using default`,
          metadata: {
            level: "debug",
            configuredTimeoutMs: configuredTimeout,
            usingTimeoutMs: DEFAULT_STAGE_VALIDATION_TIMEOUT_MS,
          },
        });
      }
      const validation = await validateStagedCall(cap, input, timeoutMs);
      await deps.audit.record({
        type: "stage.validation",
        timestamp: Date.now(),
        sessionId: ctx.sessionId,
        capability: cap.name,
        risk: cap.risk,
        message: validation.decision,
        ...(validation.decision === "deny" ? {
          resultText: validation.reason.message,
          resultIsError: true,
          metadata: { denialReason: validation.reason },
        } : {}),
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      });
      if (validation.decision === "deny") {
        return finishBeforeExecution(
          { text: validation.reason.message, isError: true, denialReason: validation.reason },
          "refused",
          { denied: true },
        );
      }
    }
    const preview = await renderPreview(cap, input);
    if (deps.proposals) {
      const turnId = ctx.turnId ?? ctx.trigger.id;
      let paths: readonly string[] | undefined;
      try {
        const discovered = discoverTouchedPaths();
        paths = discovered && !Array.isArray(discovered) ? await discovered : discovered;
      } catch (error) {
        return failTouchedPaths(error);
      }
      let baseline: ProposalBaseline[] | undefined;
      try { baseline = await baselineFor(paths); }
      catch (error) { return failTouchedPaths(error); }
      if (cap.proposalKind === "change" && !baseline?.length) {
        return finishBeforeExecution(
          { text: `Change Proposal ${cap.name} requires at least one touched path for its baseline guard.`, isError: true },
          "precondition-failed",
          { denied: true },
        );
      }
      const cancelled = refuseCall(cap, ctx, deps, journalExecution);
      if (cancelled) return cancelled;
      const proposal = await deps.proposals.create({
        id: randomUUID(),
        lane: deps.lane,
        kind: cap.proposalKind ?? "action",
        sessionId: ctx.sessionId,
        turnId,
        ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
        groupId: turnId,
        capability: cap.name,
        risk: cap.risk,
        title: preview?.split("\n", 1)[0] ?? `${cap.label ?? cap.name} ${paths?.[0] ?? ""}`.trim(),
        payload: structuredClone(input),
        baseline,
        status: "proposed",
        createdAt: new Date().toISOString(),
        ...(cap.allowSiblingProposals ? { allowSiblings: true } : {}),
      });
      return finishBeforeExecution(
        { text: `Call to ${cap.name} was staged for review (proposal ${proposal.id}); it has not run yet.` },
        "staged",
        { denied: false, ...(paths ? { touchedPaths: paths } : {}) },
      );
    }
    return finishBeforeExecution(
      { text: `Call to ${cap.name} could not be staged because Proposal storage is unavailable.`, isError: true },
      "precondition-failed",
      { denied: true },
    );
  }

  if (effectiveDecision === "ask") {
    let preview = await renderPreview(cap, input);
    let approvalBaseline: ProposalBaseline[] | undefined;
    if (cap.risk === "destructive" || cap.risk === "write" || needsFolderConsent) {
      try {
        const paths = await discoverTouchedPaths();
        // Fresh consent uses the same bounded content/metadata tiers as staging;
        // folders beyond the metadata limit are refused before opening a card.
        const consentPaths = new Set([...(paths ?? []), ...(needsFolderConsent ? ctx.proposalBaseline?.map((entry) => entry.path) ?? [] : [])]);
        // File-only approval needs no folder listing or content read. Keep
        // this preflight synchronous so a missing output adds no disk-I/O wait
        // before the broker can settle the approval requirement.
        const hasFolder = [...consentPaths].some(isDirectory);
        const current = hasFolder ? await Promise.all([...consentPaths].map((path) => captureBaseline(path))) : [];
        if (current.some((entry) => entry.directory)) {
          approvalBaseline = current;
          const listings = current.filter((entry) => entry.directory).map((entry) => {
            const directory = entry.directory!;
            const header = `Folder contents ${JSON.stringify(entry.path)}:`;
            if (directory.baseline === "too-large") {
              // Only old stored records may carry this marker. Fresh captures
              // refuse instead; fail closed if that contract ever regresses.
              throw new FolderTooLargeError();
            }
            const shown = directory.tier === "metadata"
              ? directory.entries.slice(0, APPROVAL_LISTING_MAX_ENTRIES).map((child) =>
                `${child.kind} ${JSON.stringify(child.path)} ${child.size} bytes, mtime ${child.mtimeMs}, mode ${child.mode.toString(8)}`).join("\n")
              : directory.entries.slice(0, APPROVAL_LISTING_MAX_ENTRIES).map((child) =>
                `${child.kind} ${JSON.stringify(child.path)} ${child.hash}`).join("\n");
            const more = (directory.entryCount ?? directory.entries.length) - Math.min(directory.entries.length, APPROVAL_LISTING_MAX_ENTRIES);
            const notice = directory.tier === "metadata" ? `\n${metadataBaselineNotice(directory.entryCount)}` : "";
            return `${header}${notice}\n${shown}${more > 0 ? `\nand ${more} more` : ""}`;
          });
          preview = [preview, ...listings].filter(Boolean).join("\n\n");
        } else if (needsFolderConsent) {
          return finishBeforeExecution({ text: "The proposed folder changed before approval; nothing was applied.", isError: true }, "stale", { denied: false, stale: true });
        }
      } catch (error) { return failTouchedPaths(error); }
    }
    deps.trace({ type: "approval.requested", title: `Approval requested: ${cap.name}` });
    const outcome = await deps.broker.request({ capabilityName: cap.name, risk: cap.risk, input, preview, turnId: ctx.turnId, signal: ctx.signal });
    deps.trace({ type: "approval.settled", title: `${cap.name}: ${outcome}` });
    await deps.audit.record({
      type: "approval.settled", timestamp: Date.now(), sessionId: ctx.sessionId,
      capability: cap.name, risk: cap.risk, message: outcome,
      ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
    });
    if (outcome === "cancelled") {
      return (await refuseCall(cap, ctx, deps, journalExecution, { force: true }))!;
    }
    if (outcome === "denied") {
      return finishBeforeExecution(
        { text: `The user declined the ${cap.name} call.`, isError: true },
        "refused",
        { denied: true },
      );
    }
    const execution = await runExecute(cap, input, discoverTouchedPaths, { ...ctx, ...(approvalBaseline ? { approvalBaseline } : {}) }, deps, journalExecution);
    return { ...execution, denied: execution.aborted === true && execution.relay === "denied" };
  }

  // Fail closed: execute ONLY on the exact "allow" decision (or an approved "ask",
  // handled above). Anything else — "deny", undefined, misspelled/wrong-case values,
  // or garbage returned by an app-authored JS policy — is treated as a denial. This
  // is deliberately not an `if (decision === "deny")` / else-execute shape: that
  // shape is exactly the bug being fixed (fall through to execute for any
  // unrecognized value).
  if (effectiveDecision !== "allow") {
    await deps.audit.record({
      type: "policy.decision", timestamp: Date.now(), sessionId: ctx.sessionId,
      capability: cap.name, risk: cap.risk, message: "deny",
      metadata: policyDenialReason ? { denialReason: policyDenialReason } : { rawDecision: decision },
      ...(ctx.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
    });
    if (policyDenialReason) {
      return (await refuseCall(cap, ctx, deps, journalExecution, { denialReason: policyDenialReason }))!;
    }
    return finishBeforeExecution({
      text: `Call to ${cap.name} was denied by the app's policy${policyDecision === "deny" ? "" : ` (unrecognized policy decision: ${JSON.stringify(decision)})`}.`,
      isError: true,
    }, "refused", { denied: true });
  }

  const execution = await runExecute(cap, input, discoverTouchedPaths, ctx, deps, journalExecution);
  return { ...execution, denied: execution.aborted === true && execution.relay === "denied" };
  } catch (error) {
    // Restores the ownership and Outcome Honesty invariants across every exit:
    // pre-intent failures settle as non-execution, while any post-intent hole is
    // surfaced as unknown and can never masquerade as a plain retryable failure.
    return settleUnexpectedExit(cap, error, journalExecution);
  }
}
