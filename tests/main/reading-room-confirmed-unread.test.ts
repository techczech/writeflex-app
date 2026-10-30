/**
 * A confirmed highlight stays painted until an authoritative read of Zotero that started after its
 * confirmation (ADR-0047). Authoritative: the plugin's signed read, or a bracketed file read while
 * Zotero is closed. An immutable read that may miss the write-ahead log retires nothing. Content is
 * never compared: what the read shows is Zotero's word, whatever anyone did there since.
 */
import { expect, test } from 'bun:test'
import type { OutboxEntry } from '@readflex/sidecar'
import { retireConfirmed } from '../../src/main/reading-room-highlights'

function row(id: number, operation: OutboxEntry['operation'], confirmedAt: number | null, payload: Record<string, unknown> = {}): OutboxEntry & { confirmedAt: number | null } {
  return {
    attemptCount: 1, confirmedAt, conflictPayload: null, createdAt: '', id, itemKey: 'MARKKEY2', lastError: null, libraryId: 1, localOnly: 0,
    operation, parentItemKey: 'PDFKEY22', payload: JSON.stringify(payload), status: 'confirmed', updatedAt: '',
  }
}

test('SOL D: A then B then C — a read that started between B and C retires B and keeps C painted', () => {
  // Comment A→B confirmed at 100, B→C confirmed at 200. The read started at 150: it may show B or
  // even A again (an edit in Zotero back to A); either way C must stay painted until a later read.
  const toB = row(1, 'update', 100, { comment: 'B', readflexBaseline: { comment: 'A' } })
  const toC = row(2, 'update', 200, { comment: 'C', readflexBaseline: { comment: 'B' } })
  expect(retireConfirmed([toB, toC], { authoritative: true, startedAt: 150 })).toEqual({ retired: [1], stillShown: [toC] })
  expect(retireConfirmed([toC], { authoritative: true, startedAt: 201 })).toEqual({ retired: [2], stillShown: [] })
})

test('a geometry-only edit is retired by time, with nothing to compare', () => {
  const moved = row(3, 'update', 100, { position: '{"pageIndex":0,"rects":[[9,9,9,9]]}', readflexBaseline: { position: '{"pageIndex":0,"rects":[[1,1,1,1]]}' } })
  expect(retireConfirmed([moved], { authoritative: true, startedAt: 99 }).stillShown).toEqual([moved])
  expect(retireConfirmed([moved], { authoritative: true, startedAt: 101 }).retired).toEqual([3])
})

test('a create deleted in Zotero afterwards is retired, not kept painted for ever', () => {
  // The read no longer holds the key; the old rule ("stay until the read holds the key") never let go.
  const create = row(4, 'create', 100)
  expect(retireConfirmed([create], { authoritative: true, startedAt: 500 })).toEqual({ retired: [4], stillShown: [] })
})

test('a read that started in the same millisecond as the confirmation does not retire it', () => {
  const create = row(5, 'create', 100)
  expect(retireConfirmed([create], { authoritative: true, startedAt: 100 }).stillShown).toEqual([create])
})

test('an immutable read that may miss the log retires and certifies nothing', () => {
  const create = row(6, 'create', 100)
  const remove = row(7, 'delete', 100)
  expect(retireConfirmed([create, remove], { authoritative: false, startedAt: 10_000 })).toEqual({ retired: [], stillShown: [create, remove] })
})

test('a row confirmed before the confirmation time was recorded is retired by any authoritative read', () => {
  const old = row(8, 'update', null)
  expect(retireConfirmed([old], { authoritative: true, startedAt: 0 }).retired).toEqual([8])
  expect(retireConfirmed([old], { authoritative: false, startedAt: 0 }).retired).toEqual([])
})
