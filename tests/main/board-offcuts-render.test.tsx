import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Offcut } from '../../src/preload'
import { BoardActivity, OffcutNamer, OffcutsColumn, OFFCUTS_EMPTY } from '../../src/renderer/src/components/BoardOffcuts'
import { BoardCardDrawer } from '../../src/renderer/src/components/BoardCardMaterial'

// Scraps ticket 02, locked design frames 1, 2, 3 and 6: the Offcuts column, its empty state, the
// name field an offcut opens on Idea, the activity row, and the drawer's "Add to end of piece".

const offcut = (id: string, text: string, originTitle: string, cutOn: string | null): Offcut => ({
  id, text, firstWords: text.length > 40 ? `${text.slice(0, 36)}…` : text, suggestedName: text.split(' ').slice(0, 6).join(' '), done: false,
  scrapsPath: 'schemas/scraps/x-SCRAPS.md', origin: 'schemas/x.md', originTitle, cutOn,
})

const noop = () => {}

test('the Offcuts column lists every scrap with its text start and where it was cut from', () => {
  const html = renderToStaticMarkup(
    <OffcutsColumn
      offcuts={[
        offcut('s_1', "Hall's high and low context cultures: every culture has high and low context areas", 'How humans hallucinate', `${new Date().getFullYear()}-08-03`),
        offcut('s_2', 'A list is a promise about order.', 'Frames and scripts', null),
      ]}
      selectedKey="offcut:schemas/scraps/x-SCRAPS.md#s_2"
      onSelect={noop} onDragStart={noop} onDragEnd={noop}
    />,
  )
  expect(html).toContain('data-status="offcuts"')
  expect(html).toContain('>Offcuts<')
  expect(html).toContain('<span class="c-count">2</span>')
  expect(html.match(/class="boff[ "]/g)).toHaveLength(2)
  expect(html).toContain('from How humans hallucinate · 3 Aug')
  expect(html).toContain('from Frames and scripts<')
  expect(html).toContain('class="boff sel"')
  expect(html).toContain('draggable="true"')
  expect(html).not.toContain(OFFCUTS_EMPTY)
})

test('with no offcuts the column stays and says where they will land', () => {
  const html = renderToStaticMarkup(<OffcutsColumn offcuts={[]} selectedKey={null} onSelect={noop} onDragStart={noop} onDragEnd={noop} />)
  expect(html).toContain('<span class="c-count">0</span>')
  expect(html).toContain('No offcuts in this collection. Cut a passage to Scraps while you write, and it waits here.')
})

test('the name field is prefilled and offers Make idea ↵ and Cancel', () => {
  const item = offcut('s_1', "Hall's high and low context cultures", 'How humans hallucinate', null)
  const html = renderToStaticMarkup(<OffcutNamer offcut={item} name="High and low context, everywhere" busy={false} error={null} onChange={noop} onSubmit={noop} onCancel={noop} />)
  expect(html).toContain('Name the idea')
  expect(html).toContain('value="High and low context, everywhere"')
  expect(html).toContain('Make idea <kbd>↵</kbd>')
  expect(html).toContain('>Cancel<')
  const refused = renderToStaticMarkup(<OffcutNamer offcut={item} name="" busy={false} error="Give the idea a name first." onChange={noop} onSubmit={noop} onCancel={noop} />)
  expect(refused).toContain('role="alert"')
  expect(refused).toMatch(/<button type="button" class="btn primary" disabled="">/)
})

test('the activity row names the step and offers Undo ⌘⇧Z while it holds one', () => {
  const held = renderToStaticMarkup(<BoardActivity activity={{ text: 'Offcut became an idea', stepId: 'rp1' }} onUndo={noop} />)
  expect(held).toContain('Offcut became an idea')
  expect(held).toContain('Undo <kbd>⌘⇧Z</kbd>')
  const refused = renderToStaticMarkup(<BoardActivity activity={{ text: "Can't undo: x changed since.", stepId: null, refused: true }} onUndo={noop} />)
  expect(refused).toContain('board-activity refused')
  expect(refused).not.toContain('Undo')
})

test('each drawer scrap offers Add to end of piece', () => {
  const row = { title: 'How humans hallucinate', drawer: { scraps: [{ id: 's_1', text: 'Families share more context.', firstWords: 'Families share more context.' }], moreScraps: 0, sources: [], moreSources: 0 } }
  const html = renderToStaticMarkup(<BoardCardDrawer row={row} onAppend={noop} />)
  expect(html).toContain('>Add to end of piece<')
  expect(html).toContain('aria-label="Add “Families share more context.” to the end of How humans hallucinate"')
  expect(renderToStaticMarkup(<BoardCardDrawer row={row} />)).not.toContain('Add to end of piece')
})
