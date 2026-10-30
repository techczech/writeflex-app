import { pinnedIndex } from '../helpers/folio-file-identity'
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { Workspace } from '../../src/main/workspace'
import { fallbackFolioParts, folioPieces, MANIFEST_NAME, orderFor } from '../../src/main/folio'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { movePart, readPlan } from '../../src/main/plan'
import { listCollection } from '../../src/main/collection'
import { exportBundle } from '../../src/main/export'
import { folioRunningOrder, partKeysFor, renderFolioForSharing } from '../../src/main/sharing-folio'
import { isEligibleFolioMetadata, isEligiblePiece, isSharablePiece } from '../../src/main/sharing-source-eligibility'
import { resolvesToRoomSupportFile } from '../../src/main/room-support-target'
import { isFolioPartCandidateName, isRoomSupportName } from '../../src/shared/folio-part-name'

// Room support files are never parts (spec-folio-room-data-model § 1 D-FILES-2, invariant I-9; ticket 03):
// the evidence-and-notes file and any `.canvas` file stay out of every part list, export and Share, and every
// Plan manifest write keeps a manifest entry naming one exactly as authored, whatever `content_root` says.

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-room-support-'))
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
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

const EVIDENCE = '_paper_EVIDENCE-AND-NOTES.md'
const EVIDENCE_TEXT = '# Evidence and notes\n\n## [[A]]\n\n### Notes\n\nPRIVATE_NOTE_WORDS quoted from a source.\n'
const MAP = '_paper_MAP.canvas'
/** The evidence entry as a hand-edited manifest might hold it: odd spacing and a key the app does not know. */
const EVIDENCE_ENTRY = `{ "path": "${EVIDENCE}",   "note": "kept by hand" }`

const noSupport = (paths: readonly string[]): void => {
  expect(paths.filter(isRoomSupportName)).toEqual([])
}

/** Every export and Share route for `dir`: none may carry the evidence file's words or path. */
async function assertNothingLeaves(dir: string, parts: number): Promise<void> {
  const out = await mkdtemp(join(tmpdir(), 'wf-room-support-out-'))
  try {
    const html = await exportBundle(ws, { dir, format: 'html', target: join(out, 'p.html') })
    expect(html.pieces).toBe(parts)
    expect(readFileSync(join(out, 'p.html'), 'utf8')).not.toContain('PRIVATE_NOTE_WORDS')
    const word = await exportBundle(ws, { dir, format: 'docx', target: join(out, 'p.docx') })
    expect(word.pieces).toBe(parts)
    const xml = await (await JSZip.loadAsync(await readFile(word.target))).file('word/document.xml')!.async('string')
    expect(xml).not.toContain('PRIVATE_NOTE_WORDS')
  } finally {
    await rm(out, { recursive: true, force: true })
  }
  const order = await folioRunningOrder(root, dir)
  expect(order).not.toBeNull()
  noSupport(order!.map((entry) => entry.path))
  const shared = await renderFolioForSharing(root, dir, 'img', order!, partKeysFor(order!, {}))
  expect(shared.parts.map((part) => part.path).filter(isRoomSupportName)).toEqual([])
  expect(JSON.stringify(shared)).not.toContain('PRIVATE_NOTE_WORDS')
  noSupport((await listCollection(ws, dir)).rows.map((row) => row.path))
}

test('the name rule: the evidence-and-notes file and any .canvas file, by basename, any letter case; nothing else', () => {
  for (const path of [EVIDENCE, `paper/${EVIDENCE}`, 'a/b/_x_evidence-and-notes.md', '__EVIDENCE-AND-NOTES.md', MAP, 'x.canvas', 'sub\\Map.CANVAS']) {
    expect(isRoomSupportName(path)).toBe(true)
    expect(isFolioPartCandidateName(path.split(/[\\/]/).pop()!)).toBe(false)
  }
  for (const path of ['paper_EVIDENCE-AND-NOTES.md', '_EVIDENCE-AND-NOTES.md', `${EVIDENCE}.writeflex-backup`, '_paper_EVIDENCE-AND-NOTES.txt', 'canvas.md', 'x.canvas.md', '_paper_INDEX.md', 'notes.md', 'paper.canvas/notes.md']) {
    expect(isRoomSupportName(path)).toBe(false)
  }
})

