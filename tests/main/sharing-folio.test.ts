// Share a Folio (sharing ticket 09; spec sections 4.2, 6.1 rows "Folio part added, removed or
// reordered" and "Folio part missing on disk", test matrix row Folio): the publisher's Folio rendering,
// one case per matrix row (parts in order; reorder; part added; part removed; part missing on disk),
// against the real sharing service in memory (tests/helpers/sharing-publish-world.ts). No network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildShipped, removeShipped } from '../helpers/sharing-world.ts'
import { publishWorld } from '../helpers/sharing-publish-world.ts'
import { folioDirPath, folioRunningOrder, isFolio, partKeysFor, PART_KEY, renderFolioLink } from '../../src/main/sharing-folio.ts'
import { RemotePictureRefused } from '../../src/main/sharing-remote-pictures.ts'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { partMissingText } from '../../src/shared/sharing-links.ts'

beforeAll(buildShipped)
afterAll(removeShipped)

const DIR = 'Teaching notes'
const MANIFEST = `${DIR}/_report-structure.json`
const INDEX = `${DIR}/_Teaching notes_INDEX.md`
const part = (name: string): string => `${DIR}/${name}.md`
const manifest = (...names: string[]): string => JSON.stringify({ files: names.map((name) => ({ path: `${name}.md` })) }, null, 2)
const PARTS: Record<string, string> = {
  [part('What a reading list is for')]: '# What a reading list is for\n\nMost reading lists are written as if the reader will finish them.\n\n## Start with a question\n\nThe lists I have found useful were each built around a question.\n',
  [part('Setting the first week')]: '# Setting the first week\n\nThe first week sets what students expect.\n',
  [part('Marking without a rubric')]: '# Marking without a rubric\n\nA rubric tells students what will be counted.\n',
}
const ORDER = ['What a reading list is for', 'Setting the first week', 'Marking without a rubric']
const files = (): Record<string, string> => ({
  ...PARTS,
  [MANIFEST]: manifest(...ORDER),
  [INDEX]: '---\ntitle: Teaching notes, autumn term\nauthor: Dominik\n---\n\n# Teaching notes\n',
  'Elsewhere/Another piece.md': '# Another piece\n\nOTHER_PIECE_WORDS\n',
})

async function folioWorld() {
  const w = await publishWorld({ files: files() })
  const made = await w.publisher.make(w.root, DIR, { name: 'Reading pack', comments: true }, 'folio')
  expect(made.ok).toBe(true)
  const shareId = made.ok ? made.shareId! : ''
  const save = async (...paths: string[]): Promise<void> => { w.publisher.saved(w.root, paths); await w.publisher.idle() }
  const last = () => w.publishes().at(-1)!.body
  const titles = () => last().parts.map((entry) => entry.title)
  const record = () => w.publisher.records().find((entry) => entry.shareId === shareId)!
  return { ...w, shareId, made, save, last, titles, record }
}

/** The order of the given words on the reader page. */
const orderOn = (page: string, words: readonly string[]): number[] => words.map((word) => page.indexOf(word))
const ascending = (values: readonly number[]): boolean => values.every((value, at) => value >= 0 && (at === 0 || value > values[at - 1]))

