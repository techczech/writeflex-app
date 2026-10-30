import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore, type OutboxEntry } from '@readflex/sidecar'
import { createBunSqliteDriver } from '@readflex/sqlite-driver/bun'
import {
  annotationPayload,
  areaQuotationPayload,
  drainOutbox,
  type SavedAnnotation,
  type ZoteroWriteTransport,
} from '../../src/main/zotero-annotation-writes'
import { queueAnnotationChange } from '../../src/main/zotero-outbox-edits'

const mark: SavedAnnotation = {
  color: '#ffd400',
  comment: null,
  key: 'ANN1',
  pageLabel: '1',
  position: '{"pageIndex":0,"rects":[[10,20,30,40]]}',
  sortIndex: '00000|000001|00001',
  tags: [],
  text: 'Selected words',
  type: 'highlight',
}

const directories: string[] = []
function store(): SidecarStore {
  const directory = mkdtempSync(join(tmpdir(), 'wf-outbox-edits-'))
  directories.push(directory)
  return new SidecarStore(createBunSqliteDriver(), join(directory, 'sidecar.sqlite'))
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function change(operation: OutboxEntry['operation'], annotation: SavedAnnotation = mark, extra: Record<string, unknown> = {}) {
  return {
    itemKey: annotation.key,
    libraryId: 1,
    operation,
    parentItemKey: 'ATT1',
    payload: JSON.stringify({ ...annotationPayload(annotation, 'ATT1'), ...extra }),
  }
}

const unconfirmed = (sidecar: SidecarStore) =>
  sidecar.outboxUnconfirmedAll().map((entry) => ({
    colour: (JSON.parse(entry.payload) as { annotationColor?: string }).annotationColor,
    key: entry.itemKey,
    operation: entry.operation,
    status: entry.status,
  }))

test('an edit after a create Zotero has not taken folds into the create, keeping its place', () => {
  const sidecar = store()
  queueAnnotationChange(sidecar, change('create'))
  const other = queueAnnotationChange(sidecar, change('create', { ...mark, key: 'ANN2' }))
  const folded = queueAnnotationChange(sidecar, change('update', { ...mark, color: '#5fb236' }))
  expect(folded.kind).toBe('folded')
  expect(unconfirmed(sidecar)).toEqual([
    { colour: '#5fb236', key: 'ANN1', operation: 'create', status: 'pending' },
    { colour: '#ffd400', key: 'ANN2', operation: 'create', status: 'pending' },
  ])
  expect(other.kind).toBe('queued')
  sidecar.close()
})

test('an Area create keeps the identity its quotation records resolve by when an edit folds in', () => {
  const sidecar = store()
  const area = { ...mark, key: 'AREA1', type: 'image' as const }
  queueAnnotationChange(sidecar, change('create', area, { readflexSourceKey: 'AREA1' }))
  queueAnnotationChange(sidecar, change('update', { ...area, comment: 'the figure' }))
  const [row] = sidecar.outboxUnconfirmedAll()
  expect(JSON.parse(row!.payload)).toMatchObject({ annotationComment: 'the figure', readflexSourceKey: 'AREA1' })
  sidecar.close()
})

test('a second edit to a mark Zotero has folds into the waiting edit; a confirmed mark gets a new edit', () => {
  const sidecar = store()
  const created = sidecar.enqueueOutbox(change('create'))
  sidecar.markOutboxConfirmed(created.id)
  expect(queueAnnotationChange(sidecar, change('update', { ...mark, color: '#5fb236' })).kind).toBe('queued')
  expect(queueAnnotationChange(sidecar, change('update', { ...mark, color: '#2ea8e5' })).kind).toBe('folded')
  expect(unconfirmed(sidecar)).toEqual([{ colour: '#2ea8e5', key: 'ANN1', operation: 'update', status: 'pending' }])
  sidecar.close()
})

test('an edit never folds into the private Area quotation record', () => {
  const sidecar = store()
  const area = { ...mark, key: 'AREA1', type: 'image' as const }
  const created = sidecar.enqueueOutbox(change('create', area))
  sidecar.markOutboxConfirmed(created.id)
  sidecar.enqueueOutbox({ itemKey: 'AREA1', libraryId: 1, operation: 'update', parentItemKey: 'ATT1',
    payload: JSON.stringify(areaQuotationPayload(annotationPayload(area, 'ATT1'), 'AREA1', 'Quoted in "Piece" — 21 October 2026')) })
  expect(queueAnnotationChange(sidecar, change('update', { ...area, color: '#5fb236' })).kind).toBe('queued')
  expect(sidecar.outboxUnconfirmedAll()).toHaveLength(2)
  sidecar.close()
})

test('deleting a mark Zotero never got cancels the create and everything queued after it', () => {
  const sidecar = store()
  const create = sidecar.enqueueOutbox(change('create'))
  sidecar.markOutboxFailed(create.id, 'Close Zotero and this highlight will be saved to your library.', true)
  sidecar.enqueueOutbox(change('create', { ...mark, key: 'KEEP0001' }))
  expect(queueAnnotationChange(sidecar, change('delete'))).toEqual({ kind: 'cancelled', removed: 1 })
  expect(unconfirmed(sidecar).map((row) => row.key)).toEqual(['KEEP0001'])
  sidecar.close()
})

test('a web or EPUB mark kept here and then deleted cancels too — nothing was ever owed', () => {
  const sidecar = store()
  const create = sidecar.enqueueOutbox(change('create'))
  sidecar.markOutboxLocalOnly(create.id, "Marks on web pages and EPUBs stay here for now — sending them to Zotero isn't built yet")
  expect(queueAnnotationChange(sidecar, change('delete')).kind).toBe('cancelled')
  expect(sidecar.outboxUnconfirmedAll()).toEqual([])
  sidecar.close()
})

test('deleting a mark Zotero has drops its waiting edits and queues one delete, once', () => {
  const sidecar = store()
  const created = sidecar.enqueueOutbox(change('create'))
  sidecar.markOutboxConfirmed(created.id)
  queueAnnotationChange(sidecar, change('update', { ...mark, color: '#5fb236' }))
  const first = queueAnnotationChange(sidecar, change('delete'))
  const again = queueAnnotationChange(sidecar, change('delete'))
  expect(first.kind).toBe('queued')
  expect(again.kind).toBe('folded')
  expect(unconfirmed(sidecar)).toEqual([{ colour: '#ffd400', key: 'ANN1', operation: 'delete', status: 'pending' }])
  // The confirmed create is history and is never touched.
  expect(sidecar.outboxByStatus('confirmed')).toHaveLength(1)
  sidecar.close()
})

const shown = (comment: string | null) => ({
  color: '#ffd400', comment, pageLabel: '1', position: mark.position, sortIndex: mark.sortIndex, text: mark.text,
})
const baselineOf = (entry: OutboxEntry | undefined) => (JSON.parse(entry!.payload) as { readflexBaseline?: unknown }).readflexBaseline

test('an edit is queued with the baseline it was made against; a folded edit keeps the earliest one', () => {
  const sidecar = store()
  const created = sidecar.enqueueOutbox(change('create'))
  sidecar.markOutboxConfirmed(created.id)
  queueAnnotationChange(sidecar, change('update', { ...mark, comment: 'first' }), shown(null))
  queueAnnotationChange(sidecar, change('update', { ...mark, comment: 'second' }), shown('first'))
  const [row] = sidecar.outboxUnconfirmedAll()
  expect(JSON.parse(row!.payload)).toMatchObject({ annotationComment: 'second' })
  // Zotero saw neither edit, so the write is compared against what it held before the first.
  expect(baselineOf(row)).toEqual(shown(null))
  sidecar.close()
})

test('a deletion that replaces waiting edits is compared against what Zotero held before them', () => {
  const sidecar = store()
  const created = sidecar.enqueueOutbox(change('create'))
  sidecar.markOutboxConfirmed(created.id)
  queueAnnotationChange(sidecar, change('update', { ...mark, comment: 'edited here' }), shown(null))
  queueAnnotationChange(sidecar, change('delete', { ...mark, comment: 'edited here' }), shown('edited here'))
  const rows = sidecar.outboxUnconfirmedAll()
  expect(rows.map((entry) => entry.operation)).toEqual(['delete'])
  expect(baselineOf(rows[0])).toEqual(shown(null))
  sidecar.close()
})

test('a create never carries a baseline, even when an edit folds into it', () => {
  const sidecar = store()
  queueAnnotationChange(sidecar, change('create'))
  queueAnnotationChange(sidecar, change('update', { ...mark, comment: 'x' }), shown(null))
  expect(baselineOf(sidecar.outboxUnconfirmedAll()[0])).toBeUndefined()
  sidecar.close()
})

test('SHOULD-FIX collapse atomicity: if queueing the delete fails, the waiting edits it would replace are still there', () => {
  const sidecar = store()
  const created = sidecar.enqueueOutbox(change('create'))
  sidecar.markOutboxConfirmed(created.id)
  queueAnnotationChange(sidecar, change('update', { ...mark, color: '#5fb236' }), shown(null))
  const before = sidecar.outboxUnconfirmedAll()
  // The same store, except that adding a row fails after the edits were dropped.
  const failing = {
    cancelOutboxEntries: (ids: readonly number[]) => sidecar.cancelOutboxEntries(ids),
    enqueueOutbox: (): OutboxEntry => { throw new Error('disk full') },
    outboxRowsForKey: (...args: Parameters<SidecarStore['outboxRowsForKey']>) => sidecar.outboxRowsForKey(...args),
    replaceOutboxPayload: (id: number, payload: string) => sidecar.replaceOutboxPayload(id, payload),
    runInTransaction: <T,>(work: () => T): T => sidecar.runInTransaction(work),
  }
  expect(() => queueAnnotationChange(failing, change('delete'), shown(null))).toThrow('disk full')
  expect(sidecar.outboxUnconfirmedAll()).toEqual(before)
  sidecar.close()
})

// ---------------------------------------------------------------------------
// Rows in flight (Sol round 2, item 2): a row a drain is writing is claimed, never folded or cancelled
// ---------------------------------------------------------------------------

const before = { color: '#ffd400', comment: null, pageLabel: '1', position: mark.position, sortIndex: mark.sortIndex, text: mark.text }

/** A transport that records what each write carried and lets the test act while it is in flight. */
function slowTransport(during: (request: Parameters<ZoteroWriteTransport>[0]) => void) {
  const sent: Array<{ operation: string; colour?: string; key: string | null; resend?: boolean; baseline?: unknown }> = []
  const transport: ZoteroWriteTransport = async (request) => {
    sent.push({
      baseline: request.payload.readflexBaseline,
      colour: request.payload.annotationColor,
      key: request.itemKey,
      operation: request.operation,
      resend: request.resend,
    })
    during(request)
    await new Promise((resolve) => setTimeout(resolve, 1))
    return { itemKey: request.itemKey ?? undefined, kind: 'confirmed' }
  }
  return { sent, transport }
}

test('SOL REPRO: an edit made while its create is being written is queued after it, and both reach Zotero', async () => {
  const sidecar = store()
  queueAnnotationChange(sidecar, change('create'))
  let edited = false
  const { sent, transport } = slowTransport((request) => {
    if (edited || request.operation !== 'create') return
    edited = true
    // The reader recolours the mark while its create is in flight. Before: folded into the create's
    // payload, and the confirmation of the OLD payload marked the new colour as written.
    const queued = queueAnnotationChange(sidecar, change('update', { ...mark, color: '#5fb236' }), before)
    expect(queued.kind).toBe('queued')
  })
  const first = await drainOutbox(sidecar, transport)
  expect(first).toMatchObject({ confirmed: 1 })
  // The follow-up was not due in the batch read before it existed; the next drain writes it.
  expect(unconfirmed(sidecar)).toEqual([{ colour: '#5fb236', key: 'ANN1', operation: 'update', status: 'pending' }])
  expect(await drainOutbox(sidecar, transport)).toMatchObject({ confirmed: 1 })
  expect(sent).toEqual([
    { baseline: undefined, colour: '#ffd400', key: 'ANN1', operation: 'create', resend: undefined },
    { baseline: before, colour: '#5fb236', key: 'ANN1', operation: 'update', resend: undefined },
  ])
  expect(unconfirmed(sidecar)).toEqual([])
  sidecar.close()
})

test('SOL REPRO: deleting a mark while its create is being written queues a deletion that runs after it', async () => {
  const sidecar = store()
  queueAnnotationChange(sidecar, change('create'))
  let deleted = false
  const { sent, transport } = slowTransport((request) => {
    if (deleted || request.operation !== 'create') return
    deleted = true
    // Before: the delete cancelled the create row while its write was in flight, so the mark reached
    // Zotero and the outbox forgot it — no deletion ever followed.
    const queued = queueAnnotationChange(sidecar, change('delete'), before)
    expect(queued.kind).toBe('queued')
  })
  await drainOutbox(sidecar, transport)
  expect(sidecar.outboxByStatus('confirmed').map((entry) => entry.operation)).toEqual(['create'])
  expect(unconfirmed(sidecar)).toEqual([{ colour: '#ffd400', key: 'ANN1', operation: 'delete', status: 'pending' }])
  await drainOutbox(sidecar, transport)
  expect(sent.map((write) => write.operation)).toEqual(['create', 'delete'])
  expect(sent[1]!.baseline).toEqual(before)
  expect(unconfirmed(sidecar)).toEqual([])
  sidecar.close()
})

test('an edit made while an earlier edit is being written follows it with the reader\'s own before-state', async () => {
  const sidecar = store()
  const created = sidecar.enqueueOutbox(change('create'))
  sidecar.markOutboxConfirmed(created.id)
  queueAnnotationChange(sidecar, change('update', { ...mark, color: '#5fb236' }), before)
  const afterFirst = { ...before, color: '#5fb236' }
  const { sent, transport } = slowTransport((request) => {
    if (request.payload.annotationComment) return
    queueAnnotationChange(sidecar, change('update', { ...mark, color: '#5fb236', comment: 'second' }), afterFirst)
  })
  await drainOutbox(sidecar, transport)
  await drainOutbox(sidecar, transport)
  expect(sent.map((write) => write.baseline)).toEqual([before, afterFirst])
  expect(unconfirmed(sidecar)).toEqual([])
  sidecar.close()
})

test('a claimed row cannot be folded into, cancelled or claimed twice; confirming another revision leaves it waiting', () => {
  const sidecar = store()
  const row = queueAnnotationChange(sidecar, change('update', { ...mark, color: '#5fb236' }), before)
  if (row.kind !== 'queued') throw new Error('expected a queued row')
  const claimed = sidecar.claimOutboxForSending(row.entry.id)!
  expect(claimed.sendingRevision).toBe(0)
  expect(sidecar.claimOutboxForSending(row.entry.id)).toBeNull()
  expect(sidecar.outboxDue()).toEqual([])
  expect(sidecar.replaceOutboxPayload(row.entry.id, '{}')).toBe(false)
  sidecar.cancelOutboxEntries([row.entry.id])
  expect(sidecar.outboxEntry(row.entry.id)?.payload).toBe(row.entry.payload)
  // A confirmation for a revision that is not the stored one is refused; the row stays waiting.
  expect(sidecar.markOutboxConfirmed(row.entry.id, undefined, 7)).toBe(false)
  // It is marked as interrupted (Zotero may hold some version of it), so it is not rewritten either.
  expect(sidecar.outboxEntry(row.entry.id)).toMatchObject({ sendInterrupted: 1, sendingRevision: null, status: 'pending' })
  expect(sidecar.replaceOutboxPayload(row.entry.id, '{}')).toBe(false)
  // Sent again as it stands, only its own revision confirms.
  const again = sidecar.claimOutboxForSending(row.entry.id)!
  expect(again.revision).toBe(0)
  expect(sidecar.markOutboxConfirmed(row.entry.id, undefined, 0)).toBe(true)
  expect(sidecar.outboxEntry(row.entry.id)?.status).toBe('confirmed')
  sidecar.close()
})

test('a write cut off by the app stopping is put back in the queue at the next start and sent as a resend', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wf-outbox-edits-'))
  directories.push(directory)
  const path = join(directory, 'sidecar.sqlite')
  const first = new SidecarStore(createBunSqliteDriver(), path)
  const row = first.enqueueOutbox(change('create'))
  expect(first.claimOutboxForSending(row.id)).not.toBeNull()
  first.close() // the app stopped mid-write

  const second = new SidecarStore(createBunSqliteDriver(), path)
  expect(second.outboxDue()).toEqual([])
  expect(second.recoverInterruptedSends()).toBe(1)
  expect(second.outboxEntry(row.id)).toMatchObject({ sendInterrupted: 1, sendingRevision: null, status: 'pending' })
  const { sent, transport } = slowTransport(() => {})
  expect(await drainOutbox(second, transport)).toMatchObject({ confirmed: 1 })
  expect(sent).toMatchObject([{ operation: 'create', resend: true }])
  expect(second.outboxEntry(row.id)).toMatchObject({ sendInterrupted: 0, status: 'confirmed' })
  second.close()
})

