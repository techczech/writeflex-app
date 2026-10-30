import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory, type Capability, type CapabilityContext } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { BoardMaterialDesk } from '../../src/main/board-material-desk'
import { buildWriteFlexManifest, writeflexApprovalPolicy } from '../../src/main/capabilities'
import { ChangeStore } from '../../src/main/changes'
import { pauseCollectionWrites, resumeCollectionWrites } from '../../src/main/collection-write-gate'
import { ScrapStore } from '../../src/main/scraps'
import { ScratchpadStore } from '../../src/main/scratchpad-store'
import { listScrapsWithScratchpad } from '../../src/main/scrap-listing'
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
  agent = await WorkspaceAgent.create({ mode: 'work',
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

test('ticket 04 (P4 copy): a lossless Scratchpad offcut promotes under the desk restore point; the candidate is retained and one undo restores the tracker only', async () => {
  const store = new ScratchpadStore(ws, scraps)
  const exact = 'A **kept** paragraph.\n\n- with a list\n'
  const item = await store.addText({ origin: PIECE, markdown: exact, how: 'copy', by: 'writer' })
  const recordFile = `.writeflex/scratchpad-item-${item.id}.json`
  const board = await desk()
  const result = await board.promoteOffcut({ dir: DIR, scrapsPath: '', scrapId: item.id, name: 'Kept paragraph idea' })
  expect(result).toMatchObject({ ok: true, step: { kind: 'idea', activity: 'Offcut became an idea' }, paths: [TRACKER] })
  expect(await read(TRACKER)).toContain('- [[kept-paragraph-idea]]')
  expect(await read(TRACKER)).toContain('> A **kept** paragraph.')
  expect(await read(SCRAPS)).toBe(scrapsText) // the legacy file is untouched
  // Retained copy: the candidate stays listed with exact payload/id/status, plus a historical use.
  expect((await listScrapsWithScratchpad(ws, scraps)).some((s) => s.id === item.id)).toBe(true)
  const copied = JSON.parse(await read(recordFile)) as { consumed?: unknown; uses: Array<{ path: string; historical?: boolean }> }
  expect(copied.consumed).toBeUndefined()
  expect(copied.uses.some((use) => use.path === TRACKER && use.historical === true)).toBe(true)
  expect(await store.get(item.id)).toMatchObject({ markdown: exact, status: 'active' })

  expect((await board.undo(result.ok ? result.step.id : '')).ok).toBe(true)
  expect(await read(TRACKER)).toBe(trackerText)
  // Undo does not roll the candidate's record back: the historical copy remains, candidate reusable.
  const afterUndo = await store.get(item.id)
  expect(afterUndo.markdown).toBe(exact)
  expect(afterUndo.uses.some((use) => use.path === TRACKER && use.historical === true)).toBe(true)
  expect((await listScrapsWithScratchpad(ws, scraps)).some((s) => s.id === item.id)).toBe(true)
})

test('ticket 04 (P4 copy): appending a lossless drawer item keeps its exact bytes and retains the candidate; one undo restores the piece', async () => {
  const store = new ScratchpadStore(ws, scraps)
  const exact = 'Appended **exactly**.\r\n\r\nSecond block.\r\n'
  const item = await store.addText({ origin: PIECE, markdown: exact, how: 'copy', by: 'writer' })
  const board = await desk()
  const result = await board.appendScrap({ piece: PIECE, scrapId: item.id })
  expect(result.ok).toBe(true)
  expect(await read(PIECE)).toBe(`${pieceText}\n${exact}`)
  expect((await listScrapsWithScratchpad(ws, scraps)).some((s) => s.id === item.id)).toBe(true)

  expect((await board.undo(result.ok ? result.step.id : '')).ok).toBe(true)
  expect(await read(PIECE)).toBe(pieceText)
  expect((await store.get(item.id)).markdown).toBe(exact)
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
      { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: [step.cap] } }] },
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

test('P4 copy: an accepted agent scraps.promote of a lossless item copies it; the candidate stays and survives agent Undo of the tracker', async () => {
  const store = new ScratchpadStore(ws, scraps)
  const exact = 'Agent-copied **words**.\n'
  const item = await store.addText({ origin: PIECE, markdown: exact, how: 'copy', by: 'writer' })
  const changes = new ChangeStore(ws)
  const step: ScriptedStep = { cap: 'scraps.promote', input: { dir: DIR, origin: PIECE, id: item.id, name: 'Copied idea' } }
  const prompt = 'Turn the new offcut into an idea'
  const live = await bootAgent({
    changes,
    script: [{ prompt, rounds: [
      { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: [step.cap] } }] },
      { kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] },
      { kind: 'message', text: 'Proposed.' },
    ] }],
  })
  await live.runScriptedTurn(prompt, [step])
  // Proposal posture: nothing written before acceptance.
  expect(await read(TRACKER)).toBe(trackerText)
  const [change] = await waitForChanges(changes, 1)
  expect(change.summary).toContain('copied and stays')
  expect((await live.resolveChange(change.id, 'accept')).applied).toBe(true)
  expect(await read(TRACKER)).toContain('- [[copied-idea]]')
  expect(await read(SCRAPS)).toBe(scrapsText)
  // The candidate is retained, reusable, with a historical copy recorded.
  const kept = await store.get(item.id)
  expect(kept).toMatchObject({ markdown: exact, status: 'active' })
  expect(kept.uses.some((use) => use.path === TRACKER && use.mode === 'copy' && use.historical === true)).toBe(true)
  expect((await listScrapsWithScratchpad(ws, scraps)).some((s) => s.id === item.id)).toBe(true)

  const [turn] = (await live.turnState()).turns
  const undone = await live.undoTurn(turn.turnId, true)
  expect(undone.undone).toBe(true)
  expect(await read(TRACKER)).toBe(trackerText)
  // Undo restored the tracker; it must not roll the candidate's record back or consume it.
  const afterUndo = await store.get(item.id)
  expect(afterUndo).toMatchObject({ markdown: exact, status: 'active' })
  expect(afterUndo.uses.some((use) => use.path === TRACKER && use.historical === true)).toBe(true)
})

