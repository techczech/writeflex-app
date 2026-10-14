import { expect, test } from 'bun:test'
import { QUERY_SORTABLE_FIELDS, formatQueryDate, queryStatusBadgeClass, rewriteQuerySortLine } from '../../src/renderer/src/editor/query-object'

test('query status badges follow the canonical pipeline palette and fail neutral', () => {
  expect(queryStatusBadgeClass('idea')).toBe('idea')
  expect(queryStatusBadgeClass('note gathering')).toBe('note')
  expect(queryStatusBadgeClass('in progress')).toBe('prog')
  expect(queryStatusBadgeClass('editing')).toBe('edit')
  expect(queryStatusBadgeClass('ready')).toBe('ready')
  expect(queryStatusBadgeClass('published')).toBe('pub')
  expect(queryStatusBadgeClass('waiting')).toBe('neutral')
  expect(queryStatusBadgeClass(null)).toBe('neutral')
})

test('query dates render as compact British dates and preserve unknown values', () => {
  expect(formatQueryDate('2024-04-17')).toBe('17 Apr 2024')
  expect(formatQueryDate('not-a-date')).toBe('not-a-date')
  expect(formatQueryDate(null)).toBe('—')
})

test('only engine-backed visible columns are sortable', () => {
  expect(QUERY_SORTABLE_FIELDS).toEqual(['title', 'status', 'date'])
})

test('Title, Status, and Date headers persist sort in source and toggle the active field', () => {
  expect(rewriteQuerySortLine('status: editing\nsort: date desc', 'date')).toBe('status: editing\nsort: date asc')
  expect(rewriteQuerySortLine('status: editing\nsort: title asc', 'date')).toBe('status: editing\nsort: date desc')
  expect(rewriteQuerySortLine('status: editing', 'title')).toBe('status: editing\nsort: title asc')
  expect(rewriteQuerySortLine('', 'status')).toBe('sort: status asc')
  expect(rewriteQuerySortLine('sort: status asc', 'status')).toBe('sort: status desc')
})