test('T-CONTAIN: a manifest listing the evidence file → not exported (HTML, Word), not published, left out as room-support, no Board row', async () => {
  await write('paper/01-a.md', '# A\n\nAlpha words.\n')
  await write('paper/02-b.md', '# B\n\nBeta words.\n')
  await write(`paper/${EVIDENCE}`, EVIDENCE_TEXT)
  await write('paper/_paper_INDEX.md', '# Paper\n\n## Running order\n\n- [[A]]\n- [[B]]\n')
  await write(`paper/${MANIFEST_NAME}`, `{ "schema_version": 1, "content_root": "", "files": [{ "path": "01-a.md" }, ${EVIDENCE_ENTRY}, { "path": "02-b.md" }] }\n`)
  expect(await folioPieces(ws, 'paper')).toEqual({ pieces: ['paper/01-a.md', 'paper/02-b.md'], leftOut: [{ path: EVIDENCE, reason: 'room-support' }] })
  expect(await orderFor(ws, 'paper')).toEqual(['paper/01-a.md', 'paper/02-b.md'])
  const plan = await readPlan(ws, 'paper')
  expect(plan?.parts.map((part) => part.path)).toEqual(['paper/01-a.md', 'paper/02-b.md'])
  noSupport(plan?.unlisted.map((part) => part.path ?? '') ?? [])
  await assertNothingLeaves('paper', 2)
  // Not publishable on its own either: the one source rule refuses it wherever it is asked.
  expect(isSharablePiece(root, `paper/${EVIDENCE}`)).toBe(false)
  expect(isEligiblePiece(root, `paper/${EVIDENCE}`)).toBe(false)
  expect(isEligiblePiece(root, 'paper/01-a.md')).toBe(true)
  // A manifest entry for a map, there or not, is left out for the same reason.
  await write(`paper/${MANIFEST_NAME}`, `{ "files": [{ "path": "01-a.md" }, { "path": "${MAP}" }] }\n`)
  expect((await folioPieces(ws, 'paper'))?.leftOut).toEqual([{ path: MAP, reason: 'room-support' }])
})

test('T-CONTAIN: content_root "contents" with the root evidence file in the manifest → a reorder succeeds, that entry’s bytes unchanged', async () => {
  await write('paper/contents/01-a.md', '# A\n\nAlpha.\n')
  await write('paper/contents/02-b.md', '# B\n\nBeta.\n')
  await write('paper/contents/03-c.md', '# C\n\nGamma, listed but not in the running order.\n')
  await write(`paper/${EVIDENCE}`, EVIDENCE_TEXT)
  const index = '# Paper\n\n## Running order\n\n- [[A]]\n- [[B]]\n'
  await write('paper/_paper_INDEX.md', index)
  const manifest = `{\n  "schema_version": 1,\n  "content_root": "contents",\n  "files": [\n    { "path": "01-a.md" },\n    ${EVIDENCE_ENTRY},\n    { "path": "03-c.md" },\n    { "path": "02-b.md" }\n  ]\n}\n`
  await write(`paper/${MANIFEST_NAME}`, manifest)
  const before = await readPlan(ws, 'paper')
  expect(before?.parts.map((part) => part.title)).toEqual(['A', 'B'])
  expect(before?.unlisted.map((part) => part.path)).toEqual(['paper/contents/03-c.md'])

  const after = await movePart(ws, 'paper', 1, 0)
  expect(after.parts.map((part) => part.title)).toEqual(['B', 'A'])
  expect(read('paper/_paper_INDEX.md')).toBe(pinnedIndex('# Paper\n\n## Running order\n\n- [[B]]\n- [[A]]\n', {"B":"./contents/02-b.md|B","A":"./contents/01-a.md|A"}))
  const written = read(`paper/${MANIFEST_NAME}`)
  // The evidence element's own bytes, still right after the entry it followed (A's).
  expect(written).toContain(EVIDENCE_ENTRY)
  // It held no part's slot: the written parts fill the other slots in their new order, and C keeps its own.
  expect((JSON.parse(written).files as Array<{ path: string }>).map((file) => file.path)).toEqual(['02-b.md', '03-c.md', '01-a.md', EVIDENCE])
  expect(read(`paper/${EVIDENCE}`)).toBe(EVIDENCE_TEXT)
  expect(await folioPieces(ws, 'paper')).toEqual({
    pieces: ['paper/contents/02-b.md', 'paper/contents/03-c.md', 'paper/contents/01-a.md'],
    leftOut: [{ path: EVIDENCE, reason: 'room-support' }],
  })
  await assertNothingLeaves('paper', 3)
})

