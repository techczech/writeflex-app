import { expect, test } from 'bun:test'
import type { RightPaneTab } from '../../src/renderer/src/app/pane-layout'

type NextRightPaneTab = (
  current: RightPaneTab,
  direction: 1 | -1,
  available: readonly RightPaneTab[],
) => RightPaneTab

async function navigationSeam(): Promise<NextRightPaneTab> {
  const paneLayout = await import('../../src/renderer/src/app/pane-layout')
  expect(paneLayout).toHaveProperty('nextRightPaneTab')
  return (paneLayout as unknown as { nextRightPaneTab: NextRightPaneTab }).nextRightPaneTab
}

test('right panel tab navigation wraps in both directions', async () => {
  const nextRightPaneTab = await navigationSeam()
  const available: RightPaneTab[] = ['agent', 'scratchpad', 'review', 'agent-notes', 'versions']

  expect(nextRightPaneTab('versions', 1, available)).toBe('agent')
  expect(nextRightPaneTab('agent', -1, available)).toBe('versions')
})

test('right panel tab navigation skips tabs that are not available', async () => {
  const nextRightPaneTab = await navigationSeam()
  const available: RightPaneTab[] = ['agent', 'review', 'versions']

  expect(nextRightPaneTab('agent', 1, available)).toBe('review')
  expect(nextRightPaneTab('versions', -1, available)).toBe('review')
})
