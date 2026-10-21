import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { pauseCollectionWrites, resumeCollectionWrites } from '../../src/main/collection-write-gate'
import { MANIFEST_NAME } from '../../src/main/folio'
import { readPlan } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'
import { staleMessage, type PlanProposalChange } from '../../src/shared/plan-proposal'

let root: string
let appDataDir: string
let ws: Workspace
let agents: WorkspaceAgent[]

const dir = 'notes-towards-ai-strategy'
const indexPath = `${dir}/_notes-towards-ai-strategy_INDEX.md`
const COVER = '# Notes towards a garden plan\n\nCover prose stays exactly as written.\n'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-plan-propose-'))
  appDataDir = await mkdtemp(join(tmpdir(), 'wf-plan-propose-data-'))
  ws = new Workspace(root)
  agents = []
})

afterEach(async () => {
  for (const agent of agents) await agent.dispose()
  await rm(root, { recursive: true, force: true })
  await rm(appDataDir, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

const read = (rel: string) => readFile(join(root, rel), 'utf8')

/** Fictional report fixture: an Index Note with no running order yet, three parts, one conflict copy. */
async function seedReport(index: string | null = COVER): Promise<void> {
  await write(`${dir}/00_strategy-framework.md`, '# Framework for Community Garden Planning\n\nThe original.\n')
  await write(`${dir}/00_strategy-framework-Studio Mac.md`, '# Framework for Community Garden Planning\n\nThe copy.\n')
  await write(`${dir}/01_shared-language.md`, '# Shared language for garden planning\n\nWords we share.\n')
  await write(`${dir}/02_key-strategic-moves.md`, '# Key strategic moves\n\nMoves.\n')
  if (index !== null) await write(indexPath, index)
}

const threeAdds: PlanProposalChange[] = [
  { op: 'insert', title: 'Framework for Community Garden Planning' },
  { op: 'insert', title: 'Shared language for garden planning' },
  { op: 'insert', title: 'Key strategic moves' },
]

async function propose(changes: PlanProposalChange[], proposeDir = dir): Promise<{ agent: WorkspaceAgent; id: string }> {
  const step: ScriptedStep = { cap: 'plan.propose', input: { dir: proposeDir, changes } }
  const agent = await WorkspaceAgent.create({
    workspace: ws,
    appDataDir,
    onTrace: () => {},
    onApprovalRequest: () => {},
    onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([{
      prompt: 'give me an order',
      rounds: [
        { kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] },
        { kind: 'message', text: 'Proposed.' },
      ],
    }]),
  })
  agents.push(agent)
  const { suggestions } = await agent.runScriptedTurn('give me an order', [step])
  const staged = suggestions.filter((suggestion) => suggestion.capabilityName === 'plan.propose')
  return { agent, id: staged[0]?.id ?? '' }
}

async function mtimes(paths: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {}
  for (const path of paths) out[path] = existsSync(join(root, path)) ? (await stat(join(root, path))).mtimeMs : null
  return out
}

const reportFiles = [
  indexPath,
  `${dir}/${MANIFEST_NAME}`,
  `${dir}/00_strategy-framework.md`,
  `${dir}/01_shared-language.md`,
  `${dir}/02_key-strategic-moves.md`,
]

test('running the verb writes nothing and stages one proposal the card can show', async () => {
  await seedReport()
  const before = await mtimes(reportFiles)
  const { agent, id } = await propose(threeAdds)
  expect(id).not.toBe('')
  expect(await mtimes(reportFiles)).toEqual(before)
  expect(await read(indexPath)).toBe(COVER)

  const view = await agent.planProposalView(id)
  expect(view?.status).toBe('pending')
  expect(view?.changes).toHaveLength(3)
  // The original is the part; the conflict copy stays outside the order.
  expect(view?.basis.strays.map((stray) => stray.path)).toContain(`${dir}/00_strategy-framework-Studio Mac.md`)
})

test('accept applies every change as one step, and one undo restores the Index Note byte for byte', async () => {
  await seedReport()
  const { agent, id } = await propose(threeAdds)
  const result = await agent.acceptPlanProposal(id)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.accepted.count).toBe(3)
  const plan = await readPlan(ws, dir)
  expect(plan?.parts.map((part) => part.path)).toEqual([
    `${dir}/00_strategy-framework.md`,
    `${dir}/01_shared-language.md`,
    `${dir}/02_key-strategic-moves.md`,
  ])
  expect(result.accepted.outside.map((file) => file.path)).toEqual([`${dir}/00_strategy-framework-Studio Mac.md`])
  expect(await read(indexPath)).toContain('## Running order')

  const undone = await agent.undoPlanProposal(id)
  expect(undone.ok).toBe(true)
  expect(await read(indexPath)).toBe(COVER)
  expect(existsSync(join(root, `${dir}/00_strategy-framework-Studio Mac.md`))).toBe(true)
  // The step is spent: a second undo refuses rather than restoring anything.
  expect((await agent.undoPlanProposal(id)).ok).toBe(false)
})

test('Edit first: a dropped change is neither counted nor written', async () => {
  await seedReport()
  const { agent, id } = await propose(threeAdds)
  // Frame 3: drop Shared language, drag Key strategic moves up to place 1 (it stays one change).
  const result = await agent.acceptPlanProposal(id, {
    enabled: ['c1', 'c3'],
    writerMoves: [{ id: 'w4', title: 'Key strategic moves', to: 1, enabled: true }],
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.accepted.count).toBe(2)
  const plan = await readPlan(ws, dir)
  expect(plan?.parts.map((part) => part.title)).toEqual(['Framework for Community Garden Planning', 'Key strategic moves'])
  expect(await read(indexPath)).not.toContain('Shared language')
  expect(result.accepted.outside.map((file) => file.title)).toContain('Shared language for garden planning')
})

test('stale: renaming a referenced part after proposing blocks Accept and names the file', async () => {
  await seedReport(`${COVER}\n## Running order\n\n- [[Framework for Community Garden Planning]]\n- [[Key strategic moves]]\n`)
  const { agent, id } = await propose([{ op: 'move', title: 'Key strategic moves', to: 0 }])
  const indexBefore = await read(indexPath)
  await rename(join(root, `${dir}/02_key-strategic-moves.md`), join(root, `${dir}/02_moves-for-2027.md`))

  const view = await agent.planProposalView(id)
  expect(view?.status).toBe('stale')
  expect(staleMessage(view?.stale ?? [])).toBe('The folder changed after this was proposed: 02_key-strategic-moves.md was renamed.')
  const result = await agent.acceptPlanProposal(id)
  expect(result.ok).toBe(false)
  expect(await read(indexPath)).toBe(indexBefore)
})

test('undo refuses when a part was renamed since, and names the rename', async () => {
  await seedReport(`${COVER}\n## Running order\n\n- [[Framework for Community Garden Planning]]\n- [[Key strategic moves]]\n`)
  const { agent, id } = await propose([{ op: 'move', title: 'Key strategic moves', to: 0 }])
  expect((await agent.acceptPlanProposal(id)).ok).toBe(true)
  const accepted = await read(indexPath)
  // A later rename (Journey 6 repairs the plan line) changes the part's title and the Index Note.
  await rename(join(root, `${dir}/02_key-strategic-moves.md`), join(root, `${dir}/02_moves-for-2027.md`))
  await writeFile(join(root, `${dir}/02_moves-for-2027.md`), '# Moves for 2027\n\nMoves.\n')
  await writeFile(join(root, indexPath), accepted.replace('[[Key strategic moves]]', '[[Moves for 2027]]'))

  const undone = await agent.undoPlanProposal(id)
  expect(undone.ok).toBe(false)
  if (undone.ok) return
  expect(undone.message).toBe("Can't put the order back: you have since renamed Key strategic moves to Moves for 2027, and undoing would bring back the old name in the Folio outline. Undo the rename first, or change the order in the Folio outline pane.")
  expect(await read(indexPath)).toContain('[[Moves for 2027]]')
})

test('remove takes a part out without deleting its file; materialise writes the file through the Folio outline operation', async () => {
  await seedReport(`${COVER}\n## Running order\n\n- [[Framework for Community Garden Planning]]\n- [[Key strategic moves]]\n- [[Future directions]]\n`)
  const { agent, id } = await propose([
    { op: 'remove', title: 'Key strategic moves' },
    { op: 'materialise', title: 'Future directions' },
    { op: 'setRole', title: 'Future directions', role: 'summary' },
  ])
  const result = await agent.acceptPlanProposal(id)
  expect(result.ok).toBe(true)
  expect(existsSync(join(root, `${dir}/02_key-strategic-moves.md`))).toBe(true)
  const plan = await readPlan(ws, dir)
  expect(plan?.parts.map((part) => part.title)).toEqual(['Framework for Community Garden Planning', 'Future directions'])
  expect(plan?.parts[1]).toMatchObject({ role: 'summary', path: `${dir}/02-future-directions.md` })
  expect(await read(`${dir}/02-future-directions.md`)).toContain('Future directions')

  // One undo takes the written-out file and the manifest it created back out too.
  const undone = await agent.undoPlanProposal(id)
  expect(undone.ok).toBe(true)
  expect(existsSync(join(root, `${dir}/02-future-directions.md`))).toBe(false)
  expect(existsSync(join(root, `${dir}/${MANIFEST_NAME}`))).toBe(false)
  expect(existsSync(join(root, `${dir}/02_key-strategic-moves.md`))).toBe(true)
})

test('a folder with no Index Note: accepting creates it first, and undo removes it again', async () => {
  await seedReport(null)
  const { agent, id } = await propose(threeAdds.slice(0, 2))
  const view = await agent.planProposalView(id)
  expect(view?.basis.hasIndexNote).toBe(false)
  expect(existsSync(join(root, indexPath))).toBe(false)
  expect((await agent.acceptPlanProposal(id)).ok).toBe(true)
  expect(await read(indexPath)).toContain('- [[Framework for Community Garden Planning]]')
  expect((await agent.undoPlanProposal(id)).ok).toBe(true)
  expect(existsSync(join(root, indexPath))).toBe(false)
})

test('an invalid proposal is refused at staging with a readable reason, and nothing is staged', async () => {
  await seedReport()
  const { id } = await propose([{ op: 'move', title: 'No such part', to: 0 }])
  expect(id).toBe('')
  expect(await read(indexPath)).toBe(COVER)
})

test('discard settles the proposal and writes nothing', async () => {
  await seedReport()
  const { agent, id } = await propose(threeAdds)
  await agent.discardPlanProposal(id)
  expect((await agent.planProposalView(id))?.status).toBe('discarded')
  expect((await agent.acceptPlanProposal(id)).ok).toBe(false)
  expect(await read(indexPath)).toBe(COVER)
})

/** Every file under the workspace root, with its bytes: what the writer would see in the folder (Bridle's own journal aside). */
async function folderListing(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of (await readdir(root, { recursive: true, withFileTypes: true })).filter((item) => item.isFile())) {
    const rel = join(entry.parentPath, entry.name).slice(root.length + 1)
    if (rel.startsWith('.bridle/')) continue
    out[rel] = (await readFile(join(root, rel))).toString('base64')
  }
  return out
}

test('accept then undo leaves the folder exactly as it was: no backup files left behind', async () => {
  await seedReport()
  const before = await folderListing()
  const { agent, id } = await propose(threeAdds)
  expect((await agent.acceptPlanProposal(id)).ok).toBe(true)
  // The accepted step keeps its pre-write backup while it stands.
  expect(existsSync(join(root, `${indexPath}.writeflex-backup`))).toBe(true)
  const undone = await agent.undoPlanProposal(id)
  expect(undone.ok).toBe(true)
  // The backup is housekeeping, never a file the writer is told was put back.
  if (undone.ok) expect(undone.paths.some((path) => path.endsWith('.writeflex-backup'))).toBe(false)
  expect(await folderListing()).toEqual(before)
})

test('accept then undo of a step that wrote a part file and a manifest leaves the folder exactly as it was', async () => {
  await seedReport(`${COVER}\n## Running order\n\n- [[Framework for Community Garden Planning]]\n- [[Key strategic moves]]\n- [[Future directions]]\n`)
  const before = await folderListing()
  const { agent, id } = await propose([
    { op: 'remove', title: 'Key strategic moves' },
    { op: 'materialise', title: 'Future directions' },
  ])
  expect((await agent.acceptPlanProposal(id)).ok).toBe(true)
  expect((await agent.undoPlanProposal(id)).ok).toBe(true)
  expect(await folderListing()).toEqual(before)
})

test('accept then undo in a folder with no Index Note leaves the folder exactly as it was', async () => {
  await seedReport(null)
  const before = await folderListing()
  const { agent, id } = await propose(threeAdds.slice(0, 2))
  expect((await agent.acceptPlanProposal(id)).ok).toBe(true)
  expect((await agent.undoPlanProposal(id)).ok).toBe(true)
  expect(await folderListing()).toEqual(before)
})

test('undo keeps a backup that existed before the accepted step, byte for byte', async () => {
  await seedReport()
  await write(`${indexPath}.writeflex-backup`, '# The pristine copy from an earlier edit\n')
  const before = await folderListing()
  const { agent, id } = await propose(threeAdds)
  expect((await agent.acceptPlanProposal(id)).ok).toBe(true)
  expect(await read(`${indexPath}.writeflex-backup`)).toBe('# The pristine copy from an earlier edit\n')
  expect((await agent.undoPlanProposal(id)).ok).toBe(true)
  expect(await folderListing()).toEqual(before)
})

// R7 (final Sol review round 3, P2): a failed running-order accept puts back only the files it wrote, each
// only while it still holds what the accept wrote. Bridle's restoreTo put the snapshot back over whatever
// was there, so the other program's version that made the accept refuse was lost.

/** Another program writes the Index Note while the accept's `nth` write of it (1-based) is staged. */
function outsideAtIndexWrite(nth: number, outside: string): () => number {
  const saveFile = ws.saveFile.bind(ws)
  let seen = 0
  ws.saveFile = (path, content, options) => {
    if (path === indexPath && ++seen === nth) writeFileSync(join(root, indexPath), outside)
    return saveFile(path, content, options)
  }
  return () => seen
}

test('R7: an accept refused at its first Index Note write restores nothing over the other program\'s version', async () => {
  await seedReport()
  const before = await folderListing()
  const { agent, id } = await propose(threeAdds)
  const outside = `${COVER}\nWritten by another program.\n`
  const seen = outsideAtIndexWrite(1, outside)
  const result = await agent.acceptPlanProposal(id)
  expect(seen()).toBe(1)
  expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Nothing was changed') })
  expect(await read(indexPath)).toBe(outside)
  // Everything else the step made (its pre-write backup) is gone again.
  expect(await folderListing()).toEqual({ ...before, [indexPath]: Buffer.from(outside).toString('base64') })
})

test('R7: an Index Note the accept wrote and another program changed before the rollback is left as it is and named', async () => {
  await seedReport()
  const { agent, id } = await propose(threeAdds)
  const outside = `${COVER}\nWritten by another program after the first part was added.\n`
  const seen = outsideAtIndexWrite(2, outside)
  const result = await agent.acceptPlanProposal(id)
  expect(seen()).toBe(2)
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.message).toContain(`${indexPath} changed on disk after WriteFlex wrote it, so it was left as it is.`)
  expect(await read(indexPath)).toBe(outside)
})

