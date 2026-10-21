import { expect, test } from 'bun:test'
import { METADATA_REGISTRY, metadataEntry } from '../../src/shared/metadata-registry'
import { metadataRows, editMetadataInner, metadataSummary } from '../../src/shared/document-metadata'
import { FOLIO_DETAIL_FIELDS } from '../../src/shared/folio-details'

test('registry explains Folio fields, export keys and system keys without closing custom status lanes', () => {
  for (const key of [...FOLIO_DETAIL_FIELDS, 'tags', 'description', 'purpose', 'related', 'series', 'series-order', 'toc_depth']) {
    expect(metadataEntry(key)?.explanation.length).toBeGreaterThan(15)
  }
  expect(new Set(METADATA_REGISTRY.map(e => e.key)).size).toBe(METADATA_REGISTRY.length)
  expect(metadataEntry('status')?.options).toBeUndefined()
  expect(metadataEntry('toc_depth')?.options?.map(o => o.value)).toContain('3')
  expect(metadataEntry('created-by')?.system).toBe(true)
})

test('only the edited value changes; comments, order, unknown maps and multiline stay byte exact', () => {
  const inner = '# cover\ntitle: "Before" # keep this\ncustom:\n  nested: true\nstandfirst: |\n  A real paragraph.\n  Another line.\ntags: [one, two]\n'
  expect(editMetadataInner(inner, 'title', 'After')).toBe(inner.replace('"Before"', 'After'))
  expect(editMetadataInner(inner, 'tags', ['two', 'three'])).toBe(inner.replace('[one, two]', '[two, three]'))
  expect(metadataRows(inner).find(r => r.key === 'standfirst')?.editable).toBe(false)
  expect(editMetadataInner(inner, 'custom', null)).toBe(inner.replace('custom:\n  nested: true\n', ''))
})

test('quoted hash, duplicate keys, CRLF and new fields are safe', () => {
  const inner = 'title: "A # title"\r\nauthor: Jane\r\n'
  expect(editMetadataInner(inner, 'author', 'John')).toBe(inner.replace('Jane', 'John'))
  expect(editMetadataInner(inner, 'audience', 'Writers')).toBe(inner + '\r\naudience: Writers')
  expect(() => editMetadataInner('title: A\ntitle: B', 'title', 'C')).toThrow()
  expect(metadataSummary('title: Essay\nstatus: editing\ntags: [one, two, three]')).toBe('Essay · editing · 3 tags')
})

test('quoted unknown keys surface and removal never eats separate comments', () => {
  const inner = 'title: A\n"custom field": untouched\n# keep this note\nauthor: Jane'
  expect(metadataRows(inner).map(r => r.key)).toEqual(['title', 'custom field', 'author'])
  expect(editMetadataInner(inner, 'custom field', null)).toBe('title: A\n# keep this note\nauthor: Jane')
})

test('plain custom keys with dots and spaces surface for doctor review without flattening their values', () => {
  const inner = 'title: A\ncustom.key: retained\ncustom field:\n  nested: true\nauthor: Jane'
  expect(metadataRows(inner).map(r => r.key)).toEqual(['title', 'custom.key', 'custom field', 'author'])
  expect(editMetadataInner(inner, 'title', 'B')).toBe(inner.replace('title: A', 'title: B'))
  expect(editMetadataInner(inner, 'custom field', null)).toBe(inner.replace('custom field:\n  nested: true\n', ''))
})

test('series order declares its disk key, not the export selector’s camel-case alias', () => {
  expect(metadataEntry('series-order')).toBeDefined()
  expect(metadataEntry('seriesOrder')).toBeUndefined()
})


test('metadata values treat replacement tokens as literal user text', () => {
  for (const value of ["Profit $' and $& loss", 'Before $` after', 'Cash $$ today']) {
    expect(metadataRows(`title: ${value} # keep\nauthor: Jane`)[0]).toMatchObject({ value, editable: true, comment: ' # keep' })
    expect(editMetadataInner(`title: ${value} # keep\nauthor: Jane`, 'author', 'John')).toBe(`title: ${value} # keep\nauthor: John`)
    expect(metadataRows(editMetadataInner('title: Old', 'title', value))[0].value).toBe(value)
  }
})

