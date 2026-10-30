import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { Workspace } from '../../src/main/workspace'
import { attachTurnExecutions, buildE2EScriptedTurn, WorkspaceAgent, type ModelChoice, type ScriptedTurn, type ThinkingLevel } from '../../src/main/agent'
import { SkillsRegistry } from '../../src/main/skills'
import { ThreadIndex, ThreadManager, ThreadSkillGoneError, skillDisplayName, type RunCompletePayload } from '../../src/main/threads'

/**
 * B1 (ADR-0027): the threads layer — per-thread skill-bound instances, run-as-is as "a thread with
 * nothing said", persistence/restore, and the guard states from the B1 spec's matrix. Agents ride
 * the scripted session factory; bridle's own factory-honesty check (S8) is the structural proof that
 * a skill thread's session registered exactly the skill's scope.
 */

let root: string
let userData: string
let bundled: string

const SKILL = (name: string, tools: string[], description = 'Does the thing, plainly.') => `---
name: ${name}
description: ${description}
tools: [${tools.join(', ')}]
input: document
trigger:
  label: Run on this document
  icon: pen-line
---

Do the work described by ${name}. Stage honestly.
`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-threads-root-'))
  userData = await mkdtemp(join(tmpdir(), 'wf-threads-data-'))
  bundled = await mkdtemp(join(tmpdir(), 'wf-threads-bundled-'))
  await writeFile(join(root, 'a.md'), '# A\n')
  await mkdir(join(bundled, 'copy-edit'), { recursive: true })
  await writeFile(join(bundled, 'copy-edit', 'SKILL.md'), SKILL('copy-edit', ['files.read', 'prose.edit']))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true })
  await rm(bundled, { recursive: true, force: true })
})

async function makeRegistry(): Promise<SkillsRegistry> {
  const registry = new SkillsRegistry({ appDataDir: userData, bundledSkillsDir: bundled })
  await registry.init()
  return registry
}

type Harness = {
  manager: ThreadManager
  queue: ScriptedTurn[]
  active: { agent: WorkspaceAgent | null }
  /** What ipc.ts's onActiveChanged repoints state.agentReady to — boot failures surface HERE. */
  ready: Promise<WorkspaceAgent> | null
  runs: RunCompletePayload[]
  /** Every prompt() the manager's agents received: [text, activeFile]. */
  promptCalls: Array<[string, string | null | undefined]>
  activeChanges: number
  bootDefaults: Array<{ provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel }>
  /** Every model switch applied to a live agent through the applyModel seam. */
  applied: Array<{ provider: string; id: string }>
}

async function makeManager(
  registry?: SkillsRegistry,
  options: {
    defaults?: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel }
    availableModels?: ModelChoice[]
    /** Bridle's list and its signed-in subset (production's listedModels seam). */
    listedModels?: { listed: Array<{ provider: string; id: string }>; available: Array<{ provider: string; id: string }> }
    /** Production's modelsReady seam: the startup discovery. */
    modelsReady?: Promise<unknown> | (() => Promise<unknown>)
    modelService?: Pick<import('@bridle/core').BridleModelService, 'recommendedModel' | 'resolveSavedModel'>
    switchInForceModel?: { provider: string; id: string }
  } = {},
): Promise<Harness> {
  const skills = registry ?? await makeRegistry()
  const queue: ScriptedTurn[] = []
  const harness: Harness = { manager: null as unknown as ThreadManager, queue, active: { agent: null }, ready: null, runs: [], promptCalls: [], activeChanges: 0, bootDefaults: [], applied: [] }
  harness.manager = new ThreadManager({
    userDataDir: userData,
    workspaceRoot: root,
    index: new ThreadIndex(join(userData, 'threads', 'index.json')),
    skills,
    defaults: () => ({ ...options.defaults }),
    modelService: options.modelService,
    ...(options.availableModels ? {
      isModelAvailable: (provider: string, modelId: string) => options.availableModels!.some((model) => model.provider === provider && model.id === modelId),
    } : {}),
    // Production always supplies Bridle's list; a test that names only `availableModels` gets the same
    // models as listed and runnable.
    ...(options.listedModels
      ? { listedModels: () => options.listedModels! }
      : options.availableModels
        ? { listedModels: () => ({ listed: options.availableModels!.map(({ provider, id }) => ({ provider, id })), available: options.availableModels!.map(({ provider, id }) => ({ provider, id })) }) }
        : {}),
    ...(options.modelsReady ? { modelsReady: typeof options.modelsReady === 'function' ? options.modelsReady : () => options.modelsReady as Promise<unknown> } : {}),
    applyModel: async (_agent, provider, modelId) => { harness.applied.push({ provider, id: modelId }) },
    currentModelAfterApply: (_agent, provider, modelId) => options.switchInForceModel ?? { provider, id: modelId },
    // No machine layer in tests: point at a path that never exists.
    machineInstructionsPath: join(userData, 'no-such-instructions.md'),
    createAgent: async ({ appDataDir, composition, defaults }) => {
      harness.bootDefaults.push({ ...defaults })
      const agent = await WorkspaceAgent.create({ mode: 'work',
        workspace: new Workspace(root),
        appDataDir,
        onTrace: () => {},
        onApprovalRequest: () => {},
        onSuggestionsChanged: () => {},
        sessionFactory: scriptedSessionFactory(queue),
        defaults,
        ...(composition ? { composition } : {}),
      })
      const prompt = agent.prompt.bind(agent)
      agent.prompt = (text, activeFile) => {
        harness.promptCalls.push([text, activeFile])
        return prompt(text, activeFile)
      }
      return agent
    },
    onActiveChanged: (agent, ready) => {
      harness.active.agent = agent
      harness.ready = ready
      ready?.catch(() => {}) // ipc.ts guards the same way
      harness.activeChanges += 1
    },
    onRunComplete: (payload) => { harness.runs.push(payload) },
  })
  return harness
}

// ---- ThreadIndex ---------------------------------------------------------------------------------

test('index round-trips records, filters by workspace and sorts by recency', async () => {
  const file = join(userData, 'threads', 'index.json')
  const index = new ThreadIndex(file)
  await index.add({ id: 't1', workspaceRoot: root, kind: 'chat', title: 'first', createdAt: 1, lastActiveAt: 1 })
  await index.add({ id: 't2', workspaceRoot: root, kind: 'skill', skillName: 'copy-edit', title: 'second', createdAt: 2, lastActiveAt: 2 })
  await index.add({ id: 'other', workspaceRoot: '/elsewhere', kind: 'chat', title: 'not ours', createdAt: 3, lastActiveAt: 3 })

  const fresh = new ThreadIndex(file)
  const { records, error } = await fresh.list(root)
  expect(error).toBeNull()
  expect(records.map((r) => r.id)).toEqual(['t2', 't1'])
})

