// The Shares list (sharing ticket 10; spec section 4.6; frame `shares-list`), at its seams: the IPC
// (src/main/sharing-piece-ipc.ts `sharing:open-list`, `sharing:opened`) over the real publisher and the
// real sharing service in memory, and the list's pure model (src/shared/sharing-shares-list.ts).
//
// Acceptance: every link in the collection appears once with correct counts; turning a link off from
// the list closes its reader pages. The authority model of tickets 03, 05 and 09 holds on the list:
// main lists the Workspace's own records and binds exactly those; a link whose source is gone is listed
// and can be turned off, copied and opened, nothing more; no answer carries a token.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSharingPieceIpc } from '../../src/main/sharing-piece-ipc.ts'
import { filterEntries, listTotals, needsAttention, notesTotals, openedKey, openedLabel, openedTimes, sameNameFolders, sortEntries, type ShareListEntry, type SharesListView } from '../../src/shared/sharing-shares-list.ts'
import { linkLabel, type PieceSharingView, type ShareLinkView } from '../../src/shared/sharing-links.ts'
import { buildShipped, removeShipped, TOKEN } from '../helpers/sharing-world.ts'
import { publishWorld } from '../helpers/sharing-publish-world.ts'

beforeAll(buildShipped)
afterAll(removeShipped)

const FOLIO = JSON.stringify({ files: [{ path: 'a.md' }, { path: 'b.md' }] })

async function listWorld() {
  const w = await publishWorld({
    files: {
      'Reading list.md': '# Reading list\n\nA reading list is a promise.\n',
      'Marking.md': '# Marking\n\nMarking as you read.\n',
      'Gone.md': '# Gone\n\nThis file goes away.\n',
      'F/_report-structure.json': FOLIO,
      'F/a.md': '# A\n\nPart one.\n',
      'F/b.md': '# B\n\nPart two.\n',
    },
  })
  const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  let rootOfOne: string | null = w.root
  const opened: string[] = []
  registerSharingPieceIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, w.publisher, {
    isAppWindow: (id) => id === 1 || id === 2,
    rootFor: (id) => (id === 1 ? rootOfOne : id === 2 ? w.root : null),
    openExternal: (url) => { opened.push(url) },
  })
  const call = (channel: string, sender: number, input?: unknown) => handlers.get(channel)!({ sender: { id: sender } }, input) as Promise<any>
  const make = async (path: string, name: string | null, kind: 'piece' | 'folio' = 'piece', root = w.root): Promise<string> => {
    const made = await w.publisher.make(root, path, { name, comments: true }, kind)
    if (!made.ok || !made.shareId) throw new Error(`no link for ${path}`)
    return made.shareId
  }
  return { ...w, call, make, opened, setRoot: (root: string | null) => { rootOfOne = root } }
}

const ids = (view: SharesListView): string[] => view.entries.map((entry) => entry.link.shareId)
const ownerTokens = (w: { secrets: { store: { read(slot: string): string | null } } }): string[] => Object.values(JSON.parse(w.secrets.store.read('sharing-links')!).tokens as Record<string, string>)

