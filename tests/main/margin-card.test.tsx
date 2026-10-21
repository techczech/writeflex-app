import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import type { Change } from '../../src/preload'
import { changeInSentence, describeMarginCard, diffSegments, runMarginAction, SENTENCE_CONTEXT_WORDS, sentenceAround, whenLabel, type DiffSegment, type MarginActionContext } from '../../src/renderer/src/app/margin-card'
import { effectiveMarginView, layoutCardsFor, paragraphKey } from '../../src/renderer/src/app/margin-geometry'
import { layoutMargin } from '../../src/renderer/src/app/margin-layout'
import { buildMarginModel, type MarginCard } from '../../src/renderer/src/app/margin-model'
import { bulkTargets } from '../../src/renderer/src/app/margin-bulk'
import { cardKeyAction, replyCountLabel, replyStateLabel } from '../../src/renderer/src/app/margin-card'
import { useReviewActions, type ReviewActionDeps, type ReviewActions } from '../../src/renderer/src/app/review-actions'
import { ReviewMarginPanel, type MarginPanelProps } from '../../src/renderer/src/components/ReviewMargin'

const DOC = 'They are long, they are ordered by when the author found each item.\n\nA list does one job.\n\nHours or pages?\n'
const change = (over: Partial<Change>): Change => ({
  id: 'c1', path: 'draft.md', ts: Date.parse('2026-10-14T11:40:00'), provenance: 'agent', editClass: 'content', category: 'wording',
  summary: 'Tighten', oldText: 'They are long, they are ordered', newText: 'They are long and ordered', status: 'pending', isCorrection: false, ...over,
})
const cardsOf = (changes: Change[], doc = DOC): MarginCard[] => buildMarginModel({ changes, document: doc, view: 'margin' }).cards

// ---- a fake ledger behind the real review actions ----
function harness(changes: Change[]) {
  const calls: string[] = []
  let actions!: ReviewActions
  const deps: ReviewActionDeps = {
    ledger: {
      resolveChange: async (id, action) => { calls.push(`ledger.${action}:${id}`); return { applied: true } },
      setChangeStatus: async (id, status) => { calls.push(`ledger.status:${id}:${status}`) },
    },
    changes, dockChanges: changes, suggestions: [],
    editorRef: { current: null }, recordedWriterChanges: { current: new Map() },
    acceptSuggestion: async () => false, rejectSuggestion: async () => false, savePath: async () => true,
    reloadChanges: async () => undefined, refreshInlineChangesAfterReconcile: async () => undefined,
    flash: () => undefined, handleAgentWorkspaceChange: () => undefined, reconcileAppliedFile: () => undefined,
    // The save fix's document-owner routes (as in review-actions.test.ts): here they act at once.
    acceptThroughOwner: async (_path, _id, resolve) => ({ status: 'acted', result: await resolve(), recorded: false }),
    inDocumentQueue: (_path, run) => run(),
    documentWrittenByMain: () => undefined,
    focusComposer: (text) => { calls.push(`composer:${text ?? ''}`) },
    setChangesOpen: () => undefined, selectChange: () => undefined,
    settleChange: (id, advance) => { calls.push(`settle:${id}:${advance}`) },
  }
  function Harness(): null { actions = useReviewActions(deps); return null }
  renderToString(createElement(Harness))
  const context: MarginActionContext = {
    sendOriginalToScratchpad: (c) => { calls.push(`scratchpad:${c.id}`) },
    showInText: (id) => { calls.push(`show:${id}`) },
  }
  return { calls, actions, context }
}

test('an agent edit card is anatomy plus Accept, Decline, Reply and More', () => {
  const [card] = cardsOf([change({})])
  const d = describeMarginCard(card, 1, Date.parse('2026-10-14T12:00:00'))
  expect([d.marker, d.name, d.roleTag, d.kindLabel, d.statusLabel, d.when]).toEqual([1, 'Agent', 'agent', 'Proposed edit', 'Open', 'Today, 11:40'])
  expect(d.primary.map((a) => a.label)).toEqual(['Accept', 'Decline', 'Reply'])
  expect(d.more.map((a) => a.label)).toEqual(['Accept and next', 'Hold both', 'Show in text', 'Send original to Scratchpad'])
  expect(d.segments.some((s) => s.kind === 'del')).toBe(true)
  expect(d.segments.some((s) => s.kind === 'ins' && s.text === 'long and')).toBe(true)
})

test('wording: an insertion reads Insertion, a held change reads Held both, no Keep old or Discard anywhere', () => {
  const insert = change({ id: 'i', editClass: 'insert', oldText: '', newText: ' and more', insertAfter: 'each item' })
  const held = change({ id: 'h', status: 'held' })
  for (const [c, kind, status] of [[insert, 'Insertion', 'Open'], [held, 'Proposed edit', 'Held both']] as const) {
    const [card] = cardsOf([c])
    const d = describeMarginCard(card, 1)
    expect([d.kindLabel, d.statusLabel]).toEqual([kind, status])
    const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([c])))
    for (const banned of ['Keep old', 'Change to new', 'Discard', 'Insert<']) expect(html).not.toContain(banned)
  }
})

test('an outside change has no Reply; a card that creates a file has no Hold both and no original to send', () => {
  const outside = describeMarginCard(cardsOf([change({ provenance: 'reviewer', reviewerLabel: 'Claude Code', oldText: 'Hours?', newText: 'Hours or pages?' })])[0], 1)
  expect([outside.name, outside.roleTag]).toEqual(['Claude Code', 'outside'])
  expect(outside.primary.map((a) => a.label)).toEqual(['Accept', 'Decline'])
  const file = describeMarginCard(cardsOf([change({ newFile: { path: 'w.html', content: '<p/>', sha256: 'x' } })])[0], 1)
  expect(file.kindLabel).toBe('New file')
  expect(file.more.map((a) => a.label)).toEqual(['Accept and next', 'Show in text'])
})

test('every action goes through the review actions and the ledger', async () => {
  const c = change({})
  const { calls, actions, context } = harness([c])
  await runMarginAction('accept', c, actions, context)
  await runMarginAction('decline', c, actions, context)
  await runMarginAction('hold', c, actions, context)
  await runMarginAction('accept-next', c, actions, context)
  await runMarginAction('to-scratchpad', c, actions, context)
  await runMarginAction('show', c, actions, context)
  expect(calls).toContain('ledger.accept:c1')
  expect(calls).toContain('ledger.reject:c1')
  expect(calls).toContain('ledger.status:c1:held')
  expect(calls).toContain('settle:c1:true') // Accept and next advances
  expect(calls).toContain('scratchpad:c1')
  expect(calls).toContain('show:c1')
})

