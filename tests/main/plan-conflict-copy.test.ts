import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPlan } from '../../src/main/plan'
import { readPlanForAgent } from '../../src/main/plan-agent-reads'
import { Workspace } from '../../src/main/workspace'
import { isConflictCopyOf, preferOriginal } from '../../src/shared/conflict-copy'

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-plan-conflict-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

const dir = 'notes-towards-ai-strategy'

/** Fictional report: part 1 and its conflict copy from a second device share one `# Title`. */
async function seedRealCase(): Promise<void> {
  await write(`${dir}/00_strategy-framework.md`, '# Framework for Community Garden Planning\n\nThe original, longer part.\n\nTreat the strategy as a whole.\n')
  await write(`${dir}/00_strategy-framework-Studio Mac.md`, '# Framework for Community Garden Planning\n\nThe copy.\n')
  await write(`${dir}/01_shared-language.md`, '# Shared language for garden planning\n\nWords.\n')
  await write(
    `${dir}/_notes-towards-ai-strategy_INDEX.md`,
    '# Notes towards a garden plan\n\n## Running order\n\n- [[Framework for Community Garden Planning]]\n- [[Shared language for garden planning]]\n',
  )
}

test('the running-order line resolves to the original, not the conflict copy that sorts first', async () => {
  await seedRealCase()
  // The copy really does sort first: this is why the wikilink tie-break alone picked it.
  expect(['00_strategy-framework.md', '00_strategy-framework-Studio Mac.md'].sort((a, b) => a.localeCompare(b))[0])
    .toBe('00_strategy-framework-Studio Mac.md')
  const plan = await readPlan(ws, dir)
  expect(plan?.parts.map((part) => part.path)).toEqual([
    `${dir}/00_strategy-framework.md`,
    `${dir}/01_shared-language.md`,
  ])
})

test('the agent read lists the conflict copy as a stray and the original as the part', async () => {
  await seedRealCase()
  const readout = await readPlanForAgent(ws, dir)
  expect(readout.parts[0].path).toBe(`${dir}/00_strategy-framework.md`)
  expect(readout.strays.map((stray) => stray.path)).toEqual([`${dir}/00_strategy-framework-Studio Mac.md`])
})

test('a conflict copy still resolves when it is the only file with the title', async () => {
  await write(`${dir}/00_strategy-framework-Studio Mac.md`, '# Framework for Community Garden Planning\n')
  await write(`${dir}/_notes-towards-ai-strategy_INDEX.md`, '# N\n\n## Running order\n\n- [[Framework for Community Garden Planning]]\n')
  const plan = await readPlan(ws, dir)
  expect(plan?.parts[0].path).toBe(`${dir}/00_strategy-framework-Studio Mac.md`)
})

test('isConflictCopyOf: a machine suffix is a copy; a numeric sibling or another folder is not', () => {
  expect(isConflictCopyOf('r/00_intro-Studio Mac.md', 'r/00_intro.md')).toBe(true)
  expect(isConflictCopyOf('r/00_intro (Studio\'s conflicted copy 2026-09-01).md', 'r/00_intro.md')).toBe(true)
  expect(isConflictCopyOf('r/00_intro-2.md', 'r/00_intro.md')).toBe(false)
  expect(isConflictCopyOf('s/00_intro-Studio.md', 'r/00_intro.md')).toBe(false)
  expect(isConflictCopyOf('r/00_intro.md', 'r/00_intro-Studio.md')).toBe(false)
  expect(preferOriginal(['r/a-Studio.md', 'r/a.md'])).toBe('r/a.md')
  expect(preferOriginal(['r/b.md', 'r/a.md'])).toBe('r/b.md')
})
