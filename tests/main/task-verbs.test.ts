import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory, type Capability, type CapabilityContext } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { buildWriteFlexManifest, writeflexApprovalPolicy } from '../../src/main/capabilities'
import { ChangeStore } from '../../src/main/changes'
import { toggleAgentNoteTask } from '../../src/main/tasks'
import { Workspace } from '../../src/main/workspace'

// Checkbox-lists ticket 04, journey B: an agent review becomes a to-do list. Ticking in the Agent
// notes pane writes into the NOTE's file, never the piece; the agent reads the boxes (tasks.list) and
// may only PROPOSE a tick (tasks.toggle, posture floor proposal — the content-verb law).

const PIECE = 'essays/why-schemas-matter.md'
const NOTE = 'essays/agent-notes/why-schemas-matter.review.md'
const pieceText = '# Why schemas matter\n\n- [ ] Move the schema definition up\n- [x] Add the restaurant script example\n'
const noteText = [
  '---',
  'author: agent',
  'agent_note_kind: review',
  `source_document: ${PIECE}`,
  'created: 2026-09-27T09:00:00.000Z',
  'skill: review',
  '---',
  '',
  'The argument holds, but the opening is quick. Two points matter most.',
  '',
  '1. [x] **The opening claim is too quick.** "Everybody knows…" invites disagreement.',
  '',
  '2. [ ] **No example of a schema.** The restaurant script would do it.',
  '',
].join('\n')

let root: string
let appData: string
let ws: Workspace

const ctx: CapabilityContext = {
  trigger: { id: 't', source: 'user', trust: 'interactive' },
  sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {},
}

