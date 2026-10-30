import type { AgentTrigger, ApprovalDecision, ApprovalPolicy, BridleMode, Capability } from "./types.ts";

/** Mode/trust is the floor; host policy can only raise the required consent. */
export async function modeApprovalDecision(
  mode: BridleMode,
  capability: Pick<Capability, "name" | "risk" | "showFirst">,
  input: unknown,
  trigger: AgentTrigger,
  policy: ApprovalPolicy,
  outsideWorkspace = false,
): Promise<ApprovalDecision> {
  let floor: ApprovalDecision;
  if (trigger.trust !== "interactive" && trigger.trust !== "trusted_app") {
    floor = capability.risk === "read" ? "allow" : capability.risk === "destructive" ? "deny" : "stage";
  } else if (mode === "read-only" && capability.risk !== "read") {
    floor = { decision: "deny", reason: { code: "read-only-mode", message: "This call cannot run in read-only mode." } };
  } else if (capability.risk === "read") floor = "allow";
  else if (capability.risk === "destructive" || outsideWorkspace) floor = "ask";
  else if (mode === "suggest" || (typeof capability.showFirst === "function" ? capability.showFirst(input) : capability.showFirst)) floor = "stage";
  else floor = "allow";
  if (typeof floor !== "string" || floor === "deny") return floor;
  const host = await policy({ capability: { name: capability.name, risk: capability.risk }, input, trigger });
  if (typeof host === "object" && host?.decision === "deny") return host;
  const rank = { allow: 0, stage: 1, ask: 2, deny: 3 };
  if (typeof host !== "string" || !Object.hasOwn(rank, host)) return "deny";
  return rank[host] > rank[floor] ? host : floor;
}

/**
 * ADR-0004 default: trusted triggers may read/write/sync freely but must ask
 * for destructive calls; untrusted (background/scheduled) triggers stage all
 * writes and never run destructive calls.
 */
export function defaultApprovalPolicy(): ApprovalPolicy {
  return ({ capability, trigger }) => {
    const trusted = trigger.trust === "interactive" || trigger.trust === "trusted_app";
    if (capability.risk === "read") return "allow";
    if (capability.risk === "destructive") return trusted ? "ask" : "deny";
    return trusted ? "allow" : "stage";
  };
}
