import { expect, test } from 'bun:test'
import { registryCommand } from '../../src/renderer/src/commands/registry'

test('every Plan action is palette-listed and documented in the shortcut sheet', () => {
  const ids = ['plan.open', 'plan.addPart', 'plan.adoptPart', 'plan.moveUp', 'plan.moveDown', 'plan.materialise', 'plan.removePart']
  for (const id of ids) {
    const command = registryCommand(id)
    expect(command.surfaces).toContain('palette')
    expect(command.surfaces).toContain('sheet')
  }
})

test('the primary Plan actions have the approved discoverable defaults', () => {
  expect(registryCommand('plan.addPart').keys).toBe('N')
  expect(registryCommand('plan.adoptPart').label).toBe('Add existing part to Plan')
  expect(registryCommand('plan.adoptPart').keys).toBe('A')
  expect(registryCommand('plan.moveUp').keys).toBe('⌥↑')
  expect(registryCommand('plan.moveDown').keys).toBe('⌥↓')
  expect(registryCommand('plan.materialise').keys).toBe('↵')
  expect(registryCommand('plan.removePart').keys).toBe('⌘⌫')
})
