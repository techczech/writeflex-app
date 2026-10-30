import type { AuditLog, Capability, TraceEvent } from "../types.ts";
import type { Proposal, ProposalPreview } from "./types.ts";

export async function deriveProposalPreview(
  proposal: Proposal,
  capability: Capability,
  diagnostics?: {
    trace?: (event: Omit<TraceEvent, "id" | "timestamp">) => void;
    audit?: AuditLog;
  },
): Promise<ProposalPreview> {
  // An explicit stale settlement remains visible. Adopted/rejected/superseded
  // proposals do not become stale merely because execution changed their files.
  // Still-proposed plain-file baselines retain lazy checks; folder state comes
  // from the store's explicit recheck or fresh Adoption verification.
  const baselines = proposal.baseline?.map(boundedBaselinePreview);
  let stale = proposal.status === "stale";
  if (proposal.status === "proposed") {
    for (const baseline of baselines ?? []) {
      // Folder previews reflect stored state. Only explicit recheck/Adoption
      // walks the tree; rendering the same card must not repeat that work.
      if (baseline.directory) continue;
      if (await baselineHash(baseline) !== baseline.hash) {
        stale = true;
        break;
      }
    }
  }

  const directories = baselines?.flatMap((entry) => {
    const directory = entry.directory;
    if (!directory) return [];
    // Construct overflow previews explicitly, so old journals with partial
    // entries cannot accidentally present an incomplete list as the contents.
    return [directory.baseline === "too-large"
      ? { path: entry.path, baseline: "too-large" as const, entryCount: directory.entryCount, bytes: directory.bytes, message: "too many to list" }
      : { path: entry.path, ...directory,
          ...(directory.tier === "metadata" ? { message: metadataBaselineNotice(directory.entryCount) } : {}),
        }];
  });
  const listing = directories?.length ? { directories } : {};
  if (proposal.kind === "action") {
    // A structural Action (folder move/delete/create) still previews as an
    // op-card when it declares renderOps — the reviewer sees "rename A → B", not
    // a raw JSON payload. Folder listings accompany the declared operations.
    const structuralOps = capability.renderOps?.(proposal.payload);
    if (structuralOps) {
      return { kind: "file-ops", ops: structuralOps, inferred: false, stale, ...listing };
    }
    return {
      ...listing,
      kind: "invocation",
      capability: capability.name,
      description: capability.description,
      input: proposal.payload,
      risk: capability.risk,
      egress: capability.egress ?? "none",
      reversible: Boolean(capability.undo) || (capability.risk !== "destructive" && capability.risk !== "sync"),
      stale,
    };
  }

  const fallbackPaths = baselines?.map((entry) => entry.path) ?? [];
  let paths = fallbackPaths;
  try {
    // touchedPaths may read the workspace and therefore runs on every render.
    // A transient discovery failure must not remove the consent card; the
    // staged baseline remains a safe, deterministic fallback.
    const discoveredPaths = capability.touchedPaths?.(proposal.payload);
    paths = (discoveredPaths && !Array.isArray(discoveredPaths) ? await discoveredPaths : discoveredPaths)
      ?? fallbackPaths;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const metadata = {
      proposalId: proposal.id,
      capability: capability.name,
      fallback: "staged-baseline",
      error: message,
    };
    diagnostics?.trace?.({
      type: "proposal.preview.discovery_failed",
      title: `Proposal ${proposal.id}: touched-path discovery failed during preview`,
      metadata,
    });
    await diagnostics?.audit?.record({
      type: "proposal.preview.discovery_failed",
      timestamp: Date.now(),
      sessionId: proposal.sessionId,
      turnId: proposal.turnId,
      capability: capability.name,
      toolCallId: proposal.toolCallId,
      message,
      metadata,
    });
    paths = fallbackPaths;
  }
  const renderedOps = capability.renderOps?.(proposal.payload);
  if (renderedOps) {
    return { kind: "file-ops", ops: renderedOps, inferred: false, stale, ...listing };
  }
  const rendered = capability.renderChange?.(proposal.payload);
  if (paths.length === 1 && rendered?.length === 1) {
    return {
      ...listing,
      kind: "text-diff",
      before: existsSync(rendered[0]!.path) ? await readFile(rendered[0]!.path, "utf8") : "",
      after: rendered[0]!.after,
      stale,
    };
  }

  const baselineByPath = new Map((baselines ?? []).map((entry) => [entry.path, entry.hash]));
  return {
    kind: "file-ops",
    ops: paths.map((path) => ({
      op: baselineByPath.get(path) === ABSENT_HASH ? "create" : existsSync(path) ? "modify" : "delete",
      path,
    })),
    ...listing,
    inferred: true,
    stale,
  };
}
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ABSENT_HASH } from "../snapshots.ts";
import { baselineHash, metadataBaselineNotice, boundedBaselinePreview } from "../hashing.ts";
