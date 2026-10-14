import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusBar, autosaveAgeLabel } from '../../src/renderer/src/components/StatusBar'
import { statusBarLayout } from '../../src/renderer/src/components/status-bar-model'
import { registryCommand } from '../../src/renderer/src/commands/registry'

const snapshot = {
  docText: '# Heading\n\nOne two three.',
  countText: '# Heading\n\nOne two three.',
  selEmpty: true,
  selFrom: 0,
  selTo: 0,
  selHead: 18,
  outline: [{ level: 1, text: 'Heading', from: 0, to: 9 }],
}

const session = {
  observe: () => {},
  sessionWords: 3,
  elapsedLabel: '0:12',
  wpm: 15,
  idle: false,
  now: 4_500,
}

function renderStatus(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <StatusBar
      snapshot={snapshot}
      workspaceRoot="/tmp/Essays"
      saveLabel="Saved"
      typewriterOn={false}
      onToggleTypewriter={() => {}}
      focus={null}
      onOpenFocusPicker={() => {}}
      readAloud={null}
      goal={null}
      onOpenGoal={() => {}}
      writerMode="drafting"
      session={session}
      status=""
      outboxWaiting={0}
      outboxRejected={0}
      outboxNeedsZoteroClosed={false}
      onSyncHighlights={() => {}}
      onOpenRejectedHighlights={() => {}}
      version="0.18.0-alpha.6"
      collectionName="Essays"
      onMessageAgent={() => {}}
      {...overrides}
    />,
  )
}

test('the idle resident set contains the collection, disclosure, instrument, agent affordance, and development version only', () => {
  const html = renderStatus()
  expect(html).toContain('class="sb-collection"')
  expect(html).toContain('>Essays</span>')
  expect(html).toContain('aria-label="Show status details"')
  expect(html).toContain('class="count-btn statusbar-instrument-cell"')
  expect(html).toContain('Message the agent…')
  expect(html).not.toContain('Saved')
  expect(html).not.toContain('Typewriter off')
  expect(html).not.toContain('15 wpm')
  expect(html).not.toContain('characters</span>')
  expect(html).not.toContain('>H1<')
})

test('the goal gauge is the same single resident instrument cell', () => {
  const html = renderStatus({ goal: { words: 125, target: 1_000, due: null } })
  expect(html).toContain('class="goal-gauge statusbar-instrument-cell"')
  expect(html).not.toContain('class="count-btn statusbar-instrument-cell"')
})

test('an explicit session owns the instrument measurement even when a goal exists', () => {
  const html = renderStatus({
    explicitSession: {
      id: 'session-1',
      status: 'running',
      startedAt: 1_000,
      lastActivityAt: 1_000,
      durationMs: 30 * 60_000,
      targetWords: null,
      tick: false,
      netWords: 0,
    },
    goal: { words: 125, target: 1_000, due: '2026-08-15' },
  })
  expect(html).toContain('data-sb-measure="instrument-session"')
  expect(html).not.toContain('data-sb-measure="instrument-full"')
  expect(html).toContain('29:56 left · +0 words')
})

test('mode chips exist only while their mode is active', () => {
  expect(renderStatus()).not.toContain('class="tw-chip')
  const active = renderStatus({
    typewriterOn: true,
    focus: { mode: 'fade', leadStyle: 'contrast' },
  })
  expect(active).toContain('class="tw-chip on"')
  expect(active).toContain('aria-label="Typewriter mode on"')
  expect(active).toContain('<span>Typewriter</span>')
  expect(active).toContain('class="focus-chip"')
  expect(active).toContain('Focus: Fade')

  const reviewing = renderStatus({ writerMode: 'reviewing' })
  expect(reviewing).toContain('class="reviewing-chip"')
  expect(reviewing).toContain('Reviewing')
})

test('development defaults false and only an explicit development build shows the version', () => {
  expect(renderStatus()).not.toContain('v0.18.0-alpha.6')
  expect(renderStatus({ development: true })).toContain('v0.18.0-alpha.6')
})

