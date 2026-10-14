import { test, expect } from 'bun:test'
import { fixedLineMargin } from '../../src/renderer/src/editor/fixed-line'
import { typewriterExtension } from '../../src/renderer/src/editor/typewriter'

// Typewriter mode no longer captures the caret's engage-time offset: it holds the line at the shared
// fixed line (fixed-line.ts), the same position read-aloud uses. The pure maths is covered in
// fixed-line.test.ts; the laid-out behaviour (line top within 4px of the chosen height, in both
// modes) is in tests/e2e/fixed-line.spec.ts.

test('every typewriter engage builds a distinct instance (the stale-frame identity check relies on it)', () => {
  expect(typewriterExtension()).not.toBe(typewriterExtension())
})

test('the typewriter scroll margin for a 600px editor at each preset', () => {
  expect(fixedLineMargin(0.33, 600)).toBe(198)
  expect(fixedLineMargin(0.5, 600)).toBe(300)
  expect(fixedLineMargin(0.67, 600)).toBe(402)
})
