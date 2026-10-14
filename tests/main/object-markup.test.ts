import { expect, test } from 'bun:test'
import { parseFrontmatter } from '../../src/main/frontmatter'
import { frontmatterSafeInsertPosition, objectBlock, parseFrontmatterEntries, parseTable, serialiseFrontmatterEntries, validateObjectMarkup } from '../../src/shared/object-markup'

test('table validation accepts a complete pipe table and rejects a malformed separator correctively', () => {
  expect(validateObjectMarkup('table', '| A | B |\n| --- | --- |\n| 1 | 2 |')).toBeUndefined()
  expect(() => validateObjectMarkup('table', '| A |\n| nope |')).toThrow(/valid pipe table.*separator/i)
})

test('markmap validation requires list lines, two-space indentation and no level jumps', () => {
  expect(validateObjectMarkup('markmap', '- Root\n  - Child\n    - Grandchild')).toBeUndefined()
  expect(() => validateObjectMarkup('markmap', '- Root\n   - Child')).toThrow(/two spaces/i)
  expect(() => validateObjectMarkup('markmap', '- Root\n    - Grandchild')).toThrow(/one level/i)
  expect(() => validateObjectMarkup('markmap', 'Root')).toThrow(/begin with "- "/i)
})

test('mermaid validation teaches supported types and catches empty bodies and unbalanced delimiters', () => {
  expect(validateObjectMarkup('mermaid', 'flowchart LR\n  A --> B')).toBeUndefined()
  expect(() => validateObjectMarkup('mermaid', 'diagram LR\n  A --> B')).toThrow(/start with a supported diagram type.*flowchart/i)
  expect(() => validateObjectMarkup('mermaid', 'flowchart LR')).toThrow(/body/i)
  expect(() => validateObjectMarkup('mermaid', 'flowchart LR\n  A[Broken')).toThrow(/unbalanced.*line 2/i)
})

test('objectBlock owns fences while tables remain unfenced', () => {
  expect(objectBlock('table', '| A |\n| --- |')).toBe('| A |\n| --- |')
  expect(objectBlock('mermaid', 'flowchart LR\n  A --> B\n')).toBe('```mermaid\nflowchart LR\n  A --> B\n```')
  expect(objectBlock('markmap', '- Root')).toBe('```markmap\n- Root\n```')
  expect(objectBlock('svg', '<svg><rect/></svg>')).toBe('```svg\n<svg><rect/></svg>\n```')
})

test('SVG object validation requires one complete SVG document without fences', () => {
  expect(validateObjectMarkup('svg', '<svg viewBox="0 0 1 1"><rect/></svg>')).toBeUndefined()
  expect(() => validateObjectMarkup('svg', '<rect/>')).toThrow(/svg document/i)
  expect(() => validateObjectMarkup('svg', '```svg\n<svg/>\n```')).toThrow(/without fences/i)
})

test('frontmatter parses scalars and inline or dashed lists without throwing', () => {
  expect(parseFrontmatterEntries('title: River\ntags: [water, "long form"]\nrelated:\n  - source one\n  - source two')).toEqual([
    { kind: 'scalar', key: 'title', value: 'River' },
    { kind: 'list', key: 'tags', values: ['water', 'long form'] },
    { kind: 'list', key: 'related', values: ['source one', 'source two'] },
  ])
  expect(parseFrontmatterEntries('')).toEqual([])
  expect(parseFrontmatterEntries('tags:\n- alpha\n- beta')).toEqual([
    { kind: 'list', key: 'tags', values: ['alpha', 'beta'] },
  ])
  expect(() => parseFrontmatterEntries('title: [broken')).not.toThrow()
})

test('quoted frontmatter keys are structured entries and converge byte-stably', () => {
  const source = '"two words": value\n\'list key\':\n  - one\n  - "two parts"'
  expect(parseFrontmatterEntries(source)).toEqual([
    { kind: 'scalar', key: 'two words', value: 'value' },
    { kind: 'list', key: 'list key', values: ['one', 'two parts'] },
  ])
  const canonical = '"two words": value\n"list key": [one, two parts]'
  expect(serialiseFrontmatterEntries(parseFrontmatterEntries(source))).toBe(canonical)
  expect(serialiseFrontmatterEntries(parseFrontmatterEntries(canonical))).toBe(canonical)
})

test('every insertion caret inside leading frontmatter lands after its closing fence', () => {
  const document = '---\ntitle: River\n---\n\nBody'
  for (const position of [0, 12, 20, 21, 22]) {
    expect(frontmatterSafeInsertPosition(document, position)).toBe(22)
  }
  expect(frontmatterSafeInsertPosition('---\ntitle: River\n---', 0)).toBe(20)
  expect(frontmatterSafeInsertPosition('Body\n\n---\nrule', 0)).toBe(0)
  expect(frontmatterSafeInsertPosition('---\nunclosed', 0)).toBe(0)
})