test('every link in the collection appears once, with its piece, settings, when it was made and how many times it was opened', async () => {
  const w = await listWorld()
  const marta = await w.make('Reading list.md', 'For Marta')
  const workshop = await w.make('Reading list.md', 'Workshop group')
  const seminar = await w.make('Marking.md', null)
  const pack = await w.make('F', 'Reading pack', 'folio')
  // A link in another Workspace is not this collection's.
  const elsewhere = mkdtempSync(join(tmpdir(), 'writeflex-share-other-'))
  writeFileSync(join(elsewhere, 'Other.md'), '# Other\n\nOTHER_WORKSPACE\n')
  const other = await w.make('Other.md', 'Elsewhere', 'piece', elsewhere)
  await w.publisher.idle()

  // Readers open the links: Marta's three times, the Folio once, Workshop never.
  for (let time = 0; time < 3; time += 1) expect((await w.readerPage(marta)).status).toBe(200)
  expect((await w.readerPage(pack)).status).toBe(200)
  expect((await w.readerPage(other)).status).toBe(200)

  const view = await w.call('sharing:open-list', 1) as SharesListView
  expect(view.ready).toBe(true)
  expect(ids(view).sort()).toEqual([marta, workshop, seminar, pack].sort())
  expect(new Set(ids(view)).size).toBe(ids(view).length)
  const entry = (shareId: string) => view.entries.find((item) => item.link.shareId === shareId)!
  expect(entry(marta)).toMatchObject({ kind: 'piece', path: 'Reading list.md', piece: 'Reading list', sourceGone: false, openPath: 'Reading list.md', link: { name: 'For Marta', comments: true, on: true } })
  expect(entry(seminar).link.name).toBeNull()
  expect(entry(pack)).toMatchObject({ kind: 'folio', path: 'F', piece: 'F (Folio)', sourceGone: false, openPath: 'F/a.md' })
  expect(entry(marta).link.madeAt).toBeGreaterThan(0)

  const counts = await w.call('sharing:opened', 1) as Record<string, number | null>
  expect(counts).toEqual({ [marta]: 3, [workshop]: 0, [seminar]: 0, [pack]: 1 })
  // Per collection.
  expect(listTotals(view.entries, counts)).toEqual({ links: 4, on: 4, off: 0, attention: 0, opened: 4, openedPartial: false })
  // The status reads behind the counts are not openings.
  expect(await w.call('sharing:opened', 1)).toEqual(counts)

  // No answer carries an owner token, the Cloudflare token or another Workspace's path.
  const answers = JSON.stringify([view, counts])
  for (const token of [...ownerTokens(w), TOKEN]) expect(answers).not.toContain(token)
  expect(answers).not.toContain(elsewhere)
  rmSync(elsewhere, { recursive: true, force: true })
})

test('the per-piece page shows the same counts for its own links, and only those', async () => {
  const w = await listWorld()
  const marta = await w.make('Reading list.md', 'For Marta')
  const other = await w.make('Marking.md', 'Seminar')
  await w.publisher.idle()
  await w.readerPage(marta)
  await w.readerPage(marta)
  await w.readerPage(other)
  // Nothing open: no counts.
  expect(await w.call('sharing:opened', 1)).toEqual({})
  await w.call('sharing:open', 1, 'Reading list.md')
  expect(await w.call('sharing:opened', 1)).toEqual({ [marta]: 2 })
  await w.call('sharing:close', 1)
  expect(await w.call('sharing:opened', 1)).toEqual({})
})

test('turning a link off from the list closes its reader pages; turning it on again opens them', async () => {
  const w = await listWorld()
  const marta = await w.make('Reading list.md', 'For Marta')
  const seminar = await w.make('Marking.md', 'Seminar')
  await w.publisher.idle()
  expect((await w.readerPage(marta)).status).toBe(200)

  await w.call('sharing:open-list', 1)
  const off = await w.call('sharing:turn-off', 1, { shareId: marta })
  expect(off.ok).toBe(true)
  const page = await w.readerPage(marta)
  expect(page.status).toBe(404)
  expect(page.text).toContain('This link has been turned off')
  // The other link is untouched.
  expect((await w.readerPage(seminar)).status).toBe(200)
  const after = await w.call('sharing:open-list', 1) as SharesListView
  expect(after.entries.find((entry) => entry.link.shareId === marta)!.link.on).toBe(false)
  expect(listTotals(after.entries, {})).toMatchObject({ links: 2, on: 1, off: 1, opened: null })

  // On again from the list, at the same address.
  expect((await w.call('sharing:turn-on', 1, { shareId: marta })).ok).toBe(true)
  expect((await w.readerPage(marta)).status).toBe(200)
  // Settings from the list: readers can leave notes, or not.
  expect((await w.call('sharing:set-comments', 1, { shareId: seminar, comments: false })).ok).toBe(true)
  expect(w.publisher.records().find((record) => record.shareId === seminar)!.comments).toBe(false)
  // Copy link and Open: the link's address, decided by main.
  expect(await w.call('sharing:copy-address', 1, { shareId: marta })).toBe(`https://writeflex-sharing.example.workers.dev/s/${marta}`)
  expect(await w.call('sharing:open-link', 1, { shareId: marta })).toBe(true)
  expect(w.opened).toEqual([`https://writeflex-sharing.example.workers.dev/s/${marta}`])
})

