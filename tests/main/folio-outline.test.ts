import { afterEach, beforeEach, expect, test } from 'bun:test'
import { open as fsOpen, stat as fsStat } from 'node:fs/promises'
import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folioPieces, MANIFEST_NAME } from '../../src/main/folio'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { cachedFolioOutlinePaths, folioOutline as folioOutlineWith, invalidateFolioOutlineFile, invalidateFolioOutlines, MAX_OUTLINE_FILE_BYTES, type OutlineFs } from '../../src/main/folio-outline'
import { scanText } from '../../src/main/jumps'
import { Workspace } from '../../src/main/workspace'
import {
  alsoLine,
  clampOffset,
  filterFolioFile,
  folderFootLine,
  groupAlsoInFolder,
  limitLevels,
  openRows,
  outlineSwitch,
  shownHeadings,
} from '../../src/shared/folio-outline'

const file = (path: string) => ({ path, name: path.split('/').at(-1)!, directory: path.split('/').slice(0, -1).join('/') })

test('the switch reads Folio only when the file is in a Folio, Folder otherwise, Folder disabled with no file', () => {
  expect(outlineSwitch(true, { dir: 'paper' })).toEqual({ second: 'Folio', secondDisabled: false })
  expect(outlineSwitch(true, null)).toEqual({ second: 'Folder', secondDisabled: false })
  expect(outlineSwitch(false, null)).toEqual({ second: 'Folder', secondDisabled: true })
  // A file with no open tab never offers the Folio, even if a stale answer is passed.
  expect(outlineSwitch(false, { dir: 'paper' })).toEqual({ second: 'Folder', secondDisabled: true })
})

test('also-in-this-folder lists direct children the running order lacks, in file-name order, with whether each is admitted', () => {
  const files = ['paper/b.md', 'paper/a.md', 'paper/_paper_INDEX.md', 'paper/Snippets.md', 'paper/glossary.md', 'paper/sub/deep.md'].map(file)
  const admissible = new Set(['paper/b.md', 'paper/a.md', 'paper/Snippets.md', 'paper/glossary.md'])
  expect(groupAlsoInFolder(files, ['paper/a.md', 'paper/sub/deep.md'], 'paper', admissible)).toEqual([
    { path: 'paper/_paper_INDEX.md', addable: false },
    { path: 'paper/b.md', addable: true },
    { path: 'paper/glossary.md', addable: true },
    { path: 'paper/Snippets.md', addable: true },
  ])
})

test('a piece listed twice does not appear under also-in-this-folder', () => {
  expect(groupAlsoInFolder(['x/a.md'].map(file), ['x/a.md', 'x/a.md'], 'x', new Set(['x/a.md']))).toEqual([])
})

test('the open file marks every running-order row of its path, or its also-in-this-folder row', () => {
  const outline = {
    pieces: [{ path: 'p/a.md' }, { path: 'p/b.md' }, { path: 'p/a.md' }],
    also: [{ path: 'p/g.md' }, { path: 'p/s.md' }],
  } as never
  expect(openRows(outline, 'p/a.md')).toEqual({ pieces: [0, 2], also: null })
  expect(openRows(outline, 's/none.md')).toEqual({ pieces: [], also: null })
  expect(openRows(outline, 'p/s.md')).toEqual({ pieces: [], also: 1 })
  expect(openRows(outline, null)).toEqual({ pieces: [], also: null })
})

test('a leading level-1 heading is the piece name, not a heading row; Levels and the filter narrow the rest', () => {
  const headings = [
    { level: 1, text: 'Shape', line: 1 }, { level: 2, text: 'Why', line: 3 }, { level: 3, text: 'Sections', line: 5 }, { level: 2, text: 'Move', line: 7 },
  ]
  expect(shownHeadings(headings).map((h) => h.text)).toEqual(['Why', 'Sections', 'Move'])
  expect(shownHeadings(headings.slice(1)).length).toBe(3) // no level-1 first: nothing dropped
  expect(limitLevels(shownHeadings(headings), 2).map((h) => h.text)).toEqual(['Why', 'Move'])
  expect(limitLevels(headings, null).length).toBe(4)
  const piece = { path: 'p/a.md', title: 'Shape', headings }
  expect(filterFolioFile(piece, 'sect')).toEqual({ keep: true, headings: [headings[2]] })
  expect(filterFolioFile(piece, 'shape').headings.length).toBe(3) // the title matches: every heading stays
  expect(filterFolioFile(piece, 'zzz').keep).toBe(false)
})

