import type { Adapter, ManifestGrants } from "./types.ts";

// Deny-by-default egress gating (ADR-0003, ADR-0017), by egress class:
//   none     → structural (a sandboxed subprocess); never needs a grant.
//   loopback → privileged: auto-granted by default policy; an explicit grant is
//              required only when autoGrantLoopback === false.
//   remote   → always needs an explicit (taskId, adapterId) grant.
export function isEgressGranted(adapter: Adapter, taskId: string, grants: ManifestGrants): boolean {
  if (adapter.egress === "none") return true;
  if (adapter.egress === "loopback" && grants.autoGrantLoopback !== false) return true;
  return grants.granted.some((g) => g.adapterId === adapter.id && g.taskId === taskId);
}
