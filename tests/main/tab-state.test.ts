import { test, expect } from 'bun:test'
import {
  activateTab,
  closeTab,
  isSurfaceTabId,
  isWidgetWorkbenchTabId,
  widgetWorkbenchTabId,
  workbenchDocumentOf,
  closeTabIntent,
  cycleTab,
  emptyTabState,
  openTab,
  ownFolderGroup,
  parseTabState,
  pinTab,
  sameTabList,
  tabStripFill,
  replaceActiveTab,
  reconcileTabs,
  serializeTabState,
  tabStorageKey,
  tabGroupLabels,
  tabStripView,
  type TabState,
} from '../../src/renderer/src/hooks/tab-state'

const state = (tabs: string[], active: string | null, pinned: string[] = [], recent: string[] = tabs.toReversed()): TabState => ({ tabs, active, pinned, recent })

test('storage key is namespaced per workspace root', () => {
  expect(tabStorageKey('/w/notes')).toBe('writeflex:tabs:/w/notes')
})

test('open appends new paths and focuses them; re-opening only re-focuses', () => {
  let s = openTab(emptyTabState, 'a')
  expect(s).toEqual(state(['a'], 'a'))
  s = openTab(s, 'b')
  expect(s).toEqual(state(['a', 'b'], 'b'))
  const before = s
  s = openTab(s, 'a')
  expect(s).toEqual(state(['a', 'b'], 'a', [], ['a', 'b'])) // no duplicate tab, just re-focused
  expect(s.tabs).toBe(before.tabs) // the tabs array is reused; only active changed
})

test('activate focuses an open tab and is a no-op for unknown or already-active paths', () => {
  const s = state(['a', 'b'], 'a')
  expect(activateTab(s, 'b')).toEqual(state(['a', 'b'], 'b'))
  expect(activateTab(s, 'a')).toBe(s)
  expect(activateTab(s, 'z')).toBe(s)
})

test('closing the active tab focuses the right neighbour, then falls back to the left', () => {
  expect(closeTab(state(['a', 'b', 'c'], 'b'), 'b')).toEqual(state(['a', 'c'], 'c'))
  expect(closeTab(state(['a', 'b'], 'b'), 'b')).toEqual(state(['a'], 'a'))
})

test('closing a non-active tab keeps the current focus; closing the last tab clears focus', () => {
  expect(closeTab(state(['a', 'b'], 'b'), 'a')).toEqual(state(['b'], 'b'))
  expect(closeTab(state(['a'], 'a'), 'a')).toEqual(state([], null))
  expect(closeTab(state(['a'], 'a'), 'z')).toEqual(state(['a'], 'a')) // unknown path: no-op
})

test('Command-W closes an active tab, then closes the window only when no tabs remain', () => {
  expect(closeTabIntent(state(['a'], 'a'))).toEqual({ kind: 'tab', path: 'a' })
  expect(closeTabIntent(state([], null))).toEqual({ kind: 'window' })
})

test('cycle moves forward/back and wraps at both ends', () => {
  const s = state(['a', 'b', 'c'], 'a')
  expect(cycleTab(s, 1).active).toBe('b')
  expect(cycleTab(s, -1).active).toBe('c') // wrap to end
  expect(cycleTab(state(['a', 'b', 'c'], 'c'), 1).active).toBe('a') // wrap to start
  expect(cycleTab(emptyTabState, 1)).toBe(emptyTabState) // nothing to cycle
})

test('folder browsing replaces the active tab without spawning another tab', () => {
  expect(replaceActiveTab(state(['a', 'b', 'c'], 'b'), 'folder/d.md')).toEqual(state(['a', 'folder/d.md', 'c'], 'folder/d.md', [], ['folder/d.md', 'c', 'a']))
  expect(replaceActiveTab(state(['a', 'b', 'c'], 'b'), 'c')).toEqual(state(['a', 'c'], 'c', [], ['c', 'a']))
  expect(replaceActiveTab(state([], null), 'a')).toEqual(state(['a'], 'a'))
})