describe('a Folio link: the matrix row Folio', () => {
  test('parts in order: one link opens the whole Folio, its parts in running order with a contents list', async () => {
    const w = await folioWorld()
    expect(w.publishes()).toHaveLength(1)
    const body = w.last()
    expect(body).toMatchObject({ kind: 'folio', title: 'Teaching notes, autumn term', comments: true })
    expect(body.chips).toEqual([{ label: 'Author', value: 'Dominik' }, { label: 'Parts', value: '3' }])
    expect(w.titles()).toEqual(ORDER)
    // Each part's own `#` heading is its title, printed once by the page: it is not in the part's text.
    expect(body.parts[0].html).not.toContain('>What a reading list is for<')
    expect(body.parts[0].headings.map((heading) => heading.text)).toEqual(['Start with a question'])

    const page = await w.readerPage(w.shareId)
    expect(page.status).toBe(200)
    expect(page.text).toContain('Contents')
    expect(ascending(orderOn(page.text, ['href="#part-1">1. What a reading list is for', 'href="#part-2">2. Setting the first week', 'href="#part-3">3. Marking without a rubric']))).toBe(true)
    expect(ascending(orderOn(page.text, ['Most reading lists are written', 'The first week sets', 'A rubric tells students', 'Made with WriteFlex']))).toBe(true)
    expect(page.text).not.toContain('OTHER_PIECE_WORDS')
    expect(w.made.view.mark).toEqual({ kind: 'shared' })
    expect(w.made.view.folio?.parts.map((entry) => [entry.title, entry.missing])).toEqual(ORDER.map((title) => [title, false]))
  })

  test('reorder: saving the running order republishes, and the page follows; each part keeps its ids', async () => {
    const w = await folioWorld()
    const keysBefore = { ...w.record().partKeys }
    w.write(MANIFEST, manifest(ORDER[2], ORDER[0], ORDER[1]))
    await w.save(MANIFEST)
    expect(w.publishes()).toHaveLength(2)
    expect(w.titles()).toEqual([ORDER[2], ORDER[0], ORDER[1]])
    expect(w.record().partKeys).toEqual(keysBefore)
    const page = await w.readerPage(w.shareId)
    expect(ascending(orderOn(page.text, ['A rubric tells students', 'Most reading lists are written', 'The first week sets']))).toBe(true)
  })

  test('part added: the reader page gains it in its place', async () => {
    const w = await folioWorld()
    w.write(part('Setting a reading pace'), '# Setting a reading pace\n\nPACE_WORDS: twenty pages a week.\n')
    w.write(MANIFEST, manifest(ORDER[0], 'Setting a reading pace', ORDER[1], ORDER[2]))
    await w.save(MANIFEST, part('Setting a reading pace'))
    expect(w.titles()).toEqual([ORDER[0], 'Setting a reading pace', ORDER[1], ORDER[2]])
    expect(w.last().chips).toContainEqual({ label: 'Parts', value: '4' })
    const page = await w.readerPage(w.shareId)
    expect(page.text).toContain('PACE_WORDS')
    expect(page.text).toContain('href="#part-2">2. Setting a reading pace')
  })

  test('part removed: the reader page loses it, and its text with it', async () => {
    const w = await folioWorld()
    w.write(MANIFEST, manifest(ORDER[0], ORDER[2]))
    await w.save(MANIFEST)
    expect(w.titles()).toEqual([ORDER[0], ORDER[2]])
    const page = await w.readerPage(w.shareId)
    expect(page.text).not.toContain('The first week sets')
    expect(page.text).not.toContain('Setting the first week')
  })

  test('part missing on disk: its title with "not available"; the rest published; the Sharing page and the mark flag it', async () => {
    const w = await folioWorld()
    rmSync(join(w.root, part(ORDER[1])))
    await w.save(part(ORDER[1]))
    expect(w.publishes()).toHaveLength(2)
    const body = w.last()
    expect(body.parts[1]).toMatchObject({ title: 'Setting the first week', missing: true, headings: [] })
    expect(body.parts[1].html).toBeUndefined()
    const page = await w.readerPage(w.shareId)
    expect(page.text).toContain('This part is not available.')
    expect(page.text).toContain('Setting the first week')
    expect(page.text).not.toContain('The first week sets')
    expect(page.text).toContain('A rubric tells students')

    const view = w.publisher.view(w.root, DIR, 'folio')
    expect(view.mark).toEqual({ kind: 'shared', missing: 1 })
    expect(view.links[0]).toMatchObject({ missingParts: 1, problem: null })
    const missing = view.folio!.parts.filter((entry) => entry.missing)
    expect(missing).toEqual([{ title: 'Setting the first week', missing: true, fileName: 'Setting the first week.md', path: part(ORDER[1]) }])
    expect(partMissingText(missing, 3)).toBe('Setting the first week.md is not on disk. Readers see its title with “not available”. The other two parts are published.')

    // Back on disk: published again, nothing flagged.
    w.write(part(ORDER[1]), PARTS[part(ORDER[1])])
    await w.save(part(ORDER[1]))
    expect(w.last().parts[1].missing).toBeUndefined()
    expect(w.publisher.view(w.root, DIR, 'folio').mark).toEqual({ kind: 'shared' })
  })

  test('a part missing on disk never blocks the first publish', async () => {
    const w = await publishWorld({ files: { ...files(), [MANIFEST]: manifest(ORDER[0], 'Assessment and reading lists', ORDER[2]) } })
    const made = await w.publisher.make(w.root, DIR, { name: null, comments: false }, 'folio')
    expect(made.ok).toBe(true)
    expect(made.view.links[0]).toMatchObject({ problem: null, missingParts: 1 })
    expect(w.publishes()[0].body.parts.map((entry) => [entry.title, entry.missing === true])).toEqual([[ORDER[0], false], ['Assessment and reading lists', true], [ORDER[2], false]])
  })
})

