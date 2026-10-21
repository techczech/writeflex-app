import { expect, test } from 'bun:test'
import { metadataCollapsed, rememberMetadataCollapsed } from '../../src/renderer/src/editor/metadata-view-state'

test('collapse state persists per workspace and handles unavailable storage', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  expect(metadataCollapsed('one', storage)).toBe(false)
  rememberMetadataCollapsed('one', true, storage)
  expect(metadataCollapsed('one', storage)).toBe(true)
  expect(metadataCollapsed('two', storage)).toBe(false)
  rememberMetadataCollapsed('one', false, storage)
  expect(metadataCollapsed('one', storage)).toBe(false)
  expect(metadataCollapsed('one', { getItem: () => { throw Error() } })).toBe(false)
})


test('Show metadata expands the panel without editing or creating a block', async () => {
  const source = await Bun.file(new URL('../../src/renderer/src/app/App.tsx', import.meta.url)).text()
  const body = /id: 'metadata.show'[^\n]+run: \(\) => \{([^}]+)\}/.exec(source)![1]
  const actions: unknown[] = []
  const editorRef = { current: { setMetadataCollapsed: (value: boolean) => actions.push(value), editMetadata: () => actions.push('write') } }
  new Function('editorRef', body)(editorRef)
  expect(actions).toEqual([false])
})
