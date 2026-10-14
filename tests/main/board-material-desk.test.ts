import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory, type Capability, type CapabilityContext } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { BoardMaterialDesk } from '../../src/main/board-material-desk'
import { buildWriteFlexManifest, writeflexApprovalPolicy } from '../../src/main/capabilities'
import { ChangeStore } from '../../src/main/changes'
import { ScrapStore } from '../../src/main/scraps'
import { Workspace } from '../../src/main/workspace'

// Scraps ticket 02: offcut to idea and add-to-end-of-piece each write two files as ONE undo group
// through the agent's snapshot journal (PlanProposalDesk's restore-point pattern), and one undo puts
// both back byte for byte. The agent may only propose an offcut becoming an idea (scraps.promote).

const DIR = 'schemas'
const TRACKER = 'schemas/_schemas_INDEX.md'
const PIECE = 'schemas/how-humans-hallucinate.md'
const SCRAPS = 'schemas/scraps/how-humans-hallucinate-SCRAPS.md'
const HALL = 's_mtb9yb2s0xq8'
const FAMILIES = 's_mtb9yb3a1abc'
const trackerText = '# schemas\n\n## Ideas\n\n- [[frames-and-scripts]]\n'
const pieceText = '---\nstatus: editing\n---\n# How humans hallucinate\n\nWe fill gaps.\n'
const scrapsText = `## ${HALL}\nHall's high and low context cultures.\n\n## ${FAMILIES}\nFamilies share more context.\n`

let root: string
let appData: string
let ws: Workspace
let scraps: ScrapStore
let agent: WorkspaceAgent | null

const ctx: CapabilityContext = {
  trigger: { id: 't', source: 'user', trust: 'interactive' },
  sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {},
}

async function bootAgent(opts: { changes?: ChangeStore; script?: Parameters<typeof scriptedSessionFactory>[0] } = {}): Promise<WorkspaceAgent> {
  agent = await WorkspaceAgent.create({
    workspace: ws, appDataDir: appData, services: { scraps },
    ...(opts.changes ? { changes: opts.changes, onChangesChanged: () => {} } : {}),
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    ...(opts.script ? { sessionFactory: scriptedSessionFactory(opts.script) } : {}),
  })
  return agent
}

async function desk(): Promise<BoardMaterialDesk> {
  return new BoardMaterialDesk(ws, (await bootAgent()).hostSnapshots(), scraps)
}

const read = (path: string) => readFile(join(root, path), 'utf8')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-board-material-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-board-material-data-'))
  ws = new Workspace(root)
  scraps = new ScrapStore(ws)
  agent = null
  await mkdir(join(root, 'schemas/scraps'), { recursive: true })
  await writeFile(join(root, TRACKER), trackerText, 'utf8')
  await writeFile(join(root, PIECE), pieceText, 'utf8')
  await writeFile(join(root, SCRAPS), scrapsText, 'utf8')
})

