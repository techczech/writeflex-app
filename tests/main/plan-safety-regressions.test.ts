import { afterEach, beforeEach, expect, test } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { adoptPart, assertManifestFallbackOrder, insertPart, materialisePart, movePart, readPlan, removePart, setPartRole } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace

const indexPath = 'report/_report_INDEX.md'
const manifestPath = `report/${MANIFEST_NAME}`
const indexBackupPath = `${indexPath}.writeflex-backup`
const manifestBackupPath = `${manifestPath}.writeflex-backup`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-plan-safety-'))
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(join(root, path))
    return true
  } catch {
    return false
  }
}

async function writeManifest(files: Array<Record<string, unknown>>, contentRoot = 'contents'): Promise<string> {
  const source = `${JSON.stringify({ schema_version: 1, content_root: contentRoot, files }, null, 2)}\n`
  await write(manifestPath, source)
  return source
}

test('N1: every ordered marker is read and five reads preserve the original numbering byte-for-byte', async () => {
  const source = '# Report\n\n## Running order\n\n1. [[Alpha]]\n2. [[Beta]]\n3. [[Gamma]]\n'
  await write(indexPath, source)
  await write('report/contents/01-alpha.md', '# Alpha\n')
  await write('report/contents/02-beta.md', '# Beta\n')
  await write('report/contents/03-gamma.md', '# Gamma\n')
  await writeManifest([
    { path: '01-alpha.md' },
    { path: '02-beta.md' },
    { path: '03-gamma.md' },
  ])

  for (let readNumber = 0; readNumber < 5; readNumber += 1) {
    const plan = await readPlan(ws, 'report')
    expect(plan?.parts.map((part) => part.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(await read(indexPath)).toBe(source)
  }
})

test('N2: duplicate candidate titles remain unlisted and five reads leave both files byte-identical', async () => {
  await write(indexPath, '# Report\n\n## Running order\n')
  await write('report/contents/01-first.md', '# Report\n')
  await write('report/contents/02-second.md', '# Report\n')
  await writeManifest([
    { path: '01-first.md' },
    { path: '02-second.md' },
  ])

  const first = await readPlan(ws, 'report')
  expect(first?.parts).toEqual([])
  expect(first?.unlisted.map((part) => part.path)).toEqual([
    'report/contents/01-first.md',
    'report/contents/02-second.md',
  ])
  const originalSource = await read(indexPath)

  for (let readNumber = 1; readNumber < 5; readNumber += 1) {
    const plan = await readPlan(ws, 'report')
    expect(plan?.unlisted).toHaveLength(2)
    expect(await read(indexPath)).toBe(originalSource)
  }
})

test('N3: first materialisation excludes the Index Note and collection covers from compile order', async () => {
  await write(indexPath, '# Report\n\n## Running order\n\n- [[Intended part]]\n')
  await write('report/legacy-chapter.md', '# Legacy chapter\n')
  await write('report/README.md', '# Read me\n')
  await write('report/index.md', '# Web cover\n')
  await write('report/_report.md', '# Alternate cover\n')

  const result = await materialisePart(ws, 'report', 0)
  const files = (JSON.parse(await read(manifestPath)) as { files: Array<{ path: string }> }).files

  expect(result.path).toBe('report/01-intended-part.md')
  expect(files.map((file) => file.path)).toEqual(['legacy-chapter.md', '01-intended-part.md'])
})

test('N3: first materialisation excludes underscore-prefixed files in a subfolder', async () => {
  await write(indexPath, '# Report\n\n## Running order\n\n- [[Opening]]\n')
  await write('report/00-existing.md', '# Existing\n')
  await write('report/_private-notes.md', '# Private\n')

  await materialisePart(ws, 'report', 0)

  const files = (JSON.parse(await read(manifestPath)) as { files: Array<{ path: string }> }).files
  expect(files.map((file) => file.path)).toEqual(['00-existing.md', '01-opening.md'])
})

test('N3: first materialisation excludes underscore-prefixed files at the workspace root', async () => {
  const rootName = root.split('/').at(-1)!
  await write(`_${rootName}_INDEX.md`, '# Root\n\n## Running order\n\n- [[Opening]]\n')
  await write('00-existing.md', '# Existing\n')
  await write('_private-notes.md', '# Private\n')
  await write('_scratch.md', '# Scratch\n')

  await materialisePart(ws, '', 0)

  const files = (JSON.parse(await read(MANIFEST_NAME)) as { files: Array<{ path: string }> }).files
  expect(files.map((file) => file.path)).toEqual(['00-existing.md', '01-opening.md'])
})

test('prepareManifestWrite refuses raw fallback entries that policy must exclude', () => {
  expect(() => assertManifestFallbackOrder(['report/00-opening.md', 'report/_private.md'], 'report'))
    .toThrow(/_private\.md.*cannot enter a Folio manifest/i)
  expect(() => assertManifestFallbackOrder(['report/README.md'], 'report'))
    .toThrow(/README\.md.*cannot enter a Folio manifest/i)
})

test('an unreadable manifest refuses every Plan mutation and remains byte-identical', async () => {
  const index = '# Report\n\n## Running order\n\n- [[Opening]]\n- [[Close]]\n'
  const malformed = '{ "report_id": "keep", "files": ['
  await write(indexPath, index)
  await write('report/01-opening.md', '# Opening\n')
  await write('report/02-unlisted.md', '# Unlisted\n')
  await write(manifestPath, malformed)

  await expect(insertPart(ws, 'report', 1, { title: 'Middle' })).rejects.toThrow('Cannot write an unreadable Folio manifest')
  await expect(movePart(ws, 'report', 0, 1)).rejects.toThrow('Cannot write an unreadable Folio manifest')
  await expect(removePart(ws, 'report', 0)).rejects.toThrow('Cannot write an unreadable Folio manifest')
  await expect(adoptPart(ws, 'report', 0)).rejects.toThrow('Cannot write an unreadable Folio manifest')
  await expect(materialisePart(ws, 'report', 1)).rejects.toThrow('Cannot write an unreadable Folio manifest')

  expect(await read(indexPath)).toBe(index)
  expect(await read(manifestPath)).toBe(malformed)
  expect(await exists('report/02-close.md')).toBe(false)
})

test('an I/O-unreadable manifest refuses before materialisation leaves a stub', async () => {
  const index = '# Report\n\n## Running order\n\n- [[Close]]\n'
  const manifest = await writeManifest([{ path: '01-opening.md' }], '')
  await write(indexPath, index)
  await write('report/01-opening.md', '# Opening\n')
  const readFileNormally = ws.readFile.bind(ws)
  ws.readFile = async (path: string) => {
    if (path === manifestPath) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    return readFileNormally(path)
  }

  await expect(materialisePart(ws, 'report', 0)).rejects.toThrow('Cannot write an unreadable Folio manifest')

  expect(await read(indexPath)).toBe(index)
  expect(await read(manifestPath)).toBe(manifest)
  expect(await exists('report/01-close.md')).toBe(false)
})

test('M1: a manifest path outside the folder is kept, not deleted, and the Plan write goes through', async () => {
  const index = '# Report\n\n## Running order\n'
  await write(indexPath, index)
  const manifest = await writeManifest([{ path: '../../shared/preface.md' }])

  const plan = await insertPart(ws, 'report', 0, { title: 'Opening' })

  expect(plan.parts.map((part) => part.title)).toEqual(['Opening'])
  expect(await read(indexPath)).toBe('# Report\n\n## Running order\n- [[Opening]]\n')
  expect(await read(manifestPath)).toBe(manifest)
})

// ---- Entries the Plan cannot resolve because they point outside the Folio's folder ----

const outsideEntry = {
  id: 'shared-preface',
  path: '../../shared/preface.md',
  role: 'front-matter',
  render: 'sections',
  strip_title_matter: true,
  note: { kept: ['as', 'authored'] },
}
// Written on one line inside a pretty-printed manifest, so a re-serialised copy would not match it.
const outsideRaw = JSON.stringify(outsideEntry)

async function seedWithOutsideEntry(order: string[]): Promise<string> {
  await write(indexPath, '# Report\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]]\n- [[Gamma]]\n')
  await write('report/contents/01-alpha.md', '# Alpha\n')
  await write('report/contents/02-beta.md', '# Beta\n')
  await write('report/contents/03-gamma.md', '# Gamma\n')
  await write('report/contents/04-delta.md', '# Delta\n')
  await write('shared/preface.md', '# Preface outside the Folio\n')
  const entries = order.map((name) => (name === 'OUTSIDE' ? outsideRaw : JSON.stringify({ path: name, role: 'section' })))
  const source = `{\n  "schema_version": 1,\n  "content_root": "contents",\n  "files": [\n    ${entries.join(',\n    ')}\n  ]\n}\n`
  await write(manifestPath, source)
  return source
}

async function manifestOrder(): Promise<string[]> {
  const source = await read(manifestPath)
  // The outside entry's bytes are the ones the author wrote, and it is there exactly once.
  expect(source.split(outsideRaw).length).toBe(2)
  const parsed = JSON.parse(source) as { content_root: string; files: Array<Record<string, unknown>> }
  expect(parsed.content_root).toBe('contents')
  expect(parsed.files.filter((file) => file.path === outsideEntry.path)).toEqual([outsideEntry])
  return parsed.files.map((file) => (file.path === outsideEntry.path ? 'OUTSIDE' : file.path as string))
}

test('inserting a part keeps an outside entry as authored, immediately after the entry it followed', async () => {
  await seedWithOutsideEntry(['01-alpha.md', 'OUTSIDE', '02-beta.md', '03-gamma.md'])

  const plan = await insertPart(ws, 'report', 1, { title: 'Delta' })

  expect(plan.parts.map((part) => part.title)).toEqual(['Alpha', 'Delta', 'Beta', 'Gamma'])
  expect(await manifestOrder()).toEqual(['01-alpha.md', 'OUTSIDE', '04-delta.md', '02-beta.md', '03-gamma.md'])
  expect(await exists('shared/preface.md')).toBe(true)
})

test('moving a part keeps an outside entry after the entry it followed, and at the start when it was first', async () => {
  await seedWithOutsideEntry(['01-alpha.md', 'OUTSIDE', '02-beta.md', '03-gamma.md'])
  await movePart(ws, 'report', 2, 0)
  expect(await manifestOrder()).toEqual(['03-gamma.md', '01-alpha.md', 'OUTSIDE', '02-beta.md'])
  await movePart(ws, 'report', 1, 2)
  expect(await manifestOrder()).toEqual(['03-gamma.md', '02-beta.md', '01-alpha.md', 'OUTSIDE'])

  await seedWithOutsideEntry(['OUTSIDE', '01-alpha.md', '02-beta.md', '03-gamma.md'])
  await movePart(ws, 'report', 0, 2)
  expect(await manifestOrder()).toEqual(['OUTSIDE', '02-beta.md', '03-gamma.md', '01-alpha.md'])
})

test('removing a part keeps an outside entry: after the nearest earlier surviving entry, or at the start', async () => {
  await seedWithOutsideEntry(['01-alpha.md', '02-beta.md', 'OUTSIDE', '03-gamma.md'])
  const plan = await removePart(ws, 'report', 1)
  expect(plan.parts.map((part) => part.title)).toEqual(['Alpha', 'Gamma'])
  expect(await manifestOrder()).toEqual(['01-alpha.md', 'OUTSIDE', '03-gamma.md'])

  await removePart(ws, 'report', 0)
  expect(await manifestOrder()).toEqual(['OUTSIDE', '03-gamma.md'])
})

test('writing a part out keeps an outside entry as authored', async () => {
  await seedWithOutsideEntry(['01-alpha.md', 'OUTSIDE', '02-beta.md', '03-gamma.md'])
  await insertPart(ws, 'report', 3, { title: 'Epilogue' })

  const { path } = await materialisePart(ws, 'report', 3)

  expect(path).toBe('report/contents/04-epilogue.md')
  expect(await manifestOrder()).toEqual(['01-alpha.md', 'OUTSIDE', '02-beta.md', '03-gamma.md', '04-epilogue.md'])
})

test('a refused content_root: the Plan still reads, and every write fails with the content_root message and writes nothing', async () => {
  const index = '# Report\n\n## Running order\n\n- [[Opening]]\n- [[Opening]]\n- [[Idea]]\n'
  await write(indexPath, index)
  await write('report/01-opening.md', '# Opening\n')
  await write('report/02-loose.md', '# Loose\n')
  await write('shared/01-opening.md', '# The listed part, outside\n')
  const manifest = await writeManifest([{ path: '01-opening.md', role: 'section' }], '../shared')

  // The running order is the Index Note's own; no file is shown as compiled by the manifest.
  const plan = await readPlan(ws, 'report')
  expect(plan!.parts.map((part) => part.title)).toEqual(['Opening', 'Opening', 'Idea'])
  expect(plan!.unlisted.map((part) => ({ path: part.path, manifestBacked: part.manifestBacked }))).toEqual([
    { path: 'report/02-loose.md', manifestBacked: false },
  ])

  const refused = /content_root points outside the Folio’s folder\. Correct content_root in report\/_report-structure\.json/
  // The duplicated title skips the manifest derivation, so this insert shows the refusal comes first.
  await expect(insertPart(ws, 'report', 0, { title: 'New' })).rejects.toThrow(refused)
  await expect(movePart(ws, 'report', 2, 0)).rejects.toThrow(refused)
  await expect(removePart(ws, 'report', 2)).rejects.toThrow(refused)
  await expect(setPartRole(ws, 'report', 2, 'appendix')).rejects.toThrow(refused)
  await expect(adoptPart(ws, 'report', 0)).rejects.toThrow(refused)
  await expect(materialisePart(ws, 'report', 2)).rejects.toThrow(refused)

  expect(await read(indexPath)).toBe(index)
  expect(await read(manifestPath)).toBe(manifest)
  expect(await exists(indexBackupPath)).toBe(false)
  expect(await exists(manifestBackupPath)).toBe(false)
  expect(await exists('report/03-idea.md')).toBe(false)
})

test('M2: a refused manifest derivation cannot leave an earlier repair in the Index Note', async () => {
  const index = '# Report\n\n## Running order\n'
  await write(indexPath, index)
  await write('report/contents/01-opening.md', '# Opening\n')
  await write('report/contents/opaque.txt', 'Existing non-Markdown front matter.\n')
  const manifest = await writeManifest([
    { path: '01-opening.md' },
    { path: 'opaque.txt' },
  ])

  await expect(insertPart(ws, 'report', 0, { title: 'Preface' })).rejects.toThrow(/opaque\.txt/)

  expect(await read(indexPath)).toBe(index)
  expect(await read(manifestPath)).toBe(manifest)
  expect(await exists(indexBackupPath)).toBe(false)
  expect(await exists(manifestBackupPath)).toBe(false)
})

test('M4: an operation on a duplicated Plan part names the duplicate title without writing the manifest', async () => {
  const index = '# Report\n\n## Running order\n\n- [[Report]]\n- [[Report]]\n'
  await write(indexPath, index)
  await write('report/contents/01-report.md', '# Report\n')
  const manifest = await writeManifest([{ path: '01-report.md' }])

  await expect(movePart(ws, 'report', 0, 1)).rejects.toThrow(/duplicate.*title.*Report.*rename or remove/i)

  expect(await read(indexPath)).toBe(index)
  expect(await read(manifestPath)).toBe(manifest)
})

test('the first accepted mutation owns the safety copies and a refused mutation creates none', async () => {
  const index = '# Report\n\n## Running order\n\n- [[Opening]]\n'
  await write(indexPath, index)
  await write('report/contents/01-opening.md', '# Opening\n')
  const manifest = await writeManifest([{ path: '01-opening.md' }])

  await expect(movePart(ws, 'report', 9, 0)).rejects.toThrow('Plan part index is out of range.')
  expect(await exists(indexBackupPath)).toBe(false)
  expect(await exists(manifestBackupPath)).toBe(false)

  await insertPart(ws, 'report', 1, { title: 'Close' })
  await movePart(ws, 'report', 1, 0)

  expect(await read(indexBackupPath)).toBe(index)
  expect(await read(manifestBackupPath)).toBe(manifest)
})

test('the first materialisation does not create a backup for a manifest that did not exist', async () => {
  const index = '# Report\n\n## Running order\n\n- [[Opening]]\n'
  await write(indexPath, index)

  await materialisePart(ws, 'report', 0)

  expect(await read(indexBackupPath)).toBe(index)
  expect(await exists(manifestBackupPath)).toBe(false)
})

test('duplicate titles do not block Plan operations on unrelated parts and explain how to resolve the duplicate', async () => {
  const index = [
    '# Report',
    '',
    '## Running order',
    '',
    '- [[Notes]]',
    '- [[Notes]]',
    '- [[Alpha]]',
    '- [[Beta]]',
    '- [[Draft]]',
    '',
  ].join('\n')
  await write(indexPath, index)
  await write('report/contents/01-notes.md', '# Notes\n')
  await write('report/contents/03-alpha.md', '# Alpha\n')
  await write('report/contents/04-beta.md', '# Beta\n')
  const manifest = await writeManifest([
    { path: '01-notes.md' },
    { path: '03-alpha.md' },
    { path: '04-beta.md' },
  ])

  await insertPart(ws, 'report', 5, { title: 'Close' })
  await movePart(ws, 'report', 3, 2)
  await removePart(ws, 'report', 5)
  const materialised = await materialisePart(ws, 'report', 4)

  expect(materialised.path).toBe('report/contents/05-draft.md')
  expect(materialised.plan.parts.map((part) => part.title)).toEqual(['Notes', 'Notes', 'Beta', 'Alpha', 'Draft'])
  expect(await read(manifestPath)).toBe(manifest)
  await expect(materialisePart(ws, 'report', 0)).rejects.toThrow(/duplicate.*title.*Notes.*rename or remove/i)
})

test('ordered Plan writes renumber from the original start while unordered markers stay unordered', async () => {
  await write(indexPath, '# Report\n\n## Running order\n\n3. [[Alpha]]\n4. [[Beta]]\n5. [[Gamma]]\n')

  await insertPart(ws, 'report', 1, { title: 'Delta' })
  expect(await read(indexPath)).toContain('3. [[Alpha]]\n4. [[Delta]]\n5. [[Beta]]\n6. [[Gamma]]')

  await movePart(ws, 'report', 3, 0)
  expect(await read(indexPath)).toContain('3. [[Gamma]]\n4. [[Alpha]]\n5. [[Delta]]\n6. [[Beta]]')

  await removePart(ws, 'report', 1)
  expect(await read(indexPath)).toContain('3. [[Gamma]]\n4. [[Delta]]\n5. [[Beta]]')

  const bulletIndexPath = 'notes/_notes_INDEX.md'
  await write(bulletIndexPath, '# Notes\n\n## Running order\n\n* [[One]]\n* [[Two]]\n')
  await insertPart(ws, 'notes', 1, { title: 'Middle' })
  expect(await read(bulletIndexPath)).toContain('* [[One]]\n* [[Middle]]\n* [[Two]]')
})
