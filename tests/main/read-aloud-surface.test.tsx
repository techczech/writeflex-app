import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusBar } from '../../src/renderer/src/components/StatusBar'
import { allBindableCommands, allCommands } from '../../src/renderer/src/commands/registry'
import { buildCommandPaletteSections, type AppCommand } from '../../src/renderer/src/components/CommandPalette'
import type { PlayerState } from '../../src/renderer/src/editor/read-aloud-player'

const idleState: PlayerState = { speaking: false, paused: false, sourceOffset: null, word: null, rate: 1 }
const speakingState: PlayerState = { speaking: true, paused: false, sourceOffset: 0, rate: 1.3 }

const session = {
  observe: () => {},
  sessionWords: 0,
  elapsedLabel: '0:00',
  wpm: 0,
  idle: false,
  now: 0,
}

function renderStatus(readAloud: { state: PlayerState; voiceName: string } | null): string {
  return renderToStaticMarkup(
    <StatusBar
      snapshot={null}
      workspaceRoot={null}
      saveLabel={null}
      typewriterOn={false}
      onToggleTypewriter={() => {}}
      focus={null}
      onOpenFocusPicker={() => {}}
      readAloud={readAloud}
      goal={null}
      onOpenGoal={() => {}}
      writerMode="drafting"
      session={session}
      status=""
      version={null}
    />,
  )
}

test('the read-aloud chip exists only for an active reading and formats rate to one decimal', () => {
  expect(renderStatus(null)).not.toContain('data-testid="read-aloud-chip"')
  expect(renderStatus({ state: idleState, voiceName: 'Ava' })).not.toContain('data-testid="read-aloud-chip"')

  const speaking = renderStatus({ state: speakingState, voiceName: 'Ava' })
  expect(speaking).toContain('data-testid="read-aloud-chip"')
  expect(speaking).toContain('Ava · 1.3×')
  expect(speaking).toContain('<svg')
})

test('the active chip names the paused state visibly', () => {
  const paused = renderStatus({
    state: { ...speakingState, paused: true },
    voiceName: 'Ava',
  })
  expect(paused).toContain('Ava · 1.3× · Paused')
})

test('the status-bar chip remains a trace rather than another voice-picker control', () => {
  const speaking = renderStatus({ state: speakingState, voiceName: 'Ava' })
  expect(speaking).toContain('role="status"')
  expect(speaking).not.toContain('<button class="read-aloud-chip')
})

test('the transport bar appears only while reading and keeps every action labelled and icon-based', async () => {
  const componentUrl = new URL('../../src/renderer/src/components/ReadAloudBar.tsx', import.meta.url)
  expect(existsSync(componentUrl)).toBe(true)
  const { ReadAloudBar } = await import('../../src/renderer/src/components/ReadAloudBar')
  const props = {
    voiceName: 'Ava (Premium)',
    onPauseResume: () => {},
    onStop: () => {},
    onSkipSentence: (_direction: 1 | -1) => {},
    onSkipParagraph: (_direction: 1 | -1) => {},
    onOpenReadAloudSettings: () => {},
    onSetRate: (_rate: number) => {},
    readingPositionOutsideViewport: false,
    onReturnToReading: () => {},
  }

  const idle = renderToStaticMarkup(<ReadAloudBar {...props} state={idleState} />)
  expect(idle).not.toContain('data-testid="read-aloud-bar"')

  const speaking = renderToStaticMarkup(<ReadAloudBar {...props} state={speakingState} />)
  expect(speaking).toContain('data-testid="read-aloud-bar"')
  expect(speaking).toContain('Ava (Premium)')
  expect(speaking).toContain('aria-label="Reading speed"')
  expect(speaking).toContain('<option value="1.3" selected="">1.3×</option>')
  expect(speaking.match(/<option/g)?.length).toBe(21)
  expect(speaking).toContain('aria-label="Previous paragraph"')
  expect(speaking).toContain('aria-label="Previous sentence"')
  expect(speaking).toContain('aria-label="Pause reading"')
  expect(speaking).toContain('aria-label="Next sentence"')
  expect(speaking).toContain('aria-label="Next paragraph"')
  expect(speaking).toContain('aria-label="Stop reading"')
  expect(speaking).toContain('aria-label="Open Read aloud settings. Current voice: Ava (Premium)"')
  expect(speaking.match(/<svg/g)?.length).toBe(6)
  expect(speaking).not.toContain('Return to the reading')

  const labels = [
    'Previous paragraph',
    'Previous sentence',
    'Pause reading',
    'Next sentence',
    'Next paragraph',
    'Stop reading',
    'Open Read aloud settings.',
    'Reading speed',
  ]
  const positions = labels.map((label) => speaking.indexOf(`aria-label="${label}`))
  expect(positions.every((position) => position >= 0)).toBe(true)
  expect([...positions].sort((a, b) => a - b)).toEqual(positions)

  const paused = renderToStaticMarkup(
    <ReadAloudBar {...props} state={{ ...speakingState, paused: true }} />,
  )
  expect(paused).toContain('aria-label="Resume reading"')
  expect(paused).not.toContain('Return to the reading')

  const pausedAway = renderToStaticMarkup(
    <ReadAloudBar
      {...props}
      state={{ ...speakingState, paused: true }}
      readingPositionOutsideViewport
    />,
  )
  expect(pausedAway).toContain('aria-label="Return to the reading"')
  expect(pausedAway).toContain('>Return to the reading</span>')
  expect(pausedAway.match(/<svg/g)?.length).toBe(7)

  const speakingAway = renderToStaticMarkup(
    <ReadAloudBar {...props} state={speakingState} readingPositionOutsideViewport />,
  )
  expect(speakingAway).not.toContain('Return to the reading')
})

