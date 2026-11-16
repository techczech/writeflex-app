import { expect, test } from 'bun:test'
import { commandCheckStore, createDebouncedPublisher } from '../../src/renderer/src/commands/menu-command-state'

test('mounted command owners publish live checks and release only their own state', () => {
  const store = commandCheckStore()
  let notifications = 0
  const off = store.subscribe(() => { notifications++ })
  const first = store.publish({ 'focus.ruler': true })
  expect(store.snapshot()).toEqual({ 'focus.ruler': true })
  const second = store.publish({ 'focus.ruler': false, 'board.toggleSources': true })
  expect(store.snapshot()).toEqual({ 'focus.ruler': false, 'board.toggleSources': true })
  first()
  expect(store.snapshot()).toEqual({ 'focus.ruler': false, 'board.toggleSources': true })
  second()
  expect(store.snapshot()).toEqual({})
  expect(notifications).toBe(3)
  off()
})

test('publishing trails a burst by the delay, restarts on each schedule, and flushes at once', async () => {
  let published = 0
  const publisher = createDebouncedPublisher(() => { published++ }, 20)
  for (let i = 0; i < 10; i++) publisher.schedule()
  expect(published).toBe(0)
  await new Promise(resolve => setTimeout(resolve, 60))
  expect(published).toBe(1)
  publisher.schedule()
  publisher.flush()
  expect(published).toBe(2)
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(published).toBe(2)
  publisher.schedule()
  publisher.cancel()
  await new Promise(resolve => setTimeout(resolve, 40))
  expect(published).toBe(2)
})
