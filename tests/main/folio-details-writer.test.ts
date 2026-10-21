import { expect, test } from 'bun:test'
import { FOLIO_DETAILS_CHANGED_ELSEWHERE, FolioDetailsWriter, folioDetailUnchanged, type FolioDetailsApi } from '../../src/renderer/src/components/folio-details-writer'
import { typingInDetails } from '../../src/renderer/src/components/folio-details-keys'
import type { FolioDetailAnswer, FolioDetailField, FolioDetailsRead } from '../../src/shared/folio-details'

// The Details card's writes (Sol round 2, findings 2 and 6): a change made while another is being saved is queued and
// sent after it, over the text the first one left; none is dropped. Undo from the menu and from ⌘Z share one check.

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const read = (text: string): FolioDetailsRead => ({ ok: true, indexPath: 'book/_book_INDEX.md', text, titlePagePath: null, fields: {} as never })

/** A main side that holds each `set` until the test lets it answer, and records what it was sent. */
function slowMain(start: string) {
  let disk = start
  const sent: Array<{ field: FolioDetailField; value: string | null; basis: string }> = []
  const held: Array<Deferred<void>> = []
  const api: FolioDetailsApi = {
    read: async () => read(disk),
    set: async (_dir, field, value, basis) => {
      sent.push({ field, value, basis })
      const gate = deferred<void>()
      held.push(gate)
      await gate.promise
      if (basis !== disk) return { ok: false, refused: 'disk-changed', message: 'changed', text: disk } satisfies FolioDetailAnswer
      disk = `${disk}${field}=${value}\n`
      return { ok: true, changed: true, undoToken: `t${sent.length}`, indexPath: 'book/_book_INDEX.md', text: disk }
    },
    undo: async () => ({ ok: true, indexPath: 'book/_book_INDEX.md', text: start }),
  }
  return { api, sent, held, disk: () => disk, edit: (text: string) => { disk = text } }
}

const report = () => {
  const messages: Array<string | null> = []
  const pending: Array<ReadonlyMap<FolioDetailField, string | null>> = []
  return { messages, pending, report: { read: () => undefined, message: (m: string | null) => { messages.push(m) }, pending: (p: ReadonlyMap<FolioDetailField, string | null>) => { pending.push(p) } } }
}
const direct = <T,>(call: () => Promise<T>) => call().then((value) => ({ ok: true as const, value }))

test('a change made while another is being saved waits for it and is then written over the text it left', async () => {
  const main = slowMain('---\n---\n')
  const seen = report()
  const writer = new FolioDetailsWriter('book', main.api, direct, seen.report)
  await writer.reload()
  const title = writer.set('title', 'New title')
  // The standfirst is committed while the title's save is still pending: it is queued, not dropped.
  const standfirst = writer.set('standfirst', 'A line.')
  // A picker's choice too.
  const status = writer.set('status', 'ready')
  await flush()
  expect(main.sent).toHaveLength(1)
  expect(seen.pending.at(-1)).toEqual(new Map<FolioDetailField, string | null>([['title', 'New title'], ['standfirst', 'A line.'], ['status', 'ready']]))
  main.held[0].resolve()
  await flush(); await flush()
  expect(main.sent).toHaveLength(2)
  // Sent over the text the title's write left, so it is not refused as a changed file.
  expect(main.sent[1].basis).toBe('---\n---\ntitle=New title\n')
  main.held[1].resolve()
  await flush(); await flush()
  main.held[2].resolve()
  expect(await title).toBe(true)
  expect(await standfirst).toBe(true)
  expect(await status).toBe(true)
  expect(main.disk()).toBe('---\n---\ntitle=New title\nstandfirst=A line.\nstatus=ready\n')
  expect(seen.pending.at(-1)?.size).toBe(0)
  expect(seen.messages.filter((m) => m !== null)).toEqual([])
})

test('an Undo asked while a change is being saved undoes that change, after it lands', async () => {
  const main = slowMain('start\n')
  const undone: string[] = []
  main.api.undo = async (_dir, token) => { undone.push(token); return { ok: true, indexPath: 'x', text: 'start\n' } }
  const writer = new FolioDetailsWriter('book', main.api, direct, report().report)
  await writer.reload()
  const set = writer.set('title', 'T')
  const undo = writer.undo()
  await flush()
  main.held[0].resolve()
  await set
  await undo
  expect(undone).toEqual(['t1'])
})

test('a writer whose Folio the card left still writes what was queued, and reports nothing', async () => {
  const main = slowMain('a\n')
  const seen = report()
  const writer = new FolioDetailsWriter('book', main.api, direct, seen.report)
  await writer.reload()
  const set = writer.set('title', 'Kept')
  writer.detach()
  const before = seen.messages.length
  await flush()
  main.held[0].resolve()
  expect(await set).toBe(true)
  expect(main.disk()).toBe('a\ntitle=Kept\n')
  expect(seen.messages.length).toBe(before)
})

test('Undo from the menu and from ⌘Z use one check: a picker’s filter box or uncommitted typing keeps the text undo', () => {
  const element = (field: string | undefined, inPicker: boolean) => ({ dataset: { folioDetail: field }, closest: (selector: string) => (selector === '.fd-pop' && inPicker ? {} : null) })
  const none = { title: null, standfirst: null }
  // The Author picker's filter input: no data-folio-detail, inside .fd-pop.
  expect(typingInDetails(element(undefined, true), none)).toBe(true)
  expect(typingInDetails(element('title', false), { title: 'typed', standfirst: null })).toBe(true)
  expect(typingInDetails(element('title', false), none)).toBe(false)
  expect(typingInDetails(element('author', false), none)).toBe(false)
  expect(typingInDetails(null, none)).toBe(false)
})

