import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import { commandAnnotations } from '../../src/renderer/src/commands/registry-annotations'
import { fuzzyScore } from '../../src/renderer/src/fuzzy'
import { runThemeCommand, THEME_COMMANDS, THEME_SETTING } from '../../src/renderer/src/commands/theme-commands'

// Requirement: "I don't know how to switch to dark theme — no command for it."
// `appearance.theme` holds 'light' | 'dark' only (SettingsWindow VALUE_DISPLAY), so there is no
// "Follow system theme" command.

test('Use dark theme and Use light theme are keyless, palette-only settings commands', () => {
  const expected = new Map([['appearance.darkTheme', 'Use dark theme'], ['appearance.lightTheme', 'Use light theme']])
  for (const [id, label] of expected) {
    const own = id === 'appearance.darkTheme' ? 'dark' : 'light'
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
  for (const id of expected.keys()) expect(app, `${id} has no App runner`).toContain(`id: '${id}'`)
})

test('running a theme command writes appearance.theme through the settings setter', () => {
  const writes: Array<[string, unknown, string]> = []
  const set = (key: string, value: string | number | boolean | null, label: string): void => { writes.push([key, value, label]) }
  expect(runThemeCommand('appearance.darkTheme', set)).toBe(true)
  expect(runThemeCommand('appearance.lightTheme', set)).toBe(true)
  expect(runThemeCommand('appearance.systemTheme', set)).toBe(false)
  expect(writes).toEqual([[THEME_SETTING, 'dark', 'Theme'], [THEME_SETTING, 'light', 'Theme']])
  expect(THEME_COMMANDS.map((command) => command.value)).toEqual(['dark', 'light'])
})
