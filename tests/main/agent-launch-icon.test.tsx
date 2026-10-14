import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ListOrdered } from 'lucide-react'
import type { SkillMeta } from '../../src/preload'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import { renderActionsHere, renderedRows } from '../helpers/actions-here-render'
import { PlanProjectionNav } from '../../src/renderer/src/components/PlanView'
import { CommandPalette, type AppCommand } from '../../src/renderer/src/components/CommandPalette'
import { ArmedSkillCard, SkillThreadBanner, ThreadSwitcherPopover } from '../../src/renderer/src/components/AgentSkillSurfaces'
import { RightPaneTabs } from '../../src/renderer/src/components/RightPaneTabs'
import { AGENT_ICON, launchesAgent } from '../../src/renderer/src/components/agent-icon'
import { FOLDER_REPORT_SKILL_COMMAND, REPORT_SKILL, REPORT_SKILL_COMMAND } from '../../src/renderer/src/plan/report-skill'

/** Ticket 12: every control that starts an agent run shows the Agent tab's icon before its label. */

/** The Agent tab's icon, as lucide renders it: the class every launch point must carry too. */
const agentIconClass = (): string => {
  const svg = renderToStaticMarkup(<AGENT_ICON />)
  const match = svg.match(/lucide-[a-z0-9-]+/g)?.find((name) => name !== 'lucide-icon')
  if (!match) throw new Error(`no lucide icon class in ${svg}`)
  return match
}
const AGENT = agentIconClass()

const reportSkill: SkillMeta = {
  name: REPORT_SKILL,
  title: 'Help with this report',
  description: 'Helps with a report as a whole.',
  icon: 'list-ordered',
  tools: ['files.read', 'plan.read', 'plan.propose'],
  input: 'folder',
  source: 'resources/skills/report-structure/SKILL.md',
}
const copyEdit: SkillMeta = { ...reportSkill, title: undefined, name: 'copy-edit', description: 'Tightens grammar.', icon: 'pen-line', tools: ['files.read', 'prose.edit'], input: 'document' }

test('the Agent tab wears the agent icon', () => {
  const html = renderToStaticMarkup(<RightPaneTabs active="agent" onSelect={() => {}} />)
  const agentTab = html.split('<button').find((button) => button.includes('title="Agent (⌘J)"'))
  expect(agentTab).toBeDefined()
  expect(agentTab).toContain(AGENT)
})

test('an agent launch is exactly a thread.run command', () => {
  const agentCommands = commandRegistry.filter((command) => launchesAgent(command.id)).map((command) => command.id).sort()
  // Ask the agent about this… (Actions here ticket 03) hands work to the agent too, though it is no thread.run.
  expect(agentCommands).toEqual([
    'agent.askHere',
    FOLDER_REPORT_SKILL_COMMAND,
    'skill.run.clean-up',
    'skill.run.copy-edit',
    REPORT_SKILL_COMMAND,
    'skill.run.review',
  ].sort())
  expect(launchesAgent('folder.rename')).toBe(false)
  expect(launchesAgent('app.agent')).toBe(false)
})

test('Actions here at a folder shows the agent icon before Help with this report, and on no other row (the others wear their own icons)', () => {
  for (const place of ['folder', 'focused-folder'] as const) {
    const rows = renderedRows(renderActionsHere(place))
    const help = rows.find((row) => row.label === 'Help with this report')
    expect(help).toBeDefined()
    expect(help!.markup).toContain(AGENT)
    expect(help!.markup).toContain('agent-icon')
    // The icon comes before the label.
    expect(help!.markup.indexOf(AGENT)).toBeLessThan(help!.markup.indexOf('Help with this report'))
    // Every row now wears an icon (the drawn menu); the agent's is the only one in the agent class.
    for (const row of rows) {
      expect(row.markup).toContain('<svg')
      if (row.label !== 'Help with this report') expect(row.markup).not.toContain('agent-icon')
    }
  }
})