test('Reply hands the change back to the agent through the composer, as Revise did', async () => {
  const c = change({})
  const { calls, actions, context } = harness([c])
  await runMarginAction('reply', c, actions, context)
  const composer = calls.find((x) => x.startsWith('composer:')) ?? ''
  expect(composer).toContain('suggestions.retract')
  expect(composer).toContain('draft.md')
})

function panelProps(changes: Change[], over: Partial<MarginPanelProps> = {}): MarginPanelProps {
  const model = buildMarginModel({ changes, document: DOC, view: 'margin', selectedId: changes[0]?.id ?? null })
  const layout = layoutMargin({ cards: layoutCardsFor(model.cards, DOC, { anchorTops: new Map(model.cards.map((c, i) => [c.id, 100 + i * 200])), heights: new Map(), floor: 0, foldedIds: new Set() }) })
  const { actions, context } = harness(changes)
  return {
    model, layout, view: 'margin', preferredView: 'margin', onViewChange: () => undefined, selectedId: changes[0]?.id ?? null,
    foldedIds: new Set(), onFold: () => undefined, onOpen: () => undefined, actions, context, onSelect: () => undefined, onPick: () => undefined,
    controls: { state: { filter: {}, showOwnEdits: false, settled: false }, onState: () => undefined, picked: new Set<string>(), onClearPicked: () => undefined, onAccept: () => undefined, onDecline: () => undefined, sendBackOpen: false, onSendBackOpen: () => undefined, onSendBack: () => undefined, onReopen: () => undefined },
    onHover: () => undefined, onMove: () => undefined, moreOpenId: null, onMoreOpen: () => undefined, ...over,
  }
}

test('the margin draws each pending change once, level with its passage, with nothing above the cards but a filter or allowance line', () => {
  const changes = [
    change({ id: 'a' }),
    change({ id: 'b', oldText: 'A list does one job', newText: 'A list does one thing' }),
    change({ id: 'c', oldText: 'Hours or pages?', newText: 'Hours?', status: 'accepted' }),
  ]
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps(changes)))
  expect(html.match(/data-margin-card="/g)?.length).toBe(2)
  expect(html).not.toContain('data-margin-top')
  expect(html).not.toContain('2 waiting')
  expect(html).not.toContain('1 of 2')
  expect(html).not.toContain('mg-title')
  expect(html).not.toContain('data-margin-chip')
  expect(html).not.toContain('data-margin-action="more-filters"')
  expect(html).toContain('top:100px')
  expect(html).toContain('top:300px')
  expect(html).toContain('is-selected')
  expect(html).not.toContain('mg-switch')
})

test('nothing waiting: nothing is drawn, no bar and no cards', () => {
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([], { layout: null })))
  expect(html).not.toContain('nothing waiting')
  expect(html).not.toContain('data-margin-top')
  expect(html).not.toContain('data-margin-card')
})

test('under the passage no bar is drawn and the cards are left to a later update', () => {
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([change({})], { view: 'under', layout: null })))
  expect(html).not.toContain('data-margin-top')
  expect(html).not.toContain('data-margin-card')
})

test('a card whose passage is gone is a card of its own (ticket 06): Could not be placed, Accept off, the old row gone', () => {
  const lost = change({ id: 'lost', oldText: 'not in the text', newText: 'x' })
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([lost], { layout: null })))
  expect(html).not.toContain('could not be placed in the text')
  expect(html).toContain('data-margin-card="lost"')
  expect(html).toContain('data-margin-stale="gone"')
  expect(html).toContain('Could not be placed')
  expect(html).toContain('Shown at the top of the margin.')
  expect(html).not.toContain('data-margin-action="accept"')
  expect(html).toContain('data-margin-action="decline"')
  expect(html).toContain('data-margin-action="reply"')
})

test('crowded paragraph shows a stack head', () => {
  const changes = ['They', 'are', 'long,', 'they', 'ordered'].map((w, i) => change({ id: `k${i}`, oldText: w, newText: `${w}!` }))
  const model = buildMarginModel({ changes, document: DOC, view: 'margin' })
  const layout = layoutMargin({ cards: layoutCardsFor(model.cards, DOC, { anchorTops: new Map(model.cards.map((c) => [c.id, 40])), heights: new Map(), floor: 0, foldedIds: new Set() }) })
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, { ...panelProps(changes), model, layout }))
  expect(html).toContain('items on this paragraph')
})

test('diffSegments strikes what left, underlines what arrived, keeps a few words of context', () => {
  expect(diffSegments('', 'new')).toEqual([{ kind: 'ins', text: 'new' }])
  expect(diffSegments('old', '')).toEqual([{ kind: 'del', text: 'old' }])
  const segments = diffSegments('one two three four five six seven eight', 'one two three four FIVE six seven eight')
  expect(segments.map((s) => s.kind)).toEqual(['text', 'del', 'text', 'ins', 'text'])
  expect(segments[0].text.startsWith('…') || segments[0].text.startsWith('one')).toBe(true)
})

// ---- the change inside its sentence (ticket 13, frames mixed and focused) ----

const drawn = (segments: DiffSegment[]): string => segments.map((s) => s.kind === 'del' ? `[-${s.text}-]` : s.kind === 'ins' ? `{+${s.text}+}` : s.text).join('')
const PIECE = 'Most lists are long. I have made several of these myself, for courses and for colleagues who asked where to begin, and I never finished one. The rest waits.\n\n## Start with a question\n\n- Cutting in this way is harder than adding.\n'

test('the change is drawn in its sentence: the other words plain, the old struck, the new underlined, all of them', () => {
  const from = PIECE.indexOf('of these myself, ')
  const to = from + 'of these myself, '.length
  expect(drawn(changeInSentence(PIECE, { from, to }, 'of these myself, ', ''))).toBe(
    'I have made several [-of these myself, -]for courses and for colleagues who asked where to begin, and I never finished one.')
})