test('the list binds exactly the links it listed: none from another Workspace, none made since, none the window names; no link is made from it', async () => {
  const w = await listWorld()
  const marta = await w.make('Reading list.md', 'For Marta')
  const elsewhere = mkdtempSync(join(tmpdir(), 'writeflex-share-other-'))
  writeFileSync(join(elsewhere, 'Other.md'), '# Other\n\nText.\n')
  const other = await w.make('Other.md', 'Elsewhere', 'piece', elsewhere)
  await w.publisher.idle()

  // Nothing bound yet: the list's links cannot be touched.
  expect((await w.call('sharing:turn-off', 1, { shareId: marta })).ok).toBe(false)
  const view = await w.call('sharing:open-list', 1, { root: elsewhere, path: 'Other.md' }) as SharesListView
  // Whatever the window sends, the list is its own Workspace's.
  expect(ids(view)).toEqual([marta])
  for (const channel of ['sharing:turn-off', 'sharing:turn-on', 'sharing:set-comments', 'sharing:rename', 'sharing:retry']) {
    expect((await w.call(channel, 1, { shareId: other, comments: false, name: 'x' })).ok).toBe(false)
  }
  expect(await w.call('sharing:copy-address', 1, { shareId: other })).toBeNull()
  expect(await w.call('sharing:open-link', 1, { shareId: other })).toBe(false)
  expect((await w.call('sharing:opened', 1))[other]).toBeUndefined()
  // No link is made from the list, whatever it names.
  for (const request of [{ path: 'Reading list.md', name: null, comments: true }, { folio: 'F', name: null, comments: true }, { path: '', name: null, comments: true }]) {
    expect((await w.call('sharing:make', 1, request)).ok).toBe(false)
  }
  expect(w.publisher.records()).toHaveLength(2)

  // A link made since (in another window) is not bound until the list is read again.
  const later = await w.make('Marking.md', 'Later')
  await w.publisher.idle()
  expect((await w.call('sharing:turn-off', 1, { shareId: later })).ok).toBe(false)
  expect(ids(await w.call('sharing:open-list', 1))).toContain(later)
  expect((await w.call('sharing:turn-off', 1, { shareId: later })).ok).toBe(true)

  // The Workspace changed: the binding is gone.
  w.setRoot(elsewhere)
  expect((await w.call('sharing:turn-off', 1, { shareId: marta })).ok).toBe(false)
  expect(await w.call('sharing:opened', 1)).toEqual({})
  expect(w.publisher.records().find((record) => record.shareId === marta)!.on).toBe(true)
  // Another window's list is its own binding: window 2 has the same Workspace and binds its own list.
  expect(ids(await w.call('sharing:open-list', 2))).toContain(marta)
  // Opening a piece's page replaces the list's binding.
  w.setRoot(w.root)
  await w.call('sharing:open-list', 1)
  await w.call('sharing:open', 1, 'Marking.md')
  expect((await w.call('sharing:turn-off', 1, { shareId: marta })).ok).toBe(false)
  rmSync(elsewhere, { recursive: true, force: true })
})

test('a link whose source is gone is listed and can be turned off, copied and opened, never turned on or changed', async () => {
  const w = await listWorld()
  const gone = await w.make('Gone.md', 'Gone soon')
  const formerFolio = await w.make('F', 'Pack', 'folio')
  await w.publisher.idle()
  rmSync(join(w.root, 'Gone.md'))
  rmSync(join(w.root, 'F/_report-structure.json'))

  const view = await w.call('sharing:open-list', 1) as SharesListView
  const entry = (shareId: string) => view.entries.find((item) => item.link.shareId === shareId)!
  expect(entry(gone)).toMatchObject({ sourceGone: true, openPath: null, piece: 'Gone' })
  expect(entry(formerFolio)).toMatchObject({ sourceGone: true, openPath: null, piece: 'F (Folio)' })
  for (const shareId of [gone, formerFolio]) {
    expect((await w.call('sharing:set-comments', 1, { shareId, comments: false })).ok).toBe(false)
    expect((await w.call('sharing:rename', 1, { shareId, name: 'New' })).ok).toBe(false)
    expect((await w.call('sharing:retry', 1, { shareId })).ok).toBe(false)
    expect(await w.call('sharing:copy-address', 1, { shareId })).toContain(`/s/${shareId}`)
    expect((await w.call('sharing:turn-off', 1, { shareId })).ok).toBe(true)
    expect((await w.readerPage(shareId)).status).toBe(404)
    expect((await w.call('sharing:turn-on', 1, { shareId })).ok).toBe(false)
  }
})

