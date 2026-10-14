import { expect, test } from 'bun:test'
import { parseQuery } from '../../src/main/query-engine'
import { projectionQuerySource, serialiseQueryValues } from '../../src/shared/query-source'

test('Rail and Board groups produce portable status/folder source that round-trips through the parser', () => {
  const source = projectionQuerySource({ dir: 'essays/long-form', status: 'editing' })
  expect(source).toBe('folder: essays/long-form\nstatus: editing')
  expect(parseQuery(source)).toEqual({
    ok: true,
    query: {
      folder: 'essays/long-form',
      status: ['editing'],
    },
  })
})

test('workspace-root and Unsorted projection sources stay exact and parser-valid', () => {
  const source = projectionQuerySource({ dir: '', status: 'Unsorted' })
  expect(source).toBe('status: Unsorted')
  expect(parseQuery(source)).toMatchObject({ ok: true, query: { status: ['Unsorted'] } })
})

test('projection status values with commas and quotes serialise symmetrically', () => {
  const comma = projectionQuerySource({ dir: 'essays', status: 'needs, review' })
  expect(comma).toBe('folder: essays\nstatus: "needs, review"')
  expect(parseQuery(comma)).toMatchObject({ ok: true, query: { status: ['needs, review'] } })

  const quote = projectionQuerySource({ dir: 'essays', status: 'editor says "hold"' })
  expect(quote).toBe('folder: essays\nstatus: "editor says \\"hold\\""')
  expect(parseQuery(quote)).toMatchObject({ ok: true, query: { status: ['editor says "hold"'] } })

  const tags = `tags: ${serialiseQueryValues(['language, style', 'editor says "hold"'])}`
  expect(parseQuery(tags)).toMatchObject({ ok: true, query: { tags: ['language, style', 'editor says "hold"'] } })

  const project = `project: ${serialiseQueryValues(['book, one'])}`
  expect(project).toBe('project: "book, one"')
  expect(parseQuery(project)).toMatchObject({ ok: true, query: { project: ['book, one'] } })
})
