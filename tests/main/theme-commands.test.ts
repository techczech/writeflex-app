import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import { commandAnnotations } from '../../src/renderer/src/commands/registry-annotations'
import { fuzzyScore } from '../../src/renderer/src/fuzzy'
import { runThemeCommand, THEME_COMMANDS } from '../../src/renderer/src/commands/theme-commands'

import { THEME_SETTING, usesDarkTheme } from '../../src/shared/appearance'

test('appearance commands are keyless, palette-listed and discoverable', () => {
  const expected = new Map([['appearance.darkTheme', 'Use dark theme'], ['appearance.lightTheme', 'Use light theme'], ['appearance.systemTheme', 'Match system']])
  for (const [id, label] of expected) {
    const own = id.slice('appearance.'.length, -'Theme'.length)
    const command = commandRegistry.find((entry) => entry.id === id)
    expect(command).toMatchObject({ id, label, group: 'App', surfaces: ['palette'] })
    expect(command?.keys).toBeUndefined()
    expect(commandAnnotations[id]).toEqual({ class: 'settings' })
    for (const word of [own, 'theme', 'appearance']) {
      const searchable = [command?.label, command?.task, ...(command?.keywords ?? [])].join(' ')
      expect(fuzzyScore(word, searchable), `${id} is not found by "${word}"`).not.toBeNull()
    }
  }
  const app = readFileSync(new URL('../../src/renderer/src/app/App.tsx', import.meta.url), 'utf8')
  expect(app).toContain('THEME_COMMANDS.map')
  expect(app).toContain('runThemeCommand(id, setSetting)')
})

test('running a theme command writes appearance.theme through the settings setter', () => {
  const writes: Array<[string, unknown, string]> = []
  const set = (key: string, value: string | number | boolean | null, label: string): void => { writes.push([key, value, label]) }
  expect(runThemeCommand('appearance.darkTheme', set)).toBe(true)
  expect(runThemeCommand('appearance.lightTheme', set)).toBe(true)
  expect(runThemeCommand('appearance.systemTheme', set)).toBe(true)
  expect(runThemeCommand('appearance.unknownTheme', set)).toBe(false)
  expect(writes).toEqual([[THEME_SETTING, 'dark', 'Theme'], [THEME_SETTING, 'light', 'Theme'], [THEME_SETTING, 'system', 'Theme']])
  expect(THEME_COMMANDS.map((command) => command.value)).toEqual(['dark', 'light', 'system'])
})

test('light is the unset default even on a dark system; only Match system tracks system appearance', () => {
  for (const systemIsDark of [false, true]) {
    expect(usesDarkTheme(undefined, systemIsDark)).toBe(false)
    expect(usesDarkTheme('light', systemIsDark)).toBe(false)
    expect(usesDarkTheme('dark', systemIsDark)).toBe(true)
    expect(usesDarkTheme('system', systemIsDark)).toBe(systemIsDark)
  }
})
