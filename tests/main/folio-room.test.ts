/**
 * The Folio room's read (ticket 09, spec § 12 and § 13): RW-1 for parts and unwritten parts, every compatibility
 * row, the title clash marking, labels and priority read from plan-line tags, and T-READONLY: opening the room on
 * every fixture writes nothing. Fixtures are synthetic (tests/fixtures/folio-room), never the real Pangram Folio.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { folioBinder, readFolioRoom, roomStateKey } from '../../src/main/folio-room'
import { registerFolioRoomIpc } from '../../src/main/folio-room-ipc'
import { SettingsStore } from '../../src/main/settings'
import { Workspace } from '../../src/main/workspace'
import {
  DEFAULT_ROOM_STATE, labelSlug, mergeRoomState, metaLine, readLabelVocabulary, readRoomState, resolveSelection, shownSelection, titleClashes,
} from '../../src/shared/folio-room'
import {
  READ_ONLY_FIXTURES, clashFolio, formsFolio, indexOnlyFolio, labelsFolio, largeFolio, manifestOnlyFolio, mixedFolio, noRunningOrderFolio, pangramFolio,
} from '../fixtures/folio-room/folio-room-fixtures'

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-room-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
  invalidateFolioOrderFacts(root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** Every file under `base` with its bytes, size and modified time: a snapshot to compare before and after a read. */
async function snapshot(base: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { out.push(`dir ${full.slice(base.length)}`); await walk(full) }
      else out.push(`${full.slice(base.length)} ${(await stat(full)).mtimeMs} ${(await readFile(full)).toString('base64')}`)
    }
  }
  await walk(base)
  return out.sort()
}

test('F-PANGRAM opens as two cards: the gloss is Summary’s synopsis, status Unsorted, no labels, words from the files, front matter as front matter', async () => {
  const built = await pangramFolio(root)
  const room = (await readFolioRoom(ws, built.dir))!
  expect(room.parts.map((part) => part.title)).toEqual(['Summary', 'Details'])
  const [summary, details] = room.parts
  expect(summary.synopsis).toBe('Summary of the findings and proposed evaluation.')
  expect(summary.role).toBe('summary')
  expect(details.synopsis).toBeNull()
  expect(room.parts.map((part) => part.status)).toEqual(['Unsorted', 'Unsorted'])
  expect(room.parts.every((part) => part.label === null && part.priority === null && part.written)).toBe(true)
  expect(room.parts.map((part) => part.words)).toEqual(built.writtenPaths.map((path) => built.words[path]))
  expect(room.frontMatterFiles.map((file) => file.path)).toEqual([`${built.dir}/contents/00-frontmatter.md`])
  expect(room.binder.research.map((item) => item.path)).toEqual([
    `${built.dir}/research/audience-contract.md`, `${built.dir}/research/scores.json`, `${built.dir}/source/report.html`, `${built.dir}/source/scores.json`,
  ])
  expect(room.binder.notes.map((item) => item.path)).toEqual([`${built.dir}/feedback/reviews/review-scope.md`])
  expect(room.binder.ideas).toEqual([])
  expect(room.labels).toEqual([])
  expect(room.startAPlan).toBe(false)
})

test('RW-1: on F-PANGRAM and F-MIXED the room’s lists equal an independent count from the files', async () => {
  for (const build of [pangramFolio, mixedFolio]) {
    const built = await build(root)
    const room = (await readFolioRoom(ws, built.dir))!
    expect(room.parts.map((part) => part.title)).toEqual(built.titles)
    expect(room.parts.filter((part) => !part.written).map((part) => part.title)).toEqual(built.unwritten)
    expect(room.parts.filter((part) => part.written).map((part) => part.key.path)).toEqual(built.writtenPaths)
    for (const part of room.parts) expect(part.words).toBe(part.key.path ? built.words[part.key.path] : 0)
    expect(room.meta).toEqual({
      parts: built.titles.length, unwritten: built.unwritten.length,
      words: Object.values(built.words).reduce((sum, count) => sum + count, 0),
    })
  }
})

