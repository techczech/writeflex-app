import { test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { Workspace } from '../../src/main/workspace'
import { folioPieces, MANIFEST_NAME, manifestPartEntries, parseManifest, titleMatterPath } from '../../src/main/folio'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { assessManifestOnly, readManifestOnly, rewrittenManifestForTest } from '../../src/main/folio-manifest-order'
import { addFolioPieces, moveFolioPiece, reorderFolioPieces } from '../../src/main/folio-running-order'
import { assessOutlineOrder } from '../../src/main/folio-order-assessment'
import { folioFrontMatter, frontMatterPathSet } from '../../src/main/folio-front-matter'
import { readPlan } from '../../src/main/plan'
import { exportBundle } from '../../src/main/export'
import { exportCollectionTitle } from '../../src/main/export-title'
import { folioRunningOrder } from '../../src/main/sharing-folio'
import { jsonArrayLayout } from '../../src/main/json-array-layout'
import { collectionPieces } from '../../src/main/collection'
import { DEFAULT_VAULT_WORK_SETTINGS, detectVaultWorks, markdownFactsFrom } from '../../src/main/vault-works'
import { documentTitle } from '../../src/main/frontmatter'
import { folioFilesReaders, mainProgram, plantedProgram } from './folio-manifest-files-readers'

// One resolver for a manifest's logical order (spec-folio-room-data-model § 1 D-FILES-2 (c), § 22; ticket 04):
// `manifestPartEntries` leaves room support entries out of every order, and the manifest-only writers map logical
// positions back to authored slots, so a support entry keeps its slot and its bytes. The export title asks
// `titleMatterPath`, which never names a support file (§ 23 r6-1).

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-part-entries-'))
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
  invalidateFolioPlaces(root)
  invalidateFolioOrderFacts(root)
}
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
const raws = (source: string): string[] => jsonArrayLayout(source, 'files').entries.map((entry) => entry.raw)

const DIR = 'paper'
const MANIFEST = `${DIR}/${MANIFEST_NAME}`
const EVIDENCE = '_paper_EVIDENCE-AND-NOTES.md'
const EVIDENCE_TEXT = '# Evidence and notes\n\n## [[A]]\n\n### Notes\n\nPRIVATE_NOTE_WORDS.\n'
/** As a hand-edited manifest might hold it: odd spacing and a key the app does not know. */
const EVIDENCE_ENTRY = `{ "path": "${EVIDENCE}",   "note": "kept by hand" }`
const A = `${DIR}/01-a.md`
const B = `${DIR}/02-b.md`
const C = `${DIR}/03-c.md`
const manifestOf = (entries: string[], extra = ''): string => `{\n  "schema_version": 1,${extra}\n  "content_root": "",\n  "files": [\n    ${entries.join(',\n    ')}\n  ]\n}\n`
const ENTRY_A = '{ "path": "01-a.md", "role": "section" }'
const ENTRY_B = '{"path":"02-b.md","role":"section"}'

/** No Index Note; the parts, the evidence file, and a manifest of `entries`. */
async function manifestOnlyFolio(entries: string[], extra = ''): Promise<void> {
  await write(A, '# A\n\nAlpha.\n')
  await write(B, '# B\n\nBeta.\n')
  await write(C, '# C\n\nGamma.\n')
  await write(`${DIR}/${EVIDENCE}`, EVIDENCE_TEXT)
  await write(MANIFEST, manifestOf(entries, extra))
}

/** The folder's names: a refusal leaves no backup or staged file. */
const folderNames = async (): Promise<string[]> => (await readdir(join(root, DIR))).sort()

test('manifestPartEntries: authored order and slots, resolved paths, support entries left out whatever content_root says', () => {
  const manifest = parseManifest(DIR, `{ "content_root": "contents", "files": [{ "path": "a.md" }, { "path": "${EVIDENCE}" }, { "path": "contents/b.md" }, { "path": "gone.md" }, { "path": "map.canvas" }, { "path": "a.md" }] }`)!
  const present = new Set([`${DIR}/contents/a.md`, `${DIR}/contents/b.md`, `${DIR}/${EVIDENCE}`, `${DIR}/map.canvas`])
  expect(manifestPartEntries(DIR, manifest, present)).toEqual([
    { slot: 0, file: { path: 'a.md' }, path: `${DIR}/contents/a.md` },
    { slot: 2, file: { path: 'contents/b.md' }, path: `${DIR}/contents/b.md` },
    { slot: 3, file: { path: 'gone.md' }, path: null },
    { slot: 5, file: { path: 'a.md' }, path: `${DIR}/contents/a.md` },
  ])
})

