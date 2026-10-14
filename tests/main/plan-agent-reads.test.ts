import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from '@bridle/core'
import { MANIFEST_NAME } from '../../src/main/folio'
import { buildVerbTable } from '../../src/main/verbs'
import { Workspace } from '../../src/main/workspace'
import type { AgentPlanReadout, PartComparison } from '../../src/main/plan-agent-reads'

let root: string
let ws: Workspace

const ctx: CapabilityContext = {
  trigger: { id: 't', source: 'user', trust: 'interactive' },
  sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {},
}

const ORIGINAL = [
  '---', 'status: draft', '---',
  '# Introduction',
  '',
  'Shared opening line one.',
  'Only the original has this line.',
  'Shared closing line.',
  '- a list item',
  '  continued under the item',
  '',
].join('\n')

const CONFLICT_COPY = [
  '---', 'status: draft', '---',
  '# Intro',
  '',
  'Shared opening line one.',
  'Shared closing line.',
  'Only the copy has this paragraph, written on another device.',
  '- a list item',
  '  continued under the item',
  '',
].join('\n')

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

/** Every entry under the Workspace with its mtime: any write, create or delete changes this. */
async function treeState(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      out[absolute.slice(root.length + 1)] = (await stat(absolute)).mtimeMs
      if (entry.isDirectory()) await walk(absolute)
    }
  }
  await walk(root)
  return out
}

function verb(id: string) {
  const found = buildVerbTable(ws).find((entry) => entry.id === id)
  if (!found) throw new Error(`missing verb ${id}`)
  return found
}

async function run(id: string, input: Record<string, unknown>) {
  return verb(id).run(ctx, input as never)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-plan-agent-reads-'))
  ws = new Workspace(root)
  // A Folio with an Index Note: two written parts, an unwritten part, a stray, a conflict copy.
  await write('report/_report_INDEX.md', [
    '# Report', '', 'Cover text.', '', '## Running order', '',
    '- [[Introduction]] — Why this report exists',
    '- [[Method]] #appendix',
    '- [[Findings]]',
    '',
  ].join('\n'))
  await write(`report/${MANIFEST_NAME}`, `${JSON.stringify({
    schema_version: 1, content_root: '', files: [{ path: '00_intro.md', role: 'section' }, { path: '01_method.md', role: 'appendix' }],
  }, null, 2)}\n`)
  await write('report/00_intro.md', ORIGINAL)
  await write('report/00_intro-Studio Mac.md', CONFLICT_COPY)
  await write('report/01_method.md', '# Method\n\nWe asked three questions.\n')
  await write('report/notes-on-sources.md', '# Notes on sources\n\nA loose note.\n')
  // Never offered as parts: underscore files, agent notes, scraps.
  await write('report/_scratch.md', '# Scratch\n')
  await write('report/agent-notes/review-of-00_intro.md', '# Review\n\nFine.\n')
  await write('report/scraps/00_intro-SCRAPS.md', '- cut line\n')
  // His real report's shape: no Index Note, an empty manifest, a conflict copy.
  await write(`strategy/${MANIFEST_NAME}`, '{ "schema_version": 1, "files": [] }\n')
  await write('strategy/00_strategy-framework.md', '# Strategy framework\n\nFour areas.\n')
  await write('strategy/00_strategy-framework-Studio Mac.md', '# Strategy framework\n\nThree areas.\n')
  await write('strategy/01_understanding.md', '# Understanding AI\n')
  // A Folio whose parts live under content_root, one nested a level down.
  await write('book/_book_INDEX.md', '# Book\n\n## Running order\n\n1. [[Opening]]\n')
  await write(`book/${MANIFEST_NAME}`, '{ "schema_version": 1, "content_root": "contents", "files": [{ "path": "01-opening.md" }] }\n')
  await write('book/contents/01-opening.md', '---\ntitle: Opening\n---\nFirst words here.\n')
  await write('book/contents/extra/deep-stray.md', '# Deep stray\n\nNested.\n')
  await write('book/outside-content-root.md', '# Outside\n')
  await write('elsewhere.md', '# Elsewhere\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('plan.read lists the running order in order, weighs each part, and names strays and the Index Note', async () => {
  const result = await run('plan.read', { dir: 'report' })
  expect(result.isError).toBeFalsy()
  const readout = JSON.parse(result.text) as AgentPlanReadout
  expect(readout).toEqual((result.details as { plan: AgentPlanReadout }).plan)
  expect(readout).toEqual({
    dir: 'report',
    hasIndexNote: true,
    indexPath: 'report/_report_INDEX.md',
    contentRoot: '',
    parts: [
      { title: 'Introduction', gloss: 'Why this report exists', role: 'section', path: 'report/00_intro.md', words: 23, exists: true },
      { title: 'Method', gloss: null, role: 'appendix', path: 'report/01_method.md', words: 6, exists: true },
      { title: 'Findings', gloss: null, role: 'section', path: null, words: null, exists: false },
    ],
    strays: [
      { path: 'report/00_intro-Studio Mac.md', title: 'Intro', words: 27 },
      { path: 'report/notes-on-sources.md', title: 'Notes on sources', words: 7 },
    ],
  })
})