describe('what a Folio link follows', () => {
  test('a save of a part republishes; a save outside the Folio does not; a piece link on a part is its own', async () => {
    const w = await folioWorld()
    w.write(part(ORDER[0]), PARTS[part(ORDER[0])].replace('Most reading lists', 'NEW_WORDS Most reading lists'))
    await w.save(part(ORDER[0]))
    expect(w.publishes()).toHaveLength(2)
    expect((await w.readerPage(w.shareId)).text).toContain('NEW_WORDS')
    await w.save('Elsewhere/Another piece.md')
    expect(w.publishes()).toHaveLength(2)
    // The Folio's page lists only its own links; a piece's page only the piece's.
    expect(w.publisher.view(w.root, part(ORDER[0])).links).toEqual([])
    expect(w.publisher.view(w.root, DIR, 'folio').links).toHaveLength(1)
  })

  test('a Folio with no manifest whose Index Note declares a running order publishes in the fallback order', async () => {
    const w = await publishWorld({
      files: {
        'Course/_Course_INDEX.md': '# A course\n\n## Running order\n\n- [[02-second]]\n',
        'Course/01-first.md': '# First\n\nFIRST_WORDS\n',
        'Course/02-second.md': '# Second\n\nSECOND_WORDS\n',
      },
    })
    expect(await isFolio(w.root, 'Course')).toBe(true)
    const made = await w.publisher.make(w.root, 'Course', { name: null, comments: true }, 'folio')
    expect(made.ok).toBe(true)
    expect(w.publishes()[0].body).toMatchObject({ title: 'A course' })
    expect(w.publishes()[0].body.parts.map((entry) => entry.title)).toEqual(['First', 'Second'])
  })

  test('a folder that is no Folio: refused by the reader, and a link whose Folio went says so and keeps the last copy', async () => {
    const w = await folioWorld()
    expect(await isFolio(w.root, 'Elsewhere')).toBe(false)
    expect(await folioRunningOrder(w.root, 'Elsewhere')).toBeNull()
    rmSync(join(w.root, MANIFEST))
    await w.save(MANIFEST)
    const link = w.publisher.view(w.root, DIR, 'folio').links[0]
    expect(link.problem?.reason).toBe('This folder is no longer a Folio, so WriteFlex has nothing to publish on this link.')
    expect((await w.readerPage(w.shareId)).text).toContain('Most reading lists are written')
  })
})