test('r5: no Index Note, manifest A, B, evidence → order [A, B]; reorder writes B, A, evidence (evidence bytes unchanged); Add C writes B, A, evidence, C', async () => {
  await manifestOnlyFolio([ENTRY_A, ENTRY_B, EVIDENCE_ENTRY])
  const seen = await readManifestOnly(ws, DIR)
  expect(seen.assessment).toEqual({ ok: true, order: [A, B] })
  expect((await folioPieces(ws, DIR))?.pieces).toEqual([A, B])

  const reordered = await reorderFolioPieces(ws, DIR, { order: [B, A], expected: [A, B] })
  expect(reordered.result).toEqual({ ok: true, changed: true, order: [B, A] })
  expect(raws(read(MANIFEST))).toEqual([ENTRY_B, ENTRY_A, EVIDENCE_ENTRY])
  expect(read(MANIFEST)).toBe(manifestOf([ENTRY_B, ENTRY_A, EVIDENCE_ENTRY]))

  const added = await addFolioPieces(ws, DIR, { paths: [C], expected: [B, A] })
  expect(added.result).toMatchObject({ ok: true, changed: true, order: [B, A, C] })
  const after = raws(read(MANIFEST))
  expect(after.slice(0, 3)).toEqual([ENTRY_B, ENTRY_A, EVIDENCE_ENTRY])
  expect(after).toHaveLength(4)
  expect(JSON.parse(after[3]).path).toBe('03-c.md')
  expect((await readManifestOnly(ws, DIR)).assessment).toEqual({ ok: true, order: [B, A, C] })
})

test('a support entry between parts keeps its own slot: reorder and move swap the parts around it', async () => {
  await manifestOnlyFolio([ENTRY_A, EVIDENCE_ENTRY, ENTRY_B])
  expect((await readManifestOnly(ws, DIR)).assessment).toEqual({ ok: true, order: [A, B] })
  expect((await reorderFolioPieces(ws, DIR, { order: [B, A], expected: [A, B] })).result).toMatchObject({ ok: true, order: [B, A] })
  expect(raws(read(MANIFEST))).toEqual([ENTRY_B, EVIDENCE_ENTRY, ENTRY_A])
  // Move A before B, by logical position.
  expect((await moveFolioPiece(ws, DIR, { path: A, beforePath: B, expected: [B, A] })).result).toMatchObject({ ok: true, order: [A, B] })
  expect(raws(read(MANIFEST))).toEqual([ENTRY_A, EVIDENCE_ENTRY, ENTRY_B])
})

test('Add of front matter goes before the slot of the first part after the front-matter block, never past a support entry', async () => {
  const front = '{ "path": "01-a.md", "role": "front-matter" }'
  await manifestOnlyFolio([front, EVIDENCE_ENTRY, ENTRY_B])
  await write(C, '---\nrole: front-matter\n---\n# C\n')
  const added = await addFolioPieces(ws, DIR, { paths: [C], expected: [A, B] })
  expect(added.result).toMatchObject({ ok: true, order: [A, C, B] })
  const after = raws(read(MANIFEST))
  expect(after[0]).toBe(front)
  expect(after[1]).toBe(EVIDENCE_ENTRY)
  expect(JSON.parse(after[2]).path).toBe('03-c.md')
  expect(after[3]).toBe(ENTRY_B)
})

test('a stale request is still refused, and writes nothing: the expected order counts no support entry', async () => {
  await manifestOnlyFolio([ENTRY_A, ENTRY_B, EVIDENCE_ENTRY])
  const before = read(MANIFEST)
  const names = await folderNames()
  const refused = await reorderFolioPieces(ws, DIR, { order: [B, A, `${DIR}/${EVIDENCE}`], expected: [A, B, `${DIR}/${EVIDENCE}`] })
  expect(refused.result).toMatchObject({ ok: false, stale: true })
  expect(read(MANIFEST)).toBe(before)
  expect(await folderNames()).toEqual(names)
})

