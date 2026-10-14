import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GuideProgressStore } from '../../src/main/guide-progress-store'
import { SettingsStore } from '../../src/main/settings'
import { GUIDE_PROGRESS_KEY, parseGuideProgress } from '../../src/shared/guide-progress'
import { guideNeedsRoom, resolveRightPaneTab, rightPaneTabsFor } from '../../src/renderer/src/app/pane-layout'

// Main's one writer of the Guide's progress (ticket 07): one settings key, any window's event, saved
// only when something changed, never in the settings changelog, and still there when the example goes.

function fresh(): { dir: string; file: string; settings: SettingsStore; store: GuideProgressStore; changes: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'wf-guide-store-'))
  const file = join(dir, 'settings.json')
  const settings = new SettingsStore(file)
  const store = new GuideProgressStore(settings)
  const changes: string[] = []
  store.onChange = (key) => changes.push(key)
  return { dir, file, settings, store, changes }
}

test('events are saved under one key, announced once each, and a repeat changes and announces nothing', () => {
  const { dir, file, store, changes } = fresh()
  try {
    store.commandRan('fold.current')
    store.commandRan('fold.current')
    store.chapterOpened('Shape the document')
    store.chapterOpened('Not a chapter')
    store.commandRan('')
    store.stepDone('folder', 'walking-book')
    store.stepDone('example')
    expect(changes).toEqual([GUIDE_PROGRESS_KEY, GUIDE_PROGRESS_KEY, GUIDE_PROGRESS_KEY, GUIDE_PROGRESS_KEY])
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(saved.values)).toEqual([GUIDE_PROGRESS_KEY])
    expect(parseGuideProgress(saved.values[GUIDE_PROGRESS_KEY])).toEqual({ ran: ['fold.current'], opened: ['Shape the document'], finished: {}, steps: { folder: 'walking-book', example: true }, read: [] })
    // A tick is not "a change made in Settings".
    expect(saved.changelog).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the record is read again by a new store on the same file (a restart), and the example key plays no part', () => {
  const { dir, file, settings, store } = fresh()
  try {
    store.commandRan('fold.all')
    settings.setExampleState('removed')
    const again = new GuideProgressStore(new SettingsStore(file))
    expect(again.read().ran).toEqual(['fold.all'])
    store.chapterFinished('Listen')
    expect(new GuideProgressStore(new SettingsStore(file)).read().finished.Listen).toBeGreaterThan(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the Guide tab is absent by default and last once opened; a chosen tab is respected, and a chosen Guide falls back', () => {
  expect(rightPaneTabsFor(false)).not.toContain('guide')
  expect(rightPaneTabsFor(true).at(-1)).toBe('guide')
  expect(rightPaneTabsFor(true)[0]).toBe('agent')
  expect(resolveRightPaneTab(null, true)).toBe('agent')
  expect(resolveRightPaneTab(null, false)).toBe('agent')
  expect(resolveRightPaneTab('guide', true)).toBe('guide')
  expect(resolveRightPaneTab('review', true)).toBe('review')
  expect(resolveRightPaneTab('scratchpad', false)).toBe('scratchpad')
  expect(resolveRightPaneTab('guide', false)).toBe('agent')
})

test('the narrow-window rule: the editor keeps 560px, so a 900px window with a 340px pane closes the Files pane', () => {
  expect(guideNeedsRoom({ viewportWidth: 900, leftWidth: 268, rightWidth: 340 })).toBe(true)
  expect(900 - 340).toBe(560)
  expect(guideNeedsRoom({ viewportWidth: 1320, leftWidth: 268, rightWidth: 340 })).toBe(false)
  expect(guideNeedsRoom({ viewportWidth: 1168, leftWidth: 268, rightWidth: 340 })).toBe(false)
  expect(guideNeedsRoom({ viewportWidth: 1167, leftWidth: 268, rightWidth: 340 })).toBe(true)
})

test('a topic read is saved under the same key, announced once, and is still there with no example folder (ticket 08)', () => {
  const { dir, file, store, changes } = fresh()
  try {
    store.topicRead('how.3')
    store.topicRead('how.3')
    store.topicRead('not-a-topic')
    expect(changes).toEqual([GUIDE_PROGRESS_KEY])
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(saved.values)).toEqual([GUIDE_PROGRESS_KEY])
    expect(saved.changelog).toEqual([])
    // A new process, reading the same file: the record holds the topic; the example folder is not consulted.
    expect(new GuideProgressStore(new SettingsStore(file)).read().read).toEqual(['how.3'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
