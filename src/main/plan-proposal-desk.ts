/**
 * The running-order proposal's life after the agent stages it (ticket 09): its card view, Accept as
 * ONE undoable step, Discard, and the guarded Undo. The pending proposal is the agent conversation's
 * own Bridle Proposal; this desk only remembers, in memory, what each proposal was measured against
 * and, once accepted, what its undo would restore.
 *
 * Accept follows the host-applied precedent of `acceptRecordedMove` (agent.ts): one restore point,
 * a snapshot of every file the step may write, the existing Plan operations, then the Proposal is
 * settled as superseded-by-host. Undo is that restore point's `restoreTo`, refused whenever it would
 * overwrite something that changed afterwards.
 */

import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { posix } from 'node:path'
import type { Proposal, ProposalSettlementResult, HostProposalSettlement, JournalEntry } from '@bridle/core'
import { MANIFEST_NAME } from './folio'
import { folioDeclaration } from './folio-declaration'
import { planBackupPaths, readPlan } from './plan'
import { withPlanLock } from './plan-lock'
import type { OperationWrite, Workspace } from './workspace'
import { rollBackOperationWrites, rollbackMessage } from './operation-rollback'
import { collectionWritesPaused, pausedMessage } from './collection-write-gate'
import { restoreFailure, type RestoreFailure } from './restore-failure'
import {
  driftedFiles,
  resolveProposal,
  entriesFromEdits,
  undoRefusalMessage,
  type AcceptedSummary,
  type Fingerprint,
  type PlanAcceptEdits,
  type PlanAcceptResult,
  type PlanProposalView,
  type PlanUndoResult,
  type ProposalBasis,
  type PlanProposalInput,
  type FileDrift,
} from '../shared/plan-proposal'
import {
  filesNow,
  fingerprintsFor,
  parseProposalInput,
  prepareFromBasis,
  proposalBasis,
  runPlanOperations,
} from './plan-proposal'

export const PLAN_PROPOSE = 'plan.propose'

/** The slice of a Bridle handle the desk needs (a test can pass a real handle's parts). */
export type PlanDeskBridle = {
  proposals: {
    get(id: string): Promise<Proposal | undefined>
    settleAsHost(id: string, settlement: HostProposalSettlement): Promise<ProposalSettlementResult>
    reject(id: string, by?: 'user'): Promise<ProposalSettlementResult>
  }
  snapshots: {
    beginRestorePoint(label: string, sessionId?: string, meta?: { proposalId?: string }): Promise<string>
    snapshotFile(absPath: string, meta: { sessionId?: string; capability?: string; origin?: 'turn' | 'host' }): Promise<unknown>
    restoreTo(restorePointId: string, opts?: { origin?: 'turn' | 'host' }): Promise<string[]>
    entries(): Promise<JournalEntry[]>
  }
  sessionId(): string
}

type Captured = { input: PlanProposalInput; basis: ProposalBasis; prints: Fingerprint[] }
type AcceptRecord = {
  restorePointId: string
  dir: string
  /** Absolute paths snapshotted before the step wrote. */
  targets: string[]
  /** How every written file and every part file stood right after the step. */
  after: Fingerprint[]
  extra: string[]
  /** The backups this step created (absent before it), with the bytes it wrote into them. */
  backups: StepBackup[]
  summary: AcceptedSummary
}

type StepBackup = { path: string; content: Buffer }

/** Of the backups that were absent before a step, the ones that stand now: the step made them. */
async function backupsNow(absent: string[]): Promise<StepBackup[]> {
  const out: StepBackup[] = []
  for (const path of absent) if (existsSync(path)) out.push({ path, content: await readFile(path) })
  return out
}

/**
 * Remove the backups a step made, each only while it still holds the bytes recorded for it. The
 * guard is real when the backups were captured right after the step's operations succeeded; on the
 * roll-back of operations that threw, the capture is taken at roll-back time and the guard is moot.
 */