// Review round 1, P2-1: a source that goes after the list (or the page) was read is checked at the
// moment of the action, not from the read.
test('a source that goes after the list was read: never turned on, renamed, its notes changed or retried', async () => {
  const w = await listWorld()
  const gone = await w.make('Gone.md', 'Gone soon')
  const folio = await w.make('F', 'Pack', 'folio')
  await w.publisher.idle()
  const view = await w.call('sharing:open-list', 1) as SharesListView
  expect(view.entries.every((entry) => !entry.sourceGone)).toBe(true)
  for (const shareId of [gone, folio]) expect((await w.call('sharing:turn-off', 1, { shareId })).ok).toBe(true)
  // Deleted in Finder, the manifest removed: the list is not read again.
  rmSync(join(w.root, 'Gone.md'))
  rmSync(join(w.root, 'F/_report-structure.json'))
  const record = (shareId: string) => w.publisher.records().find((entry) => entry.shareId === shareId)!
  for (const shareId of [gone, folio]) {
    expect((await w.call('sharing:turn-on', 1, { shareId })).ok).toBe(false)
    expect((await w.call('sharing:rename', 1, { shareId, name: 'New' })).ok).toBe(false)
    expect((await w.call('sharing:set-comments', 1, { shareId, comments: false })).ok).toBe(false)
    expect((await w.call('sharing:retry', 1, { shareId })).ok).toBe(false)
    expect(record(shareId)).toMatchObject({ on: false, comments: true })
    expect((await w.readerPage(shareId)).status).toBe(404)
    // Still managed: copied from the list.
    expect(await w.call('sharing:copy-address', 1, { shareId })).toContain(`/s/${shareId}`)
  }
  expect(record(gone).name).toBe('Gone soon')
  expect(record(folio).name).toBe('Pack')
})

test('a source that goes after its own page was read: the same refusals on the piece\'s and the Folio\'s page', async () => {
  const w = await listWorld()
  const gone = await w.make('Gone.md', 'Gone soon')
  const folio = await w.make('F', 'Pack', 'folio')
  await w.publisher.idle()
  const record = (shareId: string) => w.publisher.records().find((entry) => entry.shareId === shareId)!

  await w.call('sharing:open', 1, 'Gone.md')
  expect((await w.call('sharing:turn-off', 1, { shareId: gone })).ok).toBe(true)
  rmSync(join(w.root, 'Gone.md'))
  for (const [channel, input] of [['sharing:turn-on', {}], ['sharing:rename', { name: 'New' }], ['sharing:set-comments', { comments: false }], ['sharing:retry', {}]] as const) {
    expect((await w.call(channel, 1, { shareId: gone, ...input })).ok).toBe(false)
  }
  expect(record(gone)).toMatchObject({ on: false, comments: true, name: 'Gone soon' })

  await w.call('sharing:open-folio', 1, { dir: 'F', part: 'F/a.md' })
  expect((await w.call('sharing:turn-off', 1, { shareId: folio })).ok).toBe(true)
  rmSync(join(w.root, 'F/_report-structure.json'))
  for (const [channel, input] of [['sharing:turn-on', {}], ['sharing:rename', { name: 'New' }], ['sharing:set-comments', { comments: false }], ['sharing:retry', {}]] as const) {
    expect((await w.call(channel, 1, { shareId: folio, ...input })).ok).toBe(false)
  }
  expect(record(folio)).toMatchObject({ on: false, comments: true, name: 'Pack' })
})

test('opened counts the service cannot give are unknown, never zero', async () => {
  const w = await listWorld()
  const marta = await w.make('Reading list.md', 'For Marta')
  const seminar = await w.make('Marking.md', 'Seminar')
  await w.publisher.idle()
  await w.readerPage(seminar)
  await w.call('sharing:open-list', 1)
  // This Mac lost one link's key: that count is unknown, the other is still asked.
  const tokens = JSON.parse(w.secrets.store.read('sharing-links')!) as { format: number; tokens: Record<string, string> }
  delete tokens.tokens[marta]
  w.secrets.store.write('sharing-links', JSON.stringify(tokens))
  expect(await w.call('sharing:opened', 1)).toEqual({ [marta]: null, [seminar]: 1 })
  // The service cannot be reached (the one request asked, Seminar's, is dropped): unknown, not zero.
  w.fault.count = 0
  w.fault.at = 0
  w.fault.mode = 'before'
  expect(await w.call('sharing:opened', 1)).toEqual({ [marta]: null, [seminar]: null })
  w.fault.at = null
  expect(await w.call('sharing:opened', 1)).toEqual({ [marta]: null, [seminar]: 1 })
})

