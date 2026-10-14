import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import * as writerReview from '../../src/renderer/src/editor/writer-review'

type MaterialiseRecords = (
  records: writerReview.WriterPendingChange[],
  buffer: string,
) => {
  changes: Parameters<EditorState['update']>[0]['changes']
  marks: writerReview.WriterTrackedMark[]
}

const materialiseRecords = (writerReview as typeof writerReview & {
  materialiseRecords?: MaterialiseRecords
}).materialiseRecords

test('materialiseRecords recalls insert, delete, and replace over the as-of content with round-trip parity', () => {
  expect(typeof materialiseRecords).toBe('function')
  if (!materialiseRecords) return

  const asOfContent = 'A new bright tail.'
  const records: writerReview.WriterPendingChange[] = [
    {
      localId: 'replace',
      oldText: 'old',
      newText: 'new',
      anchor: { from: 2, to: 5 },
      createdAt: 1,
    },
    {
      localId: 'insert',
      oldText: '',
      newText: 'bright ',
      anchor: { from: 6, to: 13 },
      createdAt: 2,
    },
    {
      localId: 'delete',
      oldText: 'lost ',
      newText: '',
      anchor: { from: 13, to: 13 },
      createdAt: 3,
    },
  ]

  const materialised = materialiseRecords(records, asOfContent)
  const recalled = EditorState.create({ doc: asOfContent }).update({ changes: materialised.changes }).state.doc.toString()
  const pending = writerReview.pendingFromMarks(recalled, materialised.marks)

  expect(recalled).toBe('A oldnew bright lost tail.')
  expect(materialised.marks.map(({ id, role }) => ({ id, role }))).toEqual([
    { id: 'replace', role: 'old' },
    { id: 'replace', role: 'new' },
    { id: 'insert', role: 'new' },
    { id: 'delete', role: 'old' },
  ])
  expect(writerReview.deriveCleanWriterDocument(recalled, pending)).toBe(asOfContent)
})

test('materialiseRecords skips an unresolved record with a warning', () => {
  expect(typeof materialiseRecords).toBe('function')
  if (!materialiseRecords) return

  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  try {
    const result = materialiseRecords([
      {
        localId: 'drifted',
        oldText: 'old',
        newText: 'missing',
        anchor: { from: 0, to: 7 },
        createdAt: 1,
      },
    ], 'current')

    expect(result).toEqual({ changes: [], marks: [] })
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]?.[0])).toContain('drifted')
  } finally {
    console.warn = originalWarn
  }
})
