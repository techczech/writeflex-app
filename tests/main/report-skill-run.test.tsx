import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { scriptedSessionFactory } from '@bridle/core'
import {
  WorkspaceAgent,
  isRunAsIsInstruction,
  mapSessionMessages,
  runAsIsInstruction,
  RUN_AS_IS_INSTRUCTION,
  type ScriptedTurn,
} from '../../src/main/agent'
import { SkillsRegistry } from '../../src/main/skills'
import { ThreadIndex, ThreadManager } from '../../src/main/threads'
import { Workspace } from '../../src/main/workspace'
import { PlanProposalCard, type PlanProposalCardActions } from '../../src/renderer/src/components/PlanProposalCard'
import { emptyPlanCard, reducePlanCard } from '../../src/renderer/src/hooks/plan-proposal-cards'

/**
 * Ticket 10, journey 1 end to end on the scripted agent: the SHIPPED report-structure skill is seeded
 * from resources/skills, a thread is opened on it exactly as the three launch points do (openSkill,
 * then the empty run-as-is turn naming the folder), and the scripted model drives the real plan verbs.
 * The scripted factory runs the same skill scoping as live (bridle S8), so a tool the skill does not
 * list could not execute here. On a folder with a conflict copy the first turn advises and stages
 * nothing; after "leave it out" one running-order proposal is staged and the card renders it.
 */

let root: string
let userData: string
let manager: ThreadManager | null

const dir = 'notes-towards-ai-strategy'
const indexPath = `${dir}/_notes-towards-ai-strategy_INDEX.md`
const COVER = '# Notes towards a garden plan\n\nCover prose stays exactly as written.\n'
const original = `${dir}/00_strategy-framework.md`
const copy = `${dir}/00_strategy-framework-Studio Mac.md`

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-report-skill-root-'))
  userData = await mkdtemp(join(tmpdir(), 'wf-report-skill-data-'))
  manager = null
  await write(indexPath, COVER)
  await write(original, '# Framework for Community Garden Planning\n\nThe original.\n\nShared closing.\n')
  await write(copy, '# Framework for Community Garden Planning\n\nThe original.\n\nA passage only the copy has.\n\nShared closing.\n')
  await write(`${dir}/01_shared-language.md`, '# Shared language for garden planning\n\nWords we share.\n')
  await write(`${dir}/02_key-strategic-moves.md`, '# Key strategic moves\n\nMoves.\n')
})

afterEach(async () => {
  await manager?.disposeAll()
  await rm(root, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true })
})

const actions: PlanProposalCardActions = {
  onLoad: () => {}, onAccept: () => {}, onEdit: () => {}, onCancelEdit: () => {}, onDiscard: () => {},
  onDrop: () => {}, onRestore: () => {}, onDrag: () => {}, onUndo: () => {}, onProposeAgain: () => {},
}