test('the group line and the Folder part foot say what the spec words', () => {
  expect(alsoLine('Example guide', 3)).toBe('In Example guide, not in the running order.')
  expect(alsoLine('Example guide', 0)).toBe('Every piece in Example guide is in the running order.')
  expect(folderFootLine('Example guide', 12, 'Welcome')).toBe('Example guide is a folder of 12 files, shown in file-name order.')
  expect(folderFootLine(null, 12, 'Welcome')).toBe('Welcome is not in a folder, so this lists the whole collection. A Folio is made from the pieces of one folder.')
})

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-outline-'))
  ws = new Workspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const manifest = (files: string[]): string => JSON.stringify({ schema_version: 1, content_root: '', files: files.map((path) => ({ path })) })

test('folio:outline gives the running order, then the folder\'s other files with headings, never reading outside the folder', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['b.md', 'gone.md', '../outside.md', 'a.md']))
  await write('paper/a.md', '# Alpha\n\n## One\n\n### One-a\n')
  await write('paper/b.md', '# Beta\n\n## Two\n')
  await write('paper/Snippets.md', '# Snippets\n\n## Openings\n')
  await write('paper/_paper_INDEX.md', '# Index\n')
  await write('paper/sub/deep.md', '# Deep\n')
  await write('outside.md', '# Outside\n\n## Never read\n')
  const outline = await folioOutline(ws, 'paper/a.md')
  expect(outline?.dir).toBe('paper')
  expect(outline?.pieces.map((p) => [p.path, p.title, p.headings.map((h) => h.text)])).toEqual([
    ['paper/b.md', 'Beta', ['Beta', 'Two']],
    ['paper/a.md', 'Alpha', ['Alpha', 'One', 'One-a']],
  ])
  expect(outline?.pieces[1].headings[1]).toEqual({ level: 2, text: 'One', line: 3 })
  // This Folio lists a file that is gone and one outside its folder: its order is the Plan's to change, so nothing is addable here.
  expect(outline?.also.map((f) => [f.path, f.addable])).toEqual([['paper/_paper_INDEX.md', false], ['paper/Snippets.md', false]])
  expect(outline?.orderInPlanOnly).toBe(true)
  // A file of "Also in this folder" is in the same Folio; a file outside every Folio is in none.
  expect((await folioOutline(ws, 'paper/Snippets.md'))?.pieces.length).toBe(2)
  expect(await folioOutline(ws, 'outside.md')).toBeNull()
})

test('headings are cached until the file changes or the root is invalidated', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md']))
  await write('paper/a.md', '# Alpha\n\n## One\n')
  // A fixed stamp stands in for "size, times and inode unchanged" (the changed time of a rewrite cannot be put back).
  const pinned = { size: 16, mtimeMs: 1000, ctimeMs: 1000, ino: 7 }
  fsOverride.stat = async () => pinned
  expect((await folioOutline(ws, 'paper/a.md'))?.pieces[0].headings.length).toBe(2)
  await write('paper/a.md', '# Alpha\n\n## Two\n')
  expect((await folioOutline(ws, 'paper/a.md'))?.pieces[0].headings[1].text).toBe('One') // same stamp: from the cache
  invalidateFolioOutlines(root)
  expect((await folioOutline(ws, 'paper/a.md'))?.pieces[0].headings[1].text).toBe('Two')
  // A changed time alone (real stat, same size) is seen without any invalidation.
  fsOverride.stat = undefined
  await write('paper/a.md', '# Alpha\n\n## Six\n')
  expect((await folioOutline(ws, 'paper/a.md'))?.pieces[0].headings[1].text).toBe('Six')
  // So is a change in size.
  await write('paper/a.md', '# Alpha\n\n## Six\n\n## Three\n')
  expect((await folioOutline(ws, 'paper/a.md'))?.pieces[0].headings.map((h) => h.text)).toEqual(['Alpha', 'Six', 'Three'])
})

