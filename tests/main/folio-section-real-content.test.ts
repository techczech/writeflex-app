import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Workspace } from '../../src/main/workspace'
import { readFolioRoom } from '../../src/main/folio-room'
import { folioOutline } from '../../src/main/folio-outline'
import { folioOutlineFlow } from '../../src/shared/folio-heading-flow'
import { sectionOutlineRows } from '../../src/shared/folio-sections'
import { withSectionPage } from '../../src/main/folio-section-role'

// Opt-in local acceptance check. The source is read only; only its temporary copy is marked.
const source = process.env.WRITEFLEX_REAL_SECTION_SOURCE
const real = source ? test : test.skip
real('real linguistics book has ten sections, with Introduction outside; source bytes and timestamps stay unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'folio-real-sections-'))
  try {
    const manifest = await readFile(join(source!, '_report-structure.json'), 'utf8')
    const files = (JSON.parse(manifest) as { files: { path: string }[] }).files
    const snapshots = new Map<string, { hash: string; mtime: number }>()
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    await writeFile(join(root, '_report-structure.json'), manifest)
    for (const file of files) {
      const original = await readFile(join(source!, file.path), 'utf8')
      snapshots.set(file.path, { hash: hash(original), mtime: (await stat(join(source!, file.path))).mtimeMs })
      const section = /^parts\/(?:0[1-9]-.*|10-essays)\.md$/.test(file.path)
      await mkdir(dirname(join(root, file.path)), { recursive: true })
      await writeFile(join(root, file.path), section ? withSectionPage(original, true, file.path) : original)
    }
    const ws = new Workspace(root)
    const model = (await readFolioRoom(ws, ''))!
    const rows = sectionOutlineRows(model.parts, new Set())
    expect(rows.filter(row => row.sectionPage)).toHaveLength(10)
    const intro = model.parts.find(part => part.key.path === 'parts/00-introduction.md')!
    expect(rows.find(row => row.index === intro.index)?.sectionIndex).toBeNull()
    const outline = (await folioOutline(ws, 'parts/00-introduction.md'))!
    const flow = folioOutlineFlow(outline)
    expect(flow.sections).toHaveLength(10)
    expect(flow.parts[0].title).toBe('Introduction')
    expect(flow.parts[0].depth).toBe(0)
    expect(flow.parts[0].role).toBe('chapter')
    expect(flow.parts).toHaveLength(files.length)
    for (const [path, before] of snapshots) {
      expect(hash(await readFile(join(source!, path), 'utf8'))).toBe(before.hash)
      expect((await stat(join(source!, path))).mtimeMs).toBe(before.mtime)
    }
    expect(await readFile(join(source!, '_report-structure.json'), 'utf8')).toBe(manifest)
    console.log(`Real book: ${model.parts.length} parts, ${flow.sections!.length} sections, ${flow.chapters} chapters; Introduction outside; ${snapshots.size} source files unchanged.`)
  } finally { await rm(root, { recursive: true, force: true }) }
})
