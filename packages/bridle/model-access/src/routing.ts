import { isEgressGranted } from "./egress.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { Adapter, ManifestGrants, RoutingConfig, TransportClass } from "./types.ts";

const TRANSPORT_ORDER: readonly TransportClass[] = ["pack", "local-server", "cloud"];

export interface RouteOutcome {
  adapter: Adapter | null;
  reason: "ok" | "no-adapter" | "egress-denied" | "unavailable";
}

function orderedCandidates(taskId: string, adapters: AdapterRegistry, config: RoutingConfig): Adapter[] {
  const configured = config.routes?.[taskId];
  if (configured) {
    return configured
      .map((id) => adapters.get(id))
      .filter((a): a is Adapter => a !== undefined && a.tasks.includes(taskId));
  }
  return adapters
    .forTask(taskId)
    .slice()
    .sort((a, b) => TRANSPORT_ORDER.indexOf(a.transport) - TRANSPORT_ORDER.indexOf(b.transport));
}

async function available(adapter: Adapter): Promise<boolean> {
  if (!adapter.isAvailable) return true;
  return await adapter.isAvailable();
}

export async function route(
  taskId: string,
  adapters: AdapterRegistry,
  config: RoutingConfig,
  grants: ManifestGrants,
): Promise<RouteOutcome> {
  const candidates = orderedCandidates(taskId, adapters, config);
  if (candidates.length === 0) return { adapter: null, reason: "no-adapter" };

  let sawDenied = false;
  let sawUnavailable = false;
  for (const adapter of candidates) {
    if (!isEgressGranted(adapter, taskId, grants)) {
      sawDenied = true;
      continue;
    }
    if (!(await available(adapter))) {
      sawUnavailable = true;
      continue;
    }
    return { adapter, reason: "ok" };
  }
  if (sawDenied) return { adapter: null, reason: "egress-denied" };
  if (sawUnavailable) return { adapter: null, reason: "unavailable" };
  return { adapter: null, reason: "no-adapter" };
}
