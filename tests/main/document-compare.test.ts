import { expect, test } from 'bun:test'
import { compareVersionContents } from '../../src/engine'
import type { VersionCompareResult, WriteFlexApi } from '../../src/preload'
import { createDocumentCompare, documentCompareMarks } from '../../src/renderer/src/app/document-compare'
import { buildSideBySideCompareRows } from '../../src/renderer/src/components/compare-side-by-side'

type CompareInput = Parameters<WriteFlexApi['compareVersions']>[0]

function harness() {
  const reads: Array<{
    input: CompareInput
    response: ReturnType<typeof Promise.withResolvers<VersionCompareResult>>
  }> = []
  const delays: Array<{ run: () => void; cancelled: boolean }> = []
  const workingReads: string[] = []
  let working = 'The newest working text.\n'
  const compare = createDocumentCompare({
    compare(input) {
      const response = Promise.withResolvers<VersionCompareResult>()
      reads.push({ input, response })
      return response.promise
    },
    readWorking(path) {
      workingReads.push(path)
      return working
    },
    delay(run) {
      const delay = { run, cancelled: false }
      delays.push(delay)
      return () => { delay.cancelled = true }
    },
  })
  compare.observe('/writing', 'draft.md')

  function resolve(index: number, fromContent: string): Promise<VersionCompareResult> {
    const { input, response } = reads[index]
    const { path, fromId, toId, currentContent = '' } = input
    const result = compareVersionContents({
      versions: [...new Set([fromId, toId])].filter(id => id !== 'working').map(id => ({
        id, name: id, ts: 1, path, author: { name: 'Writer' },
      })),
      changes: [], path, fromId, toId,
      fromContent: fromId === 'working' ? currentContent : fromContent,
      toContent: toId === 'working' ? currentContent : 'Saved destination.\n',
    })
    response.resolve(result)
    return response.promise
  }

  function columns() {
    const rows = buildSideBySideCompareRows(compare.getSnapshot()?.result ?? null)
    return rows.flatMap(row => row.left.map(part => part.text)).join('')
  }

  function markedText() {
    return documentCompareMarks(compare.getSnapshot(), working).marks.map(mark => working.slice(mark.from, mark.to))
  }

  return { compare, reads, workingReads, delays, resolve, columns, markedText, type: (text: string) => { working = text } }
}

test('an older comparison of the same document cannot replace the selected result', async () => {
  const { compare, reads, resolve, columns, markedText } = harness()
  const first = compare.open('older', 'working')
  const second = compare.setFrom('newer')
  expect(reads.map(({ input }) => input.fromId)).toEqual(['older', 'newer'])
  expect(compare.getSnapshot()).toMatchObject({ result: null, loading: true, error: '' })

  const latestResult = await resolve(1, 'The working text.\n')
  await second
  const accepted = compare.getSnapshot()
  expect(accepted).toMatchObject({ result: latestResult, loading: false, error: '' })
  expect(columns()).toBe('The working text.\n')
  expect(markedText()).toEqual(['newest '])

  await resolve(0, 'Entirely different.\n')
  await first
  expect(compare.getSnapshot()).toBe(accepted)
  expect(columns()).toBe('The working text.\n')
  expect(markedText()).toEqual(['newest '])
})

test('a stale rejection and completion cannot end loading or replace the current error', async () => {
  const { compare, reads } = harness()
  const first = compare.open('first', 'working')
  const second = compare.setFrom('second')
  const third = compare.setFrom('third')
  const pending = compare.getSnapshot()

  reads[1].response.reject(new Error('Second read failed'))
  await second
  expect(compare.getSnapshot()).toBe(pending)
  expect(compare.getSnapshot()).toMatchObject({ loading: true, error: '' })

  reads[2].response.reject(new Error('Selected version unavailable'))
  await third
  const failed = compare.getSnapshot()
  expect(failed).toMatchObject({ result: null, loading: false, error: 'Selected version unavailable' })
  reads[0].response.reject(new Error('First read failed'))
  await first
  expect(compare.getSnapshot()).toBe(failed)
})

