/**
 * The Board's material steps as ONE undo group each (docs/design/2026-09-27-scraps-and-sources-on-the-board,
 * frames 3 and 4): offcut to idea and add a drawer scrap to the end of its piece (both write two
 * files), and attach a source to a piece (one line in the piece's frontmatter).
 *
 * Follows PlanProposalDesk's restore-point pattern: one restore point, a snapshot of every file the
 * step writes, then the writes. A failed write rolls back only the files the step wrote, each only while
 * it still holds what the step wrote (R7, operation-rollback.ts); a refusal before the first write puts
 * nothing back, so the other version that caused it stays. The snapshots are
 * `origin: 'host'` — the writer's own act on the Board — so the agent's Undo turn (which restores
 * `turn` snapshots only) never takes a Board step back, and this desk's undo never takes back an
 * agent turn. Undo is refused whenever it would overwrite something that changed afterwards.
 *
 * The desk holds one step: the latest, which the activity row's Undo ⌘⇧Z reaches.
 */

import { queueThenTurn } from './collection-write-order'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { JournalEntry } from '@bridle/core'
import type { OperationWrite, Workspace } from './workspace'
import { rollBackOperationWrites, rollbackMessage } from './operation-rollback'
import { pausedMessage } from './collection-write-gate'
import { restoreFailure } from './restore-failure'
import type { ScrapStore } from './scraps'
import { prepareOffcutPromotion, prepareScrapAppend, writeMaterial, type MaterialWrite } from './board-material'
import { prepareSourceAttach } from './source-attach'
import {
  OFFCUT_BECAME_IDEA,
  SOURCE_ATTACHED,
  scrapAddedTo,
  type AppendScrapInput,
  type AttachSourceInput,
  type BoardStep,
  type BoardStepKind,
  type BoardStepResult,
  type BoardUndoResult,
  type PromoteOffcutInput,
} from '../shared/board-material'

/** The slice of a Bridle handle the desk needs (a test passes a real SnapshotStore). */
export type BoardDeskBridle = {
  snapshots: {
    beginRestorePoint(label: string, sessionId?: string): Promise<string>
    snapshotFile(absPath: string, meta: { sessionId?: string; capability?: string; origin?: 'turn' | 'host' }): Promise<unknown>
    restoreTo(restorePointId: string, opts?: { origin?: 'turn' | 'host' }): Promise<string[]>
    entries(): Promise<JournalEntry[]>
  }
  sessionId(): string
}

export const OFFCUT_TO_IDEA_CAPABILITY = 'board.offcut-to-idea'
export const SCRAP_TO_PIECE_CAPABILITY = 'board.scrap-to-piece'
export const ATTACH_SOURCE_CAPABILITY = 'board.attach-source'