test('a corrupt index starts empty and surfaces the error instead of crashing', async () => {
  const file = join(userData, 'threads', 'index.json')
  await mkdir(join(userData, 'threads'), { recursive: true })
  await writeFile(file, '{not json', 'utf8')
  const index = new ThreadIndex(file)
  const { records, error } = await index.list(root)
  expect(records).toEqual([])
  expect(error).toMatch(/thread index/i)
  // And it recovers: adds still work.
  await index.add({ id: 't1', workspaceRoot: root, kind: 'chat', title: 'x', createdAt: 1, lastActiveAt: 1 })
  expect((await index.list(root)).records).toHaveLength(1)
})

// ---- ThreadManager: bind, threads, compositions --------------------------------------------------

test('bind creates the first chat thread on its own isolated dir and activates it', async () => {
  const { manager, active } = await makeManager()
  await manager.bind()
  const { threads } = await manager.list()
  expect(threads).toHaveLength(1)
  expect(threads[0].kind).toBe('chat')
  expect(manager.activeThreadId()).toBe(threads[0].id)
  const agent = await manager.activeReady()
  expect(active.agent).not.toBeNull()
  // review finding B1 review P0: no thread may share userData itself as its data dir — the app-global
  // proposals journal and recorder would bleed across workspaces. Every thread dir is scoped.
  expect(existsSync(join(userData, 'threads', threads[0].id))).toBe(true)
  expect(existsSync(join(userData, 'sessions'))).toBe(false)
  expect(agent).not.toBeNull()
  await manager.disposeAll()
})

test('a chat overrides the Settings defaults, persists them through reload, and a new chat inherits the current defaults', async () => {
  const runnable = [
    { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' },
    { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
  ]
  const first = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'low' },
    availableModels: runnable,
  })
  await first.manager.bind()
  await first.manager.activeReady()
  await first.manager.setModel('openai-codex', 'gpt-5.4')
  await first.manager.setThinking('high')
  expect(first.manager.activeRecord()).toMatchObject({
    model: { provider: 'openai-codex', id: 'gpt-5.4' },
    thinkingLevel: 'high',
  })
  await first.manager.disposeAll()

  const reloaded = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'minimal' },
    availableModels: runnable,
  })
  await reloaded.manager.bind()
  await reloaded.manager.activeReady()
  expect(reloaded.manager.activeRecord()).toMatchObject({
    model: { provider: 'openai-codex', id: 'gpt-5.4' },
    thinkingLevel: 'high',
  })
  expect(reloaded.bootDefaults.at(-1)).toEqual({ provider: 'openai-codex', modelId: 'gpt-5.4', thinkingLevel: 'high' })

  const newChat = await reloaded.manager.newChat()
  expect(newChat.id).toBe(reloaded.manager.activeThreadId())
  expect(reloaded.manager.activeRecord()).toMatchObject({
    model: { provider: 'openai-codex', id: 'gpt-5.5' },
    thinkingLevel: 'minimal',
  })
  await reloaded.manager.disposeAll()
})

test('a legacy thread without model preferences inherits the current defaults', async () => {
  const index = new ThreadIndex(join(userData, 'threads', 'index.json'))
  await index.add({
    id: 'legacy-thread', workspaceRoot: root, kind: 'chat', title: 'Legacy', createdAt: 1, lastActiveAt: 1,
  })
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.6-sol', thinkingLevel: 'high' },
    availableModels: [{ provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
  })
  await harness.manager.bind()
  await harness.manager.activeReady()
  expect(harness.manager.activeRecord()).toMatchObject({
    model: { provider: 'openai-codex', id: 'gpt-5.6-sol' }, thinkingLevel: 'high',
  })
  await harness.manager.disposeAll()
})

// Fix 04 follow-up (coordinator 2026-10-06): a chat never fails to start because a model is missing.
test('an unlisted default falls back to the same provider, with the one-time notice, for a first chat and a new chat', async () => {
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
    listedModels: {
      listed: [{ provider: 'anthropic', id: 'claude-x' }, { provider: 'openai-codex', id: 'gpt-5.6-sol' }],
      available: [{ provider: 'anthropic', id: 'claude-x' }, { provider: 'openai-codex', id: 'gpt-5.6-sol' }],
    },
  })
  await harness.manager.bind()
  await harness.manager.activeReady()
  expect(harness.bootDefaults.at(-1)).toEqual({ provider: 'openai-codex', modelId: 'gpt-5.6-sol', thinkingLevel: 'medium' })
  expect(harness.manager.activeModelNotice()).toBe('openai-codex/gpt-5.5 is no longer available. This chat now uses openai-codex/gpt-5.6-sol.')
  await harness.manager.newChat()
  await harness.manager.activeReady()
  expect(harness.manager.activeRecord()?.model).toEqual({ provider: 'openai-codex', id: 'gpt-5.6-sol' })
  expect(harness.manager.activeModelNotice()).toBe('openai-codex/gpt-5.5 is no longer available. This chat now uses openai-codex/gpt-5.6-sol.')
  await harness.manager.disposeAll()
})

// "Ask first" : automatic fallback stays within the chat's (or the default's)
// provider; another provider is only ever the user's explicit choice.
const claudeRef = { provider: 'anthropic', id: 'claude-x' }
const openaiRef = { provider: 'openai', id: 'gpt-api' }
const CHOICE_NOTICE = (provider: string, id: string) =>
  `${provider}/${id} is no longer available and ${provider} offers no other model you can use. Choose a model to continue.`

test('reopen: a stored model whose provider offers nothing else does not start; it asks, OpenAI first', async () => {
  const index = new ThreadIndex(join(userData, 'threads', 'index.json'))
  await index.add({
    id: 'dropped', workspaceRoot: root, kind: 'chat', title: 'Dropped', createdAt: 1, lastActiveAt: 1,
    model: { provider: 'openai-codex', id: 'gpt-retired' }, thinkingLevel: 'low',
  })
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' },
    listedModels: { listed: [claudeRef, openaiRef], available: [claudeRef, openaiRef] },
  })
  await harness.manager.bind()
  expect(harness.bootDefaults).toEqual([]) // nothing reached Bridle
  expect(harness.manager.activeReady()).toBeNull()
  expect(harness.manager.activeRecord()?.model).toEqual({ provider: 'openai-codex', id: 'gpt-retired' })
  expect(harness.manager.activeModelNotice()).toBe(CHOICE_NOTICE('openai-codex', 'gpt-retired'))
  expect(harness.manager.activeModelChoice()?.candidates).toEqual([openaiRef, claudeRef])
  expect((await index.get('dropped'))?.model).toEqual({ provider: 'openai-codex', id: 'gpt-retired' })
  await harness.manager.disposeAll()
})

