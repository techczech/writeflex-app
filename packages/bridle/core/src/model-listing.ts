import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { prepareAuthProvider, type BridleAuth } from "./auth.ts";
import { BRIDLE_VERSION } from "./version.ts";

export type RegistryModel = { provider: string; id: string; name: string; approximated?: true };
export type RegistryModels = { all: RegistryModel[]; available: RegistryModel[] };

/**
 * Why a discovery did not succeed. `empty-catalogue` means the provider answered with
 * zero listable models: that is a failure, never a success, and the previous list stays.
 * `not-signed-in` accompanies a `skipped` discovery (nothing to ask the provider with).
 */
export type BridleDiscoveryReason = 'offline' | 'provider-error' | 'empty-catalogue' | 'not-signed-in';
export type BridleDiscoveryResult = {
  at: number;
  discovery: 'succeeded' | 'failed' | 'skipped';
  reason?: BridleDiscoveryReason;
};
export type BridleModelRefreshOutcome = BridleDiscoveryResult & {
  models: RegistryModels;
};

/** What one live-discoverable provider's refresh did to the listed models. */
export type BridleProviderModelChange = {
  provider: string;
  discovery: BridleDiscoveryResult['discovery'];
  reason?: BridleDiscoveryReason;
  /** Listed ids that were not listed before this refresh, sorted. */
  added: string[];
  /** Ids that were listed before this refresh and no longer are, sorted. */
  removed: string[];
  /** When this provider's list last came back from the provider successfully; null if never. */
  checkedAt: number | null;
};

export type BridleModelRefreshReport = BridleModelRefreshOutcome & {
  /** True when an unforced refresh found every discoverable list fresh and asked no provider. */
  throttled: boolean;
  /**
   * True when a forced refresh arrived within the forced-refresh floor of a successful forced check
   * and was answered with that check's report, without asking any provider.
   */
  reused: boolean;
  /** One entry per provider Bridle discovers live (today: openai-codex). */
  providers: Record<string, BridleProviderModelChange>;
};

export type BridleRefreshModelsOptions = {
  /** Ask the providers even when the last successful check is younger than `maxAgeMs`. */
  force?: boolean;
  /** Freshness window for an unforced refresh. Default one hour. */
  maxAgeMs?: number;
};

export const DEFAULT_MODEL_REFRESH_MAX_AGE_MS = 60 * 60 * 1000;
export const DEFAULT_FORCED_REFRESH_FLOOR_MS = 10_000;

const LIVE_DISCOVERY_PROVIDERS = ["openai-codex"] as const;
const DISCOVERY_REASONS: readonly BridleDiscoveryReason[] = ['offline', 'provider-error', 'empty-catalogue', 'not-signed-in'];

export type BridleModelServiceOptions = {
  auth: BridleAuth;
  appDataDir: string;
  include?: string[];
  fetch?: typeof globalThis.fetch;
  /**
   * After a successful forced check, a forced `refreshModels` within this window returns that
   * check's report (marked `reused`) and asks no provider. Default 10 seconds.
   */
  forcedRefreshFloorMs?: number;
};

type CachedProviderModels = {
  checkedAt: number;
  etag?: string;
  models: RegistryModel[];
};

type ModelCatalogCache = {
  version: 1;
  lastDiscovery?: BridleDiscoveryResult;
  providers: Record<string, CachedProviderModels>;
};

type ProviderFamily = {
  provider: Provider;
  template: Model<Api>;
  local: Model<Api>[];
};

type RemoteModel = { id: string; name: string };

type OpenAICodexModelsResponse = {
  models?: Array<{
    slug?: unknown;
    display_name?: unknown;
    visibility?: unknown;
    supported_in_api?: unknown;
  }>;
};

export class BridleModelNotListedError extends Error {
  constructor(providerId: string, modelId: string) {
    super(`Model "${providerId}/${modelId}" is not listed by this Bridle model service.`);
    this.name = "BridleModelNotListedError";
  }
}

function modelScore(model: Model<Api>): number {
  return model.contextWindow + model.maxTokens + model.input.length * 1_000_000;
}

function providerFamilies(include?: string[]): Map<string, ProviderFamily> {
  const allow = include ? new Set(include) : null;
  const result = new Map<string, ProviderFamily>();
  for (const provider of builtinProviders()) {
    if (allow && !allow.has(provider.id)) continue;
    const local = [...provider.getModels()];
    const first = local[0];
    if (!first) continue;
    const template = local.reduce((best, candidate) =>
      modelScore(candidate) > modelScore(best) ? candidate : best, first);
    result.set(provider.id, { provider, template, local });
  }
  return result;
}