test('reconcile drops stale tabs and repairs a dropped active; unchanged when all present', () => {
  expect(reconcileTabs(state(['a', 'b', 'c'], 'b'), ['a', 'c'])).toEqual(state(['a', 'c'], 'a'))
  expect(reconcileTabs(state(['a', 'b'], 'a'), ['a', 'b'])).toEqual(state(['a', 'b'], 'a'))
  const clean = state(['a'], 'a')
  expect(reconcileTabs(clean, new Set(['a']))).toBe(clean) // same reference when nothing stale
  expect(reconcileTabs(state(['a'], 'a'), [])).toEqual(state([], null))
})

test('reconcile preserves the reserved Board tab without treating it as a file path', () => {
  expect(reconcileTabs(state(['draft.md', 'writeflex://board'], 'writeflex://board'), ['draft.md']))
    .toEqual(state(['draft.md', 'writeflex://board'], 'writeflex://board'))
})

test('parse round-trips a serialized state and repairs a dangling active', () => {
  const s = state(['a', 'b'], 'b')
  expect(parseTabState(serializeTabState(s))).toEqual(s)
  expect(parseTabState(JSON.stringify({ tabs: ['a', 'b'], active: 'gone' }))).toEqual(state(['a', 'b'], 'a'))
})

test('parse collapses missing or malformed blobs to the empty state', () => {
  expect(parseTabState(null)).toEqual(emptyTabState)
  expect(parseTabState('not json')).toEqual(emptyTabState)
  expect(parseTabState(JSON.stringify({ tabs: [1, 2] }))).toEqual(emptyTabState)
})

test('pinning caps at four, persists in serialised state, and makes close a no-op until unpinned', () => {
  let s = state(['a', 'b', 'c', 'd', 'e'], 'a')
  for (const path of ['a', 'b', 'c', 'd']) s = pinTab(s, path, true)
  expect(pinTab(s, 'e', true)).toBe(s)
  expect(closeTab(s, 'a')).toBe(s)
  expect(parseTabState(serializeTabState(s)).pinned).toEqual(['a', 'b', 'c', 'd'])
  s = pinTab(s, 'a', false)
  expect(closeTab(s, 'a').tabs).not.toContain('a')
})

test('strip fill is pinned then active then recents and spills whole tabs instead of shrinking', () => {
  const s = state(
    ['pin-a', 'pin-b', 'active', 'recent-a', 'recent-b', 'old'],
    'active',
    ['pin-a', 'pin-b'],
    ['active', 'recent-a', 'recent-b', 'old', 'pin-b', 'pin-a'],
  )
  const widths = new Map([
    ['pin-a', 100], ['pin-b', 100], ['active', 130], ['recent-a', 120], ['recent-b', 120], ['old', 90],
  ])
  expect(tabStripFill(s, widths, 520, 50)).toEqual({
    visible: ['pin-a', 'pin-b', 'active', 'recent-a'],
    overflow: ['recent-b', 'old'],
  })
  const withThirdPin = pinTab(s, 'recent-b', true)
  expect(tabStripFill(withThirdPin, widths, 520, 50)).toEqual({
    visible: ['pin-a', 'pin-b', 'recent-b', 'active'],
    overflow: ['recent-a', 'old'],
  })
})

// --- Direction D: the strip follows the open file -------------------------------------------------

const TALK = 'talks/ai-foundations-2026'
const groupsByPath: Record<string, string> = {
  [`${TALK}/parts/01.md`]: TALK,
  [`${TALK}/parts/02.md`]: TALK,
  [`${TALK}/research/priming.md`]: TALK,
  'metaphor-series/machine.md': 'metaphor-series',
  'notebooks/reading/dyslexia.md': 'notebooks/reading',
  'reading/wolf.md': 'reading',
}
const groupOf = (path: string): string => groupsByPath[path] ?? path.slice(0, Math.max(0, path.lastIndexOf('/')))
const threeGroups = (): TabState => {
  let s = emptyTabState
  for (const path of ['reading/wolf.md', 'notebooks/reading/dyslexia.md', 'metaphor-series/machine.md', `${TALK}/parts/01.md`, `${TALK}/parts/02.md`, `${TALK}/research/priming.md`]) s = openTab(s, path)
  s = pinTab(s, 'reading/wolf.md', true)
  return activateTab(s, `${TALK}/parts/01.md`)
}

