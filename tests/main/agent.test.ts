import { test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { bridleLaneForEnvironment, buildE2EScriptedTurn, proposalToSuggestion, registryModels, WorkspaceAgent, type ScriptedStep, type ScriptedTurn } from '../../src/main/agent'
import { collectionDirsForPaths } from '../../src/main/digest'
import { ChangeStore } from '../../src/main/changes'
import { BridleAuth, createModelService, scriptedSessionFactory, type BridleSessionFactory, type Proposal } from '@bridle/core'

let root: string
let appData: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-agent-root-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-agent-data-'))
  await writeFile(join(root, 'a.md'), '# A\n')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

test('uses the mock Bridle lane for e2e and builds the fixed honest TurnScript', () => {
  expect(bridleLaneForEnvironment({})).toBe('live')
  expect(bridleLaneForEnvironment({ WRITEFLEX_E2E: '0' })).toBe('live')
  expect(bridleLaneForEnvironment({ WRITEFLEX_E2E: '1' })).toBe('mock')
  expect(buildE2EScriptedTurn([{
    cap: 'files.list',
    input: { path: '' },
  }])).toEqual({
    prompt: '<e2e scripted turn>',
    rounds: [
      { kind: 'tool-calls', calls: [{ name: 'files.list', arguments: { path: '' } }] },
      { kind: 'message', text: 'Staged for your review.' },
    ],
  })
  expect(buildE2EScriptedTurn([{
    cap: 'files.list',
    input: { path: '' },
  }], '# Formatted reply')).toMatchObject({
    rounds: [
      { kind: 'tool-calls' },
      { kind: 'message', text: '# Formatted reply' },
    ],
  })
})

test('rejects an invalid e2e TurnScript before it can be queued', () => {
  expect(() => buildE2EScriptedTurn([])).toThrow(/at least one capability step/i)
  expect(() => buildE2EScriptedTurn([
    { cap: '', input: {} },
  ])).toThrow(/non-empty capability name/i)
})

test('an empty factory queue accepts two turns lazily in push order on one session', async () => {
  const queue: ScriptedTurn[] = []
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root),
    appDataDir: appData,
    onTrace: () => {},
    onApprovalRequest: () => {},
    onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory(queue),
  })

  const first = [{ cap: 'housekeeping.create_file', input: { path: 'first.md', content: '# First\n' } }]
  queue.push(buildE2EScriptedTurn(first))
  await agent.runScriptedTurn('Create the first file', first)

  const second = [{ cap: 'housekeeping.create_file', input: { path: 'second.md', content: '# Second\n' } }]
  queue.push(buildE2EScriptedTurn(second))
  const result = await agent.runScriptedTurn('Create the second file', second)

  expect((await readFile(join(root, 'first.md'), 'utf8'))).toBe('# First\n')
  expect((await readFile(join(root, 'second.md'), 'utf8'))).toBe('# Second\n')
  expect(result.messages.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual([
    'Staged for your review.',
    'Staged for your review.',
  ])
  agent.dispose()
})

test('undoing an agent rename restores the file and every reference repaired in that turn', async () => {
  await writeFile(join(root, 'old.md'), '# Report part\n')
  await writeFile(join(root, 'first-ref.md'), 'See [[old]].\n')
  await writeFile(join(root, 'second-ref.md'), 'Again [[old]].\n')
  const steps = [{ cap: 'housekeeping.rename_file', input: { path: 'old.md', newPath: 'new.md' } }]
  const queue = [buildE2EScriptedTurn(steps)]
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root),
    appDataDir: appData,
    onTrace: () => {},
    onApprovalRequest: () => {},
    onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory(queue),
  })

  await agent.runScriptedTurn('Rename the report part', steps)
  expect(await Bun.file(join(root, 'old.md')).exists()).toBe(false)
  expect(await readFile(join(root, 'new.md'), 'utf8')).toBe('# Report part\n')
  expect(await readFile(join(root, 'first-ref.md'), 'utf8')).toBe('See [[new]].\n')
  expect(await readFile(join(root, 'second-ref.md'), 'utf8')).toBe('Again [[new]].\n')

  const restored = await agent.restoreLastTurn()

  expect(new Set(restored)).toEqual(new Set([
    join(root, 'old.md'),
    join(root, 'new.md'),
    join(root, 'first-ref.md'),
    join(root, 'second-ref.md'),
  ]))
  expect(await readFile(join(root, 'old.md'), 'utf8')).toBe('# Report part\n')
  expect(await Bun.file(join(root, 'new.md')).exists()).toBe(false)
  expect(await readFile(join(root, 'first-ref.md'), 'utf8')).toBe('See [[old]].\n')
  expect(await readFile(join(root, 'second-ref.md'), 'utf8')).toBe('Again [[old]].\n')
  await agent.dispose()
})

