import { expect, test } from 'bun:test'
import { Command } from 'lucide-react'
import type { SkillMeta } from '../../src/preload'
import { TASK_GROUPS } from '../../src/renderer/src/commands/command-task-groups'
import { buildCommandPaletteSections, type AppCommand } from '../../src/renderer/src/components/CommandPalette'
import {
  TOP_VIEW, commandCountText, groupSubsections, paletteFooterHint, paletteKeyAction, taskGroupCounts, type PaletteView,
} from '../../src/renderer/src/components/palette-groups'

const cmd = (id: string, label: string, group: AppCommand['group'], subgroup: string, extra: Partial<AppCommand> = {}): AppCommand =>
  ({ id, label, group, subgroup, icon: Command, run: () => {}, ...extra })

// Registry order deliberately names "Headings and levels" before "Fold": SUBGROUP_ORDER must still put Fold first.
const commands: AppCommand[] = [
  cmd('heading.increase', 'Increase heading level', 'Shape the document', 'Headings and levels'),
  cmd('fold.all', 'Fold all', 'Shape the document', 'Fold'),
  cmd('fold.current', 'Fold current section', 'Shape the document', 'Fold'),
  cmd('edit.bold', 'Bold', 'Write', 'Format text'),
  cmd('list.bullet', 'Bulleted list', 'Write', 'Lists and checkboxes'),
  cmd('edit.link', 'Link', 'Write', 'Format text'),
  cmd('sync.now', 'Sync now', 'Find and manage files', 'Sync', { disabled: true, disabledReason: 'Not set up' }),
]
const skills: SkillMeta[] = [{ name: 'copy-edit', description: 'Tightens grammar.', icon: 'pen-line', tools: [], input: 'document', source: 'x' }]

const sections = (query: string, view: PaletteView = TOP_VIEW, recentIds: string[] = []) => buildCommandPaletteSections({
  mode: 'commands', query, files: [], folders: [], commands, skills, activeFile: 'a.md', recentIds, view,
})

test('task group counts cover all ten groups in ADR-0043 order', () => {
  const counts = taskGroupCounts(commands)
  expect(counts.map((row) => row.group)).toEqual([...TASK_GROUPS])
  expect(Object.fromEntries(counts.map((row) => [row.group, row.count]))).toMatchObject({ Write: 3, 'Shape the document': 3, 'Find and manage files': 1, Listen: 0 })
  expect(commandCountText(1)).toBe('1 command')
  expect(commandCountText(3)).toBe('3 commands')
})

test('empty top level: Recent, then one row per group, then Skills', () => {
  const out = sections('', TOP_VIEW, ['edit.link'])
  expect(out.map((section) => section.label)).toEqual(['Recent', 'All commands by task', 'Skills — on a.md'])
  expect(out[0].items.map((item) => item.key)).toEqual(['edit.link'])
  const groups = out[1].items
  expect(groups.map((item) => item.kind === 'group' && item.group)).toEqual([...TASK_GROUPS])
})

test('an opened group lists its sub-groups in registry order with every row the count promised', () => {
  const out = sections('', { kind: 'group', group: 'Shape the document' })
  expect(out.map((section) => section.label)).toEqual(['Fold', 'Headings and levels'])
  expect(out.flatMap((section) => section.items.map((item) => item.key))).toEqual(['fold.all', 'fold.current', 'heading.increase'])
  for (const { group, count } of taskGroupCounts(commands)) {
    const rows = sections('', { kind: 'group', group }).flatMap((section) => section.items)
    expect(rows.length).toBe(count)
  }
  // A disabled command keeps its row (and its place in the count) inside its group.
  const files = sections('', { kind: 'group', group: 'Find and manage files' })[0].items[0]
  expect(files.kind === 'command' && files.command.disabled).toBe(true)
})

test('typing inside a group filters within it and drops empty headings', () => {
  const out = sections('fold all', { kind: 'group', group: 'Shape the document' })
  expect(out.map((section) => section.label)).toEqual(['Fold'])
  expect(out[0].items.map((item) => item.key)).toEqual(['fold.all'])
  expect(groupSubsections(commands, 'Shape the document', 'bold')).toEqual([])
})

test('typing at the top level still searches every group at once', () => {
  const out = sections('l')
  const keys = out[0].items.map((item) => item.key)
  expect(out[0].label).toBe('Results')
  expect(keys).toContain('fold.all')
  expect(keys).toContain('edit.link')
  expect(out.at(-1)?.label).toBe('Agent')
})

test('keys: → and ↵ open a group row; ← and ⌫ on an empty input and Esc step back; Esc at top closes', () => {
  const top = TOP_VIEW
  const inGroup: PaletteView = { kind: 'group', group: 'Write' }
  expect(paletteKeyAction({ view: top, query: '', key: 'ArrowRight', selectedIsGroup: true })).toBe('open-group')
  expect(paletteKeyAction({ view: top, query: '', key: 'Enter', selectedIsGroup: true })).toBe('open-group')
  expect(paletteKeyAction({ view: top, query: 'bo', key: 'ArrowRight', selectedIsGroup: false })).toBeNull()
  expect(paletteKeyAction({ view: top, query: '', key: 'Enter', selectedIsGroup: false })).toBeNull()
  expect(paletteKeyAction({ view: top, query: '', key: 'Escape', selectedIsGroup: true })).toBe('close')
  expect(paletteKeyAction({ view: inGroup, query: '', key: 'ArrowLeft', selectedIsGroup: false })).toBe('back')
  expect(paletteKeyAction({ view: inGroup, query: '', key: 'Backspace', selectedIsGroup: false })).toBe('back')
  expect(paletteKeyAction({ view: inGroup, query: 'b', key: 'Backspace', selectedIsGroup: false })).toBeNull()
  expect(paletteKeyAction({ view: inGroup, query: 'b', key: 'ArrowLeft', selectedIsGroup: false })).toBeNull()
  expect(paletteKeyAction({ view: inGroup, query: 'b', key: 'Escape', selectedIsGroup: false })).toBe('back')
})

test('footer hint follows the view', () => {
  expect(paletteFooterHint(TOP_VIEW, '')).toBe('↑↓ move · → open group · ↵ run')
  expect(paletteFooterHint({ kind: 'group', group: 'Listen' }, '')).toBe('← back · ↵ run')
})
