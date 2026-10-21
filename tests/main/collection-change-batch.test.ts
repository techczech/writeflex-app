import { expect, test } from 'bun:test'
import { CollectionChangeBatches } from '../../src/main/collection-change-batch'

test('a batch collapses all file changes and duplicate watcher notices into one refresh', () => {
  const batches = new CollectionChangeBatches<object>()
  const state = {}
  const otherWindow = {}
  let disposed = 0
  batches.begin(state, () => { disposed += 1 })
  expect(() => batches.begin(state)).toThrow('still running')
  for (let n = 0; n < 10; n++) expect(batches.collect(state, [`file-${n}.md`])).toBe(true)
  expect(batches.collect(state, ['file-0.md'])).toBe(true)
  expect(batches.collect(otherWindow, ['other.md'])).toBe(false)
  expect(batches.finish(state)).toEqual(Array.from({ length: 10 }, (_, n) => `file-${n}.md`))
  expect(disposed).toBe(1)
  expect(batches.finish(state)).toBeNull()
  expect(batches.collect(state, ['later.md'])).toBe(false)
})