test('reopening the same comparison does not admit a response from the closed session', async () => {
  const { compare, resolve, columns, markedText } = harness()
  const first = compare.open('saved', 'working')
  compare.close()
  expect(compare.getSnapshot()).toBeNull()
  expect(markedText()).toEqual([])

  const reopened = compare.open('saved', 'working')
  await resolve(1, 'The working text.\n')
  await reopened
  const accepted = compare.getSnapshot()

  await resolve(0, 'From the closed pane.\n')
  await first
  expect(compare.getSnapshot()).toBe(accepted)
  expect(columns()).toBe('The working text.\n')
  expect(markedText()).toEqual(['newest '])
})

test.each([
  ['another tab', '/writing', 'notes.md'],
  ['another workspace with the same path', '/elsewhere', 'draft.md'],
])('going to %s and back retires the requests from the first visit', async (_label, workspace, path) => {
  const { compare, reads, resolve, columns, markedText } = harness()
  const first = compare.open('saved', 'working')
  compare.observe(workspace, path)
  expect(compare.getSnapshot()).toBeNull()
  expect(reads).toHaveLength(1)

  compare.observe('/writing', 'draft.md')
  expect(compare.getSnapshot()).toBeNull()
  const second = compare.open('saved', 'working')
  const pending = compare.getSnapshot()
  await resolve(0, 'From the first visit.\n')
  await first
  expect(compare.getSnapshot()).toBe(pending)
  expect(columns()).toBe('')
  expect(markedText()).toEqual([])

  await resolve(1, 'The working text.\n')
  await second
  expect(columns()).toBe('The working text.\n')
  expect(markedText()).toEqual(['newest '])
})

test('swapping starts one immediate read and cancels the pending Working refresh', async () => {
  const { compare, reads, delays, resolve, type, markedText } = harness()
  const first = compare.open('saved', 'working')
  type('Typing before swapping.\n')
  compare.queueWorkingRefresh('draft.md')
  expect(reads).toHaveLength(1)

  const swapped = compare.swap()
  expect(delays[0].cancelled).toBe(true)
  expect(reads).toHaveLength(2)
  expect(reads[1].input).toEqual({
    path: 'draft.md', fromId: 'working', toId: 'saved', currentContent: 'Typing before swapping.\n',
  })
  delays[0].run()
  expect(reads).toHaveLength(2)

  await resolve(1, 'Unused saved From.\n')
  await swapped
  const accepted = compare.getSnapshot()
  await resolve(0, 'Saved text.\n')
  await first
  expect(compare.getSnapshot()).toBe(accepted)
  expect(accepted?.result?.fromContent).toBe('Typing before swapping.\n')
  expect(markedText()).toEqual([])
})

test('a Working edit invalidates the in-flight diff and captures the latest text once after the pause', async () => {
  const { compare, reads, delays, workingReads, resolve, type, columns, markedText } = harness()
  const first = compare.open('saved', 'working')
  type('The newer working text.\n')
  compare.queueWorkingRefresh('draft.md')
  type('The final working text.\n')
  compare.queueWorkingRefresh('draft.md')
  expect(delays[0].cancelled).toBe(true)
  delays[0].run()
  expect(workingReads).toEqual(['draft.md'])

  await resolve(0, 'The working text.\n')
  await first
  expect(compare.getSnapshot()).toMatchObject({ result: null, loading: true, error: '' })
  expect(columns()).toBe('')
  expect(markedText()).toEqual([])

  delays[1].run()
  expect(workingReads).toEqual(['draft.md', 'draft.md'])
  expect(reads[1].input).toMatchObject({ fromId: 'saved', toId: 'working', currentContent: 'The final working text.\n' })
  await resolve(1, 'The working text.\n')
  expect(compare.getSnapshot()).toMatchObject({ loading: false, error: '' })
  expect(columns()).toBe('The working text.\n')
  expect(markedText()).toEqual(['final '])
})