test('F-MIXED: unwritten parts are dashed data (idea, no words), front matter is flagged, status and label and priority are read', async () => {
  const built = await mixedFolio(root)
  const room = (await readFolioRoom(ws, built.dir))!
  const by = Object.fromEntries(room.parts.map((part) => [part.title, part]))
  expect(by['Title page'].frontMatter).toBe(true)
  expect(by.Results).toMatchObject({ written: false, status: 'idea', words: 0, key: { title: 'Results', path: null } })
  expect(by.Intro).toMatchObject({ status: 'in progress', priority: 'high', label: { name: 'Frame', slug: 'frame', colour: 1 } })
  expect(by.Method).toMatchObject({ status: 'editing', label: { name: 'Findings', colour: 2 }, priority: null })
  // #label-unlisted is not in the vocabulary: an ordinary tag, never reinterpreted (D-LBL-1).
  expect(by.Costs).toMatchObject({ label: null, priority: 'low', tags: ['label-unlisted'], status: 'Unsorted' })
  expect(room.binder.ideas).toEqual([{ path: `${built.dir}/scraps/mixed-SCRAPS.md`, name: 'mixed-SCRAPS.md', kind: 'scrap-file', scraps: 2 }])
  expect(room.binder.notes.map((item) => item.name)).toEqual(['review-scope.md', 'meeting.md'])
  expect(metaLine(room.meta)).toMatch(/^5 parts · 1 unwritten · \d+ words$/)
})

test('compatibility: a Folio with a manifest and no Index Note opens from the manifest and writes no Index Note', async () => {
  const built = await manifestOnlyFolio(root)
  const room = (await readFolioRoom(ws, built.dir))!
  expect(room.parts.map((part) => part.title)).toEqual(['Alpha', 'Beta'])
  expect(room.startAPlan).toBe(false)
  expect((await readdir(join(root, built.dir))).filter((name) => name.endsWith('_INDEX.md'))).toEqual([])
})

test('compatibility: an Index Note with a running order and no manifest opens from the Index Note', async () => {
  const built = await indexOnlyFolio(root)
  const room = (await readFolioRoom(ws, built.dir))!
  expect(room.parts.map((part) => part.title)).toEqual(['One', 'Two', 'Three'])
  expect(room.parts.map((part) => part.written)).toEqual([true, true, false])
  expect((await readdir(join(root, built.dir))).includes('_report-structure.json')).toBe(false)
})

test('compatibility: an Index Note with no Running order is a collection; an empty Running order still declares a Folio', async () => {
  const built = await noRunningOrderFolio(root)
  expect(await readFolioRoom(ws, built.dir)).toBeNull()
  await rm(join(root, built.dir), { recursive: true })
  await mkdir(join(root, 'declared'), { recursive: true })
  await Bun.write(join(root, 'declared/_declared_INDEX.md'), '# Declared\n\n## Running order\n\n')
  const declared = (await readFolioRoom(ws, 'declared'))!
  expect(declared.parts).toEqual([])
  expect(declared.startAPlan).toBe(false)
})

test('no Folio here reads as null, not an empty room', async () => {
  await mkdir(join(root, 'plain'), { recursive: true })
  await Bun.write(join(root, 'plain/note.md'), '# Note\n')
  expect(await readFolioRoom(ws, 'plain')).toBeNull()
})

test('F-FORMS parses as today: repeated 1., non-consecutive numbers, aliases, CRLF, BOM, a code block holding a link', async () => {
  const built = await formsFolio(root)
  const room = (await readFolioRoom(ws, built.dir))!
  expect(room.parts.map((part) => part.title)).toEqual(built.titles)
  expect(room.parts.find((part) => part.title === 'Alpha')!.synopsis).toBe('First - with a dash.')
  expect(room.parts.find((part) => part.title === 'Zeta')).toMatchObject({ written: false, synopsis: 'Starred.' })
})