test('start: an unlisted default with no same-provider model makes the first chat ask instead of starting', async () => {
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' },
    listedModels: { listed: [claudeRef], available: [claudeRef] },
  })
  await harness.manager.bind()
  expect(harness.bootDefaults).toEqual([])
  expect(harness.manager.activeModelNotice()).toBe(CHOICE_NOTICE('openai-codex', 'gpt-5.5'))
  expect(harness.manager.activeModelChoice()?.candidates).toEqual([claudeRef])
  // A new chat asks too.
  await harness.manager.newChat()
  expect(harness.bootDefaults).toEqual([])
  expect(harness.manager.activeModelChoice()?.candidates).toEqual([claudeRef])
  await harness.manager.disposeAll()
})

test('choosing a model is explicit: it is persisted and the chat starts on it', async () => {
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' },
    listedModels: { listed: [claudeRef, openaiRef], available: [claudeRef, openaiRef] },
  })
  await harness.manager.bind()
  const id = harness.manager.activeRecord()!.id
  await expect(harness.manager.chooseModel('openai-codex', 'gpt-5.5')).rejects.toThrow('That model is unavailable')
  expect(harness.bootDefaults).toEqual([])
  await harness.manager.chooseModel('anthropic', 'claude-x')
  await harness.manager.activeReady()
  expect(harness.bootDefaults).toEqual([{ provider: 'anthropic', modelId: 'claude-x', thinkingLevel: 'medium' }])
  expect(harness.manager.activeModelChoice()).toBeNull()
  expect(harness.manager.activeModelNotice()).toBeNull()
  expect((await new ThreadIndex(join(userData, 'threads', 'index.json')).get(id))?.model).toEqual(claudeRef)
  await harness.manager.disposeAll()
})

test('the cross-provider case never reaches Bridle: a reopened live chat and a new chat both refuse', async () => {
  const listing = { listed: [{ provider: 'openai-codex', id: 'gpt-5.5' }, claudeRef], available: [{ provider: 'openai-codex', id: 'gpt-5.5' }, claudeRef] }
  const harness = await makeManager(undefined, { defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' }, listedModels: listing })
  await harness.manager.bind()
  await harness.manager.activeReady()
  const first = harness.manager.activeRecord()!.id
  await harness.manager.newChat()
  await harness.manager.activeReady()
  // ChatGPT drops every model; only Anthropic can run.
  listing.listed = [claudeRef]
  listing.available = [claudeRef]
  // Reopen with a live agent: not pointed at, not switched to Anthropic.
  await harness.manager.activate(first)
  expect(harness.manager.activeReady()).toBeNull()
  expect(harness.applied).toEqual([])
  expect(harness.manager.activeModelChoice()?.candidates).toEqual([claudeRef])
  // A new chat does not start either.
  const bootsBefore = harness.bootDefaults.length
  await harness.manager.newChat()
  expect(harness.bootDefaults.length).toBe(bootsBefore)
  expect(harness.bootDefaults.every((boot) => boot.provider === 'openai-codex')).toBe(true)
  await harness.manager.disposeAll()
})

test('creation: a list that changes between activation and agent creation still never reaches Bridle', async () => {
  const codex = { provider: 'openai-codex', id: 'gpt-5.5' }
  const listing = { listed: [codex, claudeRef], available: [codex, claudeRef] }
  let readyCalls = 0
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' },
    listedModels: listing,
    // Activation sees ChatGPT's model; by the time the agent is created ChatGPT lists nothing.
    modelsReady: async () => {
      readyCalls += 1
      if (readyCalls >= 3) { listing.listed = [claudeRef]; listing.available = [claudeRef] }
    },
  })
  await harness.manager.bind()
  await harness.manager.activeReady()?.catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(harness.bootDefaults).toEqual([])
  expect(harness.manager.activeModelChoice()?.candidates).toEqual([claudeRef])
  expect(harness.manager.activeModelNotice()).toBe(CHOICE_NOTICE('openai-codex', 'gpt-5.5'))
  expect(harness.manager.activeBootError()).toBeNull()
  await harness.manager.disposeAll()
})

