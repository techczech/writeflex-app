import { expect, test } from 'bun:test'
import { EVERYWHERE, INSERT_OBJECT_ROW, NOT_BY_PLACE, PLACES, PLACE_LABELS, commandPlaces, placesOf, type Place } from '../../src/renderer/src/commands/command-places'
import { actionsAt } from '../../src/renderer/src/commands/place'
import { commandRegistry } from '../../src/renderer/src/commands/registry'

const isMirror = (command: { sheetSource?: { kind: string } }): boolean => command.sheetSource?.kind === 'command'

test('every registry command declares its places: a list, everywhere, or not offered by place', () => {
  for (const command of commandRegistry) {
    const declaration = command.places
    expect(declaration, `${command.id} declares`).toBeDefined()
    if (declaration === EVERYWHERE || declaration === NOT_BY_PLACE) continue
    expect(Array.isArray(declaration), `${command.id} is a list`).toBe(true)
    expect(declaration.length, `${command.id} lists at least one place`).toBeGreaterThan(0)
    expect(new Set(declaration).size, `${command.id} lists no place twice`).toBe(declaration.length)
    for (const place of declaration) expect(PLACES as readonly string[], `${command.id} place`).toContain(place)
  }
})

test('the table has a row for every command with a row of its own, and no stale or mirror ids', () => {
  const own = commandRegistry.filter((command) => !isMirror(command)).map((command) => command.id)
  expect(own.filter((id) => !(id in commandPlaces))).toEqual([])
  expect(Object.keys(commandPlaces).filter((id) => !own.includes(id))).toEqual([])
})

test('a command with no row cannot ship: the lookup throws and names the file', () => {
  expect(() => placesOf('made.up')).toThrow('commands/command-places.ts')
})

test('a sheet row that mirrors a command takes that command’s declaration', () => {
  const byId = new Map(commandRegistry.map((command) => [command.id, command]))
  const mirrors = commandRegistry.filter(isMirror)
  expect(mirrors.length).toBeGreaterThan(30)
  for (const row of mirrors) {
    const source = byId.get((row.sheetSource as { commandId: string }).commandId)
    expect(source, `${row.id} source`).toBeDefined()
    expect(row.places, row.id).toBe(source!.places)
  }
})

test('a key-only sheet row cannot be run from a panel, so none is offered by place except the Insert row', () => {
  const offered = commandRegistry.filter((command) => command.sheetSource?.kind === 'literal' && command.places !== NOT_BY_PLACE).map((command) => command.id)
  expect(offered).toEqual([INSERT_OBJECT_ROW])
})

test('every command offered at a place can be run: the registry runs it, or App runs it from the palette or a menu', () => {
  for (const command of commandRegistry) {
    if (command.places === NOT_BY_PLACE || command.id === INSERT_OBJECT_ROW || isMirror(command)) continue
    const runnable = command.run !== undefined || command.surfaces.includes('palette') || command.surfaces.includes('menu')
    expect(runnable, command.id).toBe(true)
    expect(command.future, `${command.id} is built`).toBeUndefined()
  }
})

test('every place has a label and at least one command, and no place lists hundreds', () => {
  for (const place of PLACES) {
    expect(PLACE_LABELS[place], place).toBeTruthy()
    const declared = commandRegistry.filter((command) => !isMirror(command) && command.places !== NOT_BY_PLACE && (command.places === EVERYWHERE || command.places.includes(place)))
    expect(declared.length, place).toBeGreaterThan(0)
    // Turn into and Format children count here although they are not rows (list items declare 26 with ticket 02).
    expect(declared.length, place).toBeLessThanOrEqual(30)
    // With no document open only the commands with a `when` drop out.
    expect(actionsAt(place, null).length, place).toBe(declared.filter((command) => !command.when).length)
  }
})

test('the two pairs of places that share a label differ by the commands the pair is for', () => {
  const sharing = (label: string): Place[] => PLACES.filter((place) => PLACE_LABELS[place] === label)
  expect(sharing('On a heading')).toEqual(['heading', 'heading-top'])
  expect(sharing('On a folder')).toEqual(['folder', 'focused-folder'])
  const labels = PLACES.map((place) => PLACE_LABELS[place])
  expect(new Set(labels).size).toBe(PLACES.length - 2)
})

test('the app-level commands are not offered by place', () => {
  for (const id of ['app.settings', 'app.about', 'app.commandPalette', 'appearance.darkTheme', 'appearance.lightTheme', 'view.actionBar', 'edit.undo', 'fold.all', 'readAloud.pauseResume']) {
    expect(placesOf(id), id).toBe(NOT_BY_PLACE)
  }
})
