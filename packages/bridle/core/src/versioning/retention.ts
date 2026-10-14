import type { VersionStore } from "./store.ts";
import type { Checkpoint } from "./types.ts";

/**
 * Retention / garbage collection (PRD Decision 6, ticket T7).
 *
 * The timeline (manifests) is kept forever — it is kilobytes. This governs the
 * heavy part: the stored file CONTENTS. The retention policy selects checkpoints
 * whose bytes stay fully restorable (the recent window + milestones); any content
 * object no retained checkpoint references is collected. Missing collected objects
 * produce honest partial restore reports when an older checkpoint is restored —
 * the story stays, the old bytes go.
 */

export interface RetentionPolicy {
  keepFullLast?: number;
  milestoneEvery?: number;
}

export function referencedHashes(checkpoints: readonly Checkpoint[]): Set<string> {
  const hashes = new Set<string>();
  for (const checkpoint of checkpoints) {
    for (const entry of checkpoint.entries) {
      if (entry.kind === "file" && entry.hash) hashes.add(entry.hash);
    }
  }
  return hashes;
}

/** Delete every content object not referenced by a kept checkpoint. */
export async function collectGarbage(store: VersionStore, policy: RetentionPolicy): Promise<{ deleted: number; kept: number }> {
  return store.withLock(async () => {
    const checkpoints = await store.checkpoints();
    const keptCheckpoints = checkpointsToKeepFull(checkpoints, policy);
    const keep = referencedHashes(keptCheckpoints);
    const present = await store.objectHashes();
    let deleted = 0;
    for (const hash of present) {
      if (!keep.has(hash)) { await store.deleteObject(hash); deleted += 1; }
    }
    return { deleted, kept: keep.size };
  });
}

/**
 * Choose which checkpoints keep full content: the most recent `keepFullLast`, plus
 * every `milestoneEvery`-th older one. A size budget layers on top by the caller
 * (shrink the window until under budget). Defaults are conservative — thinning only
 * kicks in past a sizeable recent history.
 */
export function checkpointsToKeepFull(
  all: readonly Checkpoint[],
  policy: RetentionPolicy = {},
): Checkpoint[] {
  const keepFullLast = policy.keepFullLast ?? 50;
  const milestoneEvery = policy.milestoneEvery ?? 10;
  const recent = all.slice(-keepFullLast);
  const older = all.slice(0, Math.max(0, all.length - keepFullLast));
  const milestones = older.filter((_, i) => i % milestoneEvery === 0);
  return [...milestones, ...recent];
}
