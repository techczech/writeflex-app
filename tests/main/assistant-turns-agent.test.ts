import { VersionStore } from '../../src/main/versions'
import { expect, test, spyOn } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, buildE2EScriptedTurn, mapSessionMessages, type ScriptedStep } from '../../src/main/agent'
import { Workspace } from '../../src/main/workspace'
import { SkillsRegistry } from '../../src/main/skills'
import { ThreadIndex, ThreadManager } from '../../src/main/threads'
import { SettingsStore } from '../../src/main/settings'
import { ASSISTANT_MODE_KEY, assistantMode, refusalMessage } from '../../src/shared/assistant-turns'
import { pauseCollectionWrites, resumeCollectionWrites } from '../../src/main/collection-write-gate'

async function withAgent(run: (agent: WorkspaceAgent, root: string, create: (path: string) => Promise<void>, events: string[], queue: ReturnType<typeof buildE2EScriptedTurn>[]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'wf-assistant-turns-'))
  const data = await mkdtemp(join(tmpdir(), 'wf-assistant-data-'))
  const queue: ReturnType<typeof buildE2EScriptedTurn>[] = []
  const events: string[] = []
  const agent = await WorkspaceAgent.create({ mode: 'work', workspace: new Workspace(root), appDataDir: data, sessionFactory: scriptedSessionFactory(queue), onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {}, onTurnActivity: (turn) => events.push(turn.turnId) })
  const create = async (path: string) => {
    const steps: ScriptedStep[] = [{ cap: 'housekeeping.create_file', input: { path, content: '# Created\n' } }]
    queue.push(buildE2EScriptedTurn(steps)); await agent.runScriptedTurn('Create ' + path, steps)
  }
  try { await run(agent, root, create, events, queue) }
  finally { resumeCollectionWrites(root); await agent.dispose(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) }
}

for (const mode of ['work', 'suggest', 'read-only'] as const) test(`the ${mode} mode reaches Bridle and governs a scripted file create`, async () => {
  await withAgent(async (agent, root, create, events) => {
    agent.setMode(mode)
    await create('created.md')
    const state = await agent.turnState()
    expect(state.turns).toHaveLength(1)
    expect(state.turns[0].mode).toBe(mode)
    expect(existsSync(join(root, 'created.md'))).toBe(mode === 'work')
    expect((await agent.suggestions()).length).toBe(mode === 'suggest' ? 1 : 0)
    expect(events).toContain(state.turns[0].turnId)
    expect(await agent.getTurn(state.turns[0].turnId)).toEqual(state.turns[0])
  })
})

test('turn undo refuses later writes, then explicitly undoes the whole chain', async () => {
  await withAgent(async (agent, root, create) => {
    await create('one.md'); await create('two.md')
    const [latest, first] = (await agent.turnState()).turns
    expect((await agent.undoTurn(first.turnId))).toMatchObject({ undone: false, reason: 'later-turns-exist' })
    expect(existsSync(join(root, 'one.md'))).toBe(true)
    expect(existsSync(join(root, 'two.md'))).toBe(true)
    const result = await agent.undoTurn(first.turnId, true)
    expect(result).toMatchObject({ undone: true, turnIds: [latest.turnId, first.turnId] })
    expect(existsSync(join(root, 'one.md'))).toBe(false)
    expect(existsSync(join(root, 'two.md'))).toBe(false)
  })
})

test('a changed-file refusal names the path and preserves later text; legacy undo uses the same guard', async () => {
  await withAgent(async (agent, root, create) => {
    await create('one.md')
    await writeFile(join(root, 'one.md'), '# My later changes\n')
    const [turn] = (await agent.turnState()).turns
    const result = await agent.undoTurn(turn.turnId)
    expect(result).toMatchObject({ undone: false, reason: 'changed-after-turn', paths: ['one.md'] })
    if (!result.undone) expect(refusalMessage(result)).toContain('changed after this turn')
    await expect(agent.restoreLastTurn()).rejects.toThrow('one.md')
    expect(await readFile(join(root, 'one.md'), 'utf8')).toBe('# My later changes\n')
  })
})