test('a Folio folder reached through a symlink lists nothing', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md']))
  await write('paper/a.md', '# Alpha\n')
  await symlink(join(root, 'paper'), join(root, 'mirror'))
  const outline = await folioOutline(ws, 'mirror/a.md')
  expect(outline === null || (outline.pieces.length === 0 && outline.also.length === 0)).toBe(true)
})

test('a path that is not workspace-relative is refused', async () => {
  await expect(folioOutline(ws, '../x.md')).rejects.toThrow()
  await expect(folioOutline(ws, '/etc/passwd')).rejects.toThrow()
  expect(await folioOutline(ws, 'https://example.com/a.md')).toBeNull()
})

// Reads of file content, by workspace path, since the last reset. The reader is given a counting file system.
let reads: string[] = []
let fsOverride: Partial<OutlineFs> = {}
const countingFs = (): OutlineFs => ({
  stat: (absolute) => (fsOverride.stat ?? realStat)(absolute),
  open: async (absolute) => {
    const handle = await (fsOverride.open ?? realOpen)(absolute)
    let counted = false
    return {
      stat: () => handle.stat(),
      // A file counts as read when its content is first asked for (a too-large file is opened and stat'ed only).
      read: (buffer, offset, length, position) => {
        if (!counted) { counted = true; reads.push(absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute) }
        return handle.read(buffer, offset, length, position)
      },
      close: () => handle.close(),
    }
  },
})
const realOpen: OutlineFs['open'] = async (absolute) => {
  const handle = await fsOpen(absolute, 'r')
  return {
    stat: () => handle.stat(),
    read: async (buffer, offset, length, position) => ({ bytesRead: (await handle.read(buffer, offset, length, position)).bytesRead }),
    close: () => handle.close(),
  }
}
const realStat: OutlineFs['stat'] = (absolute) => fsStat(absolute)
const folioOutline = (w: Workspace, path: string) => folioOutlineWith(w, path, countingFs())
beforeEach(() => { reads = []; fsOverride = {} })
afterEach(() => { invalidateFolioOutlines(root) })

test('a manifest entry that leaves the folder is reported left out by the guard, and its target is never read', async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'wf-folio-outline-out-'))
  try {
    await writeFile(join(outsideDir, 'abs.md'), '# Absolute\n', 'utf8')
    await write('outside.md', '# Outside\n')
    await write(`paper/${MANIFEST_NAME}`, manifest(['a.md', '../outside.md', join(outsideDir, 'abs.md')]))
    await write('paper/a.md', '# Alpha\n')
    const pieces = await folioPieces(ws, 'paper')
    expect(pieces?.pieces).toEqual(['paper/a.md'])
    expect(pieces?.leftOut).toEqual([
      { path: '../outside.md', reason: 'outside-folio' },
      { path: join(outsideDir, 'abs.md'), reason: 'outside-folio' },
    ])
    const outline = await folioOutline(ws, 'paper/a.md')
    expect(outline?.pieces.map((p) => p.path)).toEqual(['paper/a.md'])
    expect(reads.every((path) => path.startsWith('paper/'))).toBe(true)
  } finally {
    await rm(outsideDir, { recursive: true, force: true })
  }
})

test('an absolute content_root lists nothing and reads nothing outside', async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'wf-folio-outline-out-'))
  try {
    await writeFile(join(outsideDir, 'a.md'), '# Outside\n', 'utf8')
    await write(`paper/${MANIFEST_NAME}`, JSON.stringify({ schema_version: 1, content_root: outsideDir, files: [{ path: 'a.md' }] }))
    await write('paper/a.md', '# Alpha\n')
    const pieces = await folioPieces(ws, 'paper')
    expect(pieces?.pieces).toEqual([])
    expect(pieces?.leftOut[0].reason).toBe('outside-folio')
    const outline = await folioOutline(ws, 'paper/a.md')
    expect(outline?.pieces).toEqual([])
    expect(reads.some((path) => path.includes(outsideDir))).toBe(false)
  } finally {
    await rm(outsideDir, { recursive: true, force: true })
  }
})

