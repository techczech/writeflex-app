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
  // Staleness only means anything for a still-actionable proposal: it warns the
  // reviewer that the files moved under a PENDING proposal. Once a proposal is
  // adopted/rejected/superseded the files legitimately differ from the baseline
  // (adoption is *why* they changed), so a "files changed" warning there is
  // false and confusing. Gate on status exactly as the store's isStale does.
  // Uses the directory-safe hash so a folder baseline never reads a folder.
  let stale = false;
  if (proposal.status === "proposed") {
    for (const baseline of proposal.baseline ?? []) {
      if (await contentHashOf(baseline.path) !== baseline.hash) {
        stale = true;
        break;
      }
    }
  }

  if (proposal.kind === "action") {
    // A structural Action (folder move/delete/create) still previews as an
    // op-card when it declares renderOps — the reviewer sees "rename A → B", not
    // a raw JSON payload — even though it carries no content baseline.
    const structuralOps = capability.renderOps?.(proposal.payload);
    if (structuralOps) {
      return { kind: "file-ops", ops: structuralOps, inferred: false, stale };
    }
    return {
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

  const fallbackPaths = proposal.baseline?.map((entry) => entry.path) ?? [];
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
    return { kind: "file-ops", ops: renderedOps, inferred: false, stale };
  }
  const rendered = capability.renderChange?.(proposal.payload);
  if (paths.length === 1 && rendered?.length === 1) {
    return {
      kind: "text-diff",
      before: existsSync(rendered[0]!.path) ? await readFile(rendered[0]!.path, "utf8") : "",
      after: rendered[0]!.after,
      stale,
    };
  }

  const baselineByPath = new Map((proposal.baseline ?? []).map((entry) => [entry.path, entry.hash]));
  return {
    kind: "file-ops",
    ops: paths.map((path) => ({
      op: baselineByPath.get(path) === ABSENT_HASH ? "create" : existsSync(path) ? "modify" : "delete",
      path,
    })),
    inferred: true,
    stale,
  };
}
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ABSENT_HASH } from "../snapshots.ts";
import { contentHashOf } from "../hashing.ts";