test('the manifest changing between the read and the commit is refused, and the other version is kept (I-6)', async () => {
  await manifestOnlyFolio([ENTRY_A, ENTRY_B, EVIDENCE_ENTRY])
  const other = manifestOf([ENTRY_A, ENTRY_B, EVIDENCE_ENTRY, '{ "path": "03-c.md" }'])
  const refused = await reorderFolioPieces(ws, DIR, { order: [B, A], expected: [A, B] }, {
    beforeManifestWrite: async () => { await writeFile(join(root, MANIFEST), other, 'utf8') },
  })
  expect(refused.result.ok).toBe(false)
  expect((refused.result as { message: string }).message).toMatch(/changed|nothing was changed/i)
  expect(read(MANIFEST)).toBe(other)
})

test('the Outline order assessment with an Index Note compares the logical order (support entry not counted)', async () => {
  await manifestOnlyFolio([ENTRY_A, EVIDENCE_ENTRY, ENTRY_B])
  await write(`${DIR}/_paper_INDEX.md`, '# Paper\n\n## Running order\n\n- [[A]]\n- [[B]]\n')
  const plan = await readPlan(ws, DIR)
  const manifest = parseManifest(DIR, read(MANIFEST))
  const present = new Set((await ws.listFilesIn(DIR)).map((file) => file.path))
  expect(assessOutlineOrder(plan, manifest, present)).toEqual({ ok: true, order: [A, B] })
  expect((await folioRunningOrder(root, DIR))?.map((entry) => entry.path)).toEqual([A, B])
})

test('a title_matter naming the evidence file is ignored by the Plan and by front-matter detection', async () => {
  await manifestOnlyFolio([ENTRY_A, ENTRY_B, EVIDENCE_ENTRY], `\n  "title_matter": "${EVIDENCE}",`)
  await write(`${DIR}/_paper_INDEX.md`, '# Paper\n\n## Running order\n\n- [[A]]\n- [[B]]\n')
  const manifest = parseManifest(DIR, read(MANIFEST))!
  const present = new Set((await ws.listFilesIn(DIR)).map((file) => file.path))
  expect(manifest.titleMatter).toBe(EVIDENCE)
  expect(titleMatterPath(DIR, manifest, present)).toBeNull()
  expect([...frontMatterPathSet(DIR, manifest, present, [])]).toEqual([])
  expect(await folioFrontMatter(ws, DIR)).toEqual({ front: [], titlePage: null })
  const plan = (await readPlan(ws, DIR))!
  expect(plan.parts.map((part) => part.path)).toEqual([A, B])
  expect([...plan.parts, ...plan.unlisted].filter((part) => part.manifestTitlePage || part.titlePage)).toEqual([])
  expect([...plan.parts, ...plan.unlisted].map((part) => part.path)).not.toContain(`${DIR}/${EVIDENCE}`)
})

