import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { Type } from "typebox";
import { ApprovalBroker } from "./approval.ts";
import { BridleAuth } from "./auth.ts";
import { executeCapabilityDetailed, type ExecutorDeps } from "./executor.ts";
import { buildSystemPrompt, createManifest, discoverManifestTools, wireName, type PromptComposition } from "./manifest.ts";
import type { Skill } from "./skills/types.ts";
import { takeCheckpoint as takeVersionCheckpoint } from "./versioning/checkpoint.ts";
import {
  reissueWorkspaceIdentity,
  resolveWorkspaceIdentity,
  type WorkspaceIdentity,
} from "./versioning/identity.ts";
import { VersioningLockError } from "./versioning/lock.ts";
import { restoreTo as restoreVersionTo } from "./versioning/restore.ts";
import { VersionStore } from "./versioning/store.ts";
import type {
  Checkpoint,
  CheckpointResult,
  RestoreReport,
} from "./versioning/types.ts";

/** Sol F3: the harness works from an immutable snapshot of the caller's composition —
 *  later mutation of the caller's objects cannot make session, envelope and
 *  per-turn skill identity diverge. */
function snapshotComposition(composition: PromptComposition): PromptComposition {
  const snapshotSkill = (skill: Skill): Skill => Object.freeze({
    ...skill,
    tools: Object.freeze([...skill.tools]) as unknown as string[],
    ...(skill.trigger ? { trigger: Object.freeze({ ...skill.trigger }) } : {}),
  });
  return Object.freeze({
    ...(composition.customInstructions !== undefined ? { customInstructions: composition.customInstructions } : {}),
    ...(composition.skills ? { skills: Object.freeze(composition.skills.map(snapshotSkill)) as unknown as Skill[] } : {}),
    ...(composition.activeSkill ? { activeSkill: snapshotSkill(composition.activeSkill) } : {}),
  });
}
import { defaultApprovalPolicy } from "./policy.ts";
import { createBridleSession, createPiEventRelay } from "./runtime-pi.ts";
import { bindSnapshotSession, RestoreRefusedError, SnapshotStore } from "./snapshots.ts";
import { BridleEventEmitter } from "./events.ts";
import { RecorderStore, type RecordingMode } from "./recorder/store.ts";
import { openProposalStore, PROPOSAL_CLOSE_TIMEOUT_MS } from "./proposals/store.ts";
import type { ProposalStore, ProposalStoreState } from "./proposals/types.ts";
import { deriveProposalPreview } from "./proposals/preview.ts";
import type { BridleEvent, ContextItem, TurnId, TurnOutcome, TurnReceipt, TurnResult, TurnEndReason, TurnResponder, TurnToolError } from "./events.ts";
import { resolveContextItems, SharpImageNormalizer, type ImageNormalizer } from "./context.ts";
import { projectUserContext, type TranscriptOptions } from "./transcript-user-context.ts";
import type {
  AgentTrigger, ApprovalPolicy, ApprovalRequest, AuditEvent, AuditLog,
  BridleLane, Capability, CapabilityResult, ManifestDefinition, TraceEvent,
} from "./types.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { createModelService, type BridleModelService } from "./model-listing.ts";
import { TurnToolOutcomes } from "./turn-tool-outcomes.ts";
import { turnFailureReason } from "./turn-failure.ts";
import { BRIDLE_VERSION } from "./version.ts";
import { openExecutionJournal, type UnknownExecution } from "./execution-journal/index.ts";
import { TurnHistory, type BridleTurns, type UndoTurnResult, type TurnVersionRestore } from "./turns.ts";
import type { BridleMode } from "./types.ts";

export type BridleThinkingLevel = "minimal" | "low" | "medium" | "high";

export type BridleModel = { providerId: string; modelId: string };
export type BridleAuditEvent = AuditEvent & { lane: BridleLane };

export type BridleVersioningRestoreResult = {
  id: string;
  noop: boolean;
  beforeCheckpointId: string | null;
  report: RestoreReport;
};

export type BridleVersioningCheckpointOptions = {
  label?: string;
  fullRehash?: boolean;
};

export type BridleVersioning = {
  readonly workspaceId: string;
  readonly workspaceClaim: "current" | "moved" | "reissued";
  checkpoints(): Promise<Checkpoint[]>;
  restoreTo(id: string): Promise<BridleVersioningRestoreResult>;
  takeCheckpoint(opts?: BridleVersioningCheckpointOptions): Promise<CheckpointResult>;
};

export type BridleExecutions = {
  /**
   * Lists attempts whose capability may have completed before Core stopped.
   *
   * A direct capability call from a provider without trustworthy per-response
   * identity has no cross-restart duplicate suppression. Its protection is this
   * unknown-state surface (and, when session recovery is enabled, the model warning).
   * A host that requires durable cross-restart identity must route the action
   * through an Action Proposal.
   *
   * Journal version 1 assumes one active Bridle writer per appDataDir and does
   * not claim simultaneous cross-process exclusion or exactly-once completion.
   */
  unknown(): Promise<readonly UnknownExecution[]>;
};

/**
 * Settles every prompt the harness will not run because it was disposed: a prompt made after
 * dispose(), and a queued prompt that had not reached the provider when dispose() began.
 * Hosts match on the stable `code`.
 */
export class BridleDisposedError extends Error {
  readonly code = "BRIDLE_DISPOSED" as const;
  constructor() {
    super("Bridle handle is disposed.");
    this.name = "BridleDisposedError";
  }
}

async function takeBootVersionCheckpoint(
  store: VersionStore,
  workspaceRoot: string,
  largeFileCeiling: number,
): Promise<CheckpointResult> {
  return retryBootVersioningLock(() =>
    takeVersionCheckpoint(store, workspaceRoot, {
      label: "workspace opened",
      trigger: "initial",
      largeFileCeiling,
    }));
}

async function retryBootVersioningLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + 3_000;
  let delayMs = 25;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof VersioningLockError)) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(delayMs, remainingMs));
      });
      delayMs = Math.min(delayMs * 2, 250);
    }
  }
}

/** Stable textual conversation view. Pi content blocks and private thinking never cross the Harness boundary. */
export type BridleTranscriptMessage =
  | { role: "user"; text: string; timestamp: number; hiddenContext?: string }
  | { role: "assistant"; text: string; timestamp: number; isError: boolean; errorMessage?: string }
  | { role: "tool"; text: string; timestamp: number; toolCallId: string; toolName: string; isError: boolean };

export type Bridle = {
  readonly mode: BridleMode;
  setMode(mode: BridleMode): void;
  readonly turns: BridleTurns;
  prompt(text: string, opts?: { trigger?: AgentTrigger; context?: ContextItem[] }): Promise<TurnResult>;
  events: { subscribe(fn: (event: BridleEvent) => void): () => void };
  abort(turnId: TurnId): boolean;
  readonly activeTurn: TurnId | null;
  approvals: ApprovalBroker;
  proposals: ProposalStore;
  readonly proposalStore: ProposalStoreState;
  snapshots: SnapshotStore;
  readonly executions: BridleExecutions;
  readonly versioning?: BridleVersioning;
  /**
   * Undoes the latest recorded turn; legacy unrecorded restore points still use SnapshotStore.
   */
  restoreLastTurn(): Promise<string[]>;
  auth: BridleAuth;
  readonly recording: RecordingMode | "off";
  readonly lane: BridleLane;
  auditEvents: BridleAuditEvent[];
  readonly sessionId: string;
  readonly model: BridleModel | null;
  readonly thinkingLevel: BridleThinkingLevel;
  /** One source of truth for model discovery, listing, and construction. */
  readonly models: BridleModelService;
  /** Hidden context is omitted from text; opt in to separate hiddenContext blocks. Legacy unsplit text is preserved. */
  transcript(options?: TranscriptOptions): BridleTranscriptMessage[];
  unsafeSession: AgentSession;
  setModel(providerId: string, modelId: string): Promise<void>;
  setThinkingLevel(level: BridleThinkingLevel): Promise<void>;
  dispose(): Promise<void>;
};

