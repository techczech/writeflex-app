import type {
  Availability,
  AvailabilityState,
  Blocker,
  LoopbackProbeSchema,
  PackRunner,
  SecretStore,
} from "@bridle/contract";
import type { Static } from "typebox";
import { dirname } from "node:path";
import type { ManifestDefinition } from "../types.ts";
import { isDiscoveredContribution, type DiscoveredContribution } from "./discovery.ts";

type ServerNeed = Static<typeof LoopbackProbeSchema>;

export type AvailabilityContext = {
  manifest?: Pick<ManifestDefinition, "appId" | "capabilities">;
  taskRegistry?: { has(id: string): boolean };
  packRunner?: PackRunner;
  secretStore?: SecretStore;
  platform: "darwin" | "win32" | "linux" | string;
  modelInputs?: readonly string[];
  catalogue?: readonly DiscoveredContribution[];
  assetStatus?: (id: string) => boolean | Promise<boolean>;
  authStatus?: (providerId: string) => boolean | Promise<boolean>;
  serverHealthCheck?: (server: ServerNeed) => boolean | Promise<boolean>;
};

const unsupported = (code: string, message: string): Blocker => ({ dimension: "requirements", code, message });
const policy = (code: string, message: string): Blocker => ({ dimension: "policy", code, message });
const dimensionPriority: Record<Blocker["dimension"], number> = {
  trust: 0,
  policy: 1,
  requirements: 2,
  runtime: 3,
};

function ordered(blockers: readonly Blocker[]): Blocker[] {
  return blockers
    .map((blocker, index) => ({ blocker, index }))
    .sort((left, right) => dimensionPriority[left.blocker.dimension] - dimensionPriority[right.blocker.dimension] || left.index - right.index)
    .map(({ blocker }) => blocker);
}

async function bindingBlockers(contribution: DiscoveredContribution, context: AvailabilityContext): Promise<Blocker[]> {
  const descriptor = contribution.descriptor;
  if (descriptor.kind === "capability") {
    const declared = descriptor.binding.capability;
    const actual = context.manifest?.capabilities.find((item) => item.name === declared.name);
    if (!actual) return [policy("unbound", `Capability ${declared.name} is not granted by the host manifest.`)];
    const egressMismatch = declared.egress !== undefined && (actual.egress ?? "none") !== declared.egress.class;
    const missingPaths = (actual.risk === "write" || actual.risk === "destructive") && typeof actual.touchedPaths !== "function";
    if (actual.risk !== declared.risk || egressMismatch || missingPaths) {
      return [policy("drift-error", `Capability ${declared.name} safety metadata does not match its descriptor.`)];
    }
    return [];
  }
  if (descriptor.kind === "task") {
    return context.taskRegistry?.has(descriptor.binding.task.id)
      ? []
      : [policy("unbound", `Task ${descriptor.binding.task.id} is not registered.`)];
  }
  if (descriptor.kind === "pack-script") {
    if (!context.packRunner) return [policy("unbound", `Pack script ${descriptor.binding.packScript.scriptId} has no PackRunner.`)];
    try {
      const availability = await context.packRunner.availability(dirname(contribution.provenance.descriptorPath), descriptor.binding.packScript.scriptId);
      return availability.blockers.map((blocker) => ({
        dimension: "requirements",
        code: "probe-failed",
        message: blocker.message,
        remediation: { kind: "install", id: blocker.code },
      }));
    } catch (error) {
      return [{ dimension: "requirements", code: "runner-error", message: error instanceof Error ? error.message : String(error) }];
    }
  }
  const target = descriptor.binding.scenario.target;
  if (target === "inline") return [];
  const matched = context.catalogue?.some((candidate) => {
    const item = candidate.descriptor;
    return item.kind === target.kind && item.name === target.name && item.version === target.version && item.contentHash === target.contentHash;
  });
  return matched ? [] : [policy("unbound", `Scenario target ${target.kind}:${target.name}@${target.version} is not available.`)];
}

