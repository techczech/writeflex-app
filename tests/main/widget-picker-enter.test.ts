import { expect, test } from 'bun:test'
import { cancelEnter, listArrived, pressEnter } from '../../src/renderer/src/components/widget-picker-enter'

test('Enter before the list loads is queued, then inserts the first row on arrival', () => {
  const pressed = pressEnter(false, undefined)
  expect(pressed).toEqual({ pending: true, choose: null })
  expect(listArrived(pressed.pending, ['a.html', 'b.html'])).toEqual({ pending: false, choose: 'a.html' })
})

test('Esc or typing cancels the queued Enter', () => {
  const pressed = pressEnter(false, undefined)
  expect(listArrived(cancelEnter(), ['a.html']).choose).toBeNull()
  expect(pressed.pending).toBe(true)
})

test('an empty list does nothing, and a list with no queued Enter inserts nothing', () => {
  expect(listArrived(true, []).choose).toBeNull()
  expect(listArrived(false, ['a.html']).choose).toBeNull()
})

test('Enter after load inserts the selected row, or nothing when there is none', () => {
  expect(pressEnter(true, 'b.html')).toEqual({ pending: false, choose: 'b.html' })
  expect(pressEnter(true, undefined)).toEqual({ pending: false, choose: null })
})
