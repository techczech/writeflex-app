import { pinnedIndex } from '../helpers/folio-file-identity'
// Ticket A, review round 1 (Sol): discovering unlisted files must never change what the running order names,
// Put back must write a manifest that names exactly the chosen file, and the role menu changes the role in
// both documents. Each test is one of the reviewer's scenarios, reproduced before the fix.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folioPartsUnderRoot, folioPieces, MANIFEST_NAME } from '../../src/main/folio'
import { addFolioPieces } from '../../src/main/folio-running-order'
import { rewriteJsonArrayEntryStringProperty } from '../../src/main/json-array-layout'
import { MANIFEST_WOULD_NAME_ANOTHER_FILE, PUT_BACK_NEEDS_MANIFEST, adoptPart, readPlan, setPartRole as setPartRoleNamed } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'
import { runPlanOperations } from '../../src/main/plan-proposal'
import { STALE_PUT_BACK_MESSAGE } from '../../src/shared/folio-running-order'
import { groupAlsoInFolder } from '../../src/shared/folio-outline'
import { FOLIO_COVER_NAMES, isNotInOutlineName } from '../../src/shared/folio-part-name'

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-plan-discovery-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
/** The role menu as the owner uses it: the card at `index` as the Plan shows it now. */
async function setPartRole(on: Workspace, dir: string, index: number, role: string) {
  const part = (await readPlan(on, dir))!.parts[index]
  return setPartRoleNamed(on, dir, index, role, { title: part.title, path: part.path, gloss: part.gloss, role: part.role, tags: part.tags })
}
const INDEX = 'report/_report_INDEX.md'
const MANIFEST = `report/${MANIFEST_NAME}`
const manifestOf = (files: Array<Record<string, unknown>>, contentRoot = ''): string => `${JSON.stringify({ schema_version: 1, content_root: contentRoot, files }, null, 2)}\n`

async function openingWithRejectedDraft(): Promise<void> {
  // `[[Opening]]` names Opening.md by its file name: its own title is "Actual opening".
  await write('report/Opening.md', '# Actual opening\n')
  await write('report/drafts/rejected.md', '# Opening\n')
  await write(MANIFEST, manifestOf([{ path: 'Opening.md' }]))
  await write(INDEX, '# Report\n\n## Running order\n\n- [[Opening]]\n')
}

test('P1: a subfolder file titled like an existing line does not retarget it; its Put back is refused with the reason and the row stays with Open', async () => {
  await openingWithRejectedDraft()
  const plan = (await readPlan(ws, 'report'))!
  expect(plan.parts.map((part) => part.path)).toEqual(['report/Opening.md'])
  const at = plan.unlisted.findIndex((part) => part.path === 'report/drafts/rejected.md')
  expect(at).toBeGreaterThanOrEqual(0)
  expect(plan.unlisted[at]).toMatchObject({ under: 'drafts', manifestBacked: false })
  expect(plan.unlisted[at].putBackRefusal).toMatch(/Another file here also answers to “Opening”/)

  const index = await read(INDEX)
  const manifest = await read(MANIFEST)
  await expect(adoptPart(ws, 'report', at)).rejects.toThrow(/answers to “Opening”/)
  expect(await read(INDEX)).toBe(index)
  expect(await read(MANIFEST)).toBe(manifest)
})

test('P1: a role change after discovery adds nothing to the manifest and changes only the role', async () => {
  await openingWithRejectedDraft()
  const plan = await setPartRole(ws, 'report', 0, 'appendix')
  expect(plan.parts.map((part) => [part.path, part.role])).toEqual([['report/Opening.md', 'appendix']])
  expect(JSON.parse(await read(MANIFEST)).files).toEqual([{ path: 'Opening.md', role: 'appendix' }])
  expect((await folioPieces(ws, 'report')).pieces).toEqual(['report/Opening.md'])
})

test('P1: a line that named no file still names none when a subfolder file carries its title', async () => {
  await write('report/drafts/deep.md', '# Deep\n')
  await write(MANIFEST, manifestOf([]))
  await write(INDEX, '# Report\n\n## Running order\n\n- [[Deep]]\n')
  const plan = (await readPlan(ws, 'report'))!
  expect(plan.parts.map((part) => part.path)).toEqual([null])
  expect(plan.unlisted.find((part) => part.path === 'report/drafts/deep.md')?.putBackRefusal).toBeDefined()
})

