import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SkillMeta } from '../../src/preload'
import { commandRegistry, registryCommand } from '../../src/renderer/src/commands/registry'
import { renderActionsHere, renderedRows } from '../helpers/actions-here-render'
import { PlanProjectionNav } from '../../src/renderer/src/components/PlanView'
import { ArmedSkillCard, SkillThreadBanner, ThreadSwitcherPopover, skillIcon } from '../../src/renderer/src/components/AgentSkillSurfaces'
import {
  FOLDER_REPORT_SKILL_COMMAND,
  REPORT_SKILL,
  REPORT_SKILL_COMMAND,
  skillLaunchTarget,
} from '../../src/renderer/src/plan/report-skill'

/** Ticket 10: the report skill's three doors — the Plan pane, a folder's menu, the palette command. */

const reportSkill: SkillMeta = {
  name: REPORT_SKILL,
  title: 'Help with this report',
  description: 'Helps with a report as a whole.',
  icon: 'list-ordered',
  tools: ['files.read', 'plan.read', 'plan.compare_parts', 'plan.propose', 'prose.insert'],
  input: 'folder',
  source: 'resources/skills/report-structure/SKILL.md',
}
const copyEdit: SkillMeta = { ...reportSkill, title: undefined, name: 'copy-edit', icon: 'pen-line', tools: ['files.read', 'prose.edit'], input: 'document' }

test('the palette command and the folder menu item are registered under the one label', () => {
  expect(registryCommand(REPORT_SKILL_COMMAND)).toMatchObject({ label: 'Help with this report', group: 'Skills', surfaces: ['palette', 'sheet'] })
  expect(registryCommand(REPORT_SKILL_COMMAND).keys).toBeUndefined()
  expect(registryCommand(FOLDER_REPORT_SKILL_COMMAND)).toMatchObject({ label: 'Help with this report', surfaces: ['menu'] })
  expect(commandRegistry.filter((command) => command.label === 'Help with this report').map((command) => command.id).sort())
    .toEqual([FOLDER_REPORT_SKILL_COMMAND, REPORT_SKILL_COMMAND].sort())
  // The palette command has a runner in App that acts on the focused folder.
  const app = readFileSync(new URL('../../src/renderer/src/app/App.tsx', import.meta.url), 'utf8')
  expect(app).toContain(`id: '${REPORT_SKILL_COMMAND}'`)
  expect(app).toContain('run: () => { if (folderFocus) helpWithReport(folderFocus.path) }')
})

test('every folder row offers Help with this report, focused or not', () => {
  for (const place of ['folder', 'focused-folder'] as const) {
    const item = renderedRows(renderActionsHere(place)).find((row) => row.id === FOLDER_REPORT_SKILL_COMMAND)
    expect(item).toMatchObject({ label: 'Help with this report' })
  }
})

test('a folder skill lands on the focused folder; a document skill still needs its document', () => {
  const on = (skill: SkillMeta, activeFile: string | null, focusedFolder: string | null) =>
    skillLaunchTarget(skill, 'Report-structure', { activeFile, focusedFolder })
  expect(on(reportSkill, 'notes/a.md', 'reports/strategy')).toEqual({ kind: 'folder', dir: 'reports/strategy' })
  expect(on(reportSkill, null, 'reports/strategy')).toEqual({ kind: 'folder', dir: 'reports/strategy' })
  const refused = on(reportSkill, 'notes/a.md', null)
  expect(refused.kind).toBe('refused')
  expect(refused.kind === 'refused' && refused.message).toContain('works on a folder')
  expect(on(copyEdit, 'notes/a.md', 'reports/strategy')).toEqual({ kind: 'document' })
  expect(on(copyEdit, null, 'reports/strategy')).toEqual({ kind: 'refused', message: 'Report-structure needs an open document.' })
})

test('the Plan pane shows the trigger only when it can start the skill', () => {
  const withTrigger = renderToStaticMarkup(<PlanProjectionNav onOpenBoard={() => {}} onHelpWithReport={() => {}} />)
  expect(withTrigger).toContain('class="ghost primary skill-trigger"')
  expect(withTrigger).toContain('Help with this report')
  expect(withTrigger).toContain('aria-label="Collection projection"')
  const without = renderToStaticMarkup(<PlanProjectionNav onOpenBoard={() => {}} />)
  expect(without).not.toContain('skill-trigger')
  expect(skillIcon('list-ordered')).not.toBe(skillIcon(undefined))
})

test('a folder skill thread offers no document run-as-is', () => {
  expect(renderToStaticMarkup(<ArmedSkillCard skill={reportSkill} activeFile="notes/a.md" transcriptEmpty running={false} onRunAsIs={() => {}} />)).toBe('')
  const banner = renderToStaticMarkup(<SkillThreadBanner skill={reportSkill} running={false} hasTranscript onManageSkills={() => {}} onRunAsIs={() => {}} />)
  expect(banner).not.toContain('Run as-is')
  expect(banner).toContain('<strong>Help with this report</strong>')
  expect(banner).not.toContain('Report-structure')
  // Document skills keep theirs.
  expect(renderToStaticMarkup(<SkillThreadBanner skill={copyEdit} running={false} hasTranscript onManageSkills={() => {}} onRunAsIs={() => {}} />)).toContain('Run as-is')
})

test('ticket 11: a folder skill thread names its folder; a document skill still reads this document', () => {
  const launched = renderToStaticMarkup(<SkillThreadBanner skill={reportSkill} folder="reports/strategy" running={false} hasTranscript onManageSkills={() => {}} onRunAsIs={() => {}} />)
  expect(launched).toContain('works on this folder · strategy')
  expect(launched).not.toContain('reads this document')
  // Opened from the switcher before any run: no folder to name yet, and never "this document".
  const unlaunched = renderToStaticMarkup(<SkillThreadBanner skill={reportSkill} running={false} hasTranscript={false} onManageSkills={() => {}} onRunAsIs={() => {}} />)
  expect(unlaunched).toContain('works on a folder')
  expect(unlaunched).not.toContain('reads this document')
  const documentBanner = renderToStaticMarkup(<SkillThreadBanner skill={copyEdit} folder="reports/strategy" running={false} hasTranscript onManageSkills={() => {}} onRunAsIs={() => {}} />)
  expect(documentBanner).toContain('reads this document')
  expect(documentBanner).toContain('<strong>Copy-edit</strong>')
})

test('ticket 11: the switcher lists the report skill and its conversations by its title', () => {
  const html = renderToStaticMarkup(
    <ThreadSwitcherPopover
      skills={[copyEdit, reportSkill]}
      skillErrors={[]}
      threads={[{ id: 't1', kind: 'skill', skillName: REPORT_SKILL, title: 'Help with this report', lastActiveAt: Date.now() }]}
      activeThreadId={null}
      onNewChat={() => {}}
      onOpenSkill={() => {}}
      onRunSkill={() => {}}
      onActivateThread={() => {}}
      onCloseThread={() => {}}
      onManageSkills={() => {}}
      onClose={() => {}}
    />,
  )
  expect(html).toContain('<strong>Help with this report</strong>')
  expect(html).toContain('Help with this report · ')
  expect(html).not.toContain('Report-structure')
  expect(html).toContain('<strong>Copy-edit</strong>')
})
