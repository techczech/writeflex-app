import { test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { draftManifest, fallbackFolioParts, folioPieces, isFolioAgentInstructionsFile, MANIFEST_NAME, orderFor } from '../../src/main/folio'
import { assessManifestOnly, manifestOnlyAddable, readManifestOnly } from '../../src/main/folio-manifest-order'
import { folioOrderFacts } from '../../src/main/folio-order-facts'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { folioOutline } from '../../src/main/folio-outline'
import { folioPlace, invalidateFolioPlaces } from '../../src/main/folio-place'
import { assertManifestFallbackOrder, readPlan } from '../../src/main/plan'
import { collectionPieces, listCollection } from '../../src/main/collection'
import { evaluateCollectionQuery } from '../../src/main/query-engine'
import { computeCollectionDigest } from '../../src/main/digest'
import { exportBundle } from '../../src/main/export'
import { writeFolioAgentInstructions } from '../../src/main/folio-agent-instructions'
import { isAgentInstructionsName } from '../../src/shared/folio-agent-files'
import { groupAlsoInFolder } from '../../src/shared/folio-outline'
import { folioPlaceFacts } from '../../src/shared/folio-place'

// The never-a-part rule (spec 2026-10-14, "What must always hold" 1), asked of every list of parts or
// candidate parts: AGENTS.md, CLAUDE.md and a conflict copy of either never appear in any of them.

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-never-a-part-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
  invalidateFolioOrderFacts(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS-Other Mac.md']
const isAgentPath = (path: string): boolean => /(?:^|\/)(?:AGENTS|CLAUDE)(?:[- ][^/]*)?\.md$/.test(path)
const noAgentFile = (paths: readonly string[]): void => {
  expect(paths.filter(isAgentPath)).toEqual([])
}

/** A folder about to become a Folio, with agent instructions of its own (a pre-existing AGENTS.md, a conflict copy). */
async function seedFolder(dir: string): Promise<void> {
  await write(`${dir}/01-intro.md`, '---\nstatus: draft\n---\n# Intro\n\nOne two three.\n')
  await write(`${dir}/02-method.md`, '---\nstatus: draft\n---\n# Method\n\nFour five.\n')
  await write(`${dir}/notes.md`, '# Notes\n\nSix.\n')
  for (const name of AGENT_FILES) await write(`${dir}/${name}`, `# ${name}\n\nAgent words agent words agent words.\n`)
}

/** A made Folio: the drafted manifest, then the instructions Make Folio writes. */
async function makeFolio(dir: string): Promise<void> {
  await seedFolder(dir)
  await write(`${dir}/${MANIFEST_NAME}`, await draftManifest(ws, dir))
  await writeFolioAgentInstructions(ws, dir)
}

test('the name rule: AGENTS.md, CLAUDE.md, any letter case, and conflict copies; nothing else', () => {
  for (const name of ['AGENTS.md', 'agents.md', 'CLAUDE.md', 'Claude.md', 'AGENTS-Other.md', 'CLAUDE (conflicted copy 2026-10-14).md', 'r/AGENTS.md']) {
    expect(isAgentInstructionsName(name)).toBe(true)
  }
  // A numbered sibling, a part that merely starts with the word, another extension: parts as before.
  for (const name of ['AGENTS-2.md', 'agents-guide.md', 'Claude-and-me.md', 'AGENTS-notes.txt', 'my-AGENTS.md', 'AGENTSX.md', '01-agents.md', 'CLAUDE.txt']) {
    expect(isAgentInstructionsName(name)).toBe(false)
  }
})

test('running order fallback and the drafted manifest leave them out', async () => {
  await seedFolder('r')
  noAgentFile(await fallbackFolioParts(ws, 'r'))
  noAgentFile(await orderFor(ws, 'r'))
  const drafted = JSON.parse(await draftManifest(ws, 'r')).files.map((file: { path: string }) => file.path)
  expect(drafted).toEqual(['01-intro.md', '02-method.md', 'notes.md'])
  // A folder whose only Markdown is agent instructions has nothing to make a Folio of.
  for (const name of AGENT_FILES) await write(`empty/${name}`, '# x\n')
  await expect(draftManifest(ws, 'empty')).rejects.toThrow('no Markdown files')
})

test('a manifest entry naming AGENTS.md is left out with its reason and makes the Outline send changes to the Folio outline', async () => {
  await seedFolder('r')
  const manifest = { schema_version: 1, content_root: '', files: [{ path: '01-intro.md' }, { path: 'AGENTS.md' }] }
  await write(`r/${MANIFEST_NAME}`, JSON.stringify(manifest))
  const resolved = await folioPieces(ws, 'r')
  expect(resolved).toEqual({ pieces: ['r/01-intro.md'], leftOut: [{ path: 'AGENTS.md', reason: 'agent-instructions' }] })
  const read = await readManifestOnly(ws, 'r')
  expect(read.assessment).toEqual({ ok: false, reason: 'agent-instructions' })
  expect(assessManifestOnly('r', read.manifest, read.source, read.present)).toEqual({ ok: false, reason: 'agent-instructions' })
})

test('Add and Add all, the Outline’s "Not in the outline" and the Folio outline’s unlisted files leave them out', async () => {
  await makeFolio('r')
  // Take notes.md out again so there is something to add.
  await write(`r/${MANIFEST_NAME}`, JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: '01-intro.md', role: 'section' }] }))
  invalidateFolioOrderFacts(root)
  const read = await readManifestOnly(ws, 'r')
  expect(await manifestOnlyAddable(ws, 'r', read)).toEqual(['r/02-method.md', 'r/notes.md'])
  const facts = await folioOrderFacts(ws, 'r')
  noAgentFile(facts.addable)
  noAgentFile(facts.unlisted)
  const outline = await folioOutline(ws, 'r/01-intro.md')
  expect(outline?.also.map((file) => file.path)).toEqual(['r/02-method.md', 'r/notes.md'])
  noAgentFile(outline?.pieces.map((file) => file.path) ?? [])

  // With an Index Note, the Plan's unlisted files.
  await write('r/_r_INDEX.md', '# R\n\n## Running order\n\n- [[Intro]]\n')
  invalidateFolioOrderFacts(root)
  const plan = await readPlan(ws, 'r')
  expect(plan?.unlisted.map((part) => part.path)).toEqual(['r/02-method.md', 'r/notes.md'])
  noAgentFile((await folioOrderFacts(ws, 'r')).addable)
})