test('dashed tag comments stay comments when tags are edited', () => {
  const source = 'tags:\n  - a # keep me\n  - "b # literal" # second\nauthor: Jane'
  expect(metadataRows(source)[0].value).toEqual(['a', 'b # literal'])
  const edited = editMetadataInner(source, 'tags', ['a', 'b # literal', 'c'])
  expect(metadataRows(edited)[0].value).toEqual(['a', 'b # literal', 'c'])
  expect(edited).toContain('  - a # keep me\n')
  expect(edited).toContain('  - "b # literal" # second\n')
  expect(edited).toEndWith('author: Jane')
})


test('app-owned metadata keys are system fields and citation facts remain editable', () => {
  for (const key of ['pattern', 'diary', 'heading']) expect(metadataEntry(key)?.system).toBe(true)
  for (const key of ['year', 'published', 'authors']) expect(metadataEntry(key)?.system).not.toBe(true)
})

// Front matter from an imported piece: ten keys WriteFlex does not register, around two it does.
const IMPORTED = [
  '# imported piece',
  'title: Imported essay',
  'venue: The Conversation',
  'published_url: "https://example.org/a-piece"',
  'lang: en # two-letter code',
  'date_precision: day',
  "date_status: '2021-04-03'",
  'date_source: 2021-04-03',
  'imported_from: medium',
  'imported: true',
  'imported_by: [agent, dominik]',
  'enriched:',
  '  - summary  # first pass',
  '  - tags',
  'status: draft',
].join('\n')
const UNKNOWN = ['venue', 'published_url', 'lang', 'date_precision', 'date_status', 'date_source', 'imported_from', 'imported', 'imported_by', 'enriched']
const linesOf = (text: string) => text.split('\n')

test('editing a known field leaves every unknown key line byte-identical', () => {
  expect(metadataRows(IMPORTED).map(r => r.key).filter(k => !metadataEntry(k))).toEqual(UNKNOWN)
  for (const [key, value] of [['title', 'A new title'], ['status', 'final'], ['title', 'Has: a colon']] as const) {
    const edited = editMetadataInner(IMPORTED, key, value)
    const before = linesOf(IMPORTED), after = linesOf(edited)
    expect(after.length).toBe(before.length)
    const changed = before.flatMap((line, i) => line === after[i] ? [] : [i])
    expect(changed).toEqual([before.findIndex(line => line.startsWith(`${key}:`))])
  }
  expect(editMetadataInner(IMPORTED, 'tags', ['one'])).toBe(IMPORTED + '\ntags: [one]')
})

test('editing an unknown scalar changes only that line and keeps its key, comment and YAML type', () => {
  const only = (key: string, value: string, line: string) => {
    const before = linesOf(IMPORTED), after = linesOf(editMetadataInner(IMPORTED, key, value))
    const changed = before.flatMap((text, i) => text === after[i] ? [] : [i])
    expect(changed.length).toBe(1)
    expect(after[changed[0]]).toBe(line)
    expect(after.length).toBe(before.length)
  }
  only('venue', 'The Guardian', 'venue: The Guardian')
  only('lang', 'cs', 'lang: cs # two-letter code')
  only('published_url', 'https://example.org/b', 'published_url: "https://example.org/b"')
  only('imported', 'false', 'imported: false')
  only('date_source', '2022-01-01', 'date_source: 2022-01-01')
  only('date_status', '2022-01-01', "date_status: '2022-01-01'")
  only('imported_from', 'Substack: archive', 'imported_from: "Substack: archive"')
  // Typing a value back to what the file holds leaves the file's bytes alone.
  for (const row of metadataRows(IMPORTED)) if (row.editable && typeof row.value === 'string') expect(editMetadataInner(IMPORTED, row.key, row.value)).toBe(IMPORTED)
  expect(metadataRows(editMetadataInner(IMPORTED, 'imported', 'false')).find(r => r.key === 'imported')?.value).toBe('false')
  expect(editMetadataInner("'odd key': kept\ntitle: A", 'odd key', 'changed')).toBe("'odd key': changed\ntitle: A")
})

// Fix round 1: typed values, list spellings, key spelling and every key shown.
import * as metadataModule from '../../src/shared/document-metadata'
const yaml = (text: string): Record<string, unknown> => Bun.YAML.parse(text) as Record<string, unknown>
/** Types a value one character at a time into a field, as the panel's input event does. */
function typeInto(inner: string, key: string, text: string): string {
  const original = (metadataModule as any).metadataOriginals?.(inner)?.get(key)
  let current = inner
  for (let n = 0; n <= text.length; n++) current = editMetadataInner(current, key, text.slice(0, n), undefined, original)
  return current
}