test('a completed turn reports the model and reasoning level that actually ran it', async () => {
  const queue: ScriptedTurn[] = []
  const scripted = scriptedSessionFactory(queue)
  const ignoresThinkingChanges: BridleSessionFactory = async (options) => {
    const created = await scripted(options)
    created.session.setThinkingLevel = () => {}
    return created
  }
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root),
    appDataDir: appData,
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.4', thinkingLevel: 'medium' },
    onTrace: () => {},
    onApprovalRequest: () => {},
    onSuggestionsChanged: () => {},
    sessionFactory: ignoresThinkingChanges,
  })
  await agent.setThinking('high')
  expect(agent.thinkingLevel()).toBe('medium')
  queue.push(buildE2EScriptedTurn([{ cap: 'files.read', input: { path: 'a.md' } }]))

  const result = await agent.prompt('Read it')

  expect(result.messages.findLast((message) => message.role === 'assistant')?.execution).toMatchObject({
    provider: 'bridle-scripted-provider', modelId: 'bridle-scripted-model', thinkingLevel: 'medium',
  })
  await agent.dispose()
})

test('a rejected thinking-level change is surfaced and leaves Bridle in force', async () => {
  const queue: ScriptedTurn[] = []
  const scripted = scriptedSessionFactory(queue)
  const rejectsThinkingChanges: BridleSessionFactory = async (options) => {
    const created = await scripted(options)
    created.session.setThinkingLevel = () => { throw new Error('The provider refused high reasoning.') }
    return created
  }
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root), appDataDir: appData,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: rejectsThinkingChanges,
  })

  await expect(agent.setThinking('high')).rejects.toThrow('The provider refused high reasoning.')
  expect(agent.thinkingLevel()).toBe('medium')
  await agent.dispose()
})

test('registryModels uses Bridle model-service discovery and every listed family member resolves', async () => {
  await writeFile(join(appData, 'model-catalog.json'), JSON.stringify({
    version: 1,
    providers: {
      'openai-codex': {
        checkedAt: Date.now(),
        models: [{ provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
      },
    },
  }))
  const service = createModelService({ auth: BridleAuth.file(join(appData, 'auth.json')), appDataDir: appData })

  expect(registryModels(service).all).toContainEqual({
    provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol',
  })
  expect(service.resolve('openai-codex', 'gpt-5.6-sol')).toMatchObject({
    provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol',
  })
})

test('an unlisted model is refused by Bridle with its named human-readable error', async () => {
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root), appDataDir: appData,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([]),
  })

  try {
    await agent.setModel('openai-codex', 'gpt-not-listed')
    throw new Error('Expected the model switch to be refused.')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('BridleModelNotListedError')
    expect((error as Error).message).toBe('Model "openai-codex/gpt-not-listed" is not listed by this Bridle model service.')
  }
  await agent.dispose()
})

test('a turn receipt exposes only files actually opened by read tools in the Digest', async () => {
  const queue: ScriptedTurn[] = []
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root), appDataDir: appData,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory(queue),
  })
  const steps = [{ cap: 'files.read', input: { path: 'a.md' } }]
  queue.push(buildE2EScriptedTurn(steps))
  await agent.runScriptedTurn('Read A', steps)

  expect((await agent.collectionDigest('')).readThisTurn).toEqual(['a.md'])
  agent.dispose()
})