describe('per-part anchoring (for notes routed to their part, ticket 07)', () => {
  test('every id in a part starts with that part\'s key; keys are distinct, kept per part file, and name no path', async () => {
    const w = await folioWorld()
    const keys = w.record().partKeys
    expect(Object.keys(keys).sort()).toEqual(ORDER.map(part).sort())
    const values = Object.values(keys)
    expect(new Set(values).size).toBe(3)
    for (const key of values) expect(key).toMatch(PART_KEY)
    for (const [at, entry] of w.last().parts.entries()) {
      const key = keys[part(w.titles()[at])]
      const ids = [...entry.html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1])
      expect(ids.length).toBeGreaterThan(0)
      for (const id of ids) expect(id.startsWith(`${key}-`)).toBe(true)
      for (const heading of entry.headings) expect(heading.id.startsWith(`${key}-`)).toBe(true)
    }
    // The block a reader's note is on carries its part's key in the page the reader gets.
    const page = await w.readerPage(w.shareId)
    expect(page.text).toContain(`id="${keys[part(ORDER[2])]}-document-block-1"`)
  })

  test('the keys are written only with a publish that went through (R8)', async () => {
    const w = await publishWorld({ files: files() })
    w.fault.count = 0
    // The page PUT of the first publish is lost: request 0 makes the link, 1 is the page.
    w.fault.at = 1
    const made = await w.publisher.make(w.root, DIR, { name: null, comments: true }, 'folio')
    expect(made.ok).toBe(true)
    const record = w.publisher.records()[0]
    expect(record.partKeys).toEqual({})
    expect(record.parts).toEqual([])
    expect(record.problem).not.toBeNull()
  })

  test('partKeysFor keeps a part\'s key and gives a new part a new one', () => {
    const kept = { 'F/a.md': 'kaaaaa' }
    const keys = partKeysFor([{ path: 'F/a.md', missing: false }, { path: 'F/b.md', missing: true }], kept)
    expect(keys['F/a.md']).toBe('kaaaaa')
    expect(keys['F/b.md']).toMatch(PART_KEY)
    expect(keys['F/b.md']).not.toBe('kaaaaa')
  })
})

test('a picture from another site in any part goes through the address guard: refused, it is its words and is counted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'writeflex-folio-pictures-'))
  mkdirSync(join(root, 'F'))
  writeFileSync(join(root, 'F/_report-structure.json'), JSON.stringify({ files: [{ path: 'a.md' }, { path: 'b.md' }] }))
  writeFileSync(join(root, 'F/a.md'), '# A\n\nText.\n')
  writeFileSync(join(root, 'F/b.md'), '# B\n\n![the router page](http://192.168.1.1/admin.png)\n')
  const asked: string[] = []
  const rendered = await renderFolioLink(root, 'F', '/s/x/images/', {}, { fetchRemote: async (url) => { asked.push(url); throw new RemotePictureRefused() } })
  expect(asked).toEqual(['http://192.168.1.1/admin.png'])
  expect(rendered!.folio.refusedPictures).toBe(1)
  expect(rendered!.folio.parts[1].html).toContain('the router page')
  expect(rendered!.folio.parts[1].html).not.toContain('192.168.1.1')
  expect(rendered!.folio.pictures).toEqual([])
})

test('the Folio\'s title: from its Index Note with hidden comments gone first (a byte-order mark before one included); else "Folio", never a folder\'s name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'writeflex-folio-title-'))
  mkdirSync(join(root, 'F'))
  writeFileSync(join(root, 'F/_report-structure.json'), JSON.stringify({ files: [{ path: 'a.md' }] }))
  writeFileSync(join(root, 'F/a.md'), '# A\n\nText.\n')
  writeFileSync(join(root, 'F/_F_INDEX.md'), '\uFEFF<!--\n# INDEX_SECRET\n-->\n\n# The public title\n\nINDEX_BODY\n')
  const rendered = await renderFolioLink(root, 'F', '/s/x/images/', {})
  expect(rendered!.folio.title).toBe('The public title')
  expect(JSON.stringify(rendered!.folio)).not.toContain('INDEX_SECRET')
  expect(JSON.stringify(rendered!.folio)).not.toContain('INDEX_BODY')
  rmSync(join(root, 'F/_F_INDEX.md'))
  expect((await renderFolioLink(root, 'F', '/s/x/images/', {}))!.folio.title).toBe('Folio')
})