test('Share: a manifest entry for an evidence file not on disk yet is not published as a missing part', async () => {
  await write('paper/01-a.md', '# A\n')
  await write('paper/_paper_INDEX.md', '# Paper\n\n## Running order\n\n- [[A]]\n')
  await write(`paper/${MANIFEST_NAME}`, `{ "files": [{ "path": "01-a.md" }, ${EVIDENCE_ENTRY}, { "path": "${MAP}" }, { "path": "gone.md" }] }\n`)
  // A written part that is gone still holds its place as missing; the room's files never do.
  expect(await folioRunningOrder(root, 'paper')).toEqual([
    { path: 'paper/01-a.md', missing: false },
    { path: 'paper/gone.md', missing: true },
  ])
  expect((await folioPieces(ws, 'paper'))?.leftOut).toEqual([
    { path: EVIDENCE, reason: 'room-support' },
    { path: MAP, reason: 'room-support' },
    { path: 'gone.md', reason: 'not-found' },
  ])
})

test('the same reorder with no content_root: the evidence entry is kept as authored, never a hidden part', async () => {
  await write('paper/01-a.md', '# A\n')
  await write('paper/02-b.md', '# B\n')
  await write(`paper/${EVIDENCE}`, EVIDENCE_TEXT)
  await write('paper/_paper_INDEX.md', '# Paper\n\n## Running order\n\n- [[A]]\n- [[B]]\n')
  await write(`paper/${MANIFEST_NAME}`, `{ "content_root": "", "files": [{ "path": "01-a.md" }, ${EVIDENCE_ENTRY}, { "path": "02-b.md" }] }\n`)
  await movePart(ws, 'paper', 1, 0)
  const written = read(`paper/${MANIFEST_NAME}`)
  expect(written).toContain(EVIDENCE_ENTRY)
  expect((JSON.parse(written).files as Array<{ path: string }>).map((file) => file.path)).toEqual(['02-b.md', '01-a.md', EVIDENCE])
})

test('a refused reorder over a manifest that lists the evidence file writes nothing and says why', async () => {
  await write('paper/contents/01-a.md', '# A\n')
  await write('paper/contents/02-b.md', '# B\n')
  await write(`paper/${EVIDENCE}`, EVIDENCE_TEXT)
  const index = '# Paper\n\n## Running order\n\n- [[A]]\n- [[B]]\n'
  await write('paper/_paper_INDEX.md', index)
  const manifest = `{ "content_root": "contents", "files": [{ "path": "01-a.md" }, ${EVIDENCE_ENTRY}, { "path": "02-b.md" }] }\n`
  await write(`paper/${MANIFEST_NAME}`, manifest)
  const racer = `{ "content_root": "contents", "files": [${EVIDENCE_ENTRY}, { "path": "01-a.md" }, { "path": "02-b.md" }] }\n`
  await expect(movePart(ws, 'paper', 1, 0, {
    beforeManifestWrite: async () => { await writeFile(join(root, `paper/${MANIFEST_NAME}`), racer) },
  })).rejects.toThrow('The Folio manifest changed while the Folio outline was being updated.')
  // The other editor's manifest stands, and the Index Note is put back as it was.
  expect(read(`paper/${MANIFEST_NAME}`)).toBe(racer)
  expect(read('paper/_paper_INDEX.md')).toBe(index)
  expect(read(`paper/${EVIDENCE}`)).toBe(EVIDENCE_TEXT)
})

test('no Index Note entries and the evidence file in the manifest → no such part in the Plan; nothing from it in export or Share; the read writes nothing', async () => {
  await write('paper/01-a.md', '# A\n\nAlpha.\n')
  await write('paper/02-b.md', '# B\n\nBeta.\n')
  await write(`paper/${EVIDENCE}`, EVIDENCE_TEXT)
  const index = '# Paper\n\n## Running order\n'
  await write('paper/_paper_INDEX.md', index)
  const manifest = `{ "content_root": "", "files": [{ "path": "01-a.md" }, ${EVIDENCE_ENTRY}, { "path": "02-b.md" }] }\n`
  await write(`paper/${MANIFEST_NAME}`, manifest)
  const plan = await readPlan(ws, 'paper')
  expect(plan?.parts.map((part) => part.path)).toEqual(['paper/01-a.md', 'paper/02-b.md'])
  noSupport(plan?.unlisted.map((part) => part.path ?? '') ?? [])
  expect(read('paper/_paper_INDEX.md')).toBe(index)
  expect(read(`paper/${MANIFEST_NAME}`)).toBe(manifest)
  await assertNothingLeaves('paper', 2)
})

