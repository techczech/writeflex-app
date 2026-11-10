import { expect, test } from 'bun:test'
import { ReadingRoomContexts } from '../../src/main/reading-room-context'
function event(id: number): any {
  const mainFrame = { processId: id, routingId: 1, origin: 'file://' }
  return { senderFrame: mainFrame, sender: { id, mainFrame, isDestroyed: () => false, on() {}, once() {} } }
}
test('document authority is specific to the main window and is rechecked after await', async () => {
  const contexts = new ReadingRoomContexts(), one = event(1), two = event(2)
  contexts.run(one, () => contexts.select('/synthetic/one.md'))
  contexts.run(two, () => contexts.select('/synthetic/two.md'))
  expect(contexts.run(one, () => contexts.current().draftPath)).toBe('/synthetic/one.md')
  expect(contexts.run(two, () => contexts.current().draftPath)).toBe('/synthetic/two.md')
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const late = contexts.run(one, async () => { await gate; contexts.check() })
  contexts.run(one, () => contexts.select('/synthetic/replacement.md'))
  finish()
  await expect(late).rejects.toThrow('stale')
  contexts.invalidate(2)
  expect(() => contexts.run({ ...two, senderFrame: null }, () => {})).toThrow('main frame')
})