function registryModel(model: Model<Api>, approximated = false): RegistryModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(approximated ? { approximated: true as const } : {}),
  };
}

function key(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

function constructFamilyDescriptor(family: ProviderFamily, model: RemoteModel): Model<Api> {
  return {
    ...family.template,
    id: model.id,
    name: model.name,
    provider: family.provider.id,
    baseUrl: family.provider.baseUrl ?? family.template.baseUrl,
    api: family.template.api,
    reasoning: family.template.reasoning,
  };
}

function validRegistryModel(value: unknown, providerId: string): value is RegistryModel {
  if (typeof value !== "object" || value === null) return false;
  const model = value as Partial<RegistryModel>;
  return model.provider === providerId
    && typeof model.id === "string"
    && model.id.length > 0
    && typeof model.name === "string"
    && model.name.length > 0;
}

function readCache(path: string, families: Map<string, ProviderFamily>): ModelCatalogCache {
  const empty: ModelCatalogCache = { version: 1, providers: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return empty;
    const root = parsed as { version?: unknown; providers?: unknown; lastDiscovery?: Partial<BridleDiscoveryResult> };
    if (root.version !== 1 || typeof root.providers !== "object" || root.providers === null) return empty;
    const providers: Record<string, CachedProviderModels> = {};
    for (const [providerId, value] of Object.entries(root.providers)) {
      if (!families.has(providerId) || typeof value !== "object" || value === null) continue;
      const entry = value as { checkedAt?: unknown; etag?: unknown; models?: unknown };
      if (typeof entry.checkedAt !== "number" || !Number.isFinite(entry.checkedAt) || !Array.isArray(entry.models)) continue;
      // An empty list is never a valid discovery; older builds stored one as success.
      if (entry.models.length === 0) continue;
      if (!entry.models.every((model) => validRegistryModel(model, providerId))) continue;
      providers[providerId] = {
        checkedAt: entry.checkedAt,
        ...(typeof entry.etag === "string" ? { etag: entry.etag } : {}),
        models: entry.models,
      };
    }
    const last = root.lastDiscovery;
    const lastDiscovery: BridleDiscoveryResult | undefined = last && typeof last.at === 'number' && Number.isFinite(last.at) && last.at >= 0
      && ['succeeded', 'failed', 'skipped'].includes(last.discovery ?? '')
      ? {
        at: last.at,
        discovery: last.discovery!,
        ...(last.reason && DISCOVERY_REASONS.includes(last.reason) ? { reason: last.reason } : {}),
      } : undefined;
    return { version: 1, providers, ...(lastDiscovery ? { lastDiscovery } : {}) };
  } catch {
    return empty;
  }
}

async function writeCache(path: string, cache: ModelCatalogCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    try {
      await unlink(temporary);
    } catch {
      // The rename consumed the temporary file, or a failed write created nothing.
    }
  }
}

function extractOpenAIAccountId(token: string): string {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) throw new Error("missing payload");
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId !== "string" || accountId.length === 0) throw new Error("missing account id");
    return accountId;
  } catch {
    throw new Error("OpenAI Codex credentials do not contain a ChatGPT account id.");
  }
}

/**
 * The `client_version` sent to the ChatGPT Codex models endpoint. It is a Codex CLI version,
 * not Bridle's: the server drops every model whose `minimal_client_version` is above it
 * (Codex 0.159's bundled catalogue sets minimums from 0.98.0 to 0.155.0), so Bridle's own
 * version (0.x) got HTTP 200 with an empty `models` array. A value that is too old hides only the
 * newer models. When to raise it: when a model the Codex CLI lists is missing from Bridle's list,
 * or when the test fixture of the live catalogue (`model-listing.test.ts`) is refreshed with a
 * higher `minimal_client_version`. Set it to the Codex CLI release that lists the model
 * (`codex --version`, or `client_version` in `~/.codex/models_cache.json`); the fixture test
 * fails until it is at least the fixture's highest minimum.
 */
export const OPENAI_CODEX_CLIENT_VERSION = "0.160.1";

function openAICodexModelsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  const root = normalized.endsWith("/codex") ? normalized : `${normalized}/codex`;
  return `${root}/models?client_version=${encodeURIComponent(OPENAI_CODEX_CLIENT_VERSION)}`;
}

class DiscoveryOfflineError extends Error {}
class DiscoveryEmptyError extends Error {}

async function discoverOpenAICodexModels(
  family: ProviderFamily,
  auth: BridleAuth,
  fetcher: typeof globalThis.fetch,
): Promise<{ models: RegistryModel[]; etag?: string } | null> {
  const token = await auth.storage.getApiKey(family.provider.id);
  // No usable token: nothing was asked, so this is "not signed in", never "discovered zero".
  if (!token) return null;
  const accountId = extractOpenAIAccountId(token);
  const response = await fetcher(openAICodexModelsUrl(family.provider.baseUrl ?? family.template.baseUrl), {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "chatgpt-account-id": accountId,
      originator: "bridle",
      "user-agent": `bridle/${BRIDLE_VERSION}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => { throw new DiscoveryOfflineError(); });
  if (!response.ok) throw new Error(`OpenAI Codex model discovery returned HTTP ${response.status}.`);
  const body = await response.json() as OpenAICodexModelsResponse;
  if (!Array.isArray(body.models)) throw new Error("OpenAI Codex model discovery returned an invalid catalogue.");
  const models = body.models
    .filter((model) => model.visibility === "list" && model.supported_in_api === true && typeof model.slug === "string" && model.slug.length > 0)
    .map((model) => ({
      provider: family.provider.id,
      id: model.slug as string,
      name: typeof model.display_name === "string" && model.display_name.length > 0
        ? model.display_name
        : model.slug as string,
    }));
  const etag = response.headers.get("etag");
  return { models, ...(etag ? { etag } : {}) };
}

function localRegistryModels(auth: BridleAuth, include?: string[]): RegistryModels {
  const families = providerFamilies(include);
  const all = [...families.values()].flatMap((family) => family.local.map((model) => registryModel(model)));
  return {
    all,
    available: all.filter((model) => auth.status(model.provider).configured),
  };
}

/**
 * Compatibility read for pre-service consumers. It is deliberately local-only:
 * it never reads another program's files. New consumers should retain one
 * BridleModelService so refresh, listing, and descriptor construction share state.
 */
export function listRegistryModels(auth: BridleAuth, opts?: { include?: string[] }): RegistryModels {
  return localRegistryModels(auth, opts?.include);
}

export class BridleModelService {
  readonly #auth: BridleAuth;
  readonly #cachePath: string;
  readonly #families: Map<string, ProviderFamily>;
  readonly #fetch: typeof globalThis.fetch;
  #cache: ModelCatalogCache;
  #refreshQueue: Promise<unknown> = Promise.resolve();
  readonly #forcedFloorMs: number;
  /** A forced check that is queued or running; further forced calls join it. */
  #pendingForced: Promise<BridleModelRefreshReport> | null = null;
  /** The last successful forced check, for the forced-refresh floor. Cleared when any check begins. */
  #lastForced: { settledAt: number; report: BridleModelRefreshReport } | null = null;
  #listeners = new Set<(models: RegistryModels, outcome: BridleModelRefreshOutcome) => void>();
  #descriptors = new Map<string, Model<Api>>();
  #approximated = new Set<string>();
  #unsubscribeAuth: (() => void) | null;

  constructor(opts: BridleModelServiceOptions) {
    this.#auth = opts.auth;
    this.#cachePath = join(opts.appDataDir, "model-catalog.json");
    this.#families = providerFamilies(opts.include);
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#forcedFloorMs = opts.forcedRefreshFloorMs ?? DEFAULT_FORCED_REFRESH_FLOOR_MS;
    this.#cache = readCache(this.#cachePath, this.#families);
    this.#rebuildDescriptors();
    this.#unsubscribeAuth = this.#auth.onChange(() => { void this.refreshWithOutcome(); });
  }

  /**
   * Stops refreshing on auth changes. Idempotent. The constructor of a service owns its
   * disposal: the harness disposes a service it created and never one a host passed in.
   */
  dispose(): void {
    this.#unsubscribeAuth?.();
    this.#unsubscribeAuth = null;
  }

  list(): RegistryModels {
    const all = [...this.#descriptors.entries()].map(([descriptorKey, descriptor]) => (
      registryModel(descriptor, this.#approximated.has(descriptorKey))
    ));
    return {
      all,
      available: all.filter((model) => this.#auth.status(model.provider).configured),
    };
  }

  async refresh(): Promise<RegistryModels> {
    return (await this.refreshWithOutcome()).models;
  }

  lastDiscovery(): BridleDiscoveryResult | null {
    return this.#cache.lastDiscovery ? { ...this.#cache.lastDiscovery } : null;
  }

  onChange(listener: (models: RegistryModels, outcome: BridleModelRefreshOutcome) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  refreshWithOutcome(): Promise<BridleModelRefreshOutcome> {
    return this.#enqueue(() => this.#refresh(false));
  }

  /**
   * Refreshes the live-discoverable providers and reports what changed per provider.
   * Unforced, it asks no provider while every signed-in discoverable provider's last
   * successful check is younger than `maxAgeMs` (default one hour); a failed or empty
   * discovery never counts as fresh, so the next trigger retries it. `force: true`
   * asks, within bounds: it joins a forced check already queued or running, and within the
   * forced-refresh floor after a successful forced check it returns that report marked `reused`.
   * A forced call that arrives during an unforced check still queues a new provider check.
   * Calls queue behind any refresh in flight.
   */
  refreshModels(opts: BridleRefreshModelsOptions = {}): Promise<BridleModelRefreshReport> {
    if (opts.force) {
      if (this.#pendingForced) return this.#pendingForced;
      const last = this.#lastForced;
      if (last) {
        const age = Date.now() - last.settledAt;
        if (age >= 0 && age < this.#forcedFloorMs) return Promise.resolve({ ...last.report, reused: true });
      }
      const pending = this.#enqueue(() => this.#refresh(true));
      this.#pendingForced = pending;
      const clear = () => { if (this.#pendingForced === pending) this.#pendingForced = null; };
      pending.then(clear, clear);
      return pending;
    }
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MODEL_REFRESH_MAX_AGE_MS;
    return this.#enqueue(async () => {
      if (this.#fresh(maxAgeMs)) return this.#throttledReport();
      return this.#refresh(false);
    });
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    // Serialise auth events and manual refreshes so older requests cannot overwrite newer state.
    const pending = this.#refreshQueue.then(run);
    this.#refreshQueue = pending.catch(() => undefined);
    return pending;
  }

  #discoverableFamilies(): ProviderFamily[] {
    return LIVE_DISCOVERY_PROVIDERS.flatMap((id) => {
      const family = this.#families.get(id);
      return family ? [family] : [];
    });
  }

  #fresh(maxAgeMs: number): boolean {
    const last = this.#cache.lastDiscovery;
    if (!last || last.discovery !== 'succeeded') return false;
    const now = Date.now();
    const signedIn = this.#discoverableFamilies().filter((family) => this.#auth.status(family.provider.id).configured);
    if (signedIn.length === 0) return false;
    return signedIn.every((family) => {
      const checkedAt = this.#cache.providers[family.provider.id]?.checkedAt;
      if (checkedAt === undefined) return false;
      const age = now - checkedAt;
      return age >= 0 && age < maxAgeMs;
    });
  }

  #throttledReport(): BridleModelRefreshReport {
    const last = this.#cache.lastDiscovery!;
    const providers: Record<string, BridleProviderModelChange> = {};
    for (const family of this.#discoverableFamilies()) {
      const id = family.provider.id;
      providers[id] = {
        provider: id,
        discovery: 'succeeded',
        added: [],
        removed: [],
        checkedAt: this.#cache.providers[id]?.checkedAt ?? null,
      };
    }
    return { models: this.list(), ...last, throttled: true, reused: false, providers };
  }

  #listedIds(providerId: string): Set<string> {
    return new Set(this.list().all.filter((model) => model.provider === providerId).map((model) => model.id));
  }

  async #refresh(forced: boolean): Promise<BridleModelRefreshReport> {
    // Any real check that begins closes the forced-refresh floor, so a forced call arriving while it
    // runs queues a new check instead of reusing a report this check is about to supersede.
    this.#lastForced = null;
    let discovery: BridleDiscoveryResult['discovery'] = 'skipped';
    let reason: BridleDiscoveryReason | undefined;
    const providers: Record<string, BridleProviderModelChange> = {};
    for (const family of this.#discoverableFamilies()) {
      const id = family.provider.id;
      const before = this.#listedIds(id);
      let providerDiscovery: BridleDiscoveryResult['discovery'] = 'skipped';
      let providerReason: BridleDiscoveryReason | undefined;
      try {
        await prepareAuthProvider(this.#auth, id);
        const discovered = this.#auth.status(id).configured
          ? await discoverOpenAICodexModels(family, this.#auth, this.#fetch)
          : null;
        if (!discovered) {
          providerReason = 'not-signed-in';
        } else if (discovered.models.length === 0) {
          throw new DiscoveryEmptyError();
        } else {
          this.#cache.providers[id] = {
            checkedAt: Date.now(),
            ...(discovered.etag ? { etag: discovered.etag } : {}),
            models: discovered.models,
          };
          this.#rebuildDescriptors();
          providerDiscovery = 'succeeded';
        }
      } catch (error) {
        // The previous list (cache entry and descriptors) is left untouched.
        providerDiscovery = 'failed';
        providerReason = error instanceof DiscoveryOfflineError ? 'offline'
          : error instanceof DiscoveryEmptyError ? 'empty-catalogue'
            : 'provider-error';
      }
      const after = this.#listedIds(id);
      providers[id] = {
        provider: id,
        discovery: providerDiscovery,
        ...(providerReason ? { reason: providerReason } : {}),
        added: [...after].filter((model) => !before.has(model)).sort(),
        removed: [...before].filter((model) => !after.has(model)).sort(),
        checkedAt: this.#cache.providers[id]?.checkedAt ?? null,
      };
    }
    // Overall result: any failure wins, then any success, else skipped. The reason is the deciding provider's.
    const changes = Object.values(providers);
    const deciding = changes.find((change) => change.discovery === 'failed')
      ?? changes.find((change) => change.discovery === 'succeeded')
      ?? changes[0];
    if (deciding) {
      discovery = deciding.discovery;
      reason = deciding.reason;
    }
    const at = Date.now();
    this.#cache.lastDiscovery = { at, discovery, ...(reason ? { reason } : {}) };
    await writeCache(this.#cachePath, this.#cache).catch(() => undefined);
    const report: BridleModelRefreshReport = {
      models: this.list(), discovery, at, ...(reason ? { reason } : {}), throttled: false, reused: false, providers,
    };
    // Only a successful forced check opens the floor (every check closed it when it began).
    this.#lastForced = forced && discovery === 'succeeded' ? { settledAt: Date.now(), report } : null;
    for (const listener of this.#listeners) {
      try { listener(report.models, report); } catch { /* Observers cannot fail a refresh. */ }
    }
    return report;
  }

  resolve(providerId: string, modelId: string): Model<Api> {
    // Descriptor invariant: list() and resolve() read the same map, so every
    // listed id has a descriptor and no undefined reaches AgentSession.setModel.
    // `available` separately means Bridle has configured credentials. Whether
    // the provider accepts a request is verified only by a live runtime call.
    const descriptor = this.#descriptors.get(key(providerId, modelId));
    if (!descriptor) throw new BridleModelNotListedError(providerId, modelId);
    return descriptor;
  }

  #rebuildDescriptors(): void {
    const descriptors = new Map<string, Model<Api>>();
    const approximated = new Set<string>();
    for (const family of this.#families.values()) {
      const discovered = this.#cache.providers[family.provider.id]?.models;
      if (!discovered) {
        // No successful live discovery: the bundled catalogue is the list.
        for (const model of family.local) descriptors.set(key(model.provider, model.id), model);
        continue;
      }
      // A successful live discovery is authoritative: list exactly what the provider listed, using
      // the bundled descriptor where Bridle has one and an approximated family descriptor otherwise.
      // A bundled model the provider no longer lists drops out (and shows in the refresh's `removed`).
      const bundled = new Map(family.local.map((model) => [model.id, model]));
      for (const cached of discovered) {
        const descriptorKey = key(cached.provider, cached.id);
        const known = bundled.get(cached.id);
        if (known) {
          descriptors.set(descriptorKey, known);
        } else {
          descriptors.set(descriptorKey, constructFamilyDescriptor(family, { id: cached.id, name: cached.name }));
          approximated.add(descriptorKey);
        }
      }
    }
    this.#descriptors = descriptors;
    this.#approximated = approximated;
  }
}

export function createModelService(opts: BridleModelServiceOptions): BridleModelService {
  return new BridleModelService(opts);
}
