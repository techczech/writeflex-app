import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability, CapabilityContext } from '@bridle/core'
import {
  agentNoteContent, createAgentNote, createFileNoteRefusal, deriveAgentNotePath, normaliseNoteKind, resolveNoteSource,
} from '../../src/main/agent-note-create'
import { buildWriteFlexManifest, capabilityEnabled } from '../../src/main/capabilities'
import { parseFrontmatter } from '../../src/main/frontmatter'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace
const ctx: CapabilityContext = {
  trigger: { id: 't', source: 'user', trust: 'interactive' },
  sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {},
}
function cap(name: string, skill?: string): Capability {
  const found = buildWriteFlexManifest(ws, undefined, skill ? { activeSkillName: skill } : undefined).capabilities.find((c) => c.name === name)
  if (!found) throw new Error(`missing capability ${name}`)
  return found
}
const at = new Date('2026-09-12T14:05:30.000Z')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-note-create-'))
  ws = new Workspace(root)
  await mkdir(join(root, 'essays'), { recursive: true })
  await writeFile(join(root, 'essays', 'metaphor.md'), '# Metaphor\n\nA partial mapping.\n', 'utf8')
  await writeFile(join(root, 'draft.md'), '# Draft\n', 'utf8')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test('the note path is derived from the source document: agent-notes/ beside it, <stem>.<kind>.md', () => {
  const none = (): boolean => false
  expect(deriveAgentNotePath('essays/metaphor.md', 'review', none, at)).toBe('essays/agent-notes/metaphor.review.md')
  expect(deriveAgentNotePath('draft.md', undefined, none, at)).toBe('agent-notes/draft.notes.md')
  expect(deriveAgentNotePath('draft', 'Peer Review', none, at)).toBe('agent-notes/draft.peer-review.md')
  expect(normaliseNoteKind('   ')).toBe('notes')
})

test('a colliding note name takes a minute stamp, and a counter when the stamp collides too', () => {
  const taken = new Set(['essays/agent-notes/metaphor.review.md'])
  const exists = (path: string): boolean => taken.has(path)
  const stamped = deriveAgentNotePath('essays/metaphor.md', 'review', exists, at)
  expect(stamped).toBe('essays/agent-notes/metaphor.review.20260912-1405.md')
  taken.add(stamped)
  expect(deriveAgentNotePath('essays/metaphor.md', 'review', exists, at)).toBe('essays/agent-notes/metaphor.review.20260912-1405-2.md')
})

test('the note carries agent-authored frontmatter that names the source document and the skill', () => {
  const content = agentNoteContent(
    { sourceDocument: 'essays/metaphor.md', kind: 'review', body: 'Verdict: the mapping is asserted, not shown.' },
    'essays/agent-notes/metaphor.review.md', 'essays/metaphor.md', { skill: 'review', now: at },
  )
  const frontmatter = parseFrontmatter(content)
  expect(frontmatter?.title).toBe('Review of metaphor')
  expect(frontmatter?.author).toBe('agent')
  expect(frontmatter?.extra).toMatchObject({
    agent_note_kind: 'review', source_document: 'essays/metaphor.md', created: '2026-09-12T14:05:30.000Z', skill: 'review',
  })
  expect(content.endsWith('Verdict: the mapping is asserted, not shown.\n')).toBe(true)
  // No skill run → no skill key; an explicit title wins over the default.
  const plain = parseFrontmatter(agentNoteContent({ sourceDocument: 'draft.md', title: 'Notes on the draft', body: 'x' }, 'agent-notes/draft.notes.md', 'draft.md', { now: at }))
  expect(plain?.title).toBe('Notes on the draft')
  expect(plain?.extra.skill).toBeUndefined()
  expect(plain?.extra.agent_note_kind).toBe('notes')
})

test('refuses a source outside the workspace, inside agent-notes/, or missing', async () => {
  expect(() => resolveNoteSource(ws, '../outside.md')).toThrow(/outside the open Workspace/)
  await ws.createFile('essays/agent-notes/metaphor.review.md', '# Note\n')
  expect(() => resolveNoteSource(ws, 'essays/agent-notes/metaphor.review.md')).toThrow(/itself an agent note/)
  expect(() => resolveNoteSource(ws, 'essays/nowhere.md')).toThrow(/does not exist/)
  await expect(createAgentNote(ws, { sourceDocument: 'draft.md', body: '   ' })).rejects.toThrow(/body must not be empty/)
})