test('a proposal already in the text (its new words stand there) is drawn the same way', () => {
  const doc = 'Alpha. The middle paragraph says it once. Omega.'
  const from = doc.indexOf('says it once')
  expect(drawn(changeInSentence(doc, { from, to: from + 'says it once'.length }, 'repeats itself', 'says it once'))).toBe(
    'The middle paragraph [-repeats itself-] {+says it once+}.')
})

test('an insertion is drawn at its point inside the sentence; words that end a sentence end it there', () => {
  const doc = 'Three titles to read first, five once the first three have raised questions. Next one.'
  const at = doc.indexOf('once')
  expect(drawn(changeInSentence(doc, { from: at, to: at }, '', 'only '))).toBe('Three titles to read first, five {+only +}once the first three have raised questions.')
  const end = doc.indexOf(' Next')
  const from = doc.indexOf('raised questions.')
  expect(drawn(changeInSentence(doc, { from, to: end }, 'raised questions.', 'asked.'))).toBe('Three titles to read first, five once the first three have [-raised questions.-] {+asked.+}')
})

test('the sentence stops at its line: no heading hashes or list bullets, and no words from the next block', () => {
  const heading = PIECE.indexOf('question')
  expect(drawn(changeInSentence(PIECE, { from: heading, to: heading + 'question'.length }, 'question', 'purpose'))).toBe('Start with a [-question-] {+purpose+}')
  const cut = PIECE.indexOf('in this way ')
  expect(drawn(changeInSentence(PIECE, { from: cut, to: cut + 'in this way '.length }, 'in this way ', ''))).toBe('Cutting [-in this way -]is harder than adding.')
  expect(sentenceAround(PIECE, heading, heading)).toEqual({ start: PIECE.indexOf('Start'), end: PIECE.indexOf('question') + 'question'.length })
})

test('a very long sentence keeps the words nearest the change and an ellipsis; a change across lines keeps its own words', () => {
  const words = Array.from({ length: 80 }, (_, i) => `w${i}`)
  const doc = `${words.join(' ')}.`
  const from = doc.indexOf('w40')
  const segments = changeInSentence(doc, { from, to: from + 3 }, 'w40', 'W40')
  const before = segments[0].text
  const after = segments[segments.length - 1].text
  expect(before.startsWith('…w10 ')).toBe(true)
  expect(before.split(/\s+/).filter(Boolean).length).toBe(SENTENCE_CONTEXT_WORDS)
  expect(after.endsWith('w70…')).toBe(true)
  expect(changeInSentence('# A\n\nB.', { from: 0, to: 0 }, '', '## New\n\n')).toEqual(diffSegments('', '## New\n\n'))
})

test('with the document, the card descriptor draws the edit in its sentence; a reader\'s comment shows its body', () => {
  const [card] = cardsOf([change({ oldText: 'they are ordered', newText: 'ordered' })])
  const d = describeMarginCard(card, 1, Date.parse('2026-10-14T12:00:00'), DOC)
  expect(drawn(d.segments)).toBe('They are long, [-they are -]ordered by when the author found each item.')
  const bare = describeMarginCard(card, 1, Date.parse('2026-10-14T12:00:00'))
  expect(drawn(bare.segments)).toBe('[-they are -]ordered')
  const [note] = cardsOf([change({ oldText: 'A list does one job.', newText: 'A list does one job.', readerNote: { shareId: 'S1', key: 'k', link: 'Seminar', name: 'Marta', kind: 'note', text: 'Which job?', quote: 'A list does one job.', anchored: 'unchanged', at: 1 }, outsideSource: 'reader' })])
  const n = describeMarginCard(note, 2, Date.parse('2026-10-14T12:00:00'), DOC)
  expect(n.segments).toEqual([])
  expect(n.reader?.note).toBe('Which job?')
})

test('an agent comment shows its body, not the words it is on (those are marked in the text)', () => {
  const [card] = cardsOf([change({ oldText: 'A list does one job.', newText: 'A list does one job.', summary: 'Say what the first five lines should hold.' })])
  const d = describeMarginCard(card, 1, Date.parse('2026-10-14T12:00:00'), DOC)
  expect(d.kindLabel).toBe('Comment')
  expect(d.body).toBe('Say what the first five lines should hold.')
  expect(d.segments).toEqual([])
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([card.change], { document: DOC })))
  expect(html).toContain('Say what the first five lines should hold.')
})

test('whenLabel says Today for today and a date otherwise', () => {
  const now = Date.parse('2026-10-14T12:00:00')
  expect(whenLabel(Date.parse('2026-10-14T09:05:00'), now)).toBe('Today, 09:05')
  expect(whenLabel(Date.parse('2026-10-13T18:02:00'), now)).toBe('13 Oct, 18:02')
})

test('geometry: paragraphs are blank-line blocks; narrow editors fall back to under the passage', () => {
  expect(paragraphKey(DOC, 5)).toBe(paragraphKey(DOC, 30))
  expect(paragraphKey(DOC, 5)).not.toBe(paragraphKey(DOC, DOC.indexOf('A list')))
  expect(effectiveMarginView('margin', 400)).toBe('margin')
  expect(effectiveMarginView('margin', 399)).toBe('under')
  expect(effectiveMarginView('under', 1400)).toBe('under')
})

test('layout cards sit no higher than the head floor, and a card folded by the writer is one line high', () => {
  const [card] = cardsOf([change({})])
  const [laid] = layoutCardsFor([card], DOC, { anchorTops: new Map([[card.id, 10]]), heights: new Map([[card.id, 140]]), floor: 70, foldedIds: new Set([card.id]) })
  expect(laid.anchorTop).toBe(70)
  expect(laid.height).toBe(36)
})

// ---- part-title proposals WriteFlex filed itself ----
const proposal = (over: Partial<Change> = {}): Change => change({
  id: 'p1', editClass: 'housekeeping', category: 'structure', summary: 'Add the heading “A list” and a matching title',
  oldText: 'A list does one job.', newText: '# A list\n\nA list does one job.', author: { name: 'WriteFlex' }, ...over,
})

test('a heading proposal WriteFlex filed is labelled WriteFlex and offers No heading in the text under More', () => {
  const [card] = cardsOf([proposal()])
  const d = describeMarginCard(card, 1, Date.parse('2026-10-14T12:00:00'))
  expect([d.name, d.roleTagText]).toEqual(['WriteFlex', 'WriteFlex'])
  expect(d.more.map((a) => a.label)).toContain('No heading in the text')
})