test('insertions inside a recorded machine block land after the complete block', () => {
  const document = [
    '# Day',
    '',
    '<!-- writeflex:recorded:start -->',
    'recorded',
    '| 09:12 | 4 min |',
    '<!-- writeflex:recorded:end -->',
    '',
    'Writer prose.',
  ].join('\n')
  const start = document.indexOf('<!-- writeflex:recorded:start -->')
  const middle = document.indexOf('| 09:12')
  const end = document.indexOf('<!-- writeflex:recorded:end -->') + '<!-- writeflex:recorded:end -->'.length
  const expected = document.indexOf('Writer prose.')
  for (const position of [start, middle, end]) {
    expect(frontmatterSafeInsertPosition(document, position)).toBe(expected)
  }
})

test('a table requires a pipe-delimited matching delimiter row and supports one column', () => {
  expect(parseTable('Introduction\n-----')).toBeNull()
  expect(parseTable('A\n---')).toBeNull()
  expect(parseTable('Introduction\n---\nParagraph')).toBeNull()
  expect(parseTable('---\n---')).toBeNull()
  expect(parseTable('| A |\n| --- |\n| 1 |')).toEqual({ cells: [['A'], ['1']], alignments: ['left'] })
  expect(parseTable('| Name | Status |\n| --- | :---: |\n| Alpha | Drafting |')).not.toBeNull()
})

test('frontmatter preserves every unmodelled byte in consecutive raw runs', () => {
  const alien = '# keep this comment\nsettings:\n  nested: true\nbody: |\n  exact: # text\n\n@alien'
  expect(parseFrontmatterEntries(alien)).toEqual([{ kind: 'raw', lines: alien }])
  expect(serialiseFrontmatterEntries(parseFrontmatterEntries(alien))).toBe(alien)
  const mixed = 'title: River\n# exact  \nsettings:\n  nested: true\nstatus: draft'
  const changed = parseFrontmatterEntries(mixed)
  expect(changed[1]).toEqual({ kind: 'raw', lines: '# exact  \nsettings:\n  nested: true' })
  if (changed[0]?.kind === 'scalar') changed[0].value = 'Thames'
  expect(serialiseFrontmatterEntries(changed)).toBe('title: Thames\n# exact  \nsettings:\n  nested: true\nstatus: draft')
})

test('frontmatter serialisation quotes every YAML-sensitive scalar and converges after one pass', () => {
  const entries = [
    { kind: 'scalar', key: 'plain', value: 'safe' },
    { kind: 'scalar', key: 'spaced', value: ' leading ' },
    { kind: 'scalar', key: 'colon', value: 'a: b' },
    { kind: 'scalar', key: 'special', value: '# heading' },
    { kind: 'scalar', key: 'quotes', value: `a 'quote' and "double"` },
    { kind: 'list', key: 'tags', values: ['short', 'hash#tag', 'two, parts', 'x'.repeat(41)] },
  ] as const
  const canonical = serialiseFrontmatterEntries(entries.map((entry) => ({ ...entry, values: 'values' in entry ? [...entry.values] : undefined } as never)))
  expect(canonical).toBe('plain: safe\nspaced: " leading "\ncolon: "a: b"\nspecial: "# heading"\nquotes: "a \'quote\' and \\"double\\""\ntags:\n  - short\n  - "hash#tag"\n  - "two, parts"\n  - xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
  expect(serialiseFrontmatterEntries(parseFrontmatterEntries(canonical))).toBe(canonical)
})

test('frontmatter serialisation quotes YAML null-like, boolean-like, and Unicode line-break scalars', () => {
  const values = ['~', 'null', 'Null', 'NULL', 'no', 'No', 'YES', 'on', 'Off', 'true', 'FALSE', `line\u2028break`]
  const canonical = serialiseFrontmatterEntries(values.map((value, index) => ({
    kind: 'scalar' as const,
    key: `value_${index}`,
    value,
  })))

  expect(canonical.split('\n')).toEqual(values.map((value, index) => `value_${index}: ${JSON.stringify(value)}`))
  expect(parseFrontmatterEntries(canonical).map((entry) => entry.kind === 'scalar' ? entry.value : null)).toEqual(values)
})

test('canonical structured output remains readable by the main frontmatter parser', () => {
  const inner = serialiseFrontmatterEntries([
    { kind: 'scalar', key: 'title', value: 'River: notes' },
    { kind: 'list', key: 'tags', values: ['rivers', 'long form'] },
  ])
  expect(parseFrontmatter(`---\n${inner}\n---\nBody`)).toMatchObject({ title: 'River: notes', tags: ['rivers', 'long form'] })
})
