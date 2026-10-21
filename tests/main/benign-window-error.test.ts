import { expect, test } from 'bun:test'
import { isBenignWindowError } from '../../src/renderer/src/benign-window-error'

test('ignores exactly the undelivered-notifications message', () => {
  expect(isBenignWindowError('ResizeObserver loop completed with undelivered notifications.')).toBe(true)
})

test('everything else still counts as a real error', () => {
  expect(isBenignWindowError('ResizeObserver loop limit exceeded')).toBe(false)
  expect(isBenignWindowError('ResizeObserver loop completed with undelivered notifications. Also more')).toBe(false)
  expect(isBenignWindowError('Uncaught TypeError: x is undefined')).toBe(false)
  expect(isBenignWindowError(new Error('boom'))).toBe(false)
  expect(isBenignWindowError(undefined)).toBe(false)
})