test('F-CLASH shows both clashing cards marked, with the sentence from the spec; the others are not marked', async () => {
  const built = await clashFolio(root)
  const room = (await readFolioRoom(ws, built.dir))!
  expect(room.parts.map((part) => part.titleClash)).toEqual([
    'Two parts are called ‘Results’. Rename one to use the room\'s evidence, map and ordering for them.',
    'Two parts are called ‘Results’. Rename one to use the room\'s evidence, map and ordering for them.',
    'Two parts are called ‘Same’. Rename one to use the room\'s evidence, map and ordering for them.',
    'Two parts are called ‘Same’. Rename one to use the room\'s evidence, map and ordering for them.',
  ])
  expect(room.parts.map((part) => part.synopsis).slice(0, 2)).toEqual(['First gloss.', 'Second gloss.'])
  expect(titleClashes(['a', 'A', 'b']).size).toBe(2)
})

test('F-LABELS: the duplicate slug is reported, not rewritten; a stray #label-x stays a tag; two priority tags read as the first', async () => {
  const built = await labelsFolio(root)
  const before = await readFile(join(root, built.indexPath!), 'utf8')
  const room = (await readFolioRoom(ws, built.dir))!
  expect(room.labels.map((label) => label.name)).toEqual(['Check fact', 'Frame'])
  expect(room.duplicateLabels).toEqual(['Check-fact'])
  expect(room.parts[0].label?.slug).toBe('check-fact')
  expect(room.parts[1]).toMatchObject({ label: null, tags: ['label-x'] })
  expect(room.parts[2]).toMatchObject({ priority: 'high', label: { name: 'Frame' } })
  expect(await readFile(join(root, built.indexPath!), 'utf8')).toBe(before)
})

test('label vocabulary: block and inline lists, quotes, BOM, CRLF; palette slot by position wraps at eight; slugs fold case and punctuation', () => {
  expect(readLabelVocabulary('---\r\nlabels: ["A b", \'C\']\r\n---\r\n').labels.map((label) => label.slug)).toEqual(['a-b', 'c'])
  expect(readLabelVocabulary('﻿---\nlabels:\n  - One\n  - "Two"\n\n  - Three\ntitle: x\n---\n').labels.map((label) => label.name)).toEqual(['One', 'Two', 'Three'])
  const nine = Array.from({ length: 9 }, (_, at) => `  - L${at}`).join('\n')
  expect(readLabelVocabulary(`---\nlabels:\n${nine}\n---\n`).labels.map((label) => label.colour)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 1])
  expect(readLabelVocabulary('# no frontmatter\nlabels:\n - x\n').labels).toEqual([])
  expect(readLabelVocabulary(null).labels).toEqual([])
  expect(labelSlug('  Check—Fact! ')).toBe('check-fact')
  expect(labelSlug('!!!')).toBeNull()
})

test('selection identity is the Plan key, re-resolved after a change; a key that no longer names a part falls back to the first part', () => {
  const parts = [{ key: { title: 'A', path: 'a.md' } }, { key: { title: 'B', path: null } }, { key: { title: 'C', path: 'c.md' } }]
  expect(resolveSelection(parts, { title: 'B', path: null })).toBe(1)
  // After B moves to the front, the same key is at a new index.
  expect(resolveSelection([parts[1], parts[0], parts[2]], { title: 'B', path: null })).toBe(0)
  expect(resolveSelection(parts, { title: 'B', path: 'b.md' })).toBeNull()
  expect(shownSelection(parts, { title: 'gone', path: null })).toBe(0)
  expect(shownSelection([], null)).toBeNull()
})