test('with tabs in three groups the strip is the pins plus only the active group, in open order', () => {
  const view = tabStripView(threeGroups(), groupOf)
  expect(view.group).toBe(TALK)
  expect(view.strip).toEqual(['reading/wolf.md', `${TALK}/parts/01.md`, `${TALK}/parts/02.md`, `${TALK}/research/priming.md`])
})

test('switching to a file in another group swaps the strip and closes nothing', () => {
  const before = threeGroups()
  const after = openTab(before, 'notebooks/reading/dyslexia.md')
  expect(after.tabs).toEqual(before.tabs)
  expect(tabStripView(after, groupOf).strip).toEqual(['reading/wolf.md', 'notebooks/reading/dyslexia.md'])
  // Opening a new file elsewhere swaps too, and still keeps every other tab open.
  const opened = openTab(after, 'metaphor-series/other.md')
  expect(opened.tabs).toEqual([...before.tabs, 'metaphor-series/other.md'])
  expect(tabStripView(opened, groupOf).strip).toEqual(['reading/wolf.md', 'metaphor-series/machine.md', 'metaphor-series/other.md'])
})

test('a pinned tab stays on the strip in every group, and activating it does not swap the strip', () => {
  const s = threeGroups()
  for (const path of ['metaphor-series/machine.md', 'notebooks/reading/dyslexia.md']) {
    expect(tabStripView(activateTab(s, path), groupOf).strip[0]).toBe('reading/wolf.md')
  }
  const onPin = activateTab(s, 'reading/wolf.md')
  expect(tabStripView(onPin, groupOf).group).toBe(TALK)
  expect(tabStripView(onPin, groupOf).strip).toEqual(tabStripView(s, groupOf).strip)
})

test('Open tabs By folder: the strip group first, then the others by last activity; pins are not grouped', () => {
  let s = threeGroups()
  s = activateTab(s, 'metaphor-series/machine.md')
  s = activateTab(s, `${TALK}/parts/02.md`)
  expect(tabStripView(s, groupOf).groups).toEqual([
    { key: TALK, tabs: [`${TALK}/parts/01.md`, `${TALK}/parts/02.md`, `${TALK}/research/priming.md`], onStrip: true },
    { key: 'metaphor-series', tabs: ['metaphor-series/machine.md'], onStrip: false },
    { key: 'notebooks/reading', tabs: ['notebooks/reading/dyslexia.md'], onStrip: false },
  ])
})

test('only pins open: the strip is the pins and there is no group', () => {
  let s = openTab(emptyTabState, 'reading/wolf.md')
  s = pinTab(s, 'reading/wolf.md', true)
  expect(tabStripView(s, groupOf)).toEqual({ group: null, strip: ['reading/wolf.md'], groups: [] })
})

test('cycling walks only the strip, pins included, and wraps', () => {
  const s = threeGroups()
  const strip = tabStripView(s, groupOf).strip
  const visited: string[] = []
  let current = s
  for (let step = 0; step < strip.length; step += 1) {
    current = cycleTab(current, 1, tabStripView(current, groupOf).strip)
    visited.push(current.active as string)
  }
  expect(visited).toEqual([`${TALK}/parts/02.md`, `${TALK}/research/priming.md`, 'reading/wolf.md', `${TALK}/parts/01.md`])
  expect(cycleTab(s, -1, strip).active).toBe('reading/wolf.md')
})

test('closing the active tab focuses its strip neighbour; an emptied group hands the strip to the most recent remaining group', () => {
  let s = threeGroups()
  s = activateTab(s, 'notebooks/reading/dyslexia.md')
  s = activateTab(s, `${TALK}/research/priming.md`)
  // Right neighbour in open order would be nothing, and tabs[idx-1] (parts/02) is on the strip too.
  const closedInGroup = closeTab(s, `${TALK}/research/priming.md`, groupOf)
  expect(closedInGroup.active).toBe(`${TALK}/parts/02.md`)
  expect(tabStripView(closedInGroup, groupOf).group).toBe(TALK)
  let emptied = closedInGroup
  emptied = closeTab(emptied, `${TALK}/parts/02.md`, groupOf)
  emptied = closeTab(emptied, `${TALK}/parts/01.md`, groupOf)
  expect(emptied.active).toBe('notebooks/reading/dyslexia.md')
  expect(tabStripView(emptied, groupOf).strip).toEqual(['reading/wolf.md', 'notebooks/reading/dyslexia.md'])
})