const INTERACTIVE: AgentTrigger = { id: "user", source: "user", trust: "interactive" };

const DEFAULT_LARGE_FILE_CEILING = 256 * 1024 * 1024;

export type BridleSessionFactory = typeof createBridleSession;

function realpathStyleResolution(path: string): string {
  let existingAncestor = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return resolve(realpathSync.native(existingAncestor), ...missingSegments);
}

function containsPath(parent: string, candidate: string): boolean {
  const remainder = relative(parent, candidate);
  return remainder === ""
    || (!isAbsolute(remainder)
      && remainder !== ".."
      && !remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function validateVersioningStoreDir(
  workspaceRoot: string,
  storeRoot: string,
  explicitStoreDir: boolean,
): void {
  if (explicitStoreDir && !isAbsolute(storeRoot)) {
    throw new Error("Bridle versioning.storeDir must be an absolute path.");
  }
  const resolvedWorkspaceRoot = realpathStyleResolution(workspaceRoot);
  const resolvedStoreDir = realpathStyleResolution(storeRoot);
  if (
    containsPath(resolvedWorkspaceRoot, resolvedStoreDir)
    || containsPath(resolvedStoreDir, resolvedWorkspaceRoot)
  ) {
    throw new Error(
      "Bridle versioning.storeDir and manifest.workspaceRoot must not contain one another.",
    );
  }
}

async function openWorkspaceVersionStore(
  storeRoot: string,
  workspaceRoot: string,
): Promise<{
  identity: WorkspaceIdentity;
  store: VersionStore;
  workspaceClaim: BridleVersioning["workspaceClaim"];
}> {
  let identity = await resolveWorkspaceIdentity(workspaceRoot);
  let store = await VersionStore.open({ dir: join(storeRoot, identity.id) });
  const claim = await retryBootVersioningLock(
    () => store.claimWorkspace(workspaceRoot, identity.id),
  );
  if (claim === "collision") {
    identity = await reissueWorkspaceIdentity(workspaceRoot);
    store = await VersionStore.open({ dir: join(storeRoot, identity.id) });
    const freshClaim = await retryBootVersioningLock(
      () => store.claimWorkspace(workspaceRoot, identity.id),
    );
    if (freshClaim === "collision") {
      throw new Error("Fresh Bridle workspace identity collided with an existing version store.");
    }
    return { identity, store, workspaceClaim: "reissued" };
  }
  return { identity, store, workspaceClaim: claim };
}

function transcriptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const block = part as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("");
}

function publicTranscriptMessage(message: unknown, options: TranscriptOptions = {}): BridleTranscriptMessage | null {
  if (!message || typeof message !== "object") return null;
  const value = message as Record<string, unknown>;
  if (typeof value.timestamp !== "number") return null;
  if (value.role === "user") {
    const projected = projectUserContext(value, options);
    return {
      role: "user", text: transcriptText(projected.content), timestamp: value.timestamp,
      ...(options.includeHidden && typeof projected.hiddenContext === "string"
        ? { hiddenContext: projected.hiddenContext } : {}),
    };
  }
  if (value.role === "assistant") {
    const isError = value.stopReason === "error";
    return {
      role: "assistant", text: transcriptText(value.content), timestamp: value.timestamp, isError,
      ...(isError && typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
    };
  }
  if (value.role === "toolResult" && typeof value.toolCallId === "string" && typeof value.toolName === "string") {
    return {
      role: "tool", text: transcriptText(value.content), timestamp: value.timestamp,
      toolCallId: value.toolCallId, toolName: value.toolName, isError: value.isError === true,
    };
  }
  return null;
}

function publicThinkingLevel(level: unknown, fallback: BridleThinkingLevel): BridleThinkingLevel {
  return level === "minimal" || level === "low" || level === "medium" || level === "high" ? level : fallback;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value as Record<string, unknown>).sort().flatMap((key) => {
    const nested = (value as Record<string, unknown>)[key];
    return nested === undefined || typeof nested === "function" ? [] : [`${JSON.stringify(key)}:${canonicalJson(nested)}`];
  }).join(",")}}`;
}

function recorderManifestHash(manifest: ManifestDefinition): string {
  const definition = {
    appId: manifest.appId,
    workspaceRoot: manifest.workspaceRoot,
    contextReader: manifest.contextReader,
    systemPromptPreamble: manifest.systemPromptPreamble,
    capabilities: manifest.capabilities.map((capability) => ({
      name: capability.name,
      label: capability.label,
      description: capability.description,
      risk: capability.risk,
      parameters: JSON.parse(JSON.stringify(capability.parameters)),
    })),
  };
  return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}

/**
 * Built-in agent self-correction (appended to every manifest): every stage result names its Proposal
 * id, so the model can withdraw its own still-proposed call instead of layering another call on top.
 * Risk `read`: it settles working state and touches no Host App files.
 */
export function retractCapability(
  proposals: ProposalStore,
): Capability {
  return {
    name: "proposals.retract",
    label: "withdraw a staged call",
    risk: "read",
    description:
      "Withdraw one of YOUR OWN still-proposed calls — your self-correction path. Every staged call's result names its proposal id; pass that id to retract the call when it was wrong, over-reached, or the user asks you to undo it, instead of stacking another call on top. Only proposed, not-yet-settled calls can be retracted.",
    parameters: Type.Object({
      id: Type.String({ description: "The proposal id from the staged call's result" }),
    }),
    execute: async (input: { id: string }, ctx) => {
      const proposal = await proposals.get(input.id);
      if (!proposal || proposal.status !== "proposed") {
        return { text: `No proposed call ${input.id} to withdraw; it may already be adopted or settled.`, isError: true };
      }
      if (proposal.sessionId !== ctx.sessionId) {
        return { text: `Proposal ${input.id} is not owned by this agent session and cannot be withdrawn.`, isError: true };
      }
      await proposals.reject(proposal.id, "agent");
      return { text: `Withdrew the staged ${proposal.capability} call (proposal ${proposal.id}).` };
    },
  };
}

/**
 * Assembles the full Bridle stack (manifest, auth, approvals, Proposals,
 * snapshots, audit, Pi session) into a single handle. ADR-0001 firewall: this
 * is the only place Pi-typed values (`AgentSession`) cross into the returned
 * surface, and only as an opaque type re-exported for host apps to hold, not
 * to import Pi directly against.
 */
/** The harness's built-in capabilities, appended to every host manifest. A host that declares its own
 *  capability with the same name overrides the built-in (its entry wins; nothing is appended). */
export function withBuiltinCapabilities(
  def: ManifestDefinition,
  proposals: ProposalStore,
): ManifestDefinition {
  if (def.capabilities.some((c) => c.name === "proposals.retract")) return def;
  return { ...def, capabilities: [...def.capabilities, retractCapability(proposals)] };
}

export type CreateBridleOptions = {
  manifest: ManifestDefinition;
  appDataDir: string;
  /** Sealed for this instance. Switching lanes requires a new Bridle session. */
  lane?: BridleLane;
  snapshotDir?: string;
  approvalPolicy?: ApprovalPolicy;
  mode?: BridleMode;
  approvalTimeoutMs?: number;
  onApprovalRequest?: (req: ApprovalRequest) => void;
  onTrace?: (e: TraceEvent) => void;
  auditLog?: AuditLog;
  recording?: RecordingMode | "off";
  provider?: string;
  modelId?: string;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  imageNormalizer?: ImageNormalizer;
  /**
   * Credential storage for the live provider. Defaults to a JSON file under
   * appDataDir (auth.json). Pass a BridleAuth backed by a SecretStore (e.g.
   * BridleAuth.secretStore(store, appId)) to keep API keys and OAuth tokens in
   * an encrypted store instead of plaintext on disk.
   */
  auth?: BridleAuth;
  modelService?: BridleModelService;
  session?: BridleSessionFactory;
  /**
   * How the persisted Pi session starts: "new" (default — every boot opens a fresh session) or
   * "continue-recent" (resume the most recent session for this workspace under this appDataDir).
   * Apps whose UI promises a conversation that survives a relaunch opt in explicitly; recording
   * "off" (in-memory sessions) ignores it.
   */
  sessionResume?: "new" | "continue-recent";
  _sessionFactory?: BridleSessionFactory;
  /**
   * PRD S4: a skill-bound Bridle instance. The app creates one instance per
   * skill-bound thread (or one-shot run); the composition — machine
   * custom-instructions, discoverable skills, the active skill — holds for the
   * instance's whole life. With an active skill the session registers only the
   * skill's capability subset (S3) and the Flight Recorder records that scoped
   * reality.
   */
  composition?: PromptComposition;
  /**
   * Opt-in whole-folder history. Omission preserves the existing zero-I/O path.
   * Store-open or boot-checkpoint failure after the bounded lock retry is fatal
   * to createBridle: startup fails closed. Degraded startup is deferred to the
   * Paddock cutover. Set storeDir when a consumer runs several Bridle instances
   * over one workspace folder (for example, per-thread instances) so they share
   * one timeline. Instances in one Node/Electron process share safely via the
   * in-process mutex; a second process contending on the same store fails closed
   * on the pre-write path — no wait is attempted.
   */
  versioning?: { enabled: true; largeFileCeiling?: number; storeDir?: string };
};

export async function createBridle(opts: CreateBridleOptions): Promise<Bridle> {
  if (opts.versioning?.enabled && !opts.manifest.workspaceRoot) {
    throw new Error("Bridle versioning requires manifest.workspaceRoot.");
  }
  if (opts.versioning?.enabled) {
    const storeRoot = opts.versioning.storeDir
      ?? join(opts.appDataDir, "versioning");
    validateVersioningStoreDir(
      opts.manifest.workspaceRoot!,
      storeRoot,
      opts.versioning.storeDir !== undefined,
    );
  }
  // Sol F3 (round 3): snapshot BEFORE the first await — a caller mutating its
  // composition object in the same tick as the call cannot race the copy.
  const composition = opts.composition ? snapshotComposition(opts.composition) : undefined;
  const lane = opts.lane ?? "live";
  return createBridleAsync(opts, composition, lane);
}

async function createBridleAsync(
  opts: CreateBridleOptions,
  composition: PromptComposition | undefined,
  lane: BridleLane,
): Promise<Bridle> {
  let activeAnswerText = "";
  let activeReasoning = "";
  let activeStopReason: string | undefined;
  let activeFinalAnswer = false;
  let activeAccumulator: {
    filesRead: Set<string>;
    filesWritten: Set<string>;
    callsDenied: number;
    callsStaged: number;
    tools: TurnToolOutcomes;
    nonReadExecuted: boolean;
    toolErrors: Map<string, TurnToolError>;
    writesAfterStop: Set<string>;
    capabilitiesAfterStop: Set<string>;
    usageSeen: boolean;
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; costSeen: boolean };
  } | null = null;
  let activeTurn: TurnId | null = null;
  let turnSignal: AbortSignal | undefined;
  let turnClosing = false;
  let activeFailure: TurnEndReason | undefined;
  let mode: BridleMode = opts.mode ?? "work";
  if (!["suggest", "work", "read-only"].includes(mode)) throw new Error("Unknown Bridle mode.");
  let history: TurnHistory;
  let session!: Awaited<ReturnType<BridleSessionFactory>>["session"];
  const observerAudits = new Set<Promise<void>>();
  const recordObserver = (event: AuditEvent) => {
    const pending = Promise.resolve(audit.record(event)).catch(() => {}).finally(() => observerAudits.delete(pending));
    observerAudits.add(pending);
  };
  let events!: BridleEventEmitter;
  const trace = (e: Omit<TraceEvent, "id" | "timestamp">) => {
    if (e.type === "events.listener_error" && (e.metadata?.eventType === "approval_requested" || e.metadata?.eventType === "approval_settled")) {
      recordObserver({ type: "approval.observer_error", timestamp: Date.now(), sessionId: session.sessionId, ...(activeTurn ? { turnId: activeTurn } : {}), metadata: { stage: "subscriber", eventType: e.metadata.eventType } });
      if (e.metadata.eventType === "approval_requested") {
        for (const request of approvals.pending()) {
          if (request.turnId === activeTurn) approvals.resolve(request.id, false);
        }
      }
    }
    try { opts.onTrace?.({ ...e, id: randomUUID(), timestamp: Date.now() }); }
    catch { /* Diagnostic observers cannot interrupt turn or approval settlement. */ }
  };
  events = new BridleEventEmitter(trace);
  const executionJournal = await openExecutionJournal({
    appDataDir: opts.appDataDir,
    appId: opts.manifest.appId,
    ...(opts.manifest.workspaceRoot ? { workspaceRoot: opts.manifest.workspaceRoot } : {}),
  });
  const recording = opts.recording ?? "full";
  const recorder = recording === "off" ? null : await RecorderStore.open(opts.appDataDir, recording, { appId: opts.manifest.appId });
  const snapshotDir = opts.snapshotDir
    ?? (opts.manifest.workspaceRoot ? join(opts.manifest.workspaceRoot, ".bridle") : join(opts.appDataDir, "snapshots"));
  const approvals = new ApprovalBroker({
    timeoutMs: opts.approvalTimeoutMs,
    onRequest: (request) => {
      if (activeTurn) events.emit({ type: "approval_requested", turnId: activeTurn, request });
      if (approvals.pending().some((pending) => pending.id === request.id)) opts.onApprovalRequest?.(request);
    },
    onObserverError: (request, stage) => {
      recordObserver({ type: "approval.observer_error", timestamp: Date.now(), sessionId: session.sessionId, turnId: request.turnId, capability: request.capabilityName, metadata: { stage, requestId: request.id } });
    },
    onRefused: (request, reason, history) => {
      recordObserver({ type: "approval.refused", timestamp: Date.now(), sessionId: session.sessionId, turnId: request?.turnId ?? history?.turnId, metadata: { reason, requestId: request?.id ?? history?.id } });
    },
    onSettle: (request, outcome) => {
      if (activeTurn) {
        events.emit({
          type: "approval_settled", turnId: activeTurn, requestId: request.id,
          decision: outcome === "approved" ? "allow" : "deny",
        });
      }
    },
  });
  const auditEvents: BridleAuditEvent[] = [];
  const audit: AuditLog = {
    async record(event) {
      const withTurn = event;
      const enriched = { ...withTurn, lane };
      auditEvents.push(enriched);
      if (activeAccumulator && event.turnId === activeTurn && (event.type === "capability.failed" || event.type === "approval.observer_error" || event.resultIsError && event.type === "capability.executed")) {
        const key = event.toolCallId ?? event.attemptId ?? event.capability ?? event.type;
        activeAccumulator.tools.error(event.toolCallId);
        activeAccumulator.toolErrors.set(key, { ...(event.capability ? { capability: event.capability } : {}), ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}), message: event.resultText ?? event.message ?? "Approval observer failed." });
      }
      if (recorder) {
        await recorder.appendAudit(enriched.sessionId, enriched as unknown as Record<string, unknown>);
        if (enriched.type === "approval.settled") await recorder.flush();
      }
      await history?.observe(enriched);
      await opts.auditLog?.record(enriched);
    },
  };
  const snapshots = await SnapshotStore.open({
    dir: snapshotDir,
    async onRecovery(warning) {
      await audit.record({ type: "snapshots.recovered", timestamp: Date.now(), sessionId: "recovery", metadata: warning });
    },
    // A restore may change the workspace only, wherever the store itself is kept.
    ...(opts.manifest.workspaceRoot ? { root: opts.manifest.workspaceRoot } : {}),
    async onRestore(restoration) {
      // The journal lies inside the workspace and can be planted, so it attributes
      // nothing. The session is the one doing the restore (the store is bound to
      // this handle's session). A proposal is named only when the caller named it,
      // or when this handle's own Proposal store says that the proposal the journal
      // names was adopted at this Restore Point.
      const claimed = restoration.untrustedSource.proposalId;
      const confirmed = restoration.proposalId ?? (claimed !== undefined
        && (await proposalStore.store.get(claimed).catch(() => undefined))?.restorePointId === restoration.restorePointId
        ? claimed : undefined);
      const event = events.emit({
        type: "restore",
        restorePointId: restoration.restorePointId,
        ...(confirmed ? { proposalId: confirmed } : {}),
        paths: restoration.paths,
        untrustedSource: restoration.untrustedSource,
      });
      await audit.record({
        type: "restore",
        timestamp: event.timestamp,
        sessionId: restoration.sessionId,
        metadata: { event },
      });
    },
  }).catch(async (error: unknown) => {
    // A store that cannot be opened (SnapshotStoreError: its folder or journal is
    // a link) fails the whole handle; release what was opened before it.
    await executionJournal.close().catch(() => {});
    throw error;
  });
  const proposalStore = await openProposalStore({
    appDataDir: opts.appDataDir,
    recorder,
    snapshots,
    async onRecovery(warning) {
      await audit.record({ type: "proposals.recovered", timestamp: Date.now(), sessionId: "recovery", metadata: warning });
    },
    async onCancellationRefused(proposal, reason) {
      await audit.record({ type: "proposal.cancel_refused", timestamp: Date.now(), sessionId: proposal.sessionId, turnId: proposal.turnId, metadata: { proposalId: proposal.id, reason } });
    },
    async onAdoptionRefused(proposal, reason) {
      await audit.record({ type: "proposal.adoption_refused", timestamp: Date.now(), sessionId: proposal.sessionId, turnId: proposal.turnId, metadata: { proposalId: proposal.id, reason } });
    },
    async onLifecycle(lifecycleEvent) {
      const { type, proposal } = lifecycleEvent;
      if (type === "proposal_created") {
        events.emit({
          type,
          turnId: proposal.turnId,
          proposalId: proposal.id,
          groupId: proposal.groupId,
          capability: proposal.capability,
          kind: proposal.kind,
        });
      } else if (type === "proposal_attempted") {
        events.emit({
          type,
          turnId: proposal.turnId,
          proposalId: proposal.id,
          proposal,
          outcome: lifecycleEvent.outcome,
        });
      } else {
        events.emit({
          type,
          turnId: proposal.turnId,
          proposalId: proposal.id,
          status: proposal.status as Exclude<typeof proposal.status, "proposed">,
          ...(proposal.settledBy ? { settledBy: proposal.settledBy } : {}),
          ...(proposal.settlementReason ? { settlementReason: proposal.settlementReason } : {}),
        });
      }
      const lifecycle = {
        type,
        timestamp: Date.now(),
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        capability: proposal.capability,
        toolCallId: proposal.toolCallId,
        ...(type === "proposal_attempted" ? {
          resultText: lifecycleEvent.outcome.resultText,
          resultIsError: lifecycleEvent.outcome.isError,
        } : {}),
        metadata: {
          proposalId: proposal.id,
          proposal,
          ...(type === "proposal_attempted"
            ? { outcome: lifecycleEvent.outcome }
            : {}),
        },
      } satisfies AuditEvent;
      await audit.record(lifecycle);
      if (recorder) {
        recorder.appendProposalEvent({
          type,
          proposal,
          ...(type === "proposal_attempted"
            ? { outcome: lifecycleEvent.outcome }
            : {}),
        });
        await recorder.flush();
      }
    },
  });
  // Assembly owns the proposal writer lock until dispose; startup failure releases it.
  try {
  // Same-turn adoption is nested work: queuing it behind its own prompt would
  // deadlock approval while streaming. Undo refuses the active turn and waits
  // for these claims; other adoption shares the prompt/undo queue.
  let promptQueue: Promise<void> = Promise.resolve();
  let inFlightUndo: Promise<UndoTurnResult> | undefined;
  const inTurnAdoptions = new Set<Promise<unknown>>();
  const trackInTurnAdoption = <T>(operation: Promise<T>): Promise<T> => {
    const tracked = operation.finally(() => inTurnAdoptions.delete(tracked));
    inTurnAdoptions.add(tracked);
    return tracked;
  };
  const queueAdoption = <T>(run: () => Promise<T>): Promise<T> => {
    const result = promptQueue.then(run);
    promptQueue = result.then(() => {}, () => {});
    return result;
  };
  const proposals: ProposalStore = {
    ...proposalStore.store,
    adopt: (id) => {
      if (disposed) return Promise.reject(new BridleDisposedError());
      if (activeTurn && !turnClosing) return proposalStore.store.get(id).then((proposal) => {
        if (proposal?.turnId === activeTurn && !turnClosing) return trackInTurnAdoption(proposalStore.store.adopt(id));
        return queueAdoption(() => proposalStore.store.adopt(id));
      });
      return queueAdoption(() => proposalStore.store.adopt(id));
    },
    adoptGroup: (groupId) => {
      if (disposed) return Promise.reject(new BridleDisposedError());
      if (activeTurn && !turnClosing) return proposalStore.store.list({ groupId, status: "proposed" }).then((members) => {
        if (members.length && members.every((proposal) => proposal.turnId === activeTurn) && !turnClosing) return trackInTurnAdoption(proposalStore.store.adoptGroup(groupId));
        return queueAdoption(() => proposalStore.store.adoptGroup(groupId));
      });
      return queueAdoption(() => proposalStore.store.adoptGroup(groupId));
    },
  };
  const manifest = createManifest(withBuiltinCapabilities(opts.manifest, proposals));
  const auth = opts.auth ?? BridleAuth.file(join(opts.appDataDir, "auth.json"));
  const ownsModelService = opts.modelService === undefined;
  const modelService = opts.modelService ?? createModelService({ auth, appDataDir: opts.appDataDir });
  const discovery = opts.modelService?.lastDiscovery();
  const age = discovery ? Date.now() - discovery.at : Infinity;
  if (age < 0 || age >= 60_000) await modelService.refresh();

  let versioning: BridleVersioning | undefined;
  let restoreTurnVersion: ((options: TurnVersionRestore) => Promise<BridleVersioningRestoreResult>) | undefined;
  let executorVersioning: ExecutorDeps["versioning"];
  if (opts.versioning?.enabled) {
    const workspaceRoot = manifest.workspaceRoot!;
    const largeFileCeiling = opts.versioning.largeFileCeiling ?? DEFAULT_LARGE_FILE_CEILING;
    const { identity, store, workspaceClaim } = await openWorkspaceVersionStore(
      opts.versioning.storeDir ?? join(opts.appDataDir, "versioning"),
      workspaceRoot,
    );
    await takeBootVersionCheckpoint(store, workspaceRoot, largeFileCeiling);
    restoreTurnVersion = async ({ checkpointId, paths, sourceCheckpoints, guard }) => {
      const result = await restoreVersionTo(store, workspaceRoot, checkpointId, { largeFileCeiling, paths, sourceCheckpoints, beforeRestore: guard });
      return { id: result.id, noop: result.noop === true, beforeCheckpointId: result.beforeCheckpointId, report: result.report };
    };
    versioning = Object.freeze({
      workspaceId: identity.id,
      workspaceClaim,
      checkpoints: () => store.checkpoints(),
      restoreTo: async (id: string) => {
        const result = await restoreVersionTo(store, workspaceRoot, id, {
          largeFileCeiling,
        });
        return {
          id: result.id,
          noop: result.noop === true,
          beforeCheckpointId: result.beforeCheckpointId,
          report: result.report,
        };
      },
      takeCheckpoint: (checkpointOpts: BridleVersioningCheckpointOptions = {}) =>
        takeVersionCheckpoint(store, workspaceRoot, {
          label: checkpointOpts.label ?? "manual checkpoint",
          trigger: "app-moment",
          largeFileCeiling,
          ...(checkpointOpts.fullRehash ? { fullRehash: true } : {}),
        }),
    });
    executorVersioning = {
      takeCheckpoint: async (checkpointOpts) => {
        const checkpoint = await takeVersionCheckpoint(store, workspaceRoot, {
          label: `before ${checkpointOpts.capability}`,
          trigger: "write",
          largeFileCeiling,
          ...checkpointOpts,
          force: true,
        });
        await history?.checkpoint(checkpointOpts.turnId, checkpoint.id);
        if (checkpointOpts.turnId) {
          const turn = await history?.get(checkpointOpts.turnId);
          await audit.record({ type: "turn.checkpoint.write", timestamp: Date.now(), sessionId: checkpointOpts.sessionId,
            turnId: checkpointOpts.turnId, capability: checkpointOpts.capability, toolCallId: checkpointOpts.toolCallId,
            metadata: { checkpointId: turn?.checkpointId ?? checkpoint.id, writeCheckpointId: checkpoint.id } });
        }
        return checkpoint;
      },
    };
  }

  const deps: ExecutorDeps = {
    lane,
    mode: () => mode,
    workspaceRoot: manifest.workspaceRoot,
    activity: (cap, input, ctx, paths, before, ids, succeeded) => history!.executed(ctx.turnId, cap, input, paths, before, ids, succeeded),
    activeTurn: () => activeTurn && turnSignal ? { turnId: activeTurn, signal: turnSignal } : undefined,
    onExecution: (event) => {
      if (!activeAccumulator || event.turnId !== activeTurn) return;
      if (event.risk !== "read") activeAccumulator.nonReadExecuted = true;
      if (event.succeeded) activeAccumulator.tools.success(event.toolCallId);
      if (event.phase === "end" && event.afterStop && event.risk !== "read") {
        for (const path of event.paths) activeAccumulator.writesAfterStop.add(path);
        activeAccumulator.capabilitiesAfterStop.add(event.capability);
      }
    },
    policy: opts.approvalPolicy ?? defaultApprovalPolicy(), broker: approvals,
    proposals: proposalStore.controller, snapshots, audit, trace,
    executionJournal,
    ...(executorVersioning ? { versioning: executorVersioning } : {}),
  };
  history = new TurnHistory({ root: manifest.workspaceRoot, recorder, snapshots, versioning, restoreVersion: restoreTurnVersion,
    largeFileCeiling: opts.versioning?.enabled ? opts.versioning.largeFileCeiling ?? DEFAULT_LARGE_FILE_CEILING : undefined,
    audit: (event) => audit.record(event) as Promise<void>,
    emit: (activity) => events.emit({ type: "turn.activity", turnId: activity.turnId, activity }),
    active: () => activeTurn,
    writable: () => proposalStore.controller.ensureWritable(),
    cancel: async (turnId) => {
      const cancellations = await proposalStore.controller.cancelTurn(turnId);
      if (cancellations.some((result) => result.refused === "store-locked")) return "store-read-only";
      if (cancellations.some((result) => result.refused === "adoption-in-flight")) return "adoption-in-flight";
      approvals.cancelTurn(turnId);
      await proposalStore.controller.waitForTurn(turnId);
      approvals.finishTurn(turnId);
      await proposalStore.controller.finishTurn(turnId);
    },
  });
  await history.load();

  const triggerRef = { current: INTERACTIVE };
  const sessionFactory = opts.session ?? opts._sessionFactory ?? createBridleSession;
  const imageNormalizer = opts.imageNormalizer ?? new SharpImageNormalizer();
  const { session: createdSession, capabilities, toolOutcomes, toolPathResolutions, toolCallIdentity } = await sessionFactory({
    manifest, auth,
    agentDir: opts.appDataDir,
    ...(recording === "off" ? {} : { sessionDir: join(opts.appDataDir, "sessions") }),
    ...(opts.sessionResume ? { sessionResume: opts.sessionResume } : {}),
    provider: opts.provider, modelId: opts.modelId, modelService, thinkingLevel: opts.thinkingLevel,
    deps, trigger: INTERACTIVE, triggerRef,
    ...(composition ? { composition } : {}),
  });
  session = createdSession;
  // Sol F1 (P0): never record a scoped envelope for a session that didn't run
  // scoped. Whenever the session exposes its registered tool set, verify it
  // matches the composition exactly; a factory that ignored the composition is
  // a startup error, not a silently lying record.
  if (composition?.activeSkill) {
    const accessor = (session as { getActiveToolNames?: () => string[] }).getActiveToolNames;
    if (typeof accessor === "function") {
      const expected = new Set(discoverManifestTools(manifest, composition).visible().map((cap) => wireName(cap.name)));
      const actual = accessor.call(session);
      const unexpected = actual.filter((name) => !expected.has(name));
      const missing = [...expected].filter((name) => !actual.includes(name));
      if (unexpected.length > 0 || missing.length > 0) {
        session.dispose();
        throw new Error(
          `Session factory did not honour the composition's skill scope for "${composition.activeSkill.name}"` +
          `${unexpected.length ? ` — registered out-of-scope tools: ${unexpected.join(", ")}` : ""}` +
          `${missing.length ? ` — missing scoped tools: ${missing.join(", ")}` : ""}.`,
        );
      }
    }
  }
  // Sol F2: the relay resolves tool events against the SESSION's capability set —
  // an event naming an out-of-scope capability must not become a trusted
  // tool_start/tool_end. Proposal preview/adoption keeps the full map (adoption
  // is an explicit user action and durable Proposals may predate the skill).
  const sessionCapabilities = composition?.activeSkill
    ? new Map(discoverManifestTools(manifest, composition).capabilities.map((cap) => [cap.name, cap]))
    : capabilities;
  bindSnapshotSession(snapshots, session.sessionId);
  proposalStore.controller.bind({
    async adopt(proposal, signal) {
      const capability = capabilities.get(proposal.capability);
      if (!capability) {
        return { result: { text: `Proposal ${proposal.id} names an unknown capability: ${proposal.capability}`, isError: true }, denied: true };
      }
      const execution = await executeCapabilityDetailed(capability, proposal.payload, {
        trigger: { id: "adoption", source: "user", trust: "interactive", label: "proposal adoption" },
        sessionId: session.sessionId,
        turnId: proposal.turnId,
        signal,
        toolCallId: proposal.toolCallId,
        adoption: true,
        proposalId: proposal.id,
        proposalBaseline: proposal.baseline,
      }, deps);
      return {
        ...execution,
        touchedPaths: execution.touchedPaths ?? [],
      };
    },
    async preview(proposal) {
      const capability = capabilities.get(proposal.capability);
      if (!capability) throw new Error(`Proposal ${proposal.id} names an unknown capability: ${proposal.capability}`);
      return deriveProposalPreview(proposal, capability, { trace, audit: { record: (event) => audit.record({ ...event, turnId: proposal.turnId }) } });
    },
  });
  const appendEnvelope = () => {
    if (!recorder) return;
    const sessionManager = (session as Partial<AgentSession>).sessionManager;
    if (!sessionManager) {
      throw new Error("Pi AgentSession did not expose SessionManager for Flight Recorder envelope.");
    }
    const model = session.model;
    // S4: a skill-bound instance records its SCOPED reality — the narrowed
    // prompt and catalogue the session actually ran with, never the full manifest.
    const envelopeCapabilities = discoverManifestTools(manifest, composition).visible();
    sessionManager.appendCustomEntry("bridle.envelope", {
      recorderVersion: 1,
      bridleVersion: BRIDLE_VERSION,
      lane,
      appId: manifest.appId,
      manifestHash: recorderManifestHash(manifest),
      ...(composition?.activeSkill ? { activeSkillId: composition.activeSkill.name } : {}),
      systemPrompt: buildSystemPrompt(manifest, composition),
      toolCatalog: envelopeCapabilities.map((capability) => ({
        wireName: wireName(capability.name),
        description: capability.description,
        parametersJsonSchema: JSON.parse(JSON.stringify(capability.parameters)),
        risk: capability.risk,
      })),
      provider: model?.provider ?? opts.provider ?? "unknown",
      modelId: model?.id ?? opts.modelId ?? "unknown",
      thinkingLevel: session.thinkingLevel ?? opts.thinkingLevel ?? "medium",
    });
  };
  appendEnvelope();
  const piRelay = createPiEventRelay({
    events,
    trace,
    activeTurn: () => activeTurn,
    capabilities: sessionCapabilities,
    toolOutcomes,
    toolPathResolutions,
    toolCallIdentity,
    onAssistantMessage: (text, toolCallIds) => { activeAnswerText = text; activeAccumulator?.tools.assistant(text, toolCallIds); },
    onReasoning: (reasoning) => { activeReasoning = reasoning; },
    onRetryStart: () => { activeFailure = undefined; activeStopReason = undefined; activeFinalAnswer = false; activeAnswerText = ""; },
    onAssistantStatus: (message) => {
      activeStopReason = message.stopReason;
      activeFinalAnswer = message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "toolUse" && message.stopReason !== "length" && activeAnswerText.trim().length > 0;
      activeFailure = message.stopReason === "error" || message.stopReason === "aborted" ? turnFailureReason(message, turnSignal?.aborted === true) : undefined;
    },
    onUsage: (usage: Usage, stopReason) => {
      activeStopReason = stopReason;
      if (!activeAccumulator) return;
      activeAccumulator.usageSeen = true;
      activeAccumulator.usage.input += usage.input;
      activeAccumulator.usage.output += usage.output;
      activeAccumulator.usage.cacheRead += usage.cacheRead;
      activeAccumulator.usage.cacheWrite += usage.cacheWrite;
      if (usage.cost?.total !== undefined) {
        activeAccumulator.usage.costSeen = true;
        activeAccumulator.usage.costUsd += usage.cost.total;
      }
    },
    onRelayAudit: ({ type, payload }) => {
      if (!recorder) return;
      void audit.record({
        type, timestamp: Date.now(), sessionId: session.sessionId,
        ...(activeTurn ? { turnId: activeTurn } : {}),
        metadata: { event: payload },
      });
    },
  });
  session.subscribe(piRelay);
  events.subscribe((event) => {
    if (!activeAccumulator || event.type !== "tool_end" || event.turnId !== activeTurn) return;
    if (event.result === "error") activeAccumulator.tools.error(event.toolCallId);
    if (event.result === "error" && !activeAccumulator.toolErrors.has(event.toolCallId)) activeAccumulator.toolErrors.set(event.toolCallId, { capability: event.capability, toolCallId: event.toolCallId, message: event.message ?? "Tool failed." });
    if (event.result === "denied") activeAccumulator.callsDenied += 1;
    if (event.result === "staged") activeAccumulator.callsStaged += 1;
    if (event.result !== "ok") return;
    activeAccumulator.tools.success(event.toolCallId);
    if (event.risk !== "read") activeAccumulator.nonReadExecuted = true;
    const target = event.risk === "read" ? activeAccumulator.filesRead : activeAccumulator.filesWritten;
    for (const path of event.paths ?? []) target.add(path);
  });

  let lastRestorePoint: string | null = null;
  let disposed = false;
  const abortedTurns = new Set<TurnId>();

  const runPrompt = async (
    text: string,
    promptOpts: { trigger?: AgentTrigger; context?: ContextItem[] } = {},
  ): Promise<TurnResult> => {
    // A prompt queued before dispose() never starts; it settles with the typed disposed error.
    if (disposed) throw new BridleDisposedError();
    const trigger = promptOpts.trigger ?? INTERACTIVE;
    const startedAt = Date.now();
    let checkpointId: string | undefined;
    let checkpointFailed = false;
    let checkpointError: unknown;
    if (versioning && mode !== "read-only" && trigger.trust !== "background") {
      try {
        const checkpoint = await versioning.takeCheckpoint({ label: `turn: ${text.slice(0, 60)}`, fullRehash: true });
        if (checkpoint.report.uncaptured.length) throw new Error("The turn checkpoint did not capture the whole workspace.");
        checkpointId = checkpoint.id;
      } catch (error) {
        checkpointFailed = true; checkpointError = error;
      }
    }
    const context = await resolveContextItems({
      text, items: checkpointFailed ? [] : promptOpts.context ?? [], manifest, capabilities,
      trigger, sessionId: session.sessionId, deps,
      modelInput: session.model?.input ?? ["text"], imageNormalizer,
    });
    // Disposal during asynchronous context preparation cancels the turn before the provider is called.
    if (disposed) throw new BridleDisposedError();
    const providerText = context.providerText;
    const turnId = randomUUID();
    const turnThinkingLevel = publicThinkingLevel(session.thinkingLevel, opts.thinkingLevel ?? "medium");
    let responder: TurnResponder = { providerId: opts.provider ?? "unknown", modelId: opts.modelId ?? "unknown", authLane: "none" };
    let outcome: TurnOutcome = "completed";
    let receipt!: TurnReceipt;
    // Lifecycle failures (turn.start/turn.end audit, restore point, recorder flush) settle the prompt
    // as a rejection. The first is the rejection reason; any later ones are traced, never dropped.
    const lifecycleErrors: Array<{ stage: string; error: unknown }> = [];
    let unsubscribeContext: (() => void) | undefined;
    activeTurn = turnId;
    turnSignal = proposalStore.controller.beginTurn(turnId);
    turnClosing = false;
    activeFailure = undefined;
    try {
      activeAnswerText = "";
      activeReasoning = "";
      activeStopReason = undefined;
      activeFinalAnswer = false;
      activeAccumulator = {
        filesRead: new Set(), filesWritten: new Set(), callsDenied: 0, callsStaged: 0,
        tools: new TurnToolOutcomes(), nonReadExecuted: false, toolErrors: new Map(), writesAfterStop: new Set(), capabilitiesAfterStop: new Set(), usageSeen: false,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costSeen: false },
      };
      for (const path of context.filesRead) activeAccumulator.filesRead.add(path);
      triggerRef.current = trigger;
      try {
        try {
          const model = session.model;
          responder = {
            providerId: model?.provider ?? opts.provider ?? "unknown",
            modelId: model?.id ?? opts.modelId ?? "unknown",
            ...((session.thinkingLevel === "minimal" || session.thinkingLevel === "low" || session.thinkingLevel === "medium" || session.thinkingLevel === "high" || opts.thinkingLevel) ? { thinkingLevel: turnThinkingLevel } : {}),
            authLane: "none",
          };
          responder.authLane = auth.authLane(responder.providerId, session.modelRuntime?.getProviderAuthStatus(responder.providerId));
        } catch (error) { activeFailure = turnFailureReason(error); }
        events.emit({
          type: "turn_start", turnId, lane, trigger, promptPreview: text,
          // S7: the Trace shows which skill ran the turn (skill-bound instance = every turn).
          ...(composition?.activeSkill ? { activeSkillId: composition.activeSkill.name } : {}),
        });
        await audit.record({
          type: "turn.start", timestamp: Date.now(), sessionId: session.sessionId,
          turnId, prompt: providerText, trigger, responder, outcome: "pending",
          metadata: { mode },
        });
        await history!.start({ turnId, startedAt, responder, mode }, session.sessionId);
        await history!.contextReads(turnId, context.filesRead, manifest.contextReader ?? "context");
        if (checkpointFailed) throw checkpointError;
        lastRestorePoint = await snapshots.beginRestorePoint(`turn: ${text.slice(0, 60)}`, session.sessionId);
        await history!.protect(turnId, lastRestorePoint, checkpointId);
        // Pi 0.83 emits these events before appendMessage, using the same message object
        // as its live state. Annotate only this prompt's first user message, before disk flush.
        let userMessage: object | undefined;
        unsubscribeContext = session.subscribe((event) => {
          if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "user") {
            userMessage ??= event.message;
            if (event.message === userMessage) Object.assign(event.message, context.split);
          }
        });
        try {
          if (!abortedTurns.has(turnId) && !activeFailure) await session.prompt(providerText, context.images.length ? { images: context.images } : undefined);
          if (abortedTurns.has(turnId) || turnSignal?.aborted) {
            outcome = "aborted";
            activeFailure = "aborted";
          } else if (activeFailure || activeStopReason === "error") {
            outcome = "error";
            activeFailure ??= "provider-error";
          } else if (activeAccumulator.tools.unansweredError || activeStopReason === "length" && activeAccumulator.toolErrors.size) {
            outcome = "error";
            activeFailure = "tool-error";
          } else if (activeStopReason === "length" && activeAnswerText.trim()) {
            activeFailure = "truncated";
          } else if (!activeFinalAnswer) {
            if (activeAccumulator.tools.successfulTool) activeFailure = "no-text";
            else {
              outcome = "error";
              activeFailure = activeAccumulator.toolErrors.size ? "tool-error" : "no-answer";
            }
          }
          if (outcome === "error") events.emit({ type: "turn_error", turnId, message: `Turn failed: ${activeFailure}.`, recoverable: !activeAccumulator.nonReadExecuted });
        } catch (error) {
          if (abortedTurns.has(turnId)) {
            outcome = "aborted";
            activeFailure = "aborted";
          } else {
            activeFailure = turnFailureReason(error, turnSignal?.aborted === true);
            outcome = activeFailure === "aborted" ? "aborted" : "error";
            events.emit({
              type: "turn_error", turnId,
              message: error instanceof Error ? error.message : String(error), recoverable: !activeAccumulator.nonReadExecuted,
            });
          }
        }
      } catch (error) {
        // Opening failed (turn.start audit or restore point); the provider was never called.
        outcome = "error";
        activeFailure = checkpointFailed ? "checkpoint-failed" : activeFailure ?? "tool-error";
        if (!checkpointFailed) lifecycleErrors.push({ stage: "turn.open", error });
        events.emit({
          type: "turn_error", turnId,
          message: error instanceof Error ? error.message : String(error), recoverable: !activeAccumulator.nonReadExecuted,
        });
      } finally {
        turnClosing = true;
        unsubscribeContext?.();
        if (abortedTurns.has(turnId)) {
          outcome = "aborted";
          activeFailure = "aborted";
          try { await proposalStore.controller.cancelTurn(turnId); await proposalStore.controller.waitForTurn(turnId); }
          catch (error) { lifecycleErrors.push({ stage: "turn.cancel", error }); }
        }
        await Promise.allSettled([...inTurnAdoptions]);
        await Promise.all(observerAudits);
        const accumulator = activeAccumulator!;
        const usage = {
          input: accumulator.usage.input,
          output: accumulator.usage.output,
          cacheRead: accumulator.usage.cacheRead,
          cacheWrite: accumulator.usage.cacheWrite,
          ...(accumulator.usage.costSeen ? { costUsd: accumulator.usage.costUsd } : {}),
        };
        receipt = {
          turnId, lane, outcome, responder, ...(activeFailure ? { reason: activeFailure } : {}),
          thinkingLevel: turnThinkingLevel,
          filesRead: [...accumulator.filesRead], filesWritten: [...accumulator.filesWritten],
          callsDenied: accumulator.callsDenied, callsStaged: accumulator.callsStaged,
          ...(accumulator.usageSeen ? { usage } : {}),
          toolErrors: [...accumulator.toolErrors.values()],
          ...(activeStopReason === "length" ? { truncated: true } : {}),
          ...(accumulator.writesAfterStop.size ? { writesAfterStop: [...accumulator.writesAfterStop] } : {}),
          ...(accumulator.capabilitiesAfterStop.size ? { capabilitiesAfterStop: [...accumulator.capabilitiesAfterStop] } : {}),
          egress: {
            providerId: responder.providerId,
            modelId: responder.modelId,
            egressClass: "remote",
            dataSent: { contextItems: promptOpts.context?.length ?? 0, filesReadCount: accumulator.filesRead.size, promptChars: providerText.length },
          },
          durationMs: Date.now() - startedAt,
        };
        try { await history!.end(turnId, outcome, activeFailure, [...accumulator.toolErrors.values()]); }
        catch (error) { lifecycleErrors.push({ stage: "turn.activity", error }); }
        events.emit({ type: "turn_end", turnId, receipt });
        try {
          await audit.record({
            type: "turn.end", timestamp: Date.now(), sessionId: session.sessionId, turnId, receipt, responder, outcome, ...(accumulator.usageSeen ? { usage } : {}), ...(activeFailure ? { reason: activeFailure } : {}),
            // ADR-0024: the turn's reasoning is recorded evidence, surfaced by turns().
            ...(activeReasoning ? { reasoning: activeReasoning } : {}),
          });
        } catch (error) {
          lifecycleErrors.push({ stage: "turn.end", error });
        }
        try {
          await recorder?.flush();
        } catch (error) {
          lifecycleErrors.push({ stage: "recorder.flush", error });
        }
      }
    } finally {
      // Innermost unconditional cleanup: whatever failed above, the harness accepts the next prompt.
      activeTurn = null;
      approvals.finishTurn(turnId);
      try { await proposalStore.controller.finishTurn(turnId); } catch (error) { lifecycleErrors.push({ stage: "turn.prune", error }); }
      turnSignal = undefined;
      turnClosing = false;
      activeAccumulator = null;
      abortedTurns.delete(turnId);
    }
    const [firstFailure, ...laterFailures] = lifecycleErrors;
    if (firstFailure) {
      for (const { stage, error } of laterFailures) {
        trace({
          type: "turn.lifecycle_error", title: "Turn recording step failed after an earlier failure",
          metadata: { turnId, stage, message: error instanceof Error ? error.message : String(error) },
        });
      }
      throw firstFailure.error;
    }
    return { turnId, outcome, ...(receipt.reason ? { reason: receipt.reason } : {}), answerText: activeAnswerText, receipt };
  };

  const handle: Bridle = {
    get mode() { return mode; },
    setMode(nextMode) {
      if (disposed) throw new BridleDisposedError();
      if (!["suggest", "work", "read-only"].includes(nextMode)) throw new Error("Unknown Bridle mode.");
      const previous = mode; mode = nextMode;
      recordObserver({ type: "mode.changed", timestamp: Date.now(), sessionId: session.sessionId, metadata: { previous, mode } });
    },
    turns: {
      list: history.list,
      get: history.get,
      undo(turnId, options) {
        if (disposed) return Promise.reject(new BridleDisposedError());
        if (activeTurn) return Promise.resolve({ undone: false, reason: "turn-active" });
        const result = promptQueue.then(() => {
          if (disposed) throw new BridleDisposedError();
          const operation = history!.undo(turnId, options);
          inFlightUndo = operation;
          return operation.finally(() => { inFlightUndo = undefined; });
        });
        promptQueue = result.then(() => {}, () => {});
        return result;
      },
    },
    unsafeSession: session, approvals, proposals, snapshots, auth, models: modelService, auditEvents, events, recording,
    executions: Object.freeze({ unknown: () => executionJournal.unknown() }),
    ...(versioning ? { versioning } : {}),
    get proposalStore() { return proposalStore.state; },
    get activeTurn() { return activeTurn; },
    get lane() { return lane; },
    get sessionId() { return session.sessionId; },
    get model() {
      const model = session.model;
      if (model) return { providerId: model.provider, modelId: model.id };
      return opts.provider && opts.modelId ? { providerId: opts.provider, modelId: opts.modelId } : null;
    },
    get thinkingLevel() { return publicThinkingLevel(session.thinkingLevel, opts.thinkingLevel ?? "medium"); },
    transcript(options = {}) {
      const transcript: BridleTranscriptMessage[] = [];
      for (const message of session.messages) {
        const projected = publicTranscriptMessage(message, options);
        if (projected) transcript.push(projected);
      }
      return transcript;
    },
    /**
     * Prompts are serialized per session: Pi's AgentSession processes one prompt
     * at a time, so the mutable `triggerRef` set here (read by the tool-runner
     * closure in runtime-pi.ts on every capability call during this prompt) is
     * safe only because there is never more than one in-flight `prompt()` call
     * against the same session.
     */
    prompt(text, promptOpts = {}) {
      if (disposed) return Promise.reject(new BridleDisposedError());
      const result = promptQueue.then(() => runPrompt(text, promptOpts));
      promptQueue = result.then(() => undefined, () => undefined);
      return result;
    },
    abort(turnId) {
      if (turnId !== activeTurn || turnClosing) return false;
      abortedTurns.add(turnId);
      void proposalStore.controller.cancelTurn(turnId).catch(() => {});
      approvals.cancelTurn(turnId);
      piRelay.clearThinkingTimers(turnId);
      piRelay.clearToolPathResolutions();
      void session.abort().catch((error) => trace({
        type: "session.abort_error", title: "Runtime abort failed",
        metadata: { message: error instanceof Error ? error.message : String(error) },
      }));
      return true;
    },
    async setModel(providerId, modelId) {
      if (disposed) throw new BridleDisposedError();
      await session.setModel(modelService.resolve(providerId, modelId));
      appendEnvelope();
    },
    async setThinkingLevel(level) {
      if (disposed) throw new BridleDisposedError();
      await Promise.resolve(session.setThinkingLevel(level));
      appendEnvelope();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      const step = async (run: () => unknown): Promise<void> => {
        try { await run(); } catch (error) { failures.push(error); }
      };
      let aborting: Promise<void> = Promise.resolve();
      if (activeTurn) {
        abortedTurns.add(activeTurn);
        void proposalStore.controller.cancelTurn(activeTurn).catch(() => {});
        approvals.cancelTurn(activeTurn);
        piRelay.clearThinkingTimers(activeTurn);
        piRelay.clearToolPathResolutions();
        aborting = Promise.resolve().then(() => session.abort()).catch((error) => {
          trace({ type: "session.abort_error", title: "Runtime abort failed during dispose",
            metadata: { message: error instanceof Error ? error.message : String(error) } });
        });
      }
      // Local restores must finish while proposal and recording stores are still open.
      await step(() => inFlightUndo);
      const deadline = Date.now() + PROPOSAL_CLOSE_TIMEOUT_MS;
      // Closing releases stuck proposal waiters before waiting for the prompt queue.
      await step(() => proposalStore.controller.close());
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([aborting, promptQueue]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); }),
      ]).finally(() => clearTimeout(timer));
      // Every cleanup step runs even if an earlier one fails; the first failure is rethrown afterwards.
      // Ownership follows construction: the harness disposes only a model service it created.
      await step(() => { if (ownsModelService) modelService.dispose(); });
      await step(() => { piRelay.clearThinkingTimers(); piRelay.clearToolPathResolutions(); });
      await step(() => session.dispose());
      await step(() => Promise.all(observerAudits));
      await step(() => recorder?.flush());
      await step(() => executionJournal.close());
      if (failures.length > 0) throw failures[0];
    },
    async restoreLastTurn() {
      if (disposed) throw new BridleDisposedError();
      const latest = (await history.list())[0];
      const active = activeTurn;
      if (active) {
        const path = await history.activePath();
        throw new RestoreRefusedError(active, path ? [{ path, reason: "turn-active" }] : [], { reason: "turn-active" });
      }
      const root = manifest.workspaceRoot;
      if (root) {
        if (!latest) throw new RestoreRefusedError("latest-turn", [{ path: root, reason: "undo-unavailable" }]);
        const result = await handle.turns.undo(latest.turnId);
        if (result.undone) return result.paths.map((path) => resolve(root, path));
        let path = result.path ?? root;
        if (result.path && result.reason !== "outside-workspace") path = resolve(root, result.path);
        throw new RestoreRefusedError(latest.turnId, [{ path, reason: result.reason }]);
      }
      if (!lastRestorePoint) {
        const points = (await snapshots.entries()).filter((e) => e.kind === "restore-point");
        lastRestorePoint = points.at(-1)?.id ?? null;
      }
      if (!lastRestorePoint) return [];
      return snapshots.restoreTo(lastRestorePoint, { origin: "turn" });
    },
  };
  Object.defineProperty(handle, "lane", {
    configurable: false,
    enumerable: true,
    get: () => lane,
  });
  return handle;
  } catch (error) {
    await proposalStore.controller.close().catch(() => {});
    await executionJournal.close().catch(() => {});
    throw error;
  }
}
