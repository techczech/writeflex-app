import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory, type Capability } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { BoardMaterialDesk } from '../../src/main/board-material-desk'
import { buildWriteFlexManifest, writeflexApprovalPolicy } from '../../src/main/capabilities'
import { ChangeStore } from '../../src/main/changes'
import { ScrapStore } from '../../src/main/scraps'
import { Workspace } from '../../src/main/workspace'

// Scraps ticket 03, locked design frame 4: dragging a source from the Sources rail onto a card adds ONE
// line to the piece's frontmatter `sources:` list, as one undoable step through the agent's snapshot
// journal (host origin), and one undo restores the file byte for byte. The agent may only propose it.

const DIR = 'schemas'
const PIECE = 'schemas/tools-of-reason.md'
const OTHER = 'schemas/how-humans-hallucinate.md'
const BARTLETT = 'schemas/research/bartlett-remembering.md'
const SCHANK = 'schemas/research/schank-abelson-scripts.md'
const pieceText = '---\ntitle: Tools of reason\nstatus: in progress\nsources:\n  - research/bartlett-remembering.md\n---\n# Tools of reason\n\nWe reason with tools.\n'
const otherText = '---\nstatus: editing\n---\n# How humans hallucinate\n\nSee [[Schank & Abelson, Scripts]].\n'

let root: string
let appData: string
let ws: Workspace
let scraps: ScrapStore
let agent: WorkspaceAgent | null

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
  root = await mkdtemp(join(tmpdir(), 'wf-source-attach-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-source-attach-data-'))
  ws = new Workspace(root)
  scraps = new ScrapStore(ws)
  agent = null
  await mkdir(join(root, 'schemas/research'), { recursive: true })
  await writeFile(join(root, PIECE), pieceText, 'utf8')
  await writeFile(join(root, OTHER), otherText, 'utf8')
  await writeFile(join(root, BARTLETT), '# Bartlett, Remembering\n', 'utf8')
  await writeFile(join(root, SCHANK), '# Schank & Abelson, Scripts\n', 'utf8')
})