test('P1: a subfolder file with a title of its own is put back through the manifest; with no manifest it is refused', async () => {
  await write('report/Opening.md', '# Opening\n')
  await write('report/drafts/aside.md', '# Aside\n')
  await write(INDEX, '# Report\n\n## Running order\n\n- [[Opening]]\n')
  const noManifest = (await readPlan(ws, 'report'))!
  expect(noManifest.unlisted.find((part) => part.path === 'report/drafts/aside.md')?.putBackRefusal).toBe(PUT_BACK_NEEDS_MANIFEST)

  await write(MANIFEST, manifestOf([{ path: 'Opening.md' }]))
  const before = (await readPlan(ws, 'report'))!
  const at = before.unlisted.findIndex((part) => part.path === 'report/drafts/aside.md')
  expect(before.unlisted[at].putBackRefusal).toBeUndefined()
  const after = await adoptPart(ws, 'report', at)
  expect(after.parts.map((part) => part.path)).toEqual(['report/Opening.md', 'report/drafts/aside.md'])
  expect(JSON.parse(await read(MANIFEST)).files.map((file: { path: string }) => file.path)).toEqual(['Opening.md', 'drafts/aside.md'])
  expect((await readPlan(ws, 'report'))!.parts.map((part) => part.path)).toEqual(['report/Opening.md', 'report/drafts/aside.md'])
})

async function shadowedContentRoot(withIndex: boolean): Promise<void> {
  // Entries carry the content_root prefix, so a new entry is written as `contents/deep/two.md`, which a reader
  // tries first as content_root + path: `contents/contents/deep/two.md`.
  await write('report/contents/01-a.md', '# Alpha\n')
  await write('report/contents/02-b.md', '# Beta\n')
  await write('report/contents/deep/two.md', '# Two\n')
  await write('report/contents/contents/deep/two.md', '# Shadow\n')
  await write(MANIFEST, manifestOf([{ path: 'contents/01-a.md' }, { path: 'contents/02-b.md' }], 'contents'))
  if (withIndex) await write(INDEX, '# Report\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]]\n')
}

test('P2: Put back of contents/deep/two.md is refused when the entry it would write resolves to contents/contents/deep/two.md; nothing is written', async () => {
  await shadowedContentRoot(true)
  const plan = (await readPlan(ws, 'report'))!
  const at = plan.unlisted.findIndex((part) => part.path === 'report/contents/deep/two.md')
  expect(at).toBeGreaterThanOrEqual(0)
  const index = await read(INDEX)
  const manifest = await read(MANIFEST)
  await expect(adoptPart(ws, 'report', at)).rejects.toThrow(MANIFEST_WOULD_NAME_ANOTHER_FILE)
  expect(await read(INDEX)).toBe(index)
  expect(await read(MANIFEST)).toBe(manifest)
  expect((await folioPieces(ws, 'report')).pieces).toEqual(['report/contents/01-a.md', 'report/contents/02-b.md'])
})

test('P2: the same Put back from the Outline (Index Note or none) is refused and writes nothing', async () => {
  for (const withIndex of [true, false]) {
    await rm(join(root, 'report'), { recursive: true, force: true })
    await shadowedContentRoot(withIndex)
    const manifest = await read(MANIFEST)
    const { result } = await addFolioPieces(ws, 'report', { paths: ['report/contents/deep/two.md'], expected: ['report/contents/01-a.md', 'report/contents/02-b.md'] })
    expect(result).toMatchObject({ ok: false })
    expect(await read(MANIFEST)).toBe(manifest)
  }
})

test('P2: without the shadow file the same Put back writes an entry that folioPieces reads as the chosen file', async () => {
  await shadowedContentRoot(true)
  await rm(join(root, 'report/contents/contents'), { recursive: true, force: true })
  const plan = (await readPlan(ws, 'report'))!
  await adoptPart(ws, 'report', plan.unlisted.findIndex((part) => part.path === 'report/contents/deep/two.md'))
  expect((await folioPieces(ws, 'report')).pieces).toEqual(['report/contents/01-a.md', 'report/contents/02-b.md', 'report/contents/deep/two.md'])
})