// Final review round 2, finding 1 (R5): an accepted scraps.promote writes the tracker and the scraps file only
// over the text it read. Another program writes one of them after the accept has read it, at the moment its
// write is staged: nothing is written over that version, and the accept is refused by type (changedOnDisk).
const outsideAtWrite = (path: string, text: string): { fired: () => boolean } => {
  let fired = false
  const saveFile = ws.saveFile.bind(ws)
  ws.saveFile = (p, content, options) => {
    if (!fired && p === path) { fired = true; writeFileSync(join(root, path), text) }
    return saveFile(p, content, options)
  }
  return { fired: () => fired }
}

async function stagedPromotion(): Promise<{ live: WorkspaceAgent; changes: ChangeStore; id: string }> {
  const changes = new ChangeStore(ws)
  const step: ScriptedStep = { cap: 'scraps.promote', input: { dir: DIR, origin: PIECE, id: HALL, name: 'Context everywhere' } }
  const prompt = 'Turn the Hall scrap into an idea'
  const live = await bootAgent({
    changes,
    script: [{ prompt, rounds: [
      { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: [step.cap] } }] },
      { kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] },
      { kind: 'message', text: 'Proposed.' },
    ] }],
  })
  await live.runScriptedTurn(prompt, [step])
  const [change] = await waitForChanges(changes, 1)
  return { live, changes, id: change.id }
}

test('an accepted scraps.promote never writes the tracker over a version it did not read (R5, round 2 finding 1)', async () => {
  const { live, changes, id } = await stagedPromotion()
  const outside = `${trackerText}- [[written-by-another-program]]\n`
  const injected = outsideAtWrite(TRACKER, outside)
  const result = await live.resolveChange(id, 'accept')
  expect(injected.fired()).toBe(true)
  expect(result.applied).toBe(false)
  expect(result.message).toContain('changed on disk while the change was being applied')
  expect(result.changedOnDisk).toEqual({ path: TRACKER, diskText: outside })
  expect(await read(TRACKER)).toBe(outside)
  expect(await read(SCRAPS)).toBe(scrapsText)
  expect((await changes.get(id))?.status).toBe('pending')
})

test('an accepted scraps.promote never takes the scrap out of a scraps file changed since its read (R5, round 2 finding 1)', async () => {
  const { live, id } = await stagedPromotion()
  const outside = `${scrapsText}\n## s_mtb9yb4zzzzz\nWritten by another program.\n`
  // Written while the tracker's write is staged: after both reads, before the scraps file's write.
  const saveFile = ws.saveFile.bind(ws)
  let fired = false
  ws.saveFile = (p, content, options) => {
    if (!fired && p === TRACKER) { fired = true; writeFileSync(join(root, SCRAPS), outside) }
    return saveFile(p, content, options)
  }
  const result = await live.resolveChange(id, 'accept')
  expect(fired).toBe(true)
  expect(result.applied).toBe(false)
  expect(result.changedOnDisk).toEqual({ path: SCRAPS, diskText: outside })
  expect(await read(SCRAPS)).toBe(outside)
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
      { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: [renameStep.cap] } }] },
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

// R7 (final Sol review round 3, P2): a failed Board step puts back only the files it wrote, each only while
// it still holds what the step wrote. Bridle's restoreTo put every snapshot back over whatever was there.