test('plan.read on a folder with no Index Note and an empty manifest reports every file as a stray', async () => {
  const readout = JSON.parse((await run('plan.read', { dir: 'strategy' })).text) as AgentPlanReadout
  expect(readout.hasIndexNote).toBe(false)
  expect(readout.indexPath).toBeNull()
  expect(readout.parts).toEqual([])
  expect(readout.strays.map((stray) => stray.path)).toEqual([
    'strategy/00_strategy-framework-Studio Mac.md',
    'strategy/00_strategy-framework.md',
    'strategy/01_understanding.md',
  ])
})

test('plan.read looks for strays recursively under content_root and nowhere else', async () => {
  const readout = JSON.parse((await run('plan.read', { dir: 'book' })).text) as AgentPlanReadout
  expect(readout.contentRoot).toBe('contents')
  expect(readout.parts).toEqual([
    { title: 'Opening', gloss: null, role: 'section', path: 'book/contents/01-opening.md', words: 3, exists: true },
  ])
  expect(readout.strays).toEqual([{ path: 'book/contents/extra/deep-stray.md', title: 'Deep stray', words: 4 }])
})

test('plan.compare_parts on a conflict-copy pair returns exactly the passages unique to each side, in order', async () => {
  const result = await run('plan.compare_parts', {
    dir: 'report', a: 'report/00_intro.md', b: 'report/00_intro-Studio Mac.md',
  })
  expect(result.isError).toBeFalsy()
  const comparison = JSON.parse(result.text) as PartComparison
  expect(comparison).toEqual((result.details as { comparison: PartComparison }).comparison)
  expect(comparison.passages).toEqual([
    { side: 'a', text: '# Introduction', line: 4, words: 2 },
    { side: 'b', text: '# Intro', line: 4, words: 2 },
    { side: 'a', text: 'Only the original has this line.', line: 7, words: 6 },
    { side: 'b', text: 'Only the copy has this paragraph, written on another device.', line: 8, words: 10 },
  ])
  expect(comparison.a).toMatchObject({ path: 'report/00_intro.md', words: 23 })
  expect(comparison.b).toMatchObject({ path: 'report/00_intro-Studio Mac.md', words: 27 })
  expect(typeof comparison.a.modifiedAt).toBe('number')
  expect(comparison.larger).toBe('b')
  expect(comparison.identical).toBe(false)
  expect(comparison.frontmatterDiffers).toBe(false)
  // Shared: 4 + 3 + 8 words (opening, closing, list item with its continuation) of 23 + 27.
  expect(comparison.similarity).toBe(0.6)
})

test('plan.compare_parts calls two identical bodies identical and still reports a frontmatter-only difference', async () => {
  await write('report/twin.md', ORIGINAL)
  const same = JSON.parse((await run('plan.compare_parts', { dir: 'report', a: 'report/00_intro.md', b: 'report/twin.md' })).text) as PartComparison
  expect(same).toMatchObject({ passages: [], similarity: 1, larger: 'equal', identical: true, frontmatterDiffers: false })
  await write('report/twin.md', ORIGINAL.replace('status: draft', 'status: final'))
  const metadata = JSON.parse((await run('plan.compare_parts', { dir: 'report', a: 'report/00_intro.md', b: 'report/twin.md' })).text) as PartComparison
  expect(metadata).toMatchObject({ passages: [], identical: false, frontmatterDiffers: true })
})