test('a plan line naming the evidence file by title reads as an unwritten part, never the file', async () => {
  await write('paper/01-a.md', '# A\n')
  await write(`paper/${EVIDENCE}`, EVIDENCE_TEXT)
  await write('paper/_paper_INDEX.md', '# Paper\n\n## Running order\n\n- [[A]]\n- [[_paper_EVIDENCE-AND-NOTES]]\n- [[Evidence and notes]]\n')
  const plan = await readPlan(ws, 'paper')
  expect(plan?.parts.map((part) => [part.title, part.path])).toEqual([
    ['A', 'paper/01-a.md'],
    ['_paper_EVIDENCE-AND-NOTES', null],
    ['Evidence and notes', null],
  ])
  noSupport(plan?.unlisted.map((part) => part.path ?? '') ?? [])
})

test('a manifest-less Folio: neither the evidence file nor a .canvas file is in the file-name order, the Board or the export', async () => {
  await write('paper/01-a.md', '# A\n\nAlpha.\n')
  await write('paper/02-b.md', '# B\n\nBeta.\n')
  await write(`paper/${EVIDENCE}`, EVIDENCE_TEXT)
  await write(`paper/${MAP}`, '{"nodes":[{"id":"n1","type":"text","text":"PRIVATE_NOTE_WORDS","x":0,"y":0,"width":10,"height":10}],"edges":[]}\n')
  await write('paper/sketch.canvas', '{"nodes":[],"edges":[]}\n')
  await write('paper/_paper_INDEX.md', '# Paper\n\n## Running order\n\n- [[A]]\n- [[B]]\n')
  expect(await fallbackFolioParts(ws, 'paper')).toEqual(['paper/01-a.md', 'paper/02-b.md'])
  expect(await orderFor(ws, 'paper')).toEqual(['paper/01-a.md', 'paper/02-b.md'])
  expect((await listCollection(ws, 'paper')).rows.map((row) => row.path)).toEqual(['paper/01-a.md', 'paper/02-b.md'])
  await assertNothingLeaves('paper', 2)
})

// Sol review r1 of ticket 03 (MAJOR, privacy): a part replaced by a link (symlink) to a room support file keeps an
// ordinary name, so the rule must judge the file a read really opens, not only the name asked for.
const MAP_TEXT = '{"nodes":[{"id":"n","type":"text","text":"PRIVATE_NOTE_WORDS on the map"}],"edges":[]}\n'
const supportTargets = [
  { label: 'the evidence-and-notes file', target: EVIDENCE, text: EVIDENCE_TEXT },
  { label: 'a .canvas file', target: MAP, text: MAP_TEXT },
]
/** Replace `rel` (a written file) by a link to `target`, a name in the same folder. */
const swapForLink = (rel: string, target: string): void => {
  unlinkSync(join(root, rel))
  symlinkSync(target, join(root, rel))
}

