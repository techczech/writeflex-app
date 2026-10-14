import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readScopeLabel, runningLineText, skillDisplayName, skillDisplayNameFor } from '../../src/shared/skill-display'
import { skillTitleFromMarkdown } from '../../src/main/skills'
import { renderToStaticMarkup } from 'react-dom/server'
import { SkillRunningLine, scopeChipsForTools } from '../../src/renderer/src/components/AgentSkillSurfaces'

/** Ticket 11: a skill is named by its SKILL.md title, and a folder skill's chip names its folder. */

test('a titled skill shows its title; an untitled one its name in CONTENT.md register', () => {
  expect(skillDisplayName({ name: 'report-structure', title: 'Help with this report' })).toBe('Help with this report')
  expect(skillDisplayName({ name: 'copy-edit' })).toBe('Copy-edit')
  expect(skillDisplayName({ name: 'review', title: '   ' })).toBe('Review')
  expect(skillDisplayName('clean-up')).toBe('Clean-up')
  expect(skillDisplayName('')).toBe('')
})

test('a skill known only by name takes its title from the registry', () => {
  const skills = [{ name: 'copy-edit' }, { name: 'report-structure', title: 'Help with this report' }]
  expect(skillDisplayNameFor('report-structure', skills)).toBe('Help with this report')
  expect(skillDisplayNameFor('copy-edit', skills)).toBe('Copy-edit')
  expect(skillDisplayNameFor('gone', skills)).toBe('Gone')
})

test('the read chip: documents unchanged, a folder skill works on its named folder', () => {
  expect(readScopeLabel('document')).toBe('reads this document')
  expect(readScopeLabel('document', 'reports/strategy')).toBe('reads this document')
  expect(readScopeLabel('selection')).toBe('reads this document')
  expect(readScopeLabel('folder', 'reports/strategy')).toBe('works on this folder · strategy')
  expect(readScopeLabel('folder', 'strategy/')).toBe('works on this folder · strategy')
  expect(readScopeLabel('folder', null)).toBe('works on a folder')
  expect(readScopeLabel('folder', '')).toBe('works on a folder')
})

test('scope chips carry the folder wording only for a folder skill', () => {
  const tools = ['files.read', 'plan.read', 'prose.insert']
  expect(scopeChipsForTools(tools).map((chip) => chip.label)).toEqual(['staged edits only', 'reads this document'])
  expect(scopeChipsForTools(tools, { input: 'folder', folder: 'reports/strategy' }).map((chip) => chip.label))
    .toEqual(['staged edits only', 'works on this folder · strategy'])
})

test('the title is read from SKILL.md frontmatter, top level only', () => {
  expect(skillTitleFromMarkdown('---\nname: x\ntitle: Help with this report\n---\nBody')).toBe('Help with this report')
  expect(skillTitleFromMarkdown('﻿---\nname: x\ntitle: "Quoted"\n---\nBody')).toBe('Quoted')
  expect(skillTitleFromMarkdown('---\nname: x\ntrigger:\n  title: nested\n---\nBody')).toBeUndefined()
  expect(skillTitleFromMarkdown('---\nname: x\ntitle:\n---\nBody')).toBeUndefined()
  expect(skillTitleFromMarkdown('no frontmatter')).toBeUndefined()
})

test('the shipped report skill is titled with its launch-point label', () => {
  const raw = readFileSync(resolve('resources/skills/report-structure/SKILL.md'), 'utf8')
  expect(skillTitleFromMarkdown(raw)).toBe('Help with this report')
  expect(raw).toContain('label: Help with this report')
  for (const name of ['copy-edit', 'review', 'clean-up']) {
    expect(skillTitleFromMarkdown(readFileSync(resolve(`resources/skills/${name}/SKILL.md`), 'utf8'))).toBeUndefined()
  }
})

test('the running line: a folder skill reads its named folder; document skills unchanged', () => {
  expect(runningLineText('Help with this report', false, 'folder', 'reports/strategy')).toBe('Help with this report is reading strategy…')
  expect(runningLineText('Help with this report', false, 'folder', null)).toBe('Help with this report is reading the folder…')
  expect(runningLineText('Help with this report', false, 'folder', '')).toBe('Help with this report is reading the folder…')
  expect(runningLineText('Help with this report', true, 'folder', 'reports/strategy')).toBe('Help with this report is staging changes…')
  expect(runningLineText('Copy-edit', false, 'document', 'reports/strategy')).toBe('Copy-edit is reading your document…')
  expect(runningLineText('Copy-edit', false)).toBe('Copy-edit is reading your document…')
  expect(runningLineText('Copy-edit', true)).toBe('Copy-edit is staging changes…')
})

test('the running line renders the folder wording for the report skill', () => {
  const skills = [{ name: 'report-structure', title: 'Help with this report' }]
  const html = renderToStaticMarkup(
    <SkillRunningLine skillName="report-structure" skills={skills} input="folder" folder="reports/strategy" staging={false} onCancel={() => {}} />,
  )
  expect(html).toContain('Help with this report is reading strategy…')
  expect(html).not.toContain('your document')
  expect(renderToStaticMarkup(<SkillRunningLine skillName="copy-edit" staging={false} onCancel={() => {}} />)).toContain('Copy-edit is reading your document…')
})