test('the match-the-title proposal is labelled WriteFlex but has no No heading item; a real agent change keeps Agent', () => {
  const [match] = cardsOf([proposal({ summary: 'Make the title match the heading “A list”' })])
  const dm = describeMarginCard(match, 1)
  expect(dm.name).toBe('WriteFlex')
  expect(dm.more.map((a) => a.label)).not.toContain('No heading in the text')
  // The agent bridge files the same shape and summary under its own author: that is the agent's change.
  const [real] = cardsOf([proposal({ id: 'r', author: { name: 'WriteFlex Agent' } })])
  const dr = describeMarginCard(real, 1)
  expect([dr.name, dr.roleTagText]).toEqual(['Agent', 'agent'])
  expect(dr.more.map((a) => a.label)).not.toContain('No heading in the text')
})

test('No heading in the text runs the context hook with the change', async () => {
  const { actions, context } = harness([])
  const seen: string[] = []
  await runMarginAction('no-heading', proposal(), actions, { ...context, keepTitleInMetadataOnly: (c) => { seen.push(c.id) } })
  expect(seen).toEqual(['p1'])
})

// ---- 0.24 ticket 07: readers' cards (frames review-margin, review-cannot-apply) ----
const readerChange = (over: Partial<Change>, fields: Partial<NonNullable<Change['readerNote']>> = {}): Change => change({
  id: 'r1', provenance: 'agent', category: 'other', oldText: 'they are ordered', newText: 'they are ordered', summary: 'Which kind?',
  outsideSource: 'reader', outsideRequest: { id: 'reader-s-k', index: 1, count: 1, at: Date.parse('2026-10-14T13:51:00') },
  readerNote: { shareId: 'ShareIdOne1', key: 'k.1', link: 'For Marta', name: 'Marta', kind: 'note', text: 'Which kind of book do you mean?', quote: 'they are ordered', anchored: 'unchanged', at: Date.parse('2026-10-14T13:51:00'), ...fields },
  ...over,
})

test("a reader's note is a card with the reader's name, the reader tag, the link, its text, Done and Reply", () => {
  const [card] = cardsOf([readerChange({})])
  const d = describeMarginCard(card, 3, Date.parse('2026-10-14T14:00:00'))
  expect([d.name, d.roleTagText, d.kindLabel, d.when]).toEqual(['Marta', 'reader', 'Comment', 'Today, 13:51'])
  // Ticket 08: reader cards are the exception to "no Reply on an outside card".
  expect(d.primary.map((a) => a.label)).toEqual(['Done', 'Reply'])
  expect(d.reader).toEqual({ link: 'For Marta', note: 'Which kind of book do you mean?', written: null, changed: false, gone: false, ambiguous: false, closed: null, replies: [], noteGone: false, canMarkDone: true })
})

test("a reader's proposed edit has Accept, Decline and Reply and shows the words it changes", () => {
  const [card] = cardsOf([readerChange({ newText: 'they are sorted' }, { kind: 'edit', name: 'Jonas', link: 'Workshop group', text: 'sorted' })])
  const d = describeMarginCard(card, 1)
  expect(d.primary.map((a) => a.label)).toEqual(['Accept', 'Decline', 'Reply'])
  expect(d.reader?.canMarkDone).toBe(false)
  expect(d.segments.some((s) => s.kind === 'ins' && s.text === 'sorted')).toBe(true)
})

test('reader text is drawn as text, never as markup', () => {
  const hostile = readerChange({}, { name: '<img src=x onerror=alert(1)>', text: '<script>alert(1)</script>', link: '<b>link</b>', anchored: 'changed', quote: '<i>words</i>' })
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([hostile])))
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('<b>link')
  expect(html).not.toContain('<i>words')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('Written on these words')
  expect(html).toContain('Passage changed')
  expect(html).toContain('Shown beside the nearest passage.')
})

test('a note whose words are gone waits in the head without a place, with the quoted words', () => {
  const gone = readerChange({ oldText: 'never in the text', newText: 'never in the text' }, { anchored: 'gone', quote: 'never in the text' })
  const model = buildMarginModel({ changes: [gone], document: DOC, view: 'margin' })
  expect(model.cards).toHaveLength(0)
  expect(model.unplaced.map((u) => u.id)).toEqual(['r1'])
  expect(model.sourceFacets.map((f) => f.label)).toEqual(['Readers'])
})

// ---- 0.24 ticket 07, part 2: a reader's edit that could not be applied (frame review-cannot-apply) ----
const REASON = 'You changed these words after Jonas sent this, so the edit could not be applied. Their wording is kept here.'
/** As the collector records it (sharing-reader-notes.ts readerChangeFor): closed, no text of its own, the reader's wording kept. */
const closedEdit = (words: string | undefined, fields: Partial<NonNullable<Change['readerNote']>> = {}): Change => readerChange({
  id: 'x1', oldText: '', newText: '', status: 'rejected', closedReason: REASON, closedAt: Date.parse('2026-10-14T13:52:00'), closedCode: 'target-gone',
  outsideRefused: true, outsideIntended: { oldText: 'a reason for each', newText: 'a one-line reason for each', cut: false },
  ...(words !== undefined ? { anchor: { from: DOC.indexOf(words), to: DOC.indexOf(words) + words.length } } : {}),
} as Partial<Change>, { kind: 'edit', name: 'Jonas', link: 'Workshop group', text: 'a one-line reason for each', quote: 'a reason for each', anchored: 'changed', ...(words !== undefined ? { words } : {}), ...fields })

