import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SkillMeta } from '../../src/preload'
import {
  CommandPalette,
  buildCommandPaletteSections,
  type AppCommand,
} from '../../src/renderer/src/components/CommandPalette'
import { Command } from 'lucide-react'

const skills: SkillMeta[] = [
  {
    name: 'clean-up',
    description: 'Housekeeping: frontmatter order, fields and values. No prose changes.',
    icon: 'eraser',
    tools: ['housekeeping.create_file'],
    input: 'document',
    source: 'resources/skills/clean-up/SKILL.md',
  },
  {
    name: 'copy-edit',
    description: 'Tightens grammar, punctuation and clarity. Never rewrites your voice.',
    icon: 'pen-line',
    tools: ['prose.edit', 'files.read'],
    input: 'document',
    source: 'resources/skills/copy-edit/SKILL.md',
  },
  {
    name: 'review',
    description: 'Reads as a critical reviewer: structure, argument, gaps. Notes, never edits.',
    icon: 'glasses',
    tools: ['files.read', 'housekeeping.create_file'],
    input: 'document',
    source: 'resources/skills/review/SKILL.md',
  },
]

const commands: AppCommand[] = [
  { id: 'copy-path', label: 'Copy file path', group: 'Find and manage files', icon: Command, run: () => {} },
  { id: 'review-pane', label: 'Open Review', group: 'Review and versions', icon: Command, run: () => {} },
]

const renderPalette = (activeFile: string | null, rows = commands, recentIds: string[] = []): string => renderToStaticMarkup(
  <CommandPalette
    mode="commands"
    files={[]}
    folders={[]}
    commands={rows}
    skills={skills}
    activeFile={activeFile}
    recentIds={recentIds}
    onRun={() => {}}
    onOpenFile={() => {}}
    onRevealFile={() => {}}
    onRevealFolder={() => {}}
    onAskAgent={() => {}}
    onRunSkill={() => {}}
    onOpenSkill={() => {}}
    onManageSkills={() => {}}
    onClose={() => {}}
  />,
)

test('empty command palette puts recent commands before unpinned skills and keeps every skill action', () => {
  const html = renderPalette('drafts/metaphors.md', commands, ['review-pane'])

  expect(html.indexOf('>Recent<')).toBeLessThan(html.indexOf('Skills — on metaphors.md'))
  expect(html.indexOf('>Commands<')).toBeLessThan(html.indexOf('Skills — on metaphors.md'))
  expect(html.indexOf('>Copy-edit<')).toBeLessThan(html.indexOf('>Review<'))
  expect(html.indexOf('>Review<')).toBeLessThan(html.indexOf('>Clean-up<'))
  expect(html).toContain('Tightens grammar, punctuation and clarity. Never rewrites your voice.')
  expect(html).toContain('Manage skills…')
})

test('document skills stay visible but disabled when no document is open', () => {
  const html = renderPalette(null)

  expect(html).toContain('>Skills<')
  expect(html).toContain('title="Needs an open document"')
  expect(html).toContain('Copy-edit')
  expect(html).toContain('Review')
  expect(html).toContain('Clean-up')
})

test('future app commands remain visible and cannot be activated', () => {
  const html = renderPalette('draft.md', [
    ...commands,
    { id: 'reading-room-highlights', label: 'Reading Room: Highlights view', group: 'Collect and plan', icon: Command, disabled: true, disabledReason: 'Available when Highlights view ships', run: () => {} },
  ])

  expect(html).toContain('Reading Room: Highlights view')
  expect(html).toContain('disabled=""')
  expect(html).toContain('title="Available when Highlights view ships"')
})

test('every command-palette row shows its task group because results are flat', () => {
  const html = renderPalette('draft.md')

  expect(html).toContain('<span class="pal-command-group">Find and manage files</span>')
  expect(html).toContain('<span class="pal-command-group">Review and versions</span>')
  for (const old of ['Files and versions', 'Reviewing', 'Reading room']) expect(html).not.toContain(`pal-command-group">${old}</span>`)
})

test('a query ranks matching skills and commands together with skill descriptions searchable', () => {
  const byName = buildCommandPaletteSections({
    mode: 'commands', query: 'review', files: [], folders: [], commands, skills, activeFile: 'draft.md', recentIds: [],
  })
  expect(new Set(byName[0]?.items.map((item) => item.key))).toEqual(new Set(['skill:review', 'review-pane']))

  const byDescription = buildCommandPaletteSections({
    mode: 'commands', query: 'punctuation clarity', files: [], folders: [], commands, skills, activeFile: 'draft.md', recentIds: [],
  })
  expect(byDescription[0]?.items.map((item) => item.key)).toEqual(['skill:copy-edit'])
})
