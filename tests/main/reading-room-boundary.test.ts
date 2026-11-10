import { expect, test } from 'bun:test'
import { decideFrameNavigation } from '../../src/main/navigation'

test('a restricted reader cannot navigate to an ambient external resource', () => {
  expect(decideFrameNavigation({ isMainFrame: false, isSameDocument: false,
    initiator: 'other', frameOpaque: false, readerOrigin: 'wf-reader://reader-test',
    url: 'https://example.invalid/synthetic' })).toBe('refuse')
})

test('a restricted reader keeps its exact same-origin viewer navigation', () => {
  expect(decideFrameNavigation({ isMainFrame: false, isSameDocument: false,
    initiator: 'other', frameOpaque: false, readerOrigin: 'wf-reader://reader-test',
    url: 'wf-reader://reader-test/reader/pdf/web/viewer.html' })).toBe('continue')
})
