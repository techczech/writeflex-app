import { describe, expect, test } from 'bun:test'
import { EDGE_ZONE_PX, MAX_SPEED_PX, REDUCED_SPEED_PX, edgeScrollSpeed } from '../../src/renderer/src/components/useDragAutoScroll'

describe('edgeScrollSpeed', () => {
  test('is zero in the middle and outside the row', () => {
    expect(edgeScrollSpeed(500, 0, 1000)).toBe(0)
    expect(edgeScrollSpeed(EDGE_ZONE_PX, 0, 1000)).toBe(0)
    expect(edgeScrollSpeed(-5, 0, 1000)).toBe(0)
    expect(edgeScrollSpeed(1005, 0, 1000)).toBe(0)
  })
  test('scrolls left near the left edge and right near the right edge', () => {
    expect(edgeScrollSpeed(10, 0, 1000)).toBeLessThan(0)
    expect(edgeScrollSpeed(990, 0, 1000)).toBeGreaterThan(0)
  })
  test('is fastest at the edge, up to the maximum, and slower further in', () => {
    expect(edgeScrollSpeed(1000, 0, 1000)).toBe(MAX_SPEED_PX)
    expect(edgeScrollSpeed(0, 0, 1000)).toBe(-MAX_SPEED_PX)
    const near = edgeScrollSpeed(1000 - 10, 0, 1000)
    const far = edgeScrollSpeed(1000 - 40, 0, 1000)
    expect(near).toBeGreaterThan(far)
    expect(far).toBeGreaterThanOrEqual(1)
  })
  test('offsets the row by its own left edge', () => {
    expect(edgeScrollSpeed(300 + 5, 300, 1300)).toBe(-edgeScrollSpeed(1300 - 5, 300, 1300))
  })
  test('reduced motion uses one constant slow speed', () => {
    expect(edgeScrollSpeed(1, 0, 1000, true)).toBe(-REDUCED_SPEED_PX)
    expect(edgeScrollSpeed(999, 0, 1000, true)).toBe(REDUCED_SPEED_PX)
    expect(edgeScrollSpeed(500, 0, 1000, true)).toBe(0)
  })
  test('a very narrow row never has overlapping zones', () => {
    expect(edgeScrollSpeed(30, 0, 60)).toBeLessThanOrEqual(0)
  })
})
