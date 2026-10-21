// The piece as published (src/main/sharing-render.ts; sharing ticket 03 review round 1, findings 2
// and 3): every published field comes from the same cleaned reading of the file, so a hidden comment
// reaches no field (the title included), a widget line publishes no path, and a link to a local file
// keeps its words but loses its destination.
import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { renderPieceForSharing } from '../../src/main/sharing-render.ts'

async function rendered(text: string, path = 'drafts/piece.md') {
  const root = mkdtempSync(join(tmpdir(), 'writeflex-share-render-'))
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
  const piece = await renderPieceForSharing(root, path, '/s/abcdefgh1234/images/')
  return { piece, all: JSON.stringify({ title: piece.title, chips: piece.chips, headings: piece.headings, html: piece.html }) }
}

test('a comment hidden in the heading is not in the title', async () => {
  const { piece, all } = await rendered('# Public <!-- PRIVATE_TITLE_CANARY -->\n\nText.\n')
  expect(piece.title).toBe('Public')
  expect(all).not.toContain('PRIVATE_TITLE_CANARY')
})

test('a heading inside a hidden comment is never the title, and the real heading is still the title', async () => {
  const { piece, all } = await rendered('<!--\n# SECRET_HEADING_CANARY\n-->\n\n# Public\n\nText.\n')
  expect(piece.title).toBe('Public')
  expect(all).not.toContain('SECRET_HEADING_CANARY')
  // The piece's own heading is the title, not repeated in the text.
  expect(piece.html).not.toContain('>Public<')
})

test('a post-it comment line is in no field', async () => {
  const { piece, all } = await rendered('// # POSTIT_CANARY\n# Public\n\n// POSTIT_BODY_CANARY\nText.\n')
  expect(piece.title).toBe('Public')
  expect(all).not.toContain('POSTIT_')
})

test('a widget line publishes no path', async () => {
  const { piece } = await rendered('# W\n\nBefore.\n\n[Simulation: private-folder/secret-widget.html]\n\n[Embed: https://example.com/x]\n\nAfter.\n')
  expect(piece.html).not.toContain('private-folder')
  expect(piece.html).not.toContain('secret-widget')
  expect(piece.html).not.toContain('Simulation:')
  expect(piece.html).not.toContain('example.com/x')
  expect(piece.html).toContain('Interactive part not shared')
  expect(piece.html).toContain('Before.')
  expect(piece.html).toContain('After.')
})

test('a link to a local file keeps its words and loses its destination; a web link stays a link', async () => {
  const { piece } = await rendered([
    '# L',
    '',
    'See [the draft](drafts/private-piece.md), [the notes](../notes/secret.md), [a section](#later),',
    '[a folder](./folder/), [home](/tmp/example-author/x.md), [the web](https://example.com/page) and [mail](mailto:a@example.com).',
    '',
    'Also [ref link][r].',
    '',
    '[r]: private/ref-target.md',
    '',
  ].join('\n'))
  for (const leak of ['private-piece', 'secret.md', '../notes', './folder', '/tmp/example-author', 'ref-target']) expect([leak, piece.html.includes(leak)]).toEqual([leak, false])
  for (const words of ['the draft', 'the notes', 'a folder', 'home', 'ref link']) expect(piece.html).toContain(words)
  expect(piece.html).toContain('href="https://example.com/page"')
  expect(piece.html).toContain('href="mailto:a@example.com"')
  expect(piece.html).not.toMatch(/href="(?!https:|mailto:)/)
})

// Review round 2, finding 1: a byte-order mark before a hidden comment, with no frontmatter, hid the
// comment from the comment stripper (adviser ruling, round 3, item 1).
for (const [what, text] of [
  ['an HTML comment', '﻿<!--\n# SECRET\n-->\n\n# Public\n'],
  ['a post-it line', '﻿// SECRET\n# Public\n'],
] as const) {
  test(`a byte-order mark before ${what}: the comment is in no field, and the real heading is the title`, async () => {
    const { piece } = await rendered(text)
    expect(piece.title).toBe('Public')
    expect(piece.html).not.toContain('SECRET')
    expect(JSON.stringify(piece.headings)).not.toContain('SECRET')
    expect(JSON.stringify(piece.chips)).not.toContain('SECRET')
    expect(piece.html).not.toContain('﻿')
  })
}
