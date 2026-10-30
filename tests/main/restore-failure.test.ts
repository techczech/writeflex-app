/**
 * Review parcel P3, driver addition 3: a restore the snapshot store refuses, or stops part-way, is
 * reported to the caller in the caller's own result shape, with what was and was not put back. It is
 * never swallowed. Seams: the Board's material desk, the Plan proposal desk and the agent's "undo
 * turn", each over a snapshot store whose `restoreTo` is stubbed to throw Bridle's two errors.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RestoreIncompleteError, RestoreRefusedError, scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { BoardMaterialDesk, type BoardDeskBridle } from '../../src/main/board-material-desk'
import type { CollectionSnapshots } from '../../src/main/gated-snapshots'
import { refusalMessage } from '../../src/shared/assistant-turns'
import { RestoreNotCompletedError, restoreFailure } from '../../src/main/restore-failure'
import { ScrapStore } from '../../src/main/scraps'
import { Workspace, type FileReadResult, type SaveFileOptions } from '../../src/main/workspace'
import type { PlanProposalChange } from '../../src/shared/plan-proposal'

const DIR = 'schemas'
const PIECE = 'schemas/tools-of-reason.md'
const SCHANK = 'schemas/research/schank-abelson-scripts.md'
const INDEX = 'schemas/_schemas_INDEX.md'
const pieceText = '---\ntitle: Tools of reason\nstatus: in progress\nsources:\n  - research/bartlett-remembering.md\n---\n# Tools of reason\n\nWe reason with tools.\n'
const COVER = '# Schemas\n\nCover prose.\n'

let root: string
let appData: string
let ws: Workspace
let agent: WorkspaceAgent | null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-restore-failure-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-restore-failure-data-'))
  ws = new Workspace(root)
  agent = null
  await mkdir(join(root, 'schemas/research'), { recursive: true })
  await writeFile(join(root, PIECE), pieceText)
  await writeFile(join(root, INDEX), COVER)
  await writeFile(join(root, 'schemas/research/bartlett-remembering.md'), '# Bartlett, Remembering\n')
  await writeFile(join(root, SCHANK), '# Schank & Abelson, Scripts\n')
})
afterEach(async () => {
  await agent?.dispose()
  for (const dir of [root, appData]) await rm(dir, { recursive: true, force: true })
})

const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8')
const refused = (): RestoreRefusedError => new RestoreRefusedError('rp_1', [{ path: join(root, PIECE), reason: 'a link stands at this path' }])
const incomplete = (): RestoreIncompleteError => new RestoreIncompleteError('rp_1', [join(root, INDEX)], [join(root, PIECE), join(root, SCHANK)], 'EACCES: permission denied')
const BOTH: Array<[string, () => Error, RegExp[]]> = [
  ['refused', refused, [/was not put back, and no file was changed by the attempt/, /schemas\/tools-of-reason\.md \(a link stands at this path\)/]],
  ['incomplete', incomplete, [/Only part of the earlier state was put back \(EACCES: permission denied\)/, /Put back: schemas\/_schemas_INDEX\.md\./, /Not put back: schemas\/tools-of-reason\.md, schemas\/research\/schank-abelson-scripts\.md\./]],
]

async function bootAgent(script?: Parameters<typeof scriptedSessionFactory>[0]): Promise<WorkspaceAgent> {
  agent = await WorkspaceAgent.create({ mode: 'work',
    workspace: ws, appDataDir: appData, services: { scraps: new ScrapStore(ws) },
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    ...(script ? { sessionFactory: scriptedSessionFactory(script) } : {}),
  })
  return agent
}
/** The agent's own snapshot store (the one object its desks and its undo share), to stub `restoreTo` on. */
const storeOf = (live: WorkspaceAgent): CollectionSnapshots => (live as unknown as { snapshots: CollectionSnapshots }).snapshots

test('the two errors become a sentence and two lists, with paths shown relative to the Collection', () => {
  expect(restoreFailure(refused(), root)).toMatchObject({ kind: 'refused', restored: [], notRestored: [join(root, PIECE)] })
  const half = restoreFailure(incomplete(), root)
  expect(half).toMatchObject({ kind: 'incomplete', restored: [join(root, INDEX)], notRestored: [join(root, PIECE), join(root, SCHANK)] })
  expect(half.message).toBe('Only part of the earlier state was put back (EACCES: permission denied). Put back: schemas/_schemas_INDEX.md. Not put back: schemas/tools-of-reason.md, schemas/research/schank-abelson-scripts.md.')
  expect(restoreFailure(refused(), root).message).toBe('The earlier state was not put back, and no file was changed by the attempt, because it includes a file WriteFlex will not write: schemas/tools-of-reason.md (a link stands at this path).')
  // A path outside the Collection, or not a full path, is shown as the store gave it.
  expect(restoreFailure(new RestoreIncompleteError('rp', ['/elsewhere/a.md', 'b.md'], [], 'x'), root).message).toContain('Put back: /elsewhere/a.md, b.md.')
  expect(restoreFailure(new Error('the disk went away'), root)).toMatchObject({ kind: 'failed', message: 'The earlier state could not be put back (the disk went away).' })
})