test('a typed value that only looks like a date is quoted, never written raw', () => {
  for (const value of ['2022-01-01T12:00:00 # literal', '2022-01-01T12:00:00: extra']) {
    const edited = editMetadataInner('date_source: 2021-04-03\ntitle: A', 'date_source', value)
    expect(yaml(edited)).toEqual({ date_source: value, title: 'A' })
  }
  expect(editMetadataInner('date_source: 2021-04-03', 'date_source', '2022-01-01T12:00:00')).toBe('date_source: 2022-01-01T12:00:00')
})

test('a typed value is a string unless the field held that same non-string type when editing began', () => {
  for (const value of ['0123', '1e3', '2022-01-01', 'true', 'null', '12']) expect(yaml(typeInto('title: Essay', 'title', value)).title).toBe(value)
  expect(yaml(typeInto('year: 2021', 'year', 'true')).year).toBe('true')
  expect(yaml(typeInto('year: 2021', 'year', '2025')).year).toBe(2025)
  expect(yaml(typeInto('imported: true\nlang: en', 'imported', 'false'))).toEqual({ imported: false, lang: 'en' })
  expect(yaml(typeInto('imported: true', 'imported', 'fals')).imported).toBe('fals')
  expect(typeInto('when: 2021-04-03', 'when', '2022-01-01')).toBe('when: 2022-01-01')
  expect(typeInto("when: '2021-04-03'", 'when', '2022-01-01')).toBe("when: '2022-01-01'")
  expect(typeInto('draft: yes', 'draft', 'no')).toBe('draft: no')
  expect(typeInto('imported: true # kept', 'imported', 'true')).toBe('imported: true # kept')
})

test('list edits keep the key spelling and existing item spellings; an identical list keeps its bytes', () => {
  const inline = '"tags": ["0123", "yes"] # mine\ntitle: A'
  expect(editMetadataInner(inline, 'tags', ['0123', 'yes'])).toBe(inline)
  const added = editMetadataInner(inline, 'tags', ['0123', 'yes', 'new', '007'])
  expect(added).toBe('"tags": ["0123", "yes", new, "007"] # mine\ntitle: A')
  expect(yaml(added).tags).toEqual(['0123', 'yes', 'new', '007'])
  const dashed = "tags:\n    - 'one' # first\n    - \"2021\"\ntitle: A"
  expect(editMetadataInner(dashed, 'tags', ['one', '2021'])).toBe(dashed)
  const grown = editMetadataInner(dashed, 'tags', ['2021', 'one', 'three'])
  expect(grown).toBe("tags:\n    - \"2021\"\n    - 'one' # first\n    - three\ntitle: A")
  expect(yaml(grown).tags).toEqual(['2021', 'one', 'three'])
})

test('a key written with a space before its colon is the same key, and its spelling is kept', () => {
  const inner = 'title : Existing\nstatus: draft'
  expect(metadataRows(inner)[0]).toMatchObject({ key: 'title', value: 'Existing', editable: true })
  expect(editMetadataInner(inner, 'title', 'New')).toBe('title : New\nstatus: draft')
  expect(() => editMetadataInner('title : A\ntitle: B', 'title', 'C')).toThrow()
  expect(editMetadataInner("'odd key' : kept", 'odd key', 'changed')).toBe("'odd key' : changed")
})

test('every plain YAML key is recognised and editable without touching its neighbours', () => {
  const inner = 'foo/bar: one\n.custom: two\n_venue: three\ncustom.key: four\nnaïve clé: five\ntitle: A'
  expect(metadataRows(inner).map(r => r.key)).toEqual(['foo/bar', '.custom', '_venue', 'custom.key', 'naïve clé', 'title'])
  expect(metadataRows(inner).every(r => r.editable)).toBe(true)
  for (const row of metadataRows(inner)) {
    const edited = editMetadataInner(inner, row.key, 'changed')
    expect(yaml(edited)).toEqual({ ...yaml(inner), [row.key]: 'changed' })
  }
})

