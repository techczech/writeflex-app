import { describe, expect, test } from 'bun:test'
import { humanModelError } from '../../src/main/agent'

// usability review regression (2026-07-03): provider errors were swallowed into empty replies.
describe('humanModelError', () => {
  test('carries trimmed provider detail', () => {
    const msg = humanModelError('Codex error: [tools[0].name] invalid_string')
    expect(msg).toContain('The model request failed')
    expect(msg).toContain('invalid_string')
  })
  test('bounds unbounded provider text', () => {
    expect(humanModelError('x'.repeat(1000)).length).toBeLessThan(300)
  })
  test('copes with missing detail', () => {
    expect(humanModelError(undefined)).toContain('no detail from the provider')
  })
})