test('a content_root Folio: the instructions in the Folio folder are not in "Not in the outline" either', async () => {
  await write('rep/contents/01-a.md', '# A\n')
  await write('rep/contents/02-b.md', '# B\n')
  await write('rep/contents/AGENTS.md', '# Theirs\n')
  await write(`rep/${MANIFEST_NAME}`, JSON.stringify({ schema_version: 1, content_root: 'contents', files: [{ path: '01-a.md' }] }))
  await writeFolioAgentInstructions(ws, 'rep')
  const outline = await folioOutline(ws, 'rep/contents/01-a.md')
  expect(outline?.also.map((file) => file.path)).toEqual(['rep/contents/02-b.md'])
})

test('the pure Outline grouping drops them from direct and deeper files', () => {
  const file = (path: string) => ({ path, name: path.split('/').pop() as string, directory: path.split('/').slice(0, -1).join('/') })
  const files = ['r/AGENTS.md', 'r/CLAUDE.md', 'r/notes.md', 'r/sub/AGENTS-Mac.md', 'r/sub/x.md'].map(file)
  const also = groupAlsoInFolder(files, [], 'r', new Set())
  expect(also.map((entry) => entry.path)).toEqual(['r/notes.md', 'r/sub/x.md'])
  expect(() => assertManifestFallbackOrder(['r/AGENTS.md'], 'r')).toThrow('cannot enter a Folio manifest')
})