test('room state: an unknown stored view and malformed values, fall back to the default', () => {
  expect(readRoomState({ view: 'unknown', selected: { title: 'A', path: null } })).toEqual({ view: 'outline', selected: { title: 'A', path: null }, surface: 'room', split: false })
  expect(readRoomState({ surface: 'page' }).surface).toBe('page')
  expect(readRoomState({ surface: 'nope' }).surface).toBe('room')
  // A patch lays over the stored state; a malformed field keeps the stored value.
  expect(mergeRoomState({ view: 'cards', selected: { title: 'A', path: null }, surface: 'room' }, { surface: 'page', view: 'bogus' })).toEqual({ view: 'cards', selected: { title: 'A', path: null }, surface: 'page' })
  expect(mergeRoomState(DEFAULT_ROOM_STATE, 'x')).toEqual(DEFAULT_ROOM_STATE)
  expect(readRoomState({ view: 'outline', selected: { title: 3 } })).toEqual(DEFAULT_ROOM_STATE)
  expect(readRoomState('x')).toEqual(DEFAULT_ROOM_STATE)
  expect(readRoomState(null)).toEqual(DEFAULT_ROOM_STATE)
})

test('T-READONLY: opening each fixture in its own workspace leaves every byte and every file as it was', async () => {
  for (const [name, build] of READ_ONLY_FIXTURES) {
    const own = await mkdtemp(join(tmpdir(), 'wf-room-ro-'))
    try {
      const w = new Workspace(own)
      invalidateFolioPlaces(own)
      invalidateFolioOrderFacts(own)
      const built = await build(own)
      const before = await snapshot(own)
      const room = await readFolioRoom(w, built.dir)
      if (name === 'no running order') expect(room).toBeNull()
      else expect(room, name).not.toBeNull()
      await readFolioRoom(w, built.dir)
      expect(await snapshot(own), name).toEqual(before)
    } finally {
      await rm(own, { recursive: true, force: true })
    }
  }
})

test('F-LARGE (200 parts of about 10 KB) reads in one pass and counts every part', async () => {
  const built = await largeFolio(root)
  const started = Date.now()
  const room = (await readFolioRoom(ws, built.dir))!
  expect(room.parts).toHaveLength(200)
  expect(room.meta.words).toBe(Object.values(built.words).reduce((sum, count) => sum + count, 0))
  expect(Date.now() - started).toBeLessThan(5000)
})

test('room state is kept in app state per Folio key and never in the Folio folder (I-8)', async () => {
  const built = await pangramFolio(root)
  const settingsPath = join(await mkdtemp(join(tmpdir(), 'wf-room-settings-')), 'settings.json')
  const store = new SettingsStore(settingsPath)
  const handlers = new Map<string, (event: { sender: { id: number } }, input: any) => unknown>()
  registerFolioRoomIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, { stateForSender: () => ({}), requireWorkspace: () => ws, store })
  const call = (channel: string, input: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input)
  expect(await call('folio-room:get-state', { dir: built.dir })).toEqual(DEFAULT_ROOM_STATE)
  const before = await snapshot(join(root, built.dir))
  expect(await call('folio-room:set-state', { dir: built.dir, state: { selected: { title: 'Details', path: `${built.dir}/contents/02-report.md` } } })).toBe(true)
  // Another spelling of the same folder reads the same state.
  expect(await call('folio-room:get-state', { dir: `${built.dir}/./` })).toEqual({ view: 'outline', selected: { title: 'Details', path: `${built.dir}/contents/02-report.md` }, surface: 'room', split: false })
  expect(store.folioRoomState(roomStateKey(ws, built.dir))).toBeDefined()
  expect(await snapshot(join(root, built.dir))).toEqual(before)
  const room = (await call('folio-room:read', { dir: built.dir })) as { parts: unknown[] }
  expect(room.parts).toHaveLength(2)
  expect(await call('folio-room:read', { dir: '../outside' })).toBeNull()
  expect(await call('folio-room:set-state', { dir: 'a\\b', state: DEFAULT_ROOM_STATE })).toBe(false)
  // A second store reading the same file sees the saved state.
  expect(new SettingsStore(settingsPath).folioRoomState(roomStateKey(ws, built.dir))).toEqual({ view: 'outline', selected: { title: 'Details', path: `${built.dir}/contents/02-report.md` }, surface: 'room', split: false })
})

