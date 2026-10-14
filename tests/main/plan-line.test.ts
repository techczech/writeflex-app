import { expect, test } from 'bun:test'
import { parsePlanLine, serialisePlanLine } from '../../src/shared/plan-line'

test('parses unordered and ordered Plan lines with both gloss separators', () => {
  expect(parsePlanLine('- [[Introduction]] — Set up the argument #VIGNETTE #opening')).toEqual({
    marker: '-',
    title: 'Introduction',
    gloss: 'Set up the argument',
    role: 'vignette',
    tags: ['opening'],
  })
  expect(parsePlanLine('1. [[Appendices]] - Supporting evidence #appendix #data-set')).toEqual({
    marker: '1.',
    title: 'Appendices',
    gloss: 'Supporting evidence',
    role: 'appendix',
    tags: ['data-set'],
  })
  expect(parsePlanLine('27. [[Late appendix]]')).toEqual({
    marker: '27.',
    title: 'Late appendix',
    gloss: null,
    role: 'section',
    tags: [],
  })
})

test('uses the first separator after the closing wikilink and keeps separators inside the gloss', () => {
  expect(parsePlanLine('* [[Methods - overview]] — First pass - with detail #methods')).toEqual({
    marker: '*',
    title: 'Methods - overview',
    gloss: 'First pass - with detail',
    role: 'section',
    tags: ['methods'],
  })
})

test('parses a marker-only Plan line without adding gloss or tags', () => {
  expect(parsePlanLine('* [[Conclusion]]')).toEqual({
    marker: '*',
    title: 'Conclusion',
    gloss: null,
    role: 'section',
    tags: [],
  })
})

test('rejects text that is not a Plan line', () => {
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

test('parse and serialise round-trip the semantic Plan-line fields', () => {
  const line = '- [[Café evidence]] — A note with punctuation: yes. #summary #naïve'
  const parsed = parsePlanLine(line)
  expect(parsed).not.toBeNull()
  expect(parsePlanLine(serialisePlanLine(parsed!, parsed!.marker))).toEqual(parsed)
})

test('serialisation refuses titles and tags that would make an unreadable Plan line', () => {
  expect(() => serialisePlanLine({ title: 'Bad ]] title', role: 'section' })).toThrow('Plan title')
  expect(() => serialisePlanLine({ title: 'Target|display', role: 'section' })).toThrow('Plan title')
  expect(() => serialisePlanLine({ title: 'Good', role: 'section', tags: ['two words'] })).toThrow('Plan tag')
})