test('the Folder dashboard rows, the Board, digests and word counts leave them out of a Folio', async () => {
  await makeFolio('r')
  const rows = (await listCollection(ws, 'r')).rows
  expect(rows.map((row) => row.name).sort()).toEqual(['01-intro.md', '02-method.md', 'notes.md'])
  // The dashboard's and the Plan's word counts are sums over exactly these rows.
  noAgentFile((await collectionPieces(ws, 'r')).map((piece) => piece.path))
  // The whole collection (recursive) leaves out every Folio's instructions too.
  noAgentFile((await collectionPieces(ws, '')).map((piece) => piece.path))
  const board = await evaluateCollectionQuery(ws, 'r', '')
  expect(board.ok).toBe(true)
  if (board.ok) noAgentFile(board.rows.map((row) => row.path))
  const digest = await computeCollectionDigest(ws, 'r')
  noAgentFile(digest.pieces.map((piece) => piece.path))
  expect(digest.summary.pieces).toBe(3)
})

test('exports leave them out: Word writes the rows, HTML writes the manifest’s pieces', async () => {
  await makeFolio('r')
  const out = await mkdtemp(join(tmpdir(), 'wf-never-a-part-out-'))
  try {
    const word = await exportBundle(ws, { dir: 'r', format: 'docx', target: join(out, 'r.docx') })
    expect(word.pieces).toBe(3)
    const html = await exportBundle(ws, { dir: 'r', format: 'html', target: join(out, 'r.html') })
    expect(html.pieces).toBe(3)
    const text = readFileSync(join(out, 'r.html'), 'utf8')
    expect(text).not.toContain('Agent words')
    expect(text).not.toContain('How this Folio works')
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('an AGENTS.md in a Folio’s content_root subfolder is left out of the Board and the word counts', async () => {
  await write('rep/contents/01-a.md', '# A\n\nOne two.\n')
  await write('rep/contents/02-b.md', '# B\n\nThree.\n')
  await write('rep/contents/AGENTS.md', '# Theirs\n\nAgent words agent words.\n')
  await write('rep/contents/deeper/CLAUDE.md', '@AGENTS.md\n')
  await write(`rep/${MANIFEST_NAME}`, JSON.stringify({ schema_version: 1, content_root: 'contents', files: [{ path: '01-a.md' }, { path: '02-b.md' }] }))
  expect(isFolioAgentInstructionsFile(ws, 'rep/contents/AGENTS.md')).toBe(true)
  expect(isFolioAgentInstructionsFile(ws, 'rep/contents/deeper/CLAUDE.md')).toBe(true)
  for (const dir of ['rep', 'rep/contents']) {
    const board = await evaluateCollectionQuery(ws, dir, '')
    expect(board.ok).toBe(true)
    if (board.ok) noAgentFile(board.rows.map((row) => row.path))
    noAgentFile((await listCollection(ws, dir)).rows.map((row) => row.path))
    noAgentFile((await collectionPieces(ws, dir)).map((piece) => piece.path))
    const digest = await computeCollectionDigest(ws, dir)
    noAgentFile(digest.pieces.map((piece) => piece.path))
  }
  noAgentFile((await collectionPieces(ws, '')).map((piece) => piece.path))
})

test('outside a Folio the Collection lists are unchanged: an AGENTS.md in a plain folder still shows', async () => {
  await write('plain/a.md', '# A\n')
  await write('plain/AGENTS.md', '# Mine\n')
  expect(isFolioAgentInstructionsFile(ws, 'plain/AGENTS.md')).toBe(false)
  expect((await listCollection(ws, 'plain')).rows.map((row) => row.name).sort()).toEqual(['AGENTS.md', 'a.md'])
})

test('the line above the text names the instructions, never a position in the running order', async () => {
  await makeFolio('r')
  expect(folioPlaceFacts('r/AGENTS.md', ['r/01-intro.md'], 'r/_r_INDEX.md').kind).toBe('instructions')
  const place = await folioPlace(ws, 'r/CLAUDE.md')
  expect(place?.kind).toBe('instructions')
  expect(place?.position).toBeNull()
})
