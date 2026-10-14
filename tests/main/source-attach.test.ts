import { expect, test } from 'bun:test'
import { appendSourceLine, planSourceAttach, sourceEntryFor, SourceAttachRefusal, yamlItem } from '../../src/main/source-attach'
import { parseFrontmatter } from '../../src/main/frontmatter'

// Scraps ticket 03, locked design frame 4: attaching a source adds ONE line to the piece's
// frontmatter `sources:` list (creating the key if absent); every other byte stays as it was.

const ENTRY = 'research/schank-abelson-scripts.md'
const body = '# Tools of reason\n\nWe reason with tools.\n'

/** The lines `after` has that `before` does not, when `before`'s lines all survive in order. */
function addedLines(before: string, after: string): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const added: string[] = []
  let i = 0
  for (const line of b) {
    if (i < a.length && line === a[i]) i += 1
    else added.push(line)
  }
  expect(i).toBe(a.length)
  return added
}

test('a block list gains exactly one item after its last, in its own indent', () => {
  const before = `---\ntitle: Tools of reason\nsources:\n  - research/bartlett-remembering.md\n  - research/kahneman-notes.md\nstatus: editing\n---\n${body}`
  const after = appendSourceLine(before, ENTRY)
  expect(after).toBe(`---\ntitle: Tools of reason\nsources:\n  - research/bartlett-remembering.md\n  - research/kahneman-notes.md\n  - ${ENTRY}\nstatus: editing\n---\n${body}`)
  expect(addedLines(before, after)).toEqual([`  - ${ENTRY}`])
  expect(parseFrontmatter(after)?.extra.sources).toEqual(['research/bartlett-remembering.md', 'research/kahneman-notes.md', ENTRY])
  // A list written flush left, with a tab after the dash, keeps its own spelling.
  expect(appendSourceLine('---\nsources:\n-\tone.md\n---\n', ENTRY)).toBe(`---\nsources:\n-\tone.md\n-\t${ENTRY}\n---\n`)
})

test('no sources: key — the key and one item go just before the closing fence', () => {
  const before = `---\ntitle: Tools of reason\nstatus: editing\n---\n${body}`
  const after = appendSourceLine(before, ENTRY)
  expect(addedLines(before, after)).toEqual(['sources:', `  - ${ENTRY}`])
  expect(after.endsWith(`---\n${body}`)).toBe(true)
  expect(parseFrontmatter(after)).toMatchObject({ title: 'Tools of reason', status: 'editing', extra: { sources: [ENTRY] } })
})

test('an empty sources: key gains its first item', () => {
  const after = appendSourceLine(`---\nsources:\nstatus: idea\n---\n${body}`, ENTRY)
  expect(after).toBe(`---\nsources:\n  - ${ENTRY}\nstatus: idea\n---\n${body}`)
})

test('a bare file gains a block holding only the key and its item; the body is untouched', () => {
  expect(appendSourceLine(body, ENTRY)).toBe(`---\nsources:\n  - ${ENTRY}\n---\n${body}`)
  // A document opening on a thematic break is not frontmatter: the new block goes above it.
  const rule = '---\n\nJust prose after a rule.\n'
  expect(appendSourceLine(rule, ENTRY)).toBe(`---\nsources:\n  - ${ENTRY}\n---\n${rule}`)
  expect(appendSourceLine('', ENTRY)).toBe(`---\nsources:\n  - ${ENTRY}\n---\n`)
})

test('CRLF line endings and a BOM are kept', () => {
  const before = `﻿---\r\ntitle: T\r\nsources:\r\n  - a.md\r\n---\r\nBody.\r\n`
  const after = appendSourceLine(before, ENTRY)
  expect(after).toBe(`﻿---\r\ntitle: T\r\nsources:\r\n  - a.md\r\n  - ${ENTRY}\r\n---\r\nBody.\r\n`)
  expect(appendSourceLine('﻿---\r\ntitle: T\r\n---\r\nBody.\r\n', ENTRY)).toBe(`﻿---\r\ntitle: T\r\nsources:\r\n  - ${ENTRY}\r\n---\r\nBody.\r\n`)
  expect(appendSourceLine('﻿Body.\r\n', ENTRY)).toBe(`﻿---\r\nsources:\r\n  - ${ENTRY}\r\n---\r\nBody.\r\n`)
})

