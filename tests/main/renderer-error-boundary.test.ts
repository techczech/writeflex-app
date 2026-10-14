import { expect, test } from 'bun:test'
import { errorParts } from '../../src/renderer/src/app/RendererErrorBoundary'

test('renderer error copy exposes a useful message without requiring a stack', () => {
  expect(errorParts(new Error('metadata editor crashed')).message).toBe('metadata editor crashed')
  expect(errorParts('promise failed')).toEqual({ message: 'promise failed', stack: '' })
  expect(errorParts({ reason: 'opaque' })).toEqual({ message: 'Unknown renderer error', stack: '' })
})