test('P3: choosing Appendix changes the role in the Index Note line and the manifest entry, every other byte kept', async () => {
  await write('report/a.md', '# Alpha\n')
  await write('report/b.md', '# Beta\n')
  await write('report/c.md', '# Gamma\n')
  const manifest = '{\n  "schema_version": 1,\n  "content_root": "",\n  "files": [\n    { "path": "a.md", "role": "section", "toc": true },\n    {\n      "path": "b.md"\n    },\n    {"path":"c.md"}\n  ],\n  "output": "out.docx"\n}\n'
  await write(MANIFEST, manifest)
  await write(INDEX, '# Report\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]]\n- [[Gamma]]\n')

  await setPartRole(ws, 'report', 0, 'appendix')
  await setPartRole(ws, 'report', 1, 'appendix')
  await setPartRole(ws, 'report', 2, 'summary')
  expect(await read(INDEX)).toBe(pinnedIndex('# Report\n\n## Running order\n\n- [[Alpha]] #appendix\n- [[Beta]] #appendix\n- [[Gamma]] #summary\n', {"Alpha":"./a.md|Alpha","Beta":"./b.md|Beta","Gamma":"./c.md|Gamma"}))
  expect(await read(MANIFEST)).toBe('{\n  "schema_version": 1,\n  "content_root": "",\n  "files": [\n    { "path": "a.md", "role": "appendix", "toc": true },\n    {\n      "path": "b.md",\n      "role": "appendix"\n    },\n    {"path":"c.md","role":"summary"}\n  ],\n  "output": "out.docx"\n}\n')
  const plan = (await readPlan(ws, 'report'))!
  expect(plan.parts.map((part) => part.role)).toEqual(['appendix', 'appendix', 'summary'])

  // Back to Section: an entry that names a role says section; nothing else moves.
  await setPartRole(ws, 'report', 0, 'section')
  expect(JSON.parse(await read(MANIFEST)).files[0]).toEqual({ path: 'a.md', role: 'section', toc: true })
})

test('the entry property rewrite replaces in place, appends in the entry’s own style, and keeps the rest', () => {
  const source = '{"files":[{"path":"a.md"},{ "path": "b.md", "role": null }]}'
  expect(rewriteJsonArrayEntryStringProperty(source, 'files', 0, 'role', 'appendix')).toBe('{"files":[{"path":"a.md","role":"appendix"},{ "path": "b.md", "role": null }]}')
  expect(rewriteJsonArrayEntryStringProperty(source, 'files', 1, 'role', 'summary')).toBe('{"files":[{"path":"a.md"},{ "path": "b.md", "role": "summary" }]}')
  expect(() => rewriteJsonArrayEntryStringProperty('{"files":["a.md"]}', 'files', 0, 'role', 'x')).toThrow()
})

test('P2: main and the sidebar share one cover rule, case-insensitive: contents/readme.md is in neither list', async () => {
  await write('report/contents/01-a.md', '# Alpha\n')
  await write('report/contents/readme.md', '# Read me\n')
  await write('report/contents/sub/Index.md', '# Sub\n')
  await write('report/contents/sub/note.md', '# Note\n')
  await write('report/top.md', '# Top\n')
  await write(MANIFEST, manifestOf([{ path: '01-a.md' }], 'contents'))
  await write(INDEX, '# Report\n\n## Running order\n\n- [[Alpha]]\n')

  const main = await folioPartsUnderRoot(ws, 'report/contents')
  expect(main).toEqual(['report/contents/01-a.md', 'report/contents/sub/note.md'])
  const plan = (await readPlan(ws, 'report'))!
  expect(plan.unlisted.map((part) => part.path)).toEqual(['report/contents/sub/note.md'])
  const listing = (await ws.listFilesIn('report')).map((file) => ({ path: file.path, name: file.name, directory: file.directory }))
  expect(groupAlsoInFolder(listing, ['report/contents/01-a.md'], 'report', new Set(), 'report/contents', true).map((row) => row.path))
    .toEqual(plan.unlisted.map((part) => part.path))
  // The one constant list drives the name rule, in any letter case.
  for (const name of FOLIO_COVER_NAMES) {
    expect(isNotInOutlineName(name)).toBe(false)
    expect(isNotInOutlineName(name.toUpperCase())).toBe(false)
  }
})