test('run-as-is (threads:run-skill) refuses a reused skill chat that waits for a model choice: nothing is sent', async () => {
  const codex = { provider: 'openai-codex', id: 'gpt-5.5' }
  const listing = { listed: [codex, claudeRef], available: [codex, claudeRef] }
  const harness = await makeManager(undefined, { defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' }, listedModels: listing })
  await harness.manager.bind()
  const skill = await harness.manager.openSkillThread('copy-edit')
  await harness.manager.activeReady()
  await harness.manager.newChat()
  await harness.manager.activeReady()
  // ChatGPT stops offering anything; the skill chat (agent still alive) is reopened and waits.
  listing.listed = [claudeRef]
  listing.available = [claudeRef]
  await harness.manager.activate(skill.id)
  expect(harness.manager.activeModelChoice()).not.toBeNull()
  harness.queue.push(buildE2EScriptedTurn([{ cap: 'files.read', input: { path: 'a.md' } }]))
  const promptsBefore = harness.promptCalls.length
  await expect(harness.manager.runSkillAsIs('copy-edit', 'a.md')).rejects.toThrow(CHOICE_NOTICE('openai-codex', 'gpt-5.5'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(harness.promptCalls.length).toBe(promptsBefore)
  expect(harness.runs).toEqual([])
  expect(harness.applied).toEqual([])
  await harness.manager.disposeAll()
})

test('run-as-is refuses a new skill thread when the default cannot run and only another provider could', async () => {
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' },
    listedModels: { listed: [claudeRef], available: [claudeRef] },
  })
  await harness.manager.bind()
  await expect(harness.manager.runSkillAsIs('copy-edit', 'a.md')).rejects.toThrow(CHOICE_NOTICE('openai-codex', 'gpt-5.5'))
  expect(harness.bootDefaults).toEqual([])
  expect(harness.promptCalls).toEqual([])
  const { threads } = await harness.manager.list()
  expect(threads.filter((thread) => thread.kind === 'skill')).toHaveLength(0)
  await harness.manager.disposeAll()
})

test('review regression: an open skill chat loses its models, run-as-is is refused without reopening, and agent:prompt then sends nothing', async () => {
  const codex = { provider: 'openai-codex', id: 'gpt-5.5' }
  const listing = { listed: [codex, claudeRef], available: [codex, claudeRef] }
  const harness = await makeManager(undefined, { defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' }, listedModels: listing })
  await harness.manager.bind()
  const skill = await harness.manager.openSkillThread('copy-edit')
  const windowAgent = await harness.manager.activeReady()
  expect(harness.active.agent).toBe(windowAgent) // the window points at the skill chat's agent
  // ChatGPT stops offering anything while the skill chat stays open (no reopen).
  listing.listed = [claudeRef]
  listing.available = [claudeRef]
  await expect(harness.manager.runSkillAsIs('copy-edit', 'a.md')).rejects.toThrow(CHOICE_NOTICE('openai-codex', 'gpt-5.5'))
  // Source: the waiting state is published — the window no longer points at an agent.
  expect(harness.active.agent).toBeNull()
  expect(harness.manager.activeThreadId()).toBe(skill.id)
  // Sink: agent:prompt sends through sendGuarded(agent, activeThreadId()). Even a caller still holding
  // the old agent reference (a send already past requireAgent) is refused and nothing is sent.
  harness.queue.push(buildE2EScriptedTurn([{ cap: 'files.read', input: { path: 'a.md' } }]))
  const before = harness.promptCalls.length
  await expect(harness.manager.sendGuarded(windowAgent!, harness.manager.activeThreadId(), () => windowAgent!.prompt('hello', 'a.md')))
    .rejects.toThrow(CHOICE_NOTICE('openai-codex', 'gpt-5.5'))
  // The agent's own thread is checked too, whichever thread id the caller names.
  await expect(harness.manager.sendGuarded(windowAgent!, null, () => windowAgent!.prompt('hello', 'a.md'))).rejects.toThrow('Choose a model to continue.')
  expect(harness.promptCalls.length).toBe(before)
  // agent:prompt itself checks before side effects and sends only through the gate.
  const ipc = await Bun.file(new URL('../../src/main/ipc.ts', import.meta.url)).text()
  const handler = ipc.slice(ipc.indexOf("ipcMain.handle('agent:prompt'"), ipc.indexOf("ipcMain.handle('agent:abort'"))
  expect(handler).toContain('state.threads?.assertMaySend(agent, state.threads.activeThreadId())')
  expect(handler).toContain('state.threads.sendGuarded(agent, state.threads.activeThreadId(), send)')
  expect(handler.match(/agent\.prompt\(/g)?.length).toBe(1) // the only prompt call sits inside the gated send
  await harness.manager.disposeAll()
})

test('a chat waiting for a model choice still shows its saved conversation', async () => {
  const codex = { provider: 'openai-codex', id: 'gpt-5.5' }
  const first = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' },
    listedModels: { listed: [codex, claudeRef], available: [codex, claudeRef] },
  })
  await first.manager.bind()
  const agent = await first.manager.activeReady()
  first.queue.push(buildE2EScriptedTurn([{ cap: 'files.read', input: { path: 'a.md' } }]))
  await agent!.prompt('read it for me')
  const live = agent!.messages()
  expect(await first.manager.activeIdleTranscript()).toEqual([]) // a running chat shows its live agent
  await first.manager.disposeAll()

  // Relaunch after ChatGPT stopped offering anything: the chat waits, and its history stays visible.
  const second = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' },
    listedModels: { listed: [claudeRef], available: [claudeRef] },
  })
  await second.manager.bind()
  expect(second.manager.activeModelChoice()).not.toBeNull()
  const shown = await second.manager.activeIdleTranscript()
  expect(shown.length).toBeGreaterThan(0)
  expect(shown.map((message) => message.content)).toEqual(live.map((message) => message.content))
  // agent:state's no-agent branch reads this, for waits as well as boot failures.
  const ipc = await Bun.file(new URL('../../src/main/ipc.ts', import.meta.url)).text()
  expect(ipc).toContain('await state.threads.activeIdleTranscript()')
  await second.manager.disposeAll()
})

test('reopen: a live chat whose model is gone switches to the user\'s pick only when chosen', async () => {
  const listing = { listed: [{ provider: 'openai-codex', id: 'gpt-5.5' }, claudeRef], available: [{ provider: 'openai-codex', id: 'gpt-5.5' }, claudeRef] }
  const harness = await makeManager(undefined, { defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' }, listedModels: listing })
  await harness.manager.bind()
  await harness.manager.activeReady()
  const first = harness.manager.activeRecord()!.id
  await harness.manager.newChat()
  await harness.manager.activeReady()
  listing.listed = [claudeRef]
  listing.available = [claudeRef]
  await harness.manager.activate(first)
  const boots = harness.bootDefaults.length
  await harness.manager.chooseModel('anthropic', 'claude-x')
  await harness.manager.activeReady()
  // The live agent was switched (and read back), not rebooted.
  expect(harness.applied).toEqual([claudeRef])
  expect(harness.bootDefaults.length).toBe(boots)
  expect(harness.manager.activeRecord()?.model).toEqual(claudeRef)
  expect(harness.manager.activeModelChoice()).toBeNull()
  await harness.manager.disposeAll()
})

test('with nothing listed at all the stored model stays and no replacement notice is invented', async () => {
  const index = new ThreadIndex(join(userData, 'threads', 'index.json'))
  await index.add({
    id: 'nothing', workspaceRoot: root, kind: 'chat', title: 'Nothing', createdAt: 1, lastActiveAt: 1,
    model: { provider: 'openai-codex', id: 'gpt-retired' }, thinkingLevel: 'low',
  })
  const harness = await makeManager(undefined, { listedModels: { listed: [], available: [] } })
  await harness.manager.bind()
  await harness.manager.activeReady()
  expect(harness.bootDefaults.at(-1)).toMatchObject({ provider: 'openai-codex', modelId: 'gpt-retired' })
  expect(harness.manager.activeModelNotice()).toBeNull()
  await harness.manager.disposeAll()
})

test('preferences resolve after startup discovery: bundled gpt-5.5 at start, discovery lists only gpt-5.6-sol, the agent starts on gpt-5.6-sol', async () => {
  const sol = { provider: 'openai-codex', id: 'gpt-5.6-sol' }
  const bundled = { provider: 'openai-codex', id: 'gpt-5.5' }
  const listing = { listed: [bundled, sol], available: [bundled, sol] }
  let finishDiscovery!: () => void
  const discovery = new Promise<void>((resolve) => { finishDiscovery = resolve })
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' },
    listedModels: listing,
    modelsReady: discovery,
  })
  const binding = harness.manager.bind()
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(harness.bootDefaults).toEqual([]) // nothing reaches Bridle before discovery is ready
  listing.listed = [sol]
  listing.available = [sol]
  finishDiscovery()
  await binding
  await harness.manager.activeReady()
  expect(harness.bootDefaults).toEqual([{ provider: 'openai-codex', modelId: 'gpt-5.6-sol', thinkingLevel: 'medium' }])
  expect(harness.manager.activeRecord()?.model).toEqual(sol)
  expect(harness.manager.activeModelNotice()).toBe('openai-codex/gpt-5.5 is no longer available. This chat now uses openai-codex/gpt-5.6-sol.')
  await harness.manager.disposeAll()
})

test('a stored model removed while the chat runs: reactivation switches the live agent, then persists and notes it', async () => {
  const sol = { provider: 'openai-codex', id: 'gpt-5.6-sol' }
  const old = { provider: 'openai-codex', id: 'gpt-5.5' }
  const listing = { listed: [old, sol], available: [old, sol] }
  const harness = await makeManager(undefined, { defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' }, listedModels: listing })
  await harness.manager.bind()
  await harness.manager.activeReady()
  const first = harness.manager.activeRecord()!.id
  await harness.manager.newChat()
  await harness.manager.activeReady()
  // The provider stops listing gpt-5.5 while the first chat's agent is still alive.
  listing.listed = [sol]
  listing.available = [sol]
  const bootsBefore = harness.bootDefaults.length
  await harness.manager.activate(first)
  await harness.manager.activeReady()
  // The cached agent was switched (read back through currentModelAfterApply), not rebooted.
  expect(harness.applied).toEqual([sol])
  expect(harness.bootDefaults.length).toBe(bootsBefore)
  expect(harness.manager.activeRecord()?.model).toEqual(sol)
  expect((await new ThreadIndex(join(userData, 'threads', 'index.json')).get(first))?.model).toEqual(sol)
  expect(harness.manager.activeModelNotice()).toBe('openai-codex/gpt-5.5 is no longer available. This chat now uses openai-codex/gpt-5.6-sol.')
  await harness.manager.disposeAll()
})

test('a live agent that cannot switch: nothing is persisted and no switch is claimed', async () => {
  const sol = { provider: 'openai-codex', id: 'gpt-5.6-sol' }
  const old = { provider: 'openai-codex', id: 'gpt-5.5' }
  const listing = { listed: [old, sol], available: [old, sol] }
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5' },
    listedModels: listing,
    switchInForceModel: old, // the read-back says the old model is still in force
  })
  await harness.manager.bind()
  await harness.manager.activeReady()
  const first = harness.manager.activeRecord()!.id
  await harness.manager.newChat()
  await harness.manager.activeReady()
  listing.listed = [sol]
  listing.available = [sol]
  await harness.manager.activate(first)
  expect(harness.manager.activeRecord()?.model).toEqual(old)
  expect((await new ThreadIndex(join(userData, 'threads', 'index.json')).get(first))?.model).toEqual(old)
  expect(harness.manager.activeModelNotice()).toBeNull()
  await harness.manager.disposeAll()
})

test('a thread whose stored model is unavailable falls back to the default and records one quiet notice', async () => {
  const index = new ThreadIndex(join(userData, 'threads', 'index.json'))
  await index.add({
    id: 'stale-thread', workspaceRoot: root, kind: 'chat', title: 'Stale', createdAt: 1, lastActiveAt: 1,
    model: { provider: 'openai-codex', id: 'gpt-retired' }, thinkingLevel: 'low',
  })
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.6-sol', thinkingLevel: 'high' },
    availableModels: [{ provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
  })
  await harness.manager.bind()
  await harness.manager.activeReady()
  expect(harness.bootDefaults.at(-1)).toEqual({ provider: 'openai-codex', modelId: 'gpt-5.6-sol', thinkingLevel: 'low' })
  expect(harness.manager.activeRecord()?.model).toEqual({ provider: 'openai-codex', id: 'gpt-5.6-sol' })
  expect(harness.manager.activeModelNotice()).toContain('gpt-retired')
  expect(harness.manager.activeModelNotice()).toContain('gpt-5.6-sol')
  expect((await new ThreadIndex(join(userData, 'threads', 'index.json')).get('stale-thread'))?.model).toEqual({ provider: 'openai-codex', id: 'gpt-5.6-sol' })
  await harness.manager.disposeAll()
})

test('a successful model switch persists and round-trips through a fresh thread-index read', async () => {
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
    availableModels: [
      { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' },
      { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    ],
  })
  await harness.manager.bind()
  await harness.manager.activeReady()
  const id = harness.manager.activeThreadId()!
  await harness.manager.setModel('openai-codex', 'gpt-5.6-sol')
  expect(harness.manager.activeRecord()?.model).toEqual({ provider: 'openai-codex', id: 'gpt-5.6-sol' })
  const refreshed = await new ThreadIndex(join(userData, 'threads', 'index.json')).get(id)
  expect(refreshed?.model).toEqual({ provider: 'openai-codex', id: 'gpt-5.6-sol' })
  await harness.manager.activate(id)
  await harness.manager.activeReady()
  expect(harness.manager.activeRecord()?.model).toEqual({ provider: 'openai-codex', id: 'gpt-5.6-sol' })
  await harness.manager.disposeAll()
})

test('an unavailable model cannot be selected into the active thread', async () => {
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
    availableModels: [{ provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' }],
  })
  await harness.manager.bind()
  await harness.manager.activeReady()
  await expect(harness.manager.setModel('anthropic', 'claude-opus-4-1')).rejects.toThrow(/unavailable/i)
  expect(harness.manager.activeRecord()?.model).toEqual({ provider: 'openai-codex', id: 'gpt-5.5' })
  await harness.manager.disposeAll()
})

test('an ignored model switch is rejected before the requested model can enter the thread record', async () => {
  const harness = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
    availableModels: [
      { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' },
      { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    ],
    switchInForceModel: { provider: 'openai-codex', id: 'gpt-5.5' },
  })
  await harness.manager.bind()
  await harness.manager.activeReady()
  await expect(harness.manager.setModel('openai-codex', 'gpt-5.6-sol')).rejects.toThrow(/gpt-5\.5.*in force/i)
  expect(harness.manager.activeRecord()?.model).toEqual({ provider: 'openai-codex', id: 'gpt-5.5' })
  await harness.manager.disposeAll()
})

test('completed-turn execution metadata is stored in the thread index and decorates the matching assistant turn after reload', async () => {
  const first = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
    availableModels: [{ provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' }],
  })
  await first.manager.bind()
  const threadId = first.manager.activeThreadId()!
  await first.manager.recordTurn(threadId, {
    turnId: 'turn-1', provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high', completedAt: 2200,
  })
  await first.manager.disposeAll()

  const reloaded = await makeManager(undefined, {
    defaults: { provider: 'openai-codex', modelId: 'gpt-5.4', thinkingLevel: 'minimal' },
  })
  await reloaded.manager.bind()
  const persisted = reloaded.manager.activeTurnRecords()
  expect(persisted[0]).toMatchObject({
    provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high', completedAt: 2200,
  })
  const messages = attachTurnExecutions([{ role: 'assistant', content: 'Done.', createdAt: 2200 }], persisted)
  expect(messages[0].execution).toMatchObject({ modelId: 'gpt-5.5', thinkingLevel: 'high' })
  await reloaded.manager.disposeAll()
})

test('a cold shared index is read consistently by concurrent callers', async () => {
  const file = join(userData, 'threads', 'index.json')
  const seed = new ThreadIndex(file)
  await seed.add({ id: 'seeded', workspaceRoot: root, kind: 'chat', title: 'x', createdAt: 1, lastActiveAt: 1 })
  // review finding B1 review P1: the first load must not let a concurrent reader see the pre-load empty array.
  const cold = new ThreadIndex(file)
  const results = await Promise.all(Array.from({ length: 20 }, () => cold.list(root)))
  for (const { records } of results) expect(records).toHaveLength(1)
})

test('an older slower activation can never leave the exposed agent pointing at the wrong thread', async () => {
  const registry = await makeRegistry()
  // Delay index reads for one specific thread so the OLDER activation resolves LAST (review finding probe).
  class DelayedIndex extends ThreadIndex {
    constructor(file: string, private readonly slowId: string) { super(file) }
    override async get(id: string) {
      const record = await super.get(id)
      if (id === this.slowId) await new Promise((resolve) => setTimeout(resolve, 30))
      return record
    }
  }
  const file = join(userData, 'threads', 'index.json')
  const now = Date.now()
  const seed = new ThreadIndex(file)
  await seed.add({ id: 'slow-chat', workspaceRoot: root, kind: 'chat', title: 'a', createdAt: now, lastActiveAt: now })
  await seed.add({ id: 'fast-skill', workspaceRoot: root, kind: 'skill', skillName: 'copy-edit', title: 'b', createdAt: now, lastActiveAt: now + 1 })

  const queue: ScriptedTurn[] = []
  const seen: Array<string | null> = []
  let manager!: ThreadManager
  manager = new ThreadManager({
    userDataDir: userData,
    workspaceRoot: root,
    index: new DelayedIndex(file, 'slow-chat'),
    skills: registry,
    machineInstructionsPath: join(userData, 'no-such-instructions.md'),
    createAgent: ({ appDataDir, composition }) => WorkspaceAgent.create({ mode: 'work',
      workspace: new Workspace(root), appDataDir,
      onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
      sessionFactory: scriptedSessionFactory(queue),
      ...(composition ? { composition } : {}),
    }),
    onActiveChanged: () => { seen.push(manager.activeThreadId()) },
  })
  // User intent: slow-chat first, fast-skill second — fast-skill must win every pointer update.
  await Promise.all([manager.activate('slow-chat'), manager.activate('fast-skill')])
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(manager.activeThreadId()).toBe('fast-skill')
  expect(manager.activeRecord()?.id).toBe('fast-skill')
  // Every onActiveChanged fired after the newer activation claimed the pointer names fast-skill.
  expect(seen.at(-1)).toBe('fast-skill')
  await manager.disposeAll()
})

test('a skill thread boots a skill-bound instance and restores its own transcript', async () => {
  const { manager, queue } = await makeManager()
  await manager.bind()
  const meta = await manager.openSkillThread('copy-edit')
  expect(meta.kind).toBe('skill')
  expect(meta.title).toBe('Copy-edit')
  const agent = await manager.activeReady()
  expect(agent).not.toBeNull()

  // Say something in the skill thread, then re-open it via a FRESH manager (an app relaunch):
  // the per-thread session dir must bring the transcript back.
  queue.push(buildE2EScriptedTurn([{ cap: 'files.read', input: { path: 'a.md' } }]))
  await agent!.prompt('tighten the second paragraph')
  await manager.disposeAll()

  const second = await makeManager()
  await second.manager.bind() // most-recent thread = the skill thread
  expect(second.manager.activeRecord()?.skillName).toBe('copy-edit')
  const restored = await second.manager.activeReady()
  // The scripted factory replays its sentinel prompt, so the restored proof is the turn's REPLY
  // surviving into a fresh instance — the per-thread session dir carried the transcript across.
  const texts = restored!.messages().map((message) => message.content)
  expect(texts.some((text) => text.includes('Staged for your review.'))).toBe(true)
  await second.manager.disposeAll()
})

test('an edited skill applies on the next activation, not to the open thread', async () => {
  const registry = await makeRegistry()
  const { manager } = await makeManager(registry)
  await manager.bind()
  await manager.openSkillThread('copy-edit')
  await manager.activeReady()

  // Edit the seeded copy (the registry reads appData, not the bundle).
  await writeFile(join(userData, 'skills', 'copy-edit', 'SKILL.md'),
    SKILL('copy-edit', ['files.read'], 'Now read-only.'))

  const meta = await manager.openSkillThread('copy-edit')
  expect(meta.id).not.toBe('')
  const { skill } = await registry.get('copy-edit')
  expect(skill?.description).toBe('Now read-only.')
  await manager.disposeAll()
})

// ---- Run-as-is -----------------------------------------------------------------------------------

test('run-as-is is a thread with nothing said: record created, no user turn, completion payload', async () => {
  const harness = await makeManager()
  await harness.manager.bind()
  const chatId = harness.manager.activeThreadId()
  harness.queue.push(buildE2EScriptedTurn([{ cap: 'files.read', input: { path: 'a.md' } }]))

  const { threadId } = await harness.manager.runSkillAsIs('copy-edit', 'a.md')
  // The panel does NOT switch: run-as-is completes beside the writer's active thread (M4 toast).
  expect(harness.manager.activeThreadId()).toBe(chatId)

  // Wait for the run to settle.
  for (let i = 0; i < 250 && harness.runs.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
  expect(harness.runs).toHaveLength(1)
  expect(harness.runs[0].threadId).toBe(threadId)
  expect(harness.runs[0].outcome).toBe('completed')

  const { threads } = await harness.manager.list()
  const record = threads.find((thread) => thread.id === threadId)
  expect(record?.title).toBe('a.md')

  // "A thread with nothing said": the fired turn carried EMPTY user text — the hidden writer situation
  // tag is the whole prompt, and messages() strips it (agent.test.ts covers the strip), so the
  // live transcript shows no user row. The scripted factory records its own sentinel prompt, so
  // the honest boundary here is what the manager sent the agent.
  expect(harness.promptCalls).toEqual([['', 'a.md']])
  await harness.manager.activate(threadId)
  const agent = await harness.manager.activeReady()
  expect(agent!.messages().some((message) => message.role === 'assistant')).toBe(true)
  await harness.manager.disposeAll()
})

test('run-as-is on a document skill without an open document is refused with human copy', async () => {
  const { manager } = await makeManager()
  await manager.bind()
  await expect(manager.runSkillAsIs('copy-edit', null)).rejects.toThrow('Copy-edit needs an open document.')
  // No thread record was left behind by the refusal.
  const { threads } = await manager.list()
  expect(threads.filter((thread) => thread.kind === 'skill')).toHaveLength(0)
  await manager.disposeAll()
})

// ---- Guard states --------------------------------------------------------------------------------

test('a persisted skill thread whose SKILL.md went malformed opens as an error, never a chat fallback', async () => {
  const { manager } = await makeManager()
  await manager.bind()
  const meta = await manager.openSkillThread('copy-edit')
  await manager.activeReady()
  await manager.disposeAll()

  // A DELETED bundled skill would self-heal (seed-if-absent), so the durable breakage is a
  // malformed user edit: the folder survives seeding, the loader records an error, get() → null.
  await writeFile(join(userData, 'skills', 'copy-edit', 'SKILL.md'), 'no frontmatter at all\n')
  const second = await makeManager()
  await second.manager.bind().catch(() => {}) // bind restores the skill thread; its boot fails
  await second.manager.activate(meta.id)
  // Boot failures surface through the agentReady view (requireAgent's await), never a chat fallback.
  await expect(second.ready).rejects.toThrow(ThreadSkillGoneError)
  expect(second.active.agent).toBeNull()
  await second.manager.disposeAll()
})

test('a skill scoping a capability the app does not bind fails loudly at boot', async () => {
  await mkdir(join(bundled, 'bogus'), { recursive: true })
  await writeFile(join(bundled, 'bogus', 'SKILL.md'), SKILL('bogus', ['no.such_tool']))
  const registry = new SkillsRegistry({ appDataDir: userData, bundledSkillsDir: bundled })
  await registry.init()
  // The seed list is fixed to the three bundled skills; place the bogus skill directly in appData.
  await mkdir(join(userData, 'skills', 'bogus'), { recursive: true })
  await writeFile(join(userData, 'skills', 'bogus', 'SKILL.md'), SKILL('bogus', ['no.such_tool']))

  const harness = await makeManager(registry)
  await harness.manager.bind()
  await harness.manager.openSkillThread('bogus')
  await expect(harness.ready).rejects.toThrow(/no\.such_tool|does not bind/)
  await harness.manager.disposeAll()
})

test('activation races resolve to the newest activation', async () => {
  const harness = await makeManager()
  await harness.manager.bind()
  const first = await harness.manager.newChat()
  const second = await harness.manager.newChat()
  // Activate the older thread then immediately the newer one; the newer must win the pointer.
  await Promise.all([
    harness.manager.activate(first.id),
    harness.manager.activate(second.id),
  ])
  expect(harness.manager.activeThreadId()).toBe(second.id)
  await harness.manager.activeReady()
  await harness.manager.disposeAll()
})

test('the first user text names the thread once; later texts do not rename it', async () => {
  const { manager } = await makeManager()
  await manager.bind()
  await manager.newChat()
  await manager.noteUserText('plan the grep essay\nand more')
  let { threads } = await manager.list()
  expect(threads[0].title).toBe('plan the grep essay')
  await manager.noteUserText('now something else')
  ;({ threads } = await manager.list())
  expect(threads[0].title).toBe('plan the grep essay')
  await manager.disposeAll()
})

test('ticket 11: a titled skill names its new thread by its title, until the first line renames it', async () => {
  const registry = await makeRegistry()
  // Straight into the registry's folder: this fixture bundles copy-edit alone.
  await mkdir(join(userData, 'skills', 'report-structure'), { recursive: true })
  await writeFile(
    join(userData, 'skills', 'report-structure', 'SKILL.md'),
    SKILL('report-structure', ['files.read']).replace('name: report-structure\n', 'name: report-structure\ntitle: Help with this report\n'),
  )
  const { manager } = await makeManager(registry)
  await manager.bind()
  const meta = await manager.openSkillThread('report-structure')
  expect(meta.title).toBe('Help with this report')
  await manager.noteUserText('where does this report stand?')
  const { threads } = await manager.list()
  expect(threads.find((thread) => thread.id === meta.id)?.title).toBe('where does this report stand?')
  await manager.disposeAll()
})

test('close disposes the instance, keeps history, and falls back to another thread', async () => {
  const { manager } = await makeManager()
  await manager.bind()
  const chatId = manager.activeThreadId()
  const meta = await manager.openSkillThread('copy-edit')
  await manager.activeReady()
  await manager.close(meta.id)
  // review finding B1 review P1: closing the active thread must not leave the window agent-less.
  expect(manager.activeThreadId()).toBe(chatId)
  const { threads } = await manager.list()
  expect(threads.find((thread) => thread.id === meta.id)).toBeDefined()
  await manager.disposeAll()
})

test('run-as-is fired while that skill thread is active reuses it — no hidden second record', async () => {
  const harness = await makeManager()
  await harness.manager.bind()
  const meta = await harness.manager.openSkillThread('copy-edit')
  await harness.manager.activeReady()
  harness.queue.push(buildE2EScriptedTurn([{ cap: 'files.read', input: { path: 'a.md' } }]))
  const { threadId } = await harness.manager.runSkillAsIs('copy-edit', 'a.md')
  expect(threadId).toBe(meta.id)
  for (let i = 0; i < 250 && harness.runs.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
  expect(harness.runs[0]?.threadId).toBe(meta.id)
  const { threads } = await harness.manager.list()
  expect(threads.filter((thread) => thread.skillName === 'copy-edit')).toHaveLength(1)
  await harness.manager.disposeAll()
})

test('a failed active boot surfaces its human copy through activeBootError and keeps the record readable', async () => {
  const { manager } = await makeManager()
  await manager.bind()
  const meta = await manager.openSkillThread('copy-edit')
  await manager.activeReady()
  await manager.disposeAll()

  await writeFile(join(userData, 'skills', 'copy-edit', 'SKILL.md'), 'no frontmatter at all\n')
  const second = await makeManager()
  await second.manager.bind().catch(() => {})
  await second.manager.activate(meta.id)
  await second.ready?.catch(() => {})
  // The designed notice: agent:state carries the record AND the failure copy — no silent fallback.
  expect(second.manager.activeThreadId()).toBe(meta.id)
  expect(second.manager.activeRecord()?.skillName).toBe('copy-edit')
  expect(second.manager.activeBootError()).toMatch(/Copy-edit skill .* missing or unreadable/)
  await second.manager.disposeAll()
})

// ---- Round-2/3 lifecycle regression coverage -----------------------------------------------------

test('concurrent disposeAll callers join ONE teardown', async () => {
  const { manager } = await makeManager()
  await manager.bind()
  await manager.activeReady()
  const first = manager.disposeAll()
  const second = manager.disposeAll()
  expect(second).toBe(first) // join, never a second early-settling snapshot of an empty map
  await first
})

test('disposal during the first bind leaves no orphan record', async () => {
  const registry = await makeRegistry()
  class PausedAddIndex extends ThreadIndex {
    resume: (() => void) | null = null
    override async add(record: Parameters<ThreadIndex['add']>[0]): Promise<void> {
      await super.add(record)
      await new Promise<void>((resolve) => { this.resume = resolve })
    }
  }
  const file = join(userData, 'threads', 'index.json')
  const index = new PausedAddIndex(file)
  const queue: ScriptedTurn[] = []
  const manager = new ThreadManager({
    userDataDir: userData, workspaceRoot: root, index, skills: registry,
    machineInstructionsPath: join(userData, 'no-such-instructions.md'),
    createAgent: ({ appDataDir, composition }) => WorkspaceAgent.create({ mode: 'work',
      workspace: new Workspace(root), appDataDir,
      onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
      sessionFactory: scriptedSessionFactory(queue),
      ...(composition ? { composition } : {}),
    }),
    onActiveChanged: () => {},
  })
  const binding = manager.bind()
  binding.catch(() => {})
  for (let i = 0; i < 100 && !index.resume; i++) await new Promise((r) => setTimeout(r, 10))
  const teardown = manager.disposeAll()
  index.resume?.()
  await expect(binding).rejects.toThrow('This window is closing.')
  await teardown
  // The rolled-back record must not survive into a fresh index read.
  expect((await new ThreadIndex(file).list(root)).records).toHaveLength(0)
})

test('run-as-is fired around disposal never prompts a disposed agent', async () => {
  const harness = await makeManager()
  await harness.manager.bind()
  await harness.manager.openSkillThread('copy-edit')
  await harness.manager.activeReady()
  // Reuse path: the touch's await gives disposal a window; the run must refuse, not prompt.
  const run = harness.manager.runSkillAsIs('copy-edit', 'a.md')
  const teardown = harness.manager.disposeAll()
  await run.catch(() => {})
  await teardown
  await new Promise((r) => setTimeout(r, 100))
  expect(harness.promptCalls).toHaveLength(0)
})

test('run-as-is REUSE path paused inside its touch refuses once disposal lands (deterministic)', async () => {
  // review finding round 4: the scheduling-based test above never actually reached touch(); this one pauses
  // INSIDE the reuse touch so disposal deterministically lands in the guarded window.
  const registry = await makeRegistry()
  class PausedTouchIndex extends ThreadIndex {
    resume: (() => void) | null = null
    pauseNext = false
    override async touch(id: string, patch?: Parameters<ThreadIndex['touch']>[1]): Promise<void> {
      if (this.pauseNext) {
        this.pauseNext = false
        await new Promise<void>((resolve) => { this.resume = resolve })
      }
      return super.touch(id, patch)
    }
  }
  const index = new PausedTouchIndex(join(userData, 'threads', 'index.json'))
  const queue: ScriptedTurn[] = []
  const promptCalls: string[] = []
  const manager = new ThreadManager({
    userDataDir: userData, workspaceRoot: root, index, skills: registry,
    machineInstructionsPath: join(userData, 'no-such-instructions.md'),
    createAgent: async ({ appDataDir, composition }) => {
      const agent = await WorkspaceAgent.create({ mode: 'work',
        workspace: new Workspace(root), appDataDir,
        onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
        sessionFactory: scriptedSessionFactory(queue),
        ...(composition ? { composition } : {}),
      })
      const prompt = agent.prompt.bind(agent)
      agent.prompt = (text, activeFile) => { promptCalls.push(text); return prompt(text, activeFile) }
      return agent
    },
    onActiveChanged: (_agent, ready) => { ready?.catch(() => {}) },
  })
  await manager.bind()
  await manager.openSkillThread('copy-edit')
  await manager.activeReady()
  index.pauseNext = true // the NEXT touch is the reuse touch inside runSkillAsIs
  const run = manager.runSkillAsIs('copy-edit', 'a.md')
  run.catch(() => {})
  for (let i = 0; i < 100 && !index.resume; i++) await new Promise((r) => setTimeout(r, 10))
  expect(index.resume).not.toBeNull() // the run IS paused inside the reuse touch
  const teardown = manager.disposeAll()
  index.resume?.()
  await expect(run).rejects.toThrow('This window is closing.')
  await teardown
  await new Promise((r) => setTimeout(r, 100))
  expect(promptCalls).toHaveLength(0)
})

test('read-only history matches the live mapping — tool rows included', async () => {
  const harness = await makeManager()
  await harness.manager.bind()
  const meta = await harness.manager.openSkillThread('copy-edit')
  const agent = await harness.manager.activeReady()
  harness.queue.push(buildE2EScriptedTurn([{ cap: 'files.read', input: { path: 'a.md' } }]))
  await agent!.prompt('read it for me')
  const live = agent!.messages()
  await harness.manager.disposeAll()

  await writeFile(join(userData, 'skills', 'copy-edit', 'SKILL.md'), 'no frontmatter at all\n')
  const second = await makeManager()
  await second.manager.bind().catch(() => {})
  const restored = await second.manager.readThreadTranscript(meta.id)
  // Same mapping function, Pi's own branch resolution: the read-only view equals the live one.
  expect(restored.filter((m) => m.role === 'tool').length).toBe(live.filter((m) => m.role === 'tool').length)
  expect(restored.some((m) => m.role === 'tool')).toBe(true)
  expect(restored.map((m) => m.content)).toEqual(live.map((m) => m.content))
  await second.manager.disposeAll()
})

test('skillDisplayName renders CONTENT.md register', () => {
  expect(skillDisplayName('copy-edit')).toBe('Copy-edit')
  expect(skillDisplayName('review')).toBe('Review')
  expect(existsSync(root)).toBe(true)
})


test('a new chat uses Bridle’s recommendation and a retired saved model uses its saved-model resolver', async () => {
  const models = [{ provider: 'openai-codex', id: 'first-listed' }, { provider: 'openai-codex', id: 'recommended' }]
  const resolved: string[] = []
  const harness = await makeManager(undefined, {
    listedModels: { listed: models, available: models },
    modelService: {
      recommendedModel: () => 'recommended',
      resolveSavedModel: (_provider, saved) => { resolved.push(saved); return { modelId: 'recommended', reason: { code: 'saved-model-not-offered', savedId: saved, replacementId: 'recommended' } } },
    },
  })
  try {
    await harness.manager.bind(); await harness.manager.activeReady()
    expect(harness.manager.activeRecord()?.model?.id).toBe('recommended')
    const index = new ThreadIndex(join(userData, 'threads', 'index.json'))
    await index.add({ id: 'retired', workspaceRoot: root, kind: 'chat', title: 'Saved', createdAt: 1, lastActiveAt: 1, model: { provider: 'openai-codex', id: 'retired-model' }, thinkingLevel: 'medium' })
    // The manager keeps its index in memory: create a cold manager to model reopening the saved chat.
    await harness.manager.disposeAll()
    const reopened = await makeManager(undefined, {
      listedModels: { listed: models, available: models },
      modelService: {
        recommendedModel: () => 'recommended',
        resolveSavedModel: (_provider, saved) => { resolved.push(saved); return { modelId: 'recommended' } },
      },
    })
    try {
      await reopened.manager.bind(); await reopened.manager.activate('retired'); await reopened.manager.activeReady()
      expect(resolved).toContain('retired-model')
      expect(reopened.manager.activeRecord()?.model?.id).toBe('recommended')
      expect(reopened.manager.activeModelNotice()).toContain('retired-model is no longer available')
    } finally { await reopened.manager.disposeAll() }
  } finally { await harness.manager.disposeAll() }
})


test('scoped scripted turns do not enable deferred tools when their catalogue is already small', async () => {
  const harness = await makeManager()
  try {
    await harness.manager.bind(); await harness.manager.activeReady()
    await harness.manager.openSkillThread('copy-edit')
    const agent = await harness.manager.activeReady()
    expect(agent).toBeTruthy()
    const script = agent!.scriptedTurn([{ cap: 'files.read', input: { path: 'a.md' } }])
    expect(script.rounds).toHaveLength(2)
    expect(script.rounds[0]).toMatchObject({ kind: 'tool-calls', calls: [{ name: 'files.read' }] })
  } finally { await harness.manager.disposeAll() }
})
