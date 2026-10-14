import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SkillMeta, ThreadMeta } from '../../src/preload'
import {
  ArmedSkillCard,
  SkillCompletionToast,
  SkillThreadBanner,
  ThreadSwitcherPopover,
  orderSkills,
  scopeChipsForTools,
} from '../../src/renderer/src/components/AgentSkillSurfaces'

const skills: SkillMeta[] = [
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

const threads: ThreadMeta[] = [
  { id: 'active', kind: 'chat', title: 'Current chat', lastActiveAt: 400 },
  { id: 'older', kind: 'chat', title: 'Plan the essay', lastActiveAt: 200 },
  { id: 'skill', kind: 'skill', skillName: 'copy-edit', title: 'Tighten section two', lastActiveAt: 300 },
]

test('one exported helper assigns palette, switcher, and chord order from CONTENT.md', () => {
  expect(orderSkills([
    { name: 'zebra' },
    { name: 'clean-up' },
    { name: 'review' },
    { name: 'copy-edit' },
    { name: 'alpha' },
  ]).map((skill) => skill.name)).toEqual(['copy-edit', 'review', 'clean-up', 'alpha', 'zebra'])
})

test('thread switcher renders skills with both verbs, recent threads, and the manager door', () => {
  const html = renderToStaticMarkup(
    <ThreadSwitcherPopover
      skills={skills}
      skillErrors={[]}
      threads={threads}
      activeThreadId="active"
      onNewChat={() => {}}
      onOpenSkill={() => {}}
      onRunSkill={() => {}}
      onActivateThread={() => {}}
      onCloseThread={() => {}}
      onManageSkills={() => {}}
      onClose={() => {}}
    />,
  )

  expect(html).toContain('New chat')
  expect(html).toContain('Everything the app can do')
  expect(html).toContain('Copy-edit')
  expect(html).toContain('Tightens grammar, punctuation and clarity. Never rewrites your voice.')
  expect(html.match(/>Run as-is<\/button>/g)?.length).toBe(2)
  expect(html.match(/>Open thread<\/button>/g)?.length).toBe(2)
  expect(html).toContain('Tighten section two')
  expect(html).toContain('Copy-edit ·')
  expect(html).toContain('Plan the essay')
  expect(html).toContain('Current chat')
  expect(html).toContain('aria-current="page"')
  expect(html).toContain('Close conversation: Current chat')
  expect(html).toContain('Manage skills')
})

test('thread switcher keeps healthy skills visible and appends the first registry error', () => {
  const html = renderToStaticMarkup(
    <ThreadSwitcherPopover
      skills={skills}
      skillErrors={[{ source: 'broken/SKILL.md', message: 'frontmatter is malformed' }]}
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

  expect(html).toContain('Copy-edit')
  expect(html).toContain('A skill failed to load — frontmatter is malformed')
})

test('parallel conversations are newest-first and keep the active conversation visible', () => {
  const manyThreads: ThreadMeta[] = [
    { id: 'active', kind: 'chat', title: 'Active', lastActiveAt: 999 },
    ...Array.from({ length: 7 }, (_, index) => ({
      id: `t${index}`,
      kind: 'chat' as const,
      title: `Recent ${index}`,
      lastActiveAt: 100 + index,
    })),
  ]
  const html = renderToStaticMarkup(
    <ThreadSwitcherPopover
      skills={[]}
      skillErrors={[]}
      threads={manyThreads}
      activeThreadId="active"
      onNewChat={() => {}}
      onOpenSkill={() => {}}
      onRunSkill={() => {}}
      onActivateThread={() => {}}
      onCloseThread={() => {}}
      onManageSkills={() => {}}
      onClose={() => {}}
    />,
  )

  expect(html).toContain('Active')
  expect(html).toContain('aria-current="page"')
  expect(html).toContain('Recent 0')
  expect(html).toContain('Recent 1')
  expect(html.indexOf('Recent 6')).toBeLessThan(html.indexOf('Recent 5'))
  expect(html.match(/Open thread: Recent/g)?.length).toBe(14)
})

test('scope chips derive every ADR vocabulary class and deduplicate repeated tools', () => {
  const chips = scopeChipsForTools([
    'prose.edit',
    'prose.revise',
    'files.read',
    'files.list',
    'frontmatter.set',
    'housekeeping.create_file',
    'folio.update',
    'scraps.add',
  ])

  expect(chips.map((chip) => chip.label)).toEqual([
    'staged edits only',
    'reads this document',
    'housekeeping — auto-applied',
    'scratchpad',
  ])

  const html = renderToStaticMarkup(
    <SkillThreadBanner skill={{ ...skills[0], tools: ['prose.edit', 'prose.revise', 'files.read'] }} running={false} hasTranscript={false} onManageSkills={() => {}} onRunAsIs={() => {}} />,
  )
  expect(html.match(/staged edits only/g)?.length).toBe(1)
  expect(html.match(/reads this document/g)?.length).toBe(1)
})

test('armed card covers open-document, missing-document, and already-spoken states', () => {
  const open = renderToStaticMarkup(
    <ArmedSkillCard skill={skills[0]} activeFile="drafts/metaphors.md" transcriptEmpty running={false} onRunAsIs={() => {}} />,
  )
  expect(open).toContain('Run on metaphors.md')
  expect(open).toContain('As written — or add instructions below first.')
  expect(open).toContain('Run as-is')

  const missing = renderToStaticMarkup(
    <ArmedSkillCard skill={skills[0]} activeFile={null} transcriptEmpty running={false} onRunAsIs={() => {}} />,
  )
  expect(missing).toContain('Open a document to run Copy-edit.')
  expect(missing).not.toContain('Run as-is')

  const spoken = renderToStaticMarkup(
    <ArmedSkillCard skill={skills[0]} activeFile="draft.md" transcriptEmpty={false} running={false} onRunAsIs={() => {}} />,
  )
  expect(spoken).toBe('')
})

test('completion toast renders staged, review-notes, and failure variants', () => {
  const staged = renderToStaticMarkup(
    <SkillCompletionToast toast={{ kind: 'staged', skillName: 'copy-edit', count: 4 }} onDismiss={() => {}} onReview={() => {}} onOpenNotes={() => {}} />,
  )
  expect(staged).toContain('Copy-edit staged 4 changes')
  expect(staged).toContain('Review ›')
  expect(staged).toContain('opens Reviewing')

  const notes = renderToStaticMarkup(
    <SkillCompletionToast toast={{ kind: 'notes', skillName: 'review', path: 'draft.review.md' }} onDismiss={() => {}} onReview={() => {}} onOpenNotes={() => {}} />,
  )
  expect(notes).toContain('Review left notes')
  expect(notes).toContain('Open notes ›')

  const failed = renderToStaticMarkup(
    <SkillCompletionToast toast={{ kind: 'error', skillName: 'copy-edit', details: 'The model could not finish.' }} onDismiss={() => {}} onReview={() => {}} onOpenNotes={() => {}} />,
  )
  expect(failed).toContain('Copy-edit stopped — nothing was changed.')
  expect(failed).toContain('Details')
  expect(failed).not.toContain('The model could not finish.')
})
