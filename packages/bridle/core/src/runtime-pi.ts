import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai/compat";
import { BridleEventEmitter } from "./events.ts";
import type { TurnId } from "./events.ts";
import { assertWireNamesUnique, buildSystemPrompt, scopedCapabilities, wireName, type PromptComposition } from "./manifest.ts";
import { executeCapabilityDetailed, freezeTouchedPaths, type ExecutorDeps } from "./executor.ts";
import type { AgentTrigger, ApprovalDenialReason, Capability, CapabilityResult, Manifest } from "./types.ts";
import { prepareAuthProvider, type BridleAuth } from "./auth.ts";
import { createModelService, type BridleModelService } from "./model-listing.ts";

export type ToolRelayOutcome = {
  result: "ok" | "error" | "denied" | "staged";
  message?: string;
  denialReason?: ApprovalDenialReason;
  paths?: readonly string[];
};

export type ToolCallIdentityClassification = "verified-unique" | "untrusted";

/**
 * Identity behaviour for every text API in Pi's pinned built-in provider catalogue.
 * The runtime test compares these keys with the catalogue so a new adapter cannot
 * inherit trust accidentally.
 */
export const PI_TOOL_CALL_IDENTITY_CLASSIFICATIONS = {
  "anthropic-messages": "provider-id",
  "openai-responses": "provider-id",
  "azure-openai-responses": "provider-id",
  "openai-codex-responses": "provider-id",
  "openai-completions": "untrusted",
  "bedrock-converse-stream": "provider-id-or-empty",
  "pi-messages": "provider-id",
  "google-generative-ai": "provider-id-or-generated",
  "google-vertex": "provider-id-or-generated",
  "mistral-conversations": "untrusted",
  "bridle-scripted": "provider-id",
} as const;

