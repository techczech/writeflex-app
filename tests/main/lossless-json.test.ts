/**
 * The carried-value check (lossless-json.ts): which values a parse-and-rewrite would change.
 *
 * Seam: `firstLossyCarriedKey` over source texts and the objects a writer would write.
 */
import { expect, test } from 'bun:test'
import { firstLossyCarriedKey, topLevelValueTexts } from '../../src/main/lossless-json'

const check = (text: string, change: (raw: Record<string, unknown>) => Record<string, unknown> = (raw) => ({ ...raw })): string | null => {
  const parsed = JSON.parse(text) as Record<string, unknown>
  return firstLossyCarriedKey(text, parsed, change(parsed))
}

test('values JSON numbers hold exactly pass, in any layout and with any string escapes', () => {
  expect(check('{ "a" : 1, "b" : [ -2.5, 1e-7, 0.1 ], "c": { "d": "caf\\u00e9 \\/" }, "e": null, "f": false }')).toBeNull()
  expect(check('{}')).toBeNull()
})

test('numbers a parse changes are named by their top-level key', () => {
  expect(check('{"ok":1,"big":9007199254740993}')).toBe('big')
  expect(check('{"huge":1e400}')).toBe('huge')
  expect(check('{"deep":{"x":[1,2,123456789012345678901234567890]}}')).toBe('deep')
})

test('a key written twice is named; a replaced value is not judged', () => {
  expect(check('{"twice":1,"twice":2}')).toBe('twice')
  expect(check('{"big":9007199254740993,"pins":[]}', (raw) => ({ ...raw, big: 5 }))).toBeNull()
  expect(check('{"pins":[],"twice":1,"twice":2}', ({ twice: _dropped, ...rest }) => ({ ...rest, twice: 3 }))).toBeNull()
})

test('top-level texts are split exactly at the object\'s own commas', () => {
  expect(topLevelValueTexts('{"a":{"b":"},{"},"c":[1,{"d":2}]}')).toEqual(new Map([['a', ['{"b":"},{"}']], ['c', ['[1,{"d":2}]']]]))
  expect(topLevelValueTexts('[1]')).toBeNull()
})
