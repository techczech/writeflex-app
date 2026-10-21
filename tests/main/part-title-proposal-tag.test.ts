// Fix round 0.23-alpha2: WriteFlex's own part-title proposals are known by an author only folio-part-proposals.ts
// files under. An agent-bridge change of the same shape and summary is the agent's, never "WriteFlex".
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { ChangeStore } from '../../src/main/changes'
import { newRequestId, type WriteRequest } from '../../src/main/cli/request-format'
import { proposePartTitles, partTitleFix, replacementFor } from '../../src/main/folio-part-proposals'
import { addOutsideRequests } from '../../src/main/outside-change-ingest'
import { ScrapStore } from '../../src/main/scraps'
import { WRITEFLEX_AGENT_AUTHOR, WRITEFLEX_SELF_AUTHOR } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
import { isAddHeadingProposal, isPartTitleProposal, WRITEFLEX_SELF_AUTHOR_NAME } from '../../src/shared/part-title-proposal'

let root: string
let appData: string
let ws: Workspace
let changes: ChangeStore
let agent: WorkspaceAgent | null = null

const PART = 'report/01-costs.md'
const PART_TEXT = 'Costs.\n\n## Items\n'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-part-tag-root-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-part-tag-data-'))
  await mkdir(join(root, 'report'), { recursive: true })
  await writeFile(join(root, PART), PART_TEXT)
  ws = new Workspace(root)
  changes = new ChangeStore(ws)
})
afterEach(async () => {
  await agent?.dispose()
  agent = null
  for (const dir of [root, appData]) await rm(dir, { recursive: true, force: true })
})

const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

test('the tag is not the agent bridge\'s author', () => {
  expect(WRITEFLEX_SELF_AUTHOR.name).toBe(WRITEFLEX_SELF_AUTHOR_NAME)
  expect(WRITEFLEX_SELF_AUTHOR.name).not.toBe(WRITEFLEX_AGENT_AUTHOR.name)
})

test('a change filed by folio-part-proposals is a part-title proposal of the add-heading kind', async () => {
  expect(await proposePartTitles(ws, changes, 'report')).toEqual({ proposed: 1, flagged: 1, withdrawn: 0 })
  const [filed] = await changes.list()
  expect(filed.author?.name).toBe('WriteFlex')
  expect(filed.summary).toBe('Add the heading “Costs” and a matching title')
  expect(isPartTitleProposal(filed)).toBe(true)
  expect(isAddHeadingProposal(filed)).toBe(true)
  // The ledger reads it back (Bridle's parseChangeLine takes any non-empty author name).
  expect(await new ChangeStore(ws).list()).toHaveLength(1)
})

test('an agent-bridge change with category structure and summary "Add the heading “X”" is NOT a part-title proposal', async () => {
  const step: ScriptedStep = { cap: 'prose.edit', input: { path: PART, oldText: 'Costs.', newText: '# X\n\nCosts.', category: 'structure', summary: 'Add the heading “X”' } }
  agent = await WorkspaceAgent.create({
    workspace: ws, appDataDir: appData, changes, services: { scraps: new ScrapStore(ws) },
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([{ prompt: 'Head it', rounds: [{ kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] }, { kind: 'message', text: 'Done.' }] }]),
  })
  await agent.runScriptedTurn('Head it', [step])
  let staged = await changes.list()
  while (staged.length === 0) { await tick(); staged = await changes.list() }
  const [bridged] = staged
  expect([bridged.provenance, bridged.category, bridged.summary, bridged.author?.name, bridged.sessionId]).toEqual(['agent', 'structure', 'Add the heading “X”', 'WriteFlex Agent', undefined])
  expect(isPartTitleProposal(bridged)).toBe(false)
  expect(isAddHeadingProposal(bridged)).toBe(false)
})

test('a command-line change of the same shape is NOT a part-title proposal', async () => {
  const id = newRequestId()
  const request = { version: 1, id, operation: 'replace', args: { path: PART, target: 'Costs.', with: '# X\n\nCosts.', source: 'WriteFlex' } } as unknown as WriteRequest
  const [outcome] = await addOutsideRequests({ requests: [{ id, request }], workspace: ws, changes, now: () => new Date() })
  const filed = outcome.kind === 'filed' ? outcome.changes : await changes.list()
  expect(filed.length).toBeGreaterThan(0)
  for (const change of filed) {
    expect(change.author?.name).not.toBe('WriteFlex')
    expect(isPartTitleProposal({ ...change, category: 'structure' })).toBe(false)
  }
})

test('a proposal filed under the older author is no longer labelled WriteFlex, and is still not proposed again', async () => {
  const fix = partTitleFix(PART_TEXT, PART)!
  const replacement = replacementFor(PART_TEXT, fix.next)!
  const old = await changes.add({
    path: PART, provenance: 'agent', editClass: 'insert', category: 'structure', summary: fix.summary,
    oldText: replacement.oldText, newText: replacement.newText, anchor: replacement.anchor, insertAfter: '',
    isCorrection: false, author: WRITEFLEX_AGENT_AUTHOR,
  })
  expect(isPartTitleProposal(old)).toBe(false)
  expect(await proposePartTitles(ws, changes, 'report')).toEqual({ proposed: 0, flagged: 1, withdrawn: 0 })
  expect(await changes.list()).toHaveLength(1)
})
