import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RightPaneTabs } from '../../src/renderer/src/components/RightPaneTabs'
import { RIGHT_PANE_TABS, rightPaneTabsFor } from '../../src/renderer/src/app/pane-layout'
import { besideFit } from '../../src/shared/scratchpad-layout'

const labels = (html: string): string[] => [...html.split('class="pane-tabs-measure"')[0].matchAll(/<span class="pt-label">([^<]+)<\/span>/g)].map((m) => m[1])

test('the right sidebar tabs are Versions, Agent, Research in that order; the Scratchpad only while docked, the Guide only while open', () => {
  expect(RIGHT_PANE_TABS).toEqual(['versions', 'agent', 'research'])
  expect(rightPaneTabsFor(false, false)).toEqual(['versions', 'agent', 'research'])
  expect(rightPaneTabsFor(true, true)).toEqual(['versions', 'agent', 'research', 'scratchpad', 'guide'])
  const draw = (props: { guideShown?: boolean; scratchpadDocked?: boolean }) => labels(renderToStaticMarkup(<RightPaneTabs active="versions" onSelect={() => {}} {...props} />))
  expect(draw({})).toEqual(['Versions', 'Agent', 'Research'])
  expect(draw({ scratchpadDocked: true, guideShown: true })).toEqual(['Versions', 'Agent', 'Research', 'Scratchpad', 'Guide'])
})

test('the Scratchpad opens beside the text where the editor keeps 55% of the window, and overlays where it does not', () => {
  const editor = (right: number) => ({ left: 268, right, top: 70, bottom: 600 })
  // 1440 wide, left sidebar only: the editor column is 1172 wide; a 520 px panel leaves 652 (45%) -> too narrow.
  expect(besideFit({ viewportWidth: 1440, editor: editor(1440), preferredWidth: 700 })).toBeNull()
  // 1920 wide: 1652 - 520 = 1132 (59%) fits, the panel takes the editor column's right end.
  expect(besideFit({ viewportWidth: 1920, editor: editor(1920), preferredWidth: 700 })).toEqual({ left: 1400, top: 70, width: 520, height: 530 })
  // 1000 wide never fits.
  expect(besideFit({ viewportWidth: 1000, editor: editor(1000), preferredWidth: 420 })).toBeNull()
})
