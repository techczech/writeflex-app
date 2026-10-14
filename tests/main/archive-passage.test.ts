import { expect, test } from 'bun:test'
import { buildPassageModel, NO_WIDENING, widen, widenedQuote } from '../../src/renderer/src/archive-passage'

const context = {
  before: 'They simply looked at paths trodden in the grass. Then they paved them.',
  passage: 'Planners were wrong. But being open to repaving is the most important thing. It keeps paths honest.',
  after: 'Nobody paves a desire line twice.',
}
const HIT = 'But being open to repaving is the most important thing.'

test('unwidened, the quote is exactly the hit', () => {
  const model = buildPassageModel(context, HIT)
  expect(model).not.toBeNull()
  expect(widenedQuote(model!, NO_WIDENING)).toBe(HIT)
})

test('⇧↑ and ⇧↓ take one original sentence at a time, crossing lines as original slices', () => {
  const model = buildPassageModel(context, HIT)!
  let widening = widen(model, NO_WIDENING, 'before')
  expect(widenedQuote(model, widening)).toBe(`Planners were wrong. ${HIT}`)
  widening = widen(model, widening, 'before')
  expect(widenedQuote(model, widening)).toBe(`Then they paved them.\nPlanners were wrong. ${HIT}`)
  widening = widen(model, widen(model, widening, 'after'), 'after')
  expect(widenedQuote(model, widening)).toBe(`Then they paved them.\nPlanners were wrong. ${HIT} It keeps paths honest.\nNobody paves a desire line twice.`)
  // Nothing more after: the widening stays put.
  expect(widen(model, widening, 'after')).toEqual(widening)
})

test('a hit that is not verbatim in its passage gives no model, so nothing widens', () => {
  expect(buildPassageModel(context, 'Not in the passage.')).toBeNull()
  expect(widen(null, NO_WIDENING, 'before')).toEqual(NO_WIDENING)
})