// ── The model (pure) ────────────────────────────────────────────────────────────────────────────

const link = (shareId: string, patch: Partial<ShareLinkView> = {}): ShareLinkView => ({
  shareId, name: null, address: `https://x.workers.dev/s/${shareId}`, comments: true, notes: 'private', on: true, madeAt: 1_000,
  publishedAt: 2_000, publishedSavedAt: 2_000, problem: null, publishing: false, note: null, ...patch,
})
const entry = (shareId: string, piece: string, patch: Partial<ShareLinkView> = {}, more: Partial<ShareListEntry> = {}): ShareListEntry => ({
  link: link(shareId, patch), kind: 'piece', path: `${piece}.md`, piece, sourceGone: false, openPath: `${piece}.md`, ...more,
})
const label = (item: ShareListEntry): string => linkLabel(item.link)

test('model: counts per collection, the filters and the sort', () => {
  const entries = [
    entry('a', 'Reading list', { name: 'Workshop group', madeAt: 9, problem: { kind: 'offline', reason: 'x', at: 1 } }),
    entry('b', 'Reading list', { name: 'For Marta', madeAt: 12 }),
    entry('c', 'Marking', { name: 'Seminar', madeAt: 8, on: false }),
    entry('d', 'Teaching (Folio)', { name: 'Reading pack', madeAt: 5, missingParts: 1 }, { kind: 'folio' }),
    entry('e', 'Choosing', { madeAt: 13, comments: false }),
  ]
  const opened = { a: 41, b: 3, c: 18, d: 22, e: null }
  expect(listTotals(entries, opened)).toEqual({ links: 5, on: 4, off: 1, attention: 2, opened: 84, openedPartial: true })
  expect(listTotals([], {})).toEqual({ links: 0, on: 0, off: 0, attention: 0, opened: null, openedPartial: false })
  expect(entries.filter(needsAttention).map((item) => item.link.shareId)).toEqual(['a', 'd'])
  // An off link is never "needs attention", whatever its last publish said.
  expect(needsAttention(entry('x', 'X', { on: false, problem: { kind: 'offline', reason: 'x', at: 1 } }))).toBe(false)

  const shown = (filter: Parameters<typeof filterEntries>[1], search = '') => filterEntries(entries, filter, search, label).map((item) => item.link.shareId)
  expect(shown('all')).toEqual(['a', 'b', 'c', 'd', 'e'])
  expect(shown('on')).toEqual(['a', 'b', 'd', 'e'])
  expect(shown('off')).toEqual(['c'])
  expect(shown('attention')).toEqual(['a', 'd'])
  expect(shown('all', 'reading')).toEqual(['a', 'b', 'd'])
  expect(shown('all', 'marta')).toEqual(['b'])
  // A link without a name is found by its settings, as it is listed.
  expect(shown('all', 'no comments')).toEqual(['e'])

  const sorted = (column: Parameters<typeof sortEntries>[1]['column'], descending: boolean) => sortEntries(entries, { column, descending }, opened, label).map((item) => item.link.shareId)
  expect(sorted('made', true)).toEqual(['e', 'b', 'a', 'c', 'd'])
  expect(sorted('opened', true)).toEqual(['a', 'd', 'c', 'b', 'e'])
  expect(sorted('piece', false)).toEqual(['e', 'c', 'b', 'a', 'd'])
  expect(sorted('on', false)[0]).toBe('c')
  expect(openedLabel(3)).toBe('3')
  expect(openedLabel(0)).toBe('0')
  expect(openedLabel(null)).toBe('–')
  expect(openedLabel(undefined)).toBe('–')
  expect(openedTimes(1)).toBe("1 time")
  expect(openedTimes(41)).toBe("41 times")
  expect(openedTimes(null)).toBe("Not known")

  // Ticket 07: Notes waiting and Handled, per link and for the collection; unknown is never zero.
  const notes = { a: { waiting: 6, handled: 12 }, b: { waiting: 2, handled: 0 }, c: { waiting: 0, handled: 7 }, d: { waiting: 3, handled: 14 }, e: { waiting: null, handled: null } }
  expect(sortEntries(entries, { column: 'waiting', descending: true }, opened, label, notes).map((item) => item.link.shareId)).toEqual(['a', 'd', 'b', 'c', 'e'])
  expect(sortEntries(entries, { column: 'handled', descending: true }, opened, label, notes).map((item) => item.link.shareId)).toEqual(['d', 'a', 'c', 'b', 'e'])
  expect(notesTotals(entries, notes)).toEqual({ waiting: 11, handled: 33 })
  expect(notesTotals(entries, {})).toEqual({ waiting: null, handled: null })
})