test('the following turn receives the previous turn file read under the truthful Digest label', async () => {
  const queue: ScriptedTurn[] = []
  const injected: string[] = []
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root), appDataDir: appData,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    observePromptContext: (content) => injected.push(content),
    sessionFactory: scriptedSessionFactory(queue),
  })
  await agent.collectionDigest('')
  const first = [{ cap: 'files.read', input: { path: 'a.md' } }]
  queue.push(buildE2EScriptedTurn(first))
  await agent.runScriptedTurn('Read A', first)
  const second = [{ cap: 'files.list', input: {} }]
  queue.push(buildE2EScriptedTurn(second))
  await agent.runScriptedTurn('List files', second)

  expect(injected[0]).toContain('READ LAST TURN (full file reads by tools)\n- none')
  expect(injected.at(-1)).toContain('READ LAST TURN (full file reads by tools)\n- a.md')
  agent.dispose()
})

test('prompt self-primes a current Digest after the boot cache revision becomes stale', async () => {
  const queue: ScriptedTurn[] = []
  const injected: string[] = []
  let revision = 0
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root), appDataDir: appData,
    getCollectionRevision: () => revision,
    observePromptContext: (content) => injected.push(content),
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory(queue),
  })
  await writeFile(join(root, 'n2.md'), '# N2\n\nCurrent digest piece.\n')
  revision += 1
  const steps = [{ cap: 'files.list', input: {} }]
  queue.push(buildE2EScriptedTurn(steps))

  const result = await agent.prompt('')

  expect(result.messages.some((message) => message.error)).toBe(false)
  expect(injected.at(-1)).toContain('n2.md')
  agent.dispose()
})

test('a primed Digest survives a revision bump and is used without a mid-turn recompute', async () => {
  const queue: ScriptedTurn[] = []
  const injected: string[] = []
  let revision = 0
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root), appDataDir: appData,
    getCollectionRevision: () => revision,
    observePromptContext: (content) => injected.push(content),
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory(queue),
  })
  await agent.primeCollectionDigest('')
  await writeFile(join(root, 'after-prime.md'), '# After prime\n')
  revision += 1
  const steps = [{ cap: 'files.list', input: {} }]
  queue.push(buildE2EScriptedTurn(steps))

  const result = await agent.prompt('Use the prepared digest')

  expect(result.messages.some((message) => message.error)).toBe(false)
  expect(injected.at(-1)).not.toContain('after-prime.md')
  agent.dispose()
})

test('a turn scoped to Essays invalidates Notes from its real write and the next Notes Digest carries the file', async () => {
  await mkdir(join(root, 'Essays'), { recursive: true })
  await mkdir(join(root, 'Notes'), { recursive: true })
  await writeFile(join(root, 'Essays', 'draft.md'), '# Draft\n')
  await writeFile(join(root, 'Notes', 'n1.md'), '# N1\n')
  const queue: ScriptedTurn[] = []
  const injected: string[] = []
  const revisions = new Map<string, number>()
  const bump = (paths: string[], activeDir: string) => {
    for (const dir of collectionDirsForPaths([...paths, activeDir])) revisions.set(dir, (revisions.get(dir) ?? 0) + 1)
  }
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root), appDataDir: appData,
    getCollectionRevision: (dir) => revisions.get(dir) ?? 0,
    onTurnComplete: bump,
    observePromptContext: (content) => injected.push(content),
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory(queue),
  })
  const create = [{ cap: 'housekeeping.create_file', input: { path: 'Notes/n2.md', content: '# N2\n\nWritten by the agent.\n' } }]
  queue.push(buildE2EScriptedTurn(create))
  await agent.prompt('Create the note', 'Essays/draft.md', 'Essays')
  expect(revisions.get('Notes')).toBe(1)
  const list = [{ cap: 'files.list', input: {} }]
  queue.push(buildE2EScriptedTurn(list))

  await agent.prompt('List Notes', 'Notes/n1.md', 'Notes')

  expect(injected.at(-1)).toContain('Notes/n2.md')
  agent.dispose()
})

test('a real nested write invalidates both its Collection and parent Collection scopes', async () => {
  await mkdir(join(root, 'Essays', 'sub'), { recursive: true })
  await writeFile(join(root, 'Essays', 'draft.md'), '# Draft\n')
  const queue: ScriptedTurn[] = []
  const revisions = new Map<string, number>()
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root), appDataDir: appData,
    getCollectionRevision: (dir) => revisions.get(dir) ?? 0,
    onTurnComplete: (paths, activeDir) => {
      for (const dir of collectionDirsForPaths([...paths, activeDir])) revisions.set(dir, (revisions.get(dir) ?? 0) + 1)
    },
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory(queue),
  })
  const create = [{ cap: 'housekeeping.create_file', input: { path: 'Essays/sub/n2.md', content: '# Nested\n' } }]
  queue.push(buildE2EScriptedTurn(create))

  await agent.prompt('Create the nested Piece', 'Essays/draft.md', 'Essays')

  expect(revisions.get('Essays')).toBe(1)
  expect(revisions.get('Essays/sub')).toBe(1)
  agent.dispose()
})

