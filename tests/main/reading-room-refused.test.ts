import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore, type OutboxEntry } from '@readflex/sidecar'
import { createBunSqliteDriver } from '@readflex/sqlite-driver/bun'
import { highlightsResult, mergeWithOutbox, withKeptEdits } from '../../src/main/reading-room-highlights'
import {
  dismissRefused,
  keptEditKeys,
  reconcileKeptEdits,
  refusedHighlights,
  retryRefused,
} from '../../src/main/reading-room-refused'
import {
  annotationPayload,
  areaQuotationPayload,
  drainOutbox,
  localZoteroTransport,
  LEGACY_UNSUPPORTED_ZOTERO_EDIT_REASONS,
  UNSUPPORTED_ZOTERO_EDIT_REASON,
  type SavedAnnotation,
} from '../../src/main/zotero-annotation-writes'

const mark: SavedAnnotation = {
  color: '#ffd400',
  comment: null,
  key: 'ANN1',
  pageLabel: '157',
  position: '{"pageIndex":156,"rects":[[131.8,274.1,287,283.2]]}',
  sortIndex: '00156|000601|00268',
  tags: [],
  text: 'the implicit models that have generally been used',
  type: 'highlight',
}

const directories: string[] = []
function store(): SidecarStore {
  const directory = mkdtempSync(join(tmpdir(), 'wf-refused-'))
  directories.push(directory)
  return new SidecarStore(createBunSqliteDriver(), join(directory, 'sidecar.sqlite'))
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function enqueue(
  sidecar: SidecarStore,
  operation: OutboxEntry['operation'],
  annotation: SavedAnnotation = mark,
  parentItemKey = 'ATT1',
): OutboxEntry {
  return sidecar.enqueueOutbox({
    itemKey: annotation.key,
    libraryId: 1,
    operation,
    parentItemKey,
    payload: JSON.stringify(annotationPayload(annotation, parentItemKey)),
  })
}

/** Every stored row, by id, as the fields a reclassification must not disturb. */
function snapshot(sidecar: SidecarStore): Record<number, unknown> {
  const rows = (['pending', 'retrying', 'failed', 'conflict', 'confirmed'] as const)
    .flatMap((status) => sidecar.outboxByStatus(status))
  return Object.fromEntries(rows.map((row) => [row.id, {
    conflictPayload: row.conflictPayload,
    itemKey: row.itemKey,
    lastError: row.lastError,
    localOnly: row.localOnly,
    operation: row.operation,
    payload: row.payload,
    status: row.status,
  }]))
}

const neverInserts = { insert(): never { throw new Error('an edit must never reach the insert') } }

test('an edit and a deletion Zotero cannot take yet are kept, drawn as edited, and never counted refused', async () => {
  const sidecar = store()
  const edited = { ...mark, color: '#5fb236', comment: 'my note' }
  const update = enqueue(sidecar, 'update', edited)
  const removal = enqueue(sidecar, 'delete', { ...mark, key: 'ANN2' })

  const report = await drainOutbox(sidecar, localZoteroTransport(neverInserts))

  expect(report).toMatchObject({ attempted: 2, keptLocal: 2, rejected: 0, confirmed: 0 })
  expect(sidecar.countOutboxRejected()).toBe(0)
  expect(sidecar.countOutboxWaiting()).toBe(0)
  expect(refusedHighlights(sidecar, () => null)).toEqual([])
  // Both survive, unaltered, with the reason they are here.
  const kept = sidecar.outboxUnconfirmed()
  expect(kept.map((entry) => [entry.id, entry.localOnly, entry.lastError])).toEqual([
    [update.id, 1, UNSUPPORTED_ZOTERO_EDIT_REASON],
    [removal.id, 1, UNSUPPORTED_ZOTERO_EDIT_REASON],
  ])
  expect(kept[0]!.payload).toBe(update.payload)
  expect(kept[1]!.payload).toBe(removal.payload)
  // What the Reading Room shows is the EDIT, over the copy Zotero still holds.
  const inZotero = { authorName: null, color: '#ffd400', comment: null, isExternal: false, key: 'ANN1',
    pageLabel: '157', parentItemKey: 'ATT1', position: mark.position, sortIndex: mark.sortIndex,
    tags: [], text: mark.text, type: 'highlight' as const }
  const shown = withKeptEdits(highlightsResult(mergeWithOutbox([inZotero], kept)), keptEditKeys(kept))
  expect(shown.rows).toMatchObject([{ key: 'ANN1', colour: '#5fb236', comment: 'my note', keptHere: true }])
  expect(shown.forReader).toMatchObject([{ key: 'ANN1', color: '#5fb236', comment: 'my note' }])
  // A second drain has nothing to do: a kept edit is not retried.
  expect(await drainOutbox(sidecar, localZoteroTransport(neverInserts))).toMatchObject({ attempted: 0 })
  sidecar.close()
})

test('reconciling legacy rows is idempotent and touches only unsupported edits', () => {
  const sidecar = store()
  const legacyUpdate = enqueue(sidecar, 'update', { ...mark, comment: 'my note' })
  sidecar.markOutboxFailed(legacyUpdate.id, UNSUPPORTED_ZOTERO_EDIT_REASON, false)
  const legacyDelete = enqueue(sidecar, 'delete', { ...mark, key: 'ANN2' })
  sidecar.markOutboxFailed(legacyDelete.id, UNSUPPORTED_ZOTERO_EDIT_REASON, false)
  const waitingEdit = enqueue(sidecar, 'update', { ...mark, key: 'ANN3' })

  // Everything below must be left exactly as it is.
  const otherReason = enqueue(sidecar, 'update', { ...mark, key: 'ANN4' })
  sidecar.markOutboxFailed(otherReason.id, 'Zotero rejected this operation.', false)
  const refusedInsert = enqueue(sidecar, 'create', { ...mark, key: 'ANN5' })
  sidecar.markOutboxFailed(refusedInsert.id, 'The paper this highlight belongs to is no longer in Zotero.', false)
  // An insert that happens to carry the sentence is still an insert: the operation decides.
  const insertWithSentence = enqueue(sidecar, 'create', { ...mark, key: 'ANN6' })
  sidecar.markOutboxFailed(insertWithSentence.id, UNSUPPORTED_ZOTERO_EDIT_REASON, false)
  const conflict = enqueue(sidecar, 'update', { ...mark, key: 'ANN7', comment: 'mine' })
  sidecar.markOutboxConflict(conflict.id, conflict.payload, 'The annotation changed in Zotero.')
  const waitingInsert = enqueue(sidecar, 'create', { ...mark, key: 'ANN8' })
  const areaQuotation = sidecar.enqueueOutbox({ itemKey: 'AREA1', libraryId: 1, operation: 'update',
    parentItemKey: 'ATT1', payload: JSON.stringify(areaQuotationPayload(
      annotationPayload({ ...mark, key: 'AREA1', type: 'image' }, 'ATT1'), 'AREA1', 'Quoted in: Piece')) })
  const refusedAreaQuotation = sidecar.enqueueOutbox({ itemKey: 'AREA2', libraryId: 1, operation: 'update',
    parentItemKey: 'ATT1', payload: areaQuotation.payload })
  sidecar.markOutboxFailed(refusedAreaQuotation.id, UNSUPPORTED_ZOTERO_EDIT_REASON, false)
  const unreadable = sidecar.enqueueOutbox({ itemKey: 'BROKEN1', libraryId: 1, operation: 'update',
    parentItemKey: 'ATT1', payload: '{not json' })
  sidecar.markOutboxFailed(unreadable.id, UNSUPPORTED_ZOTERO_EDIT_REASON, false)
  const confirmed = enqueue(sidecar, 'create', { ...mark, key: 'ANN9' })
  sidecar.markOutboxConfirmed(confirmed.id, 'ANN9')
  const untouched = [otherReason, refusedInsert, insertWithSentence, conflict, waitingInsert,
    areaQuotation, refusedAreaQuotation, unreadable, confirmed].map((entry) => entry.id)

  const before = snapshot(sidecar)
  expect(sidecar.countOutboxRejected()).toBe(8)

  expect(reconcileKeptEdits(sidecar)).toBe(3)

  const after = snapshot(sidecar)
  for (const id of untouched) expect(after[id]).toEqual(before[id])
  for (const entry of [legacyUpdate, legacyDelete, waitingEdit]) {
    expect(after[entry.id]).toEqual({
      ...(before[entry.id] as object),
      lastError: UNSUPPORTED_ZOTERO_EDIT_REASON,
      localOnly: 1,
      status: 'failed',
    })
    // The reader's words are byte-identical.
    expect((after[entry.id] as { payload: string }).payload).toBe(entry.payload)
  }
  expect(sidecar.countOutboxRejected()).toBe(6)
  // The waiting insert and the Area quotation are still owed to Zotero.
  expect(sidecar.countOutboxWaiting()).toBe(2)

  // Idempotent: a second and third run change nothing at all.
  expect(reconcileKeptEdits(sidecar)).toBe(0)
  expect(reconcileKeptEdits(sidecar)).toBe(0)
  expect(snapshot(sidecar)).toEqual(after)
  sidecar.close()
})

test('a failed row stored with the old ReadFlex sentence is still recognised and reconciled', () => {
  const sidecar = store()
  const oldSentence = 'Editing a highlight in Zotero itself is not something ReadFlex does yet, so this change is kept here.'
  expect(LEGACY_UNSUPPORTED_ZOTERO_EDIT_REASONS).toContain(oldSentence)
  const row = enqueue(sidecar, 'update', { ...mark, comment: 'my note' })
  sidecar.markOutboxFailed(row.id, oldSentence, false)
  expect(sidecar.countOutboxRejected()).toBe(1)
  expect(reconcileKeptEdits(sidecar)).toBe(1)
  const after = snapshot(sidecar)[row.id] as { lastError: string; localOnly: number; status: string }
  expect(after).toMatchObject({ lastError: UNSUPPORTED_ZOTERO_EDIT_REASON, localOnly: 1, status: 'failed' })
  expect(sidecar.countOutboxRejected()).toBe(0)
  expect(reconcileKeptEdits(sidecar)).toBe(0)
  sidecar.close()
})

test('a genuine refusal still counts and is listed with its paper, words, reason and date', async () => {
  const sidecar = store()
  enqueue(sidecar, 'create', mark, 'ATT1')
  enqueue(sidecar, 'create', { ...mark, key: 'ANN2', text: null, comment: 'x '.repeat(200) }, 'ATT2')
  const report = await drainOutbox(sidecar, localZoteroTransport({
    insert() { throw new Error('The document this highlight belongs to is no longer in Zotero, so the highlight was not written.') },
  }))
  expect(report).toMatchObject({ attempted: 2, rejected: 2, keptLocal: 0 })
  expect(sidecar.countOutboxRejected()).toBe(2)

  const listed = refusedHighlights(sidecar, (libraryId, attachmentKey) =>
    attachmentKey === 'ATT1' && libraryId === 1 ? { itemKey: 'ITEM1', title: 'Lakoff 1987 — Women, Fire' } : null)

  expect(listed).toHaveLength(sidecar.countOutboxRejected())
  expect(listed[0]).toMatchObject({
    documentTitle: 'Lakoff 1987 — Women, Fire',
    excerpt: 'the implicit models that have generally been used',
    kind: 'refused',
    open: { attachmentKey: 'ATT1', itemKey: 'ITEM1', libraryId: 1 },
    position: mark.position,
    reason: 'The document this highlight belongs to is no longer in Zotero, so the highlight was not written.',
    retryable: true,
  })
  expect(Number.isNaN(new Date(listed[0]!.date).getTime())).toBe(false)
  // A paper the library no longer names falls back to its key, and cannot be opened.
  expect(listed[1]).toMatchObject({ documentTitle: 'ATT2', open: null })
  expect(listed[1]!.excerpt.length).toBeLessThanOrEqual(160)
  expect(listed[1]!.excerpt.endsWith('…')).toBe(true)
  sidecar.close()
})

test('a conflict keeps the losing payload, is listed, and keeps it when dismissed', () => {
  const sidecar = store()
  const conflict = enqueue(sidecar, 'update', { ...mark, comment: 'mine' })
  sidecar.markOutboxConflict(conflict.id, conflict.payload, 'The annotation changed in Zotero.')

  expect(reconcileKeptEdits(sidecar)).toBe(0)
  expect(sidecar.countOutboxRejected()).toBe(1)
  expect(refusedHighlights(sidecar, () => null)).toMatchObject([
    { id: conflict.id, kind: 'conflict', reason: 'The annotation changed in Zotero.', retryable: false },
  ])
  expect(sidecar.outboxByStatus('conflict')[0]!.conflictPayload).toBe(conflict.payload)

  expect(retryRefused(sidecar, conflict.id)).toBe(false)
  expect(dismissRefused(sidecar, conflict.id)).toBe(true)
  expect(sidecar.countOutboxRejected()).toBe(0)
  expect(sidecar.outboxUnconfirmed()).toMatchObject([{
    conflictPayload: conflict.payload,
    id: conflict.id,
    lastError: 'The annotation changed in Zotero.',
    localOnly: 1,
    payload: conflict.payload,
  }])
  sidecar.close()
})

test('dismiss removes a refusal from the count and keeps the highlight; retry requeues only an insert', () => {
  const sidecar = store()
  const refused = enqueue(sidecar, 'create')
  sidecar.markOutboxFailed(refused.id, 'This highlight could not be written to Zotero.', false)
  const waiting = enqueue(sidecar, 'create', { ...mark, key: 'ANN2' })

  // Neither action reaches a row that is not refused.
  expect(dismissRefused(sidecar, waiting.id)).toBe(false)
  expect(retryRefused(sidecar, waiting.id)).toBe(false)
  expect(dismissRefused(sidecar, 4711)).toBe(false)
  expect(sidecar.countOutboxWaiting()).toBe(1)
  expect(sidecar.countOutboxRejected()).toBe(1)

  expect(dismissRefused(sidecar, refused.id)).toBe(true)
  expect(sidecar.countOutboxRejected()).toBe(0)
  expect(refusedHighlights(sidecar, () => null)).toEqual([])
  const kept = sidecar.outboxUnconfirmed().find((entry) => entry.id === refused.id)
  expect(kept).toMatchObject({ lastError: 'This highlight could not be written to Zotero.',
    localOnly: 1, payload: refused.payload })
  // Still drawn on the page and in the list.
  expect(highlightsResult(mergeWithOutbox([], [kept!])).rows).toMatchObject([{ key: 'ANN1', body: mark.text }])
  // Dismissed twice is dismissed once.
  expect(dismissRefused(sidecar, refused.id)).toBe(false)

  const again = enqueue(sidecar, 'create', { ...mark, key: 'ANN3' })
  sidecar.markOutboxFailed(again.id, 'This highlight could not be written to Zotero.', false)
  expect(retryRefused(sidecar, again.id)).toBe(true)
  expect(sidecar.outboxByStatus('pending').map((entry) => entry.id)).toEqual([waiting.id, again.id])
  expect(sidecar.countOutboxRejected()).toBe(0)
  sidecar.close()
})
