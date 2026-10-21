import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FocusPicker } from '../../src/renderer/src/components/FocusPicker'
import { DEFAULT_LINE_OVERLAY } from '../../src/renderer/src/editor/line-overlay'

const noop = (): void => undefined
const html = (mode: 'off' | 'anchored', lineFocusOn: boolean, rulerOn = false): string => renderToStaticMarkup(
  <FocusPicker
    mode={(mode === 'off' ? '' : mode) as never}
    leadStyle="contrast"
    lineOverlay={{ ...DEFAULT_LINE_OVERLAY, lineFocus: { ...DEFAULT_LINE_OVERLAY.lineFocus, on: lineFocusOn }, ruler: { ...DEFAULT_LINE_OVERLAY.ruler, on: rulerOn } }}
    onToggleLineFocus={noop} onToggleRuler={noop} onOverlayChange={noop} onSelect={noop} onSelectStyle={noop} onClose={noop}
  />,
)

test('with Line focus on, its row is chosen and the Ruler options are faded', () => {
  const out = html('off', true)
  expect(out).toContain('<div class="pr chosen"><button type="button" class="pi" aria-pressed="true"><span class="num" aria-hidden="true">6</span>')
  expect(out).toMatch(/class="pr faded"><button[^>]*aria-pressed="false"><span class="num" aria-hidden="true">7<\/span>Ruler/)
})

test('anchored reading chosen: its pills are not faded; otherwise they are', () => {
  expect(html('anchored', false)).toMatch(/class="pr chosen"><button[^>]*aria-pressed="true"><span class="num" aria-hidden="true">\d<\/span>Anchored reading[\s\S]*?class="styles"/)
  expect(html('off', false)).toMatch(/class="pr faded"><button[^>]*aria-pressed="false"><span class="num" aria-hidden="true">\d<\/span>Anchored reading/)
})

test('with both overlays off every overlay option is faded', () => {
  const out = html('off', false)
  const lineFocus = out.slice(out.indexOf('Line focus options') - 400)
  expect((out.match(/class="pr faded"><button[^>]*aria-pressed="false"><span class="num" aria-hidden="true">[67]/g) ?? []).length).toBe(2)
  expect(lineFocus).toContain('overlay-pills')
})
