import { expect, test } from 'bun:test'
import { extractOutline } from '../../src/renderer/src/editor/outline'
import { countWords } from '../../src/renderer/src/editor/word-count'
import { statusBarTextForCount, type StatusBarSnapshotForCount } from '../../src/renderer/src/components/StatusBar'

const raw = '# Draft\n\nThe oldnew draft.\n'
const clean = '# Draft\n\nThe new draft.\n'

function snapshot(overrides: Partial<StatusBarSnapshotForCount> = {}): StatusBarSnapshotForCount {
  return {
    docText: raw,
    countText: clean,
    outline: extractOutline(raw),
    selHead: 3,
    selFrom: 0,
    selTo: 0,
    selEmpty: true,
    ...overrides,
  }
}

test('whole-document status count uses clean review text, not the raw marked buffer', () => {
  const scoped = statusBarTextForCount(snapshot())
  expect(scoped).toBe(clean)
  expect(countWords(scoped, { excludeCommentLines: true })).toBe(4)
})

test('selection count and outline offsets stay indexed against the raw buffer', () => {
  const selected = statusBarTextForCount(snapshot({
    selEmpty: false,
    selFrom: raw.indexOf('oldnew'),
    selTo: raw.indexOf('oldnew') + 'oldnew'.length,
  }))
  expect(selected).toBe('oldnew')
  expect(snapshot().outline[0].from).toBe(0)
  expect(snapshot().docText.slice(snapshot().outline[0].from, snapshot().outline[0].from + '# Draft'.length)).toBe('# Draft')
})
