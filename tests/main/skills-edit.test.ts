import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, type ScriptedTurn } from '../../src/main/agent'
import {
  SkillsRegistry,
  parseSkillApplyEditInput,
  parseSkillOpenForEditingInput,
  parseSkillProposeEditInput,
} from '../../src/main/skills'
import { ThreadIndex, ThreadManager } from '../../src/main/threads'
import { Workspace } from '../../src/main/workspace'
import { resolveWorkspaceRoot } from '../../src/main/root-resolution'

let workspaceRoot: string
let userDataDir: string
let bundledSkillsDir: string

const currentSkill = `---
name: copy-edit
description: Tightens prose.
tools: [files.read, prose.edit]
input: document
---

Keep the writer's voice.
`

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'wf-skill-edit-workspace-'))
  userDataDir = await mkdtemp(join(tmpdir(), 'wf-skill-edit-data-'))
  bundledSkillsDir = await mkdtemp(join(tmpdir(), 'wf-skill-edit-bundled-'))
  await mkdir(join(bundledSkillsDir, 'copy-edit'), { recursive: true })
  await writeFile(join(bundledSkillsDir, 'copy-edit', 'SKILL.md'), currentSkill)
})

afterEach(async () => {
  await Promise.all([
    rm(workspaceRoot, { recursive: true, force: true }),
    rm(userDataDir, { recursive: true, force: true }),
    rm(bundledSkillsDir, { recursive: true, force: true }),
  ])
})

async function registry(): Promise<SkillsRegistry> {
  const skills = new SkillsRegistry({ appDataDir: userDataDir, bundledSkillsDir })
  await skills.init()
  return skills
}

async function managerWithReply(reply: string): Promise<{
  manager: ThreadManager
  prompts: string[]
  compositions: unknown[]
  disposals: { abort: number; dispose: number }
}> {
  const skills = await registry()
  const prompts: string[] = []
  const compositions: unknown[] = []
  const disposals = { abort: 0, dispose: 0 }
  const manager = new ThreadManager({
    userDataDir,
    workspaceRoot,
    index: new ThreadIndex(join(userDataDir, 'threads', 'index.json')),
    skills,
    machineInstructionsPath: join(userDataDir, 'missing-machine-instructions.md'),
    createAgent: async ({ appDataDir, composition }) => {
      compositions.push(composition)
      const queue: ScriptedTurn[] = [{
        prompt: '<skill edit test>',
        rounds: [{ kind: 'message', text: reply }],
      }]
      const agent = await WorkspaceAgent.create({
        workspace: new Workspace(workspaceRoot),
        appDataDir,
        composition,
        sessionFactory: scriptedSessionFactory(queue),
        onTrace: () => {},
        onApprovalRequest: () => {},
        onSuggestionsChanged: () => {},
      })
      const prompt = agent.prompt.bind(agent)
      agent.prompt = (text, activeFile) => {
        prompts.push(text)
        return prompt(text, activeFile)
      }
      const abort = agent.abort.bind(agent)
      agent.abort = async () => { disposals.abort += 1; await abort() }
      const dispose = agent.dispose.bind(agent)
      agent.dispose = async () => { disposals.dispose += 1; await dispose() }
      return agent
    },
    onActiveChanged: () => {},
  })
  return { manager, prompts, compositions, disposals }
}

test('proposes a complete fenced SKILL.md from the current file and request, then disposes the throwaway', async () => {
  const proposed = currentSkill.replace("Keep the writer's voice.", 'Keep long sentences intact.')
  const harness = await managerWithReply(`\`\`\`markdown\n${proposed}\`\`\``)

  const result = await harness.manager.proposeSkillEdit('copy-edit', 'Never split my long sentences.')

  expect(result).toEqual({ current: currentSkill, proposed })
  expect(harness.prompts).toHaveLength(1)
  expect(harness.prompts[0]).toContain(currentSkill)
  expect(harness.prompts[0]).toContain('Never split my long sentences.')
  expect(harness.compositions).toHaveLength(1)
  expect(harness.compositions[0]).not.toHaveProperty('activeSkill')
  expect(harness.disposals).toEqual({ abort: 1, dispose: 1 })
  // review finding B5 review r1+r2: settlement means the scratch dir is GONE — cleanup is completion-bound,
  // not fire-and-forget, so a shutdown right after settle can't strand a tree.
  const threadDirs = await readdir(join(userDataDir, 'threads')).catch(() => [] as string[])
  expect(threadDirs.some((name) => name.startsWith('skill-edit-'))).toBe(false)
})

