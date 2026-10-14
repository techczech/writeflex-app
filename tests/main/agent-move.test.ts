import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { ChangeStore } from '../../src/main/changes'
import { Workspace } from '../../src/main/workspace'
import { scriptedSessionFactory } from '@bridle/core'

let root: string
let appDataDir: string
let ws: Workspace
let changes: ChangeStore
let traces: Array<{ type: string; title: string; metadata?: Record<string, unknown> }>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-agent-move-'))
  appDataDir = await mkdtemp(join(tmpdir(), 'wf-agent-move-data-'))
  ws = new Workspace(root)
  changes = new ChangeStore(ws)
  traces = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(appDataDir, { recursive: true, force: true })
})

async function makeAgent(text: string, steps: ScriptedStep[]): Promise<WorkspaceAgent> {
  return WorkspaceAgent.create({
    workspace: ws,
    appDataDir,
    changes,
    onChangesChanged: () => {},
    onTrace: (event) => traces.push(event),
    onApprovalRequest: () => {},
    onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([{
      prompt: text,
      rounds: [
        { kind: 'tool-calls', calls: steps.map((step) => ({ name: step.cap, arguments: step.input as Record<string, unknown> })) },
        { kind: 'message', text: 'Scripted turn complete.' },
      ],
    }]),
  })
}

