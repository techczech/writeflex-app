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
  refusedHighlights,
  retryRefused,
} from '../../src/main/reading-room-refused'
import { releaseKeptEdits } from '../../src/main/zotero-outbox-edits'
import {
  annotationPayload,
  areaQuotationPayload,
  drainOutbox,
  LEGACY_UNSUPPORTED_ZOTERO_EDIT_REASONS,
  UNSUPPORTED_ZOTERO_EDIT_REASON,
  type SavedAnnotation,
  type ZoteroWriteOutcome,
  type ZoteroWriteTransport,
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

/** `mark` as the reader showed it: the baseline an edit or deletion of it is written against. */
const shownMark = {
  color: mark.color,
  comment: mark.comment,
  pageLabel: mark.pageLabel,
  position: mark.position,
  sortIndex: mark.sortIndex,
  text: mark.text,
}

function enqueue(
  sidecar: SidecarStore,
  operation: OutboxEntry['operation'],
  annotation: SavedAnnotation = mark,
  parentItemKey = 'ATT1',
  baseline: typeof shownMark | null = null,
): OutboxEntry {
  return sidecar.enqueueOutbox({
    itemKey: annotation.key,
    libraryId: 1,
    operation,
    parentItemKey,
    payload: JSON.stringify({
      ...annotationPayload(annotation, parentItemKey),
      ...(baseline ? { readflexBaseline: baseline } : {}),
    }),
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

type EditCall = { kind: 'update' | 'delete'; key: string; parentAttachmentKey: string; color?: string | null; comment?: string | null }

/** A stand-in for the plugin route: records edits and deletions, and answers each with `answer`. */
function editingTransport(calls: EditCall[], answer: ZoteroWriteOutcome = { kind: 'confirmed' }): ZoteroWriteTransport {
  return async ({ itemKey, operation, parentItemKey, payload }) => {
    if (operation === 'create') throw new Error('an edit must never reach a create')
    calls.push(operation === 'delete'
      ? { key: itemKey!, kind: 'delete', parentAttachmentKey: parentItemKey! }
      : { color: payload.annotationColor ?? null, comment: payload.annotationComment ?? null, key: itemKey!, kind: 'update', parentAttachmentKey: parentItemKey! })
    return answer
  }
}

test('an edit and a deletion are sent through the transport, by key and document, and confirmed', async () => {
  const sidecar = store()
  const edited = { ...mark, color: '#5fb236', comment: 'my note' }
  enqueue(sidecar, 'update', edited, 'ATT1', shownMark)
  enqueue(sidecar, 'delete', { ...mark, key: 'ANN2' }, 'ATT1', shownMark)

  // While both still wait, the Room shows the edit and no longer shows the deleted mark.
  const inZotero = (key: string) => ({ authorName: null, color: '#ffd400', comment: null, isExternal: false, key,
    pageLabel: '157', parentItemKey: 'ATT1', position: mark.position, sortIndex: mark.sortIndex,
    tags: [], text: mark.text, type: 'highlight' as const })
  const owed = sidecar.outboxUnconfirmedFor(1, 'ATT1')
  const shown = withKeptEdits(highlightsResult(mergeWithOutbox([inZotero('ANN1'), inZotero('ANN2')], owed)), keptEditKeys(owed))
  expect(shown.rows).toMatchObject([{ key: 'ANN1', colour: '#5fb236', comment: 'my note' }])
  expect(shown.rows[0]!.keptHere).toBeUndefined()

  const calls: EditCall[] = []
  const report = await drainOutbox(sidecar, editingTransport(calls))
  expect(report).toMatchObject({ attempted: 2, confirmed: 2, keptLocal: 0, rejected: 0 })
  expect(calls).toEqual([
    { color: '#5fb236', comment: 'my note', key: 'ANN1', kind: 'update', parentAttachmentKey: 'ATT1' },
    { key: 'ANN2', kind: 'delete', parentAttachmentKey: 'ATT1' },
  ])
  expect(sidecar.countOutboxWaiting()).toBe(0)
  expect(sidecar.outboxUnconfirmed()).toEqual([])
  sidecar.close()
})

test('a change the plugin declines is listed as refused with its reason, never silently kept', async () => {
  const sidecar = store()
  enqueue(sidecar, 'delete', { ...mark, key: 'AREA1', type: 'image' }, 'ATT1', shownMark)
  const report = await drainOutbox(sidecar, editingTransport([], {
    kind: 'rejected',
    reason: 'Deleting a marked region or a drawing is not written to Zotero yet. Delete it in Zotero itself.',
  }))
  expect(report).toMatchObject({ attempted: 1, rejected: 1 })
  expect(sidecar.countOutboxRejected()).toBe(1)
  expect(refusedHighlights(sidecar, () => null)).toMatchObject([{
    reason: 'Deleting a marked region or a drawing is not written to Zotero yet. Delete it in Zotero itself.',
    retryable: true,
  }])
  sidecar.close()
})

test('releasing kept edits is idempotent, keeps their order, and touches only kept PDF edits', () => {
  const sidecar = store()
  // Both marks were created here, so what the reader had before each kept change is recoverable.
  for (const key of ['ANN1', 'ANN2']) sidecar.markOutboxConfirmed(enqueue(sidecar, 'create', { ...mark, key }).id)
  const keptUpdate = enqueue(sidecar, 'update', { ...mark, comment: 'my note' })
  sidecar.markOutboxLocalOnly(keptUpdate.id, UNSUPPORTED_ZOTERO_EDIT_REASON)
  const failedLegacyDelete = enqueue(sidecar, 'delete', { ...mark, key: 'ANN2' })
  sidecar.markOutboxFailed(failedLegacyDelete.id, UNSUPPORTED_ZOTERO_EDIT_REASON, false)

  // Everything below must be left exactly as it is.
  const otherReason = enqueue(sidecar, 'update', { ...mark, key: 'ANN4' })
  sidecar.markOutboxFailed(otherReason.id, 'Zotero rejected this operation.', false)
  const insertWithSentence = enqueue(sidecar, 'create', { ...mark, key: 'ANN6' })
  sidecar.markOutboxFailed(insertWithSentence.id, UNSUPPORTED_ZOTERO_EDIT_REASON, false)
  const webEdit = enqueue(sidecar, 'update', { ...mark, key: 'WEB1', position: '{"type":"FragmentSelector","value":"epubcfi(/6/4)"}' })
  sidecar.markOutboxLocalOnly(webEdit.id, UNSUPPORTED_ZOTERO_EDIT_REASON)
  const webKept = enqueue(sidecar, 'update', { ...mark, key: 'WEB2' })
  sidecar.markOutboxLocalOnly(webKept.id, 'Marks on web pages and EPUBs stay here for now')
  const refusedAreaQuotation = sidecar.enqueueOutbox({ itemKey: 'AREA2', libraryId: 1, operation: 'update',
    parentItemKey: 'ATT1', payload: JSON.stringify(areaQuotationPayload(
      annotationPayload({ ...mark, key: 'AREA2', type: 'image' }, 'ATT1'), 'AREA2', 'Quoted in: Piece')) })
  sidecar.markOutboxFailed(refusedAreaQuotation.id, UNSUPPORTED_ZOTERO_EDIT_REASON, false)
  const unreadable = sidecar.enqueueOutbox({ itemKey: 'BROKEN1', libraryId: 1, operation: 'update',
    parentItemKey: 'ATT1', payload: '{not json' })
  sidecar.markOutboxFailed(unreadable.id, UNSUPPORTED_ZOTERO_EDIT_REASON, false)
  const untouched = [otherReason, insertWithSentence, webEdit, webKept, refusedAreaQuotation, unreadable]
    .map((entry) => entry.id)
  const later = enqueue(sidecar, 'create', { ...mark, key: 'ANN9' })

  const before = snapshot(sidecar)
  expect(releaseKeptEdits(sidecar)).toBe(2)
  const after = snapshot(sidecar)
  for (const id of untouched) expect(after[id]).toEqual(before[id])
  for (const entry of [keptUpdate, failedLegacyDelete]) {
    const released = after[entry.id] as { payload: string }
    expect(after[entry.id]).toEqual({ ...(before[entry.id] as object), lastError: null, localOnly: 0, payload: released.payload, status: 'pending' })
    // The payload is the kept change plus the recovered baseline: the mark as this app created it, with its kind.
    expect(JSON.parse(released.payload)).toEqual({ ...JSON.parse(entry.payload), readflexBaseline: { ...shownMark, type: 'highlight' } })
  }
  // Released in their original place, ahead of what was queued after them.
  expect(sidecar.outboxDue().map((entry) => entry.id)).toEqual([keptUpdate.id, failedLegacyDelete.id, later.id])
  expect(releaseKeptEdits(sidecar)).toBe(0)
  expect(snapshot(sidecar)).toEqual(after)
  sidecar.close()
})

test('a row stored with the old ReadFlex sentence is released too', () => {
  const sidecar = store()
  const oldSentence = 'Editing a highlight in Zotero itself is not something ReadFlex does yet, so this change is kept here.'
  expect(LEGACY_UNSUPPORTED_ZOTERO_EDIT_REASONS).toContain(oldSentence)
  sidecar.markOutboxConfirmed(enqueue(sidecar, 'create').id)
  const row = enqueue(sidecar, 'update', { ...mark, comment: 'my note' })
  sidecar.markOutboxLocalOnly(row.id, oldSentence)
  expect(releaseKeptEdits(sidecar)).toBe(1)
  expect(snapshot(sidecar)[row.id]).toMatchObject({ lastError: null, localOnly: 0, status: 'pending' })
  expect(sidecar.countOutboxWaiting()).toBe(1)
  sidecar.close()
})

test('a genuine refusal still counts and is listed with its paper, words, reason and date', async () => {
  const sidecar = store()
  enqueue(sidecar, 'create', mark, 'ATT1')
  enqueue(sidecar, 'create', { ...mark, key: 'ANN2', text: null, comment: 'x '.repeat(200) }, 'ATT2')
  const report = await drainOutbox(sidecar, async () => ({
    kind: 'rejected',
    reason: 'The document this highlight belongs to is no longer in Zotero, so the highlight was not written.',
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

  expect(releaseKeptEdits(sidecar)).toBe(0)
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

test('dismiss removes a refusal from the count and keeps the highlight; retry requeues a refused write', () => {
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
