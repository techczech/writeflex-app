import { test, expect } from 'bun:test'
import { clipboardPayload, CLIPBOARD_KIND_LABELS } from '../../src/main/clipboard'

const DOC = [
  '---',
  'title: Stage truth',
  'status: draft',
  '---',
  '',
  '# The River',
  '',
  '// a post-it that never leaves',
  'Prose with **bold**, a [link](https://example.com), a [[wikilink]] and a note[^1].',
  'Čeština — em-dash.',
  '',
  '[^1]: The note itself.',
  '',
].join('\n')

test('a rich copy writes RTF, HTML and plain text together', async () => {
  const { kind, payload } = await clipboardPayload(DOC, 'rich')
  expect(kind).toBe('rich')
  expect(Object.keys(payload).sort()).toEqual(['html', 'rtf', 'text'])
  expect(payload.rtf?.startsWith('{\\rtf1\\ansi')).toBe(true)
  expect(payload.html).toContain('<p style=')
  expect(payload.text).toContain('The River')
})

test('the three flavours of a rich copy are the same document', async () => {
  const { payload } = await clipboardPayload(DOC, 'rich')
  for (const flavour of [payload.text, payload.html ?? '', payload.rtf ?? '']) {
    // Frontmatter and comments never leave, in any flavour.
    expect(flavour).not.toContain('Stage truth')
    expect(flavour).not.toContain('post-it')
    // Wikilinks disappear into their label text, in any flavour.
    expect(flavour).not.toContain('[[')
    expect(flavour).toContain('wikilink')
  }
  expect(payload.html).toContain('The note itself.')
  expect(payload.rtf).toContain('The note itself.')
  expect(payload.text).toContain('The note itself.')
})

test('non-ASCII survives every flavour of a rich copy', async () => {
  const { payload } = await clipboardPayload('Čeština — příliš žluťoučký kůň.\n', 'rich')
  expect(payload.text).toContain('Čeština — příliš žluťoučký kůň.')
  expect(payload.html).toContain('Čeština — příliš žluťoučký kůň.')
  expect(payload.rtf).toContain('\\u268?')
  expect(payload.rtf).toContain('\\u8212?')
})

test('a Markdown copy is the document own bytes, minus what never leaves', async () => {
  const { payload } = await clipboardPayload(DOC, 'markdown')
  expect(Object.keys(payload)).toEqual(['text'])
  expect(payload.text).toContain('# The River')
  expect(payload.text).toContain('[link](https://example.com)')
  expect(payload.text).toContain('[^1]: The note itself.')
  expect(payload.text).not.toContain('status: draft')
  expect(payload.text).not.toContain('post-it')
  expect(payload.text).not.toContain('[[')
})

test('a plain copy is prose with the markup removed', async () => {
  const { payload } = await clipboardPayload(DOC, 'plain')
  expect(Object.keys(payload)).toEqual(['text'])
  expect(payload.text).toContain('The River')
  expect(payload.text).not.toContain('**')
  expect(payload.text).not.toContain('](https://example.com)')
  expect(payload.text).toContain('link')
})

test('a selection copies as a selection — the scope is whatever it is given', async () => {
  const { payload } = await clipboardPayload('a **bold** fragment', 'rich')
  expect(payload.text).toBe('a bold fragment\n')
  expect(payload.html).toContain('<strong>bold</strong>')
})

test('an unusable request is refused with a recovery action, not a silent write', async () => {
  await expect(clipboardPayload(undefined, 'rich')).rejects.toThrow(/try the command again/)
  await expect(clipboardPayload(42, 'rich')).rejects.toThrow(/try the command again/)
  await expect(clipboardPayload('text', 'fancy')).rejects.toThrow(/not a way of copying/)
  await expect(clipboardPayload('text', undefined)).rejects.toThrow(/not a way of copying/)
})

test('an empty document never empties the clipboard', async () => {
  await expect(clipboardPayload('', 'plain')).rejects.toThrow(/nothing to copy/)
  await expect(clipboardPayload('   \n\n', 'markdown')).rejects.toThrow(/nothing to copy/)
  await expect(clipboardPayload('---\ntitle: only frontmatter\n---\n', 'plain')).rejects.toThrow(/nothing to copy/)
})

test('the flavour names the writer reads back are British and human', () => {
  expect(CLIPBOARD_KIND_LABELS).toEqual({ rich: 'rich text', markdown: 'Markdown', plain: 'plain text' })
})
