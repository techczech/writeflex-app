import { readFile } from 'node:fs/promises'
import type {
  RenameRepairIssue,
  RenameRepairOptions,
  RenameRepairPlan,
  RenameRepairPlannedWrite,
  RenameRepairResult,
} from './rename-repair'
import { DiskChangedUnderBuffer, DocumentChangedError, SavedButNotReadBack, type Workspace } from './workspace'
import { fingerprintOfRead } from './guarded-document-read'
import { repairReceipt } from '../shared/repair-receipt'

class RenameRepairApplyError extends Error {
  constructor(message: string, readonly unrevertedPaths: string[]) {
    super(message)
    this.name = 'RenameRepairApplyError'
  }
}

function result(writtenPaths: string[], issues: RenameRepairIssue[]): RenameRepairResult {
  return {
    writtenPaths,
    unrepairedReferences: issues
      .filter((issue) => issue.kind === 'reference')
      .map((issue) => issue.text),
    issues,
  }
}

async function diskContent(workspace: Workspace, path: string): Promise<string | null> {
  try {
    return await readFile(workspace.absolute(path), 'utf8')
  } catch {
    return null
  }
}

/** Preserve the plan's reference identity when applying it fails after the structural rename. */
export async function failedPlannedRenameRepairResult(
  plan: RenameRepairPlan,
  workspace: Workspace,
  error: unknown,
): Promise<RenameRepairResult> {
  const unrevertedPaths = error instanceof RenameRepairApplyError ? new Set(error.unrevertedPaths) : new Set<string>()
  const writtenPaths: string[] = []
  const writtenPathSet = new Set<string>()
  const failedPaths: string[] = []
  for (const write of plan.writes) {
    if (await diskContent(workspace, write.path) === write.content) {
      writtenPaths.push(write.path)
      writtenPathSet.add(write.path)
    } else if (unrevertedPaths.has(write.path)) {
      writtenPaths.push(write.path)
      writtenPathSet.add(write.path)
    }
    else failedPaths.push(write.path)
  }
  const reason = error instanceof Error ? error.message : String(error)
  const belongsToWrittenPath = (reference: string): boolean => (
    writtenPaths.some((path) => reference.startsWith(`${path}: `))
  )
  const repairedReferences = new Set(plan.plannedReferences.filter(belongsToWrittenPath))
  const completedOutcomes: RenameRepairIssue[] = []
  for (const outcome of plan.plannedOutcomes) {
    const write = plan.writes.find(({ path }) => path === outcome.path)
    const expected = plan.verification.markdown.find(({ path }) => path === outcome.path)
      ?? plan.verification.manifests.find(({ path }) => path === outcome.path)
    const remainsTrue = write
      ? writtenPathSet.has(outcome.path)
      : expected?.content !== null && expected?.content !== undefined
        && await diskContent(workspace, outcome.path) === expected.content
    if (remainsTrue) completedOutcomes.push({ kind: 'outcome', text: outcome.text })
  }
  return result(writtenPaths, [
    ...plan.unrepairedReferences
      .map((text): RenameRepairIssue => ({ kind: 'reference', text })),
    ...plan.plannedReferences
      .filter((text) => !repairedReferences.has(text))
      .map((text): RenameRepairIssue => ({ kind: 'reference', text })),
    ...completedOutcomes,
    ...failedPaths.map((text): RenameRepairIssue => ({ kind: 'file', text })),
    { kind: 'reason', text: reason },
  ])
}

/** At most this many paths are named in a drift refusal: a sync landing 200 files must not flash a wall of text. */
const DRIFT_NAMED = 3

/** The refusal when the workspace moved on between the rename's plan and its apply. Exported for its test. */
export function planDriftMessage(changedPaths: string[] = [], plannedReferences: string[] = []): string {
  const references = [...new Set(plannedReferences)]
  const changed = changedPaths.length
    ? ` ${changedPaths.length} ${changedPaths.length === 1 ? 'file was' : 'files were'} added or removed while the rename was prepared`
      + ` (${changedPaths.length > DRIFT_NAMED ? 'first three: ' : ''}${changedPaths.slice(0, DRIFT_NAMED).join(', ')}).`
    : ''
  const moreReferences = references.length - DRIFT_NAMED
  const named = references.length
    ? ` Planned references: ${references.slice(0, DRIFT_NAMED).join('; ')}${moreReferences > 0 ? ` and ${moreReferences} more` : ''}.`
    : ''
  return `The Rename Repair plan changed while the rename was being prepared.${changed}${named}`
}

function planDriftError(plan: RenameRepairPlan, changedPaths: string[] = []): Error {
  return new Error(planDriftMessage(changedPaths, plan.plannedReferences))
}