// Fix round 2: nested lists are opaque, new fields take their declared type, every entry is a row.
test('a list holding a nested list or map is opaque: read-only and never edited by the panel', () => {
  for (const inner of ['tags: [[a, b], c]\ntitle: A', 'tags: [{a: 1}, c]\ntitle: A', 'tags:\n  - a: 1\n  - c\ntitle: A', 'tags:\n  - [a, b]\n  - c\ntitle: A', 'tags:\n  - - a\n  - c\ntitle: A']) {
    const row = metadataRows(inner)[0]
    expect(row.key).toBe('tags')
    expect(row.editable).toBe(false)
    expect(() => editMetadataInner(inner, 'tags', ['c'])).toThrow()
    expect(editMetadataInner(inner, 'title', 'B')).toBe(inner.replace('title: A', 'title: B'))
  }
  expect(metadataRows('tags: ["[a", "b]", c]')[0]).toMatchObject({ editable: true, items: ['"[a"', '"b]"', 'c'] })
})

test('a field absent when editing began takes its declared type, whether typed or pasted', () => {
  const typed = (key: string, text: string) => {
    let inner = 'title: A'
    for (let n = 1; n <= text.length; n++) inner = editMetadataInner(inner, key, text.slice(0, n), undefined, null)
    return inner
  }
  const pasted = (key: string, text: string) => editMetadataInner('title: A', key, text, undefined, null)
  for (const [key, text, expected] of [['goal', '1e3', '1e3'], ['goal', '1000', 1000], ['goal', '12 words', '12 words'], ['toc_depth', '3', 3], ['venue', '2021', '2021'], ['due', '2026-11-01', '2026-11-01'], ['title2', 'true', 'true']] as const) {
    expect(typed(key, text)).toBe(pasted(key, text))
    expect((Bun.YAML.parse(pasted(key, text)) as Record<string, unknown>)[key]).toEqual(expected)
  }
  expect(pasted('due', '2026-11-01')).toBe('title: A\ndue: 2026-11-01')
})

test('an entry the key reader cannot name still gets its own read-only row and never joins its neighbour', () => {
  const inner = 'title: A\n[a]: x\n? complex\n: value\nauthor: Jane'
  const rows = metadataRows(inner)
  expect(rows.map(r => r.opaque ? `opaque ${r.valueText}` : r.key)).toEqual(['title', 'opaque [a]: x', 'opaque ? complex', 'author'])
  expect(rows.find(r => r.key === 'title')?.editable).toBe(true)
  expect(editMetadataInner(inner, 'title', 'B')).toBe(inner.replace('title: A', 'title: B'))
  expect(metadataRows('? first\n: one\ntitle: A').map(r => r.opaque ?? false)).toEqual([true, false])
})

// Fix round 3 (Sol re-review): anchored/aliased/tagged list items, plain decimals only, opaque entries never removed.
test('a list whose items carry an anchor, alias or tag, or that the split cannot match, is read-only', () => {
  for (const inner of ['tags: [&x [a, b], c]\ntitle: A', 'tags: [&x a, *x]\ntitle: A', 'tags: [!!str 1, c]\ntitle: A', 'tags:\n  - &x a\n  - c\ntitle: A', 'tags:\n  - *x\n  - c\ntitle: A']) {
    expect(metadataRows(inner)[0]).toMatchObject({ key: 'tags', editable: false })
    expect(() => editMetadataInner(inner, 'tags', ['c'])).toThrow()
    expect(editMetadataInner(inner, 'title', 'B')).toBe(inner.replace('title: A', 'title: B'))
  }
})

test('a new number field is bare only for a plain decimal with no plus sign and no leading zero', () => {
  const added = (text: string) => editMetadataInner('title: A', 'goal', text, undefined, null)
  for (const [text, expected] of [['+12', '+12'], ['012', '012'], ['-012', '-012'], ['0', 0], ['0.5', 0.5], ['-0.5', -0.5], ['12', 12]] as const)
    expect((Bun.YAML.parse(added(text)) as Record<string, unknown>).goal).toEqual(expected)
  expect(added('+12')).toBe('title: A\ngoal: "+12"')
  expect(added('012')).toBe('title: A\ngoal: "012"')
})

test('an opaque entry is never removed or written through the helper', () => {
  const inner = '[a]: x\ntitle: A'
  const opaque = metadataRows(inner)[0]
  expect(opaque.opaque).toBe(true)
  expect(() => editMetadataInner(inner, opaque.key, null)).toThrow()
  expect(() => editMetadataInner(inner, opaque.key, 'y')).toThrow()
  expect(() => editMetadataInner('title: A', '\u0000[a]: x', 'y')).toThrow()
  expect(editMetadataInner(inner, 'title', null)).toBe('[a]: x\n')
})