test('a prompt that throws after taking a prepared Digest leaves no cache pin', async () => {
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root), appDataDir: appData,
    observePromptContext: () => { throw new Error('forced context observer failure') },
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([]),
  })
  await agent.primeCollectionDigest('')

  await expect(agent.prompt('Fail after taking the digest')).rejects.toThrow('forced context observer failure')

  expect(agent.digestPinCountForTests()).toBe(0)
  agent.dispose()
})

test('maps a proposed Bridle text diff onto the frozen renderer suggestion wire shape', () => {
  const proposal: Proposal = {
    id: 'proposal-1',
    kind: 'change',
    sessionId: 'session-1',
    turnId: 'turn-1',
    groupId: 'turn-1',
    capability: 'prose.edit',
    risk: 'write',
    title: 'wording edit — Tighten the sentence',
    payload: { path: 'a.md', oldText: 'wordy', newText: 'concise' },
    status: 'proposed',
    createdAt: '2026-07-13T07:00:00.000Z',
  }

  expect(proposalToSuggestion(proposal, {
    kind: 'text-diff',
    before: '# A\n\nThe draft is wordy.\n',
    after: '# A\n\nThe draft is concise.\n',
    stale: false,
  })).toEqual({
    id: 'proposal-1',
    capabilityName: 'prose.edit',
    input: proposal.payload,
    preview: 'wording edit — Tighten the sentence\n--- current\n# A\n\nThe draft is wordy.\n\n+++ proposed\n# A\n\nThe draft is concise.\n',
    stagedAt: Date.parse(proposal.createdAt),
  })
})

test('create() opens the snapshot store in <root>/.bridle (history-on-open) and exposes model surface', async () => {
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root), appDataDir: appData,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {}
  })
  expect(existsSync(join(root, '.bridle', 'objects'))).toBe(true)
  // usability review fix: the model select lists only lanes with credentials — a fresh appData has none.
  // The positive path (configured lane → models listed) is covered live at usability review and by bridle's auth tests.
  expect(agent.availableModels()).toEqual([])
  expect(await agent.suggestions()).toEqual([])
  expect(agent.messages()).toEqual([])
  await agent.checkpointFile('a.md')
  expect(existsSync(join(root, '.bridle', 'journal.jsonl'))).toBe(true)
  agent.dispose()
})

function fixedScript(text: string, steps: ScriptedStep[]): Parameters<typeof scriptedSessionFactory>[0] {
  return [{
    prompt: text,
    rounds: [
      { kind: 'tool-calls', calls: steps.map((step) => ({ name: step.cap, arguments: step.input as Record<string, unknown> })) },
      { kind: 'message', text: 'Scripted turn complete.' },
    ],
  }]
}

async function makeLedgerAgent(script?: { text: string; steps: ScriptedStep[] }): Promise<{ agent: WorkspaceAgent; workspace: Workspace; changes: ChangeStore }> {
  const workspace = new Workspace(root)
  const changes = new ChangeStore(workspace)
  const agent = await WorkspaceAgent.create({
    workspace,
    appDataDir: appData,
    changes,
    onChangesChanged: () => {},
    onTrace: () => {},
    onApprovalRequest: () => {},
    onSuggestionsChanged: () => {},
    ...(script ? { sessionFactory: scriptedSessionFactory(fixedScript(script.text, script.steps)) } : {}),
  })
  return { agent, workspace, changes }
}