afterEach(async () => {
  await agent?.dispose()
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

test('offcut to idea writes one idea line and removes that scrap; one undo restores both files byte for byte', async () => {
  const board = await desk()
  const result = await board.promoteOffcut({ dir: DIR, scrapsPath: SCRAPS, scrapId: HALL, name: 'High and low context, everywhere' })
  expect(result).toMatchObject({ ok: true, step: { kind: 'idea', activity: 'Offcut became an idea' }, paths: [TRACKER, SCRAPS] })
  expect(await read(TRACKER)).toBe(`${trackerText}- [[high-and-low-context-everywhere]]\n  > Hall's high and low context cultures.\n`)
  expect(await read(SCRAPS)).toBe(`## ${FAMILIES}\nFamilies share more context.\n`)
  expect(board.latest()?.kind).toBe('idea')

  const undone = await board.undo(result.ok ? result.step.id : '')
  expect(undone.ok).toBe(true)
  expect(await read(TRACKER)).toBe(trackerText)
  expect(await read(SCRAPS)).toBe(scrapsText)
  expect(board.latest()).toBeNull()
  // The step is spent: a second undo refuses and writes nothing.
  expect(await board.undo(result.ok ? result.step.id : '')).toMatchObject({ ok: false, message: 'That change is no longer held for undo.' })
})

test('undo brings back a scraps file the last offcut emptied, and deletes a tracker the step created', async () => {
  await rm(join(root, TRACKER))
  await writeFile(join(root, SCRAPS), `## ${HALL}\nOnly this one.\n`, 'utf8')
  const board = await desk()
  const result = await board.promoteOffcut({ dir: DIR, scrapsPath: SCRAPS, scrapId: HALL, name: 'Only this one' })
  expect(result.ok).toBe(true)
  expect(await read(TRACKER)).toBe('# schemas\n\n## Ideas\n\n- [[only-this-one]]\n  > Only this one.\n')
  expect(existsSync(join(root, SCRAPS))).toBe(false)

  expect((await board.undo(result.ok ? result.step.id : '')).ok).toBe(true)
  expect(existsSync(join(root, TRACKER))).toBe(false)
  expect(await read(SCRAPS)).toBe(`## ${HALL}\nOnly this one.\n`)
})

test('a refused promote writes nothing and holds nothing to undo', async () => {
  const board = await desk()
  await writeFile(join(root, 'schemas/frames.md'), '# Frames\n', 'utf8')
  for (const name of ['', 'Frames and scripts', 'Frames']) {
    const result = await board.promoteOffcut({ dir: DIR, scrapsPath: SCRAPS, scrapId: HALL, name })
    expect(result.ok).toBe(false)
  }
  expect((await board.promoteOffcut({ dir: 'elsewhere', scrapsPath: SCRAPS, scrapId: HALL, name: 'X' }))).toMatchObject({ ok: false, message: 'That offcut is not in this collection.' })
  expect(await read(TRACKER)).toBe(trackerText)
  expect(await read(SCRAPS)).toBe(scrapsText)
  expect(board.latest()).toBeNull()
})

test('undo refuses, putting nothing back, when either file changed since', async () => {
  const board = await desk()
  const result = await board.promoteOffcut({ dir: DIR, scrapsPath: SCRAPS, scrapId: HALL, name: 'Context' })
  if (!result.ok) throw new Error(result.message)
  const edited = `${await read(TRACKER)}\nA line the writer added.\n`
  await writeFile(join(root, TRACKER), edited, 'utf8')
  expect(await board.undo(result.step.id)).toMatchObject({ ok: false, message: expect.stringContaining(`${TRACKER} changed since`) })
  expect(await read(TRACKER)).toBe(edited)
  expect(await read(SCRAPS)).toBe(`## ${FAMILIES}\nFamilies share more context.\n`)
})

test('add to end of piece appends the scrap and removes it; one undo restores both; the agent Undo turn leaves it alone', async () => {
  const board = await desk()
  const result = await board.appendScrap({ piece: PIECE, scrapId: FAMILIES })
  expect(result).toMatchObject({ ok: true, step: { kind: 'append', activity: 'Scrap added to the end of How humans hallucinate' }, paths: [PIECE, SCRAPS] })
  expect(await read(PIECE)).toBe(`${pieceText}\nFamilies share more context.\n`)
  expect(await read(SCRAPS)).toBe(`## ${HALL}\nHall's high and low context cultures.\n`)

  // The Board step is the writer's own (host origin): the agent's Undo turn does not take it back.
  await expect(agent!.restoreLastTurn()).rejects.toThrow('There is no agent turn to undo.')
  expect(await read(PIECE)).toBe(`${pieceText}\nFamilies share more context.\n`)

  expect((await board.undo(result.ok ? result.step.id : '')).ok).toBe(true)
  expect(await read(PIECE)).toBe(pieceText)
  expect(await read(SCRAPS)).toBe(scrapsText)
})

test('only the latest step holds its undo', async () => {
  const board = await desk()
  const first = await board.promoteOffcut({ dir: DIR, scrapsPath: SCRAPS, scrapId: HALL, name: 'Context' })
  const second = await board.appendScrap({ piece: PIECE, scrapId: FAMILIES })
  if (!first.ok || !second.ok) throw new Error('steps failed')
  expect(await board.undo(first.step.id)).toMatchObject({ ok: false })
  expect((await board.undo(second.step.id)).ok).toBe(true)
  expect(await read(PIECE)).toBe(pieceText)
  expect(await read(SCRAPS)).toBe(`## ${FAMILIES}\nFamilies share more context.\n`)
})

function cap(name: string): Capability {
  const found = buildWriteFlexManifest(ws, undefined, { scraps }).capabilities.find((c) => c.name === name)
  if (!found) throw new Error(`missing capability ${name}`)
  return found
}

test('scraps.promote stages at every trust level and validates the scrap and the name', async () => {
  const policy = writeflexApprovalPolicy(undefined, ws)
  for (const trust of ['interactive', 'trusted_app', 'background'] as const) {
    expect(await policy({ capability: { name: 'scraps.promote', risk: 'write' }, input: {}, trigger: { id: 't', source: 'user', trust } })).toBe('stage')
  }
  const promote = cap('scraps.promote')
  const input = { dir: DIR, origin: PIECE, id: HALL, name: 'Context everywhere' }
  expect(await promote.validateStage!(input)).toEqual({ decision: 'pass' })
  expect(await promote.validateStage!({ ...input, id: 's_gone' })).toMatchObject({ decision: 'deny' })
  expect(await promote.validateStage!({ ...input, name: 'Frames and scripts' })).toMatchObject({ decision: 'deny', reason: { message: expect.stringMatching(/already in the tracker/) } })
  expect(await promote.touchedPaths!(input)).toEqual([ws.absolute(TRACKER), ws.absolute(SCRAPS)])
  expect(await promote.preview!(input)).toBe(`Make the idea “Context everywhere” from an offcut of ${PIECE}`)
})

async function waitForChanges(changes: ChangeStore, count: number): Promise<Awaited<ReturnType<ChangeStore['list']>>> {
  for (let i = 0; i < 50; i += 1) {
    const all = await changes.list()
    if (all.length === count) return all
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return changes.list()
}

test('an agent scraps.promote is a proposal: nothing is written until the writer accepts it', async () => {
  const changes = new ChangeStore(ws)
  const step: ScriptedStep = { cap: 'scraps.promote', input: { dir: DIR, origin: PIECE, id: HALL, name: 'Context everywhere' } }
  const prompt = 'Turn the Hall scrap into an idea'
  const live = await bootAgent({
    changes,
    script: [{ prompt, rounds: [
      { kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] },
      { kind: 'message', text: 'Proposed.' },
    ] }],
  })
  await live.runScriptedTurn(prompt, [step])
  expect(await read(TRACKER)).toBe(trackerText)
  expect(await read(SCRAPS)).toBe(scrapsText)
  const [change] = await waitForChanges(changes, 1)
  expect(change).toMatchObject({ path: TRACKER, provenance: 'agent', status: 'pending', oldText: trackerText })
  expect(change.newText).toBe(`${trackerText}- [[context-everywhere]]\n  > Hall's high and low context cultures.\n`)

  expect((await live.resolveChange(change.id, 'accept')).applied).toBe(true)
  expect(await read(TRACKER)).toBe(change.newText)
  expect(await read(SCRAPS)).toBe(`## ${FAMILIES}\nFamilies share more context.\n`)
})

/** Every file under the workspace root with its bytes, Bridle's own journal aside. */
async function folderListing(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of (await readdir(root, { recursive: true, withFileTypes: true })).filter((item) => item.isFile())) {
    const rel = join(entry.parentPath, entry.name).slice(root.length + 1)
    if (!rel.startsWith('.bridle/')) out[rel] = (await readFile(join(root, rel))).toString('base64')
  }
  return out
}

test('a Board step then its undo leaves the folder exactly as it was: no stray files', async () => {
  const board = await desk()
  const before = await folderListing()
  const result = await board.promoteOffcut({ dir: DIR, scrapsPath: SCRAPS, scrapId: HALL, name: 'Context' })
  expect((await board.undo(result.ok ? result.step.id : '')).ok).toBe(true)
  expect(await folderListing()).toEqual(before)
})

test('with no agent turn, Undo turn refuses and leaves a host Board step exactly as it stands', async () => {
  const board = await desk()
  const result = await board.appendScrap({ piece: PIECE, scrapId: FAMILIES })
  expect(result.ok).toBe(true)
  const after = await folderListing()

  await expect(agent!.restoreLastTurn()).rejects.toThrow('There is no agent turn to undo.')
  expect(await folderListing()).toEqual(after)
  // The Board step is still the writer's to undo.
  expect((await board.undo(result.ok ? result.step.id : '')).ok).toBe(true)
  expect(await read(PIECE)).toBe(pieceText)
})

test('Undo turn takes back the agent turn, never a Board step made after it', async () => {
  const renameStep: ScriptedStep = { cap: 'housekeeping.rename_file', input: { path: 'schemas/frames.md', newPath: 'schemas/frames-and-scripts.md' } }
  await writeFile(join(root, 'schemas/frames.md'), '# Frames\n', 'utf8')
  const prompt = 'Rename frames'
  const live = await bootAgent({
    script: [{ prompt, rounds: [
      { kind: 'tool-calls', calls: [{ name: renameStep.cap, arguments: renameStep.input as Record<string, unknown> }] },
      { kind: 'message', text: 'Renamed.' },
    ] }],
  })
  await live.runScriptedTurn(prompt, [renameStep])
  expect(existsSync(join(root, 'schemas/frames-and-scripts.md'))).toBe(true)
  const board = new BoardMaterialDesk(ws, live.hostSnapshots(), scraps)
  expect((await board.appendScrap({ piece: PIECE, scrapId: FAMILIES })).ok).toBe(true)
  const appended = await read(PIECE)

  await live.restoreLastTurn()
  expect(existsSync(join(root, 'schemas/frames.md'))).toBe(true)
  expect(existsSync(join(root, 'schemas/frames-and-scripts.md'))).toBe(false)
  expect(await read(PIECE)).toBe(appended)
})