/** The title the HTML export (its `<title>`) and the Word export (its document title) carry. */
async function exportTitles(): Promise<{ html: string; word: string }> {
  const out = await mkdtemp(join(tmpdir(), 'wf-part-entries-out-'))
  try {
    await exportBundle(ws, { dir: DIR, format: 'html', target: join(out, 'p.html') })
    const html = /<title>([^<]*)<\/title>/.exec(readFileSync(join(out, 'p.html'), 'utf8'))?.[1] ?? ''
    const word = await exportBundle(ws, { dir: DIR, format: 'docx', target: join(out, 'p.docx') })
    const core = await (await JSZip.loadAsync(await readFile(word.target))).file('docProps/core.xml')!.async('string')
    return { html, word: /<dc:title>([^<]*)<\/dc:title>/.exec(core)?.[1] ?? '' }
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}

test('T-CONTAIN (r6-1): title_matter names the evidence file, no title page, no manifest title → HTML and Word title equal the fixture’s without title_matter', async () => {
  await manifestOnlyFolio([ENTRY_A, ENTRY_B], `\n  "title_matter": "${EVIDENCE}",`)
  expect(await exportCollectionTitle(ws, DIR)).not.toBe('Evidence and notes')
  const withEvidence = await exportTitles()
  await write(MANIFEST, manifestOf([ENTRY_A, ENTRY_B]))
  const without = await exportTitles()
  expect(without.html).not.toBe('')
  expect(without.word).not.toBe('')
  expect(withEvidence).toEqual(without)
  expect(withEvidence.html).not.toContain('Evidence and notes')
})

// The anti-regression scan (§ 22): only these functions may read a parsed Folio's `files`; every other order reader
// asks `manifestPartEntries`. Named by function, so a new reader in one of these files still fails.
const ALLOWED: Record<string, string[]> = {
  'src/main/folio.ts': ['parseManifest', 'titleMatterPath', 'manifestPartEntries', 'manifestRoomSupportEntries', 'draftManifest'],
  // (b) Plan array writers and their guards, and the two convention readers (spelling, entry shape).
  'src/main/plan.ts': ['prepareManifestWrite', 'keepEntriesAsAuthored', 'assertManifestNamesIntendedFiles', 'assertManifestWritePreservesExistingFiles', 'namedAfterManifestAdd', 'withManifestRole', 'newManifestPath', 'manifestSiblingEntries'],
  // The whole-array shape check stays on the authored array.
  'src/main/folio-manifest-order.ts': ['assessManifestOnly/sameEntries'],
  // Path repair: an entry's path is repaired like any entry; no order is produced.
  'src/main/rename-repair.ts': ['prepareManifestWrites'],
  'src/main/cli/organise-operations.ts': ['innerManifestNotices'],
}
const allowed = (file: string, chain: string): boolean => (ALLOWED[file] ?? []).some((name) => chain === name || chain.startsWith(`${name}/`))
const relative = (file: string): string => file.slice(resolve('.').length + 1)

test('anti-regression: no reader of a parsed Folio’s files outside the allow-list, and every allow-listed function exists', () => {
  const { program, files } = mainProgram()
  const outside = folioFilesReaders(program, files).filter((reader) => !allowed(relative(reader.file), reader.chain))
  expect(outside.map((reader) => `${relative(reader.file)}:${reader.line} ${reader.chain}`)).toEqual([])
  for (const [file, names] of Object.entries(ALLOWED)) {
    const text = readFileSync(resolve(file), 'utf8')
    for (const name of names) {
      for (const part of name.split('/')) expect(new RegExp(`(?:function|const|let) ${part}\\b`).test(text) ? `${file} ${part}` : `${file} ${part} MISSING`).toBe(`${file} ${part}`)
    }
  }
}, 60_000)

test('anti-regression: the scan fails on a planted new reader of files inside an allow-listed file, and inside an allow-listed function outside its allowed part', () => {
  const folio = resolve('src/main/folio.ts')
  const order = resolve('src/main/folio-manifest-order.ts')
  const orderText = readFileSync(order, 'utf8')
  const anchor = '  if (!sameEntries) return { ok: false, reason: \'unreadable-entry\' }\n'
  expect(orderText).toContain(anchor)
  const planted = new Map([
    [folio, `${readFileSync(folio, 'utf8')}\nexport function plantedOrder(manifest: Folio): string[] { return manifest.files.map((file) => file.path) }\n`],
    [order, orderText.replace(anchor, `${anchor}  const planted = manifest.files.length\n  void planted\n`)],
  ])
  const program = plantedProgram([folio, order], planted)
  const outside = folioFilesReaders(program, [folio, order]).filter((reader) => !allowed(relative(reader.file), reader.chain))
  expect(outside.map((reader) => `${relative(reader.file)} ${reader.chain}`)).toEqual([
    'src/main/folio.ts plantedOrder',
    'src/main/folio-manifest-order.ts assessManifestOnly/planted',
  ])
}, 60_000)

test('a manifest-ordered front-matter block read through the resolver: a support entry first does not end the block', async () => {
  const front = '{ "path": "01-a.md", "role": "front-matter" }'
  await manifestOnlyFolio([EVIDENCE_ENTRY, front, ENTRY_B])
  await write(C, '---\nrole: front-matter\n---\n# C\n')
  const added = await addFolioPieces(ws, DIR, { paths: [C], expected: [A, B] })
  expect(added.result).toMatchObject({ ok: true, order: [A, C, B] })
  const after = raws(read(MANIFEST))
  expect(after.slice(0, 2)).toEqual([EVIDENCE_ENTRY, front])
  expect(JSON.parse(after[2]).path).toBe('03-c.md')
  expect(after[3]).toBe(ENTRY_B)
  // Front matter still leads: B cannot move before A, by logical position.
  const refused = await moveFolioPiece(ws, DIR, { path: B, beforePath: A, expected: [A, C, B] })
  expect(refused.result.ok).toBe(false)
})

test('an entry naming the evidence file with a front-matter role is not front matter', async () => {
  await manifestOnlyFolio([`{ "path": "${EVIDENCE}", "role": "front-matter" }`, ENTRY_A, ENTRY_B])
  const manifest = parseManifest(DIR, read(MANIFEST))!
  const present = new Set((await ws.listFilesIn(DIR)).map((file) => file.path))
  expect([...frontMatterPathSet(DIR, manifest, present, [])]).toEqual([])
})

test('the first part of a folder piece and a vault work’s parts are never a support file', async () => {
  await write('series/report/_report-structure.json', `{ "files": [{ "path": "${EVIDENCE}" }, { "path": "01-a.md" }] }`)
  await write(`series/report/${EVIDENCE}`, EVIDENCE_TEXT)
  await write('series/report/01-a.md', '# A\n')
  const piece = (await collectionPieces(ws, 'series')).find((item) => item.folderPath === 'series/report')
  expect(piece?.path).toBe('series/report/01-a.md')
  const index = detectVaultWorks({ rootName: 'vault', files: [`report/${EVIDENCE}`, 'report/01-a.md'], folders: ['report'], manifests: ['report'] }, DEFAULT_VAULT_WORK_SETTINGS, {
    declaration: folder => ({ isFolio: folder === 'report', manifest: folder === 'report', runningOrder: false, repairNeeded: false }),
    markdown: (path) => markdownFactsFrom(path.endsWith(EVIDENCE) ? EVIDENCE_TEXT : '# A\n', path, documentTitle('# A\n', path)),
    manifest: () => `{ "files": [{ "path": "${EVIDENCE}" }, { "path": "01-a.md" }] }`,
  })
  expect(index.works.find((work) => work.path === 'report')?.parts).toEqual(['report/01-a.md'])
})

// Opus review r1 of ticket 04, finding 1: an authored path that keeps no support basename but normalises to the
// support file (`_paper_EVIDENCE-AND-NOTES.md/x/..`) is a support entry too, judged on where it resolves.
const DOTTED = `${EVIDENCE}/x/..`
const DOTTED_ENTRY = `{ "path": "${DOTTED}",  "note": "dotted" }`

test('a `..`-suffixed title_matter that resolves to the evidence file: no title page, no front matter, export title not the evidence heading', async () => {
  await manifestOnlyFolio([ENTRY_A, ENTRY_B], `\n  "title_matter": "${DOTTED}",`)
  const manifest = parseManifest(DIR, read(MANIFEST))!
  const present = new Set((await ws.listFilesIn(DIR)).map((file) => file.path))
  expect(manifest.titleMatter).toBe(DOTTED)
  expect(titleMatterPath(DIR, manifest, present)).toBeNull()
  expect(await folioFrontMatter(ws, DIR)).toEqual({ front: [], titlePage: null })
  expect(await exportCollectionTitle(ws, DIR)).not.toBe('Evidence and notes')
  const titles = await exportTitles()
  expect(titles.html).not.toBe('')
  expect(titles.html).not.toContain('Evidence and notes')
  expect(titles.word).not.toContain('Evidence and notes')
})

test('a `..`-suffixed files entry that resolves to the evidence file is no piece, not counted, kept verbatim at its slot on reorder', async () => {
  await manifestOnlyFolio([ENTRY_A, DOTTED_ENTRY, ENTRY_B])
  const manifest = parseManifest(DIR, read(MANIFEST))!
  const present = new Set((await ws.listFilesIn(DIR)).map((file) => file.path))
  expect(manifestPartEntries(DIR, manifest, present).map((entry) => entry.slot)).toEqual([0, 2])
  expect(await folioPieces(ws, DIR)).toEqual({ pieces: [A, B], leftOut: [{ path: DOTTED, reason: 'room-support' }] })
  expect(assessManifestOnly(DIR, manifest, read(MANIFEST), present)).toEqual({ ok: true, order: [A, B] })
  expect((await reorderFolioPieces(ws, DIR, { order: [B, A], expected: [A, B] })).result).toMatchObject({ ok: true, order: [B, A] })
  expect(raws(read(MANIFEST))).toEqual([ENTRY_B, DOTTED_ENTRY, ENTRY_A])
})

test('a `..`-suffixed entry first is never a folder piece’s main document or a vault work’s part', async () => {
  const listed = `{ "files": [{ "path": "${DOTTED}" }, { "path": "01-a.md" }] }`
  await write('series/report/_report-structure.json', listed)
  await write(`series/report/${EVIDENCE}`, EVIDENCE_TEXT)
  await write('series/report/01-a.md', '# A\n')
  const piece = (await collectionPieces(ws, 'series')).find((item) => item.folderPath === 'series/report')
  expect(piece?.path).toBe('series/report/01-a.md')
  const index = detectVaultWorks({ rootName: 'vault', files: [`report/${EVIDENCE}`, 'report/01-a.md'], folders: ['report'], manifests: ['report'] }, DEFAULT_VAULT_WORK_SETTINGS, {
    declaration: folder => ({ isFolio: folder === 'report', manifest: folder === 'report', runningOrder: false, repairNeeded: false }),
    markdown: (path) => markdownFactsFrom(path.endsWith(EVIDENCE) ? EVIDENCE_TEXT : '# A\n', path, documentTitle('# A\n', path)),
    manifest: () => listed,
  })
  expect(index.works.find((work) => work.path === 'report')?.parts).toEqual(['report/01-a.md'])
})

test('a slot mapping that drops or doubles an authored element is refused before anything is written (finding 3)', async () => {
  await manifestOnlyFolio([ENTRY_A, EVIDENCE_ENTRY, ENTRY_B])
  const seen = await readManifestOnly(ws, DIR)
  const refusal = /could not be rewritten exactly, so nothing was changed/
  // Dropped: the support entry's slot (1) is missing.
  expect(() => rewrittenManifestForTest(DIR, seen, [{ keep: 2 }, { keep: 0 }], [B, A])).toThrow(refusal)
  // Doubled: slot 1 twice.
  expect(() => rewrittenManifestForTest(DIR, seen, [{ keep: 2 }, { keep: 1 }, { keep: 1 }, { keep: 0 }], [B, A])).toThrow(refusal)
  // The full mapping passes.
  expect(raws(rewrittenManifestForTest(DIR, seen, [{ keep: 2 }, { keep: 1 }, { keep: 0 }], [B, A]))).toEqual([ENTRY_B, EVIDENCE_ENTRY, ENTRY_A])
})

test('a slot mapping of the right length that swaps one support entry for another is refused (finding 3)', async () => {
  const MAP_ENTRY = '{ "path": "map.canvas" }'
  await manifestOnlyFolio([ENTRY_A, EVIDENCE_ENTRY, MAP_ENTRY, ENTRY_B])
  await write(`${DIR}/map.canvas`, '{}')
  const seen = await readManifestOnly(ws, DIR)
  expect(seen.assessment).toEqual({ ok: true, order: [A, B] })
  // The Map's slot (2) dropped and the evidence slot (1) written twice: the read-back alone would accept it.
  expect(() => rewrittenManifestForTest(DIR, seen, [{ keep: 3 }, { keep: 1 }, { keep: 1 }, { keep: 0 }], [B, A])).toThrow(/could not be rewritten exactly/)
  expect(raws(rewrittenManifestForTest(DIR, seen, [{ keep: 3 }, { keep: 1 }, { keep: 2 }, { keep: 0 }], [B, A]))).toEqual([ENTRY_B, EVIDENCE_ENTRY, MAP_ENTRY, ENTRY_A])
})