// Review round 2 (Sol).

test('round 2 P2: manifest-listed cover and _-prefixed files are not in the outline on the Folio outline, as on the sidebar; writes keep their entries', async () => {
  await write('report/contents/a.md', '# Alpha\n')
  await write('report/contents/readme.md', '# Read me\n')
  await write('report/contents/_private.md', '# Private\n')
  await write('report/contents/b.md', '# Beta\n')
  await write(MANIFEST, manifestOf([{ path: 'a.md' }, { path: 'readme.md' }, { path: '_private.md' }, { path: 'b.md' }], 'contents'))
  await write(INDEX, '# Report\n\n## Running order\n\n- [[Alpha]]\n')

  const plan = (await readPlan(ws, 'report'))!
  expect(plan.unlisted.map((part) => part.path)).toEqual(['report/contents/b.md'])
  const listing = (await ws.listFilesIn('report')).map((file) => ({ path: file.path, name: file.name, directory: file.directory }))
  expect(groupAlsoInFolder(listing, ['report/contents/a.md'], 'report', new Set(), 'report/contents', true).map((row) => row.path))
    .toEqual(plan.unlisted.map((part) => part.path))

  // The hidden entries stay in the manifest, in place, through a role change and a Put back.
  await setPartRole(ws, 'report', 0, 'appendix')
  await adoptPart(ws, 'report', 0)
  expect(JSON.parse(await read(MANIFEST)).files).toEqual([{ path: 'a.md', role: 'appendix' }, { path: 'readme.md' }, { path: '_private.md' }, { path: 'b.md' }])
})

test('round 2: an unchanged unlisted file is not read again on the next load (the per-file facts cache)', async () => {
  await write('report/a.md', '# Alpha\n')
  for (let n = 0; n < 20; n += 1) await write(`report/deep/f${String(n).padStart(2, '0')}.md`, `---\ndescription: File ${n}\n---\n# File ${n}\n`)
  await write(MANIFEST, manifestOf([{ path: 'a.md' }]))
  await write(INDEX, '# Report\n\n## Running order\n\n- [[Alpha]]\n')
  const first = (await readPlan(ws, 'report'))!
  expect(first.unlisted).toHaveLength(20)
  expect(first.unlisted[0]).toMatchObject({ title: 'File 0', gloss: 'File 0' })
  const reads = spyOn(Workspace.prototype, 'readFile')
  try {
    const second = (await readPlan(ws, 'report'))!
    expect(second.unlisted).toEqual(first.unlisted)
    expect(reads.mock.calls.filter(([path]) => String(path).startsWith('report/deep/'))).toEqual([])
    // A file that changed is read again.
    await write('report/deep/f00.md', '---\ndescription: Changed and longer\n---\n# File 0\n')
    const third = (await readPlan(ws, 'report'))!
    expect(third.unlisted[0].gloss).toBe('Changed and longer')
  } finally {
    reads.mockRestore()
  }
})

/** A Workspace that runs `hook` once, just before its listing number `at` (1-based): another writer acting mid-run. */
class ListingHookWorkspace extends Workspace {
  calls = 0
  at = Infinity
  hook: () => Promise<void> = async () => {}
  override async listFiles(): ReturnType<Workspace['listFiles']> {
    this.calls += 1
    if (this.calls === this.at) await this.hook()
    return super.listFiles()
  }
}

