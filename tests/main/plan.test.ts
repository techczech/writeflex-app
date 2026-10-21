import { afterEach, beforeEach, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { MANIFEST_NAME, orderFor } from '../../src/main/folio'
import { adoptPart, insertPart, materialisePart, movePart, readPlan, removePart } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-plan-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

async function read(rel: string): Promise<string> {
  return readFile(join(root, rel), 'utf8')
}

const indexPath = 'report/_report_INDEX.md'

async function seedPlan(): Promise<void> {
  await write('report/contents/01-opening.md', '# Opening\n\nStart here.\n')
  await write('report/contents/03-close.md', '# Close\n\nFinish here.\n')
  await write(
    indexPath,
    '---\npurpose: report\ncustom: keep exactly\n---\n\n' +
    '# Report\n\nCover prose stays byte-identical.\n\n' +
    '## Running order\n\n' +
    '- [[Opening]] — Establish the question #opening\n' +
    '* [[Unwritten idea]]\n' +
    '- [[Close]] #summary\n\n' +
    '## Notes\n\nDo not touch this section.\n',
  )
  await write(
    `report/${MANIFEST_NAME}`,
    `${JSON.stringify({
      schema_version: 1,
      content_root: 'contents',
      output: 'html/report.html',
      files: [
        { path: '01-opening.md', role: 'section', toc: true },
        { path: '03-close.md', role: 'summary' },
      ],
    }, null, 2)}\n`,
  )
}

function partShape(plan: NonNullable<Awaited<ReturnType<typeof readPlan>>>) {
  return plan.parts.map(({ title, gloss, role, path }) => ({ title, gloss, role, path }))
}

async function manifestFiles(): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await read(`report/${MANIFEST_NAME}`)).files
}

function realisticManifest(files: Array<Record<string, unknown>> = [
  { id: 'executive-summary', path: '00-executive-summary.md', role: 'executive-summary', annotatable: true, strip_title_matter: false },
  { id: 'report-body', path: '10-report-body.md', role: 'report-body', annotatable: true, strip_title_matter: true },
  { id: 'appendix', path: '90-appendix.md', role: 'appendix', annotatable: false, strip_title_matter: true },
  { id: 'source-index', path: '99-source-index.md', role: 'source-index', annotatable: false, strip_title_matter: true },
]): string {
  const source = `${JSON.stringify({
    schema_version: 2,
    report_id: 'ai-2026-strategic-impact-agents-funding',
    title: 'Strategic impact of agents and funding',
    authors: ['Dominik Lukeš'],
    bibliography: 'references.json',
    numbered: true,
    caption: 'Working report',
    title_matter: { subtitle: 'Offline copy', date: '2026-08-07' },
    vignettes: Array.from({ length: 14 }, (_, index) => `vignettes/${String(index + 1).padStart(2, '0')}.md`),
    content_root: 'contents',
    files,
  }, null, 2)}\n`
  return source.replace(
    '    {\n      "id": "appendix",\n      "path": "90-appendix.md",\n      "role": "appendix",\n      "annotatable": false,\n      "strip_title_matter": true\n    }',
    '    { "id": "appendix", "path": "90-appendix.md", "role": "appendix", "annotatable": false, "strip_title_matter": true }',
  )
}

function rawEntryForPath(source: string, path: string): string {
  const needle = `"path": "${path}"`
  const at = source.indexOf(needle)
  if (at < 0) throw new Error(`Missing fixture entry: ${path}`)
  return source.slice(source.lastIndexOf('{', at), source.indexOf('}', at) + 1)
}

async function seedRealisticPlan(): Promise<string> {
  const parts = [
    ['00-executive-summary.md', 'Executive summary'],
    ['10-report-body.md', 'Report body'],
    ['90-appendix.md', 'Appendix'],
    ['99-source-index.md', 'Source index'],
  ] as const
  for (const [path, title] of parts) await write(`report/contents/${path}`, `# ${title}\n`)
  await write(indexPath,
    '# Strategic impact\n\n## Running order\n\n' +
    '- [[Executive summary]]\n' +
    '- [[Report body]]\n' +
    '- [[Appendix]] #appendix\n' +
    '- [[Source index]]\n',
  )
  const manifest = realisticManifest()
  await write(`report/${MANIFEST_NAME}`, manifest)
  return manifest
}

