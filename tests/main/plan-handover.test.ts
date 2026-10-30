/** The Folio page's decision on a command handed over from the room (round 3): never on another part, never consumed by a failed read. */
import { expect, test } from 'bun:test'
import { handoverStep } from '../../src/renderer/src/plan/plan-commands'

const plan = { parts: [{ title: 'One', path: 'one.md' }, { title: 'Two', path: null }] }

test('no Plan yet, or a failed read (null): the command waits and is kept', () => {
  expect(handoverStep(undefined, { key: null }, null)).toEqual({ kind: 'wait' })
  expect(handoverStep(null, { key: null }, null)).toEqual({ kind: 'wait' })
  expect(handoverStep(null, { key: { title: 'One', path: 'one.md' } }, 0)).toEqual({ kind: 'wait' })
})

test('a key that no longer resolves is refused, never run on the page\'s own selection', () => {
  expect(handoverStep(plan, { key: { title: 'Gone', path: null } }, 0)).toEqual({ kind: 'refuse' })
})

test('a resolved key selects its part first, then runs; no key runs at once', () => {
  expect(handoverStep(plan, { key: { title: 'Two', path: null } }, 0)).toEqual({ kind: 'select', at: 1 })
  expect(handoverStep(plan, { key: { title: 'Two', path: null } }, 1)).toEqual({ kind: 'run' })
  expect(handoverStep(plan, { key: null }, 0)).toEqual({ kind: 'run' })
})