test('Actions here at a file: every row carries an icon, none of them the agent’s', () => {
  for (const row of renderedRows(renderActionsHere('file'))) {
    expect(row.markup).toContain('<svg')
    expect(row.markup).not.toContain('agent-icon')
  }
})

test("the Plan pane's Help with this report shows the agent icon, not the skill's own", () => {
  const html = renderToStaticMarkup(<PlanProjectionNav onOpenBoard={() => {}} onHelpWithReport={() => {}} />)
  const start = html.indexOf('skill-trigger')
  const button = html.slice(start, html.indexOf('</button>', start) + '</button>'.length)
  expect(button).toContain(AGENT)
  // The icon, then the label.
  expect(button).toContain('</svg>Help with this report</button>')
  expect(button).not.toContain('lucide-list-ordered')
})

const renderPalette = (commands: AppCommand[], skills: SkillMeta[] = [], activeFile: string | null = 'notes/a.md'): string => renderToStaticMarkup(
  <CommandPalette
    mode="commands"
    files={[]}
    folders={[]}
    commands={commands}
    skills={skills}
    activeFile={activeFile}
    recentIds={[]}
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

/** The palette's rows (each a <button class="pal-row…">), keyed by the name they show. */
const paletteRows = (html: string): Map<string, string> => {
  const rows = new Map<string, string>()
  for (const chunk of html.split('<button').slice(1)) {
    const name = chunk.match(/<span class="pal-name">([^<]*)<\/span>/)?.[1]
    if (name) rows.set(name, chunk.slice(0, chunk.indexOf('</button>')))
  }
  return rows
}

test('the palette row for the report skill shows the agent icon; other commands keep theirs', () => {
  // Handed a non-agent icon, as App could: the palette still draws the agent's for an agent launch.
  const rows = paletteRows(renderPalette([
    { id: REPORT_SKILL_COMMAND, label: 'Help with this report', group: 'Skills', icon: ListOrdered, run: () => {} },
    { id: 'plan.open', label: 'Open Plan', group: 'Navigation', icon: ListOrdered, run: () => {} },
  ]))
  const report = rows.get('Help with this report')
  expect(report).toContain(AGENT)
  expect(report).toContain('agent-icon')
  expect(report).not.toContain('lucide-list-ordered')
  const plan = rows.get('Open Plan')
  expect(plan).toContain('lucide-list-ordered')
  expect(plan).not.toContain(AGENT)
})

test("the palette's skill rows, which run on ↵, show the agent icon", () => {
  const rows = paletteRows(renderPalette([], [copyEdit]))
  const row = rows.get('Copy-edit')
  expect(row).toContain(AGENT)
  expect(row).not.toContain('lucide-pen-line')
})

test('every Run as-is on a document skill shows the agent icon', () => {
  const armed = renderToStaticMarkup(<ArmedSkillCard skill={copyEdit} activeFile="notes/a.md" transcriptEmpty running={false} onRunAsIs={() => {}} />)
  expect(armed).toContain('Run on a.md')
  expect(armed.slice(armed.indexOf('<button'))).toContain(AGENT)

  const banner = renderToStaticMarkup(<SkillThreadBanner skill={copyEdit} running={false} hasTranscript onManageSkills={() => {}} onRunAsIs={() => {}} />)
  const runButton = banner.slice(banner.lastIndexOf('<button', banner.indexOf('Run as-is')))
  expect(runButton.slice(0, runButton.indexOf('</button>'))).toContain(AGENT)

  const popover = renderToStaticMarkup(
    <ThreadSwitcherPopover
      skills={[copyEdit]}
      skillErrors={[]}
      threads={[]}
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
  const run = popover.slice(popover.lastIndexOf('<button', popover.indexOf('>Run as-is<')))
  expect(run.slice(0, run.indexOf('</button>'))).toContain(AGENT)
  // Open thread starts no run, so it stays plain.
  const open = popover.slice(popover.lastIndexOf('<button', popover.indexOf('>Open thread<')))
  expect(open.slice(0, open.indexOf('</button>'))).not.toContain('<svg')
})
