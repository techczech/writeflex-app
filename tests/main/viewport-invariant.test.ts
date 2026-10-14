import { expect, test } from 'bun:test'
import { preserveViewportPosition, shouldScrollForSelectedRevision } from '../../src/renderer/src/editor/viewport-invariant'

test('only a newly selected visible revision may request a scroll', () => {
  expect(shouldScrollForSelectedRevision(null, 'change-1', true)).toBe(true)
  expect(shouldScrollForSelectedRevision('change-1', 'change-1', true)).toBe(false)
  expect(shouldScrollForSelectedRevision(null, 'change-1', false)).toBe(false)
  expect(shouldScrollForSelectedRevision('change-1', null, true)).toBe(false)
})

test('resolving a change restores the viewport synchronously and after editor measurement', () => {
  const scroller = { scrollTop: 480 }
  let measuredRestore: (() => void) | null = null

  preserveViewportPosition(
    scroller,
    () => { scroller.scrollTop = 20 },
    (restore) => { measuredRestore = restore },
  )

  expect(scroller.scrollTop).toBe(480)
  scroller.scrollTop = 0
  measuredRestore?.()
  expect(scroller.scrollTop).toBe(480)
})
