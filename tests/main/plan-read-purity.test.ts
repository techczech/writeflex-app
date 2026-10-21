import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { adoptPart, insertPart, readPlan } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace

const indexPath = 'report/_report_INDEX.md'
const manifestPath = `report/${MANIFEST_NAME}`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-plan-read-purity-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), content, 'utf8')
}

async function read(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8')
}

async function seedManifest(files: Array<Record<string, unknown>>): Promise<string> {
  const source = `${JSON.stringify({ schema_version: 1, content_root: 'contents', files }, null, 2)}\n`
  await write(manifestPath, source)
  return source
}

async function expectFivePureReads(index: string, manifest: string): Promise<void> {
  for (let readNumber = 0; readNumber < 5; readNumber += 1) await readPlan(ws, 'report')
  expect({
    index: await read(indexPath),
    manifest: await read(manifestPath),
    indexWrittenByApp: ws.wasRecentlyWrittenByApp(indexPath),
    manifestWrittenByApp: ws.wasRecentlyWrittenByApp(manifestPath),
  }).toEqual({ index, manifest, indexWrittenByApp: false, manifestWrittenByApp: false })
}

test('five reads are byte-pure for every reconciliation-sensitive Folio outline shape', async () => {
  const shapes = [
    {
      name: 'needs repair',
      index: '# Report\n\n## Running order\n',
      files: [{ path: '01-alpha.md', role: 'section' }],
      documents: [['01-alpha.md', '# Alpha\n']],
    },
    {
      name: 'duplicate titles',
      index: '# Report\n\n## Running order\n\n- [[Report]]\n- [[Report]]\n',
      files: [{ path: '01-report.md' }, { path: '02-report.md' }],
      documents: [['01-report.md', '# Report\n'], ['02-report.md', '# Report\n']],
    },
    {
      name: 'numbered Folio outline',
      index: '# Report\n\n## Running order\n\n3. [[Alpha]]\n4. [[Beta]]\n',
      files: [{ path: '01-alpha.md' }, { path: '02-beta.md' }],
      documents: [['01-alpha.md', '# Alpha\n'], ['02-beta.md', '# Beta\n']],
    },
    {
      name: 'manifest file absent on disk',
      index: '# Report\n\n## Running order\n\n- [[Alpha]]\n',
      files: [{ path: '01-alpha.md' }, { path: '02-missing.md', role: 'appendix' }],
      documents: [['01-alpha.md', '# Alpha\n']],
    },
  ] as const

  for (const shape of shapes) {
    await rm(join(root, 'report'), { recursive: true, force: true })
    await write(indexPath, shape.index)
    for (const [path, content] of shape.documents) await write(`report/contents/${path}`, content)
    const manifest = await seedManifest([...shape.files])
    await expectFivePureReads(shape.index, manifest)
  }
})

test('deleting a Folio outline line by hand keeps it deleted and reports the file as unlisted', async () => {
  await write('report/contents/01-alpha.md', '# Alpha\n')
  await write('report/contents/02-beta.md', '# Beta\n')
  await write('report/contents/03-gamma.md', '# Gamma\n')
  await seedManifest([
    { path: '01-alpha.md' },
    { path: '02-beta.md' },
    { path: '03-gamma.md' },
  ])
  const edited = '# Report\n\n## Running order\n\n- [[Alpha]] — one\n- [[Gamma]] — three\n'
  await write(indexPath, edited)

  const plan = await readPlan(ws, 'report')

  expect(await read(indexPath)).toBe(edited)
  expect(plan?.parts.map((part) => part.title)).toEqual(['Alpha', 'Gamma'])
  expect(plan?.unlisted.map((part) => part.title)).toEqual(['Beta'])
})