afterEach(async () => {
  await agent?.dispose()
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

test('attach adds exactly one sources: line; one undo restores the file byte for byte; no file moves', async () => {
  const board = await desk()
  const filesBefore = (await readdir(join(root, 'schemas'), { recursive: true })).sort()
  const result = await board.attachSource({ dir: DIR, piece: PIECE, source: SCHANK })
  expect(result).toMatchObject({ ok: true, step: { kind: 'source', activity: 'Source attached' }, paths: [PIECE] })
  expect(await read(PIECE)).toBe(pieceText.replace('  - research/bartlett-remembering.md\n', '  - research/bartlett-remembering.md\n  - research/schank-abelson-scripts.md\n'))
  expect((await readdir(join(root, 'schemas'), { recursive: true })).sort()).toEqual(filesBefore)
  expect(await read(SCHANK)).toBe('# Schank & Abelson, Scripts\n')

  // The Board step is the writer's own (host origin): the agent's Undo turn does not take it back.
  await expect(agent!.restoreLastTurn()).rejects.toThrow('There is no agent turn to undo.')
  expect(await read(PIECE)).not.toBe(pieceText)

  const undone = await board.undo(result.ok ? result.step.id : '')
  expect(undone).toEqual({ ok: true, paths: [PIECE] })
  expect(await read(PIECE)).toBe(pieceText)
  expect(board.latest()).toBeNull()
})

test('a piece without a sources: key gains the key and the line; undo takes both back', async () => {
  const board = await desk()
  const result = await board.attachSource({ dir: DIR, piece: OTHER, source: BARTLETT })
  expect(result.ok).toBe(true)
  expect(await read(OTHER)).toBe('---\nstatus: editing\nsources:\n  - research/bartlett-remembering.md\n---\n# How humans hallucinate\n\nSee [[Schank & Abelson, Scripts]].\n')
  expect((await board.undo(result.ok ? result.step.id : '')).ok).toBe(true)
  expect(await read(OTHER)).toBe(otherText)
})

test('attaching an already-listed source does nothing and says so, however the list names it', async () => {
  const board = await desk()
  expect(await board.attachSource({ dir: DIR, piece: PIECE, source: BARTLETT })).toEqual({
    ok: false, message: '“Bartlett, Remembering” is already in the sources of Tools of reason. Nothing was changed.',
  })
  // Listed by title as a wikilink, and by its path from the workspace root: still the same note.
  const byTitle = pieceText.replace('  - research/bartlett-remembering.md', '  - "[[Bartlett, Remembering]]"')
  await writeFile(join(root, PIECE), byTitle, 'utf8')
  expect(await board.attachSource({ dir: DIR, piece: PIECE, source: BARTLETT })).toMatchObject({ ok: false, message: expect.stringContaining('already in the sources') })
  expect(await read(PIECE)).toBe(byTitle)
  expect(board.latest()).toBeNull()
})

test('a note the text only links to is not listed: attaching it adds it to the list', async () => {
  const board = await desk()
  const result = await board.attachSource({ dir: DIR, piece: OTHER, source: SCHANK })
  expect(result.ok).toBe(true)
  expect(await read(OTHER)).toContain('sources:\n  - research/schank-abelson-scripts.md\n---\n')
})

test('refusals write nothing: a non-research source, a source outside the collection, a missing piece', async () => {
  const board = await desk()
  expect(await board.attachSource({ dir: DIR, piece: PIECE, source: OTHER })).toMatchObject({ ok: false, message: expect.stringContaining('research/ folder') })
  expect(await board.attachSource({ dir: 'elsewhere', piece: PIECE, source: SCHANK })).toMatchObject({ ok: false, message: 'That piece is not in this collection.' })
  expect(await board.attachSource({ dir: DIR, piece: 'schemas/gone.md', source: SCHANK })).toMatchObject({ ok: false, message: 'schemas/gone.md no longer exists.' })
  expect(await board.attachSource({ dir: DIR, piece: BARTLETT, source: SCHANK })).toMatchObject({ ok: false, message: 'A source can only be attached to a piece.' })
  expect(await read(PIECE)).toBe(pieceText)
  expect(board.latest()).toBeNull()
})

test('undo refuses, putting nothing back, when the piece changed since', async () => {
  const board = await desk()
  const result = await board.attachSource({ dir: DIR, piece: PIECE, source: SCHANK })
  if (!result.ok) throw new Error(result.message)
  const edited = `${await read(PIECE)}\nA line the writer added.\n`
  await writeFile(join(root, PIECE), edited, 'utf8')
  expect(await board.undo(result.step.id)).toMatchObject({ ok: false, message: expect.stringContaining(`${PIECE} changed since`) })
  expect(await read(PIECE)).toBe(edited)
})

function cap(name: string): Capability {
  const found = buildWriteFlexManifest(ws, undefined, { scraps }).capabilities.find((c) => c.name === name)
  if (!found) throw new Error(`missing capability ${name}`)
  return found
}

test('sources.attach stages at every trust level and validates the piece and the source', async () => {
  const policy = writeflexApprovalPolicy(undefined, ws)
  for (const trust of ['interactive', 'trusted_app', 'background'] as const) {
    expect(await policy({ capability: { name: 'sources.attach', risk: 'write' }, input: {}, trigger: { id: 't', source: 'user', trust } })).toBe('stage')
  }
  const attach = cap('sources.attach')
  const input = { dir: DIR, piece: PIECE, source: SCHANK }
  expect(await attach.validateStage!(input)).toEqual({ decision: 'pass' })
  expect(await attach.validateStage!({ ...input, source: BARTLETT })).toMatchObject({ decision: 'deny', reason: { message: expect.stringMatching(/already in the sources/) } })
  expect(await attach.touchedPaths!(input)).toEqual([ws.absolute(PIECE)])
  expect(await attach.preview!(input)).toBe(`Attach ${SCHANK} to the sources of ${PIECE}`)
})

async function waitForChanges(changes: ChangeStore, count: number): Promise<Awaited<ReturnType<ChangeStore['list']>>> {
  for (let i = 0; i < 50; i += 1) {
    const all = await changes.list()
    if (all.length === count) return all
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return changes.list()
}

test('an agent sources.attach is a proposal: nothing is written until the writer accepts it', async () => {
  const changes = new ChangeStore(ws)
  const step: ScriptedStep = { cap: 'sources.attach', input: { dir: DIR, piece: PIECE, source: SCHANK } }
  const prompt = 'Attach the Schank note to Tools of reason'
  const live = await bootAgent({
    changes,
    script: [{ prompt, rounds: [
      { kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] },
      { kind: 'message', text: 'Proposed.' },
    ] }],
  })
  await live.runScriptedTurn(prompt, [step])
  expect(await read(PIECE)).toBe(pieceText)
  const [change] = await waitForChanges(changes, 1)
  expect(change).toMatchObject({ path: PIECE, provenance: 'agent', status: 'pending', oldText: pieceText })
  expect(change.newText).toContain('  - research/bartlett-remembering.md\n  - research/schank-abelson-scripts.md\n')

  expect((await live.resolveChange(change.id, 'accept')).applied).toBe(true)
  expect(await read(PIECE)).toBe(change.newText)
})

// Final review round 2, finding 1 (R5): an accepted sources.attach writes the piece only over the text it
// read. Another program writes the piece after the accept has read it, at the moment its write is staged:
// nothing is written over that version, and the accept is refused by type (changedOnDisk) for the notice.
test('an accepted sources.attach never writes the piece over a version it did not read (R5, round 2 finding 1)', async () => {
  const changes = new ChangeStore(ws)
  const step: ScriptedStep = { cap: 'sources.attach', input: { dir: DIR, piece: PIECE, source: SCHANK } }
  const prompt = 'Attach the Schank note to Tools of reason'
  const live = await bootAgent({
    changes,
    script: [{ prompt, rounds: [
      { kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] },
      { kind: 'message', text: 'Proposed.' },
    ] }],
  })
  await live.runScriptedTurn(prompt, [step])
  const [change] = await waitForChanges(changes, 1)
  const outside = pieceText.replace('We reason with tools.', 'Paragraph X, written by another program.')
  const saveFile = ws.saveFile.bind(ws)
  let fired = false
  ws.saveFile = (p, content, options) => {
    if (!fired && p === PIECE) { fired = true; writeFileSync(join(root, PIECE), outside) }
    return saveFile(p, content, options)
  }
  const result = await live.resolveChange(change.id, 'accept')
  expect(fired).toBe(true)
  expect(result.applied).toBe(false)
  expect(result.message).toContain('changed on disk while the change was being applied')
  expect(result.changedOnDisk).toEqual({ path: PIECE, diskText: outside })
  expect(await read(PIECE)).toBe(outside)
  expect((await changes.get(change.id))?.status).toBe('pending')
})