async function exists(rel: string): Promise<boolean> {
  try {
    await access(join(root, rel))
    return true
  } catch {
    return false
  }
}

test('readPlan returns null without an Index Note and an insertion point without a Running order heading', async () => {
  await write('plain/a.md', '# A\n')
  expect(await readPlan(ws, 'plain')).toBeNull()

  await write(indexPath, '# Report\n\nCover prose.\n')
  const plan = await readPlan(ws, 'report')
  expect(plan).not.toBeNull()
  expect(plan!.headingLine).toBe(3)
  expect(plan!.parts).toEqual([])
})

test('all writers round-trip intended order and roles while the manifest always equals written Folio outline parts', async () => {
  await seedPlan()

  const inserted = await insertPart(ws, 'report', 1, { title: 'Evidence', gloss: 'What the sources show', role: 'appendix' })
  expect(partShape(inserted)).toEqual([
    { title: 'Opening', gloss: 'Establish the question', role: 'section', path: 'report/contents/01-opening.md' },
    { title: 'Evidence', gloss: 'What the sources show', role: 'appendix', path: null },
    { title: 'Unwritten idea', gloss: null, role: 'section', path: null },
    { title: 'Close', gloss: null, role: 'summary', path: 'report/contents/03-close.md' },
  ])
  expect(await manifestFiles()).toEqual([
    { path: '01-opening.md', role: 'section', toc: true },
    { path: '03-close.md', role: 'summary' },
  ])

  const moved = await movePart(ws, 'report', 3, 1)
  expect(moved.parts.map((part) => part.title)).toEqual(['Opening', 'Close', 'Evidence', 'Unwritten idea'])
  expect(await manifestFiles()).toEqual([
    { path: '01-opening.md', role: 'section', toc: true },
    { path: '03-close.md', role: 'summary' },
  ])

  const removed = await removePart(ws, 'report', 0)
  expect(removed.parts.map((part) => part.title)).toEqual(['Close', 'Evidence', 'Unwritten idea'])
  expect(await manifestFiles()).toEqual([{ path: '03-close.md', role: 'summary' }])

  const materialised = await materialisePart(ws, 'report', 1)
  expect(materialised.path).toBe('report/contents/02-evidence.md')
  expect(partShape(materialised.plan)).toEqual([
    { title: 'Close', gloss: null, role: 'summary', path: 'report/contents/03-close.md' },
    { title: 'Evidence', gloss: 'What the sources show', role: 'appendix', path: 'report/contents/02-evidence.md' },
    { title: 'Unwritten idea', gloss: null, role: 'section', path: null },
  ])
  expect(await manifestFiles()).toEqual([
    { path: '03-close.md', role: 'summary' },
    { path: '02-evidence.md', role: 'appendix' },
  ])
  expect(await read(materialised.path)).toBe(
    '---\ntitle: "Evidence"\nrole: "appendix"\ndescription: "What the sources show"\nstatus: idea\n---\n\n' +
    '# Evidence\n\nWhat the sources show\n',
  )
})

test('root Folio outline materialisation excludes the root Index Note and legacy cover from its new manifest', async () => {
  const rootName = basename(root)
  await write(`_${rootName}_INDEX.md`, '# Root\n\n## Running order\n\n- [[Opening]]\n')
  await write(`_${rootName}.md`, '# Legacy root cover\n')

  await materialisePart(ws, '', 0)

  expect((JSON.parse(await read(MANIFEST_NAME)) as { files: Array<{ path: string }> }).files).toEqual([
    { path: '01-opening.md' },
  ])
})

