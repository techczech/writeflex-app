import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { buildE2EScriptedTurn, WorkspaceAgent, type ScriptedStep, type ScriptedTurn } from '../../src/main/agent'
import { ChangeStore } from '../../src/main/changes'
import { Workspace } from '../../src/main/workspace'

// The logic of tests/e2e/agent-object-proposal.spec.ts without Electron: a scripted agent turn stages an
// object insertion as a pending Change and writes nothing; Accept writes the fence at the anchor,
// Discard leaves the document exactly as it was. (How the staged object is drawn is the renderer's.)
const DRAFT = '# Draft\n\nPlace the object after this sentence.\n'
const ANCHOR = 'Place the object after this sentence.'

let root: string
let appData: string
let ws: Workspace
let changes: ChangeStore
let agent: WorkspaceAgent
const queue: ScriptedTurn[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-object-proposal-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-object-proposal-data-'))
  queue.length = 0
  await writeFile(join(root, 'draft.md'), DRAFT, 'utf8')
  await writeFile(join(root, 'editing.md'), '---\ntitle: Editing Piece\nstatus: editing\ndate: 2026-07-16\n---\n\n# Editing Piece\n', 'utf8')
  ws = new Workspace(root)
  changes = new ChangeStore(ws)
  agent = await WorkspaceAgent.create({
    workspace: ws, appDataDir: appData, changes,
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory(queue),
  })
})
afterEach(async () => {
  agent.dispose()
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

async function stage(step: ScriptedStep, prompt: string): Promise<void> {
  queue.push(buildE2EScriptedTurn([step]))
  const turn = await agent.runScriptedTurn(prompt, [step])
  expect(turn.messages.filter((m) => m.role === 'assistant').at(-1)?.content).toBe('Staged for your review.')
}
const disk = (): Promise<string> => readFile(join(root, 'draft.md'), 'utf8')

test('a scripted query insertion stays off the page until Accept writes the fence after its anchor', async () => {
  const query = '```query\nstatus: editing\n```'
  await stage({
    cap: 'prose.insert',
    input: { path: 'draft.md', text: query, insertAfter: ANCHOR, category: 'other', summary: 'Show pieces currently in editing.' },
  }, 'Put a table of everything in editing here')

  // Staged: one pending agent change carrying the fence; the file is untouched.
  const pending = await changes.list({ path: 'draft.md', status: 'pending' })
  expect(pending).toHaveLength(1)
  expect(pending[0]).toMatchObject({ provenance: 'agent', editClass: 'insert', summary: 'Show pieces currently in editing.', oldText: '' })
  expect(pending[0].newText).toContain(query)
  expect(await disk()).toBe(DRAFT)

  const result = await agent.resolveChange(pending[0].id, 'accept')
  expect(result.applied).toBe(true)
  expect(await disk()).toContain(`${ANCHOR}\n\n${query}`)
  expect((await disk()).startsWith('# Draft\n\n')).toBe(true)
  expect((await changes.get(pending[0].id))?.status).toBe('accepted')
  expect(await changes.list({ path: 'draft.md', status: 'pending' })).toEqual([])
})

test('a scripted table insertion stages without touching the page and Discard leaves the document as it was', async () => {
  const table = '| Title | Status |\n| --- | --- |\n| Draft | editing |'
  await stage({
    cap: 'objects.insert',
    input: { path: 'draft.md', kind: 'table', content: table, insertAfter: ANCHOR, summary: 'Add a compact status table.' },
  }, 'Add a small status table here')

  const suggestions = await agent.suggestions()
  expect(suggestions).toHaveLength(1)
  const pending = await changes.list({ path: 'draft.md', status: 'pending' })
  expect(pending).toHaveLength(1)
  expect(pending[0].newText).toContain(table)
  expect(pending[0].summary).toBe('Add a compact status table.')
  expect(await disk()).toBe(DRAFT)

  const outcome = await agent.discardSuggestion(suggestions[0].id)
  expect(outcome.suggestions).toEqual([])
  expect(await disk()).toBe(DRAFT)
  expect(await changes.list({ path: 'draft.md', status: 'pending' })).toEqual([])
})