test('an empty manifest exposes direct Markdown files as ordered unlisted parts that can be adopted', async () => {
  const index = '# Report\n\n## Running order\n\n'
  const manifest = `${JSON.stringify({ schema_version: 1, content_root: '', files: [] }, null, 2)}\n`
  await write(indexPath, index)
  await write('report/02_key-strategic-moves.md', '# Key strategic moves\n')
  await write('report/00_strategy-framework.md', '# Strategy framework\n')
  await write('report/01_understanding-ai-in-2026.md', '---\nrole: appendix\n---\n\n# Understanding AI in 2026\n')
  await write('report/_private-notes.md', '# Private notes\n')
  await write(manifestPath, manifest)

  const plan = await readPlan(ws, 'report')

  expect(plan?.unlisted.map(({ title, path, role, manifestBacked }) => ({ title, path, role, manifestBacked }))).toEqual([
    { title: 'Strategy framework', path: 'report/00_strategy-framework.md', role: 'section', manifestBacked: false },
    { title: 'Understanding AI in 2026', path: 'report/01_understanding-ai-in-2026.md', role: 'appendix', manifestBacked: false },
    { title: 'Key strategic moves', path: 'report/02_key-strategic-moves.md', role: 'section', manifestBacked: false },
  ])
  await expectFivePureReads(index, manifest)

  const adopted = await adoptPart(ws, 'report', 1)

  expect(adopted.parts.map(({ title, path }) => ({ title, path }))).toEqual([
    { title: 'Understanding AI in 2026', path: 'report/01_understanding-ai-in-2026.md' },
  ])
  expect(adopted.parts[0].role).toBe('appendix')
  expect(adopted.unlisted.map((part) => part.title)).toEqual(['Strategy framework', 'Key strategic moves'])
  expect(await read(indexPath)).toBe(`${index}- [[Understanding AI in 2026]] #appendix\n`)
  expect((JSON.parse(await read(manifestPath)) as { files: Array<{ path: string; role?: string }> }).files).toEqual([
    { path: '01_understanding-ai-in-2026.md', role: 'appendix' },
  ])
})

test('adoptPart appends one unlisted part with derivable gloss and role, and rejects any other index', async () => {
  const index = '# Report\n\n## Running order\n\n- [[Alpha]] — one\n'
  await write(indexPath, index)
  await write('report/contents/01-alpha.md', '# Alpha\n')
  await write('report/contents/02-beta.md', '---\ndescription: two\n---\n\n# Beta\n')
  const manifest = await seedManifest([
    { path: '01-alpha.md' },
    { path: '02-beta.md', role: 'appendix', toc: false },
  ])

  await expect(adoptPart(ws, 'report', 1)).rejects.toThrow('Folio outline part index is out of range.')
  expect(await read(indexPath)).toBe(index)
  expect(await read(manifestPath)).toBe(manifest)

  const checkpoints: string[] = []
  const adopted = await adoptPart(ws, 'report', 0, {
    beforeIndexWrite: async (path) => { checkpoints.push(path) },
    beforeManifestWrite: async (path) => { checkpoints.push(path) },
  })

  expect(adopted.parts.map(({ title, gloss, role }) => ({ title, gloss, role }))).toEqual([
    { title: 'Alpha', gloss: 'one', role: 'section' },
    { title: 'Beta', gloss: 'two', role: 'appendix' },
  ])
  expect(adopted.unlisted).toEqual([])
  expect(await read(indexPath)).toBe(`${index}- [[Beta]] — two #appendix\n`)
  expect(await read(manifestPath)).toBe(manifest)
  expect(checkpoints).toEqual([indexPath])
  expect(await read(`${indexPath}.writeflex-backup`)).toBe(index)
  expect(await read(`${manifestPath}.writeflex-backup`)).toBe(manifest)
})

test('a Folio outline write leaves an unlisted manifest entry byte-identical in its existing position', async () => {
  await write(indexPath, '# Report\n\n## Running order\n\n- [[Alpha]]\n- [[Gamma]]\n')
  await write('report/contents/01-alpha.md', '# Alpha\n')
  await write('report/contents/02-beta.md', '# Beta\n')
  await write('report/contents/03-gamma.md', '# Gamma\n')
  const manifest = await seedManifest([
    { path: '01-alpha.md', role: 'section' },
    { path: '02-beta.md', role: 'appendix', toc: false, custom: 'keep exactly' },
    { path: '03-gamma.md', role: 'summary' },
  ])
  const betaEntry = '{\n      "path": "02-beta.md",\n      "role": "appendix",\n      "toc": false,\n      "custom": "keep exactly"\n    }'

  await insertPart(ws, 'report', 1, { title: 'Interlude' })

  const after = await read(manifestPath)
  expect(after).toContain(betaEntry)
  expect((JSON.parse(after) as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual([
    '01-alpha.md',
    '02-beta.md',
    '03-gamma.md',
  ])
  expect(manifest).toContain(betaEntry)
})