test('the existing undo path removes only the latest turn and honours the Collection write gate', async () => {
  await withAgent(async (agent, root, create) => {
    await create('one.md'); await create('two.md')
    pauseCollectionWrites(root, 'Another writer owns this Collection.')
    const [turn] = (await agent.turnState()).turns
    const refusal = await agent.undoTurn(turn.turnId)
    expect(refusal).toMatchObject({ undone: false, reason: 'writes-paused' })
    if (!refusal.undone) expect(refusalMessage(refusal)).toBe('Another writer owns this Collection.')
    await expect(agent.restoreLastTurn()).rejects.toThrow('Another writer owns this Collection.')
    expect(existsSync(join(root, 'two.md'))).toBe(true)
    resumeCollectionWrites(root)
    await agent.restoreLastTurn()
    expect(existsSync(join(root, 'two.md'))).toBe(false)
    expect(existsSync(join(root, 'one.md'))).toBe(true)
  })
})


test('restored tool receipts hide discovery by tool name, preserving real tool output verbatim', () => {
  const messages = mapSessionMessages([
    { role: 'toolResult', toolName: 'tools.search', content: 'Internal catalogue search' },
    { role: 'toolResult', toolName: 'tools.enable', content: 'Internal catalogue enable' },
    { role: 'toolResult', toolName: 'tools_search', content: 'Internal wire search' },
    { role: 'tool', toolName: 'tools_enable', content: 'Internal wire enable' },
    { role: 'toolResult', toolName: 'tools.search_documents', content: 'Search result' },
    { role: 'toolResult', toolName: 'files.read', content: 'tools.enable is mentioned in the document' },
  ])
  expect(messages.map(message => message.content)).toEqual(['Search result', 'tools.enable is mentioned in the document'])
})


test('fresh agents and non-panel prompts enforce the current setting and fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-mode-root-'))
  const data = await mkdtemp(join(tmpdir(), 'wf-mode-data-'))
  const settingsPath = join(data, 'settings.json')
  const steps = [{ cap: 'housekeeping.create_file', input: { path: 'refused.md', content: '# Refused' } }]
  const queue = [buildE2EScriptedTurn(steps)]
  const settings = new SettingsStore(settingsPath)
  settings.set(ASSISTANT_MODE_KEY, 'read-only', 'Assistant mode')
  const agent = await WorkspaceAgent.create({
    workspace: new Workspace(root), appDataDir: data,
    getMode: () => settings.get(ASSISTANT_MODE_KEY),
    subscribeMode: (update) => settings.onChange((key) => { if (key === ASSISTANT_MODE_KEY) update() }),
    sessionFactory: scriptedSessionFactory(queue), onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
  })
  try {
    expect(agent.mode()).toBe('read-only')
    // ThreadManager's background skill and skill-edit paths call prompt directly, bypassing agent:prompt.
    await agent.prompt('Create refused.md')
    expect(existsSync(join(root, 'refused.md'))).toBe(false)
    expect((await agent.turnState()).turns[0].mode).toBe('read-only')
    settings.set(ASSISTANT_MODE_KEY, 'work', 'Assistant mode')
    expect(agent.mode()).toBe('work')
    settings.set(ASSISTANT_MODE_KEY, 'broken', 'Assistant mode')
    expect(agent.mode()).toBe('read-only')
    queue.push(buildE2EScriptedTurn(steps))
    await agent.prompt('Create refused.md again')
    expect(existsSync(join(root, 'refused.md'))).toBe(false)
    settings.revert(0)
    expect(agent.mode()).toBe('work')
  } finally { await agent.dispose(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) }
})

test('missing mode keys default to Work while present invalid values and unreadable settings fail closed', async () => {
  for (const invalid of [null, undefined, '', 'invalid', false, {}, 0]) expect(assistantMode(invalid)).toBe('read-only')
  expect(assistantMode('work')).toBe('work')
  const data = await mkdtemp(join(tmpdir(), 'wf-mode-settings-'))
  const path = join(data, 'settings.json')
  try {
    expect(new SettingsStore(path).get(ASSISTANT_MODE_KEY)).toBe('work')
    await writeFile(path, '{}')
    expect(new SettingsStore(path).get(ASSISTANT_MODE_KEY)).toBe('work')
    for (const raw of ['{', '{"values":{"agent.mode":{}}}', '{"values":{"agent.mode":"invalid"}}']) {
      await writeFile(path, raw)
      expect(assistantMode(new SettingsStore(path).get(ASSISTANT_MODE_KEY))).toBe('read-only')
    }
  } finally { await rm(data, { recursive: true, force: true }) }
})


