import { bindToolDiscovery } from "./tool-discovery.ts";
import {
  createAssistantMessageEventStream,
  getApiProvider,
  registerApiProvider,
  type AssistantMessage,
  type Context,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai/compat";
import {
  createProvider,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { checkTurnScript, type TurnScript } from "@bridle/contract";
import { executeCapabilityDetailed } from "./executor.ts";
import { wireName } from "./manifest.ts";
import {
  assembleSessionConfig,
  createResponseToolCallIdentityResolver,
  toolRelayOutcome,
  type TouchedPathsResolution,
  type ToolRelayOutcome,
} from "./runtime-pi.ts";
import type { AgentTrigger, Capability, CapabilityResult, Manifest } from "./types.ts";
import type { BridleSessionFactory } from "./harness.ts";

const SCRIPTED_API = "bridle-scripted";
const SCRIPTED_PROVIDER = "bridle-scripted-provider";
const SCRIPTED_MODEL = "bridle-scripted-model";
const SCRIPTED_DISPATCHER_SOURCE = "bridle-scripted-provider";

type CompletionStopReason = Extract<AssistantMessage["stopReason"], "length" | "stop" | "toolUse">;
type ScriptedModel = Model<typeof SCRIPTED_API>;
type ScriptedRoute = { next(model: ScriptedModel, context: Context): AssistantMessage & { stopReason: CompletionStopReason } };

const routes = new WeakMap<ScriptedModel, ScriptedRoute>();
let scriptedDispatcher: ReturnType<typeof getApiProvider> | undefined;

class ScriptedProviderError extends Error {
  override name = "ScriptedProviderError";
}

function response(
  model: ScriptedModel,
  content: AssistantMessage["content"],
  stopReason: CompletionStopReason,
): AssistantMessage & { stopReason: CompletionStopReason } {
  return {
    role: "assistant",
    content,
    api: SCRIPTED_API,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function scriptedModel(route: ScriptedRoute): ScriptedModel {
  const model: ScriptedModel = {
    id: SCRIPTED_MODEL,
    name: "Bridle scripted provider",
    api: SCRIPTED_API,
    provider: SCRIPTED_PROVIDER,
    baseUrl: "scripted://bridle",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 1_024,
  };
  routes.set(model, route);
  return model;
}

function streamScripted(model: ScriptedModel, context: Context, options?: StreamOptions) {
  const route = routes.get(model);
  if (!route) throw new ScriptedProviderError(`No scripted completion route is registered for ${model.provider}/${model.id}.`);
  const stream = createAssistantMessageEventStream();
  const next = route.next(model, context);
  queueMicrotask(async () => {
    await options?.onResponse?.({ status: 200, headers: {} }, model);
    stream.push({ type: "start", partial: next });
    stream.push({ type: "done", reason: next.stopReason, message: next });
    stream.end(next);
  });
  return stream;
}

function ensureScriptedDispatcher(): void {
  const existing = getApiProvider(SCRIPTED_API);
  if (existing) {
    if (existing === scriptedDispatcher) return;
    throw new ScriptedProviderError(`Reserved scripted API ID ${SCRIPTED_API} is already owned by another provider.`);
  }
  registerApiProvider({ api: SCRIPTED_API, stream: streamScripted, streamSimple: streamScripted }, SCRIPTED_DISPATCHER_SOURCE);
  scriptedDispatcher = getApiProvider(SCRIPTED_API);
  if (!scriptedDispatcher) throw new ScriptedProviderError(`Failed to register reserved scripted API ID ${SCRIPTED_API}.`);
}

function routeFor(scripts: TurnScript[], identityPrefix: string, dynamicTools = false): ScriptedRoute {
  let scriptIndex = 0;
  let roundIndex = 0;
  let prefixSeen = false;
  let systemPrompt: string | undefined;
  let toolCatalog = "";
  return {
    next(model, context) {
      const currentToolCatalog = JSON.stringify(context.tools ?? []);
      if (!prefixSeen) {
        prefixSeen = true;
        systemPrompt = context.systemPrompt;
        toolCatalog = currentToolCatalog;
      } else if (context.systemPrompt !== systemPrompt || (!dynamicTools && currentToolCatalog !== toolCatalog)) {
        throw new ScriptedProviderError("Scripted provider Cache Law violation: Pi changed the system prompt or tool catalog within a session.");
      }
      const script = scripts[scriptIndex];
      if (!script) throw new ScriptedProviderError("Scripted provider prompt overrun: no TurnScript remains for this prompt().");
      const round = script.rounds[roundIndex];
      if (!round) throw new ScriptedProviderError(`TurnScript ${scriptIndex + 1} has no scripted round ${roundIndex + 1}.`);
      roundIndex += 1;
      if (round.kind === "message") {
        scriptIndex += 1;
        roundIndex = 0;
        return response(model, [{ type: "text", text: round.text }], "stop");
      }
      return response(model, round.calls.map((call, callIndex) => ({
        type: "toolCall",
        id: `${identityPrefix}-script-${scriptIndex + 1}-round-${roundIndex}-call-${callIndex + 1}`,
        name: wireName(call.name),
        arguments: call.arguments,
      })), "toolUse");
    },
  };
}

/**
 * Creates a deterministic, Pi-backed provider for conformance scenarios. Its
 * synthetic model responses still travel through Pi's AgentSession and
 * SessionManager, so the Flight Recorder sees the same session entries as a
 * live provider.
 */
function createScriptedSessionFactory(scripts: TurnScript[], identityPrefix: string): BridleSessionFactory {
  scripts.forEach((script, index) => {
    const checked = checkTurnScript(script);
    if (!checked.ok) throw new ScriptedProviderError(`TurnScript ${index + 1} is invalid: ${checked.reason ?? "unknown validation error"}`);
  });
  ensureScriptedDispatcher();
  return async (opts) => {
    const capabilities = new Map(opts.manifest.capabilities.map((capability) => [capability.name, capability]));
    const toolOutcomes = new Map<string, ToolRelayOutcome>();
    const toolPathResolutions = new Map<string, TouchedPathsResolution>();
    let sessionId = "pending";
    const responseIdentities = createResponseToolCallIdentityResolver();
    const triggerRef = opts.triggerRef ?? { current: opts.trigger };
    const runner = async (capability: Capability, input: unknown, toolCallId: string, signal: AbortSignal | undefined): Promise<CapabilityResult> => {
      const execution = await executeCapabilityDetailed(capability, input, {
        trigger: triggerRef.current,
        sessionId,
        toolCallId,
        toolCallIdentity: responseIdentities.classify(toolCallId, wireName(capability.name)),
        signal,
        ...(toolPathResolutions.get(toolCallId) !== undefined
          ? { touchedPathsResolution: toolPathResolutions.get(toolCallId)! }
          : {}),
      }, opts.deps);
      const result = execution.result;
      toolOutcomes.set(toolCallId, toolRelayOutcome(
        result,
        execution.relay,
        execution.touchedPaths,
      ));
      return result;
    };
    // THE LAW: scripted ≡ live — including the S3 skill scoping (Sol S8 finding:
    // dropping composition here false-greened conformance for skill-bound runs).
    const assembled = assembleSessionConfig(opts.manifest, { agentDir: opts.agentDir, runCapability: runner }, opts.composition);
    const route = routeFor(scripts, identityPrefix, assembled.discovery.enabled);
    for (const cap of assembled.discovery.capabilities) capabilities.set(cap.name, cap);
    const loader = new DefaultResourceLoader(assembled.loaderConfig);
    await loader.reload();
    const model = scriptedModel(route);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
    });
    modelRuntime.registerNativeProvider(createProvider({
      id: SCRIPTED_PROVIDER,
      name: "Bridle scripted provider",
      baseUrl: model.baseUrl,
      auth: {
        apiKey: {
          name: "Bridle scripted provider",
          async check() { return { type: "api_key", source: "Bridle scripted provider" }; },
          async resolve() { return { auth: {}, source: "Bridle scripted provider" }; },
        },
      },
      models: [model],
      api: { stream: streamScripted, streamSimple: streamScripted },
    }));
    const { session } = await createAgentSession({
      cwd: opts.manifest.workspaceRoot,
      agentDir: opts.agentDir,
      modelRuntime,
      model,
      thinkingLevel: opts.thinkingLevel,
      tools: assembled.customTools.map((tool) => tool.name),
      customTools: assembled.customTools,
      resourceLoader: loader,
      // THE LAW: a scripted run is indistinguishable from live at the record layer — including how
      // the session starts (sessionResume must behave exactly as runtime-pi's live path does).
      sessionManager: opts.sessionDir
        ? (opts.sessionResume === "continue-recent"
          ? SessionManager.continueRecent(opts.manifest.workspaceRoot ?? opts.agentDir, opts.sessionDir)
          : SessionManager.create(opts.manifest.workspaceRoot ?? opts.agentDir, opts.sessionDir))
        : SessionManager.inMemory(opts.manifest.workspaceRoot ?? opts.agentDir),
    });
    for (const message of session.messages) {
      responseIdentities.observe({ type: "message_end", message } as never);
    }
    session.subscribe(responseIdentities.observe);
    bindToolDiscovery(session, assembled.discovery, wireName);
    sessionId = session.sessionId;
    let promptCount = 0;
    const prompt = session.prompt.bind(session);
    session.prompt = async (...args) => {
      if (promptCount >= scripts.length) {
        throw new ScriptedProviderError("Scripted provider prompt overrun: no TurnScript remains for this prompt().");
      }
      promptCount += 1;
      return prompt(...args);
    };
    return { session, capabilities, toolOutcomes, toolPathResolutions, toolCallIdentity: responseIdentities.classify };
  };
}

export function scriptedSessionFactory(scripts: TurnScript[]): BridleSessionFactory {
  return createScriptedSessionFactory(scripts, randomUUID());
}

/** Internal crash-fixture seam for deliberately modelling provider redelivery. */
export function scriptedRedeliverySessionFactory(scripts: TurnScript[], identityPrefix: string): BridleSessionFactory {
  return createScriptedSessionFactory(scripts, identityPrefix);
}