test('while another owner holds the Collection, accept and undo are refused and write nothing: no file, no backup, no restore point', async () => {
  await seedReport()
  const { agent, id } = await propose(threeAdds)
  const history = async (): Promise<string> => readFile(join(root, '.bridle', 'journal.jsonl'), 'utf8').catch(() => '')
  const before = { folder: await folderListing(), history: await history() }
  pauseCollectionWrites(root, 'Saving is paused for this test.')
  try {
    expect(await agent.acceptPlanProposal(id)).toEqual({ ok: false, message: 'Nothing was changed: Saving is paused for this test.' })
    expect({ folder: await folderListing(), history: await history() }).toEqual(before)
    resumeCollectionWrites(root)
    expect((await agent.acceptPlanProposal(id)).ok).toBe(true)

    const accepted = { folder: await folderListing(), history: await history() }
    pauseCollectionWrites(root, 'Saving is paused for this test.')
    expect(await agent.undoPlanProposal(id)).toEqual({ ok: false, message: "Can't put the order back: Saving is paused for this test." })
    // Nothing was put back and the step's backup was not removed; the step is still held for undo.
    expect({ folder: await folderListing(), history: await history() }).toEqual(accepted)
    expect(existsSync(join(root, `${indexPath}.writeflex-backup`))).toBe(true)
    resumeCollectionWrites(root)
    expect((await agent.undoPlanProposal(id)).ok).toBe(true)
    expect(await folderListing()).toEqual(before.folder)
  } finally {
    resumeCollectionWrites(root)
  }
})
