/** Ticket 05 of Folio versions: the Versions tab's pure helpers (dates, words, the left-out notice, list keys, the disabled actions). */
import { expect, test } from 'bun:test'
import { ROOM_VIEWS, ROOM_VIEW_LABELS, WORKSPACE_TAB_CHORDS, readRoomState } from '../../src/shared/folio-room'
import { VERSION_ACTIONS, bodyForReading, leftOutReasons, partLead, readingChip, listKeyTarget, plural, shownVersionId, versionMeta, versionWhen, wordsText, type FolioVersionRow } from '../../src/shared/folio-versions-view'

const row = (id: string, over: Partial<FolioVersionRow> = {}): FolioVersionRow => ({ id, name: `Version ${id}`, ts: Date.UTC(2026, 9, 19, 16, 40), author: 'Dominik Lukes', ...over })

test('Versions is the eighth tab, after Files, on ⌥8, and a stored Versions view is kept', () => {
  expect(ROOM_VIEWS.slice(-2)).toEqual(['files', 'versions'])
  expect(ROOM_VIEWS).toHaveLength(8)
  expect(ROOM_VIEW_LABELS.versions).toBe('Versions')
  expect(WORKSPACE_TAB_CHORDS.versions).toBe('⌥8')
  expect(readRoomState({ view: 'versions' }).view).toBe('versions')
})

test('dates read as 19 Oct, 16:40; the year shows only when it is not this year', () => {
  const now = Date.UTC(2026, 10, 3, 9, 0)
  expect(versionWhen(Date.UTC(2026, 9, 19, 16, 40), now, 'UTC')).toBe('19 Oct, 16:40')
  expect(versionWhen(Date.UTC(2025, 11, 31, 8, 5), now, 'UTC')).toBe('31 Dec 2025, 08:05')
  expect(versionMeta({ ts: Date.UTC(2026, 9, 19, 16, 40), author: 'Dominik Lukes', note: '  Outliers removed  ' }, now, 'UTC')).toBe('19 Oct, 16:40 · Dominik Lukes · Outliers removed')
  expect(versionMeta({ ts: Date.UTC(2026, 9, 19, 16, 40), author: 'Dominik Lukes' }, now, 'UTC')).toBe('19 Oct, 16:40 · Dominik Lukes')
})

test('words and counts are plain', () => {
  expect(wordsText(1)).toBe('1 word')
  expect(wordsText(1228)).toBe('1,228 words')
  expect(plural(1, 'Markdown file')).toBe('1 Markdown file')
  expect(plural(3, 'Markdown file')).toBe('3 Markdown files')
})

test('the left-out notice names only versions in this list, each with the backup\'s own sentence; unavailable names none', () => {
  const versions = [row('b'), row('a')]
  const ok = { versions, backup: { state: 'ok' as const, leftOut: [{ id: 'a', name: 'Version a', file: 'x.md', reason: "'Version a' is not in the backup because x.md is in the .trash folder. Move the part back into your writing to back it up." }, { id: 'elsewhere', name: 'Other', file: 'y.md', reason: 'other' }] } }
  expect(leftOutReasons(ok)).toEqual([{ id: 'a', name: 'Version a', reason: "'Version a' is not in the backup because x.md is in the .trash folder. Move the part back into your writing to back it up." }])
  expect(leftOutReasons({ versions, backup: { state: 'ok', leftOut: [] } })).toEqual([])
  expect(leftOutReasons({ versions, backup: { state: 'unavailable', reason: 'a damaged file' } })).toEqual([])
})

test('list keys: arrows by one and stop at the ends, Home and End jump, other keys and an empty list answer null', () => {
  const ids = ['a', 'b', 'c']
  expect(listKeyTarget(ids, 'a', 'ArrowDown')).toBe('b')
  expect(listKeyTarget(ids, 'c', 'ArrowDown')).toBe('c')
  expect(listKeyTarget(ids, 'b', 'ArrowUp')).toBe('a')
  expect(listKeyTarget(ids, 'a', 'ArrowUp')).toBe('a')
  expect(listKeyTarget(ids, null, 'ArrowDown')).toBe('a')
  expect(listKeyTarget(ids, 'b', 'Home')).toBe('a')
  expect(listKeyTarget(ids, 'b', 'End')).toBe('c')
  expect(listKeyTarget(ids, 'b', 'x')).toBeNull()
  expect(listKeyTarget([], null, 'ArrowDown')).toBeNull()
})

test('the version shown is the one chosen while it is in the list, else the newest', () => {
  expect(shownVersionId(['a', 'b'], null)).toBe('a')
  expect(shownVersionId(['a', 'b'], 'b')).toBe('b')
  expect(shownVersionId(['a', 'b'], 'gone')).toBe('a')
  expect(shownVersionId([], 'b')).toBeNull()
})

test('every action on a selected version opens a later ticket, so each has a plain reason and a label', () => {
  expect(VERSION_ACTIONS.map((action) => action.id)).toEqual(['open-read-only', 'compare', 'restore', 'export', 'mark-sent'])
  for (const action of VERSION_ACTIONS) {
    expect(action.label.length).toBeGreaterThan(3)
    expect(action.reason).toMatch(/not built yet\.$/)
  }
})

test('the read-only view\'s helpers: the chip names the version; a card\'s lead is the first prose line after front matter and headings; the body drops front matter', () => {
  expect(readingChip('Draft for Sam Rowe')).toBe('Reading “Draft for Sam Rowe” · read-only')
  const text = '\uFEFF---\ntitle: Pilot\nsynopsis: not this\n---\n\n# Pilot overview\n\n```\ncode\n```\n\nThe first sentence of the part. And more.\n\nSecond paragraph.\n'
  expect(partLead(text)).toBe('The first sentence of the part. And more.')
  expect(bodyForReading(text)).toStartWith('\n# Pilot overview')
  expect(bodyForReading(text)).not.toContain('synopsis')
  expect(partLead('# Only a heading\n')).toBe('')
  expect(partLead(null)).toBe('')
  expect(partLead('x'.repeat(300), 20)).toBe(`${'x'.repeat(19)}…`)
  expect(bodyForReading('No front matter here.\n---\nnot front matter\n')).toBe('No front matter here.\n---\nnot front matter\n')
})
