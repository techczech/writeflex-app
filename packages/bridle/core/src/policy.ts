import type { ApprovalPolicy } from "./types.ts";

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
