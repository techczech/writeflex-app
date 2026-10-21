import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CollectionActionSheet, collectionSheetKeyDown, NO_MOVE_DESTINATION } from '../../src/renderer/src/components/CollectionActionSheet'
import { CollectionSnippet } from '../../src/renderer/src/components/CollectionView'
import { collectionPageMenuCommand } from '../../src/renderer/src/components/collection-page-commands'

const props = { value: NO_MOVE_DESTINATION, folders: ['', 'writing', 'writing/drafts'], folioName: 'Writing', busy: false, error: '', onChange: () => {}, onClose: () => {}, onSubmit: () => {} }
test('move starts without a destination and keeps Apply disabled until a folder is chosen', () => {
  const html = renderToStaticMarkup(<CollectionActionSheet {...props} sheet="move" />)
  expect(html).toContain('<select')
  expect(html).toContain('value="writing/drafts"')
  expect(html).toContain('Choose a folder')
  expect(html).not.toContain('<input')
  expect(html).toContain('disabled')
})
test('Folio add names the current Folio without accepting another folder', () => {
  const html = renderToStaticMarkup(<CollectionActionSheet {...props} sheet="folio" />)
  expect(html).toContain('Writing')
  expect(html).not.toContain('<input')
  expect(html).not.toContain('<select')
})
test('snippet highlights literal regex punctuation and escapes HTML as React text', () => {
  const html = renderToStaticMarkup(<CollectionSnippet text={'Use [.* and <script> words.'} query="[.*" />)
  expect(html).toContain('<mark>[.*</mark>')
  expect(html).toContain('&lt;script&gt;')
  expect(renderToStaticMarkup(<CollectionSnippet text="Words" query="" />)).toContain('Words')
})
test('only real collection menu actions dispatch', () => {
  expect(collectionPageMenuCommand('collection-page:bulk-move')).toBe('bulk-move')
  expect(collectionPageMenuCommand('collection-page:invented')).toBeNull()
  expect(collectionPageMenuCommand('new-file')).toBeNull()
})

test('Escape closes and Tab stays inside the bulk sheet in both directions', () => {
  let closed = 0
  let focused = ''
  let prevented = 0
  let stopped = 0
  const first = { focus: () => { focused = 'first' } }
  const last = { focus: () => { focused = 'last' } }
  const dialog = { querySelectorAll: () => [first, last], focus: () => { focused = 'dialog' } }
  const event = (key: string, shiftKey = false) => ({ key, shiftKey, preventDefault: () => { prevented++ }, stopPropagation: () => { stopped++ } })
  collectionSheetKeyDown(event('Tab'), dialog as never, last as never, () => { closed++ })
  expect(focused).toBe('first')
  collectionSheetKeyDown(event('Tab', true), dialog as never, first as never, () => { closed++ })
  expect(focused).toBe('last')
  collectionSheetKeyDown(event('Escape'), dialog as never, first as never, () => { closed++ })
  expect(closed).toBe(1)
  expect(prevented).toBe(3)
  expect(stopped).toBe(1)
})

test('a busy sheet disables Cancel and consumes Escape without closing', () => {
  const html = renderToStaticMarkup(<CollectionActionSheet {...props} sheet="status" busy error="Still visible" />)
  expect(html).toContain('disabled="">Cancel')
  expect(html).toContain('Still visible')
  let closed = false
  collectionSheetKeyDown({ key: 'Escape', shiftKey: false, preventDefault() {}, stopPropagation() {} }, {} as never, null, () => { closed = true }, true)
  expect(closed).toBe(false)
})

test('choosing the workspace root explicitly enables Apply', () => {
  const html = renderToStaticMarkup(<CollectionActionSheet {...props} sheet="move" value="" />)
  expect(html).toContain('value="" selected')
  expect(html).not.toContain('type="submit" disabled')
})
