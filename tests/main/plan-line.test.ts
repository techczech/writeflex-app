import { expect, test } from 'bun:test'
import { parsePlanLine, serialisePlanLine } from '../../src/shared/plan-line'

test('parses unordered and ordered Folio outline lines with both gloss separators', () => {
  expect(parsePlanLine('- [[Introduction]] — Set up the argument #VIGNETTE #opening')).toEqual({
    marker: '-',
    title: 'Introduction',
    gloss: 'Set up the argument',
    role: 'vignette',
    tags: ['opening'],
    frontMatter: false,
  })
  expect(parsePlanLine('1. [[Appendices]] - Supporting evidence #appendix #data-set')).toEqual({
    marker: '1.',
    title: 'Appendices',
    gloss: 'Supporting evidence',
    role: 'appendix',
    tags: ['data-set'],
    frontMatter: false,
  })
  expect(parsePlanLine('27. [[Late appendix]]')).toEqual({
    marker: '27.',
    title: 'Late appendix',
    gloss: null,
    role: 'section',
    tags: [],
    frontMatter: false,
  })
})

test('uses the first separator after the closing wikilink and keeps separators inside the gloss', () => {
  expect(parsePlanLine('* [[Methods - overview]] — First pass - with detail #methods')).toEqual({
    marker: '*',
    title: 'Methods - overview',
    gloss: 'First pass - with detail',
    role: 'section',
    tags: ['methods'],
    frontMatter: false,
  })
})

test('parses a marker-only Folio outline line without adding gloss or tags', () => {
  expect(parsePlanLine('* [[Conclusion]]')).toEqual({
    marker: '*',
    title: 'Conclusion',
    gloss: null,
    role: 'section',
    tags: [],
    frontMatter: false,
  })
})

test('a #front-matter tag is kept as a fact of the line whatever role tag follows it (ADR-0046)', () => {
  expect(parsePlanLine('- [[A]] #front-matter #summary')).toEqual({ marker: '-', title: 'A', gloss: null, role: 'summary', tags: [], frontMatter: true })
  expect(parsePlanLine('- [[A]] #summary #Front-Matter #draft')).toMatchObject({ role: 'front-matter', tags: ['draft'], frontMatter: true })
  expect(parsePlanLine('- [[A]] #summary')).toMatchObject({ role: 'summary', frontMatter: false })
})

test('rejects text that is not a Folio outline line', () => {
  expect(parsePlanLine('Paragraph with [[Introduction]].')).toBeNull()
  expect(parsePlanLine('- Introduction #section')).toBeNull()
  expect(parsePlanLine('- [[Introduction]] unexplained text')).toBeNull()
})

test('serialises the default role implicitly and other roles as trailing tags', () => {
  expect(serialisePlanLine({ title: 'Conclusion', gloss: null, role: 'section', tags: [] }, '*')).toBe('* [[Conclusion]]')
  expect(serialisePlanLine({ title: 'Evidence', gloss: 'What the sources show', role: 'summary', tags: ['review'] }, '1.')).toBe(
    '1. [[Evidence]] — What the sources show #summary #review',
  )
  expect(serialisePlanLine({ title: 'Late appendix' }, '27.')).toBe('27. [[Late appendix]]')
})

test('parse and serialise round-trip the semantic Folio outline-line fields', () => {
  const line = '- [[Café evidence]] — A note with punctuation: yes. #summary #naïve'
  const parsed = parsePlanLine(line)
  expect(parsed).not.toBeNull()
  expect(parsePlanLine(serialisePlanLine(parsed!, parsed!.marker))).toEqual(parsed)
})

test('serialisation refuses titles and tags that would make an unreadable Folio outline line', () => {
  expect(() => serialisePlanLine({ title: 'Bad ]] title', role: 'section' })).toThrow('Folio outline title')
  expect(() => serialisePlanLine({ title: 'Target|display', role: 'section' })).toThrow('Folio outline title')
  expect(() => serialisePlanLine({ title: 'Good', role: 'section', tags: ['two words'] })).toThrow('Folio outline tag')
})