async function assertPlanStillMatchesDisk(plan: RenameRepairPlan, workspace: Workspace): Promise<void> {
  const listedPaths = (await workspace.listFiles()).map(({ path }) => path)
  const listedPathSet = new Set(listedPaths)
  const expectedPathSet = new Set(plan.verification.workspacePaths)
  const pathChanges = [
    ...listedPaths.filter((path) => !expectedPathSet.has(path)),
    ...plan.verification.workspacePaths.filter((path) => !listedPathSet.has(path)),
  ]
  if (pathChanges.length) throw planDriftError(plan, pathChanges)
  for (const write of plan.writes) {
    const expected = plan.verification.markdown.find(({ path }) => path === write.path)
      ?? plan.verification.manifests.find(({ path }) => path === write.path)
    if (!expected || await diskContent(workspace, write.path) !== expected.content) {
      throw planDriftError(plan)
    }
  }
  if (await diskContent(workspace, plan.toPath) !== plan.verification.renamedContent) {
    throw planDriftError(plan)
  }
}

export async function applyPlannedRenameRepair(
  plan: RenameRepairPlan,
  workspace: Workspace,
  options: RenameRepairOptions = {},
): Promise<RenameRepairResult> {
  await assertPlanStillMatchesDisk(plan, workspace)

  for (const write of plan.writes) {
    if (write.kind === 'manifest') await options.beforeManifestWrite?.(write.path)
    else await options.beforeMarkdownWrite?.(write.path)
  }

  const applied: RenameRepairPlannedWrite[] = []
  try {
    // Correctness invariant: this is the only forward-write loop, and it iterates the declared plan
    // directly. Apply therefore writes exactly the plan's path set: neither a subset nor a superset.
    for (const write of plan.writes) {
      const expected = plan.verification.markdown.find(({ path }) => path === write.path)
        ?? plan.verification.manifests.find(({ path }) => path === write.path)
      if (!expected || expected.content === null) throw planDriftError(plan)
      // Verification and checkpoints await: a save may have landed since. Compare the plan's
      // source bytes again in the commit tick, for Markdown AND manifests, before replacing them.
      // A write that committed counts as applied even if its read-back failed: rollback must cover it.
      try {
        await workspace.saveFileOverRead(write.path, write.content, expected.content)
      } catch (error) {
        if (!(error instanceof SavedButNotReadBack)) throw error
      }
      applied.push(write)
    }
  } catch (error) {
    const rollbackFailures: string[] = []
    const unrevertedPaths: string[] = []
    for (const write of [...applied].reverse()) {
      try {
        // Read through the Workspace (the guarded read where it has one), and put back only while the
        // file still holds those bytes at the moment of the rename: the save carries their fingerprint.
        const read = await workspace.readFile(write.path).catch(() => null)
        if (!read || read.content !== write.content) {
          rollbackFailures.push(`${write.path}: the file changed after Rename Repair wrote it`)
          unrevertedPaths.push(write.path)
          continue
        }
        const current = plan.verification.markdown.find(({ path }) => path === write.path)?.content
          ?? plan.verification.manifests.find(({ path }) => path === write.path)?.content
        if (current === null || current === undefined) throw new Error('The original content is absent from the Rename Repair plan.')
        // Put back only while the file still holds what Rename Repair wrote, compared again in the tick of the
        // rename (R7) and by the guarded write's fingerprint of the read above: a change made after the check
        // above is left as it is, never overwritten.
        try {
          await workspace.saveFileOver(write.path, current, { kind: 'disk', text: write.content }, { allowExplicitEmpty: true, expect: { fingerprint: fingerprintOfRead(read) } })
        } catch (putBackError) {
          if (putBackError instanceof DiskChangedUnderBuffer || putBackError instanceof DocumentChangedError) {
            rollbackFailures.push(`${write.path}: the file changed after Rename Repair wrote it`)
            unrevertedPaths.push(write.path)
            continue
          }
          if (!(putBackError instanceof SavedButNotReadBack)) throw putBackError
        }
      } catch (rollbackError) {
        rollbackFailures.push(`${write.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        unrevertedPaths.push(write.path)
      }
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new RenameRepairApplyError(
      `The file was renamed to ${plan.toPath}, but reference repair failed: ${reason}. `
      + (rollbackFailures.length ? `Rollback also failed for ${rollbackFailures.join('; ')}.` : 'No partial repair was left behind.'),
      unrevertedPaths,
    )
  }

  const receipts = await Promise.all(applied.map((write) => {
    const before = plan.verification.markdown.find(({ path }) => path === write.path)?.content
      ?? plan.verification.manifests.find(({ path }) => path === write.path)?.content ?? ''
    return repairReceipt(write.path, before, write.content)
  }))
  return {
    ...result(
      plan.writes.map((write) => write.path),
      [
        ...plan.unrepairedReferences.map((text): RenameRepairIssue => ({ kind: 'reference', text })),
        ...plan.plannedOutcomes.map((outcome): RenameRepairIssue => ({ kind: 'outcome', text: outcome.text })),
      ],
    ),
    receipts,
  }
}