test('a later change to a mark waits while an earlier change to it is still owed', async () => {
  const sidecar = store()
  queueAnnotationChange(sidecar, change('create'))
  // A row queued after a create that Zotero will not take yet (a retry, not a refusal).
  sidecar.enqueueOutbox({ ...change('update', { ...mark, color: '#5fb236' }), payload: JSON.stringify({ ...annotationPayload({ ...mark, color: '#5fb236' }, 'ATT1'), readflexBaseline: before }) })
  const sent: string[] = []
  const transport: ZoteroWriteTransport = async (request) => {
    sent.push(request.operation)
    return { kind: 'retry', reason: 'not now' }
  }
  await drainOutbox(sidecar, transport)
  expect(sent).toEqual(['create'])
  expect(unconfirmed(sidecar).map((row) => row.status)).toEqual(['retrying', 'pending'])
  sidecar.close()
})

test('SOL REPRO: a create whose send was cut off is never folded into or cancelled; a deletion queues behind its resend', async () => {
  const sidecar = store()
  queueAnnotationChange(sidecar, change('create'))
  // The create left, and no answer came back: Zotero may hold it.
  await drainOutbox(sidecar, async () => ({ kind: 'retry', reason: 'Zotero did not answer in time.', uncertain: true }))
  expect(sidecar.outboxUnconfirmedAll()).toMatchObject([{ operation: 'create', sendInterrupted: 1 }])

  // An edit is not folded into it: the create's payload is what Zotero may already hold.
  const edited = queueAnnotationChange(sidecar, change('update', { ...mark, color: '#5fb236' }), before)
  expect(edited.kind).toBe('queued')
  expect(unconfirmed(sidecar)).toEqual([
    { colour: '#ffd400', key: 'ANN1', operation: 'create', status: 'retrying' },
    { colour: '#5fb236', key: 'ANN1', operation: 'update', status: 'pending' },
  ])

  // A deletion does not cancel it either: it queues behind the resend.
  const deleted = queueAnnotationChange(sidecar, change('delete', { ...mark, color: '#5fb236' }), { ...before, color: '#5fb236' })
  expect(deleted.kind).toBe('queued')
  expect(unconfirmed(sidecar).map((row) => row.operation)).toEqual(['create', 'delete'])

  const sent: Array<{ operation: string; resend?: boolean; baseline: unknown }> = []
  await drainOutbox(sidecar, async (request) => {
    sent.push({ baseline: request.payload.readflexBaseline ?? null, operation: request.operation, resend: request.resend })
    return { itemKey: 'ANN1', kind: 'confirmed' }
  })
  expect(sent.map((write) => [write.operation, write.resend ?? false])).toEqual([['create', true], ['delete', false]])
  // The deletion is compared against what Zotero holds after the create: the edit never reached it.
  expect(sent[1]!.baseline).toEqual(before)
  expect(unconfirmed(sidecar)).toEqual([])
  sidecar.close()
})

