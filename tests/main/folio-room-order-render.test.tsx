import { outlineDropTarget, outlineDragRefusal, AMBIGUOUS_DRAG_MESSAGE, OUTLINE_DRAG_CHANGED_MESSAGE } from '../../src/renderer/src/components/folio-outline-drag'
/**
 * Folio room ticket 11: the room's order helpers (src/shared/folio-room-order.ts) and what the room draws for them
 * (FolioRoomOrder.tsx): the move permutation a drag or ⌥↑↓ asks for, the title-clash and New card checks, the banner
 * (the export sheet's out-of-step line, or the Index-only line of spec § 12) and the New card tile and composer.
 */
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewCard, RoomOrderBanner, roomMoveChord } from '../../src/renderer/src/components/FolioRoomOrder'
import type { ExportOrderCheck } from '../../src/shared/export-order-agreement'
import {
  INDEX_ONLY_BANNER, MANIFEST_CREATED, NEW_CARD_INDEX_NOTE, NEW_CARD_NEEDS_TITLE, NEW_CARD_RESERVED, NEW_CARD_TITLE_UNWRITABLE, clashingTitle, moveOrder, newCardClashRefusal, newCardLooseRefusal, newCardTitle, roomOrderLine, withManifestNote,
} from '../../src/shared/folio-room-order'

const check = (agreement: ExportOrderCheck['agreement']): ExportOrderCheck => ({ agreement, expected: { parts: [], manifestExists: agreement.kind !== 'no-manifest' }, unreadableMessage: 'Manifest unreadable.' })

test('moveOrder: the part at `from` goes to `to`, every other part keeps its order; out of range or in place gives null', () => {
  expect(moveOrder(4, 3, 0)).toEqual([3, 0, 1, 2])
  expect(moveOrder(4, 0, 3)).toEqual([1, 2, 3, 0])
  expect(moveOrder(4, 1, 2)).toEqual([0, 2, 1, 3])
  expect(moveOrder(4, 2, 2)).toBeNull()
  expect(moveOrder(4, -1, 2)).toBeNull()
  expect(moveOrder(4, 1, 4)).toBeNull()
  expect(moveOrder(4, 1.5, 2)).toBeNull()
})

test('clashingTitle: the Plan\'s title key folds case and Unicode form; distinct titles give null', () => {
  expect(clashingTitle(['Results', 'Method', 'results'])).toBe('results')
  expect(clashingTitle(['Café', 'CAFÉ'])).toBe('CAFÉ')
  expect(clashingTitle(['One', 'Two'])).toBeNull()
})

test('newCardTitle: trimmed; empty, unwritable and clashing titles are refused in plain words', () => {
  const parts = [{ title: 'Summary' }, { title: 'Details' }]
  expect(newCardTitle('  Methods ', parts)).toEqual({ ok: true, title: 'Methods' })
  expect(newCardTitle('   ', parts)).toEqual({ ok: false, message: NEW_CARD_NEEDS_TITLE })
  for (const bad of ['A #tag', 'A | B', 'A ]] B', 'two\nlines']) expect(newCardTitle(bad, parts)).toEqual({ ok: false, message: NEW_CARD_TITLE_UNWRITABLE })
  expect(newCardTitle('SUMMARY', parts)).toEqual({ ok: false, message: newCardClashRefusal('SUMMARY') })
})

test('newCardTitle in the field (review S-1, S-5): a loose file\'s title or file name, the Index Note\'s heading or file name and a reserved name are refused', () => {
  const parts = [{ title: 'One' }]
  const folio = { notInOutline: [{ title: 'Extra', path: 'index-only/extra.md' }, { title: 'Notes from the field', path: 'index-only/field-notes.md' }], indexNote: { path: 'index-only/_index-only_INDEX.md', title: 'Index only' } }
  expect(newCardTitle('Extra', parts, folio)).toEqual({ ok: false, message: newCardLooseRefusal('extra.md') })
  expect(newCardTitle('FIELD-NOTES', parts, folio)).toEqual({ ok: false, message: newCardLooseRefusal('field-notes.md') })
  expect(newCardTitle('notes from the field', parts, folio)).toEqual({ ok: false, message: newCardLooseRefusal('field-notes.md') })
  expect(newCardTitle('index only', parts, folio)).toEqual({ ok: false, message: NEW_CARD_INDEX_NOTE })
  expect(newCardTitle('_index-only_INDEX', parts, folio)).toEqual({ ok: false, message: NEW_CARD_INDEX_NOTE })
  for (const reserved of ['AGENTS', 'claude', '_report-structure', 'x.canvas']) expect(newCardTitle(reserved, parts, folio)).toEqual({ ok: false, message: NEW_CARD_RESERVED })
  expect(newCardTitle('Four', parts, folio)).toEqual({ ok: true, title: 'Four' })
  // No Index Note yet: only the loose files and reserved names are compared.
  expect(newCardTitle('Index only', parts, { ...folio, indexNote: null })).toEqual({ ok: true, title: 'Index only' })
})