async function removeBackups(backups: StepBackup[]): Promise<void> {
  for (const backup of backups) {
    // A backup is a file inside the Collection: it is not removed while this app does not hold the
    // Collection. It stays as a pristine copy, which is what it would be had the step succeeded.
    if (collectionWritesPaused(backup.path)) continue
    const now = existsSync(backup.path) ? await readFile(backup.path).catch(() => null) : null
    if (now && now.equals(backup.content)) await rm(backup.path, { force: true })
  }
}

export class PlanProposalDesk {
  private readonly captured = new Map<string, Captured>()
  private readonly accepted = new Map<string, AcceptRecord>()

  constructor(private readonly workspace: Workspace, private readonly bridle: PlanDeskBridle) {}

  /**
   * Remember what the proposal was measured against. Called the moment Bridle stages it; after a
   * relaunch the first view captures instead, so staleness is measured from then.
   */
  async capture(id: string, payload?: unknown): Promise<Captured | null> {
    const known = this.captured.get(id)
    if (known) return known
    const raw = payload ?? (await this.bridle.proposals.get(id))?.payload
    try {
      const input = parseProposalInput(raw)
      const basis = await proposalBasis(this.workspace, input.dir)
      const prepared = await prepareFromBasis(this.workspace, input, basis)
      const captured = { input, basis, prints: await fingerprintsFor(this.workspace, prepared.writes, prepared.referenced) }
      this.captured.set(id, captured)
      return captured
    } catch {
      return null
    }
  }

  private async drift(captured: Captured) {
    const extra = captured.prints.filter((print) => print.title === undefined).map((print) => print.path)
    return driftedFiles(captured.prints, await filesNow(this.workspace, captured.basis.dir, extra))
  }

  async view(id: string): Promise<PlanProposalView | null> {
    const proposal = await this.bridle.proposals.get(id)
    if (!proposal || proposal.capability !== PLAN_PROPOSE) return null
    const record = this.accepted.get(id)
    const captured = await this.capture(id, proposal.payload)
    let input: PlanProposalInput
    try {
      input = captured?.input ?? parseProposalInput(proposal.payload)
    } catch {
      return null
    }
    const basis = captured?.basis ?? await proposalBasis(this.workspace, input.dir).catch(() => null)
    if (!basis) return null
    const stale = proposal.status === 'proposed' || proposal.status === 'stale'
      ? (captured ? await this.drift(captured) : [])
      : []
    const status = record ? 'accepted'
      : proposal.status === 'rejected' ? 'discarded'
        : proposal.status === 'proposed' ? (stale.length ? 'stale' : 'pending')
          : proposal.status === 'stale' ? 'stale'
            : 'gone'
    return {
      id,
      status,
      dir: input.dir,
      ...(input.summary ? { summary: input.summary } : {}),
      basis,
      changes: input.changes,
      stale,
      ...(record ? { accepted: record.summary } : {}),
    }
  }

  /**
   * Accept: apply every remaining change as one undoable step. Nothing is written when the
   * proposal is stale, invalid after the writer's edits, or no longer pending.
   */
  async accept(id: string, edits?: PlanAcceptEdits): Promise<PlanAcceptResult> {
    // The staleness check, the snapshot, every Plan operation and a roll-back are one hold of the Folio's
    // lock (plan-lock.ts), so no other Plan write lands between them.
    const captured = await this.capture(id)
    if (!captured) return this.acceptHeld(id, edits)
    return withPlanLock(this.workspace, captured.input.dir, () => this.acceptHeld(id, edits))
  }