async function waitForChangeCount(count: number): Promise<Awaited<ReturnType<ChangeStore['list']>>> {
  for (let i = 0; i < 50; i += 1) {
    const all = await changes.list()
    if (all.length === count) return all
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return changes.list()
}

test('scripted prose.move ingests as one move Change and resolving it relocates the block', async () => {
  const text = 'Second paragraph to move.'
  const insertAfter = 'Third paragraph stays.'
  const draft = `# Draft\n\nFirst paragraph.\n\n${text}\n\n${insertAfter}\n`
  const destination = draft.indexOf(insertAfter) + insertAfter.length
  await writeFile(join(root, 'draft.md'), draft)
  const move: ScriptedStep = {
    cap: 'prose.move',
    input: { path: 'draft.md', text, insertAfter, summary: 'Move the second paragraph after the third.' },
  }
  const prompt = 'Move the second paragraph after the third'
  const agent = await makeAgent(prompt, [move])

  await agent.runScriptedTurn(prompt, [move])

  const all = await waitForChangeCount(1)
  expect(all).toHaveLength(1)
  expect(all[0]).toMatchObject({
    provenance: 'agent',
    editClass: 'move',
    category: 'structure',
    status: 'pending',
    oldText: text,
    newText: text,
    summary: 'Move the second paragraph after the third.',
  })
  expect(all[0].moveFrom).toEqual({ from: draft.indexOf(text), to: draft.indexOf(text) + text.length })
  expect(all[0].moveTo).toBeDefined()
  expect(all[0].moveTo).toEqual({ from: destination, to: destination })
  expect(all[0].anchor).toEqual({ from: destination - insertAfter.length, to: destination })

  expect(await agent.resolveChange(all[0].id, 'accept')).toEqual({ applied: true })
  expect((await ws.readFile('draft.md')).content).toBe('# Draft\n\nFirst paragraph.\n\nThird paragraph stays.\n\nSecond paragraph to move.\n')
  expect((await changes.get(all[0].id))?.status).toBe('accepted')

  // Editor ⌘Z restores the pre-resolution file and revives the persisted Change. Redo then comes
  // through this same main-process door after the live Bridle proposal has already settled.
  await ws.saveFile('draft.md', draft)
  await changes.setStatus(all[0].id, 'pending')
  expect(await agent.resolveChange(all[0].id, 'accept')).toEqual({ applied: true })
  expect((await ws.readFile('draft.md')).content).toBe('# Draft\n\nFirst paragraph.\n\nThird paragraph stays.\n\nSecond paragraph to move.\n')
  expect((await changes.get(all[0].id))?.status).toBe('accepted')
})

test('scripted prose.move records the original-buffer destination when source follows anchor', async () => {
  const text = 'Third paragraph to move.'
  const insertAfter = 'First paragraph.'
  const draft = `# Draft\n\n${insertAfter}\n\nSecond paragraph stays.\n\n${text}\n`
  const destination = draft.indexOf(insertAfter) + insertAfter.length
  await writeFile(join(root, 'draft.md'), draft)
  const move: ScriptedStep = {
    cap: 'prose.move',
    input: { path: 'draft.md', text, insertAfter, summary: 'Move the third paragraph after the first.' },
  }
  const prompt = 'Move the third paragraph after the first'
  const agent = await makeAgent(prompt, [move])

  await agent.runScriptedTurn(prompt, [move])

  const all = await waitForChangeCount(1)
  expect(all).toHaveLength(1)
  expect(all[0].moveFrom).toEqual({ from: draft.indexOf(text), to: draft.indexOf(text) + text.length })
  expect(all[0].moveTo).toEqual({ from: destination, to: destination })

  expect(await agent.resolveChange(all[0].id, 'accept')).toEqual({ applied: true })
  expect((await ws.readFile('draft.md')).content).toBe('# Draft\n\nFirst paragraph.\n\nThird paragraph to move.\n\nSecond paragraph stays.\n\n')
  expect((await changes.get(all[0].id))?.status).toBe('accepted')
})

test('applying the second of two same-source prose.move suggestions uses its recorded destination and rebases the survivor', async () => {
  const text = 'Move me.'
  const firstAnchor = 'Anchor one.'
  const secondAnchor = 'Anchor two.'
  const draft = `# Draft\n\n${text}\n\n${firstAnchor}\n\n${secondAnchor}\n`
  await writeFile(join(root, 'draft.md'), draft)
  const prompt = 'Stage two possible destinations for the same source paragraph'
  const steps: ScriptedStep[] = [
    {
      cap: 'prose.move',
      input: { path: 'draft.md', text, insertAfter: firstAnchor, summary: 'Move after the first anchor.' },
    },
    {
      cap: 'prose.move',
      input: { path: 'draft.md', text, insertAfter: secondAnchor, summary: 'Move after the second anchor.' },
    },
  ]
  const agent = await makeAgent(prompt, steps)

  await agent.runScriptedTurn(prompt, steps)

  const all = await waitForChangeCount(2)
  const second = all.find((c) => c.summary === 'Move after the second anchor.')
  expect(second).toBeDefined()
  const secondSuggestion = (await agent.suggestions()).find((suggestion) => {
    const input = suggestion.input as { summary?: string }
    return input.summary === 'Move after the second anchor.'
  })
  expect(secondSuggestion).toBeDefined()
  let diskWrites = 0
  const saveFile = ws.saveFile.bind(ws)
  ws.saveFile = async (...args) => {
    diskWrites += 1
    return saveFile(...args)
  }
  expect(await agent.applySuggestion(secondSuggestion!.id)).toMatchObject({
    text: 'Applied recorded prose.move proposal.',
    details: {
      file: {
        file: { path: 'draft.md', name: 'draft.md' },
        content: `# Draft\n\n${firstAnchor}\n\n${secondAnchor}\n\n${text}\n`,
      },
    },
  })
  expect(diskWrites).toBe(1)
  expect((await ws.readFile('draft.md')).content).toBe(`# Draft\n\n${firstAnchor}\n\n${secondAnchor}\n\n${text}\n`)
  expect((await changes.get(second!.id))?.status).toBe('accepted')
  const remaining = (await changes.list()).find((change) => change.summary === 'Move after the first anchor.')
  expect(remaining?.moveFrom).toEqual({ from: 35, to: 43 })
  expect(remaining?.moveTo).toEqual({ from: 20, to: 20 })
  expect(remaining?.anchor).toEqual({ from: 9, to: 20 })
  const settled = await (agent as unknown as { bridle: { proposals: { get: (id: string) => Promise<{ status: string; settledBy?: string } | undefined> } } })
    .bridle.proposals.get(secondSuggestion!.id)
  expect(settled).toMatchObject({
    status: 'superseded',
    settledBy: 'host',
    settlementReason: 'superseded-by-host',
  })
  expect(await agent.suggestions()).toHaveLength(0)
})

test('a refused host settlement never marks the recorded move accepted', async () => {
  const text = 'Move me.'
  const anchor = 'Anchor.'
  const draft = `# Draft\n\n${text}\n\n${anchor}\n`
  await writeFile(join(root, 'draft.md'), draft)
  const step: ScriptedStep = {
    cap: 'prose.move',
    input: { path: 'draft.md', text, insertAfter: anchor, summary: 'Move after the anchor.' },
  }
  const agent = await makeAgent('Move the paragraph', [step])

  await agent.runScriptedTurn('Move the paragraph', [step])

  const [change] = await waitForChangeCount(1)
  const [suggestion] = await agent.suggestions()
  const proposals = (agent as unknown as {
    bridle: {
      proposals: {
        get: (id: string) => Promise<Record<string, unknown> | undefined>
        settleAsHost: (id: string, settlement: unknown) => Promise<Record<string, unknown>>
      }
    }
  }).bridle.proposals
  const proposal = await proposals.get(suggestion.id)
  proposals.settleAsHost = async () => ({ ...proposal, refused: 'already-settled' })

  expect(await agent.applySuggestion(suggestion.id)).toEqual({
    text: 'The recorded move was applied, but its proposal settlement was refused (already-settled); the Change remains pending.',
    isError: true,
  })
  expect((await changes.get(change.id))?.status).toBe('pending')
})

test('scripted prose.move rejects ambiguous source text and records no Change', async () => {
  const draft = '# Draft\n\nRepeat me.\n\nAnchor.\n\nRepeat me.\n'
  await writeFile(join(root, 'draft.md'), draft)
  const prompt = 'Move the repeated paragraph'
  const steps: ScriptedStep[] = [
    {
      cap: 'prose.move',
      input: { path: 'draft.md', text: 'Repeat me.', insertAfter: 'Anchor.', summary: 'Move duplicate text' },
    },
  ]
  const agent = await makeAgent(prompt, steps)

  const result = await agent.runScriptedTurn(prompt, steps)

  expect(await waitForChangeCount(0)).toEqual([])
  expect(result.suggestions).toEqual([])
  expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Scripted turn complete.' })
  expect(result.messages.at(-1)?.error).toBeUndefined()
  expect(result.messages.find((message) => message.role === 'tool')?.content).toContain('not unique')
  expect(JSON.stringify(traces)).toContain('not unique')
  expect((await ws.readFile('draft.md')).content).toBe(draft)
})
