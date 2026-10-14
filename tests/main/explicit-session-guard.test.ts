import { expect, test } from 'bun:test'
import { endRunningExplicitSessions, SESSION_TAKEOVER_MESSAGE } from '../../src/main/explicit-session-guard'

test('starting in a second window ends the first recorder and flashes both window states', async () => {
  const first = { name: 'first', explicitSession: { active: true } }
  const second = { name: 'second', explicitSession: null }
  const closed: string[] = []
  const messages: Array<[string, string]> = []

  await endRunningExplicitSessions(
    [first, second],
    second,
    async (state) => { closed.push(state.name); state.explicitSession = { active: false } },
    (state, message) => messages.push([state.name, message]),
  )

  expect(closed).toEqual(['first'])
  expect(messages).toEqual([
    ['first', SESSION_TAKEOVER_MESSAGE],
    ['second', SESSION_TAKEOVER_MESSAGE],
  ])
})

test('restarting in one window also reports the takeover', async () => {
  const only = { name: 'only', explicitSession: { active: true } }
  const messages: string[] = []
  await endRunningExplicitSessions([only], only, async (state) => { state.explicitSession = { active: false } }, (_state, message) => messages.push(message))
  expect(messages).toEqual([SESSION_TAKEOVER_MESSAGE])
})