type HeldStep = {
  step: BoardStep
  /** Absolute paths snapshotted before the step wrote. */
  targets: string[]
  /** How each written file stood right after the step (null: absent). */
  after: Array<{ path: string; content: string | null }>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class BoardMaterialDesk {
  private held: HeldStep | null = null

  constructor(
    private readonly workspace: Workspace,
    private readonly bridle: BoardDeskBridle,
    /** Scraps-file writes ride the store's chain, so they never interleave with a pane or agent write. */
    private readonly scraps: Pick<ScrapStore, 'exclusive'>,
  ) {}

  /** Make an idea from an offcut: one line (plus the quote) in the tracker, the scrap out of its file. */
  promoteOffcut(input: PromoteOffcutInput): Promise<BoardStepResult> {
    return this.apply('idea', OFFCUT_TO_IDEA_CAPABILITY, async () => {
      const plan = await prepareOffcutPromotion(this.workspace, input)
      return { label: `offcut to idea: ${plan.target}`, activity: OFFCUT_BECAME_IDEA, writes: [plan.tracker, plan.scraps] }
    })
  }

  /** Add a drawer scrap to the end of its piece: the text appended, the scrap out of its file. */
  appendScrap(input: AppendScrapInput): Promise<BoardStepResult> {
    return this.apply('append', SCRAP_TO_PIECE_CAPABILITY, async () => {
      const plan = await prepareScrapAppend(this.workspace, input)
      return { label: `scrap to end of ${input.piece}`, activity: scrapAddedTo(plan.pieceTitle), writes: [plan.piece, plan.scraps] }
    })
  }

  /** Attach a source from the rail to a piece: one line added to its frontmatter `sources:` list. */
  attachSource(input: AttachSourceInput): Promise<BoardStepResult> {
    return this.apply('source', ATTACH_SOURCE_CAPABILITY, async () => {
      const plan = await prepareSourceAttach(this.workspace, input)
      return { label: `attach source ${input.source} to ${input.piece}`, activity: SOURCE_ATTACHED, writes: [plan.piece] }
    })
  }

  /** The step Undo ⌘⇧Z would take back, if one is held. */
  latest(): BoardStep | null {
    return this.held?.step ?? null
  }

  private async readNow(path: string): Promise<string | null> {
    const absolute = this.workspace.absolute(path)
    return existsSync(absolute) ? readFile(absolute, 'utf8') : null
  }

  private apply(
    kind: BoardStepKind,
    capability: string,
    prepare: () => Promise<{ label: string; activity: string; writes: MaterialWrite[] }>,
  ): Promise<BoardStepResult> {
    // The scrap store's queue, then ONE turn of the Collection's write turn (collection-write-order.ts)
    // from the read the step is planned from to its last write.
    return queueThenTurn(this.scraps, this.workspace, async (): Promise<BoardStepResult> => {
      let prepared
      try {
        prepared = await prepare()
      } catch (error) {
        return { ok: false, message: message(error) }
      }
      // The restore point, the snapshots and the files are all inside the Collection: none is
      // written while this app does not hold it.
      const paused = pausedMessage(this.workspace.root)
      if (paused) return { ok: false, message: `Nothing was changed: ${paused}` }
      const sessionId = this.bridle.sessionId()
      const restorePointId = await this.bridle.snapshots.beginRestorePoint(prepared.label, sessionId)
      const targets = prepared.writes.map((write) => this.workspace.absolute(write.path))
      for (const target of targets) await this.bridle.snapshots.snapshotFile(target, { sessionId, capability, origin: 'host' })
      const written: OperationWrite[] = []
      try {
        await this.workspace.recordingOperationWrites(written, () => writeMaterial(this.workspace, prepared.writes))
      } catch (error) {
        // Not Bridle's restoreTo: it puts each snapshot back over whatever is there now, which would
        // overwrite the other program's version that refused the write (final review round 3, P2).
        return { ok: false, message: rollbackMessage(message(error), await rollBackOperationWrites(this.workspace, written)) }
      }
      const step: BoardStep = { id: restorePointId, kind, activity: prepared.activity }
      this.held = { step, targets, after: prepared.writes.map((write) => ({ path: write.path, content: write.after })) }
      return { ok: true, step, paths: prepared.writes.map((write) => write.path) }
    })
  }

  /**
   * Undo the held step: every file it wrote back byte for byte. Refused, with nothing written, when
   * any of them changed since, or when a later Board step on another file would be taken back with it.
   */
  undo(id: string): Promise<BoardUndoResult> {
    // The scrap store's queue, then ONE turn of the Collection's write turn for the checks and the
    // restore together (collection-write-order.ts): nothing in this app writes between the check
    // that the step's files are unchanged and the restore that puts them back.
    return queueThenTurn(this.scraps, this.workspace, async (): Promise<BoardUndoResult> => {
      const held = this.held
      if (!held || held.step.id !== id) return { ok: false, message: 'That change is no longer held for undo.' }
      const changed: string[] = []
      for (const file of held.after) if ((await this.readNow(file.path)) !== file.content) changed.push(file.path)
      if (changed.length) {
        return { ok: false, message: `Can't undo: ${changed.join(' and ')} changed since. Nothing was put back.` }
      }
      const entries = await this.bridle.snapshots.entries()
      const point = entries.findIndex((entry) => entry.kind === 'restore-point' && entry.id === id)
      if (point < 0) return { ok: false, message: "Can't undo: its restore point is gone." }
      const ours = new Set(held.targets)
      const laterHostWrite = entries.slice(point + 1).some((entry) => (
        (entry.kind === 'snapshot' && entry.origin === 'host' && !ours.has(entry.file))
        || (entry.kind === 'undo-action' && entry.origin === 'host')
      ))
      if (laterHostWrite) return { ok: false, message: "Can't undo: a later change would be taken back with it. Nothing was put back." }
      const paused = pausedMessage(this.workspace.root)
      if (paused) return { ok: false, message: `Can't undo: ${paused} Nothing was put back.` }
      let restored: string[]
      try {
        restored = await this.bridle.snapshots.restoreTo(id, { origin: 'host' })
      } catch (error) {
        // Refused: nothing was written and the step is still held. Stopped part-way: the step is
        // half undone, and the writer is told which files were and were not put back.
        return { ok: false, message: `Can't undo. ${restoreFailure(error, this.workspace.root).message}` }
      }
      this.held = null
      return { ok: true, paths: restored.map((path) => this.workspace.relative(path)) }
    })
  }
}