const promotion = { dir: DIR, scrapsPath: SCRAPS, scrapId: HALL, name: 'High and low context, everywhere' }
const promotedTracker = `${trackerText}- [[high-and-low-context-everywhere]]\n  > Hall's high and low context cultures.\n`

test('R7: a Board step refused before its first write restores nothing: the other program\'s version stays', async () => {
  const bridle = (await bootAgent()).hostSnapshots()
  const outside = `${trackerText}- [[written-by-another-program]]\n`
  // Written after the step read and snapshotted the tracker, before writeMaterial's first check.
  const store = bridle.snapshots
  const snapshots: typeof store = {
    beginRestorePoint: (label, sessionId) => store.beginRestorePoint(label, sessionId),
    restoreTo: (id, opts) => store.restoreTo(id, opts),
    entries: () => store.entries(),
    snapshotFile: async (absPath, meta) => {
      const entry = await store.snapshotFile(absPath, meta)
      if (absPath === ws.absolute(SCRAPS)) writeFileSync(join(root, TRACKER), outside)
      return entry
    },
  }
  const board = new BoardMaterialDesk(ws, { snapshots, sessionId: bridle.sessionId }, scraps)
  const result = await board.promoteOffcut(promotion)
  expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Nothing was changed') })
  expect(await read(TRACKER)).toBe(outside)
  expect(await read(SCRAPS)).toBe(scrapsText)
  expect(board.latest()).toBeNull()
})

/** Another program writes the scraps file (and optionally the tracker) while the scraps file's write is staged. */
function outsideAtScrapsWrite(scrapsOutside: string, trackerOutside?: string): () => boolean {
  const saveFileOverRead = ws.saveFileOverRead.bind(ws)
  let fired = false
  ws.saveFileOverRead = (p, next, readText, options) => {
    if (!fired && p === SCRAPS) {
      fired = true
      writeFileSync(join(root, SCRAPS), scrapsOutside)
      if (trackerOutside !== undefined) writeFileSync(join(root, TRACKER), trackerOutside)
    }
    return saveFileOverRead(p, next, readText, options)
  }
  return () => fired
}

test('R7: a Board step failing after its first of two files puts that file back and keeps the outside change on the second', async () => {
  const board = await desk()
  const outside = `${scrapsText}\n## s_mtb9yb4zzzzz\nWritten by another program.\n`
  const fired = outsideAtScrapsWrite(outside)
  const result = await board.promoteOffcut(promotion)
  expect(fired()).toBe(true)
  expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Nothing was changed') })
  expect(await read(TRACKER)).toBe(trackerText)
  expect(await read(SCRAPS)).toBe(outside)
  expect(board.latest()).toBeNull()
})

test('R7: a file the step wrote and another program changed before the rollback is left as it is and named', async () => {
  const board = await desk()
  const scrapsOutside = `${scrapsText}\n## s_mtb9yb4zzzzz\nWritten by another program.\n`
  const trackerOutside = `${promotedTracker}- [[also-written-by-another-program]]\n`
  const fired = outsideAtScrapsWrite(scrapsOutside, trackerOutside)
  const result = await board.promoteOffcut(promotion)
  expect(fired()).toBe(true)
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.message).toContain(`${TRACKER} changed on disk after WriteFlex wrote it, so it was left as it is.`)
  expect(result.message).not.toContain('Nothing was changed')
  expect(await read(TRACKER)).toBe(trackerOutside)
  expect(await read(SCRAPS)).toBe(scrapsOutside)
})

test('while another owner holds the Collection, a Board step and its undo are refused and write nothing, the history store included', async () => {
  const board = await desk()
  const tree = async (): Promise<Record<string, string>> => Object.fromEntries(await Promise.all(
    (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())
      .map(async (entry) => [join(entry.parentPath, entry.name).slice(root.length + 1), await readFile(join(entry.parentPath, entry.name), 'utf8')] as const),
  ))
  const input = { dir: DIR, scrapsPath: SCRAPS, scrapId: HALL, name: 'High and low context, everywhere' }
  const before = await tree()
  pauseCollectionWrites(root, 'Saving is paused for this test.')
  try {
    expect(await board.promoteOffcut(input)).toEqual({ ok: false, message: 'Nothing was changed: Saving is paused for this test.' })
    expect(await tree()).toEqual(before)
    expect(board.latest()).toBeNull()
    resumeCollectionWrites(root)
    const result = await board.promoteOffcut(input)
    expect(result.ok).toBe(true)

    const stepped = await tree()
    pauseCollectionWrites(root, 'Saving is paused for this test.')
    expect(await board.undo(result.ok ? result.step.id : '')).toEqual({ ok: false, message: "Can't undo: Saving is paused for this test. Nothing was put back." })
    expect(await tree()).toEqual(stepped)
    resumeCollectionWrites(root)
    expect((await board.undo(result.ok ? result.step.id : '')).ok).toBe(true)
    expect(await read(TRACKER)).toBe(trackerText)
  } finally {
    resumeCollectionWrites(root)
  }
})

