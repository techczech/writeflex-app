import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { Workspace } from '../../src/main/workspace'
import { readFolioRoom } from '../../src/main/folio-room'
import { readFolioPlan, reorderParts, movePart, insertPart, adoptPart, removePart } from '../../src/main/plan'
import { folioPieces, orderFor, readManifest, manifestFilePathCandidates } from '../../src/main/folio'
import { readPlanForAgent } from '../../src/main/plan-agent-reads'
import { runCli } from '../../src/main/cli/run'
import * as roomOrder from '../../src/renderer/src/components/FolioRoomOrder'

let root: string
let ws: Workspace
const authored = ['parts/./00-introduction.md', 'x.md', 'essays/y.md']
const paths = ['F/parts/00-introduction.md', 'F/answers/x.md', 'F/essays/y.md']
const manifestPath = 'F/_report-structure.json'
const indexPath = 'F/_F_INDEX.md'
const disk = (path: string) => readFile(join(root, path), 'utf8')
async function put(path: string, text: string) {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), text)
}
beforeEach(async () => {
  root = await mkdtemp(join(import.meta.dir, '.folio-content-root-'))
  ws = new Workspace(root)
  for (const [at, path] of paths.entries()) await put(path, `# Part ${at + 1}\n\nText.\n`)
  await put(manifestPath, JSON.stringify({ schema_version: 1, content_root: 'answers', files: authored.map(path => ({ path })) }))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const strings = async () => JSON.parse(await disk(manifestPath)).files.map((file: { path: string }) => file.path)

test('room, export order and command-line reader include every mixed-root entry in manifest order', async () => {
  expect((await readFolioRoom(ws, 'F'))?.parts.map(part => part.key.path)).toEqual(paths)
  expect(await orderFor(ws, 'F')).toEqual(paths)
  expect((await readPlanForAgent(ws, 'F', { manifestOrder: true })).hasIndexNote).toBe(false)
  expect((await readPlanForAgent(ws, 'F', { manifestOrder: true })).parts.map(part => part.path)).toEqual(paths)
  let output = ''
  const code = await runCli(['--root', root, '--json', 'running-order', 'F'], { cwd: root, stdout: text => { output += text }, stderr: () => {}, openUrl: async () => { throw new Error('A read must not open anything') } })
  expect(code).toBe(0)
  expect(JSON.parse(output).result.parts.map((part: { path: string }) => part.path)).toEqual(paths)
})

test('first Plan write creates an Index Note containing all entries; reorder preserves authored manifest strings', async () => {
  await movePart(ws, 'F', 2, 0)
  expect(await strings()).toEqual([authored[2], authored[0], authored[1]])
  expect((await readFolioPlan(ws, 'F'))?.parts.map(part => part.path)).toEqual([paths[2], paths[0], paths[1]])
  expect(await disk(indexPath)).toContain('## Running order')
  await reorderParts(ws, 'F', [1, 2, 0])
  expect(await strings()).toEqual(authored)
})

test('add and remove preserve the authored strings of retained mixed-root entries', async () => {
  await movePart(ws, 'F', 2, 0)
  await reorderParts(ws, 'F', [1, 2, 0])
  await insertPart(ws, 'F', 3, { title: 'Future' })
  expect(await strings()).toEqual(authored)
  await put('F/answers/extra.md', '# Extra\n')
  await adoptPart(ws, 'F', 0)
  expect(await strings()).toEqual([...authored, 'extra.md'])
  await removePart(ws, 'F', 1)
  expect(await strings()).toEqual([authored[0], authored[2], 'extra.md'])
})

test('outside-folder entry is reported left out with its reason and never read', async () => {
  await put('outside.md', '# Outside\n')
  const reads: string[] = []
  const read = ws.readFile.bind(ws)
  ws.readFile = async (path) => { reads.push(path); return read(path) }
  const manifest = JSON.parse(await disk(manifestPath))
  manifest.files.push({ path: '../../outside.md' })
  await put(manifestPath, JSON.stringify(manifest))
  expect((await folioPieces(ws, 'F'))?.leftOut).toContainEqual({ path: '../../outside.md', reason: 'outside-folio' })
  // Essential read isolates part resolution from the existing workspace-wide evidence picker.
  const room = await readFolioRoom(ws, 'F', true)
  expect(room?.leftOut).toContainEqual({ path: '../../outside.md', reason: 'outside-folio' })
  expect(room?.parts.map(part => part.key.path)).toEqual(paths)
  expect(renderToStaticMarkup(<roomOrder.RoomLeftOut entries={room?.leftOut ?? []} />)).toContain('outside the Folio folder')
  expect(reads.filter(path => path === 'outside.md' || path.includes('..'))).toEqual([])
})

test('footer names the manifest without an Index Note, and the actual Index Note when present', () => {
  expect(renderToStaticMarkup(<roomOrder.RoomOrderSource indexNote={null} />)).toContain('Order of record: Folio manifest (_report-structure.json)')
  expect(renderToStaticMarkup(<roomOrder.RoomOrderSource indexNote={{ path: indexPath }} />)).toContain('Order of record: _F_INDEX.md running order')
})

test('refused content_root admits no manifest candidates', async () => {
  const manifest = JSON.parse(await disk(manifestPath))
  await put('F/direct.md', '# Direct\n')
  manifest.content_root = '../elsewhere'
  await put(manifestPath, JSON.stringify(manifest))
  const plan = await readFolioPlan(ws, 'F')
  expect(plan?.parts).toEqual([])
  const parsed = (await readManifest(ws, 'F'))!
  expect(manifestFilePathCandidates('F', parsed, parsed.files[0])).toEqual([])
  expect(plan?.unlisted.every(part => part.manifestBacked === false)).toBe(true)
  expect((await folioPieces(ws, 'F'))?.pieces).toEqual([])
})

test('listed fallback files omitted by an existing Index Note stay visible in Plan, sidebar and CLI strays', async () => {
  await put(indexPath, '# F\n\n## Running order\n\n- [[Part 2]]\n')
  const plan = await readFolioPlan(ws, 'F')
  expect(plan?.unlisted.map(part => [part.path, part.under, part.manifestBacked])).toEqual([
    [paths[0], 'parts', true], [paths[2], 'essays', true],
  ])
  const { folioOutline } = await import('../../src/main/folio-outline')
  expect((await folioOutline(ws, paths[1]))?.also.map(part => part.path)).toEqual([paths[0], paths[2]])
  expect((await readPlanForAgent(ws, 'F', { manifestOrder: true })).strays.map(part => part.path)).toEqual([paths[2], paths[0]])
})

test('an existing Index Note keeps authored path-link bytes when its mixed running order moves', async () => {
  const lines = ['- [[./parts/00-introduction.md|First]]', '- [[./answers/x.md|Second]]', '- [[./essays/y.md|Third]]']
  await put(indexPath, `# F\n\n## Running order\n\n${lines.join('\n')}\n`)
  await reorderParts(ws, 'F', [2, 0, 1])
  const source = await disk(indexPath)
  expect(source.split('\n').filter(line => line.startsWith('- [['))).toEqual([lines[2], lines[0], lines[1]])
  expect(await strings()).toEqual([authored[2], authored[0], authored[1]])
})

test('Put back accepts an already-listed fallback when the manifest order does not need rewriting', async () => {
  await put(indexPath, '# F\n\n## Running order\n\n- [[./parts/00-introduction]]\n- [[Part 2]]\n')
  expect((await readFolioPlan(ws, 'F'))?.unlisted.map(part => part.path)).toEqual([paths[2]])
  await adoptPart(ws, 'F', 0)
  expect((await readFolioPlan(ws, 'F'))?.parts.map(part => part.path)).toEqual(paths)
  expect(await strings()).toEqual(authored)
})

async function setEntries(entries: string[], extra = {}) {
  await put(manifestPath, JSON.stringify({ content_root: 'answers', ...extra, files: entries.map(path => ({ path })) }))
}

test('S1: a missing mixed entry retains its authored string when its file appears', async () => {
  await setEntries([...authored, 'parts/gone.md'])
  await movePart(ws, 'F', 1, 0)
  expect(await disk(indexPath)).toContain('./answers/parts/gone.md')
  expect(await strings()).toContain('parts/gone.md')
  await put('F/answers/parts/gone.md', '# Gone\n')
  expect((await readFolioPlan(ws, 'F'))?.parts.at(-1)?.path).toBe('F/answers/parts/gone.md')
  await movePart(ws, 'F', 0, 1)
  expect((await readFolioPlan(ws, 'F'))?.unlisted).toEqual([])
})

for (const entry of ['parts/./00-introduction.md', './x.md']) {
  test(`S2/S6: deleted entry ${entry} retains authored bytes through reorders and removal`, async () => {
    await setEntries([entry, 'essays/y.md'])
    await movePart(ws, 'F', 1, 0)
    await unlink(join(root, entry.startsWith('parts') ? paths[0] : paths[1]))
    await movePart(ws, 'F', 0, 1)
    expect(await strings()).toEqual([entry, 'essays/y.md'])
    await removePart(ws, 'F', 0)
    expect(await strings()).toEqual(['essays/y.md'])
  })
}

test('S6: a never-present entry keeps its non-normalised authored string', async () => {
  await setEntries([...authored, 'parts/./gone.md'])
  await movePart(ws, 'F', 1, 0)
  expect(await strings()).toContain('parts/./gone.md')
  await movePart(ws, 'F', 0, 1)
  expect(await strings()).toContain('parts/./gone.md')
})

test('S3: ordinary title matter and omitted files do not produce a Left out banner', async () => {
  await put('F/answers/title.md', '---\nrole: title-matter\n---\nBook\n')
  await put('F/answers/_notes.md', '# Notes\n')
  await setEntries(['title.md', 'x.md', '_notes.md'], { title_matter: 'title.md' })
  expect((await readFolioRoom(ws, 'F', true))?.leftOut).toEqual([])
  await put(indexPath, '# F\n\n## Running order\n\n- [[Part 2]]\n')
  expect((await readFolioRoom(ws, 'F', true))?.leftOut).toEqual([])
})

test('R4: removed fallbacks and unlisted sibling folders stay undiscovered', async () => {
  await setEntries([authored[0], 'x.md'])
  await put('F/parts/new.md', '# New\n')
  await put('F/old-drafts/draft.md', '# Draft\n')
  await movePart(ws, 'F', 1, 0)
  await removePart(ws, 'F', 1)
  expect((await readFolioPlan(ws, 'F'))?.unlisted).toEqual([])
  const { folioOutline } = await import('../../src/main/folio-outline')
  expect((await folioOutline(ws, paths[1]))?.also).toEqual([])
  expect((await readPlanForAgent(ws, 'F', { manifestOrder: true })).strays).toEqual([])
})

test('R2: title-only Index Note lines keep the original content-root pool', async () => {
  await put(indexPath, '# F\n\n## Running order\n\n- [[Part 1]]\n- [[Part 2]]\n- [[Part 3]]\n')
  expect((await readFolioPlan(ws, 'F'))?.parts.map(part => part.path)).toEqual([null, paths[1], null])
})

test('S3: unreadable listed entries use their authored string in the banner', async () => {
  const read = ws.readFile.bind(ws)
  ws.readFile = async path => {
    if (path === paths[0]) throw new Error('unreadable part')
    return read(path)
  }
  const room = await readFolioRoom(ws, 'F', true)
  expect(room?.leftOut).toEqual([{ path: authored[0], reason: 'unreadable' }])
})


test('S2/S6: an omitted missing authored entry survives an unrelated Index Note reorder', async () => {
  await setEntries(['x.md', 'parts/./gone.md', 'essays/y.md'])
  await put(indexPath, '# F\n\n## Running order\n\n- [[Part 2]]\n- [[./essays/y.md|Part 3]]\n')
  await movePart(ws, 'F', 1, 0)
  expect(await strings()).toContain('parts/./gone.md')
})


test('R1: an explicit Index Note link never rebinds to the content-root namesake', async () => {
  await put('F/answers/x.md', '# In\n')
  await put('F/x.md', '# Loose\n')
  await put('F/answers/y.md', '# Y\n')
  await setEntries(['x.md', 'y.md'])
  const index = '# F\n\n## Running order\n\n- [[./x.md|Loose]]\n- [[./answers/y.md|Y]]\n'
  await put(indexPath, index)
  const manifest = await disk(manifestPath)
  expect((await readFolioPlan(ws, 'F'))?.parts[0].path).toBe('F/x.md')
  await expect(movePart(ws, 'F', 1, 0)).rejects.toThrow()
  expect(await disk(indexPath)).toBe(index)
  expect(await disk(manifestPath)).toBe(manifest)
})

test('R3: ordinary Folios retain missing rows in the Outline and room', async () => {
  await put('F/a.md', '# Alpha\n')
  await put('F/b.md', '# Beta\n')
  await setEntries(['b.md', 'gone.md', 'a.md'], { content_root: '' })
  const { folioOutline } = await import('../../src/main/folio-outline')
  expect((await folioOutline(ws, 'F/a.md'))?.pieces.map(part => part.path)).toEqual(['F/b.md', 'F/gone.md', 'F/a.md'])
  const room = await readFolioRoom(ws, 'F', true)
  expect(room?.parts.map(part => [part.key.path, part.status])).toEqual([['F/b.md', 'Unsorted'], ['F/gone.md', 'Missing file'], ['F/a.md', 'Unsorted']])
  expect(room?.leftOut).toEqual([])
})

test('R5: missing entry links use the shared resolver location inside the Folio', async () => {
  await setEntries(['x.md', 'gone.md', '../parts/absent.md'])
  await movePart(ws, 'F', 1, 0)
  const index = await disk(indexPath)
  expect(index).toContain('[[./answers/gone.md|gone.md]]')
  expect(index).toContain('[[./parts/absent.md|../parts/absent.md]]')
  expect(index).not.toContain('[[./../')
  expect(await strings()).toEqual(['gone.md', 'x.md', '../parts/absent.md'])
})

test('V1: an existing missing link outside the Folio passes through unchanged', async () => {
  await setEntries(['x.md', '../parts/gone.md'])
  const index = '# F\n\n## Running order\n\n- [[./answers/x.md|X]]\n- [[./../parts/gone.md|Gone]]\n'
  await put(indexPath, index)
  const manifest = await disk(manifestPath)
  await movePart(ws, 'F', 1, 0)
  expect(await disk(indexPath)).toBe('# F\n\n## Running order\n\n- [[./../parts/gone.md|Gone]]\n- [[./answers/x.md|X]]\n')
  expect(await disk(manifestPath)).toBe(manifest)
})


for (const withManifest of [false, true]) {
  test(`V1: existing outside-Folio author line survives reorder (${withManifest ? 'manifest' : 'no manifest'})`, async () => {
    if (withManifest) await setEntries(['a.md', 'b.md'], { content_root: '' })
    else await unlink(join(root, manifestPath))
    await put('F/a.md', '# A\n')
    await put('F/b.md', '# B\n')
    await put('shared/s.md', '# Shared\n')
    const shared = '- [[./../shared/s.md|Shared]] — Author text #tag'
    await put(indexPath, `# F\n\n## Running order\n\n- [[A]]\n${shared}\n- [[B]]\n`)
    await movePart(ws, 'F', 2, 0)
    expect(await disk(indexPath)).toContain(shared + '\n')
    expect((await readFolioPlan(ws, 'F'))?.parts.map(part => part.title)).toEqual(['B', 'A', 'Shared'])
  })
}

for (const authoredGone of ['parts/gone.md', 'parts/./gone.md']) {
  test(`N1: a missing candidate follows its manifest entry when the fallback appears (${authoredGone})`, async () => {
    await setEntries(['x.md', 'parts/p.md', authoredGone])
    await put('F/parts/p.md', '# P\n')
    await movePart(ws, 'F', 1, 0)
    const before = await disk(indexPath)
    expect(before).toContain(`[[./answers/parts/gone.md|${authoredGone}]]`)
    await put('F/parts/gone.md', '# Gone\n')
    expect((await readFolioPlan(ws, 'F'))?.parts.at(-1)?.path).toBe('F/parts/gone.md')
    expect(await disk(indexPath)).toBe(before)
    await movePart(ws, 'F', 2, 0)
    expect(await disk(indexPath)).toContain(`[[./parts/gone.md|${authoredGone}]]`)
    expect(await disk(indexPath)).not.toContain('[[./answers/parts/gone.md|')
    const expected = ['F/parts/gone.md', 'F/parts/p.md', 'F/answers/x.md']
    expect((await readFolioPlan(ws, 'F'))?.parts.map(part => part.path)).toEqual(expected)
    expect((await readFolioRoom(ws, 'F', true))?.parts.map(part => part.key.path)).toEqual(expected)
    expect(await orderFor(ws, 'F')).toEqual(expected)
    expect(await strings()).toEqual([authoredGone, 'parts/p.md', 'x.md'])
  })
}

test('N1: an unmatched missing path keeps its original line on reorder', async () => {
  await setEntries(['x.md'])
  const missing = '- [[./unrelated/missing.md|An idea]] — Keep this #tag'
  await put(indexPath, `# F\n\n## Running order\n\n- [[./answers/x.md|X]]\n${missing}\n`)
  expect((await readFolioPlan(ws, 'F'))?.parts[1].manifestEntry).toBeUndefined()
  await movePart(ws, 'F', 1, 0)
  expect(await disk(indexPath)).toBe(`# F\n\n## Running order\n\n${missing}\n- [[./answers/x.md|X]]\n`)
})


test('N1: candidate matching normalises the link path and preserves its label, fragment and suffix', async () => {
  await setEntries(['x.md', 'parts/./gone.md'])
  const line = '* [[./answers/parts/./gone.md#Section|  Author label  ]] — Keep this #tag'
  await put(indexPath, `# F\n\n## Running order\n\n- [[./answers/x.md|X]]\n${line}\n`)
  await put('F/parts/gone.md', '# Gone\n')
  await movePart(ws, 'F', 1, 0)
  expect(await disk(indexPath)).toContain('* [[./parts/gone.md#Section|  Author label  ]] — Keep this #tag')
  expect(await strings()).toEqual(['parts/./gone.md', 'x.md'])
})

for (const existingFirst of [false, true]) {
  test(`N1: a missing candidate cannot take an entry owned by another line (existing first: ${existingFirst})`, async () => {
    await setEntries(['parts/gone.md'])
    await put('F/parts/gone.md', '# Gone\n')
    const missing = '- [[./answers/parts/gone.md|Missing]]'
    const existing = '- [[./parts/gone.md|Existing]]'
    await put(indexPath, `# F\n\n## Running order\n\n${existingFirst ? existing + '\n' + missing : missing + '\n' + existing}\n`)
    const parts = (await readFolioPlan(ws, 'F'))!.parts
    expect(parts.find(part => part.title === 'Missing')?.manifestEntry).toBeUndefined()
    expect(parts.find(part => part.path === 'F/parts/gone.md')?.manifestEntry).toBe('parts/gone.md')
  })
}


test('N1: only the first of two missing candidate lines binds the manifest entry', async () => {
  await setEntries(['parts/gone.md'])
  await put(indexPath, '# F\n\n## Running order\n\n- [[./answers/parts/gone.md|First]]\n- [[./answers/parts/./gone.md|Second]]\n')
  const parts = (await readFolioPlan(ws, 'F'))!.parts
  expect(parts.map(part => part.manifestEntry)).toEqual(['parts/gone.md', undefined])
})
