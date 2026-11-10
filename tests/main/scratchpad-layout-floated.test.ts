import { expect, test } from 'bun:test'
import { besideFit, dock, float, parseLayout } from '../../src/shared/scratchpad-layout'

const vp = { w: 1000, h: 650 }
const box = { x: 300, y: 90, w: 600, h: 500 }

test('a layout saved before the floated flag keeps the person\'s float and dock', () => {
  const legacyFloat = parseLayout(JSON.stringify({ mode: 'float', restore: 'float', box }), vp)
  expect(legacyFloat).toMatchObject({ mode: 'float', floated: true })
  const legacyCollapsedFloat = parseLayout(JSON.stringify({ mode: 'collapsed', restore: 'float', box }), vp)
  expect(legacyCollapsedFloat).toMatchObject({ mode: 'collapsed', restore: 'float', floated: true })
  const legacyDock = parseLayout(JSON.stringify({ mode: 'docked', restore: 'docked', box }), vp)
  expect(legacyDock).toMatchObject({ mode: 'docked', floated: false })
  // At 1000 px nothing fits beside the text, and the host docks only a layout that is not floated.
  expect(besideFit({ viewportWidth: 1000, editor: { left: 0, right: 1000, top: 70, bottom: 600 }, preferredWidth: 600 })).toBeNull()
  expect(legacyFloat.floated === true).toBe(true)
})

test('an explicit flag is kept, and a fresh layout (nothing saved) is not floated so it docks', () => {
  expect(parseLayout(JSON.stringify({ mode: 'collapsed', restore: 'float', box, floated: false }), vp).floated).toBe(false)
  expect(parseLayout(JSON.stringify({ mode: 'float', restore: 'float', box, floated: true }), vp).floated).toBe(true)
  expect(parseLayout(null, vp)).toMatchObject({ mode: 'collapsed', restore: 'float', floated: false })
  expect(dock(parseLayout(null, vp)).floated).toBe(false)
  expect(float(parseLayout(null, vp)).floated).toBe(true)
})