  private async acceptHeld(id: string, edits?: PlanAcceptEdits): Promise<PlanAcceptResult> {
    const proposal = await this.bridle.proposals.get(id)
    if (!proposal || proposal.capability !== PLAN_PROPOSE) return { ok: false, message: 'That proposal no longer exists.' }
    const captured = await this.capture(id, proposal.payload)
    if (!captured) return { ok: false, message: 'This proposal no longer fits the folder; ask the agent to propose again.' }
    const stale = await this.drift(captured)
    if (stale.length || proposal.status === 'stale') return { ok: false, message: 'The folder changed after this was proposed.', stale }
    if (proposal.status !== 'proposed') return { ok: false, message: `This proposal was already ${proposal.status}; nothing was applied.` }

    let prepared
    try {
      prepared = await prepareFromBasis(this.workspace, captured.input, await proposalBasis(this.workspace, captured.input.dir), edits)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message.replace('was not staged', 'cannot be applied') : String(error) }
    }
    const dir = prepared.basis.dir
    // The restore point, the snapshots and the files are all inside the Collection: none is written
    // while this app does not hold it.
    const paused = pausedMessage(this.workspace.root)
    if (paused) return { ok: false, message: `Nothing was changed: ${paused}` }
    const sessionId = this.bridle.sessionId()
    const restorePointId = await this.bridle.snapshots.beginRestorePoint(`running order: ${dir || 'workspace root'}`, sessionId, { proposalId: id })
    // The Plan operations leave a pristine-copy backup beside the Index Note and the manifest the
    // first time they write them. Only a backup absent now can be one this step creates; one that
    // already stands is never touched by the step and is kept.
    const absentBackups = planBackupPaths(this.workspace, dir)
      .map((path) => this.workspace.absolute(path))
      .filter((target) => !existsSync(target))
    const targets = prepared.writes.map((path) => this.workspace.absolute(path))
    for (const target of targets) {
      await this.bridle.snapshots.snapshotFile(target, { sessionId, capability: PLAN_PROPOSE, origin: 'turn' })
    }
    // Every file the operations write (documents, manifest, stubs, the pristine-copy backups), with what it
    // held before and what they left. A rollback puts back only those, each only while it still holds what
    // the step wrote (R7): not Bridle's restoreTo, which would put the snapshots back over a version
    // another program wrote, the one that made the step refuse (final review round 3, P2). One turn of the
    // Collection's write turn (collection-write-turn.ts): no save, accept or restore of this app in between.
    const written: OperationWrite[] = []
    const rollBack = async (reason: string): Promise<PlanAcceptResult> => (
      { ok: false, message: rollbackMessage(reason, await this.workspace.exclusiveAll(() => rollBackOperationWrites(this.workspace, written))) }
    )
    let result
    try {
      result = await this.workspace.recordingOperationWrites(written, () => runPlanOperations(this.workspace, dir, prepared.ops))
    } catch (error) {
      return rollBack(error instanceof Error ? error.message : String(error))
    }
    // The backups this step created, with the bytes it wrote, captured the moment its writes end.
    const backups = await backupsNow(absentBackups)
    const settlement = await this.bridle.proposals.settleAsHost(id, { status: 'superseded', reason: 'superseded-by-host' })
    if (settlement.refused) return rollBack(`the proposal was settled elsewhere (${settlement.refused}).`)