test('every Folio outline mutation edits only manifest file membership and order in a realistic manifest', async () => {
  const before = await seedRealisticPlan()
  const beforeJson = JSON.parse(before) as Record<string, unknown>
  const entries = (beforeJson.files as Array<Record<string, unknown>>).map((entry) => rawEntryForPath(before, entry.path as string))

  await insertPart(ws, 'report', 1, { title: 'New part' })
  const unchangedAfterInsert = await read(`report/${MANIFEST_NAME}`) === before
  await movePart(ws, 'report', 4, 0)
  await removePart(ws, 'report', 2)
  await insertPart(ws, 'report', 2, { title: 'New part' })
  await materialisePart(ws, 'report', 2)

  const after = await read(`report/${MANIFEST_NAME}`)
  const afterJson = JSON.parse(after) as Record<string, unknown>
  expect({
    unchangedAfterInsert,
    topLevel: { ...afterJson, files: undefined },
    ids: (afterJson.files as Array<Record<string, unknown>>).map((entry) => entry.id),
    retainedEntriesAreByteIdentical: entries.every((entry) => after.includes(entry)),
    newEntry: (afterJson.files as Array<Record<string, unknown>>)[2],
  }).toEqual({
    unchangedAfterInsert: true,
    topLevel: { ...beforeJson, files: undefined },
    ids: ['source-index', 'executive-summary', 'new-part', 'report-body', 'appendix'],
    retainedEntriesAreByteIdentical: true,
    newEntry: { id: 'new-part', path: '03-new-part.md', role: 'section' },
  })
})

test('unwritten parts never reach the manifest', async () => {
  await seedPlan()
  await insertPart(ws, 'report', 0, { title: 'Still only an intention', role: 'vignette' })
  expect(await manifestFiles()).toEqual([
    { path: '01-opening.md', role: 'section', toc: true },
    { path: '03-close.md', role: 'summary' },
  ])
})

test('moving a part changes only the Folio outline lines in the whole Index Note', async () => {
  await seedPlan()
  await movePart(ws, 'report', 2, 0)
  expect(await read(indexPath)).toBe(
    '---\npurpose: report\ncustom: keep exactly\n---\n\n' +
    '# Report\n\nCover prose stays byte-identical.\n\n' +
    '## Running order\n\n' +
    '- [[Close]] #summary\n' +
    '- [[Opening]] — Establish the question #opening\n' +
    '* [[Unwritten idea]]\n\n' +
    '## Notes\n\nDo not touch this section.\n',
  )
})

test('inserting a part changes only the Folio outline lines in the whole Index Note', async () => {
  await seedPlan()
  await insertPart(ws, 'report', 1, { title: 'Evidence', gloss: 'What the sources show', role: 'appendix' })
  expect(await read(indexPath)).toBe(
    '---\npurpose: report\ncustom: keep exactly\n---\n\n' +
    '# Report\n\nCover prose stays byte-identical.\n\n' +
    '## Running order\n\n' +
    '- [[Opening]] — Establish the question #opening\n' +
    '- [[Evidence]] — What the sources show #appendix\n' +
    '* [[Unwritten idea]]\n' +
    '- [[Close]] #summary\n\n' +
    '## Notes\n\nDo not touch this section.\n',
  )
})

test('removing a part changes only the Folio outline lines in the whole Index Note', async () => {
  await seedPlan()
  await removePart(ws, 'report', 1)
  expect(await read(indexPath)).toBe(
    '---\npurpose: report\ncustom: keep exactly\n---\n\n' +
    '# Report\n\nCover prose stays byte-identical.\n\n' +
    '## Running order\n\n' +
    '- [[Opening]] — Establish the question #opening\n' +
    '- [[Close]] #summary\n\n' +
    '## Notes\n\nDo not touch this section.\n',
  )
})

test('materialising a part leaves every Index Note byte unchanged', async () => {
  await seedPlan()
  const before = await read(indexPath)
  await materialisePart(ws, 'report', 1)
  expect(await read(indexPath)).toBe(before)
})

test('a part with no gloss or tags keeps its list marker and bytes through another insertion', async () => {
  await seedPlan()
  await insertPart(ws, 'report', 3, { title: 'Afterword' })
  expect((await read(indexPath)).split('\n')[12]).toBe('* [[Unwritten idea]]')
  expect((await readPlan(ws, 'report'))!.parts[1]).toMatchObject({
    title: 'Unwritten idea', gloss: null, role: 'section', tags: [],
  })
})