test('an inline list takes the item inside its brackets; a lone value becomes a two-item list', () => {
  expect(appendSourceLine('---\nsources: [a.md, "b c.md"]\n---\n', ENTRY)).toBe(`---\nsources: [a.md, "b c.md", ${ENTRY}]\n---\n`)
  expect(appendSourceLine('---\nsources: []\n---\n', ENTRY)).toBe(`---\nsources: [${ENTRY}]\n---\n`)
  expect(appendSourceLine('---\nsources: "[[Hall 1976]]"\n---\n', ENTRY)).toBe(`---\nsources:\n  - "[[Hall 1976]]"\n  - ${ENTRY}\n---\n`)
  expect(parseFrontmatter(appendSourceLine('---\nsources: a.md\n---\n', ENTRY))?.extra.sources).toEqual(['a.md', ENTRY])
})

test('the last sources: key is the one written to, as the reader takes the last', () => {
  const after = appendSourceLine('---\nsources:\n  - old.md\nsources:\n  - new.md\n---\n', ENTRY)
  expect(after).toBe(`---\nsources:\n  - old.md\nsources:\n  - new.md\n  - ${ENTRY}\n---\n`)
})

test('forms it cannot extend safely, and an entry already written, are refused', () => {
  for (const before of [
    '---\nsources: |\n  a.md\n---\n',
    '---\nsources:\n  a: b\n---\n',
    '---\nsources: [[a], b]\n---\n',
    `---\nsources:\n  - ${ENTRY}\n---\n`,
    `---\nsources: [${ENTRY}]\n---\n`,
    `---\nsources: ${ENTRY}\n---\n`,
  ]) expect(() => appendSourceLine(before, ENTRY)).toThrow(SourceAttachRefusal)
})

test('an entry that YAML would misread is quoted, and reads back as written', () => {
  expect(yamlItem('research/hall.md')).toBe('research/hall.md')
  expect(yamlItem('research/Hall: Beyond culture.md')).toBe('"research/Hall: Beyond culture.md"')
  expect(yamlItem('research/a, b.md', true)).toBe('"research/a, b.md"')
  const after = appendSourceLine('---\nsources:\n  - a.md\n---\n', 'research/Hall: Beyond culture #2.md')
  expect(parseFrontmatter(after)?.extra.sources).toEqual(['a.md', 'research/Hall: Beyond culture #2.md'])
})

test('the entry is the note\'s path from the piece\'s folder', () => {
  expect(sourceEntryFor('tools-of-reason.md', 'research/schank.md')).toBe('research/schank.md')
  expect(sourceEntryFor('schemas/tools-of-reason.md', 'schemas/research/schank.md')).toBe('research/schank.md')
  expect(sourceEntryFor('schemas/essays/tools.md', 'schemas/research/schank.md')).toBe('../research/schank.md')
})

test('the plan refuses a source the list already names, saying so', () => {
  const input = { piecePath: 's/p.md', piece: body, sourcePath: 's/research/x.md', pieceTitle: 'Tools of reason', sourceTitle: 'Schank & Abelson' }
  expect(() => planSourceAttach({ ...input, listedAs: '[[Schank & Abelson]]' })).toThrow('“Schank & Abelson” is already in the sources of Tools of reason. Nothing was changed.')
  const plan = planSourceAttach({ ...input, listedAs: null })
  expect(plan.piece).toEqual({ path: 's/p.md', before: body, after: `---\nsources:\n  - research/x.md\n---\n${body}` })
})