test('a neighbour in another group is never chosen while the strip group still has tabs', () => {
  const s = activateTab(openTab(openTab(openTab(emptyTabState, 'a/one.md'), 'b/two.md'), 'a/three.md'), 'a/one.md')
  // Open order is a/one, b/two, a/three: the plain right neighbour would be b/two.
  expect(closeTab(s, 'a/one.md').active).toBe('b/two.md')
  expect(closeTab(s, 'a/one.md', groupOf).active).toBe('a/three.md')
})

test('group headings use the folder name, parent / name only when the name is shared', () => {
  const labels = tabGroupLabels(['talks/ai-foundations-2026', 'notebooks/reading', 'reading', 'metaphor-series', '', 'writeflex://board'], 'writing')
  expect(Object.fromEntries(labels)).toEqual({
    'talks/ai-foundations-2026': 'ai-foundations-2026',
    'notebooks/reading': 'notebooks / reading',
    reading: 'reading',
    'metaphor-series': 'metaphor-series',
    '': 'writing',
    'writeflex://board': 'Board',
  })
})

test('tab state persisted before direction D restores unchanged and reconcile still drops missing files', () => {
  const legacy = JSON.stringify({ tabs: ['a/one.md', 'b/two.md', 'gone.md'], active: 'b/two.md', pinned: ['a/one.md'], recent: ['b/two.md', 'a/one.md', 'gone.md'] })
  const parsed = parseTabState(legacy)
  expect(parsed).toEqual({ tabs: ['a/one.md', 'b/two.md', 'gone.md'], active: 'b/two.md', pinned: ['a/one.md'], recent: ['b/two.md', 'a/one.md', 'gone.md'] })
  expect(serializeTabState(parsed)).toBe(legacy)
  const reconciled = reconcileTabs(parsed, ['a/one.md', 'b/two.md'])
  expect(reconciled).toEqual({ tabs: ['a/one.md', 'b/two.md'], active: 'b/two.md', pinned: ['a/one.md'], recent: ['b/two.md', 'a/one.md'] })
  expect(tabStripView(reconciled, ownFolderGroup).strip).toEqual(['a/one.md', 'b/two.md'])
  expect(Object.keys(reconciled).sort()).toEqual(['active', 'pinned', 'recent', 'tabs'])
})

test('sameTabList compares ids and order, not array identity', () => {
  expect(sameTabList(['a', 'b'], ['a', 'b'])).toBe(true)
  expect(sameTabList([], [])).toBe(true)
  expect(sameTabList(['a', 'b'], ['b', 'a'])).toBe(false)
  expect(sameTabList(['a'], ['a', 'b'])).toBe(false)
})

test('tabStripFill is stable: equal inputs give an equal list, and refilling with its own result changes nothing', () => {
  const s = { tabs: ['a', 'b', 'c', 'd'], active: 'c', pinned: ['a'], recent: ['c', 'b', 'd'] }
  const widths = new Map([['a', 100], ['b', 120], ['c', 120], ['d', 120]])
  for (const available of [100, 230, 300, 360, 460, 600]) {
    const first = tabStripFill(s, widths, available, 50)
    const again = tabStripFill({ ...s, tabs: [...s.tabs], recent: [...s.recent] }, widths, available, 50)
    expect(sameTabList(again.visible, first.visible)).toBe(true)
    const narrowed = tabStripFill({ ...s, tabs: first.visible, recent: s.recent.filter((p) => first.visible.includes(p)) }, widths, available, 50)
    expect(sameTabList(narrowed.visible, first.visible)).toBe(true)
  }
})