test('materialise preflights an occupied target before changing either document', async () => {
  await seedRealisticPlan()
  await write('report/contents/03-intended.md', '# Unrelated existing file\n')
  await write(indexPath,
    '# Strategic impact\n\n## Running order\n\n' +
    '- [[Executive summary]]\n' +
    '- [[Report body]]\n' +
    '- [[Intended]]\n' +
    '- [[Appendix]] #appendix\n' +
    '- [[Source index]]\n',
  )
  const indexBefore = await read(indexPath)
  const manifestBefore = await read(`report/${MANIFEST_NAME}`)
  const occupiedBefore = await read('report/contents/03-intended.md')

  let error = ''
  try { await materialisePart(ws, 'report', 2) } catch (caught) { error = String(caught) }

  expect({
    rejectedAsOccupied: error.includes('already exists'),
    index: await read(indexPath),
    manifest: await read(`report/${MANIFEST_NAME}`),
    occupied: await read('report/contents/03-intended.md'),
  }).toEqual({ rejectedAsOccupied: true, index: indexBefore, manifest: manifestBefore, occupied: occupiedBefore })
})

test('a failed first materialise creates no manifest and preserves the complete fallback order', async () => {
  class FileFailingWorkspace extends Workspace {
    override async createFile(path: string, content: string) {
      if (path.endsWith('/01-intended-part.md')) throw new Error('injected file write failure')
      return super.createFile(path, content)
    }
  }

  await write('report/legacy-chapter.md', '# Legacy chapter\n')
  await write(indexPath, '# Report\n\n## Running order\n\n- [[Intended part]]\n')
  const failing = new FileFailingWorkspace(root)
  const beforeOrder = await orderFor(failing, 'report')
  const beforeIndex = await read(indexPath)

  let error = ''
  try { await materialisePart(failing, 'report', 0) } catch (caught) { error = String(caught) }

  expect({
    rejectedFromFileWrite: error.includes('injected file write failure'),
    manifestExists: await exists(`report/${MANIFEST_NAME}`),
    order: await orderFor(failing, 'report'),
    index: await read(indexPath),
  }).toEqual({ rejectedFromFileWrite: true, manifestExists: false, order: beforeOrder, index: beforeIndex })
})

test('the first successful materialise preserves every part in the prior fallback order', async () => {
  await write('report/legacy-chapter.md', '# Legacy chapter\n')
  await write(indexPath, '# Report\n\n## Running order\n\n- [[Intended part]]\n')

  const result = await materialisePart(ws, 'report', 0)

  const afterOrder = await orderFor(ws, 'report')
  expect({ priorPartPreserved: afterOrder.includes('report/legacy-chapter.md'), createdFilePresent: afterOrder.includes(result.path) }).toEqual({
    priorPartPreserved: true,
    createdFilePresent: true,
  })
})

test('fenced and indented code examples are not Folio outline parts and remain byte-stable through a move', async () => {
  const source = '# Report\n\n## Running order\n\n```markdown\n- [[Example only]]\n```\n    - [[Indented example]]\n- [[Live one]]\n- [[Live two]]\n'
  await write(indexPath, source)

  const before = await readPlan(ws, 'report')
  await movePart(ws, 'report', 1, 0)
  expect({ titles: before!.parts.map((part) => part.title), source: await read(indexPath) }).toEqual({
    titles: ['Live one', 'Live two'],
    source: '# Report\n\n## Running order\n\n```markdown\n- [[Example only]]\n```\n    - [[Indented example]]\n- [[Live two]]\n- [[Live one]]\n',
  })
})

test('a deeper heading closes the Folio outline section and remove leaves its lines byte-identical', async () => {
  const source = '# Report\n\n## Running order\n\n- [[Live part]]\n\n### Parked ideas\n\n- [[Parked part]]\n'
  await write(indexPath, source)

  const before = await readPlan(ws, 'report')
  await removePart(ws, 'report', 0)
  expect({ titles: before!.parts.map((part) => part.title), source: await read(indexPath) }).toEqual({
    titles: ['Live part'],
    source: '# Report\n\n## Running order\n\n\n### Parked ideas\n\n- [[Parked part]]\n',
  })
})