test('an unparseable proposal uses the designed failure and still disposes exactly once', async () => {
  const harness = await managerWithReply('I suggest adding a sentence about long sentences.')

  await expect(harness.manager.proposeSkillEdit('copy-edit', 'Keep sentences intact.'))
    .rejects.toThrow('The agent could not propose a change — try rephrasing.')
  expect(harness.disposals).toEqual({ abort: 1, dispose: 1 })
  // The failure path shares the same completion-bound cleanup.
  const threadDirs = await readdir(join(userDataDir, 'threads')).catch(() => [] as string[])
  expect(threadDirs.some((name) => name.startsWith('skill-edit-'))).toBe(false)
})

test('proposal parsing honours a longer outer fence around nested triple-backtick examples', async () => {
  const proposed = `${currentSkill}\nExample:\n\`\`\`text\ninside\n\`\`\`\n`
  const harness = await managerWithReply(`\`\`\`\`markdown\n${proposed}\`\`\`\``)

  expect((await harness.manager.proposeSkillEdit('copy-edit', 'Add an example.')).proposed).toBe(proposed)
})

test('proposal parsing supports tilde fences and preserves CRLF content', async () => {
  const proposed = currentSkill.replaceAll('\n', '\r\n')
  const harness = await managerWithReply(`~~~~markdown\r\n${proposed}~~~~\r\n`)

  expect((await harness.manager.proposeSkillEdit('copy-edit', 'Keep CRLF.')).proposed).toBe(proposed)
})

test('proposal parsing rejects an outer fence without a matching close', async () => {
  const harness = await managerWithReply(`\`\`\`\`markdown\n${currentSkill}\`\`\``)

  await expect(harness.manager.proposeSkillEdit('copy-edit', 'Do not accept a nested close.'))
    .rejects.toThrow('The agent could not propose a change — try rephrasing.')
})

test('a reply with TWO fenced blocks is ambiguous and fails to the designed copy (review finding P1)', async () => {
  const harness = await managerWithReply(`\`\`\`markdown\n${currentSkill}\`\`\`\nOr alternatively:\n\`\`\`markdown\nsomething else entirely\n\`\`\``)

  await expect(harness.manager.proposeSkillEdit('copy-edit', 'Pick one.'))
    .rejects.toThrow('The agent could not propose a change — try rephrasing.')
})

test('a same-length inner fence that splits the reply into two blocks is rejected, never half-applied', async () => {
  // The inner ``` closes the outer early; the residue parses as a second block → ambiguous.
  const harness = await managerWithReply(`\`\`\`markdown\n${currentSkill}Example:\n\`\`\`\ninside\n\`\`\`\n`)

  await expect(harness.manager.proposeSkillEdit('copy-edit', 'Add an example.'))
    .rejects.toThrow('The agent could not propose a change — try rephrasing.')
})

test('prose around ONE fenced block stays acceptable — models narrate', async () => {
  const proposed = currentSkill.replace("Keep the writer's voice.", 'Keep long sentences intact.')
  const harness = await managerWithReply(`Here is the revised file:\n\`\`\`markdown\n${proposed}\`\`\`\nLet me know if you want changes.`)

  expect((await harness.manager.proposeSkillEdit('copy-edit', 'Never split sentences.')).proposed).toBe(proposed)
})

test('parse helpers reject path-shaped skill names (review finding P2)', async () => {
  const { parseSkillProposeEditInput, parseSkillApplyEditInput, parseSkillOpenForEditingInput } = await import('../../src/main/skills')
  for (const name of ['a/b', '..', '../outside', 'a\\b', '.']) {
    expect(() => parseSkillProposeEditInput({ name, request: 'x' })).toThrow(/plain skill name/)
    expect(() => parseSkillApplyEditInput({ name, content: 'x' })).toThrow(/plain skill name/)
    expect(() => parseSkillOpenForEditingInput({ name })).toThrow(/plain skill name/)
  }
  // Only PATH syntax is rejected — the grammar stays as wide as the bridle loader's (review finding r2).
  for (const name of ['copy-edit', 'copy.edit', 'draft..review', 'résumé-review']) {
    expect(parseSkillOpenForEditingInput({ name })).toEqual({ name })
  }
})

