import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Change } from '../../src/preload'
import { countMenu, type CountMenuRow } from '../../src/renderer/src/app/margin-count-menu'
import { buildMarginModel } from '../../src/renderer/src/app/margin-model'
import { declineQuestion, sendBackScope } from '../../src/renderer/src/app/margin-bulk'
import { EMPTY_HEAD_FILTER } from '../../src/renderer/src/app/margin-head-state'
import { DeclineConfirm, ReviewAskPopover, SendBackPopover } from '../../src/renderer/src/components/ReviewBulkPopovers'

// Ticket 04: the Decline all confirmation and the Send back popover as drawn (frames `bulk-decline-confirm`, `send-back`),
// and the count menu's bulk rows when cards are picked (the "From 03" note: label and action agree).
// The keys (↵ confirms, Esc writes nothing, ⌘↵ sends) are exercised in tests/browser/review-bulk-popovers.test.ts.

const DOC = 'Alpha one. Beta two. Gamma three. Delta four.'
const base = (id: string, oldText: string, over: Partial<Change> = {}): Change => ({
  id, path: 'draft.md', ts: 1, provenance: 'agent', editClass: 'content', category: 'wording', summary: id, oldText, newText: `${oldText}!`, status: 'pending', isCorrection: false, ...over,
})
const jonas = (c: Change): Change => ({ ...c, provenance: 'reviewer', outsideSource: 'reader', readerNote: { shareId: 's1', key: 'k', link: 'Seminar group', name: 'Jonas', kind: 'edit', text: 'x', quote: 'q', anchored: 'unchanged', at: 1 } } as Change)
const changes = [base('a1', 'Alpha one.'), base('an', 'Beta two.', { newText: 'Beta two.' }), jonas(base('j1', 'Gamma three.')), base('c1', 'Delta four.', { provenance: 'reviewer', reviewerLabel: 'Claude Code' })]
const model = buildMarginModel({ changes, document: DOC, view: 'margin' })
const noop = (): void => undefined
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

test('the Decline all confirmation: the question, who will see it, the reassurance, Decline N with ↵ and Cancel with Esc', () => {
  const html = renderToStaticMarkup(<DeclineConfirm question={declineQuestion(model, ['a1', 'j1', 'c1'])} onConfirm={noop} onCancel={noop} />)
  expect(text(html)).toBe('Decline 3 edits? One is Jonas’s proposed edit: Jonas will see it declined on the reader page. One is the agent’s, one is Claude Code’s. The text stays as it is. Each one can be reopened from Settled today. Decline 3 ↵ Cancel Esc')
  expect(html).toContain('role="alertdialog"')
  expect(html).toContain('data-review-confirm-decline')
})

test('the Send back popover: what goes back, the note box, Send back with ⌘↵ (off while empty) and Cancel with Esc', () => {
  const html = renderToStaticMarkup(<SendBackPopover scope={sendBackScope(model)} onSend={noop} onCancel={noop} />)
  expect(text(html)).toBe('Send back to the agent Goes back: the agent’s 2 waiting items (1 edit, 1 comment), with this note. They stay in the margin marked Sent back until the agent answers. Readers and Claude Code are not included. Send back ⌘↵ Cancel Esc')
  expect(html).toContain('placeholder="What should the agent change?"')
  expect(html).toContain(`data-review-send="true" disabled=""`)
  const ask = renderToStaticMarkup(<ReviewAskPopover ask={{ kind: 'send-back', scope: sendBackScope(model), onSend: noop, onCancel: noop }} />)
  expect(ask).toContain('data-review-ask="send-back"')
})

test('the count menu with cards picked: the bulk rows say "picked" and act on them; Mark all done leaves', () => {
  const items = (rows: CountMenuRow[]) => rows.flatMap((row) => (row.kind === 'item' ? [row] : []))
  const input = { model, state: EMPTY_HEAD_FILTER, preferredView: 'margin' as const, textRoom: 800, marginHidden: false }
  const plain = items(countMenu(input)).map((row) => row.label)
  expect(plain).toContain('Accept all 3 edits')
  expect(plain).toContain('Mark all 1 comment done')
  const picked = items(countMenu({ ...input, picked: new Set(['a1', 'an']) }))
  const accept = picked.find((row) => row.id === 'accept-picked')!
  expect(accept.label).toBe('Accept 2 picked')
  expect(accept.action).toEqual({ type: 'accept' })
  expect(picked.find((row) => row.id === 'decline-all')!.label).toBe('Decline 1 picked…')
  expect(picked.some((row) => row.id === 'accept-edits' || row.id === 'accept-comments')).toBe(false)
})