test('notes.create writes the note under agent-notes/ with skill provenance and returns its path', async () => {
  const create = cap('notes.create', 'review')
  const input = { sourceDocument: 'essays/metaphor.md', kind: 'review', body: '1. §2 asserts partiality without a failing case.' }
  const touched = await create.touchedPaths!(input)
  expect(touched).toEqual([join(root, 'essays/agent-notes/metaphor.review.md')])
  const result = await create.execute(input, { ...ctx, resolvedTouchedPaths: Object.freeze(touched) })
  expect(result.isError).toBeUndefined()
  expect(result.text).toBe('Left an agent note at essays/agent-notes/metaphor.review.md.')
  const written = await readFile(join(root, 'essays/agent-notes/metaphor.review.md'), 'utf8')
  const frontmatter = parseFrontmatter(written)
  expect(frontmatter?.author).toBe('agent')
  expect(frontmatter?.extra).toMatchObject({ agent_note_kind: 'review', source_document: 'essays/metaphor.md', skill: 'review' })
  expect(typeof frontmatter?.extra.created).toBe('string')
  // The second review of the same document does not overwrite the first.
  const again = await create.execute(input, ctx)
  expect(again.isError).toBeUndefined()
  expect(again.text).toMatch(/metaphor\.review\.\d{8}-\d{4}\.md\.$/)
  expect(existsSync(join(root, 'essays/agent-notes/metaphor.review.md'))).toBe(true)
  expect(await readFile(join(root, 'essays/agent-notes/metaphor.review.md'), 'utf8')).toBe(written)
})

test('notes.create refuses a source outside the workspace or inside agent-notes/ with a clear error', async () => {
  const create = cap('notes.create')
  const outside = await create.execute({ sourceDocument: '../elsewhere.md', body: 'x' }, ctx)
  expect(outside.isError).toBe(true)
  expect(outside.text).toMatch(/outside the open Workspace/)
  await ws.createFile('agent-notes/draft.notes.md', '# Existing\n')
  const nested = await create.execute({ sourceDocument: 'agent-notes/draft.notes.md', body: 'x' }, ctx)
  expect(nested.isError).toBe(true)
  expect(nested.text).toMatch(/itself an agent note/)
  expect(capabilityEnabled('notes.create', (key) => key === 'permissions.createFiles' ? false : undefined)).toBe(false)
})

test('housekeeping.create_file refuses ONLY agent-note-named files and names notes.create', async () => {
  expect(createFileNoteRefusal('essays/metaphor.review.md')).toMatch(/named like an agent note.*notes\.create/)
  expect(createFileNoteRefusal('Essays/Metaphor.COMMENTS.md')).toMatch(/notes\.create/)
  expect(createFileNoteRefusal('draft.notes.md')).toMatch(/notes\.create/)
  expect(createFileNoteRefusal('draft.feedback')).toMatch(/notes\.create/)
  // Real pieces are untouched: plain names, and dotted names beside their sibling document.
  expect(createFileNoteRefusal('essays/second-essay.md')).toBeNull()
  expect(createFileNoteRefusal('essays/v1.2-plan.md')).toBeNull()
  expect(createFileNoteRefusal('essays/metaphor.critique.md')).toBeNull()

  const create = cap('housekeeping.create_file')
  const refused = await create.execute({ path: 'essays/metaphor.review.md', content: '# Review\n' }, ctx)
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('notes.create')
  expect(existsSync(join(root, 'essays/metaphor.review.md'))).toBe(false)
  await ws.createFile('chapter.md', '# Chapter\n')
  const sibling = await create.execute({ path: 'chapter.draft.md', content: '# Chapter draft\n' }, ctx)
  expect(sibling.isError).toBeUndefined()
  expect(existsSync(join(root, 'chapter.draft.md'))).toBe(true)
  const allowed = await create.execute({ path: 'essays/second-essay.md', content: '# Second\n' }, ctx)
  expect(allowed.isError).toBeUndefined()
})