function cap(name: string, services?: Parameters<typeof buildWriteFlexManifest>[2]): Capability {
  const found = buildWriteFlexManifest(ws, undefined, services).capabilities.find((c) => c.name === name)
  if (!found) throw new Error(`missing capability ${name}`)
  return found
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-task-verbs-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-task-verbs-data-'))
  ws = new Workspace(root)
  await mkdir(join(root, 'essays/agent-notes'), { recursive: true })
  await writeFile(join(root, PIECE), pieceText, 'utf8')
  await writeFile(join(root, NOTE), noteText, 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

test('the pane tick writes one character into the note file and leaves the piece untouched', async () => {
  const pieceBefore = await stat(join(root, PIECE))
  const toggled = await toggleAgentNoteTask(ws, NOTE, 13, false)
  expect(toggled).toMatchObject({ line: 13, checked: true, text: '**No example of a schema.** The restaurant script would do it.' })
  const after = await readFile(join(root, NOTE), 'utf8')
  expect(after).toBe(noteText.replace('2. [ ] **No example', '2. [x] **No example'))
  expect(after.length).toBe(noteText.length)
  const pieceAfter = await stat(join(root, PIECE))
  expect(pieceAfter.mtimeMs).toBe(pieceBefore.mtimeMs)
  expect(await readFile(join(root, PIECE), 'utf8')).toBe(pieceText)

  // Its undo is the inverse tick, guarded by the state the pane now shows.
  await toggleAgentNoteTask(ws, NOTE, 13, true)
  expect(await readFile(join(root, NOTE), 'utf8')).toBe(noteText)
})

test('the pane tick refuses the piece, a stale box and a line without a box, writing nothing', async () => {
  await expect(toggleAgentNoteTask(ws, PIECE, 3, false)).rejects.toThrow(/is not an agent note/)
  expect(await readFile(join(root, PIECE), 'utf8')).toBe(pieceText)
  await expect(toggleAgentNoteTask(ws, NOTE, 11, false)).rejects.toThrow(/already ticked/)
  await expect(toggleAgentNoteTask(ws, NOTE, 9, false)).rejects.toThrow(/no checkbox/)
  // A stray file in agent-notes/ that the agent did not write is not an agent note either.
  await writeFile(join(root, 'essays/agent-notes/mine.md'), '- [ ] my own list\n', 'utf8')
  await expect(toggleAgentNoteTask(ws, 'essays/agent-notes/mine.md', 1, false)).rejects.toThrow(/is not an agent note/)
  expect(await readFile(join(root, NOTE), 'utf8')).toBe(noteText)
})

test('tasks.list returns the open and done items of a note and of a piece, with their file lines', async () => {
  const note = await cap('tasks.list').execute({ path: NOTE }, ctx)
  expect(note.isError).toBeFalsy()
  expect(JSON.parse(note.text)).toEqual({
    path: NOTE,
    open: [{ line: 13, text: '**No example of a schema.** The restaurant script would do it.' }],
    done: [{ line: 11, text: '**The opening claim is too quick.** "Everybody knows…" invites disagreement.' }],
    counts: { open: 1, done: 1, total: 2 },
  })
  const piece = await cap('tasks.list').execute({ path: PIECE }, ctx)
  expect(JSON.parse(piece.text)).toMatchObject({
    open: [{ line: 3, text: 'Move the schema definition up' }],
    done: [{ line: 4, text: 'Add the restaurant script example' }],
  })
  expect((await cap('tasks.list').execute({ path: 'missing.md' }, ctx)).isError).toBe(true)
})

test('tasks.toggle stages at every trust level, validates the line, and previews the item', async () => {
  const policy = writeflexApprovalPolicy(undefined, ws)
  for (const trust of ['interactive', 'trusted_app', 'background'] as const) {
    expect(await policy({ capability: { name: 'tasks.toggle', risk: 'write' }, input: { path: NOTE, line: 13 }, trigger: { id: 't', source: 'user', trust } })).toBe('stage')
  }
  const toggle = cap('tasks.toggle')
  expect(await toggle.validateStage!({ path: NOTE, line: 13 })).toEqual({ decision: 'pass' })
  expect(await toggle.validateStage!({ path: NOTE, line: 9 })).toMatchObject({ decision: 'deny', reason: { message: expect.stringMatching(/no checkbox; call tasks.list/) } })
  expect(await toggle.preview!({ path: NOTE, line: 13 })).toBe(`Tick “**No example of a schema.** The restaurant script would do it.” — ${NOTE}, line 13`)
  expect(await toggle.preview!({ path: NOTE, line: 11 })).toStartWith('Untick “**The opening claim')
  expect(await toggle.touchedPaths!({ path: NOTE, line: 13 })).toEqual([ws.absolute(NOTE)])
})

test('an adopted tasks.toggle writes the one character and tells the pane and open tabs', async () => {
  const changed: string[][] = []
  const notes: string[] = []
  const toggle = cap('tasks.toggle', { notifyFilesChangedOnDisk: (paths) => changed.push(paths), onAgentNotesChanged: (path) => notes.push(path) })
  const result = await toggle.execute({ path: NOTE, line: 13 }, ctx)
  expect(result.isError).toBeFalsy()
  expect(result.text).toBe(`Ticked “**No example of a schema.** The restaurant script would do it.” in ${NOTE}.`)
  expect(await readFile(join(root, NOTE), 'utf8')).toBe(noteText.replace('2. [ ]', '2. [x]'))
  expect(changed).toEqual([[NOTE]])
  expect(notes).toEqual([NOTE])
})

async function waitForChanges(changes: ChangeStore, count: number): Promise<Awaited<ReturnType<ChangeStore['list']>>> {
  for (let i = 0; i < 50; i += 1) {
    const all = await changes.list()
    if (all.length === count) return all
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return changes.list()
}

test('an agent tasks.toggle is a proposal: nothing is written until the writer accepts it', async () => {
  const changes = new ChangeStore(ws)
  const step: ScriptedStep = { cap: 'tasks.toggle', input: { path: NOTE, line: 13 } }
  const prompt = 'Tick the schema example point'
  const agent = await WorkspaceAgent.create({ mode: 'work',
    workspace: ws, appDataDir: appData, changes,
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([{
      prompt,
      rounds: [
        { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: [step.cap] } }] },
        { kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] },
        { kind: 'message', text: 'Proposed.' },
      ],
    }]),
  })
  await agent.runScriptedTurn(prompt, [step])

  // Staged, never written.
  expect(await readFile(join(root, NOTE), 'utf8')).toBe(noteText)
  const [suggestion] = await agent.suggestions()
  expect(suggestion.capabilityName).toBe('tasks.toggle')
  const [change] = await waitForChanges(changes, 1)
  const from = noteText.indexOf('2. [ ]') + 3
  expect(change).toMatchObject({
    path: NOTE, provenance: 'agent', status: 'pending', oldText: '[ ]', newText: '[x]',
    anchor: { from, to: from + 3 }, summary: 'Tick “**No example of a schema.** The restaurant script would do it.”',
  })

  const pieceBefore = await stat(join(root, PIECE))
  expect((await agent.resolveChange(change.id, 'accept')).applied).toBe(true)
  expect(await readFile(join(root, NOTE), 'utf8')).toBe(noteText.replace('2. [ ]', '2. [x]'))
  expect((await stat(join(root, PIECE))).mtimeMs).toBe(pieceBefore.mtimeMs)
  expect((await changes.get(change.id))?.status).toBe('accepted')
  agent.dispose()
})
