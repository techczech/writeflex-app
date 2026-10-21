import { describe, expect, test } from 'bun:test'
import { clipboardPayload } from '../../src/main/clipboard'

// The logic of tests/e2e/copy.spec.ts without Electron: the same document through the same payload builder
// the main process hands to Electron's clipboard.write. What the e2e added is the palette hop and the real
// system clipboard; the three flavours and what each must hold or leave out are decided here.
const DOC = `---
title: Stage truth
status: draft
---

# The River

// a post-it that must never leave

Prose with **bold**, a [link](https://example.com), a [[wikilink]] and a note[^1].
Čeština — em-dash included.

| Column | Another |
| --- | --- |
| cell | plain |

[^1]: The note itself.
`

describe('Copy as rich text', () => {
  test('RTF, HTML and plain text together, with nothing the writer must not share', async () => {
    const { kind, payload } = await clipboardPayload(DOC, 'rich')
    expect(kind).toBe('rich')
    expect(payload.text!.length).toBeGreaterThan(0)
    expect(payload.html!.length).toBeGreaterThan(0)
    expect(payload.rtf!.length).toBeGreaterThan(0)
    expect(payload.rtf!.startsWith('{\\rtf1')).toBe(true)
    for (const flavour of [payload.text, payload.html!, payload.rtf!]) {
      expect(flavour).not.toContain('[[') // the disappearing-wikilink law, in every flavour that leaves
      expect(flavour).not.toContain('Stage truth') // frontmatter is stage truth
      expect(flavour).not.toContain('post-it') // comments are annotation
      expect(flavour).toContain('The River')
    }
    expect(payload.html).toContain('<strong>bold</strong>')
    expect(payload.html).toContain('href="https://example.com"')
    expect(payload.html).toContain('<table')
    expect(payload.text).toContain('Čeština — em-dash included.')
    expect(payload.rtf).toContain('\\u268?')
    expect(payload.rtf).toContain('\\u8212?')
  })
})

describe('Copy as Markdown and Copy as plain text write one flavour each', () => {
  test('Markdown keeps the structure and drops frontmatter and wikilink brackets', async () => {
    const { payload } = await clipboardPayload(DOC, 'markdown')
    expect(Object.keys(payload)).toEqual(['text'])
    expect(payload.text).toContain('# The River')
    expect(payload.text).toContain('[link](https://example.com)')
    expect(payload.text).toContain('[^1]: The note itself.')
    expect(payload.text).not.toContain('[[')
    expect(payload.text).not.toContain('status: draft')
  })

  test('plain text loses the markup but keeps the words', async () => {
    const { payload } = await clipboardPayload(DOC, 'plain')
    expect(Object.keys(payload)).toEqual(['text'])
    expect(payload.text).toContain('The River')
    expect(payload.text).not.toContain('**')
    expect(payload.text).not.toContain('](https://example.com)')
    expect(payload.text).toContain('link')
  })
})

describe('the scope is whatever text the window hands over', () => {
  test('a selection of the heading line alone carries only that line', async () => {
    // The renderer decides the scope (selection when there is one, else the document) and says so in its
    // flash; main renders exactly the text it is given. That decision has no seam outside the window.
    const { payload } = await clipboardPayload('# The River', 'plain')
    expect(payload.text).toContain('The River')
    expect(payload.text).not.toContain('Čeština')
    expect(payload.text).not.toContain('bold')
  })
})