test('a Folio whose folder is the workspace itself lists its Research and Notes in the binder', async () => {
  await Bun.write(join(root, 'research/one.md'), '# One\n')
  await Bun.write(join(root, 'notes/two.md'), '# Two\n')
  await Bun.write(join(root, 'ideas/scraps.md'), '# Scraps\n')
  const binder = await folioBinder(ws, '')
  expect(binder.research.map((item) => item.path)).toEqual(['research/one.md'])
  expect(binder.notes.map((item) => item.path)).toEqual(['notes/two.md'])
})

test('a patch with a malformed field keeps that field’s stored value; a well-formed field still applies', () => {
  const stored = { view: 'cards' as const, selected: { title: 'Details', path: 'a/b.md' }, surface: 'page' as const }
  expect(mergeRoomState(stored, { selected: 42 })).toEqual(stored)
  expect(mergeRoomState(stored, { selected: { title: 3 } })).toEqual(stored)
  expect(mergeRoomState(stored, { view: 'nonsense', surface: 'elsewhere' })).toEqual(stored)
  expect(mergeRoomState(stored, { selected: null, surface: 'room' })).toEqual({ ...stored, selected: null, surface: 'room' })
})

test('label vocabulary: a YAML comment after a name is not part of the name (D-LBL-1/2), in block and inline lists', async () => {
  const block = readLabelVocabulary('---\nlabels: # the vocabulary\n  - Frame # explanatory comment\n  - "Check # fact" # kept inside quotes\n  - Plain\n---\n')
  expect(block.labels.map((label) => [label.name, label.slug])).toEqual([['Frame', 'frame'], ['Check # fact', 'check-fact'], ['Plain', 'plain']])
  expect(readLabelVocabulary('---\nlabels: [Frame, Plain] # why\n---\n').labels.map((label) => label.slug)).toEqual(['frame', 'plain'])
  await Bun.write(join(root, 'cmt/_cmt_INDEX.md'), '---\nlabels:\n  - Frame # explanatory comment\n---\n\n# Cmt\n\n## Running order\n\n- [[One]] #label-frame\n')
  const room = (await readFolioRoom(ws, 'cmt'))!
  expect(room.parts[0].label?.name).toBe('Frame')
  expect(room.parts[0].tags).toEqual([])
})

test('label vocabulary: YAML quote escapes do not end the quote early (backslash in "...", doubled quote in \'...\')', () => {
  const double = readLabelVocabulary('---\nlabels:\n  - "Check \\" # fact" # note\n---\n')
  expect(double.labels.map((label) => [label.name, label.slug])).toEqual([['Check " # fact', 'check-fact']])
  const single = readLabelVocabulary("---\nlabels:\n  - 'It''s # fine' # note\n---\n")
  expect(single.labels.map((label) => [label.name, label.slug])).toEqual([["It's # fine", 'it-s-fine']])
  expect(readLabelVocabulary('---\nlabels: ["A \\" # b", \'C\'\'\'] # why\n---\n').labels.map((label) => label.slug)).toEqual(['a-b', 'c'])
})

test('no production source reads a test switch for which face a Folio opens on', async () => {
  const hits: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name) && (await readFile(full, 'utf8')).includes('WRITEFLEX_E2E_FOLIO_PAGE')) hits.push(full)
    }
  }
  await walk(join(import.meta.dir, '../../src'))
  expect(hits).toEqual([])
})

test('Outline headings use the room’s existing content reads and match folioOutline line facts', async () => {
  const built = await pangramFolio(root)
  const path = built.writtenPaths[0]
  const source = (await ws.readFile(path)).content + '\n## Methods\n\n### Participants\n\n## Results\n'
  await Bun.write(join(root, path), source)
  const { folioOutline } = await import('../../src/main/folio-outline')
  const expected = (await folioOutline(ws, path))!.pieces.find(piece => piece.path === path)!
  const room = (await readFolioRoom(ws, built.dir))!
  expect(room.parts[0].outline?.headings).toEqual(expected.headings)
  expect(room.parts[0].outline?.heading).toBe(expected.heading)
})


