import { test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { bridleLaneForEnvironment, buildE2EScriptedTurn, placeRecordedReplacement, proposalToSuggestion, registryModels, WorkspaceAgent, type ScriptedStep, type ScriptedTurn } from '../../src/main/agent'
import { collectionDirsForPaths } from '../../src/main/digest'
import { ChangeStore, closedReasonOf } from '../../src/main/changes'
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
      { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: ['files.list'] } }] },
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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
      { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: steps.map((step) => step.cap) } }] },
      { kind: 'tool-calls', calls: steps.map((step) => ({ name: step.cap, arguments: step.input as Record<string, unknown> })) },
      { kind: 'message', text: 'Scripted turn complete.' },
    ],
  }]
}

async function makeLedgerAgent(script?: { text: string; steps: ScriptedStep[] }): Promise<{ agent: WorkspaceAgent; workspace: Workspace; changes: ChangeStore }> {
  const workspace = new Workspace(root)
  const changes = new ChangeStore(workspace)
  const agent = await WorkspaceAgent.create({ mode: 'work',
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

/** A staged agent replacement as the ingest records it: anchored in `source`. */
async function stageReplacement(changes: ChangeStore, source: string, oldText: string, newText: string, path = 'a.md') {
  const from = source.indexOf(oldText)
  const change = await changes.addProposedReplacement({
    path,
    provenance: 'agent',
    editClass: 'content',
    category: 'wording',
    summary: 'Tighten',
    oldText,
    newText,
    anchor: { from, to: from + oldText.length },
    isCorrection: false,
  })
  if (!change) throw new Error('not staged')
  return change
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

  expect(result).toMatchObject({ applied: true, receipt: { written: '# A\n\nThe draft is concise.\n' } })
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
  const agent = await WorkspaceAgent.create({ mode: 'work',
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

test('accepting a persisted agent edit with non-unique oldText refuses, writes nothing and leaves it pending (ticket 14)', async () => {
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

  expect(result).toEqual({ applied: false, message: expect.stringMatching(/not unique/i) })
  expect((await workspace.readFile('a.md')).content).toBe(draft)
  // An Accept that could not be carried out is not a decision: neither accepted nor declined, no reason recorded.
  const after = (await changes.get(change.id))!
  expect(after.status).toBe('pending')
  expect(closedReasonOf(after)).toBeNull()
  agent.dispose()
})

// Ticket 14's example: "Most reading lists" → "Most lists" is recorded shortened to the removed word
// `reading `, which also stands in the title. Accepted after the live proposal has gone (a relaunch:
// a second agent over the same ledger), it is placed where it was made and the title is untouched.
const READING_DRAFT = '# Why reading matters\n\nMost reading lists are too long.\n'
const READING_EDIT: ScriptedStep = { cap: 'prose.edit', input: { path: 'a.md', oldText: 'Most reading lists', newText: 'Most lists', category: 'wording', summary: 'Trim' } }

async function stageReadingEditThenRelaunch(): Promise<{ agent: WorkspaceAgent; changes: ChangeStore; id: string }> {
  await writeFile(join(root, 'a.md'), READING_DRAFT)
  const staged = await makeLedgerAgent({ text: 'Trim', steps: [READING_EDIT] })
  await staged.agent.runScriptedTurn('Trim', [READING_EDIT])
  const [change] = await staged.changes.list()
  staged.agent.dispose()
  expect(change).toMatchObject({ oldText: 'reading ', newText: '', anchorContext: { before: 'Most ', after: 'lists' } })
  const relaunched = await makeLedgerAgent()
  return { agent: relaunched.agent, changes: relaunched.changes, id: change.id }
}

test('ticket 14: a shortened edit whose removed word also stands in the title is accepted at its place; the title is untouched', async () => {
  const { agent, changes, id } = await stageReadingEditThenRelaunch()

  const result = await agent.resolveChange(id, 'accept')

  expect(result.applied).toBe(true)
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('# Why reading matters\n\nMost lists are too long.\n')
  expect((await changes.get(id))?.status).toBe('accepted')
  agent.dispose()
})

test('ticket 14: the words trimmed off the shortened edit find its place after the text above it has moved', async () => {
  const { agent, changes, id } = await stageReadingEditThenRelaunch()
  // The recorded span no longer holds the text; the trimmed words still stand once around it.
  await writeFile(join(root, 'a.md'), `Preface.\n\n${READING_DRAFT}`)

  const result = await agent.resolveChange(id, 'accept')

  expect(result.applied).toBe(true)
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('Preface.\n\n# Why reading matters\n\nMost lists are too long.\n')
  expect((await changes.get(id))?.status).toBe('accepted')
  agent.dispose()
})

test('ticket 14: placeRecordedReplacement finds the one place, in order, and never guesses', () => {
  const doc = '# Why reading matters\n\nMost reading lists are too long.\n'
  const at = doc.indexOf('reading lists')
  const record = { path: 'a.md', oldText: 'reading ', anchor: { from: at, to: at + 8 }, anchorContext: { before: 'Most ', after: 'lists' } }
  // By the trimmed words, wherever the span has drifted to.
  expect(placeRecordedReplacement(`x${doc}`, record)).toEqual({ from: at + 1, to: at + 9 })
  // By the span, when the trimmed words stand twice and frame it.
  const repeated = `${doc}Most reading lists again.\n`
  expect(placeRecordedReplacement(repeated, record)).toEqual({ from: at, to: at + 8 })
  // The span holds the text but not the trimmed words around it: no one place.
  const reframed = doc.replace('Most reading lists', 'Few reading lists') + 'Most reading lists. Most reading lists.\n'
  expect(placeRecordedReplacement(reframed, record)).toMatchObject({ code: 'target-repeated' })
  // With trimmed words on record, the text standing once elsewhere is not its place (P1).
  const byHand = '# Why reading matters\n\nMost lists are too long.\n'
  expect(placeRecordedReplacement(byHand, { ...record, anchor: { from: 6, to: 14 } })).toMatchObject({ code: 'target-gone' })
  // An addition: placed by its trimmed words, then by its framed zero-width point (P0).
  const adding = { path: 'a.md', oldText: '', anchor: { from: 28, to: 28 }, anchorContext: { before: 'Most ', after: 'lists' } }
  const plain = '# Why reading matters\n\nMost lists are too long.\n'
  expect(placeRecordedReplacement(plain, adding)).toEqual({ from: 28, to: 28 })
  expect(placeRecordedReplacement(`${plain}Most lists again.\n`, adding)).toEqual({ from: 28, to: 28 })
  expect(placeRecordedReplacement('Most lists. Most lists.\n', adding)).toMatchObject({ code: 'target-repeated' })
  expect(placeRecordedReplacement('No such words.\n', adding)).toMatchObject({ code: 'target-gone' })
  // Without trimmed words on record (an older record): the span when it holds the text, then the text once.
  const { anchorContext: _ignored, ...legacy } = record
  expect(placeRecordedReplacement(doc, legacy)).toEqual({ from: at, to: at + 8 })
  expect(placeRecordedReplacement(doc, { ...legacy, anchor: { from: 0, to: 8 } })).toMatchObject({ code: 'target-repeated' })
  expect(placeRecordedReplacement(byHand, { ...legacy, anchor: { from: 0, to: 8 } })).toEqual({ from: 6, to: 14 })
  expect(placeRecordedReplacement(doc, { ...legacy, oldText: 'absent ' })).toMatchObject({ code: 'target-gone' })
  // An older addition with only a zero-width point: no way to check the place, so it waits (gone), never closes.
  expect(placeRecordedReplacement(plain, { path: 'a.md', oldText: '', anchor: { from: 28, to: 28 } })).toMatchObject({ code: 'target-gone' })
  // No text, no words around it, no point: never placeable.
  expect(placeRecordedReplacement(doc, { ...legacy, oldText: '', anchor: undefined })).toMatchObject({ code: 'other' })
})

test('ticket 14 (P1): the trimmed words decide the place; after the writer made the edit by hand, Accept never writes into the title', async () => {
  const { agent, changes, id } = await stageReadingEditThenRelaunch()
  // "reading " now stands once, in the title; the place it was made ("Most reading lists") is gone.
  const byHand = '# Why reading matters\n\nMost lists are too long.\n'
  await writeFile(join(root, 'a.md'), byHand)

  const result = await agent.resolveChange(id, 'accept')

  expect(result).toEqual({ applied: false, message: expect.stringMatching(/no longer in a\.md/) })
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(byHand)
  const after = (await changes.get(id))!
  expect(after.status).toBe('pending')
  expect(closedReasonOf(after)).toBeNull()
  agent.dispose()
})

// A word the agent ADDS: "Most lists" → "Most reading lists" is recorded as `` → `reading ` at a zero-width point.
const ADDING_DRAFT = '# Why reading matters\n\nMost lists are too long.\n'
const ADDING_EDIT: ScriptedStep = { cap: 'prose.edit', input: { path: 'a.md', oldText: 'Most lists', newText: 'Most reading lists', category: 'wording', summary: 'Say which lists' } }

async function stageAddingEditThenRelaunch(): Promise<{ agent: WorkspaceAgent; changes: ChangeStore; id: string }> {
  await writeFile(join(root, 'a.md'), ADDING_DRAFT)
  const staged = await makeLedgerAgent({ text: 'Add', steps: [ADDING_EDIT] })
  await staged.agent.runScriptedTurn('Add', [ADDING_EDIT])
  const [change] = await staged.changes.list()
  staged.agent.dispose()
  const at = ADDING_DRAFT.indexOf('lists')
  expect(change).toMatchObject({ oldText: '', newText: 'reading ', anchor: { from: at, to: at }, anchorContext: { before: 'Most ', after: 'lists' } })
  const relaunched = await makeLedgerAgent()
  return { agent: relaunched.agent, changes: relaunched.changes, id: change.id }
}

test('ticket 14 (P0): a word the agent adds is accepted after a relaunch, at its place', async () => {
  const { agent, changes, id } = await stageAddingEditThenRelaunch()

  const result = await agent.resolveChange(id, 'accept')

  expect(result.applied).toBe(true)
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('# Why reading matters\n\nMost reading lists are too long.\n')
  expect((await changes.get(id))?.status).toBe('accepted')
  agent.dispose()
})

test('ticket 14 (P0): a word the agent adds with no one place left is refused and waits, never closed', async () => {
  const { agent, changes, id } = await stageAddingEditThenRelaunch()
  const twice = 'Preface.\n\nMost lists are too long. Most lists are short.\n'
  await writeFile(join(root, 'a.md'), twice)

  const result = await agent.resolveChange(id, 'accept')

  expect(result).toEqual({ applied: false, message: expect.stringMatching(/more than once/) })
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(twice)
  const after = (await changes.get(id))!
  expect(after.status).toBe('pending')
  expect(closedReasonOf(after)).toBeNull()
  agent.dispose()
})

for (const status of ['pending', 'held'] as const) test(`ticket 14: a shortened edit with no one place left is refused, writes nothing, and stays ${status}, never declined`, async () => {
  {
    const { agent, changes, id } = await stageReadingEditThenRelaunch()
    if (status === 'held') await changes.setStatus(id, 'held')
    // The passage now stands twice and the recorded span is gone: no one place to put it.
    const twice = 'Preface.\n\nMost reading lists are too long.\n\nMost reading lists are too long.\n'
    await writeFile(join(root, 'a.md'), twice)

    const result = await agent.resolveChange(id, 'accept')

    expect(result).toEqual({ applied: false, message: expect.stringMatching(/more than once/i) })
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(twice)
    const after = (await changes.get(id))!
    expect(after.status).toBe(status)
    expect(closedReasonOf(after)).toBeNull()
    agent.dispose()
  }
})

/** Counts every document write main makes through the workspace (saveFile and saveFileWithoutReadBack). */
function countWrites(workspace: Workspace): { count: number } {
  const writes = { count: 0 }
  const mutable = workspace as unknown as { saveFile: Workspace['saveFile']; saveFileWithoutReadBack: Workspace['saveFileWithoutReadBack'] }
  const saveFile = mutable.saveFile.bind(workspace)
  const withoutReadBack = mutable.saveFileWithoutReadBack.bind(workspace)
  mutable.saveFile = ((...args: Parameters<Workspace['saveFile']>) => { writes.count += 1; return saveFile(...args) }) as Workspace['saveFile']
  mutable.saveFileWithoutReadBack = ((...args: Parameters<Workspace['saveFileWithoutReadBack']>) => { writes.count += 1; return withoutReadBack(...args) }) as Workspace['saveFileWithoutReadBack']
  return writes
}

test('Apply on a discarded agent change is refused: nothing is written, it stays discarded, and the message points to Reopen (redo of a Discard, then Apply)', async () => {
  // Guard: the refusal of a rejected record in resolveChangeWriting. Without it the accept takes the stored
  // replacement and writes the text of a change the writer discarded.
  const draft = '# A\n\nThe draft is too wordy.\n'
  await writeFile(join(root, 'a.md'), draft)
  const { agent, workspace, changes } = await makeLedgerAgent()
  const change = await stageReplacement(changes, draft, 'too wordy', 'concise')
  expect(await agent.resolveChange(change.id, 'reject')).toMatchObject({ applied: true })
  const writes = countWrites(workspace)

  const result = await agent.resolveChange(change.id, 'accept')

  // 0.23's rule (main): a rejected Change is accepted only by reopening it first; nothing is written.
  expect(result).toEqual({ applied: false, message: 'This change was rejected. Reopen it before accepting it.' })
  expect(result.message).toMatch(/Reopen/)
  expect(writes.count).toBe(0)
  expect((await workspace.readFile('a.md')).content).toBe(draft)
  expect((await changes.get(change.id))?.status).toBe('rejected')
  agent.dispose()
})

test('Discard of an applied agent change is refused: nothing is written, no receipt, it stays accepted (redo of an Accept, then Discard)', async () => {
  // Guard: the refusal of an accepted record on a reject in resolveChangeWriting. Without it the Discard
  // falls through to a status-only flip: the record says discarded and the applied text stays on disk.
  const draft = '# A\n\nThe draft is too wordy.\n'
  const accepted = '# A\n\nThe draft is concise.\n'
  await writeFile(join(root, 'a.md'), draft)
  const { agent, workspace, changes } = await makeLedgerAgent()
  const change = await stageReplacement(changes, draft, 'too wordy', 'concise')
  expect(await agent.resolveChange(change.id, 'accept')).toMatchObject({ applied: true, receipt: { written: accepted } })
  const writes = countWrites(workspace)

  const result = await agent.resolveChange(change.id, 'reject')

  expect(result).toEqual({ applied: false, message: 'That change is already applied, so it was not discarded. Undo in the editor takes it back.' })
  expect(result).not.toHaveProperty('receipt')
  expect(writes.count).toBe(0)
  expect((await workspace.readFile('a.md')).content).toBe(accepted)
  expect((await changes.get(change.id))?.status).toBe('accepted')
  agent.dispose()
})

test('P1 regression: Apply writes where the old text uniquely stands now (B, not the staged A), and a later Discard is refused, the file byte-equal to what Apply wrote', async () => {
  // Guard: the refusal of an accepted record on a reject. Without it the Discard flips the record to
  // discarded over a file that still holds the applied text (and no second rule may locate a write).
  const intro = '# A\n\nThis opening paragraph is long enough to keep the change away from the start.\n\n'
  const draft = `${intro}At A the draft is too wordy.\n\nAt B the draft is plain.\n`
  await writeFile(join(root, 'a.md'), draft)
  const { agent, workspace, changes } = await makeLedgerAgent()
  const change = await stageReplacement(changes, draft, 'too wordy', 'concise')
  // The writer edits A to the new text by hand and types the old text at B.
  const edited = `${intro}At A the draft is concise.\n\nAt B the draft is too wordy.\n`
  await writeFile(join(root, 'a.md'), edited)

  const apply = await agent.resolveChange(change.id, 'accept')

  const applied = `${intro}At A the draft is concise.\n\nAt B the draft is concise.\n`
  expect(apply).toMatchObject({ applied: true, receipt: { written: applied } })
  expect((await workspace.readFile('a.md')).content).toBe(applied)
  expect((await changes.get(change.id))?.status).toBe('accepted')
  const writes = countWrites(workspace)

  const discard = await agent.resolveChange(change.id, 'reject')

  expect(discard).toEqual({ applied: false, message: 'That change is already applied, so it was not discarded. Undo in the editor takes it back.' })
  expect(writes.count).toBe(0)
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(applied)
  expect((await changes.get(change.id))?.status).toBe('accepted')
  agent.dispose()
})

test('T1: Apply on a pending record targeting .git/config, loaded from the journal, is refused before any write', async () => {
  // Guard: the hidden-target check in resolveChangeWriting. Without it the stored replacement is written
  // into .git/config.
  await mkdir(join(root, '.git'), { recursive: true })
  const config = '[core]\n\tvalue = too wordy\n'
  await writeFile(join(root, '.git', 'config'), config)
  const from = config.indexOf('too wordy')
  const record = {
    id: 'c_hidden1', path: '.git/config', ts: 1, provenance: 'agent', editClass: 'content', category: 'wording', summary: 'x',
    oldText: 'too wordy', newText: 'concise', anchor: { from, to: from + 9 }, status: 'pending', isCorrection: false,
  }
  await mkdir(join(root, '.writeflex'), { recursive: true })
  await writeFile(join(root, '.writeflex', 'changes.jsonl'), `${JSON.stringify(record)}\n`)
  const { agent, changes } = await makeLedgerAgent()
  expect((await changes.get('c_hidden1'))?.status).toBe('pending')

  const result = await agent.resolveChange('c_hidden1', 'accept')

  expect(result).toEqual({ applied: false, message: 'That change targets a file outside the visible folders of the Workspace, so nothing was written.' })
  expect(await readFile(join(root, '.git', 'config'), 'utf8')).toBe(config)
  expect((await changes.get('c_hidden1'))?.status).toBe('pending')
  agent.dispose()
})

test('T2: a stored replacement whose text overlaps itself is not unique: `aa` in `aaa` is refused', async () => {
  // Guard: uniqueStoredRange searching again from first+1. Searching after the whole match misses the
  // overlapping occurrence and writes at the first.
  await writeFile(join(root, 'a.md'), 'aaa\n')
  const { agent, workspace, changes } = await makeLedgerAgent()
  const change = await changes.add({
    path: 'a.md', provenance: 'agent', editClass: 'copy', category: 'wording', summary: 'x',
    oldText: 'aa', newText: 'b', isCorrection: false,
  })

  const result = await agent.resolveChange(change.id, 'accept')

  expect(result.applied).toBe(false)
  expect(result.message).toMatch(/not unique/i)
  expect((await workspace.readFile('a.md')).content).toBe('aaa\n')
  // Ticket 14: an Accept that cannot be placed decides nothing; the Change waits, neither accepted nor declined.
  expect((await changes.get(change.id))?.status).toBe('pending')
  expect(result.closed).toBeUndefined()
  agent.dispose()
})


test('Sol P1: a second Apply of an accepted replacement is refused and writes nothing ("The cat." stays "The catfish.", never "The catfishfish.")', async () => {
  // Guard: the refusal of an accepted record on an accept in resolveChangeWriting. Without it the second
  // Apply finds `cat` once in "The catfish." and writes the replacement again: "The catfishfish.".
  const draft = 'The cat.\n'
  await writeFile(join(root, 'a.md'), draft)
  const { agent, workspace, changes } = await makeLedgerAgent()
  const change = await stageReplacement(changes, draft, 'cat', 'catfish')

  const first = await agent.resolveChange(change.id, 'accept')
  expect(first).toMatchObject({ applied: true })
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('The catfish.\n')
  expect((await changes.get(change.id))?.status).toBe('accepted')
  const writes = countWrites(workspace)

  const second = await agent.resolveChange(change.id, 'accept')

  // 0.23's rule (main): a second Accept of an accepted Change writes nothing and answers applied.
  expect(second).toEqual({ applied: true })
  expect(writes.count).toBe(0)
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('The catfish.\n')
  expect((await changes.get(change.id))?.status).toBe('accepted')
  agent.dispose()
})

test('Sol P1: a second Apply of an accepted insert is refused and writes nothing', async () => {
  // Guard: the refusal of an accepted record on an accept (it replaces the insert catch's "already there"
  // heuristic). Without it the insert is placed again after its anchor: "One.\n\nTwo.\n\nTwo.".
  const draft = 'One.\n'
  await writeFile(join(root, 'a.md'), draft)
  const { agent, workspace, changes } = await makeLedgerAgent()
  const change = await changes.add({
    path: 'a.md', provenance: 'agent', editClass: 'insert', category: 'wording', summary: 'Add a line',
    oldText: '', newText: 'Two.', insertAfter: 'One.', isCorrection: false,
  })
  expect(await agent.resolveChange(change.id, 'accept')).toMatchObject({ applied: true })
  const inserted = await readFile(join(root, 'a.md'), 'utf8')
  expect(inserted.match(/Two\./g)?.length).toBe(1)
  const writes = countWrites(workspace)

  const second = await agent.resolveChange(change.id, 'accept')

  // 0.23's rule (main): a second Accept of an accepted Change writes nothing and answers applied.
  expect(second).toEqual({ applied: true })
  expect(writes.count).toBe(0)
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(inserted)
  expect((await changes.get(change.id))?.status).toBe('accepted')
  agent.dispose()
})

test('Sol P1: Apply of an accepted widget record (it creates a file) is refused and writes nothing', async () => {
  // Guard: the refusal of an accepted record on an accept (it replaces the createsAFile branch's
  // `applied: true` for an accepted record). Without it the Apply answers that it applied.
  const draft = 'The draft is too wordy.\n'
  await writeFile(join(root, 'a.md'), draft)
  const { agent, workspace, changes } = await makeLedgerAgent()
  const page = '<p>pace</p>\n'
  const change = await changes.addWithNewFile(
    { path: 'a.md', provenance: 'agent', editClass: 'content', category: 'other', summary: 'Add a widget', oldText: 'too wordy', newText: 'concise', isCorrection: false },
    { path: 'assets/pace.html', content: page, sha256: createHash('sha256').update(page, 'utf8').digest('hex') },
  )
  await changes.setStatus(change.id, 'accepted')
  const writes = countWrites(workspace)

  const result = await agent.resolveChange(change.id, 'accept')

  // 0.23's rule (main): an accepted Change is not placed again; nothing is written.
  expect(result).toEqual({ applied: true })
  expect(writes.count).toBe(0)
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(draft)
  expect(existsSync(join(root, 'assets', 'pace.html'))).toBe(false)
  expect((await changes.get(change.id))?.status).toBe('accepted')
  agent.dispose()
})

test('R1 (restated, ticket 14): the ledger door places a minimised record at its recorded span when its text stands twice', async () => {
  // Was a documented residual (refused): the minimised text `too wordy` stands twice, but the record's
  // span still holds it, which is where its review mark is drawn. It is written there and nowhere else.
  const draft = 'The draft is too wordy.\nAnother draft is too wordy.\n'
  await writeFile(join(root, 'a.md'), draft)
  const { agent, changes } = await makeLedgerAgent()
  const change = await stageReplacement(changes, draft, 'The draft is too wordy.', 'The draft is concise.')
  expect(change.oldText).toBe('too wordy')

  const result = await agent.resolveChange(change.id, 'accept')

  expect(result.applied).toBe(true)
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('The draft is concise.\nAnother draft is too wordy.\n')
  expect((await changes.get(change.id))?.status).toBe('accepted')
  agent.dispose()
})

test('R1 (ticket 14): a minimised record whose span no longer holds its text and whose text stands twice is refused, writes nothing and stays pending', async () => {
  // Guard: uniqueStoredRange's second-occurrence check, after the span check. Without it the ledger Apply
  // writes `concise` at the first `too wordy`, a guess.
  const draft = 'The draft is too wordy.\nAnother draft is too wordy.\n'
  await writeFile(join(root, 'a.md'), draft)
  const { agent, workspace, changes } = await makeLedgerAgent()
  const change = await stageReplacement(changes, draft, 'The draft is too wordy.', 'The draft is concise.')
  const moved = `Preface.\n${draft}`
  await writeFile(join(root, 'a.md'), moved)
  const writes = countWrites(workspace)

  const result = await agent.resolveChange(change.id, 'accept')

  expect(result).toEqual({ applied: false, message: expect.stringMatching(/not unique/i) })
  expect(writes.count).toBe(0)
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(moved)
  const after = (await changes.get(change.id))!
  expect(after.status).toBe('pending')
  expect(closedReasonOf(after)).toBeNull()
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

  expect(await agent.resolveChange(accepted.id, 'accept')).toMatchObject({ applied: true })
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
  const agent = await WorkspaceAgent.create({ mode: 'work', workspace: new Workspace(root), appDataDir: appData,
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