test('a symlinked file inside the Folio folder that points outside is not listed and not read', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md', 'link.md']))
  await write('paper/a.md', '# Alpha\n')
  await write('secret.md', '# Secret\n\n## Never\n')
  await symlink(join(root, 'secret.md'), join(root, 'paper/link.md'))
  const outline = await folioOutline(ws, 'paper/a.md')
  expect(outline?.pieces.map((p) => p.path)).toEqual(['paper/a.md'])
  expect(outline?.also.map((p) => p.path)).toEqual([])
  expect(reads).toEqual(['paper/a.md'])
})

test('the outline lists exactly the pieces folioPieces gives the Plan and the export, a nested Folio\'s entry included', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['inner/a.md', 'b.md']))
  await write(`paper/inner/${MANIFEST_NAME}`, manifest(['a.md']))
  await write('paper/inner/a.md', '# Inner\n')
  await write('paper/b.md', '# Beta\n')
  const outline = await folioOutline(ws, 'paper/b.md')
  expect(outline?.pieces.map((p) => p.path)).toEqual((await folioPieces(ws, 'paper'))!.pieces)
})

test('a file over 2 MB is not read: no headings, flagged tooLarge; headings are capped at 200 characters', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['big.md', 'a.md']))
  await write('paper/big.md', `# Big\n\n## Hidden\n\n${'x'.repeat(MAX_OUTLINE_FILE_BYTES + 1)}\n`)
  await write('paper/a.md', `# Alpha\n\n## ${'w'.repeat(500)}\n`)
  const outline = await folioOutline(ws, 'paper/a.md')
  expect(reads).toEqual(['paper/a.md'])
  expect(outline?.pieces[0]).toMatchObject({ path: 'paper/big.md', headings: [], tooLarge: true })
  expect(outline?.pieces[1].tooLarge).toBeUndefined()
  expect(outline?.pieces[1].headings[1].text.length).toBe(200)
})

test('a failed read is answered empty for that request only and is not cached', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md']))
  await write('paper/a.md', '# Alpha\n\n## One\n')
  await chmod(join(root, 'paper/a.md'), 0o000)
  try {
    expect((await folioOutline(ws, 'paper/a.md'))?.pieces[0].headings).toEqual([])
  } finally {
    await chmod(join(root, 'paper/a.md'), 0o644)
  }
  expect((await folioOutline(ws, 'paper/a.md'))?.pieces[0].headings.map((h) => h.text)).toEqual(['Alpha', 'One'])
})

test('saving one file re-reads only that file', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md', 'b.md', 'c.md']))
  for (const name of ['a', 'b', 'c']) await write(`paper/${name}.md`, `# ${name}\n\n## One\n`)
  await folioOutline(ws, 'paper/a.md')
  expect(reads.length).toBe(3)
  reads = []
  await folioOutline(ws, 'paper/a.md')
  expect(reads).toEqual([])
  // Same size and mtime: only the dropped entry is read again.
  const before = (await ws.listFilesIn('paper')).find((f) => f.path === 'paper/b.md')!
  await write('paper/b.md', '# b\n\n## Two\n')
  await utimes(join(root, 'paper/b.md'), new Date(before.modifiedAt), new Date(before.modifiedAt))
  invalidateFolioOutlineFile(root, 'paper/b.md')
  const outline = await folioOutline(ws, 'paper/a.md')
  expect(reads).toEqual(['paper/b.md'])
  expect(outline?.pieces[1].headings[1].text).toBe('Two')
})

test('the heading cache holds exactly 2,000 files per root, the oldest out first', async () => {
  const names = Array.from({ length: 2010 }, (_, i) => `p${String(i).padStart(4, '0')}.md`)
  await write(`paper/${MANIFEST_NAME}`, manifest(names))
  for (const name of names) await writeFile(join(root, 'paper', name), `# ${name}\n`, 'utf8')
  await folioOutline(ws, 'paper/p0000.md')
  expect(reads.length).toBe(2010)
  // The first ten went, in the order they were added: the cache is the last 2,000, oldest first.
  expect(cachedFolioOutlinePaths(root)).toEqual(names.slice(10).map((name) => `paper/${name}`))
})