// Sol round 3, new P1: a conflict must not rebase changes already queued onto text the user never saw.
test('when another editor changes the Index Note during a save, the changes queued behind it are dropped and the card says so', async () => {
  const main = slowMain('---\ntitle: Old\n---\n')
  const seen = report()
  const reads: string[] = []
  const writer = new FolioDetailsWriter('book', main.api, direct, { ...seen.report, read: (r) => { if (r.ok) reads.push(r.text) } })
  await writer.reload()
  // Status is being saved and Title is queued behind it...
  const status = writer.set('status', 'ready')
  const title = writer.set('title', 'Mine')
  await flush()
  // ...when another editor changes the title.
  main.edit('---\ntitle: Theirs\n---\n')
  main.held[0].resolve()
  expect(await status).toBe(false)
  expect(await title).toBe(false)
  // The queued Title change was never sent over the other editor's text.
  expect(main.sent.map((s) => s.field)).toEqual(['status'])
  expect(main.disk()).toBe('---\ntitle: Theirs\n---\n')
  // The card was refreshed from disk and told the changes were not saved.
  expect(reads.at(-1)).toBe('---\ntitle: Theirs\n---\n')
  expect(seen.messages.at(-1)).toBe(FOLIO_DETAILS_CHANGED_ELSEWHERE)
  expect(seen.pending.at(-1)?.size).toBe(0)
  // A change made after the card shows the new text is written over it.
  const again = writer.set('title', 'Mine')
  await flush()
  main.held[1].resolve()
  expect(await again).toBe(true)
  expect(main.sent[1].basis).toBe('---\ntitle: Theirs\n---\n')
})

test('a read after a write that finds another editor’s change too drops the changes queued before it', async () => {
  const main = slowMain('a\n')
  const writer = new FolioDetailsWriter('book', main.api, direct, report().report)
  await writer.reload()
  const realRead = main.api.read
  let sneak = true
  main.api.read = async (dir) => { if (sneak && main.sent.length === 1) { sneak = false; main.edit(`${main.disk()}other\n`) } return realRead(dir) }
  const first = writer.set('title', 'T')
  const second = writer.set('status', 'ready')
  await flush()
  main.held[0].resolve()
  expect(await first).toBe(true)
  expect(await second).toBe(false)
  expect(main.sent).toHaveLength(1)
})

test('an Undo leaves the card’s own text: a change queued after it is still sent', async () => {
  const main = slowMain('start\n')
  main.api.undo = async () => {
    main.edit(main.disk().replace('title=T\n', ''))
    return { ok: true, indexPath: 'x', text: main.disk() }
  }
  const writer = new FolioDetailsWriter('book', main.api, direct, report().report)
  await writer.reload()
  const set = writer.set('title', 'T')
  const undo = writer.undo()
  const after = writer.set('status', 'ready')
  await flush()
  main.held[0].resolve()
  await set; await undo
  await flush()
  main.held[1].resolve()
  expect(await after).toBe(true)
  expect(main.disk()).toBe('start\nstatus=ready\n')
})

// Sol round 3, finding 2 (partly fixed): the last value chosen is the one written.
test('a choice back to the shown value while another is saving is compared with the queued value, not skipped', async () => {
  const main = slowMain('---\n---\n')
  const writer = new FolioDetailsWriter('book', main.api, direct, report().report)
  await writer.reload()
  expect(writer.queued('status')).toBeUndefined()
  const ready = writer.set('status', 'ready')
  expect(writer.queued('status')).toBe('ready')
  // The card shows "draft"; the user picks "draft" again while "ready" is saving.
  expect(folioDetailUnchanged('draft', writer.queued('status'), 'draft')).toBe(false)
  const draft = writer.set('status', 'draft')
  expect(writer.queued('status')).toBe('draft')
  await flush()
  main.held[0].resolve()
  await ready
  await flush(); await flush()
  main.held[1].resolve()
  expect(await draft).toBe(true)
  expect(main.disk()).toBe('---\n---\nstatus=ready\nstatus=draft\n')
  expect(writer.queued('status')).toBeUndefined()
  // With nothing queued, the shown value decides; a typed field restored to its queued value is skipped.
  expect(folioDetailUnchanged(' draft ', undefined, 'draft')).toBe(true)
  expect(folioDetailUnchanged('Old', 'New', 'Old')).toBe(false)
  expect(folioDetailUnchanged('New', 'New', 'Old')).toBe(true)
})

// Sol round 4: a change dropped after the card has left the Folio is still said, in the app's status line.
test('after the card leaves the Folio, changes dropped because the Index Note changed elsewhere are said in the app’s status line', async () => {
  const main = slowMain('---\ntitle: Old\n---\n')
  const seen = report()
  const away: string[] = []
  const writer = new FolioDetailsWriter('work/book', main.api, direct, { ...seen.report, elsewhere: (m) => { away.push(m) } })
  await writer.reload()
  const status = writer.set('status', 'ready')
  const title = writer.set('title', 'Mine')
  await flush()
  // The user goes to another Folio; another editor changes this one's Index Note before Status completes.
  writer.detach()
  const before = seen.messages.length
  main.edit('---\ntitle: Theirs\n---\n')
  main.held[0].resolve()
  expect(await status).toBe(false)
  expect(await title).toBe(false)
  expect(main.sent).toHaveLength(1)
  // Nothing goes to the card it left; the app's status line names the Folio.
  expect(seen.messages.length).toBe(before)
  expect(away.length).toBeGreaterThan(0)
  expect(new Set(away)).toEqual(new Set(['The Index Note of “book” changed elsewhere, so your last changes there were not saved. Make them again.']))
})