test('a plausible Running order heading is reused rather than duplicated', async () => {
  await write(indexPath, '# Report\n\n## Running order (v2)\n\n- [[Opening]]\n')

  const plan = await insertPart(ws, 'report', 1, { title: 'Close' })

  const source = await read(indexPath)
  expect({ titles: plan.parts.map((part) => part.title), headings: source.match(/^##\s+Running order/gim)?.length, source }).toEqual({
    titles: ['Opening', 'Close'],
    headings: 1,
    source: '# Report\n\n## Running order (v2)\n\n- [[Opening]]\n- [[Close]]\n',
  })
})

test('readPlan degrades on malformed manifest JSON without changing the Index Note', async () => {
  const index = '# Report\n\n## Running order\n\n- [[Opening]]\n'
  await write(indexPath, index)
  await write(`report/${MANIFEST_NAME}`, '{ not valid JSON')

  const plan = await readPlan(ws, 'report')

  expect({ titles: plan!.parts.map((part) => part.title), source: await read(indexPath) }).toEqual({ titles: ['Opening'], source: index })
})

test('readPlan lists an unrepresentable unlisted title with Put back refused, instead of throwing or hiding it', async () => {
  const index = '# Report\n\n## Running order\n'
  await write(indexPath, index)
  // Its title cannot be a line, and neither can its path (`./contents/bad#1`): no line can name it (a title alone
  // that a line cannot hold goes in by its path instead, Sol round 2).
  await write('report/contents/bad#1.md', '# Bad | title # fragment ]]\n')
  await write(`report/${MANIFEST_NAME}`, realisticManifest([]))

  const plan = await readPlan(ws, 'report')

  expect(plan!.parts).toEqual([])
  expect(plan!.unlisted.map((part) => [part.path, Boolean(part.putBackRefusal)])).toEqual([['report/contents/bad#1.md', true]])
  expect(await read(indexPath)).toBe(index)
  // Put back is refused with the row's own reason, before any line is built.
  await expect(adoptPart(ws, 'report', 0)).rejects.toThrow(/No running-order line can name this file/)
  expect(await read(indexPath)).toBe(index)
})

test('a manifest entry whose title a running-order line cannot hold is in the order by its path (Sol round 2)', async () => {
  const index = '# Report\n\n## Running order\n'
  await write(indexPath, index)
  await write('report/contents/bad.md', '# Bad | title # fragment ]]\n')
  await write(`report/${MANIFEST_NAME}`, realisticManifest([
    { id: 'bad', path: 'bad.md', role: 'report-body', annotatable: true, strip_title_matter: true },
  ]))

  const plan = await readPlan(ws, 'report')

  expect(plan!.parts.map((part) => [part.title, part.path])).toEqual([['./contents/bad', 'report/contents/bad.md']])
  expect(plan!.unlisted).toEqual([])
  expect(await read(indexPath)).toBe(index)
})

test('a same-title draft outside content_root stays unwritten and never escapes into the manifest', async () => {
  const manifest = realisticManifest([])
  await write(indexPath, '# Report\n\n## Running order\n\n- [[Method]]\n')
  await write('report/ideas/method.md', '# Method\n')
  await write(`report/${MANIFEST_NAME}`, manifest)

  const before = await readPlan(ws, 'report')
  await insertPart(ws, 'report', 1, { title: 'Conclusion' })
  const files = await manifestFiles()
  expect({ resolvedPath: before!.parts[0].path, files, escaped: JSON.stringify(files).includes('../') }).toEqual({
    resolvedPath: null,
    files: [],
    escaped: false,
  })
})

test('readPlan returns one manifest file absent from the Folio outline as unlisted without changing either file', async () => {
  await write('report/contents/01-opening.md', '# Opening\n')
  await write('report/contents/02-appendix.md', '# Appendix\n')
  await write(indexPath, '# Report\n\n## Running order\n\n* [[Opening]]\n')
  const manifest = `${JSON.stringify({
    schema_version: 1,
    content_root: 'contents',
    output: 'html/report.html',
    files: [
      { path: '01-opening.md', role: 'section' },
      { path: '02-appendix.md', role: 'appendix', toc: false },
    ],
  }, null, 2)}\n`
  await write(`report/${MANIFEST_NAME}`, manifest)

  const plan = await readPlan(ws, 'report')
  expect(plan!.parts.map((part) => part.title)).toEqual(['Opening'])
  expect(plan!.unlisted.map(({ title, role }) => ({ title, role }))).toEqual([{ title: 'Appendix', role: 'appendix' }])
  expect(await read(indexPath)).toBe('# Report\n\n## Running order\n\n* [[Opening]]\n')
  expect(await read(`report/${MANIFEST_NAME}`)).toBe(manifest)

  const secondRead = await readPlan(ws, 'report')
  expect(secondRead!.parts.map((part) => part.title)).toEqual(['Opening'])
  expect(secondRead!.unlisted.map((part) => part.title)).toEqual(['Appendix'])
})

test('an absent Running order heading stays absent on disk while the Plan reads the manifest parts as its running order', async () => {
  await write('report/contents/01-opening.md', '# Opening\n')
  await write(indexPath, '# Report\n\nCover prose.\n')
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({
    schema_version: 1,
    content_root: 'contents',
    files: [{ path: '01-opening.md', role: 'section' }],
  }))

  const plan = await readPlan(ws, 'report')
  expect(plan!.parts.map((part) => part.title)).toEqual(['Opening'])
  expect(plan!.orderFrom).toBe('manifest')
  expect(plan!.unlisted).toEqual([])
  expect(await read(indexPath)).toBe('# Report\n\nCover prose.\n')
})