test('the transport bar is mounted before the editor in normal flow and Read aloud does not open the picker', async () => {
  const app = await Bun.file(new URL('../../src/renderer/src/app/App.tsx', import.meta.url)).text()
  const css = await Bun.file(new URL('../../src/renderer/src/styles/app.css', import.meta.url)).text()
  const barIndex = app.indexOf('<ReadAloudBar')
  const editorIndex = app.indexOf('<EditorPane')

  expect(barIndex).toBeGreaterThan(-1)
  expect(editorIndex).toBeGreaterThan(barIndex)
  expect(app).not.toContain('(showPicker = true)')
  expect(app).not.toContain("if (showPicker) openOverlay('voice')")
  expect(app).not.toContain('<VoicePicker')
  expect(app).not.toContain("openOverlay('voice')")
  expect(app).not.toContain("from '../components/VoicePicker'")

  const barRules = [...css.matchAll(/\.read-aloud-bar(?:[^{]*)\{([^}]*)\}/g)]
    .map((match) => match[1])
    .join('\n')
  expect(barRules).not.toBe('')
  expect(barRules).not.toMatch(/position\s*:\s*(?:absolute|fixed)/)
  expect(barRules).toMatch(/display\s*:\s*grid/)
  expect(barRules).toMatch(/grid-template-columns\s*:\s*minmax\(0,1fr\)\s+auto\s+minmax\(0,1fr\)/)

  const transportRule = css.match(/\.read-aloud-bar-transport\{([^}]*)\}/)?.[1] ?? ''
  expect(transportRule).toMatch(/grid-column\s*:\s*2/)
  expect(transportRule).toMatch(/justify-self\s*:\s*center/)
})

test('manual scrolling and pointer-down in document text pause without reviving follow suspension', async () => {
  const editor = await Bun.file(new URL('../../src/renderer/src/components/EditorPane.tsx', import.meta.url)).text()
  const app = await Bun.file(new URL('../../src/renderer/src/app/App.tsx', import.meta.url)).text()
  const readAloud = await Bun.file(new URL('../../src/renderer/src/editor/read-aloud.ts', import.meta.url)).text()

  expect(editor).toContain('onManualReadAloudScroll')
  expect(editor).toContain('onDocumentPointerDown')
  expect(editor).toContain('pointerdown(event, view)')
  expect(editor).toContain('view.contentDOM.contains(event.target as Node)')
  expect(app).toContain('onManualReadAloudScroll={pauseReadAloudOnManualScroll}')
  expect(app).toContain('onDocumentPointerDown={pauseReadAloudAtCaret}')
  expect(editor).not.toContain('resumeReadAloudFollow')
  expect(editor).not.toContain('createReadAloudFollowController')
  expect(readAloud).not.toContain('createReadAloudFollowController')
})

test('every read-aloud command is reachable in the Keycap Ledger', () => {
  const commands = allBindableCommands().filter((command) => command.id.startsWith('readAloud.'))
  expect(commands.map((command) => command.id).sort()).toEqual([
    'readAloud.chooseVoice',
    'readAloud.faster',
    'readAloud.nextParagraph',
    'readAloud.nextSentence',
    'readAloud.pauseResume',
    'readAloud.previousParagraph',
    'readAloud.previousSentence',
    'readAloud.returnToReading',
    'readAloud.slower',
    'readAloud.start',
    'readAloud.stop',
  ])
  expect(commands.find((command) => command.id === 'readAloud.chooseVoice')?.label).toBe('Read aloud settings…')
})

test('read-aloud transport commands are findable by the writer\'s palette vocabulary', () => {
  const transportIds = new Set([
    'readAloud.nextSentence',
    'readAloud.previousSentence',
    'readAloud.nextParagraph',
    'readAloud.previousParagraph',
  ])
  const commands: AppCommand[] = allCommands()
    .filter((command) => transportIds.has(command.id))
    .map((command) => ({
      id: command.id,
      label: command.label,
      group: command.task,
      subgroup: command.subgroup,
      icon: () => null,
      run: () => {},
    }))

  for (const query of ['read aloud']) {
    const sections = buildCommandPaletteSections({
      mode: 'commands',
      query,
      files: [],
      folders: [],
      commands,
      skills: [],
      activeFile: null,
      recentIds: [],
    })
    const resultIds = sections.flatMap((section) => section.items)
      .filter((item) => item.kind === 'command')
      .map((item) => item.command.id)
    expect(resultIds.sort(), query).toEqual([...transportIds].sort())
  }
})