test('the non-panel skill-edit throwaway refuses a write in Read only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-mode-skill-'))
  const data = await mkdtemp(join(tmpdir(), 'wf-mode-skill-data-'))
  const bundledSkillsDir = join(data, 'bundled')
  await mkdir(join(bundledSkillsDir, 'copy-edit'), { recursive: true })
  const skill = '---\nname: copy-edit\ndescription: Copy edit.\ntools: [files.read]\ninput: document\n---\nKeep the prose.\n'
  await writeFile(join(bundledSkillsDir, 'copy-edit', 'SKILL.md'), skill)
  const skills = new SkillsRegistry({ appDataDir: data, bundledSkillsDir })
  await skills.init()
  let observedMode: string | undefined
  const manager = new ThreadManager({
    userDataDir: data, workspaceRoot: root,
    index: new ThreadIndex(join(data, 'threads', 'index.json')), skills,
    machineInstructionsPath: join(data, 'absent.md'),
    createAgent: async ({ appDataDir, composition }) => {
      const script = buildE2EScriptedTurn([{ cap: 'housekeeping.create_file', input: { path: 'unsafe.md', content: 'unsafe' } }], '```markdown\n' + skill + '```')
      const agent = await WorkspaceAgent.create({
        workspace: new Workspace(root), appDataDir, composition, getMode: () => 'read-only',
        sessionFactory: scriptedSessionFactory([script]),
        onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
        onTurnActivity: (turn) => { observedMode = turn.mode },
      })
      expect(agent.mode()).toBe('read-only')
      return agent
    },
    onActiveChanged: () => {},
  })
  try {
    expect((await manager.proposeSkillEdit('copy-edit', 'Tighten it')).proposed).toBe(skill)
    expect(observedMode).toBe('read-only')
    expect(existsSync(join(root, 'unsafe.md'))).toBe(false)
  } finally { await manager.disposeAll(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) }
})

test('a missing getter fails closed and a live getter is reread even without notifications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-mode-getter-'))
  const data = await mkdtemp(join(tmpdir(), 'wf-mode-getter-data-'))
  let value: unknown = 'work'
  let unreadable = false
  const steps = [{ cap: 'housekeeping.create_file', input: { path: 'unsafe.md', content: 'unsafe' } }]
  const queue = Array.from({ length: 3 }, () => buildE2EScriptedTurn(steps))
  const create = (getMode?: () => unknown) => WorkspaceAgent.create({
    workspace: new Workspace(root), appDataDir: data, getMode,
    sessionFactory: scriptedSessionFactory(queue), onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
  })
  let agent = await create()
  try {
    expect(agent.mode()).toBe('read-only')
    await agent.prompt('Create unsafe.md')
    expect(existsSync(join(root, 'unsafe.md'))).toBe(false)
    await agent.dispose()
    agent = await create(() => { if (unreadable) throw new Error('Unreadable mode'); return value })
    expect(agent.mode()).toBe('work')
    value = 'read-only'
    await agent.prompt('Create unsafe.md')
    expect((await agent.turnState()).turns[0].mode).toBe('read-only')
    unreadable = true
    await agent.prompt('Create unsafe.md')
    expect((await agent.turnState()).turns[0].mode).toBe('read-only')
    expect(existsSync(join(root, 'unsafe.md'))).toBe(false)
  } finally { await agent.dispose(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) }
})


test('legacy restore skips a newer question-only turn', async () => {
  await withAgent(async (agent, root, create) => {
    await create('one.md')
    const bridle = (agent as unknown as { bridle: import('@bridle/core').Bridle }).bridle
    const [written] = await bridle.turns.list()
    const original = bridle.turns.list
    bridle.turns.list = async () => [{ ...written, turnId: 'question', startedAt: Date.now() + 1, counts: { read: 1, created: 0, modified: 0, moved: 0, trashed: 0, deleted: 0 } }, written]
    try { await agent.restoreLastTurn(); expect(existsSync(join(root, 'one.md'))).toBe(false) }
    finally { bridle.turns.list = original }
  })
})