test('disposeAll owns a proposal before delayed agent creation settles and waits for its teardown', async () => {
  const skills = await registry()
  let creationStarted!: () => void
  const started = new Promise<void>((resolve) => { creationStarted = resolve })
  let releaseCreation!: () => void
  const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve })
  const counts = { prompt: 0, abort: 0, dispose: 0 }
  const agent = {
    prompt: async () => { counts.prompt += 1; return { messages: [], suggestions: [] } },
    abort: async () => { counts.abort += 1 },
    dispose: async () => { counts.dispose += 1 },
  } as unknown as WorkspaceAgent
  const manager = new ThreadManager({
    userDataDir, workspaceRoot, skills,
    index: new ThreadIndex(join(userDataDir, 'threads', 'index.json')),
    machineInstructionsPath: join(userDataDir, 'missing-machine-instructions.md'),
    createAgent: async () => { creationStarted(); await creationGate; return agent },
    onActiveChanged: () => {},
  })
  const proposal = manager.proposeSkillEdit('copy-edit', 'Keep sentences intact.')
  proposal.catch(() => {})
  await started

  let teardownSettled = false
  const teardown = manager.disposeAll().then(() => { teardownSettled = true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const settledBeforeCreation = teardownSettled
  releaseCreation()
  await Promise.allSettled([proposal, teardown])

  expect(settledBeforeCreation).toBe(false)
  expect(counts).toEqual({ prompt: 0, abort: 1, dispose: 1 })
})

test('disposeAll aborts an active proposal prompt exactly once and waits for disposal', async () => {
  const skills = await registry()
  let promptStarted!: () => void
  const started = new Promise<void>((resolve) => { promptStarted = resolve })
  let releasePrompt!: () => void
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve })
  let releaseDispose!: () => void
  const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve })
  const counts = { abort: 0, dispose: 0 }
  const agent = {
    prompt: async () => {
      promptStarted()
      await promptGate
      return { messages: [{ role: 'assistant', content: `\`\`\`markdown\n${currentSkill}\`\`\``, createdAt: Date.now() }], suggestions: [] }
    },
    abort: async () => { counts.abort += 1; releasePrompt() },
    dispose: async () => { counts.dispose += 1; await disposeGate },
  } as unknown as WorkspaceAgent
  const manager = new ThreadManager({
    userDataDir, workspaceRoot, skills,
    index: new ThreadIndex(join(userDataDir, 'threads', 'index.json')),
    machineInstructionsPath: join(userDataDir, 'missing-machine-instructions.md'),
    createAgent: async () => agent,
    onActiveChanged: () => {},
  })
  const proposal = manager.proposeSkillEdit('copy-edit', 'Keep sentences intact.')
  proposal.catch(() => {})
  await started

  let teardownSettled = false
  const teardown = manager.disposeAll().then(() => { teardownSettled = true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const settledBeforeDisposal = teardownSettled
  releasePrompt()
  releaseDispose()
  await Promise.allSettled([proposal, teardown])

  expect(settledBeforeDisposal).toBe(false)
  expect(counts).toEqual({ abort: 1, dispose: 1 })
})

test('applyEdit snapshots once, atomically replaces SKILL.md, and reloads the new body', async () => {
  const skills = await registry()
  const proposed = currentSkill.replace("Keep the writer's voice.", 'Keep long sentences intact.')

  const applied = await skills.applyEdit('copy-edit', proposed)

  expect(await readFile(applied.source, 'utf8')).toBe(proposed)
  expect(await readFile(applied.backup, 'utf8')).toBe(currentSkill)
  expect((await readdir(dirname(applied.source))).filter((name) => name.startsWith('SKILL.md.bak-'))).toHaveLength(1)
  expect((await skills.get('copy-edit')).skill?.instructions).toBe('Keep long sentences intact.')
  expect((await readdir(dirname(applied.source))).some((name) => name.endsWith('.tmp'))).toBe(false)
})