// ── Ticket 11: review follow-ups for the Shares list (review 10) ───────────────────────────────

test('ticket 11, review 10 note: a piece page for a path no longer on disk is "Piece not found", offers no Turn on, refuses it; Turn off still works', async () => {
  const w = await listWorld()
  const off = await w.make('Gone.md', 'Off link')
  const on = await w.make('Gone.md', 'On link')
  await w.publisher.idle()
  const page = await w.call('sharing:open', 1, 'Gone.md') as PieceSharingView
  expect(page.sourceGone).toBeUndefined()
  expect((await w.call('sharing:turn-off', 1, { shareId: off })).ok).toBe(true)
  rmSync(join(w.root, 'Gone.md'))
  // The page bound again (opened, or read on a change): manage only, the piece not found.
  for (const view of [await w.call('sharing:open', 1, 'Gone.md'), await w.call('sharing:piece', 1, 'Gone.md')] as PieceSharingView[]) {
    expect(view).toMatchObject({ sourceGone: true, pieceNotFound: true })
  }
  expect((await w.call('sharing:turn-on', 1, { shareId: off })).ok).toBe(false)
  expect(w.publisher.records().find((record) => record.shareId === off)!.on).toBe(false)
  expect((await w.call('sharing:turn-off', 1, { shareId: on })).ok).toBe(true)
  // A piece still on disk is found as before.
  expect(await w.call('sharing:open', 1, 'Marking.md')).not.toHaveProperty('pieceNotFound')
})

test('ticket 11, review round 1 F2: a page opened while its piece was missing turns a link on once the file is back, checked when the writer acts', async () => {
  const w = await listWorld()
  const shareId = await w.make('Gone.md', 'Back again')
  await w.publisher.idle()
  await w.call('sharing:open', 1, 'Gone.md')
  expect((await w.call('sharing:turn-off', 1, { shareId })).ok).toBe(true)
  // The file moved out of the Collection (same volume: the same file, device, inode and birth time).
  const aside = join(mkdtempSync(join(tmpdir(), 'writeflex-share-aside-')), 'Gone.md')
  const before = statSync(join(w.root, 'Gone.md'), { bigint: true })
  renameSync(join(w.root, 'Gone.md'), aside)
  expect(await w.call('sharing:open', 1, 'Gone.md')).toMatchObject({ sourceGone: true, pieceNotFound: true })
  // Still missing: Turn on and a new link are refused, and nothing reaches the publisher.
  expect((await w.call('sharing:turn-on', 1, { shareId })).ok).toBe(false)
  expect((await w.call('sharing:make', 1, { path: 'Gone.md', name: 'New' })).ok).toBe(false)
  expect(w.publisher.records().find((record) => record.shareId === shareId)!.on).toBe(false)
  // The same file back at its path; the open page reads again (no reopen).
  renameSync(aside, join(w.root, 'Gone.md'))
  const after = statSync(join(w.root, 'Gone.md'), { bigint: true })
  expect([after.dev, after.ino, after.birthtimeNs]).toEqual([before.dev, before.ino, before.birthtimeNs])
  const refreshed = await w.call('sharing:piece', 1, 'Gone.md') as PieceSharingView
  expect(refreshed.pieceNotFound).toBeUndefined()
  expect(refreshed.sourceGone).toBeUndefined()
  expect((await w.call('sharing:turn-on', 1, { shareId })).ok).toBe(true)
  await w.publisher.idle()
  expect(w.publisher.records().find((record) => record.shareId === shareId)!.on).toBe(true)
  expect((await w.readerPage(shareId)).status).toBe(200)
  // Another file put at the path is the same piece (ticket 04 R-C: the same path is an edit), so it too may be turned on.
  expect((await w.call('sharing:turn-off', 1, { shareId })).ok).toBe(true)
  rmSync(join(w.root, 'Gone.md'))
  expect(await w.call('sharing:open', 1, 'Gone.md')).toMatchObject({ pieceNotFound: true })
  writeFileSync(join(w.root, 'Gone.md'), '# Gone\n\nAnother file at the same path.\n')
  expect(statSync(join(w.root, 'Gone.md'), { bigint: true }).ino === after.ino && statSync(join(w.root, 'Gone.md'), { bigint: true }).birthtimeNs === after.birthtimeNs).toBe(false)
  expect((await w.call('sharing:turn-on', 1, { shareId })).ok).toBe(true)
  // The binding was never widened: a link of another piece is still refused from this page.
  const other = await w.make('Marking.md', 'Elsewhere')
  expect((await w.call('sharing:turn-off', 1, { shareId: other })).ok).toBe(false)
})