test('round 2 P1: an agent proposal’s Put back names the file it meant; a file listed ahead of it meanwhile is refused, nothing is written', async () => {
  await write('report/a.md', '# Alpha\n')
  await write('report/deep/z.md', '# Zulu\n')
  await write(MANIFEST, manifestOf([{ path: 'a.md' }]))
  await write(INDEX, '# Report\n\n## Running order\n\n- [[Alpha]]\n')
  // How many listings the route's own read of the Plan takes: the next one is the Put back's read.
  const counter = new ListingHookWorkspace(root)
  await readPlan(counter, 'report')
  const hooked = new ListingHookWorkspace(root)
  hooked.at = counter.calls + 1
  hooked.hook = () => write('report/deep/b.md', '# Beta\n')
  const index = await read(INDEX)
  const manifest = await read(MANIFEST)
  await expect(runPlanOperations(hooked, 'report', [{ op: 'adoptPart', path: 'report/deep/z.md', title: 'Zulu' }])).rejects.toThrow(STALE_PUT_BACK_MESSAGE)
  expect(await read(INDEX)).toBe(index)
  expect(await read(MANIFEST)).toBe(manifest)
  // On the list as it now stands the same operation puts back Zulu, not Beta.
  const { plan } = await runPlanOperations(ws, 'report', [{ op: 'adoptPart', path: 'report/deep/z.md', title: 'Zulu' }])
  expect(plan!.parts.map((part) => part.path)).toEqual(['report/a.md', 'report/deep/z.md'])
})

// Review round 3 (Sol).

test('round 3 P1: an agent proposal’s Put back whose file is gone is refused, even when another file now carries its title; nothing is written', async () => {
  await write('report/a.md', '# Alpha\n')
  await write('report/deep/z.md', '# Zulu\n')
  await write(MANIFEST, manifestOf([{ path: 'a.md' }]))
  await write(INDEX, '# Report\n\n## Running order\n\n- [[Alpha]]\n')
  // Staged against deep/z.md; before the run, that file goes and another file titled Zulu arrives.
  await rm(join(root, 'report/deep/z.md'))
  await write('report/replacement.md', '# Zulu\n')
  const index = await read(INDEX)
  const manifest = await read(MANIFEST)
  await expect(runPlanOperations(ws, 'report', [{ op: 'adoptPart', path: 'report/deep/z.md', title: 'Zulu' }])).rejects.toThrow(STALE_PUT_BACK_MESSAGE)
  expect(await read(INDEX)).toBe(index)
  expect(await read(MANIFEST)).toBe(manifest)
})

test('round 3 P2: an agent proposal’s role change names the whole card it read; a swap of two Idea cards is refused, nothing is written', async () => {
  await write(INDEX, '# Report\n\n## Running order\n\n- [[Idea]] — First idea\n- [[Idea]] — Second idea\n')
  const counter = new ListingHookWorkspace(root)
  await readPlan(counter, 'report')
  const hooked = new ListingHookWorkspace(root)
  hooked.at = counter.calls + 1
  hooked.hook = () => write(INDEX, '# Report\n\n## Running order\n\n- [[Idea]] — Second idea\n- [[Idea]] — First idea\n')
  await expect(runPlanOperations(hooked, 'report', [{ op: 'setPartRole', title: 'Idea', role: 'appendix' }])).rejects.toThrow(/running order changed/i)
  expect(await read(INDEX)).toBe('# Report\n\n## Running order\n\n- [[Idea]] — Second idea\n- [[Idea]] — First idea\n')
})

test('round 3 P2: Put back builds its line from the file as it is now, not from a cached read an outside edit kept the size and time of', async () => {
  await write('report/a.md', '# Alpha\n')
  await write('report/b.md', '---\ndescription: Old\nrole: section\n---\n# Beta\n')
  await write(MANIFEST, manifestOf([{ path: 'a.md' }]))
  await write(INDEX, '# Report\n\n## Running order\n\n- [[Alpha]]\n')
  const warm = (await readPlan(ws, 'report'))!
  expect(warm.unlisted[0]).toMatchObject({ path: 'report/b.md', gloss: 'Old', role: 'section' })
  // An outside edit of the same length that keeps the modified time.
  const before = await stat(join(root, 'report/b.md'))
  await write('report/b.md', '---\ndescription: New\nrole: summary\n---\n# Beta\n')
  await utimes(join(root, 'report/b.md'), before.atime, before.mtime)
  await adoptPart(ws, 'report', 0)
  expect(await read(INDEX)).toBe(pinnedIndex('# Report\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]] — New #summary\n', {"Alpha":"./a.md|Alpha","Beta":"./b.md|Beta"}))
})