test('roomOrderLine: the out-of-step line as the sheets word it; the Index-only line only when a part is written; nothing when the orders agree', () => {
  expect(roomOrderLine(check({ kind: 'disagree', orderDiffers: { index: ['b', 'a'], manifest: ['a', 'b'] }, notInExport: [], notInRunningOrder: [] }), true))
    .toEqual({ lines: ['The export order does not match the running order'], repair: true })
  expect(roomOrderLine(check({ kind: 'no-manifest' }), true)).toEqual({ lines: [INDEX_ONLY_BANNER], repair: true })
  expect(roomOrderLine(check({ kind: 'no-manifest' }), false)).toBeNull()
  expect(roomOrderLine(check({ kind: 'agree' }), true)).toBeNull()
  expect(roomOrderLine(check({ kind: 'unreadable' }), true)).toEqual({ lines: ['Manifest unreadable.'], repair: false })
  expect(roomOrderLine(null, true)).toBeNull()
  expect(INDEX_ONLY_BANNER).toBe('Export and sharing follow file names until this Folio’s order is written')
})

test('withManifestNote adds the manifest sentence only when the write created the manifest', () => {
  expect(withManifestNote('Moved Two to 1 of 3', true)).toBe(`Moved Two to 1 of 3. ${MANIFEST_CREATED}`)
  expect(withManifestNote('Moved Two to 1 of 3', undefined)).toBe('Moved Two to 1 of 3')
})

test('the banner: the line, Make export follow the running order, and what the repair said', () => {
  const html = renderToStaticMarkup(<RoomOrderBanner state={{ line: { lines: [INDEX_ONLY_BANNER], repair: true }, said: null, busy: false, repair: () => {} }} />)
  expect(html).toContain('data-testid="room-order-banner"')
  expect(html).toContain(INDEX_ONLY_BANNER.replace('’', '’'))
  expect(html).toContain('Make export follow the running order')
  const said = renderToStaticMarkup(<RoomOrderBanner state={{ line: null, said: { ok: true, text: MANIFEST_CREATED }, busy: false, repair: () => {} }} />)
  expect(said).toContain(MANIFEST_CREATED)
  expect(renderToStaticMarkup(<RoomOrderBanner state={{ line: null, said: null, busy: false, repair: () => {} }} />)).toBe('')
})

test('New card: a dashed tile until opened, then a title field; the Outline draws it only while open', () => {
  const props = { parts: [], busy: false, onOpen: () => {}, onClose: () => {}, onAdd: async () => true }
  const tile = renderToStaticMarkup(<NewCard open={false} {...props} />)
  expect(tile).toContain('fr-card fr-newcard')
  expect(tile).toContain('Type a title to add an unwritten part to the running order')
  const open = renderToStaticMarkup(<NewCard open {...props} />)
  expect(open).toContain('aria-label="Title of the new part"')
  expect(renderToStaticMarkup(<NewCard open={false} row {...props} />)).toBe('')
  expect(roomMoveChord()).toBe('⌥↑↓')
})


test('Outline drop geometry respects row halves and the last row, and cancellation or a missing source has no target', () => {
  const rows = [0, 1, 2].map(index => ({ index, top: index * 20, bottom: (index + 1) * 20 }))
  expect(outlineDropTarget(rows, 2, 25)?.to).toBe(1)
  expect(outlineDropTarget(rows, 0, 35)?.to).toBe(1)
  expect(outlineDropTarget(rows, 0, 90)).toEqual({ to: 2, boundary: 2, after: true })
  expect(outlineDropTarget(rows, 0, 35, false)).toBeNull() // Escape: finish(false) cannot request a write.
  expect(outlineDropTarget(rows, 7, 35)).toBeNull()
  const keyed = rows.map(row => ({ ...row, key: `part-${row.index}` }))
  expect(outlineDropTarget(keyed, 0, 35, true, 'part-0')?.to).toBe(1)
  const afterKeyboardMove = keyed.map(row => ({ ...row, key: row.index === 0 ? 'part-1' : row.index === 1 ? 'part-0' : row.key }))
  expect(outlineDropTarget(afterKeyboardMove, 0, 35, true, 'part-0')).toBeNull()
  const a = { title: 'Draft', path: null, gloss: 'First card', role: 'body', tags: [] }
  const b = { ...a, gloss: 'Second card' }
  const cards = [{ index: 0, key: JSON.stringify(a) }, { index: 1, key: JSON.stringify(b) }]
  expect(outlineDragRefusal(cards, 0, JSON.stringify(a))).toBeNull()
  expect(outlineDragRefusal([{ ...cards[0], index: 1 }, { ...cards[1], index: 0 }], 0, JSON.stringify(a))).toBe(OUTLINE_DRAG_CHANGED_MESSAGE)
  const allParts = [{ index: 0, key: JSON.stringify(a) }, { index: 1, key: JSON.stringify(a) }]
  const visibleParts = allParts.slice(0, 1)
  expect(outlineDragRefusal(visibleParts, 0, JSON.stringify(a))).toBeNull()
  expect(outlineDragRefusal(allParts, 0, JSON.stringify(a))).toBe(AMBIGUOUS_DRAG_MESSAGE)
})