const ONE = '1'.repeat(32)
const TWO = '2'.repeat(32)
const sessionOf = (entry: OutboxEntry) => (JSON.parse(entry.payload) as { readflexReaderSession?: string }).readflexReaderSession

test('a fold keeps the reader session of the row it lands in', () => {
  const sidecar = store()
  const created = queueAnnotationChange(sidecar, change('create', mark, { readflexReaderSession: ONE }))
  // A reader opened later saw the owed mark under the same key and edits it: same mark, one row.
  const folded = queueAnnotationChange(sidecar, change('update', { ...mark, color: '#5fb236' }, { readflexReaderSession: TWO }), {
    color: '#ffd400', comment: null, pageLabel: '1', position: mark.position, sortIndex: mark.sortIndex, text: mark.text,
  })
  expect(folded.kind).toBe('folded')
  expect(sessionOf(sidecar.outboxEntry(created.kind === 'queued' ? created.entry.id : 0)!)).toBe(ONE)
  sidecar.close()
})

test('after a re-key, changes of the re-keying reader and of any other reader under the old key never fold together', () => {
  const sidecar = store()
  const before = { color: '#ffd400', comment: null, pageLabel: '1', position: mark.position, sortIndex: mark.sortIndex, text: mark.text }
  sidecar.recordOutboxKeyReplacement(1, 'ATT1', 'ANN1', 'FRESHKY2', ONE)
  const ours = queueAnnotationChange(sidecar, change('update', { ...mark, color: '#5fb236' }, { readflexReaderSession: ONE }), before)
  expect(ours.kind).toBe('queued')
  // Another reader edits what Zotero holds under ANN1: its own row, not folded into ours.
  const theirs = queueAnnotationChange(sidecar, change('update', { ...mark, color: '#ff6666' }, { readflexReaderSession: TWO }), before)
  expect(theirs.kind).toBe('queued')
  // Its deletion does not cancel or absorb ours either; our next edit still folds into ours.
  expect(queueAnnotationChange(sidecar, change('update', { ...mark, color: '#2ea8e5' }, { readflexReaderSession: ONE }), before).kind).toBe('folded')
  const rows = sidecar.outboxUnconfirmedAll()
  expect(rows.map((entry) => [sessionOf(entry), (JSON.parse(entry.payload) as { annotationColor: string }).annotationColor]))
    .toEqual([[ONE, '#2ea8e5'], [TWO, '#ff6666']])
  sidecar.close()
})