/**
 * Review round 2 of ticket 11 (P1): a page opened while its piece was missing, the path then restored
 * as a link (symlink) to something that is not a writer's piece. The publisher's `make` and `turnOn`
 * are counted; neither may be reached, and no record or reader page appears.
 */
async function restoredAsLink(target: (root: string) => string) {
  const w = await listWorld()
  const shareId = await w.make('Gone.md', 'Was here')
  await w.publisher.idle()
  await w.call('sharing:open', 1, 'Gone.md')
  expect((await w.call('sharing:turn-off', 1, { shareId })).ok).toBe(true)
  rmSync(join(w.root, 'Gone.md'))
  expect(await w.call('sharing:open', 1, 'Gone.md')).toMatchObject({ sourceGone: true, pieceNotFound: true })
  const reached = { make: 0, turnOn: 0 }
  const publisher = w.publisher as unknown as { make: (...args: unknown[]) => unknown; turnOn: (...args: unknown[]) => unknown }
  const realMake = publisher.make.bind(publisher)
  const realTurnOn = publisher.turnOn.bind(publisher)
  publisher.make = (...args) => { reached.make += 1; return realMake(...args) }
  publisher.turnOn = (...args) => { reached.turnOn += 1; return realTurnOn(...args) }
  symlinkSync(target(w.root), join(w.root, 'Gone.md'))
  return { w, shareId, reached }
}

const HIDDEN_TEXT = 'PRIVATE_SUPPORT_TEXT'

async function expectNothingPublished(w: Awaited<ReturnType<typeof listWorld>>, shareId: string, reached: { make: number; turnOn: number }, action: 'make' | 'turn-on') {
  const before = w.publisher.records().map((record) => record.shareId)
  const result = action === 'make'
    ? await w.call('sharing:make', 1, { path: 'Gone.md', name: 'New' })
    : await w.call('sharing:turn-on', 1, { shareId })
  expect(result.ok).toBe(false)
  await w.publisher.idle()
  expect(reached).toEqual({ make: 0, turnOn: 0 })
  expect(w.publisher.records().map((record) => record.shareId)).toEqual(before)
  expect(w.publisher.records().find((record) => record.shareId === shareId)!.on).toBe(false)
  expect(JSON.stringify(result)).not.toContain(HIDDEN_TEXT)
}

test('ticket 11, review round 2 P1 (a): a missing piece restored as a link to a hidden support file: Create link refused, the publisher never reached', async () => {
  const { w, shareId, reached } = await restoredAsLink((root) => {
    mkdirSync(join(root, '.bridle'), { recursive: true })
    writeFileSync(join(root, '.bridle', 'private.md'), `# Private\n\n${HIDDEN_TEXT}\n`)
    return join(root, '.bridle', 'private.md')
  })
  await expectNothingPublished(w, shareId, reached, 'make')
})

test('ticket 11, review round 2 P1 (b): the same restore: Turn on refused, the publisher never reached', async () => {
  const { w, shareId, reached } = await restoredAsLink((root) => {
    mkdirSync(join(root, '.bridle'), { recursive: true })
    writeFileSync(join(root, '.bridle', 'private.md'), `# Private\n\n${HIDDEN_TEXT}\n`)
    return join(root, '.bridle', 'private.md')
  })
  await expectNothingPublished(w, shareId, reached, 'turn-on')
})

test('ticket 11, review round 2 P1 (c): a missing piece restored as a link to a file outside the Collection: Create link and Turn on refused; likewise a link into a support folder', async () => {
  const outside = (): string => {
    const file = join(mkdtempSync(join(tmpdir(), 'writeflex-share-outside-')), 'Elsewhere.md')
    writeFileSync(file, `# Elsewhere\n\n${HIDDEN_TEXT}\n`)
    return file
  }
  const made = await restoredAsLink(outside)
  await expectNothingPublished(made.w, made.shareId, made.reached, 'make')
  const turned = await restoredAsLink(outside)
  await expectNothingPublished(turned.w, turned.shareId, turned.reached, 'turn-on')
  // A support folder inside the Collection is refused the same way, for both actions.
  const notes = (root: string): string => {
    mkdirSync(join(root, 'agent-notes'), { recursive: true })
    writeFileSync(join(root, 'agent-notes', 'n.md'), `# Notes\n\n${HIDDEN_TEXT}\n`)
    return join(root, 'agent-notes', 'n.md')
  }
  const support = await restoredAsLink(notes)
  await expectNothingPublished(support.w, support.shareId, support.reached, 'make')
  const supportOn = await restoredAsLink(notes)
  await expectNothingPublished(supportOn.w, supportOn.shareId, supportOn.reached, 'turn-on')
})