test('accepting a persisted pending agent edit applies its stored unique replacement', async () => {
  const draft = '# A\n\nThe draft is too wordy.\n'
  await writeFile(join(root, 'a.md'), draft)
  const { agent, workspace, changes } = await makeLedgerAgent()
  const change = await changes.add({
    path: 'a.md',
    provenance: 'agent',
    editClass: 'content',
    category: 'wording',
    summary: 'Tighten the sentence',
    oldText: 'The draft is too wordy.',
    newText: 'The draft is concise.',
    isCorrection: false,
  })

  const result = await agent.resolveChange(change.id, 'accept')

  expect(result).toEqual({ applied: true })
  expect((await workspace.readFile('a.md')).content).toBe('# A\n\nThe draft is concise.\n')
  const journal = (await readFile(join(root, '.bridle', 'journal.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; file?: string; hash?: string; capability?: string })
  expect(journal).toContainEqual(expect.objectContaining({
    kind: 'snapshot',
    file: join(root, 'a.md'),
    capability: 'change.accept',
    hash: createHash('sha256').update(draft).digest('hex'),
  }))
  expect((await changes.get(change.id))?.status).toBe('accepted')
  agent.dispose()
})

test('rejecting a persisted pending agent edit leaves disk untouched and marks rejected', async () => {
  const draft = '# A\n\nThe draft is too wordy.\n'
  await writeFile(join(root, 'a.md'), draft)
  const { agent, workspace, changes } = await makeLedgerAgent()
  const change = await changes.add({
    path: 'a.md',
    provenance: 'agent',
    editClass: 'copy',
    category: 'grammar',
    summary: 'Rejectable edit',
    oldText: 'too wordy',
    newText: 'concise',
    isCorrection: false,
  })

  const result = await agent.resolveChange(change.id, 'reject')

  expect(result).toEqual({ applied: true })
  expect((await workspace.readFile('a.md')).content).toBe(draft)
  expect((await changes.get(change.id))?.status).toBe('rejected')
  agent.dispose()
})

test('scripted frontmatter.normalise exposes the current failure: staged metadata is absent from review Changes', async () => {
  await writeFile(join(root, 'a.md'), '---\ntitle: A\n---\n\n# A\n')
  const steps: ScriptedStep[] = [{
    cap: 'frontmatter.normalise',
    input: { path: 'a.md' },
  }]
  const { agent, workspace, changes } = await makeLedgerAgent({ text: 'Add metadata', steps })
  const turn = await agent.runScriptedTurn('Add metadata', steps)

  expect(turn.suggestions).toHaveLength(1)
  expect(turn.suggestions[0].capabilityName).toBe('frontmatter.normalise')
  expect(await changes.list()).toEqual([])
  expect((await workspace.readFile('a.md')).content).toBe('---\ntitle: A\n---\n\n# A\n')
  agent.dispose()
})

test('scripted frontmatter.set stages a review Change and applies canonical metadata to a bare file', async () => {
  const steps: ScriptedStep[] = [{
    cap: 'frontmatter.set',
    input: { path: 'a.md', set: { title: 'A', tags: ['draft', 'review'] }, summary: 'Add metadata' },
  }]
  const { agent, workspace, changes } = await makeLedgerAgent({ text: 'Add metadata', steps })
  const turn = await agent.runScriptedTurn('Add metadata', steps)

  expect(turn.suggestions).toHaveLength(1)
  const outcome = await agent.applySuggestion(turn.suggestions[0].id)
  expect(outcome.isError).toBeUndefined()
  const settled = await (agent as unknown as { bridle: { proposals: { get: (id: string) => Promise<{ status: string } | undefined> } } })
    .bridle.proposals.get(turn.suggestions[0].id)
  expect(settled?.status).toBe('adopted')
  expect((await changes.list())).toHaveLength(1)
  expect((await workspace.readFile('a.md')).content).toBe('---\ntitle: A\ntags: [draft, review]\n---\n\n# A\n')
  agent.dispose()
})

test('a refused frontmatter staging creates no proposal or review Change', async () => {
  await writeFile(join(root, 'a.md'), '---\nstatus: idea and\n  more words\n---\n\n# A\n')
  const steps: ScriptedStep[] = [{
    cap: 'frontmatter.set',
    input: { path: 'a.md', set: { status: 'ready' }, summary: 'Set status' },
  }]
  const { agent, changes } = await makeLedgerAgent({ text: 'Set status', steps })
  const turn = await agent.runScriptedTurn('Set status', steps)

  expect(turn.suggestions).toEqual([])
  expect(await changes.list()).toEqual([])
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('---\nstatus: idea and\n  more words\n---\n\n# A\n')
  agent.dispose()
})

test('a trailing-space target collision refuses agent staging and preserves every byte', async () => {
  const original = '---\ngoal : 500\nstatus: idea\n---\n\n# A\n'
  await writeFile(join(root, 'a.md'), original)
  const steps: ScriptedStep[] = [{
    cap: 'frontmatter.set',
    input: { path: 'a.md', set: { goal: '900' }, summary: 'Set goal' },
  }]
  const { agent, changes } = await makeLedgerAgent({ text: 'Set goal', steps })
  const turn = await agent.runScriptedTurn('Set goal', steps)

  expect(turn.suggestions).toEqual([])
  expect(await changes.list()).toEqual([])
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(original)
  agent.dispose()
})

test('an errored proposal execution reports its capability error and never reports Applied', async () => {
  const steps: ScriptedStep[] = [{
    cap: 'frontmatter.set',
    input: { path: 'a.md', set: { status: 'ready' }, summary: 'Set status' },
  }]
  const { agent, workspace } = await makeLedgerAgent({ text: 'Set status', steps })
  const turn = await agent.runScriptedTurn('Set status', steps)
  expect(turn.suggestions).toHaveLength(1)
  const mutableWorkspace = workspace as unknown as { saveFile: Workspace['saveFile'] }
  mutableWorkspace.saveFile = async () => { throw new Error('forced frontmatter apply failure') }

  const outcome = await agent.applySuggestion(turn.suggestions[0].id)

  expect(outcome).toMatchObject({ isError: true, text: 'forced frontmatter apply failure' })
  expect(outcome.text).not.toContain('Applied')
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('# A\n')
  agent.dispose()
})

test('invalid scripted objects.insert is a corrective tool result, not a failed turn or staged proposal', async () => {
  const steps: ScriptedStep[] = [{
    cap: 'objects.insert',
    input: { path: 'a.md', kind: 'mermaid', content: 'diagram LR\n  A --> B', summary: 'Add diagram.' },
  }]
  const traces: unknown[] = []
  const workspace = new Workspace(root)
  const changes = new ChangeStore(workspace)
  const agent = await WorkspaceAgent.create({
    workspace,
    appDataDir: appData,
    changes,
    onChangesChanged: () => {},
    onTrace: (event) => traces.push(event),
    onApprovalRequest: () => {},
    onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory(fixedScript('Add a diagram', steps)),
  })

  const turn = await agent.runScriptedTurn('Add a diagram', steps)

  expect(turn.suggestions).toEqual([])
  expect(await changes.list()).toEqual([])
  expect(turn.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Scripted turn complete.' })
  expect(turn.messages.at(-1)?.error).toBeUndefined()
  expect(JSON.stringify(traces)).toContain('must start with a supported diagram type')
  await agent.dispose()
})

test('accepting a persisted agent edit with non-unique oldText refuses and stays pending', async () => {
  const draft = '# A\n\nRepeat me.\n\nRepeat me.\n'
  await writeFile(join(root, 'a.md'), draft)
  const { agent, workspace, changes } = await makeLedgerAgent()
  const change = await changes.add({
    path: 'a.md',
    provenance: 'agent',
    editClass: 'copy',
    category: 'wording',
    summary: 'Ambiguous edit',
    oldText: 'Repeat me.',
    newText: 'Say this once.',
    isCorrection: false,
  })

  const result = await agent.resolveChange(change.id, 'accept')

  expect(result.applied).toBe(false)
  expect(result.message).toMatch(/not unique/i)
  expect((await workspace.readFile('a.md')).content).toBe(draft)
  expect((await changes.get(change.id))?.status).toBe('pending')
  agent.dispose()
})

test('accepting a persisted agent move replays its recorded coordinates', async () => {
  const draft = '# A\n\nMove this.\n\nAnchor.\n'
  await writeFile(join(root, 'a.md'), draft)
  const { agent, workspace, changes } = await makeLedgerAgent()
  const change = await changes.add({
    path: 'a.md',
    provenance: 'agent',
    editClass: 'move',
    category: 'structure',
    summary: 'Move a paragraph',
    oldText: 'Move this.',
    newText: 'Move this.',
    moveFrom: { from: draft.indexOf('Move this.'), to: draft.indexOf('Move this.') + 'Move this.'.length },
    moveTo: { from: draft.indexOf('Anchor.') + 'Anchor.'.length, to: draft.indexOf('Anchor.') + 'Anchor.'.length },
    isCorrection: false,
  })

  const result = await agent.resolveChange(change.id, 'accept')

  expect(result.applied).toBe(true)
  expect((await workspace.readFile('a.md')).content).toBe('# A\n\nAnchor.\n\nMove this.\n')
  expect((await changes.get(change.id))?.status).toBe('accepted')
  agent.dispose()
})

test('version finalisation applies pending stored agent edits before snapshotting', async () => {
  const draft = '# A\n\nThe draft is too wordy and has bad grammer.\n'
  await writeFile(join(root, 'a.md'), draft)
  const { agent, workspace, changes } = await makeLedgerAgent()
  const wording = await changes.add({
    path: 'a.md',
    provenance: 'agent',
    editClass: 'content',
    category: 'wording',
    summary: 'Tighten wording',
    oldText: 'too wordy',
    newText: 'concise',
    isCorrection: false,
  })
  const grammar = await changes.add({
    path: 'a.md',
    provenance: 'agent',
    editClass: 'copy',
    category: 'grammar',
    summary: 'Fix grammar',
    oldText: 'bad grammer',
    newText: 'poor grammar',
    isCorrection: false,
  })

  await agent.applyAcceptedChangesForVersion([wording.id, grammar.id])
  const version = await agent.snapshotReviewVersion('a.md')

  expect((await workspace.readFile('a.md')).content).toBe('# A\n\nThe draft is concise and has poor grammar.\n')
  expect((await changes.get(wording.id))?.status).toBe('accepted')
  expect((await changes.get(grammar.id))?.status).toBe('accepted')
  const journal = (await readFile(join(root, '.bridle', 'journal.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string; id?: string; file?: string; hash?: string; capability?: string })
  expect(journal).toContainEqual(expect.objectContaining({
    kind: 'snapshot',
    id: version.snapshotId,
    file: join(root, 'a.md'),
    capability: 'change.save-version',
    hash: createHash('sha256').update('# A\n\nThe draft is concise and has poor grammar.\n').digest('hex'),
  }))
  agent.dispose()
})

test('version finalisation does not re-apply an edit that was already accepted on the way to saving', async () => {
  await writeFile(join(root, 'a.md'), '# A\n\nThis is not bad.\n')
  const { agent, workspace, changes } = await makeLedgerAgent()
  const change = await changes.add({
    path: 'a.md',
    provenance: 'agent',
    editClass: 'copy',
    category: 'wording',
    summary: 'Soften the judgement',
    oldText: 'bad',
    newText: 'not bad',
    status: 'accepted',
    isCorrection: false,
  })

  await agent.applyAcceptedChangesForVersion([change.id])

  expect((await workspace.readFile('a.md')).content).toBe('# A\n\nThis is not bad.\n')
  expect((await changes.get(change.id))?.status).toBe('accepted')
  agent.dispose()
})

test('version finalisation stamps accepted changes and leaves undecided proposals pending for a future version', async () => {
  await writeFile(join(root, 'a.md'), '# A\n\nThe draft is concise but has bad grammer.\n')
  const { agent, workspace, changes } = await makeLedgerAgent()
  const accepted = await changes.add({
    path: 'a.md',
    provenance: 'agent',
    editClass: 'copy',
    category: 'grammar',
    summary: 'Fix grammar',
    oldText: 'bad grammer',
    newText: 'poor grammar',
    isCorrection: false,
  })
  const undecided = await changes.add({
    path: 'a.md',
    provenance: 'agent',
    editClass: 'content',
    category: 'wording',
    summary: 'Strengthen ending',
    oldText: 'concise',
    newText: 'focused',
    isCorrection: false,
  })

  expect(await agent.resolveChange(accepted.id, 'accept')).toEqual({ applied: true })
  const version = await agent.snapshotReviewVersion('a.md')
  const stamped = await changes.saveVersion([accepted.id, undecided.id], version.versionId, {
    [accepted.id]: 'accepted',
  })

  expect((await workspace.readFile('a.md')).content).toBe('# A\n\nThe draft is concise but has poor grammar.\n')
  expect(stamped.map((change) => change.id)).toEqual([accepted.id])
  expect((await changes.get(accepted.id))?.snapshotId).toBe(version.versionId)
  const stillPending = await changes.get(undecided.id)
  expect(stillPending?.status).toBe('pending')
  expect(stillPending?.snapshotId).toBeUndefined()
  expect(stillPending?.newText).toBe('focused')
  agent.dispose()
})

test('version finalisation leaves earlier saved changes out of the current run', async () => {
  await writeFile(join(root, 'a.md'), '# A\n\nThe draft is good but dull.\n')
  const { agent, workspace, changes } = await makeLedgerAgent()
  const saved = await changes.add({
    path: 'a.md',
    provenance: 'agent',
    editClass: 'copy',
    category: 'wording',
    summary: 'Already saved wording',
    oldText: 'bad',
    newText: 'good',
    status: 'accepted',
    isCorrection: false,
  })
  await changes.saveVersion([saved.id], 'old-version', { [saved.id]: 'accepted' })
  const fresh = await changes.add({
    path: 'a.md',
    provenance: 'agent',
    editClass: 'content',
    category: 'wording',
    summary: 'Fresh run wording',
    oldText: 'dull',
    newText: 'sharp',
    isCorrection: false,
  })

  await agent.applyAcceptedChangesForVersion([saved.id, fresh.id])
  const version = await agent.snapshotReviewVersion('a.md')
  const stamped = await changes.saveVersion([saved.id, fresh.id], version.versionId, {
    [saved.id]: 'accepted',
    [fresh.id]: 'accepted',
  })

  expect((await workspace.readFile('a.md')).content).toBe('# A\n\nThe draft is good but sharp.\n')
  expect(stamped.map((change) => change.id)).toEqual([fresh.id])
  expect((await changes.get(saved.id))?.snapshotId).toBe('old-version')
  expect((await changes.get(fresh.id))?.snapshotId).toBe(version.versionId)
  agent.dispose()
})

test('the canonical run-as-is instruction never reaches the visible transcript', async () => {
  const { mapSessionMessages, RUN_AS_IS_INSTRUCTION } = await import('../../src/main/agent')
  const messages = mapSessionMessages([
    { role: 'user', content: RUN_AS_IS_INSTRUCTION, timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'Staged 2 changes.' }], timestamp: 2 },
    { role: 'user', content: 'a real question', timestamp: 3 },
  ])
  // The run turn shows as an agent reply with NOTHING said; real user text still shows.
  expect(messages.map((m) => `${m.role}:${m.content}`)).toEqual([
    'assistant:Staged 2 changes.',
    'user:a real question',
  ])
})

test('ambient is model-visible exactly once before the Digest and never enters the user transcript', async () => {
  const { AmbientState, ambientToPrompt } = await import('../../src/main/ambient')
  const ambient = new AmbientState(root)
  ambient.set({ workspaceRoot: root, activeFile: { path: 'a.md', title: 'The actual heading', collection: '' }, mode: { writer: 'reviewing', view: 'raw' }, selection: { from: 4, to: 12, text: 'Selected' }, process: null, recency: {} })
  const expected = ambientToPrompt(ambient.get())
  const modelTexts: string[] = []
  const scripted = scriptedSessionFactory([buildE2EScriptedTurn([{ cap: 'files.read', input: { path: 'a.md' } }])])
  const factory: BridleSessionFactory = async (opts) => {
    const created = await scripted(opts)
    const prompt = created.session.prompt.bind(created.session)
    created.session.prompt = (text, options) => { modelTexts.push(text); return prompt(text, options) }
    return created
  }
  const agent = await WorkspaceAgent.create({ workspace: new Workspace(root), appDataDir: appData,
    composition: { ambient }, sessionFactory: factory,
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {} })
  try {
    const result = await agent.prompt('What am I looking at?', 'wrong.md')
    expect(modelTexts).toHaveLength(1)
    expect(modelTexts[0].split(expected)).toHaveLength(2)
    expect(modelTexts[0].indexOf(expected)).toBeLessThan(modelTexts[0].indexOf('Active Collection Digest'))
    expect(ambient.get().recency.lastAgentActionAt).toBeDefined()
    expect(result.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['What am I looking at?'])
    expect(result.messages.some((m) => m.content.includes('Workspace:'))).toBe(false)
    expect(ambient.get().recency.lastAgentActionAt).toBeDefined()
  } finally { await agent.dispose() }
})