for (const { label, target, text } of supportTargets) {
  test(`individual publishing: a piece that is a link to ${label} is refused`, async () => {
    await write('paper/01-a.md', '# A\n')
    await write(`paper/${target}`, text)
    expect(isEligiblePiece(root, 'paper/01-a.md')).toBe(true)
    swapForLink('paper/01-a.md', target)
    expect(resolvesToRoomSupportFile(root, 'paper/01-a.md')).toBe(true)
    expect(isSharablePiece(root, 'paper/01-a.md')).toBe(false)
    expect(isEligiblePiece(root, 'paper/01-a.md')).toBe(false)
    // A link through a folder: the file it really opens is still the support file.
    await mkdir(join(root, 'other'), { recursive: true })
    symlinkSync('../paper', join(root, 'other', 'via'))
    expect(isEligiblePiece(root, `other/via/${target}`)).toBe(false)
    // Folio metadata (an Index Note) replaced by such a link is never read either.
    await write('paper/_paper_INDEX.md', '# Paper\n')
    expect(isEligibleFolioMetadata(root, 'paper/_paper_INDEX.md')).toBe(true)
    swapForLink('paper/_paper_INDEX.md', target)
    expect(isEligibleFolioMetadata(root, 'paper/_paper_INDEX.md')).toBe(false)
  })

  test(`Folio share: a part swapped for a link to ${label} after the order is read is published as missing, its text never`, async () => {
    await write('paper/01-a.md', '# A\n\nAlpha words.\n')
    await write('paper/02-b.md', '# B\n\nBeta words.\n')
    await write(`paper/${target}`, text)
    await write('paper/_paper_INDEX.md', '# Paper\n\n## Running order\n\n- [[A]]\n- [[B]]\n')
    await write(`paper/${MANIFEST_NAME}`, '{ "files": [{ "path": "01-a.md" }, { "path": "02-b.md" }] }\n')
    const order = await folioRunningOrder(root, 'paper')
    expect(order).toEqual([{ path: 'paper/01-a.md', missing: false }, { path: 'paper/02-b.md', missing: false }])
    swapForLink('paper/01-a.md', target)
    const shared = await renderFolioForSharing(root, 'paper', 'img', order!, partKeysFor(order!, {}))
    expect(shared.parts.map((part) => [part.path, part.missing])).toEqual([['paper/01-a.md', true], ['paper/02-b.md', false]])
    expect(JSON.stringify(shared)).not.toContain('PRIVATE_NOTE_WORDS')
  })

  test(`export: a part swapped for a link to ${label} at any read during the export is never read into it`, async () => {
    const setUp = async (): Promise<void> => {
      await rm(join(root, 'paper'), { recursive: true, force: true })
      await write('paper/01-a.md', '# A\n\nAlpha words.\n')
      await write('paper/02-b.md', '# B\n\nBeta words.\n')
      await write(`paper/${target}`, text)
      await write('paper/_paper_INDEX.md', '# Paper\n\n## Running order\n\n- [[A]]\n- [[B]]\n')
      await write(`paper/${MANIFEST_NAME}`, '{ "files": [{ "path": "01-a.md" }, { "path": "02-b.md" }] }\n')
      invalidateFolioPlaces(root)
      invalidateFolioOrderFacts(root)
    }
    // A Workspace that, at its `swapAt`-th read of the first part, replaces the second part by the link: so
    // every moment between listing and reading the second part is tried in turn.
    class Swapping extends Workspace {
      reads = 0
      constructor(dir: string, readonly swapAt: number) { super(dir) }
      override async readFile(path: string) {
        const result = await super.readFile(path)
        if (path === 'paper/01-a.md' && ++this.reads === this.swapAt) swapForLink('paper/02-b.md', target)
        return result
      }
    }
    await setUp()
    const out = await mkdtemp(join(tmpdir(), 'wf-room-support-out-'))
    try {
      const counting = new Swapping(root, 0)
      await exportBundle(counting, { dir: 'paper', format: 'html', target: join(out, 'p.html') })
      expect(counting.reads).toBeGreaterThan(0)
      for (let swapAt = 1; swapAt <= counting.reads; swapAt += 1) {
        for (const format of ['html', 'docx'] as const) {
          await setUp()
          const file = join(out, `p-${swapAt}.${format}`)
          await exportBundle(new Swapping(root, swapAt), { dir: 'paper', format, target: file }).catch(() => null)
          const written = format === 'html'
            ? readFileSync(file, 'utf8')
            : await (await JSZip.loadAsync(await readFile(file))).file('word/document.xml')!.async('string')
          expect(written).toContain('Alpha words.')
          expect(written).not.toContain('PRIVATE_NOTE_WORDS')
        }
      }
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
}

test('Board rows and Plan candidates: a part swapped for a link to the evidence file after any listing: no Board row or Plan part shows it or resolves to it', async () => {
  const setUp = async (): Promise<void> => {
    await rm(join(root, 'paper'), { recursive: true, force: true })
    await write('paper/01-a.md', '# A\n\nAlpha words.\n')
    await write('paper/02-b.md', '# B\n\nBeta words.\n')
    await write(`paper/${EVIDENCE}`, EVIDENCE_TEXT)
    // A line naming the evidence file by its title: it must stay unwritten, never resolve to the swapped part.
    await write('paper/_paper_INDEX.md', '# Paper\n\n## Running order\n\n- [[A]]\n- [[B]]\n- [[Evidence and notes]]\n')
    invalidateFolioPlaces(root)
    invalidateFolioOrderFacts(root)
  }
  // A Workspace that replaces the first part by the link right after its `swapAt`-th whole-Collection listing.
  class Swapping extends Workspace {
    lists = 0
    constructor(dir: string, readonly swapAt: number) { super(dir) }
    override async listFiles() {
      const files = await super.listFiles()
      if (++this.lists === this.swapAt) swapForLink('paper/01-a.md', EVIDENCE)
      return files
    }
  }
  const titles = async (w: Workspace): Promise<string[]> => {
    const plan = await readPlan(w, 'paper')
    const named = [...(plan?.parts ?? []), ...(plan?.unlisted ?? [])]
    return [
      ...(await listCollection(w, 'paper')).rows.map((row) => row.title ?? ''),
      ...named.filter((part) => part.path).map((part) => part.title ?? ''),
    ]
  }
  await setUp()
  const counting = new Swapping(root, 0)
  await titles(counting)
  expect(counting.lists).toBeGreaterThan(1)
  for (let swapAt = 1; swapAt <= counting.lists; swapAt += 1) {
    await setUp()
    expect(await titles(new Swapping(root, swapAt))).not.toContain('Evidence and notes')
  }
})
