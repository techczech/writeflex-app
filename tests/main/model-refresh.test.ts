import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import { commandAnnotations } from '../../src/renderer/src/commands/registry-annotations'
import { fuzzyScore } from '../../src/renderer/src/fuzzy'
import { REFRESH_MODELS_COMMAND, runRefreshModelsCommand } from '../../src/renderer/src/commands/model-refresh-command'
import {
  describeModelRefresh,
  lastCheckedLine,
  summariseModelRefresh,
  type ModelRefreshReportLike,
  type ModelRefreshResult,
} from '../../src/shared/model-refresh'

// Fix 04 : "when the provider updates its models, the list is out of date".
// Bridle does the refresh (forced `refreshModels`, empty discovery = failure); WriteFlex reports it.

const AT = new Date(2026, 9, 6, 14, 5, 0).getTime()

function report(overrides: Partial<ModelRefreshReportLike> = {}): ModelRefreshReportLike {
  return { at: AT, discovery: 'succeeded', providers: { 'openai-codex': { added: [], removed: [] } }, ...overrides }
}

test('Refresh models is a keyless, palette-only Agent command the palette finds by its words', () => {
  const command = commandRegistry.find((entry) => entry.id === 'agent.refreshModels')
  expect(command).toMatchObject({ id: 'agent.refreshModels', label: 'Refresh models', group: 'Agent', surfaces: ['palette'] })
  expect(command?.keys).toBeUndefined()
  expect(commandAnnotations['agent.refreshModels']).toEqual({ class: 'settings' })
  for (const word of ['refresh models', 'new models', 'update', 'provider']) {
    const searchable = [command?.label, command?.task, ...(command?.keywords ?? [])].join(' ')
    expect(fuzzyScore(word, searchable), `not found by "${word}"`).not.toBeNull()
  }
  const app = readFileSync(new URL('../../src/renderer/src/app/App.tsx', import.meta.url), 'utf8')
  expect(app).toContain(`id: '${REFRESH_MODELS_COMMAND.id}'`)
  expect(app).toContain('runRefreshModelsCommand(window.writeflex.refreshModels, flash)')
})

test('the Refresh models command flashes progress, then the result with its last-checked time', async () => {
  const flashes: string[] = []
  const result: ModelRefreshResult = summariseModelRefresh(report({
    providers: { 'openai-codex': { added: ['gpt-a', 'gpt-b', 'gpt-c'], removed: [] } },
  }))
  await runRefreshModelsCommand(async () => result, (message) => flashes.push(message), () => AT + 1_000)
  expect(flashes).toEqual(['Refreshing models…', '3 new models · Last checked just now'])

  const reusedFlashes: string[] = []
  await runRefreshModelsCommand(async () => ({ ...result, reused: true }), (message) => reusedFlashes.push(message), () => AT + 1_000)
  expect(reusedFlashes).toEqual(['Refreshing models…', 'Checked just now — 3 new models'])

  const failures: string[] = []
  await runRefreshModelsCommand(async () => { throw new Error('No Workspace is open in this window.') }, (message) => failures.push(message))
  expect(failures).toEqual(['Refreshing models…', "Couldn't refresh models: No Workspace is open in this window."])
})

test('the refresh result names new and removed models, up to date, not signed in, and each failure', () => {
  expect(describeModelRefresh(summariseModelRefresh(report({ providers: { p: { added: ['a'], removed: [] } } })))).toBe('1 new model')
  expect(describeModelRefresh(summariseModelRefresh(report({ providers: { p: { added: ['a', 'b'], removed: ['c'] } } })))).toBe('2 new models, 1 model removed')
  expect(describeModelRefresh(summariseModelRefresh(report({ providers: { p: { added: [], removed: ['c', 'd'] } } })))).toBe('2 models removed')
  expect(summariseModelRefresh(report())).toMatchObject({ status: 'up-to-date', checked: { at: AT, discovery: 'succeeded' } })
  expect(describeModelRefresh(summariseModelRefresh(report()))).toBe('Up to date')
  expect(describeModelRefresh(summariseModelRefresh(report({ discovery: 'skipped', reason: 'not-signed-in' }))))
    .toBe('Sign in to an account to check for new models')
  expect(describeModelRefresh(summariseModelRefresh(report({ discovery: 'failed', reason: 'offline' }))))
    .toBe("Couldn't refresh: you are offline")
  expect(describeModelRefresh(summariseModelRefresh(report({ discovery: 'failed', reason: 'provider-error' }))))
    .toBe("Couldn't refresh: the provider returned an error")
  const empty = summariseModelRefresh(report({ discovery: 'failed', reason: 'empty-catalogue' }))
  expect(empty).toMatchObject({ status: 'failed', reason: 'empty-catalogue', checked: { discovery: 'failed', reason: 'empty-catalogue' } })
  expect(describeModelRefresh(empty)).toBe("Couldn't refresh: the provider listed no models, so the current list was kept")
})

test('a reused forced check reads "Checked just now — {the earlier result}"', () => {
  expect(describeModelRefresh(summariseModelRefresh(report({ reused: true })))).toBe('Checked just now — up to date')
  expect(describeModelRefresh(summariseModelRefresh(report({ reused: true, providers: { p: { added: ['a', 'b', 'c'], removed: [] } } }))))
    .toBe('Checked just now — 3 new models')
  expect(summariseModelRefresh(report({ reused: false }))).not.toHaveProperty('reused')
})

test('the last-checked line reads the time of the check and says when it failed', () => {
  expect(lastCheckedLine(null, AT)).toBe('Model list not checked yet')
  expect(lastCheckedLine({ at: AT, discovery: 'succeeded' }, AT + 30_000)).toBe('Last checked just now')
  expect(lastCheckedLine({ at: AT, discovery: 'succeeded' }, AT + 5 * 60_000)).toBe('Last checked 5 min ago')
  expect(lastCheckedLine({ at: AT, discovery: 'succeeded' }, AT + 2 * 60 * 60_000)).toBe('Last checked today at 14:05')
  expect(lastCheckedLine({ at: AT, discovery: 'succeeded' }, AT + 2 * 24 * 60 * 60_000)).toBe('Last checked on 6 Oct at 14:05')
  expect(lastCheckedLine({ at: AT, discovery: 'failed', reason: 'empty-catalogue' }, AT + 2 * 60_000))
    .toBe('Last check failed 2 min ago (provider listed no models)')
  expect(lastCheckedLine({ at: AT, discovery: 'failed' }, AT)).toBe('Last check failed just now (provider error)')
  expect(lastCheckedLine({ at: AT, discovery: 'skipped', reason: 'not-signed-in' }, AT)).toBe('Last checked just now (not signed in)')
})

test('main asks Bridle, never its own clock: forced refresh on the command, Bridle-throttled on picker open', () => {
  const ipc = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
  expect(ipc).toContain("ipcMain.handle('agent:models-refresh'")
  expect(ipc).toContain('summariseModelRefresh(await modelService.refreshModels({ force: true }))')
  expect(ipc).toContain('pickerRefresh = modelService.refreshModels()')
  expect(ipc).not.toContain('60 * 60 * 1000')
  expect(ipc).toContain("ipcMain.removeHandler('agent:models-refresh')")
  const preload = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
  expect(preload).toContain("refreshModels: () => ipcRenderer.invoke('agent:models-refresh')")
})
