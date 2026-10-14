import { expect, test } from 'bun:test'
import { wordRangeAt } from '../../src/renderer/src/editor/word-range'

const SOURCE = 'A schema is different: it is the shape of a situation we already know, and don\'t forget well-known cases.'

test('a word start gives the whole word and nothing else', () => {
  const at = SOURCE.indexOf('situation')
  expect(wordRangeAt(SOURCE, at)).toEqual({ from: at, to: at + 'situation'.length })
})

test('an offset inside a word gives the same word', () => {
  const at = SOURCE.indexOf('situation')
  expect(wordRangeAt(SOURCE, at + 4)).toEqual({ from: at, to: at + 'situation'.length })
})

test('trailing punctuation stays outside the word', () => {
  const at = SOURCE.indexOf('know,')
  expect(wordRangeAt(SOURCE, at)).toEqual({ from: at, to: at + 4 })
  expect(wordRangeAt(SOURCE, at + 4)).toBeNull()
  const colon = SOURCE.indexOf('different:')
  expect(wordRangeAt(SOURCE, colon)).toEqual({ from: colon, to: colon + 'different'.length })
})

test('an apostrophe or hyphen between letters belongs to the word', () => {
  const dont = SOURCE.indexOf("don't")
  expect(wordRangeAt(SOURCE, dont)).toEqual({ from: dont, to: dont + 5 })
  const hyphen = SOURCE.indexOf('well-known')
  expect(wordRangeAt(SOURCE, hyphen + 2)).toEqual({ from: hyphen, to: hyphen + 10 })
})

test('whitespace, markup and out-of-range offsets give no word', () => {
  expect(wordRangeAt(SOURCE, SOURCE.indexOf(' schema'))).toBeNull()
  expect(wordRangeAt('**bold** text', 0)).toBeNull()
  expect(wordRangeAt('**bold** text', 2)).toEqual({ from: 2, to: 6 })
  expect(wordRangeAt(SOURCE, -1)).toBeNull()
  expect(wordRangeAt(SOURCE, SOURCE.length)).toBeNull()
  expect(wordRangeAt('', 0)).toBeNull()
})

test('accented and non-Latin letters count as word characters', () => {
  expect(wordRangeAt('Příliš žluťoučký kůň', 0)).toEqual({ from: 0, to: 6 })
})