test("a reader's closed edit is a card beside its words: Could not be applied, its words, their wording, the reason, Copy, Reply and Dismiss only", () => {
  const model = buildMarginModel({ changes: [closedEdit('A list does one job.')], document: DOC, view: 'margin' })
  expect(model.notPlaced).toHaveLength(0)
  expect(model.cards.map((c) => [c.id, c.status, c.anchor.from])).toEqual([['x1', 'closed', DOC.indexOf('A list does one job.')]])
  const d = describeMarginCard(model.cards[0], 1, Date.parse('2026-10-14T14:00:00'))
  expect([d.name, d.roleTagText, d.kindLabel, d.statusLabel]).toEqual(['Jonas', 'reader', 'Proposed edit', 'Could not be applied'])
  // Ticket 08 (frame review-cannot-apply): Copy <name>'s wording, Reply, Dismiss.
  expect(d.primary.map((a) => [a.id, a.label])).toEqual([['copy-wording', 'Copy Jonas’s wording'], ['reply', 'Reply'], ['dismiss', 'Dismiss']])
  expect(d.more).toEqual([])
  expect(d.reader).toMatchObject({ link: 'Workshop group', written: 'a reason for each', closed: { reason: REASON, wording: 'a one-line reason for each' } })
  expect(d.segments.some((s) => s.kind === 'ins' && s.text.trim() === 'one-line')).toBe(true)
  // No key accepts or declines it; R replies (ticket 08).
  for (const key of ['a', 'A', 'd']) expect(cardKeyAction(key, d)).toBeNull()
  expect(cardKeyAction('r', d)).toBe('reply')
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([closedEdit('A list does one job.')])))
  expect(html).toContain('Could not be applied')
  expect(html).toContain(REASON)
  expect(html).toContain('Copy Jonas’s wording')
  expect(html).not.toContain('data-margin-action="accept"')
  expect(html).not.toContain('data-margin-action="decline"')
  expect(html).not.toContain('data-margin-action="more"')
})

test("a reader's closed edit is never in Accept all or Decline all, and Dismiss and Copy write nothing", async () => {
  const model = buildMarginModel({ changes: [closedEdit('A list does one job.'), change({})], document: DOC, view: 'margin' })
  const targets = bulkTargets(model, new Set(['x1', 'c1']), undefined)
  expect(targets.ids).toEqual(['c1'])
  expect(targets.declinable).toEqual(['c1'])
  const h = harness([closedEdit('A list does one job.')])
  const copied: string[] = []
  const dismissed: string[] = []
  const context = { ...h.context, copyText: (text: string) => { copied.push(text) }, dismiss: (id: string) => { dismissed.push(id) } }
  await runMarginAction('copy-wording', closedEdit('A list does one job.'), h.actions, context)
  await runMarginAction('dismiss', closedEdit('A list does one job.'), h.actions, context)
  expect(copied).toEqual(['a one-line reason for each'])
  expect(dismissed).toEqual(['x1'])
  expect(h.calls).toEqual([])
  // Dismissed: the card goes.
  expect(buildMarginModel({ changes: [closedEdit('A list does one job.')], document: DOC, view: 'margin', dismissedIds: new Set(['x1']) }).cards).toHaveLength(0)
})

test("a reader's closed edit whose words are gone waits in the head, with Copy <name>'s wording", () => {
  const gone = closedEdit(undefined, { anchored: 'gone' })
  const model = buildMarginModel({ changes: [gone], document: DOC, view: 'margin' })
  expect(model.cards).toHaveLength(0)
  expect(model.notPlaced.map((c) => c.id)).toEqual(['x1'])
  // Its words edited away since it was collected: also the head.
  const moved = buildMarginModel({ changes: [closedEdit('A list does one job.')], document: DOC.replace('A list does one job.', 'A list has one job.'), view: 'margin' })
  expect(moved.cards).toHaveLength(0)
  expect(moved.notPlaced.map((c) => c.id)).toEqual(['x1'])
})

test('a note whose words stand in more than one place is flagged where it is shown', () => {
  const tied = readerChange({}, { ambiguous: true })
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([tied])))
  expect(html).toContain('data-margin-flag="ambiguous"')
  expect(html).toContain('These words stand in more than one place.')
})

test('Readers can be narrowed to one link (frame review-filter-and-all)', () => {
  const marta = readerChange({ id: 'm1' })
  const workshop = readerChange({ id: 'w1', anchor: undefined, oldText: 'A list does one job.', newText: 'A list does one job.' }, { shareId: 'ShareIdTwo2', link: 'Workshop group' })
  const all = buildMarginModel({ changes: [marta, workshop, change({})], document: DOC, view: 'margin' })
  expect(all.linkFacets).toEqual([{ shareId: 'ShareIdOne1', label: 'For Marta', count: 1 }, { shareId: 'ShareIdTwo2', label: 'Workshop group', count: 1 }])
  const one = buildMarginModel({ changes: [marta, workshop, change({})], document: DOC, view: 'margin', filter: { links: new Set(['ShareIdTwo2']) } })
  expect(one.cards.map((c) => c.id)).toEqual(['w1'])
  expect(one.counts.total).toBe(3)
})

// ---- 0.24 ticket 08: replying to a reader on a card (frame review-reply) ----
test('Reply on a reader\'s card opens the reply box in the card; it never goes to the agent', async () => {
  const h = harness([readerChange({})])
  const opened: string[] = []
  await runMarginAction('reply', readerChange({}), h.actions, { ...h.context, openReply: (id) => { opened.push(id) } })
  expect(opened).toEqual(['r1'])
  // Without a reply box nothing happens: a reader's note is never handed to the agent's composer.
  await runMarginAction('reply', readerChange({}), h.actions, h.context)
  expect(h.calls).toEqual([])
  // An agent card's Reply is still the composer.
  await runMarginAction('reply', change({}), h.actions, h.context)
  expect(h.calls.some((call) => call.startsWith('composer:'))).toBe(true)
})

test('the reply box: Reply to <name>, who sees it and when, the count of 1,000, Send reply, Send and mark done on a waiting note, Cancel', () => {
  const draft = 'A history of phonics teaching, for example. I will name one in the next draft.'
  const reply = { draft: { id: 'r1', text: draft }, sending: false, error: null, onChange: () => undefined, onCancel: () => undefined, onSend: () => undefined }
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([readerChange({})], { reply })))
  expect(html).toContain('Reply to Marta')
  expect(html).toContain('Marta sees this on their page the next time it loads.')
  expect(html).toContain(`${draft.length} of 1,000`)
  expect(html).toContain('data-margin-action="send-reply"')
  expect(html).toContain('data-margin-action="send-reply-done"')
  expect(html).toContain('data-margin-action="cancel-reply"')
  // The box replaces the card's own buttons while it is open.
  expect(html).not.toContain('data-margin-action="accept"')
  // On a proposed edit there is no Send and mark done.
  const edit = readerChange({ newText: 'they are sorted' }, { kind: 'edit', text: 'sorted' })
  const onEdit = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([edit], { reply })))
  expect(onEdit).toContain('data-margin-action="send-reply"')
  expect(onEdit).not.toContain('data-margin-action="send-reply-done"')
})