test('both verbs refuse a path outside dir or the Workspace with a readable error', async () => {
  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ['plan.read', { dir: '../outside' }, /dir "\.\.\/outside" is outside the open Workspace\./],
    ['plan.read', { dir: '/etc' }, /absolute path/],
    ['plan.read', { dir: 'missing-folder' }, /is not a folder in the open Workspace/],
    ['plan.compare_parts', { dir: '../outside', a: 'x.md', b: 'y.md' }, /outside the open Workspace/],
    ['plan.compare_parts', { dir: 'report', a: 'report/00_intro.md', b: 'strategy/01_understanding.md' },
      /b "strategy\/01_understanding\.md" is not inside the folder "report"/],
    ['plan.compare_parts', { dir: 'report', a: 'elsewhere.md', b: 'report/00_intro.md' }, /a "elsewhere\.md" is not inside the folder "report"/],
    ['plan.compare_parts', { dir: 'report', a: 'report/../../../etc/passwd', b: 'report/00_intro.md' }, /outside the open Workspace/],
    ['plan.compare_parts', { dir: 'report', a: 'report/00_intro.md', b: 'report/../strategy/01_understanding.md' }, /not inside the folder "report"/],
    ['plan.compare_parts', { dir: 'report', a: 'report/00_intro.md', b: 'report/00_intro.md' }, /the same file/],
    ['plan.compare_parts', { dir: 'report', a: 'report/00_intro.md', b: 'report/nope.md' }, /does not exist/],
  ]
  for (const [id, input, message] of refusals) {
    const result = await run(id, input)
    expect(result.isError, `${id} ${JSON.stringify(input)}`).toBe(true)
    expect(result.text).toMatch(message)
  }
})

test('neither verb writes anything: the fixture tree and its mtimes are unchanged', async () => {
  const before = await treeState()
  await run('plan.read', { dir: 'report' })
  await run('plan.read', { dir: 'strategy' })
  await run('plan.read', { dir: 'book' })
  await run('plan.read', { dir: '' })
  await run('plan.read', { dir: '../outside' })
  await run('plan.compare_parts', { dir: 'report', a: 'report/00_intro.md', b: 'report/00_intro-Studio Mac.md' })
  await run('plan.compare_parts', { dir: 'strategy', a: 'strategy/00_strategy-framework.md', b: 'strategy/00_strategy-framework-Studio Mac.md' })
  await run('plan.compare_parts', { dir: 'report', a: 'report/00_intro.md', b: 'strategy/01_understanding.md' })
  expect(await treeState()).toEqual(before)
  expect(ws.wasRecentlyWrittenByApp('report/_report_INDEX.md')).toBe(false)
  expect(ws.wasRecentlyWrittenByApp(`report/${MANIFEST_NAME}`)).toBe(false)
})

test('both verbs are read-only, direct-posture, agent-only registry entries without touched paths', () => {
  for (const id of ['plan.read', 'plan.compare_parts']) {
    const entry = verb(id)
    expect(entry).toMatchObject({ class: 'content', posture: 'direct', agentOnly: true, risk: 'read' })
    expect(entry.touchedPaths).toBeUndefined()
    expect(entry.preview).toBeUndefined()
  }
})

test('a symlink inside dir that points out of the Workspace is refused as outside it', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'wf-plan-agent-reads-outside-'))
  try {
    await writeFile(join(outside, 'secret.md'), '# Secret\n')
    await symlink(join(outside, 'secret.md'), join(root, 'report', 'escape.md'))
    const result = await run('plan.compare_parts', { dir: 'report', a: 'report/00_intro.md', b: 'report/escape.md' })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/b "report\/escape\.md" is outside the open Workspace\./)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})
