import { expect, test } from 'bun:test'
import type { Change } from '../../src/preload'
import { ReviewCursor, owedReveal } from '../../src/renderer/src/app/review-cursor'

function change(id: string, oldText: string, status: Change['status'] = 'pending'): Change {
  return {
    id,
    path: 'draft.md',
    ts: 1,
    provenance: 'agent',
    editClass: 'content',
    category: 'wording',
    summary: id,
    oldText,
    newText: `${oldText}!`,
    status,
    isCorrection: false,
  }
}

test('the review cursor follows document order and stops at either end', () => {
  const events: Array<{ id: string | null; reveal: boolean }> = []
  const cursor = new ReviewCursor((event) => events.push(event))
  cursor.sync([
    change('third', 'Third'),
    change('first', 'First'),
    change('second', 'Second'),
  ], 'First. Second. Third.')

  cursor.select('first')
  cursor.move(1)
  cursor.move(1)
  cursor.move(1)
  cursor.move(-1)

  expect(events).toEqual([
    { id: 'first', reveal: true },
    { id: 'second', reveal: true },
    { id: 'third', reveal: true },
    { id: 'second', reveal: true },
  ])
})

test('the review cursor never retains a resolved or absent change', () => {
  const events: Array<{ id: string | null; reveal: boolean }> = []
  const cursor = new ReviewCursor((event) => events.push(event))
  cursor.sync([change('one', 'One'), change('two', 'Two')], 'One. Two.')
  cursor.select('one')

  cursor.sync([change('one', 'One', 'accepted'), change('two', 'Two')], 'One. Two.')
  expect(cursor.currentId).toBe('two')
  expect(events.at(-1)).toEqual({ id: 'two', reveal: false })

  cursor.sync([], 'One. Two.')
  expect(cursor.currentId).toBeNull()
  expect(events.at(-1)).toEqual({ id: null, reveal: false })
})

test('normal resolution holds the viewport while accept-and-next reveals the next change', () => {
  const events: Array<{ id: string | null; reveal: boolean }> = []
  const cursor = new ReviewCursor((event) => events.push(event))
  cursor.sync([change('one', 'One'), change('two', 'Two'), change('three', 'Three')], 'One. Two. Three.')
  cursor.select('one')

  cursor.settle('one', false)
  expect(cursor.currentId).toBe('two')
  expect(events.at(-1)).toEqual({ id: 'two', reveal: false })

  cursor.settle('two', true)
  expect(cursor.currentId).toBe('three')
  expect(events.at(-1)).toEqual({ id: 'three', reveal: true })

  cursor.settle('three', true)
  expect(cursor.currentId).toBeNull()
  expect(events.at(-1)).toEqual({ id: null, reveal: false })
})

test('resolving the final document-order change falls back to the preceding unresolved change', () => {
  const events: Array<{ id: string | null; reveal: boolean }> = []
  const cursor = new ReviewCursor((event) => events.push(event))
  cursor.sync([change('one', 'One'), change('two', 'Two')], 'One. Two.')
  cursor.select('two')

  cursor.settle('two', true)

  expect(cursor.currentId).toBe('one')
  expect(events.at(-1)).toEqual({ id: 'one', reveal: true })
})

test('Accept and next from an unselected card still lands on the following change', () => {
  const events: Array<{ id: string | null; reveal: boolean }> = []
  const cursor = new ReviewCursor((event) => events.push(event))
  cursor.sync([change('one', 'One'), change('two', 'Two')], 'One. Two.')

  cursor.settle('one', true)

  expect(cursor.currentId).toBe('two')
  expect(events.at(-1)).toEqual({ id: 'two', reveal: true })
})

test('a reveal request is honoured once, however often the change list refreshes', () => {
  const listed = [change('one', 'One'), change('two', 'Two')]
  const request = { revealId: 'two', revealSerial: 3 }

  expect(owedReveal(request, null, listed)?.id).toBe('two')
  // The same request against a refreshed list (a new array, as every idle ledger push produces) owes nothing.
  expect(owedReveal(request, 3, [...listed])).toBeNull()
  // A fresh deliberate navigation to the same change is a new serial and reveals again.
  expect(owedReveal({ revealId: 'two', revealSerial: 4 }, 3, listed)?.id).toBe('two')
})

test('a reveal whose change is not listed yet stays owed until the list catches up; no request owes nothing', () => {
  const request = { revealId: 'late', revealSerial: 1 }
  expect(owedReveal(request, null, [change('one', 'One')])).toBeNull()
  expect(owedReveal(request, null, [change('one', 'One'), change('late', 'Late')])?.id).toBe('late')
  expect(owedReveal({ revealId: null, revealSerial: 5 }, null, [change('one', 'One')])).toBeNull()
})