test('Outline expansion persists through the settings IPC per Folio, without changing the Folio', async () => {
  const built = await pangramFolio(root)
  const before = await snapshot(join(root, built.dir))
  const settingsPath = join(root, 'app-settings.json')
  const store = new SettingsStore(settingsPath)
  const handlers = new Map<string, (event: { sender: { id: number } }, input: any) => unknown>()
  registerFolioRoomIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, { stateForSender: () => ({}), requireWorkspace: () => ws, store })
  const call = (channel: string, input: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input)
  expect(await call('folio-room:set-state', { dir: built.dir, state: { outlineExpanded: built.writtenPaths } })).toBe(true)
  expect((await call('folio-room:get-state', { dir: built.dir }) as any).outlineExpanded).toEqual(built.writtenPaths)
  expect(readRoomState(new SettingsStore(settingsPath).folioRoomState(roomStateKey(ws, built.dir))).outlineExpanded).toEqual(built.writtenPaths)
  expect(readRoomState(store.folioRoomState(roomStateKey(ws, 'other'))).outlineExpanded).toBeUndefined()
  expect(await snapshot(join(root, built.dir))).toEqual(before)
})

test('the one-time file-link marker survives room patches and a settings-store restart', async () => {
  const settingsPath = join(root, 'app-state.json')
  const store = new SettingsStore(settingsPath)
  const key = roomStateKey(ws, 'paper')
  const marked = mergeRoomState(DEFAULT_ROOM_STATE, { identityLinksAttempted: true })
  expect(store.setFolioRoomState(key, marked)).toBe(true)
  const changed = mergeRoomState(readRoomState(store.folioRoomState(key)), { view: 'cards', identityLinksAttempted: false })
  expect(store.setFolioRoomState(key, changed)).toBe(true)
  expect(readRoomState(new SettingsStore(settingsPath).folioRoomState(key)).identityLinksAttempted).toBe(true)
})

test('N5: completed linking follows a renamed and moved Folio and its nested Folio in persistent app state', async () => {
  await mkdir(join(root, 'paper/sub'), { recursive: true })
  const settingsPath = join(root, 'app-state.json')
  let store = new SettingsStore(settingsPath)
  for (const dir of ['paper', 'paper/sub', 'paper2']) store.setFolioRoomState(roomStateKey(ws, dir), { ...DEFAULT_ROOM_STATE, identityLinksAttempted: true })
  await rename(join(root, 'paper'), join(root, 'renamed'))
  expect(store.followFolioIdentityMove(root, 'paper', 'renamed')).toBe(true)
  store = new SettingsStore(settingsPath)
  expect(readRoomState(store.folioRoomState(roomStateKey(ws, 'renamed'))).identityLinksAttempted).toBe(true)
  expect(readRoomState(store.folioRoomState(roomStateKey(ws, 'renamed/sub'))).identityLinksAttempted).toBe(true)
  expect(readRoomState(store.folioRoomState(roomStateKey(ws, 'paper'))).identityLinksAttempted).toBeUndefined()
  expect(readRoomState(store.folioRoomState(roomStateKey(ws, 'paper2'))).identityLinksAttempted).toBe(true)
  await mkdir(join(root, 'shelf'))
  await rename(join(root, 'renamed'), join(root, 'shelf/moved'))
  expect(store.followFolioIdentityMove(root, 'renamed', 'shelf/moved')).toBe(true)
  store = new SettingsStore(settingsPath)
  expect(readRoomState(store.folioRoomState(roomStateKey(ws, 'shelf/moved'))).identityLinksAttempted).toBe(true)
  expect(readRoomState(store.folioRoomState(roomStateKey(ws, 'shelf/moved/sub'))).identityLinksAttempted).toBe(true)
  expect(readRoomState(store.folioRoomState(roomStateKey(ws, 'renamed'))).identityLinksAttempted).toBeUndefined()
})