test('a reply the service refused, and a note it no longer holds, are shown as not sent, never Sent (Sol review round 1)', () => {
  const at = Date.parse('2026-10-14T14:12:00')
  const full = readerChange({ readerReplies: [{ id: 'reply-0001', text: 'One too many.', at, by: 'Dominik', notSent: 'full' }] } as Partial<Change>)
  const [fullCard] = cardsOf([full])
  expect(describeMarginCard(fullCard, 1, at).reader?.replies.map((r) => [r.state, r.sent])).toEqual([['full', false]])
  const fullHtml = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([full])))
  expect(fullHtml).toContain('data-margin-reply="full"')
  expect(fullHtml).toContain('Not sent: this comment has reached its 20 replies')
  expect(fullHtml).not.toContain('>Sent<')
  expect(fullHtml).not.toContain('Not sent yet')
  // Gone: a reply queued before the service answered, and one written after, both not on the reader's page.
  const gone = readerChange({ readerGone: at, readerReplies: [
    { id: 'reply-0002', text: 'Written on the train.', at, by: 'Dominik', notSent: 'gone' },
    { id: 'reply-0003', text: 'Written after.', at: at + 1, by: 'Dominik' },
  ] } as Partial<Change>)
  const [goneCard] = cardsOf([gone])
  const d = describeMarginCard(goneCard, 1, at)
  expect(d.reader?.noteGone).toBe(true)
  expect(d.reader?.replies.map((r) => r.state)).toEqual(['gone', 'gone'])
  const goneHtml = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([gone])))
  expect(goneHtml).toContain('data-margin-note-gone')
  expect(goneHtml).toContain('This comment is no longer on the reader&#x27;s page.')
  // Twice in the thread (drawn on focus), once more at rest as the card's exception line (ticket 06, from 05).
  expect(goneHtml.split('Not sent: this comment is no longer on the reader&#x27;s page')).toHaveLength(4)
  expect(goneHtml).toContain('data-margin-reply-exception')
  expect(goneHtml).not.toContain('>Sent<')
  // Gone with nothing written back: the notice alone.
  const bare = readerChange({ readerGone: at } as Partial<Change>)
  expect(renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([bare])))).toContain('data-margin-note-gone')
})

test('a reply marked both Sent and refused shows the refusal, never Sent; a reply sent before its note was cleared stays Sent (Sol review round 2)', () => {
  const at = Date.parse('2026-10-14T14:12:00')
  const both = readerChange({ readerReplies: [
    { id: 'reply-0001', text: 'Both marks.', at, by: 'Dominik', sent: at + 5, notSent: 'full' },
    { id: 'reply-0002', text: 'Both, gone.', at, by: 'Dominik', sent: at + 5, notSent: 'gone' },
  ] } as Partial<Change>)
  const [card] = cardsOf([both])
  expect(describeMarginCard(card, 1, at).reader?.replies.map((r) => [r.state, r.sent])).toEqual([['full', false], ['gone', false]])
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([both])))
  expect(html).not.toContain('>Sent<')
  expect(html).toContain('Not sent: this comment has reached its 20 replies')
  const earlier = readerChange({ readerGone: at + 10, readerReplies: [{ id: 'reply-0003', text: 'Sent first.', at, by: 'Dominik', sent: at + 5 }] } as Partial<Change>)
  const [earlierCard] = cardsOf([earlier])
  expect(describeMarginCard(earlierCard, 1, at).reader?.replies.map((r) => r.state)).toEqual(['sent'])
})

test('a reply on a link whose sharing service is too old to confirm it says to update the service (Sol review round 2)', () => {
  const at = Date.parse('2026-10-14T14:12:00')
  const waits = readerChange({ readerRepliesWait: true, readerReplies: [{ id: 'reply-0001', text: 'Waiting.', at, by: 'Dominik' }] } as Partial<Change>)
  const [card] = cardsOf([waits])
  expect(describeMarginCard(card, 1, at).reader?.replies.map((r) => [r.state, r.sent])).toEqual([['update', false]])
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([waits])))
  expect(html).toContain('data-margin-reply="update"')
  expect(html).toContain('Not sent yet: update the sharing service in Settings › Sharing')
  expect(html).not.toContain('>Sent<')
})

test('the writer\'s replies are drawn under the note as text, each Sent or Not sent yet', () => {
  const replied = readerChange({ readerReplies: [
    { id: 'reply-0001', text: '<img src=x onerror=alert(1)> One line, yes.', at: Date.parse('2026-10-14T14:12:00'), by: 'Dominik', sent: Date.parse('2026-10-14T14:12:05') },
    { id: 'reply-0002', text: 'Would a short phrase be enough?', at: Date.parse('2026-10-14T14:20:00'), by: 'Dominik' },
  ] } as Partial<Change>)
  const [card] = cardsOf([replied])
  const d = describeMarginCard(card, 1, Date.parse('2026-10-14T15:00:00'))
  expect(d.reader?.replies.map((r) => [r.by, r.when, r.sent])).toEqual([['Dominik', 'Today, 14:12', true], ['Dominik', 'Today, 14:20', false]])
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([replied])))
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; One line, yes.')
  expect(html).toContain('data-margin-reply="sent"')
  expect(html).toContain('data-margin-reply="unsent"')
  expect(html).toContain('Not sent yet')
  expect(html).toContain('>author<')
  // Folded, the card says how many replies it has.
  const folded = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([replied], { foldedIds: new Set(['r1']) })))
  expect(folded).toContain('Marta')
  expect(folded).toContain(' · 1 comment')
  expect(folded).toContain('title="2 replies"')
})

// ---- the quiet card (ticket 01, ADR-0046) ----
const NOW = Date.parse('2026-10-14T12:00:00')
const readerNote = (): Change => readerChange({}, { link: 'Seminar group', at: Date.parse('2026-10-13T18:40:00') })

