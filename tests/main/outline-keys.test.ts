import { expect, test } from 'bun:test'
import { classifyOutlineKey, emptySpaceFocusTarget, extendSelection, type OutlineKey } from '../../src/renderer/src/editor/outline-keys'

const key = (name: string, mods: Partial<Omit<OutlineKey, 'key'>> = {}): OutlineKey => ({ key: name, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

test('plain keys move, fold, jump and leave', () => {
  expect(classifyOutlineKey(key('ArrowUp'))).toBe('up')
  expect(classifyOutlineKey(key('ArrowDown'))).toBe('down')
  expect(classifyOutlineKey(key('Home'))).toBe('home')
  expect(classifyOutlineKey(key('End'))).toBe('end')
  expect(classifyOutlineKey(key('ArrowLeft'))).toBe('fold')
  expect(classifyOutlineKey(key('ArrowRight'))).toBe('unfold')
  expect(classifyOutlineKey(key('Enter'))).toBe('jump')
  expect(classifyOutlineKey(key('Escape'))).toBe('escape')
})

test('⌘↵ returns to the editor, ⇧ arrows extend, ⌘K and the menu key open the row menu', () => {
  expect(classifyOutlineKey(key('Enter', { metaKey: true }))).toBe('jumpToEditor')
  expect(classifyOutlineKey(key('ArrowUp', { shiftKey: true }))).toBe('extendUp')
  expect(classifyOutlineKey(key('ArrowDown', { shiftKey: true }))).toBe('extendDown')
  expect(classifyOutlineKey(key('k', { metaKey: true }))).toBe('menu')
  expect(classifyOutlineKey(key('K', { metaKey: true }))).toBe('menu')
  expect(classifyOutlineKey(key('ContextMenu'))).toBe('menu')
})

test('chords that are not the outline’s are left alone: ⇧⌘K quick-open, ⌥⌘K link, ⌥⌘ arrows, ⌘ arrows', () => {
  expect(classifyOutlineKey(key('k', { metaKey: true, shiftKey: true }))).toBeNull()
  expect(classifyOutlineKey(key('k', { metaKey: true, altKey: true }))).toBeNull()
  expect(classifyOutlineKey(key('ArrowUp', { metaKey: true, altKey: true }))).toBeNull()
  expect(classifyOutlineKey(key('ArrowUp', { metaKey: true }))).toBeNull()
  expect(classifyOutlineKey(key('k'))).toBeNull()
})

test('⇧↓ then ⇧↓ picks a growing range from the anchor; ⇧↑ shrinks it back; the ends stop', () => {
  const order = [10, 20, 30, 40]
  const first = extendSelection(order, null, 20, 1)!
  expect(first).toEqual({ selected: [20, 30], focus: 30, anchor: 20 })
  const second = extendSelection(order, first.anchor, first.focus, 1)!
  expect(second.selected).toEqual([20, 30, 40])
  const back = extendSelection(order, second.anchor, second.focus, -1)!
  expect(back.selected).toEqual([20, 30])
  const up = extendSelection(order, 20, 20, -1)!
  expect(up.selected).toEqual([10, 20])
  expect(extendSelection(order, 20, 40, 1)).toBeNull()
  expect(extendSelection(order, null, 10, -1)).toBeNull()
  expect(extendSelection(order, null, 99, 1)).toBeNull()
})

test('a click on empty space focuses the cursor row, else the first row, else nothing', () => {
  expect(emptySpaceFocusTarget([5, 15, 25], 15)).toBe(15)
  expect(emptySpaceFocusTarget([5, 15, 25], 99)).toBe(5)
  expect(emptySpaceFocusTarget([5, 15, 25], null)).toBe(5)
  expect(emptySpaceFocusTarget([], 15)).toBeNull()
})

import { readFileSync } from 'node:fs'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import { conflictsFor } from '../../src/renderer/src/commands/chords'

test('⌘K stays the editor’s and the Files tree’s: no registry command claims it, the editor keymap still binds it, and the outline row menu is documented and in the palette', () => {
  expect(commandRegistry.filter((command) => command.claimsChord !== false && [command.keys].flat().includes('⌘K'))).toEqual([])
  expect(conflictsFor('⌘K', 'outline.rowMenu', {})).toEqual([])
  expect(readFileSync(new URL('../../src/renderer/src/editor/live-preview.ts', import.meta.url), 'utf8')).toContain("key: 'Mod-k'")
  const command = commandRegistry.find((entry) => entry.id === 'outline.rowMenu')!
  expect(command.surfaces).toContain('palette')
  expect(command.keys).toBeUndefined()
  expect(commandRegistry.some((entry) => entry.label === 'Outline row menu (outline row)' && entry.keys === '⌘K')).toBe(true)
  expect(commandRegistry.find((entry) => entry.id === 'view.outline')!.keywords).toContain('focus outline')
})

test('the focused outline row has a visible focus ring that does not depend on :focus-visible', () => {
  const css = readFileSync(new URL('../../src/renderer/src/styles/app.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.ol-item:focus\{outline:2px solid var\(--accent\)/)
})