// Parent independent review: a required copy-use record can fail after the tracker committed.
test('a refused accepted lossless promotion rolls back its own tracker write and preserves the outside candidate change', async () => {
  const store = new ScratchpadStore(ws, scraps)
  const item = await store.addText({ origin: PIECE, markdown: 'Exact **candidate**.\n', how: 'copy', by: 'writer' })
  const changes = new ChangeStore(ws)
  const step: ScriptedStep = { cap: 'scraps.promote', input: { dir: DIR, origin: PIECE, id: item.id, name: 'Refused copy' } }
  const prompt = 'Propose this candidate as an idea'
  const live = await bootAgent({ changes, script: [{ prompt, rounds: [
    { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: [step.cap] } }] },
    { kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] },
    { kind: 'message', text: 'Proposed.' },
  ] }] })
  await live.runScriptedTurn(prompt, [step])
  const [change] = await waitForChanges(changes, 1)
  const saveFile = ws.saveFile.bind(ws)
  let fired = false
  ws.saveFile = async (path, content, options) => {
    const saved = await saveFile(path, content, options)
    if (!fired && path === TRACKER) {
      fired = true
      const recordPath = join(root, '.writeflex', `scratchpad-item-${item.id}.json`)
      const record = JSON.parse(await readFile(recordPath, 'utf8'))
      record.status = 'rejected'
      await writeFile(recordPath, JSON.stringify(record) + '\n')
    }
    return saved
  }
  const result = await live.resolveChange(change.id, 'accept')
  expect(fired).toBe(true)
  expect(result.applied).toBe(false)
  expect(await read(TRACKER)).toBe(trackerText)
  expect(await store.get(item.id)).toMatchObject({ status: 'rejected', markdown: 'Exact **candidate**.\n' })
})

test('a refused accepted lossless promotion leaves a tracker changed outside after its write, and says it stayed', async () => {
  const store = new ScratchpadStore(ws, scraps)
  const item = await store.addText({ origin: PIECE, markdown: 'Exact **candidate**.\n', how: 'copy', by: 'writer' })
  const changes = new ChangeStore(ws)
  const step: ScriptedStep = { cap: 'scraps.promote', input: { dir: DIR, origin: PIECE, id: item.id, name: 'Refused copy outside tracker' } }
  const prompt = 'Propose this candidate as an idea'
  const live = await bootAgent({ changes, script: [{ prompt, rounds: [
    { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: [step.cap] } }] },
    { kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] },
    { kind: 'message', text: 'Proposed.' },
  ] }] })
  await live.runScriptedTurn(prompt, [step])
  const [change] = await waitForChanges(changes, 1)
  const saveFile = ws.saveFile.bind(ws)
  let fired = false
  let outsideTracker = ''
  ws.saveFile = async (path, content, options) => {
    const saved = await saveFile(path, content, options)
    if (!fired && path === TRACKER) {
      fired = true
      // After WriteFlex's tracker write landed, another program edits the tracker itself, and the
      // candidate is rejected outside, so the required historical-use record then refuses.
      outsideTracker = `${await read(TRACKER)}- [[written-outside-after-ours]]\n`
      await writeFile(join(root, TRACKER), outsideTracker)
      const recordPath = join(root, '.writeflex', `scratchpad-item-${item.id}.json`)
      const record = JSON.parse(await readFile(recordPath, 'utf8'))
      record.status = 'rejected'
      await writeFile(recordPath, JSON.stringify(record) + '\n')
    }
    return saved
  }
  const result = await live.resolveChange(change.id, 'accept')
  expect(fired).toBe(true)
  expect(result.applied).toBe(false)
  // The rollback is conditional: the tracker no longer holds only what WriteFlex wrote, so the
  // outside version (our line plus theirs) stays exactly, and the message names it as left.
  expect(result.message).toContain(`${TRACKER} changed on disk after WriteFlex wrote it, so it was left as it is.`)
  expect(result.message).not.toContain('Nothing was changed')
  expect(await read(TRACKER)).toBe(outsideTracker)
  expect(await read(TRACKER)).toContain('- [[written-outside-after-ours]]')
  // The outside candidate edit stays too, with its exact payload, and no copy use was recorded.
  const kept = await store.get(item.id)
  expect(kept).toMatchObject({ status: 'rejected', markdown: 'Exact **candidate**.\n' })
  expect(kept.uses.some((use) => use.path === TRACKER)).toBe(false)
  expect((await changes.get(change.id))?.status).toBe('pending')
})