function stateFor(blockers: readonly Blocker[]): AvailabilityState {
  if (blockers.length === 0) return "ready";
  const first = blockers[0]!;
  if (first.dimension === "trust" || first.dimension === "policy") return "unsupported";
  switch (first.code) {
    case "unsupported-platform":
    case "unsupported-model-input": return "unsupported";
    case "probe-failed": return "needs-dependency";
    case "asset-missing": return "needs-asset";
    case "auth-required": return "needs-auth";
    case "secret-absent":
    case "secret-expired": return "needs-secret";
    case "server-down": return "needs-server";
    default: return "unsupported";
  }
}

/** Computes a new result on every invocation. No availability cache is kept. */
export async function computeAvailability(
  contribution: DiscoveredContribution,
  context: AvailabilityContext,
): Promise<Availability> {
  if (!isDiscoveredContribution(contribution)) {
    return {
      state: "unsupported",
      blockers: [{ dimension: "trust", code: "undiscovered-contribution", message: "Contribution must be issued by discoverContributions()." }],
    };
  }
  if (contribution.source.blockers.length > 0) {
    return { state: "unsupported", blockers: ordered(contribution.source.blockers) };
  }

  const blockers = await bindingBlockers(contribution, context);
  const requirements = contribution.descriptor.requirements;
  if (!requirements) {
    const result = ordered(blockers);
    return { state: stateFor(result), blockers: result };
  }

  if (requirements.platforms && !requirements.platforms.includes(context.platform as "darwin" | "win32" | "linux")) {
    blockers.push(unsupported("unsupported-platform", `Platform ${context.platform} is not supported.`));
  }
  for (const input of requirements.modelInputs ?? []) {
    if (!context.modelInputs?.includes(input)) blockers.push(unsupported("unsupported-model-input", `Selected model does not accept ${input} input.`));
  }
  for (const probe of requirements.probes ?? []) {
    let ok = false;
    if (context.packRunner) {
      try {
        ok = (await context.packRunner.probe(probe.packRoot)).some((result) => result.id === probe.id && result.ok);
      } catch {
        ok = false;
      }
    }
    if (!ok) blockers.push({
      dimension: "requirements", code: "probe-failed", message: `Required probe failed: ${probe.id}`,
      remediation: { kind: "install", id: probe.id },
    });
  }
  for (const asset of requirements.assets ?? []) {
    const present = await context.assetStatus?.(asset.id) ?? false;
    if (!present) blockers.push({
      dimension: "requirements", code: "asset-missing", message: `Managed asset is unavailable: ${asset.id}`,
      remediation: { kind: "asset", id: asset.id },
    });
  }
  for (const auth of requirements.auth ?? []) {
    const ready = await context.authStatus?.(auth.providerId) ?? false;
    if (!ready) blockers.push({
      dimension: "requirements", code: "auth-required", message: `Authentication is required: ${auth.providerId}`,
      remediation: { kind: "auth", id: auth.providerId },
    });
  }
  for (const secret of requirements.secrets ?? []) {
    const status = await context.secretStore?.status({ appId: context.manifest?.appId ?? contribution.descriptor.name, name: secret.name });
    if (!status || status.state === "absent") blockers.push({
      dimension: "requirements", code: "secret-absent", message: `Secret is required: ${secret.name}`,
      remediation: { kind: "secret", id: secret.name },
    });
    else if (status.expired) blockers.push({
      dimension: "requirements", code: "secret-expired", message: `Secret has expired: ${secret.name}`,
      remediation: { kind: "secret", id: secret.name },
    });
  }
  for (const server of requirements.server ?? []) {
    const healthy = await context.serverHealthCheck?.(server) ?? false;
    if (!healthy) blockers.push({
      dimension: "runtime", code: "server-down", message: `Required server is unavailable: ${server.id}`,
      remediation: { kind: "server", id: server.id },
    });
  }
  const result = ordered(blockers);
  return { state: stateFor(result), blockers: result };
}