    const finalParts = result.plan?.parts ?? []
    const inOrder = new Set(finalParts.flatMap((part) => (part.path ? [part.path] : [])))
    const basisNow = await proposalBasis(this.workspace, dir)
    const summary: AcceptedSummary = {
      count: prepared.proposed.count,
      folderName: posix.basename(dir || this.workspace.root),
      parts: finalParts.map((part) => ({ title: part.title, path: part.path })),
      outside: basisNow.strays.filter((stray) => !inOrder.has(stray.path)).map((stray) => ({ title: stray.title, path: stray.path })),
      createdIndexNote: prepared.proposed.createsIndexNote,
      manifest: folioDeclaration(this.workspace, dir).manifest,
      undoable: true,
    }
    const referenced = finalParts.flatMap((part) => (part.path && !prepared.writes.includes(part.path) ? [part.path] : []))
    const after = await fingerprintsFor(this.workspace, prepared.writes, referenced)
    this.accepted.set(id, { restorePointId, dir, targets, after, extra: prepared.writes, backups, summary })
    this.captured.delete(id)
    return { ok: true, accepted: summary, paths: [...new Set([...prepared.writes, ...result.created])] }
  }

  /** Discard a pending or stale proposal. Nothing is written. */
  async discard(id: string): Promise<void> {
    const settlement = await this.bridle.proposals.reject(id, 'user')
    if (settlement.refused && settlement.refused !== 'already-settled') {
      throw new Error(`Could not discard the proposal: settlement was refused (${settlement.refused}).`)
    }
    this.captured.delete(id)
  }

  /**
   * Undo the accepted step, or refuse and say what is in the way: a file the step wrote or depends
   * on that changed since, or a later agent change that the restore would also take back.
   */
  undo(id: string): Promise<PlanUndoResult> {
    // The Folio's Plan lock (plan-lock.ts) first, then ONE turn of the Collection's write turn for the checks
    // and the restore together: the same order as every Plan write (lock, then the turn its saves take), so
    // the two never wait on each other. Nothing in this app writes between the check that the step's files
    // are unchanged and the restore that puts them back, and the restore runs before or after an accept or
    // a save, never during one.
    const held = this.accepted.get(id)
    if (!held) return this.workspace.exclusiveAll(() => this.undoInTurn(id))
    return withPlanLock(this.workspace, held.dir, () => this.workspace.exclusiveAll(() => this.undoInTurn(id)))
  }

  private async undoInTurn(id: string): Promise<PlanUndoResult> {
    const record = this.accepted.get(id)
    if (!record) return { ok: false, message: "Can't put the order back from here: this step is no longer held for undo. Change the order in the Folio outline pane." }
    const drift = await this.pairRenames(record, driftedFiles(record.after, await filesNow(this.workspace, record.dir, record.extra)))
    const entries = await this.bridle.snapshots.entries()
    const point = entries.findIndex((entry) => entry.kind === 'restore-point' && entry.id === record.restorePointId)
    if (point < 0) return { ok: false, message: "Can't put the order back: its restore point is gone. Change the order in the Folio outline pane." }
    const ours = new Set(record.targets)
    const laterAgentFiles = [...new Set(entries.slice(point + 1).flatMap((entry) => {
      if (entry.kind === 'undo-action' && (entry.origin ?? 'turn') === 'turn') return ['a folder']
      if (entry.kind !== 'snapshot' || (entry.origin ?? 'turn') !== 'turn' || ours.has(entry.file)) return []
      return [this.workspace.relative(entry.file)]
    }))]
    if (drift.length || laterAgentFiles.length) {
      return { ok: false, message: undoRefusalMessage({ drift, laterAgentFiles }) }
    }
    const paused = pausedMessage(this.workspace.root)
    if (paused) return { ok: false, message: `Can't put the order back: ${paused}` }
    let restored: string[]
    try {
      restored = await this.bridle.snapshots.restoreTo(record.restorePointId, { origin: 'turn' })
    } catch (error) {
      // Refused: nothing was written and the undo is still held. Stopped part-way: the order is
      // half put back, and the writer is told which files were and were not.
      return { ok: false, message: `Can't put the order back. ${restoreFailure(error, this.workspace.root).message}` }
    }
    await removeBackups(record.backups)
    this.accepted.delete(id)
    return { ok: true, paths: restored.map((path) => this.workspace.relative(path)) }
  }

  /**
   * A part renamed in WriteFlex usually changes its file name, its title and its plan line at once,
   * so its content no longer matches. Pair a vanished part with the part now standing in its place
   * in the running order, so the refusal can say "renamed X to Y" (frame 5).
   */
  private async pairRenames(record: AcceptRecord, drift: FileDrift[]): Promise<FileDrift[]> {
    if (!drift.some((item) => item.kind === 'missing')) return drift
    const now = (await readPlan(this.workspace, record.dir).catch(() => null))?.parts ?? []
    return drift.map((item) => {
      if (item.kind !== 'missing') return item
      const place = record.summary.parts.findIndex((part) => part.path === item.path)
      const standing = place >= 0 ? now[place] : undefined
      const known = new Set(record.summary.parts.map((part) => part.path))
      if (!standing || known.has(standing.path) || standing.title === item.fromTitle) return item
      return { ...item, kind: 'renamed', ...(standing.path ? { to: standing.path } : {}), toTitle: standing.title }
    })
  }

  /** Whether `id` holds a live undo (for ⌘⇧Z routing). */
  hasUndo(id: string): boolean {
    return this.accepted.has(id)
  }

  /** Proposed order for a view, recomputed for the given edits (used by tests and the IPC view). */
  static proposedFor(view: PlanProposalView, edits?: PlanAcceptEdits) {
    return resolveProposal(view.basis, entriesFromEdits(view.changes, edits))
  }
}
