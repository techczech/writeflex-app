import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Change } from '../../src/preload'
import { buildMarginModel } from '../../src/renderer/src/app/margin-model'
import { ElsewherePopover } from '../../src/renderer/src/components/ReviewElsewherePopover'
import { statusPopoverPlacement } from '../../src/renderer/src/components/status-bar-popovers'
import { elsewhereRows, reviewLine, reviewLineCompact } from '../../src/renderer/src/components/status-bar-model'

// Ticket 07: "Waiting in N other pieces" on a clean piece (frame `elsewhere`) and the review line in a narrow window (frame `narrow-1000`).

const base = (id: string, path: string, oldText: string, over: Partial<Change> = {}): Change => ({
  id, path, ts: 1, provenance: 'agent', editClass: 'content', category: 'wording', summary: id, oldText, newText: `${oldText}!`, status: 'pending', isCorrection: false, ...over,
})
const jonas = (c: Change): Change => ({ ...c, provenance: 'reviewer', outsideSource: 'reader', readerNote: { shareId: 's1', key: 'k', link: 'Seminar group', name: 'Jonas', kind: 'note', text: 'Is this marked?', quote: 'q', anchored: 'unchanged', at: 1 } } as Change)
const others = [
  base('o1', 'teaching/choosing.md', 'Begin with the book'), base('o2', 'teaching/choosing.md', 'Second'),
  base('o3', 'teaching/choosing.md', 'Third', { provenance: 'reviewer', reviewerLabel: 'Claude Code' }),
  jonas(base('o4', 'teaching/assessment.md', 'Is this marked')),
]
const model = buildMarginModel({ changes: [], document: 'A clean piece.', view: 'margin', others })
const noop = (): void => undefined
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

test('a clean piece with items elsewhere: the line is the one phrase, and the rows say count, who and the first words', () => {
  const line = reviewLine({ waiting: 0, shown: 0, filtered: false, kind: 'all', counts: { all: 0, comments: 0, edits: 0 }, position: null, newCount: 0, otherPieces: model.otherPieces.length })!
  expect(line.hereless).toBe(true)
  expect(line.elsewhereText).toBe('Changes to review in 2 other documents')
  const rows = elsewhereRows(model.otherPieces)
  expect(rows.map((row) => [row.name, row.count])).toEqual([['assessment.md', 1], ['choosing.md', 3]])
  expect(rows[1].sources).toContain('Claude Code 1')
  expect(rows[1].first).toMatch(/^first: “.+”$/)
})

test('the popover draws Open per piece and Next piece with its chord; Open and Next piece call back', () => {
  const calls: string[] = []
  const controls = {
    pieces: model.otherPieces,
    changes: others,
    onBatch: async () => ({ decided: 0, left: [] }),
    onBatchSummary: noop,
    onOpen: (path: string) => calls.push(`open ${path}`),
    onNextPiece: () => calls.push('next'),
    nextPieceChord: '⌃⌥⌘G',
  }
  const html = renderToStaticMarkup(<ElsewherePopover controls={controls} onClose={noop} />)
  expect(html).toContain('data-testid="review-elsewhere"')
  expect(text(html)).toContain('Changes to review in 2 other documents')
  expect(text(html)).toContain('3 changes')
  expect(text(html)).toContain('Open')
  expect(text(html)).toEndWith('Next document with changes to review ⌃⌥⌘G')
  expect((html.match(/data-margin-action="open-piece"/g) ?? []).length).toBe(2)
})

test('the line is compact below 1150 px and whole at 1150', () => {
  expect(reviewLineCompact(1000)).toBe(true)
  expect(reviewLineCompact(1149)).toBe(true)
  expect(reviewLineCompact(1150)).toBe(false)
})


test('status popovers shift off the right edge, flip when needed and reserve a scroll box', () => {
  expect(statusPopoverPlacement({ right: 910, top: 450, bottom: 474 }, { width: 340, height: 700 }, { width: 900, height: 490 }))
    .toEqual({ left: 552, top: 8, maxHeight: 434 })
  expect(statusPopoverPlacement({ right: 28, top: 20, bottom: 44 }, { width: 250, height: 200 }, { width: 900, height: 490 }))
    .toEqual({ left: 8, top: 52, maxHeight: 430 })
})