test('selected-step open paths are checked against files still inside the folder', async () => {
  await withAgent(async (agent, root, create) => {
    await create('one.md')
    const [turn] = (await agent.turnState()).turns
    expect(turn.openPaths).toEqual(['one.md'])
    await rm(join(root, 'one.md'))
    expect((await agent.getTurn(turn.turnId))?.openPaths).toEqual([])
  })
})

test('mode refresh avoids duplicate audit writes and contains a stale disposed listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-mode-listener-'))
  const data = await mkdtemp(join(tmpdir(), 'wf-mode-listener-data-'))
  const settings = new SettingsStore(join(data, 'settings.json'))
  const agent = await WorkspaceAgent.create({ workspace: new Workspace(root), appDataDir: data,
    getMode: () => settings.get(ASSISTANT_MODE_KEY),
    subscribeMode: update => settings.onChange(key => { if (key === ASSISTANT_MODE_KEY) update() }),
    sessionFactory: scriptedSessionFactory([]), onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
  })
  const bridle = (agent as unknown as { bridle: import('@bridle/core').Bridle }).bridle
  const setMode = spyOn(bridle, 'setMode')
  const refresh = () => (agent as unknown as { refreshMode(): void }).refreshMode()
  try {
    refresh(); refresh()
    expect(setMode).not.toHaveBeenCalled()
    settings.set(ASSISTANT_MODE_KEY, 'suggest', 'Assistant mode')
    expect(setMode).toHaveBeenCalledTimes(1)
    // Bridle was disposed without WorkspaceAgent.dispose removing its settings listener.
    await bridle.dispose()
    expect(() => settings.set(ASSISTANT_MODE_KEY, 'work', 'Assistant mode')).not.toThrow()
  } finally { setMode.mockRestore(); await agent.dispose(); await rm(root, { recursive: true, force: true }); await rm(data, { recursive: true, force: true }) }
})


test('agent rename and turn Undo restore the version history to the original path', async () => {
  await withAgent(async (agent, root, _create, _events, queue) => {
    await writeFile(join(root, 'old.md'), '# Before move\n')
    const versions = new VersionStore(new Workspace(root))
    const first = await versions.append({ path: 'old.md', name: 'Before', author: { name: 'Writer' } })
    const steps: ScriptedStep[] = [{ cap: 'housekeeping.rename_file', input: { path: 'old.md', newPath: 'new.md' } }]
    queue.push(buildE2EScriptedTurn(steps))
    await agent.runScriptedTurn('Rename the file', steps)
    expect((await versions.list({ path: 'new.md' }))[0].id).toBe(first.id)
    const turn = (await agent.turnState()).turns[0]
    expect((await agent.undoTurn(turn.turnId)).undone).toBe(true)
    expect((await versions.list({ path: 'old.md' }))[0].id).toBe(first.id)
    expect(await versions.list({ path: 'new.md' })).toEqual([])
  })
})


test('Undo including later agent renames takes a chain and its versions back exactly', async () => {
  await withAgent(async (agent, root, _create, _events, queue) => {
    await writeFile(join(root, 'a.md'), '# Original\n')
    const versions = new VersionStore(new Workspace(root))
    const first = await versions.append({ path: 'a.md', name: 'Before', author: { name: 'Writer' } })
    const detached = await versions.append({ path: 'b.md', name: 'Previously detached', author: { name: 'Writer' } })
    for (const [path, newPath] of [['a.md', 'b.md'], ['b.md', 'c.md']]) {
      const steps: ScriptedStep[] = [{ cap: 'housekeeping.rename_file', input: { path, newPath } }]
      queue.push(buildE2EScriptedTurn(steps))
      await agent.runScriptedTurn('Rename', steps)
    }
    const turns = (await agent.turnState()).turns
    expect((await agent.undoTurn(turns[1].turnId, true)).undone).toBe(true)
    expect((await versions.list({ path: 'a.md' }))[0].id).toBe(first.id)
    expect((await versions.list({ path: 'b.md' }))[0].id).toBe(detached.id)
    expect(await versions.list({ path: 'c.md' })).toEqual([])
  })
})