test('the first change to an Index Note with no running-order part writes the manifest order and the change in one write', async () => {
  await write('report/contents/01-opening.md', '# Opening\n')
  await write(indexPath, '# Report\n\n## Running order\n')
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({
    schema_version: 1,
    content_root: 'contents',
    files: [{ path: '01-opening.md', role: 'section' }],
  }))

  const plan = await insertPart(ws, 'report', 0, { title: 'Preface' })
  expect(plan.parts.map((part) => part.title)).toEqual(['Preface', 'Opening'])
  expect(plan.orderFrom).toBeUndefined()
  expect(plan.unlisted).toEqual([])
  expect(await read(indexPath)).toBe('# Report\n\n## Running order\n- [[Preface]]\n- [[Opening]]\n')
})

test('even a same-position move rewrites the manifest from the Folio outline order', async () => {
  await write('report/contents/01-opening.md', '# Opening\n')
  await write('report/contents/02-close.md', '# Close\n')
  await write(indexPath, '# Report\n\n## Running order\n\n- [[Opening]]\n- [[Close]]\n')
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({
    schema_version: 1,
    content_root: 'contents',
    files: [{ path: '01-opening.md', role: 'section' }],
  }))

  await movePart(ws, 'report', 0, 0)
  expect(await manifestFiles()).toEqual([
    { path: '01-opening.md', role: 'section' },
    { path: '02-close.md', role: 'section' },
  ])
})

test('a failed materialise leaves the Folio outline readable and the phantom manifest entry inert', async () => {
  class FileFailingWorkspace extends Workspace {
    override async createFile(path: string, content: string) {
      if (path.endsWith('/01-intended-part.md')) throw new Error('injected file write failure')
      return super.createFile(path, content)
    }
  }

  await write(indexPath, '# Report\n\n## Running order\n\n- [[Intended part]] — The future opening\n')
  const failing = new FileFailingWorkspace(root)
  const beforeOrder = await orderFor(failing, 'report')
  await expect(materialisePart(failing, 'report', 0)).rejects.toThrow('injected file write failure')

  const after = await readPlan(failing, 'report')
  expect(partShape(after!)).toEqual([
    { title: 'Intended part', gloss: 'The future opening', role: 'section', path: null },
  ])
  expect(await read(indexPath)).toBe('# Report\n\n## Running order\n\n- [[Intended part]] — The future opening\n')
  expect(await orderFor(failing, 'report')).toEqual(beforeOrder)
  expect(await exists(`report/${MANIFEST_NAME}`)).toBe(false)
})

test('a writer refuses to save a Folio outline line that its parser cannot round-trip', async () => {
  await write(indexPath, '# Report\n\n## Running order\n')
  await expect(insertPart(ws, 'report', 0, { title: 'Bad ]] title' })).rejects.toThrow('Folio outline title')
  expect(await read(indexPath)).toBe('# Report\n\n## Running order\n')
})
