import { expect, test } from 'bun:test'
import { closeSettingsForRestart } from '../../src/main/settings-restart'
import { createRestartClose } from '../../src/main/restart-windows'

test('an update waits for the Settings window and editor before stopping backup', async () => {
  let settleSettings = () => {}, settleEditor = (_closed: boolean) => {}
  let closedSettings = false, stoppedBackup = false
  const settings = closeSettingsForRestart({ isDestroyed: () => false, once: (_event, done) => { settleSettings = done }, close: () => { closedSettings = true } })
  const editor = { closed: new Promise<boolean>(r => { settleEditor = r }), abandon: () => false }
  const restart = createRestartClose({
    closeEach: () => [editor, ...settings], finishWork: async () => {},
    backup: () => ({ stop: async () => { stoppedBackup = true; return true }, resume: () => {} }),
    windowCount: () => 0, openWindow: () => {},
  })
  const outcome = restart.close({ live: () => true, onCallOff: () => {} })
  settleEditor(true)
  await Promise.resolve()
  expect(closedSettings).toBe(true)
  expect(stoppedBackup).toBe(false)
  settleSettings()
  expect(await outcome).toBe(true)
  expect(stoppedBackup).toBe(true)
})

test('a refused Settings close prevents an update commit; an absent window adds nothing', async () => {
  expect(closeSettingsForRestart(null)).toEqual([])
  const [attempt] = closeSettingsForRestart({ isDestroyed: () => false, once: () => {}, close: () => { throw new Error('closed process') } })
  expect(await attempt.closed).toBe(false)
})
