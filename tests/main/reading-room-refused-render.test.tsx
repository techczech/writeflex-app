import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReadingRoomRefusedList } from '../../src/renderer/src/components/ReadingRoomRefused'
import type { RefusedHighlight } from '../../src/preload'

const refused: RefusedHighlight = {
  date: '2026-10-08T09:30:00.000Z',
  documentTitle: 'Lakoff 1987 — Women, Fire',
  excerpt: 'the implicit models',
  id: 7,
  kind: 'refused',
  open: { attachmentKey: 'ATT1', itemKey: 'ITEM1', libraryId: 1 },
  position: '{"pageIndex":0,"rects":[]}',
  reason: 'The document this highlight belongs to is no longer in Zotero.',
  retryable: true,
}
const actions = { busyId: null, onDismiss() {}, onOpen() {}, onRetry() {} }

test('nothing refused renders nothing at all', () => {
  expect(renderToStaticMarkup(<ReadingRoomRefusedList items={[]} {...actions} />)).toBe('')
})

test('a refused highlight shows its paper, words, reason and date, and says the highlight is kept', () => {
  const conflict: RefusedHighlight = { ...refused, id: 8, kind: 'conflict', open: null, retryable: false,
    documentTitle: 'ATT2', reason: 'The annotation changed in Zotero.' }
  const markup = renderToStaticMarkup(<ReadingRoomRefusedList items={[refused, conflict]} {...actions} />)

  expect(markup).toContain('Not sent to Zotero')
  expect(markup).toContain('<span>2</span>')
  expect(markup).toContain('Lakoff 1987 — Women, Fire')
  expect(markup).toContain('“the implicit models”')
  expect(markup).toContain('The document this highlight belongs to is no longer in Zotero.')
  expect(markup).toContain('8 Oct 2026')
  expect(markup).toContain('kept here in WriteFlex')
  expect(markup).toContain('nothing is deleted')
  // Only the retryable one offers a retry; both can be dismissed; only the findable one opens.
  expect(markup.match(/>Try again</g)).toHaveLength(1)
  expect(markup.match(/>Dismiss, keep highlight here</g)).toHaveLength(2)
  expect(markup.match(/title="Open this document at the highlight"/g)).toHaveLength(1)
  expect(markup).toContain('Changed in Zotero as well: The annotation changed in Zotero.')
})

test('the list is styled from WriteFlex tokens, with no literal colours', () => {
  const css = readFileSync(join(import.meta.dirname, '../../src/renderer/src/styles/app.css'), 'utf8')
  const rules = css.split('\n').filter((line) =>
    line.startsWith('.reading-room-refused') || line.startsWith('button.reading-room-refused')
    || line.startsWith('.reading-room-highlights-kept'))
  expect(rules.length).toBeGreaterThan(10)
  for (const rule of rules) expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
})