export function classifyToolCallIdentity(
  api: string | undefined,
  toolCallId: string,
  toolWireName: string,
): ToolCallIdentityClassification {
  if (!toolCallId) return "untrusted";
  const classification = PI_TOOL_CALL_IDENTITY_CLASSIFICATIONS[
    api as keyof typeof PI_TOOL_CALL_IDENTITY_CLASSIFICATIONS
  ];
  if (!classification) return "untrusted";
  if (classification === "untrusted") return "untrusted";
  if (classification === "provider-id-or-generated") {
    const escapedName = toolWireName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escapedName}_[0-9]+_[0-9]+$`).test(toolCallId)
      ? "untrusted"
      : "verified-unique";
  }
  return "verified-unique";
}

export function createResponseToolCallIdentityResolver(): {
  observe(event: AgentSessionEvent): void;
  classify(toolCallId: string, toolWireName: string): ToolCallIdentityClassification;
} {
  // Identity follows the assistant response that carried the tool call. Mutable
  // session model state is deliberately absent, preserving stable attempt
  // identity when a resumed session selects another model before redelivery.
  const responseApis = new Map<string, string>();
  return {
    observe(event) {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      for (const content of event.message.content) {
        if (content.type === "toolCall") responseApis.set(content.id, event.message.api);
      }
    },
    classify(toolCallId, toolWireName) {
      return classifyToolCallIdentity(responseApis.get(toolCallId), toolCallId, toolWireName);
    },
  };
}

export function toolRelayOutcome(
  result: CapabilityResult,
  relay: ToolRelayOutcome["result"],
  paths: readonly string[] | undefined,
): ToolRelayOutcome {
  const denial = relay === "denied" ? result.denialReason : undefined;
  return {
    result: relay,
    message: result.text,
    ...(denial ? { denialReason: denial } : {}),
    ...(paths ? { paths } : {}),
  };
}

export type PiEventRelay = ((event: AgentSessionEvent) => void) & {
  clearThinkingTimers(turnId?: TurnId): void;
  clearToolPathResolutions(): void;
};

export type TouchedPathsResolution = readonly string[] | Promise<readonly string[]>;

function currentLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Every Pi event type in the pinned 0.83.0 AgentSession surface. This list is
 * intentionally exhaustive: a Pi upgrade that introduces another relay class
 * must choose session substitution or durable audit before it can compile.
 */
export const RELAY_EVENT_CLASSES = [
  "agent_start", "agent_end", "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_update", "tool_execution_end",
  "queue_update", "compaction_start", "session_info_changed", "thinking_level_changed",
  "compaction_end", "auto_retry_start", "auto_retry_end", "agent_settled", "entry_appended",
  "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
  "bash_execution_update",
] as const;

/** Classes whose complete model-relevant payload is recoverable from Pi session entries. */
export const SESSION_SUBSTITUTION_CLASSES = [
  "agent_start", "agent_end", "turn_start", "turn_end",
  "message_start", "message_update", "message_end",
  "tool_execution_start", "tool_execution_end", "compaction_start",
  "session_info_changed", "thinking_level_changed", "compaction_end", "entry_appended",
] as const;

/** Classes Pi does not persist as session entries and must therefore enter recorder audit. */
export const DURABLE_RELAY_CLASSES = [
  "tool_execution_update", "auto_retry_start", "auto_retry_end", "queue_update", "agent_settled",
  "summarization_retry_scheduled", "summarization_retry_attempt_start", "summarization_retry_finished",
  "bash_execution_update",
] as const;

type DeclaredRelayClass = typeof RELAY_EVENT_CLASSES[number];
type SessionSubstitutionClass = typeof SESSION_SUBSTITUTION_CLASSES[number];
type DurableRelayClass = typeof DURABLE_RELAY_CLASSES[number];
type Assert<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type MissingRelayClass = Exclude<AgentSessionEvent["type"], DeclaredRelayClass>;
const relayClassesCoverPi: MissingRelayClass extends never ? true : never = true;
void relayClassesCoverPi;
type PiClassesCoverRelay = Assert<Equal<DeclaredRelayClass, AgentSessionEvent["type"]>>;
type PersistencePathsCoverRelay = Assert<Equal<SessionSubstitutionClass | DurableRelayClass, DeclaredRelayClass>>;
type PersistencePathsAreDisjoint = Assert<Equal<Extract<SessionSubstitutionClass, DurableRelayClass>, never>>;
const relayPartitionTypeProof: [PiClassesCoverRelay, PersistencePathsCoverRelay, PersistencePathsAreDisjoint] = [true, true, true];
void relayPartitionTypeProof;

/** Exhaustive runtime persistence decision; adding a Pi class requires a path. */
export const RELAY_PERSISTENCE_PATHS = {
  agent_start: "session", agent_end: "session", turn_start: "session", turn_end: "session",
  message_start: "session", message_update: "session", message_end: "session",
  tool_execution_start: "session", tool_execution_update: "audit", tool_execution_end: "session",
  queue_update: "audit", compaction_start: "session", session_info_changed: "session",
  thinking_level_changed: "session", compaction_end: "session", auto_retry_start: "audit", auto_retry_end: "audit",
  agent_settled: "audit", entry_appended: "session", summarization_retry_scheduled: "audit",
  summarization_retry_attempt_start: "audit", summarization_retry_finished: "audit", bash_execution_update: "audit",
} as const satisfies Record<DeclaredRelayClass, "session" | "audit">;

/**
 * The only relay-envelope positions that are credentials. Model-visible
 * payloads are intentionally absent: if Pi can show it to the model, the
 * Flight Recorder must retain it verbatim.
 */
export const REDACTION_PATHS = [
  "transport.headers.authorization", "transport.headers.proxy-authorization", "transport.api_key", "transport.apikey",
  "request.headers.authorization", "request.headers.proxy-authorization", "request.api_key", "request.apikey",
  "connection.headers.authorization", "connection.headers.proxy-authorization", "connection.api_key", "connection.apikey",
  "auth.authorization", "auth.api_key", "auth.apikey",
  "credentials.authorization", "credentials.api_key", "credentials.apikey",
] as const;

const REDACTION_PATH_SET = new Set<string>(REDACTION_PATHS);

function redactCredentialFields(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => redactCredentialFields(item, path));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key, REDACTION_PATH_SET.has([...path, key].map((part) => part.toLowerCase()).join("."))
      ? "[redacted:credential]" : redactCredentialFields(nested, [...path, key]),
  ]));
}

function assistantText(message: unknown): string {
  if (!message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => (
      typeof part === "object" && part !== null && (part as { type?: string }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("");
}

/**
 * ADR-0024: the model's reasoning (Pi `ThinkingContent` blocks). Captured for the
 * recorder + the human inspector — it never enters the typed `transcript()` /
 * `TurnResult` surface that other agents see (ADR-0019).
 */
function assistantReasoning(message: unknown): string {
  if (!message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "thinking"; thinking: string } => (
      typeof part === "object" && part !== null && (part as { type?: string }).type === "thinking"
      && typeof (part as { thinking?: unknown }).thinking === "string"
    ))
    .map((part) => part.thinking)
    .join("\n");
}

export function createPiEventRelay(opts: {
  events: BridleEventEmitter;
  trace: ExecutorDeps["trace"];
  activeTurn: () => TurnId | null;
  capabilities: Map<string, Capability>;
  toolOutcomes: Map<string, ToolRelayOutcome>;
  toolPathResolutions?: Map<string, TouchedPathsResolution>;
  toolCallIdentity?: (toolCallId: string, toolWireName: string) => ToolCallIdentityClassification;
  onAssistantMessage?: (text: string) => void;
  onReasoning?: (reasoning: string) => void;
  onUsage?: (usage: Usage, stopReason: string) => void;
  onRelayAudit?: (entry: { type: string; payload: unknown }) => void;
}): PiEventRelay {
  const thinkingByTurn = new Map<TurnId, { summary: string; lastEmit: number; timer?: ReturnType<typeof setTimeout> }>();
  const toolPathResolutions = opts.toolPathResolutions ?? new Map<string, TouchedPathsResolution>();
  const capabilityForWireName = (name: string) => [...opts.capabilities.values()].find((cap) => wireName(cap.name) === name);
  const clearThinkingTimers = (turnId?: TurnId) => {
    for (const [id, state] of thinkingByTurn) {
      if (turnId && id !== turnId) continue;
      if (state.timer) clearTimeout(state.timer);
      thinkingByTurn.delete(id);
    }
  };
  const relay = ((event: AgentSessionEvent) => {
    if (!(RELAY_EVENT_CLASSES as readonly string[]).includes(event.type)) {
      throw new Error(`Unclassified Pi relay event type: ${event.type}`);
    }
    const payload = redactCredentialFields(event);
    opts.trace({ type: `pi.${event.type}`, title: event.type, metadata: { event: payload } });
    if (RELAY_PERSISTENCE_PATHS[event.type] === "audit") {
      opts.onRelayAudit?.({ type: `relay.${event.type}`, payload });
    }
    const turnId = opts.activeTurn();
    if (event.type === "turn_end" || event.type === "agent_end") {
      toolPathResolutions.clear();
    }
    if (event.type === "message_update" && turnId && event.message.role === "assistant"
      && event.assistantMessageEvent.type === "text_delta") {
      opts.events.emit({ type: "assistant_delta", turnId, text: event.assistantMessageEvent.delta });
      return;
    }
    if (event.type === "message_update" && turnId && event.message.role === "assistant"
      && event.assistantMessageEvent.type === "thinking_delta") {
      const state = thinkingByTurn.get(turnId) ?? { summary: "", lastEmit: 0 };
      state.summary += event.assistantMessageEvent.delta;
      const elapsed = Date.now() - state.lastEmit;
      if (state.lastEmit === 0 || elapsed >= 500) {
        state.lastEmit = Date.now();
        opts.events.emit({ type: "thinking_summary", turnId, summary: state.summary });
      } else if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = undefined;
          state.lastEmit = Date.now();
          opts.events.emit({ type: "thinking_summary", turnId, summary: state.summary });
        }, 500 - elapsed);
      }
      thinkingByTurn.set(turnId, state);
      return;
    }
    if (event.type === "message_end" && turnId && event.message.role === "assistant") {
      clearThinkingTimers(turnId);
      // Emit the authoritative final reasoning as the last thinking_summary. The
      // throttled delta path can leave the last <500ms of thinking buffered in a
      // timer that clearThinkingTimers cancels un-emitted; this flushes the tail
      // and hands the complete reasoning to the recorder (ADR-0024).
      const reasoning = assistantReasoning(event.message);
      if (reasoning) opts.events.emit({ type: "thinking_summary", turnId, summary: reasoning });
      opts.onReasoning?.(reasoning);
      const text = assistantText(event.message);
      opts.events.emit({ type: "assistant_message", turnId, text });
      opts.onAssistantMessage?.(text);
      opts.onUsage?.(event.message.usage, event.message.stopReason);
      return;
    }
    if (event.type === "tool_execution_start" && turnId) {
      const capability = capabilityForWireName(event.toolName);
      if (!capability) return;
      const emitStart = (paths?: readonly string[]) => opts.events.emit({
        type: "tool_start", turnId, toolCallId: event.toolCallId,
        capability: capability.name, risk: capability.risk,
        inputPreview: JSON.stringify(event.args).slice(0, 1_000),
        ...(paths?.length ? { paths } : {}),
      });
      // This pre-resolution is sound only because every write-capable Pi tool
      // uses sequential executionMode; no second write can change workspace
      // discovery between this event and the executor consuming the resolution.
      const trustedIdentity = opts.toolCallIdentity?.(event.toolCallId, event.toolName) === "verified-unique";
      const shouldResolve = trustedIdentity;
      const discovered = shouldResolve ? capability.touchedPaths?.(event.args) : undefined;
      const resolution = discovered && !Array.isArray(discovered)
        ? discovered.then(freezeTouchedPaths)
        : discovered ? freezeTouchedPaths(discovered) : undefined;
      if (resolution !== undefined) toolPathResolutions.set(event.toolCallId, resolution);
      if (resolution && !Array.isArray(resolution)) {
        void (async () => emitStart(await resolution))().catch(() => emitStart());
      } else {
        emitStart(resolution);
      }
      return;
    }
    if (event.type === "tool_execution_end" && turnId) {
      const capability = capabilityForWireName(event.toolName);
      if (!capability) return;
      const outcome = opts.toolOutcomes.get(event.toolCallId);
      const emitEnd = (paths?: readonly string[]) => opts.events.emit({
        type: "tool_end", turnId, toolCallId: event.toolCallId,
        capability: capability.name, risk: capability.risk,
        result: outcome?.result ?? (event.isError ? "error" : "ok"),
        ...(outcome?.message ? { message: outcome.message } : {}),
        ...(outcome?.denialReason ? { denialReason: outcome.denialReason } : {}),
        ...(paths?.length ? { paths } : {}),
      });
      const discovered = outcome?.paths ?? toolPathResolutions.get(event.toolCallId);
      if (discovered && !Array.isArray(discovered)) {
        void (async () => emitEnd(await discovered))().catch(() => emitEnd());
      } else {
        emitEnd(discovered);
      }
      opts.toolOutcomes.delete(event.toolCallId);
      toolPathResolutions.delete(event.toolCallId);
      return;
    }
    if (event.type === "compaction_end" && event.result) {
      opts.events.emit({
        type: "compaction",
        ...(turnId ? { turnId } : {}),
        tokensBefore: event.result.tokensBefore,
        summaryPreview: event.result.summary.slice(0, 1_000),
      });
    }
  }) as PiEventRelay;
  relay.clearThinkingTimers = clearThinkingTimers;
  relay.clearToolPathResolutions = () => { toolPathResolutions.clear(); };
  return relay;
}

/**
 * Maps a manifest Capability to a Pi ToolDefinition verbatim (name/label/
 * description/parameters). Read-risk capabilities run in parallel with other
 * tool calls; write/sync/destructive run sequentially (ADR-0001). That
 * sequential mode is the dependency that makes relay touched-path
 * pre-resolution safe until the executor consumes it.
 *
 * `run` is injected so callers can route execution through executeCapability's
 * policy/approval/snapshot/audit pipeline (Task 7) rather than calling
 * cap.execute directly.
 */
export function capabilityToPiTool(
  cap: Capability,
  run: (cap: Capability, input: unknown, toolCallId: string, signal: AbortSignal | undefined) => Promise<CapabilityResult>,
): ToolDefinition {
  return {
    // Wire-safe name (see manifest.wireName): dotted canonical names are rejected by provider APIs.
    name: wireName(cap.name),
    label: cap.label ?? cap.name,
    description: cap.description,
    parameters: cap.parameters,
    // Keep write-capable tools sequential: relay path pre-resolution relies on
    // no sibling write changing workspace discovery before execution begins.
    executionMode: cap.risk === "read" ? "parallel" : "sequential",
    execute: async (toolCallId, params, signal) => {
      const result = await run(cap, params, toolCallId, signal);
      // AgentToolResult (pi-agent-core) has no isError field; the executor
      // already encodes failure in `text`, so we only carry details through.
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  } as ToolDefinition;
}

export type SessionAssemblyOptions = {
  agentDir: string;
  runCapability: (cap: Capability, input: unknown, toolCallId: string, signal: AbortSignal | undefined) => Promise<CapabilityResult>;
};

/**
 * Pure production session assembly shared with conformance capture.
 *
 * PRD S3 (the tool-scoper): when `composition.activeSkill` is set, the session
 * registers ONLY that skill's capability subset — toolNames, customTools and the
 * prompt all narrow from the same `scopedCapabilities` resolution, so the model's
 * registered world and the story the prompt tells cannot drift apart. An
 * out-of-scope tool is structurally absent, not refused.
 */
export function assembleSessionConfig(manifest: Manifest, opts: SessionAssemblyOptions, composition?: PromptComposition): {
  systemPrompt: string;
  toolNames: string[];
  customTools: ToolDefinition[];
  loaderConfig: {
    cwd: string;
    agentDir: string;
    systemPrompt: string;
    noExtensions: true;
    noSkills: true;
    noPromptTemplates: true;
    noThemes: true;
    noContextFiles: true;
  };
} {
  assertWireNamesUnique(manifest.capabilities.map((capability) => capability.name));
  const capabilities = composition?.activeSkill
    ? scopedCapabilities(manifest, composition.activeSkill)
    : manifest.capabilities;
  const systemPrompt = buildSystemPrompt(manifest, composition);
  // Pi 0.83 stopped appending the date but ADR-0025 fixes Bridle's recorded
  // prompt tail as date + cwd. Keep the date in the locked loader input; Pi
  // still appends the cwd, and both values remain byte-stable for the session.
  const loaderSystemPrompt = `${systemPrompt}\nCurrent date: ${currentLocalDate()}`;
  return {
    systemPrompt,
    toolNames: capabilities.map((capability) => wireName(capability.name)),
    customTools: capabilities.map((capability) => capabilityToPiTool(capability, opts.runCapability)),
    loaderConfig: {
      cwd: manifest.workspaceRoot ?? opts.agentDir,
      agentDir: opts.agentDir,
      systemPrompt: loaderSystemPrompt,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  };
}

/**
 * ADR-0001/0003: builds a persistent Pi AgentSession whose only tools are the
 * manifest's capabilities (explicit `tools` allowlist of capability names —
 * no built-in bash/read/write/edit/grep/find/ls) and whose system prompt is
 * generated entirely from the manifest (via a locked-down
 * DefaultResourceLoader: no ambient skills, extensions, prompt templates,
 * themes, or context files).
 */
export async function createBridleSession(opts: {
  manifest: Manifest;
  auth: BridleAuth;
  agentDir: string;
  sessionDir?: string;
  /**
   * How the persisted session under `sessionDir` starts: "new" (default, the pre-0.7 behaviour —
   * every boot opens a fresh session) or "continue-recent" (resume the most recent session for
   * this cwd, or create one if none — Pi's SessionManager.continueRecent). Apps whose UI promises
   * a conversation that survives a relaunch (WriteFlex threads) opt in explicitly.
   */
  sessionResume?: "new" | "continue-recent";
  provider?: string;
  modelId?: string;
  /** The model service shared with the public Bridle handle. */
  modelService?: BridleModelService;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  deps: ExecutorDeps;
  trigger: AgentTrigger;
  /**
   * Mutable holder for the trigger of the prompt currently in flight. `Bridle.prompt`
   * (harness.ts) updates `.current` before calling `session.prompt`; the tool runner
   * closure below reads it per call so policy sees the real per-prompt trigger instead
   * of the trigger the session was created with. Threaded exactly like `sessionId`.
   */
  triggerRef?: { current: AgentTrigger };
  /** PRD S3: skill-scoped session — registers only the active skill's capability subset. */
  composition?: PromptComposition;
}): Promise<{
  session: AgentSession;
  capabilities: Map<string, Capability>;
  toolOutcomes: Map<string, ToolRelayOutcome>;
  toolPathResolutions?: Map<string, TouchedPathsResolution>;
  toolCallIdentity?: (toolCallId: string, toolWireName: string) => ToolCallIdentityClassification;
}> {
  if (opts.provider) await prepareAuthProvider(opts.auth, opts.provider);
  const capabilities = new Map(opts.manifest.capabilities.map((c) => [c.name, c]));
  const toolOutcomes = new Map<string, ToolRelayOutcome>();
  const toolPathResolutions = new Map<string, TouchedPathsResolution>();
  let sessionId = "pending";
  const responseIdentities = createResponseToolCallIdentityResolver();
  const triggerRef = opts.triggerRef ?? { current: opts.trigger };
  const runner = async (cap: Capability, input: unknown, toolCallId: string, signal: AbortSignal | undefined) => {
    const execution = await executeCapabilityDetailed(
      cap,
      input,
      {
        trigger: triggerRef.current,
        sessionId,
        toolCallId,
        toolCallIdentity: responseIdentities.classify(toolCallId, wireName(cap.name)),
        signal,
        ...(toolPathResolutions.get(toolCallId) !== undefined
          ? { touchedPathsResolution: toolPathResolutions.get(toolCallId)! }
          : {}),
      },
      opts.deps,
    );
    const result = execution.result;
    toolOutcomes.set(toolCallId, toolRelayOutcome(
      result,
      execution.relay,
      execution.touchedPaths,
    ));
    return result;
  };
  const assembled = assembleSessionConfig(opts.manifest, { agentDir: opts.agentDir, runCapability: runner }, opts.composition);

  const model = opts.provider && opts.modelId
    ? (opts.modelService ?? createModelService({
      auth: opts.auth,
      appDataDir: opts.agentDir,
    })).resolve(opts.provider, opts.modelId)
    : undefined;

  // ADR-0003: locked-down resource loader — the manifest-generated prompt is
  // the whole world; no ambient skills, extensions, or context files.
  const loader = new DefaultResourceLoader(assembled.loaderConfig);
  await loader.reload();

  const modelRuntime = await ModelRuntime.create({
    credentials: opts.auth.storage,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
  });

  const { session } = await createAgentSession({
    cwd: opts.manifest.workspaceRoot,
    agentDir: opts.agentDir,
    modelRuntime,
    model: model ?? undefined,
    thinkingLevel: opts.thinkingLevel,
    // Explicit allowlist: only manifest capabilities exist (ADR-0003); built-ins are excluded by omission.
    tools: assembled.toolNames,
    customTools: assembled.customTools,
    resourceLoader: loader,
    sessionManager: opts.sessionDir
      ? (opts.sessionResume === "continue-recent"
        ? SessionManager.continueRecent(opts.manifest.workspaceRoot ?? opts.agentDir, opts.sessionDir)
        : SessionManager.create(opts.manifest.workspaceRoot ?? opts.agentDir, opts.sessionDir))
      : SessionManager.inMemory(opts.manifest.workspaceRoot ?? opts.agentDir),
  });
  for (const message of session.messages) {
    responseIdentities.observe({ type: "message_end", message } as AgentSessionEvent);
  }
  session.subscribe(responseIdentities.observe);
  sessionId = session.sessionId;

  return { session, capabilities, toolOutcomes, toolPathResolutions, toolCallIdentity: responseIdentities.classify };
}