test('a file that grows past the cap between stat and read is tooLarge, and no more than cap+1 bytes are read', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md']))
  await write('paper/a.md', '# Alpha\n')
  let delivered = 0
  fsOverride.open = async () => ({
    stat: async () => ({ size: 10 }), // looked small …
    read: async (buffer, offset, length) => { // … then keeps growing
      const n = Math.min(length, 64 * 1024)
      buffer.fill(0x78, offset, offset + n)
      delivered += n
      return { bytesRead: n }
    },
    close: async () => undefined,
  })
  const outline = await folioOutline(ws, 'paper/a.md')
  expect(outline?.pieces[0]).toMatchObject({ headings: [], tooLarge: true })
  expect(delivered).toBeLessThanOrEqual(MAX_OUTLINE_FILE_BYTES + 1)
  expect(delivered).toBeGreaterThan(MAX_OUTLINE_FILE_BYTES)
})

test('a path named by a rename, trash, restore or create is dropped from the cache', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md', 'b.md']))
  await write('paper/a.md', '# A\n')
  await write('paper/b.md', '# B\n')
  await folioOutline(ws, 'paper/a.md')
  expect(cachedFolioOutlinePaths(root).sort()).toEqual(['paper/a.md', 'paper/b.md'])
  invalidateFolioOutlineFile(root, 'paper/a.md')
  expect(cachedFolioOutlinePaths(root)).toEqual(['paper/b.md'])
})

test('a changed inode with the same size and modified time is read again', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md']))
  await write('paper/a.md', '# Alpha\n')
  await folioOutline(ws, 'paper/a.md')
  await folioOutline(ws, 'paper/a.md')
  expect(reads).toEqual(['paper/a.md'])
  fsOverride.stat = async (absolute) => ({ ...(await realStat(absolute)), ino: 424242 })
  await folioOutline(ws, 'paper/a.md')
  expect(reads).toEqual(['paper/a.md', 'paper/a.md'])
})

test('a file with 10,000 headings lists 400, titles and headings are cut at 200 characters, and the scan stops at the limit', async () => {
  const body = Array.from({ length: 10000 }, (_, i) => `## H${i + 1}`).join('\n')
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md']))
  await write('paper/a.md', `# ${'T'.repeat(500)}\n\n${body}\n`)
  const outline = await folioOutline(ws, 'paper/a.md')
  expect(outline?.pieces[0].headings.length).toBe(400)
  expect(outline?.pieces[0].title.length).toBe(200)
  // The scan itself returns at the limit: the 401st heading is never produced.
  const scanned = scanText(body, { headings: true, headingLimit: 400 })
  expect(scanned.length).toBe(400)
  expect(scanned.at(-1)).toMatchObject({ text: 'H400', line: 400 })
  expect(scanText(body, { headings: true }).length).toBe(10000) // no limit: the old behaviour
})

test('a jump offset beyond the document is clamped, not thrown', () => {
  expect(clampOffset(900, 10)).toBe(10)
  expect(clampOffset(-3, 10)).toBe(0)
  expect(clampOffset(4, 10)).toBe(4)
})

test('a title taken from the filename after a failed stat or read is also cut at 200 characters', async () => {
  const name = `${'n'.repeat(227)}.md` // 230 characters with the extension
  await write(`paper/${MANIFEST_NAME}`, manifest([name]))
  await write(`paper/${name}`, '# Never read\n')
  fsOverride.stat = async () => { throw new Error('gone') }
  const outline = await folioOutline(ws, `paper/${name}`)
  expect(outline?.pieces[0].title.length).toBeGreaterThan(0)
  expect(outline?.pieces[0].title.length).toBeLessThanOrEqual(200)
  fsOverride = {}
  invalidateFolioOutlines(root)
  fsOverride.open = async () => { throw new Error('unreadable') }
  const again = await folioOutline(ws, `paper/${name}`)
  expect(again?.pieces[0].title.length).toBeLessThanOrEqual(200)
})
