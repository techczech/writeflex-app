// Generic LLM provider / model / auth catalog (ADR-0018).
//
// The ADR-0001 firewall keeps Pi imports inside @bridle/core. This module is the
// sanctioned place that derives a provider catalog from Pi and exposes it so
// consuming apps enumerate providers generically — Claude AND ChatGPT/OpenAI AND
// others — without hardcoding provider ids, model ids, or auth lanes. Apps never
// import Pi directly; they call listProviders() + drive BridleAuth by id.
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export type AuthLane = "oauth" | "apikey";

export interface ProviderModel {
  id: string;
  label: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  models: ProviderModel[];
  /** Lanes the framework can actually complete for this provider; oauth first when available. */
  authLanes: AuthLane[];
}

// Curated default: the mainstream + genuinely-loginable providers. Pi also bundles
// ~30 niche / regional providers; those are hidden unless explicitly requested via
// opts.include (which replaces this list). Extend here as first-class support grows.
const DEFAULT_ALLOWLIST = ["anthropic", "openai", "openai-codex", "google", "github-copilot"];

// Structural view of the bits of Pi's Provider we depend on — kept local so this
// module doesn't hard-depend on Pi's exported types for the /providers/all subpath.
type PiProvider = {
  id: string;
  name?: string;
  auth?: { apiKey?: unknown; oauth?: unknown };
  getModels?: () => Array<{ id: string; name?: string }>;
};

export interface OAuthProviderInfo {
  id: string;
  name: string;
}

/** Provider-owned OAuth catalogue exposed through Bridle's Pi firewall. */
export function getOAuthProviders(): OAuthProviderInfo[] {
  return (builtinProviders() as unknown as PiProvider[])
    .filter((provider) => provider.auth?.oauth)
    .map((provider) => ({ id: provider.id, name: provider.name ?? provider.id }));
}

/**
 * List the LLM providers a consuming app may offer, with their models and the
 * auth lanes that can actually be completed. Derived from Pi's built-in catalog.
 *
 * @param opts.include - explicit provider-id allowlist; replaces the curated default.
 */
export function listProviders(opts?: { include?: string[] }): ProviderInfo[] {
  const allow = opts?.include ?? DEFAULT_ALLOWLIST;
  // OAuth is only offered when the provider is genuinely loginable (a declared
  // `auth.oauth` on the provider is broader than the actually-loginable set).
  const loginableOAuth = new Set(getOAuthProviders().map((p) => p.id));
  const byId = new Map((builtinProviders() as unknown as PiProvider[]).map((p) => [p.id, p]));

  const result: ProviderInfo[] = [];
  for (const id of allow) {
    const provider = byId.get(id);
    if (!provider) continue;

    const authLanes: AuthLane[] = [];
    if (provider.auth?.oauth && loginableOAuth.has(provider.id)) authLanes.push("oauth");
    if (provider.auth?.apiKey) authLanes.push("apikey");
    if (authLanes.length === 0) continue; // no usable lane → not selectable

    let models: ProviderModel[] = [];
    try {
      models = (provider.getModels?.() ?? []).map((model) => ({ id: model.id, label: model.name ?? model.id }));
    } catch {
      models = []; // dynamic providers may need a network refresh; expose empty rather than crash
    }

    result.push({ id: provider.id, label: provider.name ?? provider.id, models, authLanes });
  }
  return result;
}