test('card descriptor: hover buttons, keys on every action, role line, and a status only when it is not Open', () => {
  const edit = describeMarginCard(cardsOf([change({})])[0], 1, NOW)
  expect(edit.hover.map((a) => [a.id, a.key])).toEqual([['accept', 'A'], ['decline', 'D']])
  expect(edit.primary.map((a) => a.key)).toEqual(['A', 'D', 'R'])
  expect(edit.more.map((a) => a.key)).toEqual(['⌥⌘↵', 'H', '↵', 'S'])
  expect([edit.time, edit.statusSpeaks, edit.roleLine]).toEqual(['11:40', false, 'Agent, Today, 11:40. Reply goes to the agent.'])
  const held = describeMarginCard(cardsOf([change({ status: 'held' })])[0], 1, NOW)
  expect(held.statusSpeaks).toBe(true)
  const outside = describeMarginCard(cardsOf([change({ provenance: 'reviewer', reviewerLabel: 'Claude Code', oldText: 'Hours?', newText: 'Hours or pages?', outsideRequest: { id: 'q', at: Date.parse('2026-10-14T21:12:00'), index: 2, count: 5 } })])[0], 2, NOW)
  expect(outside.roleLine).toBe('Claude Code, request of 21:12, change 2 of 5. No reply goes back.')
  expect(outside.hover.map((a) => a.id)).toEqual(['accept', 'decline'])
})

test('card descriptor: a reader note hovers Done and Reply, names the link on its role line, and has no Send original', () => {
  const note = describeMarginCard(cardsOf([readerNote()])[0], 3, NOW)
  expect(note.hover.map((a) => a.label)).toEqual(['Done', 'Reply'])
  expect(note.roleLine).toBe('Reader Marta, through the link “Seminar group”, 13 Oct, 18:40.')
  expect(note.time).toBe('Yesterday')
  expect(note.more.map((a) => a.id)).toEqual(['show'])
})

test('card keys: the letters a card has a button for, Enter shows, Backspace dismisses only a closed edit', () => {
  const edit = describeMarginCard(cardsOf([change({})])[0], 1, NOW)
  expect(['a', 'd', 'r', 'h', 's', 'Enter', 'n', 'c', 'Backspace', 'x'].map((k) => cardKeyAction(k, edit))).toEqual(['accept', 'decline', 'reply', 'hold', 'to-scratchpad', 'show', null, null, null, null])
  const note = describeMarginCard(cardsOf([readerNote()])[0], 1, NOW)
  expect(['a', 'd', 'h', 's'].map((k) => cardKeyAction(k, note))).toEqual(['accept', null, null, null])
  const heading = describeMarginCard(cardsOf([proposal()], 'A list does one job.\n')[0], 1, NOW)
  expect(cardKeyAction('n', heading)).toBe('no-heading')
})

test('the card at rest: no Open word, no kind word other than Comment or the edit kind, hover buttons drawn, actions carry keys', () => {
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([change({ id: 'a' }), readerNote()], { selectedId: null, now: NOW })))
  expect(html).not.toContain('data-margin-status')
  expect(html).not.toContain('>Open<')
  expect(html).toContain('data-margin-quick-action="accept"')
  expect(html).toContain('data-margin-quick-action="decline"')
  expect(html).toContain('Comment')
  expect(html).toContain('data-margin-leader')
  expect(html).not.toContain('is-focus')
  // The labelled actions are drawn for focus to reveal, each with its key.
  expect(html).toContain('data-margin-action="accept"')
  expect(html).toMatch(/Accept<kbd>A<\/kbd>/)
  expect(html).toContain('Done<kbd>A</kbd>')
})

test('a focused or selected card wears is-focus; a held card says Held both; an unread card has a dot', () => {
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([change({ id: 'a', status: 'held' })], { focusedId: 'a', unreadIds: new Set(['a']), now: NOW })))
  expect(html).toContain('is-focus')
  expect(html).toContain('Held both')
  expect(html).toContain('data-margin-unread')
  expect(html).toContain('Agent, Today, 11:40')
})

test('the card actions reach the same ledger calls (hold, no heading, scratchpad)', async () => {
  const c = change({})
  const { calls, actions, context } = harness([c])
  let kept = ''
  await runMarginAction('no-heading', c, actions, { ...context, keepTitleInMetadataOnly: (x) => { kept = x.id } })
  await runMarginAction('hold', c, actions, context)
  expect(kept).toBe('c1')
  expect(calls).toEqual(['ledger.status:c1:held'])
})

// ---- 0.24 ticket 05: the thread and the composer (frames thread, component-sheet) ----
test('the thread part of a reader comment: each reply says Sent, Not sent yet, the update wording or Not sent (20 replies)', () => {
  const at = Date.parse('2026-10-14T14:12:00')
  const change = readerChange({ readerReplies: [
    { id: 'a', text: 'One.', at, by: 'Dominik', sent: at + 5 },
    { id: 'b', text: 'Two.', at: at + 1, by: 'Dominik' },
    { id: 'c', text: 'Three.', at: at + 2, by: 'Dominik', notSent: 'full' },
  ] } as Partial<Change>)
  const [card] = cardsOf([change])
  const d = describeMarginCard(card, 1, at + 60_000)
  expect(d.reader?.replies.map((r) => r.stateLabel)).toEqual(['Sent', 'Not sent yet', 'Not sent: this comment has reached its 20 replies'])
  expect(replyStateLabel('update')).toBe('Not sent yet: update the sharing service in Settings › Sharing')
  expect([replyCountLabel(1), replyCountLabel(2)]).toEqual(['1 reply', '2 replies'])
})

test('the thread is drawn in full (no clamp) and hidden at rest by the card, which shows the count; the composer says Send, Send and mark done, Cancel', async () => {
  const css = await Bun.file('src/renderer/src/styles/app.css').text()
  expect(css).toContain('.mg-card:not(.is-focus) .mg-thread{display:none}')
  expect(css).not.toContain('.mg-card:not(.is-focus) .mg-thread .t-body')
  const replied = readerChange({ readerReplies: [{ id: 'a', text: 'Yes. I will add a title.', at: Date.parse('2026-10-14T14:12:00'), by: 'Dominik', sent: Date.parse('2026-10-14T14:12:05') }] } as Partial<Change>)
  const reply = { draft: { id: 'r1', text: 'Good point.' }, sending: false, error: null, onChange: () => undefined, onCancel: () => undefined, onSend: () => undefined }
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([replied], { reply })))
  expect(html).toContain('title="1 reply"')
  expect(html).toContain('data-margin-thread')
  expect(html).toContain('Send<kbd>⌘↵</kbd>')
  expect(html).toContain('Send and mark done')
  expect(html).toContain('Cancel<kbd>Esc</kbd>')
  expect(html).toContain('1,000')
})