test('the folder run-as-is text names the folder and never reaches the visible transcript', () => {
  const text = runAsIsInstruction(dir)
  expect(text).toContain(`"${dir}"`)
  expect(isRunAsIsInstruction(text)).toBe(true)
  expect(isRunAsIsInstruction(RUN_AS_IS_INSTRUCTION)).toBe(true)
  expect(runAsIsInstruction()).toBe(RUN_AS_IS_INSTRUCTION)
  // A folder name with quotes stays one JSON string, so the text still reads as the instruction.
  expect(isRunAsIsInstruction(runAsIsInstruction('Reports/"Draft" 2'))).toBe(true)
  // The writer's own words are never mistaken for it.
  expect(isRunAsIsInstruction('Carry out your skill instructions on the folder reports now')).toBe(false)
  const rows = mapSessionMessages([
    { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
    { role: 'user', content: [{ type: 'text', text: 'leave it out' }], timestamp: 2 },
  ])
  expect(rows.map((row) => row.content)).toEqual(['leave it out'])
})

test('with a conflict copy the first turn advises and stages nothing; after "leave it out" the card appears', async () => {
  const skills = new SkillsRegistry({ appDataDir: userData, bundledSkillsDir: resolve('resources/skills') })
  await skills.init()
  const queue: ScriptedTurn[] = [
    {
      prompt: runAsIsInstruction(dir),
      rounds: [
        { kind: 'tool-calls', calls: [{ name: 'plan.read', arguments: { dir } }] },
        { kind: 'tool-calls', calls: [{ name: 'plan.compare_parts', arguments: { dir, a: original, b: copy } }] },
        { kind: 'message', text: 'Two files are near-identical: the copy has one passage the original lacks. Shall I leave the copy out of the running order?' },
      ],
    },
    {
      prompt: 'leave it out',
      rounds: [
        {
          kind: 'tool-calls',
          calls: [{
            name: 'plan.propose',
            arguments: {
              dir,
              changes: [
                { op: 'insert', title: 'Framework for Community Garden Planning' },
                { op: 'insert', title: 'Shared language for garden planning' },
                { op: 'insert', title: 'Key strategic moves' },
              ],
            },
          }],
        },
        { kind: 'message', text: 'Proposed a running order of three parts; the copy stays outside it.' },
      ],
    },
  ]
  const prompts: string[] = []
  let active: WorkspaceAgent | null = null
  manager = new ThreadManager({
    userDataDir: userData,
    workspaceRoot: root,
    index: new ThreadIndex(join(userData, 'threads', 'index.json')),
    skills,
    defaults: () => ({}),
    applyModel: async () => {},
    currentModelAfterApply: (_agent, provider, modelId) => ({ provider, id: modelId }),
    machineInstructionsPath: join(userData, 'no-such-instructions.md'),
    createAgent: async ({ appDataDir, composition, defaults }) => {
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
      agent.prompt = (text, activeFile, collection) => {
        prompts.push(text)
        return prompt(text, activeFile, collection)
      }
      return agent
    },
    onActiveChanged: (agent) => { active = agent },
  })

  // The launch: a new thread bound to the shipped skill, then the empty turn on the folder.
  const meta = await manager.openSkillThread('report-structure')
  expect(meta.skillName).toBe('report-structure')
  const agent = await manager.activeReady()
  expect(agent).toBe(active!)

  const first = await agent!.prompt(runAsIsInstruction(dir), null)
  expect(prompts[0]).toBe(runAsIsInstruction(dir))
  expect(first.suggestions).toEqual([])
  // The instruction is hidden; the plan tools ran for real on the folder (the copy is a stray, and
  // the comparison names the passage only the copy has); the reply advises.
  expect(first.messages.filter((message) => message.role === 'user')).toEqual([])
  const tools = first.messages.filter((message) => message.role === 'tool').map((message) => message.content)
  expect(tools).toHaveLength(2)
  expect(tools[0]).toContain('00_strategy-framework-Studio Mac.md')
  expect(tools[0]).toContain('"hasIndexNote": true')
  expect(tools[1]).toContain('A passage only the copy has.')
  expect(first.messages.at(-1)).toMatchObject({ role: 'assistant' })
  expect(first.messages.at(-1)?.content).toContain('Shall I leave the copy out')
  expect(await readFile(join(root, indexPath), 'utf8')).toBe(COVER)

  const second = await agent!.prompt('leave it out', null)
  const staged = second.suggestions.filter((suggestion) => suggestion.capabilityName === 'plan.propose')
  expect(staged).toHaveLength(1)
  // Staged, not written: the Index Note is untouched until the writer accepts.
  expect(await readFile(join(root, indexPath), 'utf8')).toBe(COVER)
  const view = await agent!.planProposalView(staged[0].id)
  expect(view?.status).toBe('pending')
  expect(view?.dir).toBe(dir)
  expect(view?.basis.strays.map((stray) => stray.path)).toContain(copy)

  const html = renderToStaticMarkup(<PlanProposalCard card={reducePlanCard(emptyPlanCard(staged[0].id), { type: 'loaded', view: view! })} actions={actions} />)
  expect(html).toContain('Proposed running order <span>3 changes</span>')
  expect(html).toContain('00_strategy-framework-Studio Mac')
  expect(html).toContain('Use this order')
})
