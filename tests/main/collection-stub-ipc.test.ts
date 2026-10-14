import { expect, test } from 'bun:test'
import { validateCollectionStubIpcInput } from '../../src/main/collection-stub-ipc'

test('the renderer Stub boundary rejects a non-string exact path', () => {
  expect(() => validateCollectionStubIpcInput({ dir: '', title: 'One', gist: '', path: 42 } as never)).toThrow(
    'Invalid Collection Stub path.',
  )
})

test('the renderer Stub boundary rejects a non-string role', () => {
  expect(() => validateCollectionStubIpcInput({ dir: '', title: 'One', gist: '', role: true } as never)).toThrow(
    'Invalid Collection Stub role.',
  )
})

test('the renderer Stub boundary rejects a non-string body lead', () => {
  expect(() => validateCollectionStubIpcInput({ dir: '', title: 'One', gist: '', bodyLead: [] } as never)).toThrow(
    'Invalid Collection Stub body lead.',
  )
})