test('ticket 11, review round 2 P1 (d): a real file restored at the path still allows Create link and Turn on from the page opened while it was missing', async () => {
  const w = await listWorld()
  const shareId = await w.make('Gone.md', 'Was here')
  await w.publisher.idle()
  await w.call('sharing:open', 1, 'Gone.md')
  expect((await w.call('sharing:turn-off', 1, { shareId })).ok).toBe(true)
  rmSync(join(w.root, 'Gone.md'))
  expect(await w.call('sharing:open', 1, 'Gone.md')).toMatchObject({ pieceNotFound: true })
  writeFileSync(join(w.root, 'Gone.md'), '# Gone\n\nBack as a real file.\n')
  const made = await w.call('sharing:make', 1, { path: 'Gone.md', name: 'New' })
  expect(made.ok).toBe(true)
  expect((await w.call('sharing:turn-on', 1, { shareId })).ok).toBe(true)
  await w.publisher.idle()
  expect(w.publisher.records().find((record) => record.shareId === shareId)!.on).toBe(true)
  expect((await w.readerPage(made.shareId)).status).toBe(200)
})

test('ticket 11, review 10 P3-3 model: two pieces of one name each carry their folder; unique names and links to one piece carry none', () => {
  const entries = [
    entry('a', 'Draft', {}, { path: 'Talks/Draft.md' }),
    entry('b', 'Draft', {}, { path: 'Draft.md' }),
    entry('c', 'Draft', {}, { path: 'Notes/2026/Draft.md' }),
    entry('d', 'Marking', {}, { path: 'Marking.md' }),
    entry('e', 'Marking', {}, { path: 'Marking.md' }),
    entry('f', 'Pack (Folio)', {}, { kind: 'folio', path: 'Talks/Pack' }),
  ]
  expect(sameNameFolders(entries)).toEqual({ a: 'Talks', b: '', c: 'Notes/2026' })
  expect(sameNameFolders([entries[0], entries[3]])).toEqual({})
})

test('ticket 11, review round 1 F4 model: a malformed record\'s absolute or `..` path shows no folder; a folder inside the Collection still does', () => {
  const entries = [
    entry('a', 'Draft', {}, { path: '/tmp/example-author/Draft.md' }),
    entry('b', 'Draft', {}, { path: '../Outside/Draft.md' }),
    entry('c', 'Draft', {}, { path: 'Talks/../../Draft.md' }),
    entry('d', 'Draft', {}, { path: 'C:\\Notes\\Draft.md' }),
    entry('e', 'Draft', {}, { path: '\\\\server\\Draft.md' }),
    entry('f', 'Draft', {}, { path: 'Talks/Draft.md' }),
    entry('g', 'Draft', {}, { path: 'Draft.md' }),
  ]
  expect(sameNameFolders(entries)).toEqual({ f: 'Talks', g: '' })
})

test('ticket 11, review 10 P3-2 model: the opened counts are asked again on a link on or off, made or gone, or a publish finished, never on a publish step', () => {
  const before = [link('a', { publishedAt: 2_000 }), link('b')]
  const key = openedKey(before)
  expect(openedKey([link('a', { publishedAt: 2_000, publishing: true }), link('b')])).toBe(key)
  expect(openedKey([link('a', { publishedAt: 2_000, problem: { kind: 'offline', reason: 'x', at: 1 } }), link('b')])).toBe(key)
  expect(openedKey([link('b'), link('a', { publishedAt: 2_000 })])).toBe(key)
  expect(openedKey([link('a', { publishedAt: 3_000 }), link('b')])).not.toBe(key)
  expect(openedKey([link('a', { publishedAt: 2_000, on: false }), link('b')])).not.toBe(key)
  expect(openedKey([link('a', { publishedAt: 2_000 })])).not.toBe(key)
})