// Review round 1, finding 1: no folder's name reaches the published copy, the Workspace's own included.
test('a Folio at the Workspace itself, with no Index Note or one with no title: "Folio", never the Workspace folder\'s name', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'writeflex-folio-root-title-'))
  const root = join(parent, 'COLLECTION_NAME_CANARY')
  mkdirSync(root)
  writeFileSync(join(root, '_report-structure.json'), JSON.stringify({ files: [{ path: 'a.md' }] }))
  writeFileSync(join(root, 'a.md'), '# A\n\nText.\n')
  const published = async () => (await renderFolioLink(root, '', '/s/x/images/', {}))!.folio
  expect((await published()).title).toBe('Folio')
  expect(JSON.stringify(await published())).not.toContain('COLLECTION_NAME_CANARY')
  // An Index Note without a title (nor a heading) changes nothing.
  writeFileSync(join(root, '_COLLECTION_NAME_CANARY_INDEX.md'), '---\nauthor: Dominik\n---\n\nJust words.\n')
  expect((await published()).title).toBe('Folio')
  expect(JSON.stringify(await published())).not.toContain('COLLECTION_NAME_CANARY')
  // Through the publisher: the payload does not hold the Workspace folder's name.
  const w = await publishWorld({ files: { '_report-structure.json': JSON.stringify({ files: [{ path: 'a.md' }] }), 'a.md': '# A\n\nText.\n' } })
  const made = await w.publisher.make(w.root, '', { name: null, comments: true }, 'folio')
  expect(made.ok).toBe(true)
  await w.publisher.idle()
  const body = w.publishes().at(-1)!.body
  expect(body.title).toBe('Folio')
  expect(JSON.stringify(body)).not.toContain(w.root.split('/').at(-1)!)
})

// Review round 1, finding 2: the Index Note is read only where a part could be read.
test('an Index Note that is a link to an Agent note, a dot-folder or out of the Folio is not read: the Folio publishes with "Folio" and no chips', async () => {
  const root = mkdtempSync(join(tmpdir(), 'writeflex-folio-index-link-'))
  mkdirSync(join(root, 'F/sources'), { recursive: true })
  mkdirSync(join(root, 'agent-notes'))
  mkdirSync(join(root, '.bridle'))
  mkdirSync(join(root, 'F/agent-notes'))
  writeFileSync(join(root, 'F/_report-structure.json'), JSON.stringify({ files: [{ path: 'a.md' }] }))
  writeFileSync(join(root, 'F/a.md'), '# A\n\nText.\n')
  writeFileSync(join(root, 'agent-notes/review.md'), '---\ntitle: AGENT_NOTE_TITLE_CANARY\nauthor: AGENT_AUTHOR_CANARY\n---\n')
  writeFileSync(join(root, '.bridle/private.md'), '---\ntitle: BRIDLE_TITLE_CANARY\nstatus: BRIDLE_STATUS_CANARY\n---\n')
  writeFileSync(join(root, 'F/agent-notes/inside.md'), '# INSIDE_AGENT_NOTE_CANARY\n')
  writeFileSync(join(root, 'Elsewhere.md'), '# OUTSIDE_FOLIO_CANARY\n')
  writeFileSync(join(root, 'F/sources/cover.md'), '---\ntitle: The cover in the Folio\nauthor: Dominik\n---\n')
  const index = join(root, 'F/_F_INDEX.md')
  const publish = async () => (await renderFolioLink(root, 'F', '/s/x/images/', {}))!.folio
  for (const target of ['../agent-notes/review.md', '../.bridle/private.md', 'agent-notes/inside.md', '../Elsewhere.md']) {
    rmSync(index, { force: true })
    symlinkSync(target, index)
    const folio = await publish()
    expect(folio.title).toBe('Folio')
    expect(folio.chips).toEqual([{ label: 'Parts', value: '1' }])
    expect(folio.parts.map((entry) => entry.title)).toEqual(['A'])
    expect(JSON.stringify(folio)).not.toMatch(/CANARY/)
  }
  // A link that stays inside the Folio, in a writer's folder, is read as the Index Note.
  rmSync(index)
  symlinkSync('sources/cover.md', index)
  const folio = await publish()
  expect(folio.title).toBe('The cover in the Folio')
  expect(folio.chips).toEqual([{ label: 'Author', value: 'Dominik' }, { label: 'Parts', value: '1' }])
})

test('folioDirPath: inside the Workspace, no dot-folder, no agent-notes', () => {
  expect(folioDirPath('Teaching notes/')).toBe('Teaching notes')
  expect(folioDirPath('')).toBe('')
  expect(folioDirPath('a/./b')).toBe('a/b')
  for (const bad of ['../x', '/abs', 'a/../../x', '.writeflex', 'x/agent-notes', 'x/.git/y', 3, null]) expect(folioDirPath(bad)).toBeNull()
})