test('the event slot uses one tenant directly and collapses several into one count', () => {
  const one = renderStatus({ outboxRejected: 4 })
  expect(one).toContain('class="sb-event-chip')
  expect(one).toContain('4 highlights refused')
  expect(one).toContain('class="sb-event-label"')

  const several = renderStatus({ outboxWaiting: 2, outboxRejected: 4 })
  expect(several.match(/class="sb-event-chip/g)?.length).toBe(1)
  expect(several).toContain('2 attention events')
})

test('pending and failed saves use an amber glyph whose tooltip names the file', () => {
  const pending = renderStatus({ saveState: { kind: 'pending', path: 'drafts/essay.md' } })
  expect(pending).toContain('data-event-kind="save-pending"')
  expect(pending).toContain('Saving essay.md')
  expect(pending).not.toContain('>Saving…<')

  const failed = renderStatus({ saveState: { kind: 'failed', path: 'drafts/essay.md' } })
  expect(failed).toContain('data-event-kind="save-failed"')
  expect(failed).toContain('Could not save essay.md')
})

test('absorption removes attention and other modes before the typewriter indicator', async () => {
  const module = await import('../../src/renderer/src/components/StatusBar') as Record<string, unknown>
  expect(typeof module.statusBarAbsorption).toBe('function')
  const absorb = module.statusBarAbsorption as (
    available: number,
    residents: number,
    event: number,
    modes: Array<{ id: string; width: number }>,
  ) => string[]
  const modes = [{ id: 'reviewing', width: 84 }, { id: 'focus', width: 96 }, { id: 'typewriter', width: 88 }]
  expect(absorb(900, 500, 120, modes)).toEqual([])
  expect(absorb(770, 500, 120, modes)).toEqual(['event'])
  expect(absorb(600, 500, 120, modes)).toEqual(['event', 'reviewing', 'focus'])
})

test('the narrow-width ladder preserves typewriter through the resident degradations', () => {
  const modes = [{ id: 'reviewing' as const, width: 84 }, { id: 'focus' as const, width: 96 }, { id: 'typewriter' as const, width: 88 }]
  const savings = { collectionWidth: 240, collectionFloor: 96, goalDueWidth: 70, agentLabelWidth: 100 }

  expect(statusBarLayout(600, 500, 120, modes, savings)).toEqual({
    absorbed: ['event', 'reviewing', 'focus'],
    collectionAtFloor: false,
    goalWithoutDue: false,
    agentIconOnly: false,
    typewriterPriority: false,
  })
  expect(statusBarLayout(300, 500, 120, modes, savings)).toEqual({
    absorbed: ['event', 'reviewing', 'focus'],
    collectionAtFloor: true,
    goalWithoutDue: true,
    agentIconOnly: true,
    typewriterPriority: false,
  })
  expect(statusBarLayout(250, 500, 120, modes, savings)).toEqual({
    absorbed: ['event', 'reviewing', 'focus', 'typewriter'],
    collectionAtFloor: true,
    goalWithoutDue: true,
    agentIconOnly: true,
    typewriterPriority: false,
  })
  expect(statusBarLayout(600, 1_000, 0, [{ id: 'typewriter', width: 88 }], {
    collectionWidth: 0,
    collectionFloor: 0,
    goalDueWidth: 0,
    agentLabelWidth: 0,
  }, true)).toMatchObject({ absorbed: [], typewriterPriority: true })
})

test('the disclosure uses the current-window autosave idiom', () => {
  expect(autosaveAgeLabel(null, 1_000)).toBe('not yet this window')
})

test('the disclosure reports elapsed autosave age from the shared session tick', () => {
  expect(autosaveAgeLabel(1_000, 4_500)).toBe('3 s ago')
})

test('the disclosure is palette-listed with a free default chord', () => {
  const command = registryCommand('statusbar.disclosure')
  expect(command.label).toBe('Show status details')
  expect(command.keys).toBe('⌃⌘I')
  expect(command.surfaces).toContain('palette')
})