// ---- ticket 06: stale items, refused Accept, settled rows, the resting exception line ----
import { describeSettledRow } from '../../src/renderer/src/app/margin-card'
import { layoutEntriesFor, marginEntriesOf } from '../../src/renderer/src/app/margin-geometry'

test('Passage changed: the words it was written on, why, and Accept off (Decline and Reply remain)', () => {
  const written = 'A list does one task'
  const at = DOC.indexOf('A list does one job')
  const drift = change({ id: 'd', oldText: written, newText: 'A list does one thing', anchor: { from: at, to: at + written.length } })
  const model = buildMarginModel({ changes: [drift], document: DOC, view: 'margin' })
  const d = describeMarginCard(model.cards[0], 1, Date.now(), DOC)
  expect(d.stale).toEqual({ kind: 'changed', label: 'Passage changed', written, notice: 'You changed these words after this was proposed. Nothing was applied. Decline it, or Reply to send it back.' })
  expect(d.primary.map((a) => a.id)).toEqual(['decline', 'reply'])
  expect(d.more.map((a) => a.id)).toEqual(['show', 'to-scratchpad'])
  expect(d.hover.map((a) => a.id)).toEqual(['decline', 'reply'])
  expect(cardKeyAction('a', d)).toBeNull()
  expect(cardKeyAction('d', d)).toBe('decline')
})

test('Could not be placed keeps the old head row\'s Done, Decline, Reply and Send original on the card', () => {
  const at = DOC.indexOf('Hours or pages?')
  const goneEdit = change({ id: 'g', oldText: 'which is a different thing', newText: 'which is another thing', anchor: { from: at, to: at + 26 } })
  const goneNote = change({ id: 'n', oldText: 'gone words', newText: 'gone words', summary: 'A note on gone words' })
  const model = buildMarginModel({ changes: [goneEdit, goneNote], document: DOC, view: 'margin' })
  const [edit, note] = model.unplaced.map((item) => describeMarginCard(item, 1))
  expect(edit.stale?.label).toBe('Could not be placed')
  expect(edit.stale?.notice).toBe('These words are no longer in the piece. Shown at the paragraph they were in.')
  expect(edit.primary.map((a) => a.id)).toEqual(['decline', 'reply'])
  expect(edit.more.map((a) => a.id)).toContain('to-scratchpad')
  expect(note.primary.map((a) => a.label)).toEqual(['Done', 'Reply'])
  expect(note.stale?.notice).toBe('These words are no longer in the piece. Shown at the top of the margin.')
})

test('a refused Accept: the waiting card says Could not be applied with main\'s reason, and Accept is off until it clears', () => {
  const [card] = cardsOf([change({})])
  const reason = 'The words around this change now stand more than once in draft.md, so it has no one place to go; ask the agent to redo the edit.'
  const d = describeMarginCard(card, 1, Date.now(), DOC, { refused: reason })
  expect(d.refused).toBe(reason)
  expect(d.primary.map((a) => a.id)).toEqual(['decline', 'reply'])
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, panelProps([change({})], { refused: new Map([['c1', reason]]) })))
  expect(html).toContain('Could not be applied')
  expect(html).toContain('data-margin-refused-reason')
  expect(html).not.toContain('data-margin-action="accept"')
  // Cleared (the writer declined, or the text changed): Accept is back.
  expect(describeMarginCard(card, 1, Date.now(), DOC).primary.map((a) => a.id)).toEqual(['accept', 'decline', 'reply'])
})

test('a settled row: dim, one line, its outcome and number; O reopens through the existing reopen action', async () => {
  const accepted = change({ id: 's', status: 'accepted', oldText: 'They are long, they are ordered', newText: 'They are long and ordered' })
  const doc = DOC.replace('They are long, they are ordered', 'They are long and ordered')
  const waiting = change({ id: 'w', oldText: 'A list does one job', newText: 'A list does one thing' })
  const model = buildMarginModel({ changes: [accepted, waiting], document: doc, view: 'margin', settledHere: new Set(['s']) })
  const row = describeSettledRow(model.settled[0], model.markers.get('s')!)
  expect([row.marker, row.name, row.outcome, row.words]).toEqual([1, 'Agent', 'Accepted', 'They are long and ordered'])
  expect(cardKeyAction('o', row)).toBe('reopen')
  expect(cardKeyAction('a', row)).toBeNull()
  // Drawn: the row beside its words, with no card and no mark of its own.
  const entries = marginEntriesOf(model)
  const layout = layoutMargin({ cards: layoutEntriesFor(entries, doc, { anchorTops: new Map([['s', 100], ['w', 300]]), heights: new Map(), floor: 0, foldedIds: new Set() }) })
  const { actions, context } = harness([accepted, waiting])
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, { ...panelProps([waiting]), model, layout, document: doc, context: { ...context, reopen: (id) => actions.reopenChange(id) } }))
  expect(html).toContain('data-margin-settled-row="s"')
  expect(html).toContain('data-outcome="accepted"')
  expect(html.match(/data-margin-card="/g)?.length).toBe(1)
  // Reopen: the existing reopen action, the item back to waiting.
  const h = harness([accepted])
  await runMarginAction('reopen', accepted, h.actions, { ...h.context, reopen: (id) => h.actions.reopenChange(id) })
  expect(h.calls).toEqual(['ledger.status:s:pending'])
})

test('at rest a reader comment with an unsent reply says so in the thread\'s words (from 05)', () => {
  const unsent = readerChange({ readerReplies: [{ id: 'r', text: 'Thanks', at: Date.parse('2026-10-14T14:00:00'), by: 'You' }] } as Partial<Change>)
  const [card] = cardsOf([unsent])
  expect(describeMarginCard(card, 1).replyException).toBe('Not sent yet')
  const sent = readerChange({ readerReplies: [{ id: 'r', text: 'Thanks', at: Date.parse('2026-10-14T14:00:00'), by: 'You', sent: Date.parse('2026-10-14T14:01:00') }] } as Partial<Change>)
  expect(describeMarginCard(cardsOf([sent])[0], 1).replyException).toBeNull()
  const full = readerChange({ readerReplies: [{ id: 'r', text: 'Thanks', at: 1, by: 'You', notSent: 'full' }] } as Partial<Change>)
  expect(describeMarginCard(cardsOf([full])[0], 1).replyException).toBe(replyStateLabel('full'))
})