for (const [name, error, says] of BOTH) {
  test(`Board desk: a failed step whose rollback is ${name} says so, with what was and was not put back`, async () => {
    // The step's write fails after its restore point is made; the rollback then meets the store's error.
    class FailingWorkspace extends Workspace {
      override async saveFile(path: string, content: string, options: SaveFileOptions = {}): Promise<FileReadResult> {
        if (path === PIECE) throw new Error('The disk refused the write.')
        return super.saveFile(path, content, options)
      }
    }
    const failing = new FailingWorkspace(root)
    const host = (await bootAgent()).hostSnapshots()
    const bridle: BoardDeskBridle = { ...host, snapshots: { ...host.snapshots, restoreTo: async () => { throw error() } } }
    const board = new BoardMaterialDesk(failing, bridle, new ScrapStore(failing))

    const result = await board.attachSource({ dir: DIR, piece: PIECE, source: SCHANK })

    expect(result.ok).toBe(false)
    if (result.ok) return
    // The save fix (R7): a failed step's rollback is not the store's restore. It puts back only what the
    // step wrote, and the step's first write is the one that failed, so nothing was changed.
    expect(result.message).toBe('Nothing was changed: The disk refused the write.')
    expect(await read(PIECE)).toBe(pieceText)
  })

  test(`Board desk: an undo that is ${name} is not reported as done, and says what was and was not put back`, async () => {
    const host = (await bootAgent()).hostSnapshots()
    let fail = false
    const bridle: BoardDeskBridle = { ...host, snapshots: { ...host.snapshots, restoreTo: async (id, opts) => { if (fail) throw error(); return host.snapshots.restoreTo(id, opts) } } }
    const board = new BoardMaterialDesk(ws, bridle, new ScrapStore(ws))
    const step = await board.attachSource({ dir: DIR, piece: PIECE, source: SCHANK })
    expect(step.ok).toBe(true)
    if (!step.ok) return
    const attached = await read(PIECE)
    fail = true

    const result = await board.undo(step.step.id)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message.startsWith("Can't undo. ")).toBe(true)
    for (const pattern of says) expect(result.message).toMatch(pattern)
    expect(await read(PIECE)).toBe(attached)
    // The step is still held: once the store can restore, the same undo works.
    fail = false
    expect(await board.undo(step.step.id)).toMatchObject({ ok: true })
    expect(await read(PIECE)).toBe(pieceText)
  })

  test(`Folio outline desk: an undo that is ${name}, and a rollback that is, are reported in the result`, async () => {
    const changes: PlanProposalChange[] = [{ op: 'insert', title: 'Tools of reason' }]
    const step: ScriptedStep = { cap: 'plan.propose', input: { dir: DIR, changes } }
    const turn = (prompt: string) => ({ prompt, rounds: [{ kind: 'tool-calls' as const, calls: [{ name: 'tools.enable', arguments: { names: [step.cap] } }] }, { kind: 'tool-calls' as const, calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] }, { kind: 'message' as const, text: 'Proposed.' }] })
    const live = await bootAgent([turn('order one'), turn('order two')])
    const propose = async (prompt: string): Promise<string> => (await live.runScriptedTurn(prompt, [step])).suggestions.filter((suggestion) => suggestion.capabilityName === 'plan.propose').at(-1)!.id
    const store = storeOf(live)
    const restoreTo = store.restoreTo

    // Undo: the accepted order stands, and the result says the restore did not complete.
    const first = await propose('order one')
    expect((await live.acceptPlanProposal(first)).ok).toBe(true)
    const ordered = await read(INDEX)
    store.restoreTo = async () => { throw error() }
    const undone = await live.undoPlanProposal(first)
    expect(undone.ok).toBe(false)
    if (undone.ok) return
    expect(undone.message.startsWith("Can't put the order back. ")).toBe(true)
    for (const pattern of says) expect(undone.message).toMatch(pattern)
    expect(await read(INDEX)).toBe(ordered)
    store.restoreTo = restoreTo
    expect((await live.undoPlanProposal(first)).ok).toBe(true)
    expect(await read(INDEX)).toBe(COVER)

    // Rollback: the proposal turns out to be settled elsewhere after the step wrote. The save fix (R7):
    // the rollback is not the store's restore (which fails here); it puts back what the step wrote, each
    // file only while it holds what the step left, so the Plan is as it was and that is what is said.
    const second = await propose('order two')
    const proposals = (live as unknown as { bridle: { proposals: { settleAsHost: (...args: unknown[]) => Promise<unknown> } } }).bridle.proposals
    proposals.settleAsHost = async () => ({ refused: 'already-settled' })
    store.restoreTo = async () => { throw error() }
    const accepted = await live.acceptPlanProposal(second)
    expect(accepted.ok).toBe(false)
    if (accepted.ok) return
    expect(accepted.message).toBe('Nothing was changed: the proposal was settled elsewhere (already-settled).')
    expect(await read(INDEX)).toBe(COVER)
  })

  test(`undo turn: a restore that is ${name} reports its refusal through the turn seam`, async () => {
    const edit: ScriptedStep = { cap: 'housekeeping.create_file', input: { path: 'schemas/new-note.md', content: '# New\n' } }
    const live = await bootAgent([{ prompt: 'make a note', rounds: [{ kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: [edit.cap] } }] }, { kind: 'tool-calls', calls: [{ name: edit.cap, arguments: edit.input as Record<string, unknown> }] }, { kind: 'message', text: 'Done.' }] }])
    await live.runScriptedTurn('make a note', [edit])
    const turns = (live as unknown as { bridle: import('@bridle/core').Bridle }).bridle.turns
    turns.undo = async () => { throw error() }
    const [turn] = (await live.turnState()).turns
    const result = await live.undoTurn(turn.turnId)
    expect(result).toMatchObject({ undone: false, reason: name === 'incomplete' ? 'partially-undone' : 'unrestorable-file', paths: name === 'incomplete' ? [PIECE, SCHANK] : [PIECE] })
    if (!result.undone) for (const pattern of says) expect(refusalMessage(result)).toMatch(pattern)
  })
}