test('resolveOpenForEditing returns the registered skills root and exact SKILL.md source', async () => {
  const skills = await registry()

  const target = await skills.resolveOpenForEditing('copy-edit')

  expect(target).toEqual({
    root: join(userDataDir, 'skills'),
    source: join(userDataDir, 'skills', 'copy-edit', 'SKILL.md'),
  })
  expect(resolveWorkspaceRoot(target.source, { home: userDataDir })).toBe(target.root)
  // Path-shaped names now die at the parse boundary (review finding B5 P2), before resolution even runs.
  await expect(skills.resolveOpenForEditing('../outside')).rejects.toThrow(/plain skill name|No skill named/)
})

test('only a current registry load error can cross the show-item absolute-path boundary', async () => {
  const skills = await registry()
  const malformed = join(userDataDir, 'skills', 'broken', 'SKILL.md')
  await mkdir(dirname(malformed), { recursive: true })
  await writeFile(malformed, 'No frontmatter here.\n')
  const loadError = (await skills.list()).errors.find((error) => error.source === malformed)

  expect(loadError).toBeDefined()
  expect(await skills.resolveRevealErrorSource(malformed)).toBe(malformed)
  await expect(skills.resolveRevealErrorSource(join(userDataDir, 'skills', 'copy-edit', 'SKILL.md')))
    .rejects.toThrow('not a current skill load error')
  await expect(skills.resolveRevealErrorSource(join(userDataDir, 'outside.md')))
    .rejects.toThrow('not a current skill load error')
})

test('flat registered skill files can be applied and opened safely', async () => {
  const skills = await registry()
  const flatSource = join(userDataDir, 'skills', 'flat-edit.md')
  const flatCurrent = currentSkill.replace('copy-edit', 'flat-edit')
  const flatProposed = flatCurrent.replace("Keep the writer's voice.", 'Keep every deliberate pause.')
  await writeFile(flatSource, flatCurrent)

  const applied = await skills.applyEdit('flat-edit', flatProposed)
  const target = await skills.resolveOpenForEditing('flat-edit')

  expect(applied.source).toBe(flatSource)
  expect(await readFile(applied.backup, 'utf8')).toBe(flatCurrent)
  expect(await readFile(flatSource, 'utf8')).toBe(flatProposed)
  expect(target).toEqual({ root: join(userDataDir, 'skills'), source: flatSource })
})

test('an empty apply payload fails before creating a backup or changing the source', async () => {
  const skills = await registry()
  const source = join(userDataDir, 'skills', 'copy-edit', 'SKILL.md')

  await expect(skills.applyEdit('copy-edit', '')).rejects.toThrow(/content/i)

  expect(await readFile(source, 'utf8')).toBe(currentSkill)
  expect((await readdir(dirname(source))).filter((name) => name.startsWith('SKILL.md.bak-'))).toEqual([])
})

test('IPC skill payload guards reject malformed objects and empty strings', () => {
  expect(() => parseSkillProposeEditInput(null)).toThrow(/propose-edit payload/i)
  expect(() => parseSkillProposeEditInput({ name: 'copy-edit', request: '   ' })).toThrow(/propose-edit payload/i)
  expect(() => parseSkillApplyEditInput({ name: '', content: currentSkill })).toThrow(/apply-edit payload/i)
  expect(() => parseSkillApplyEditInput({ name: 'copy-edit', content: '' })).toThrow(/apply-edit payload/i)
  expect(() => parseSkillOpenForEditingInput({ name: 42 })).toThrow(/open-for-editing payload/i)
})

test('overlapping applies serialise by source so the second backup contains the first edit', async () => {
  const skills = await registry()
  const first = currentSkill.replace("Keep the writer's voice.", 'Keep the first edit.')
  const second = currentSkill.replace("Keep the writer's voice.", 'Keep the second edit.')

  const [firstResult, secondResult] = await Promise.all([
    skills.applyEdit('copy-edit', first),
    skills.applyEdit('copy-edit', second),
  ])

  expect(await readFile(firstResult.backup, 'utf8')).toBe(currentSkill)
  expect(await readFile(secondResult.backup, 'utf8')).toBe(first)
  expect(await readFile(secondResult.source, 'utf8')).toBe(second)
})
