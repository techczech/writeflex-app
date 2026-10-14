import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { AgentNotesView, groupProseNotes, noteTaskTarget, proposalOnTask, reviewProgress, taskProposalsFrom } from '../../src/renderer/src/components/AgentNotes'
import type { AgentNote, AgentProseNote, Change } from '../../src/preload'
import { readTaskLines } from '../../src/shared/markdown/task-lines'

// Requirement: "I can't get to the file and cannot find it by searching — it becomes
// invisible — I need to be able to see it side by side with the text it comments on."

const actions = { onOpenFile: () => {}, onReveal: () => {}, onRestage: async () => {} }

const prose = (over: Partial<AgentProseNote> & { path: string; sourceDocument: string }): AgentNote => ({
  noteType: 'prose',
  title: 'Review of why-schemas-matter',
  kind: 'review',
  created: '2026-09-13T00:40:00.000Z',
  skill: 'review',
  body: '## Verdict\n\nThe argument **holds**.\n\n- keep the schema example\n',
  bodyLine: 1,
  bodyOffset: 0,
  ...over,
})

const review = prose({ path: 'blogs/schemas-and-propositions/agent-notes/why-schemas-matter.review.md', sourceDocument: 'blogs/schemas-and-propositions/why-schemas-matter.md' })
const sibling = prose({
  path: 'blogs/schemas-and-propositions/agent-notes/another-piece.comments.md', sourceDocument: 'blogs/schemas-and-propositions/another-piece.md',
  title: 'Comments of another-piece', kind: 'comments', body: 'Sibling note body.\n',
})
const elsewhere = prose({ path: 'essays/agent-notes/metaphor.review.md', sourceDocument: 'essays/metaphor.md', title: 'Review of metaphor', body: 'Far away.\n' })
const object: AgentNote = {
  noteType: 'object', path: 'blogs/schemas-and-propositions/agent-notes/20260912T090000Z-abcd1234.md', recordedAt: '2026-09-12T09:00:00.000Z',
  sourceDocument: 'blogs/schemas-and-propositions/why-schemas-matter.md', kind: 'table', source: '| a | b |\n| --- | --- |\n| 1 | 2 |', status: 'discarded', summary: 'A table',
  settlements: [{ status: 'discarded', recordedAt: '2026-09-12T09:00:00.000Z' }],
}

const render = (notes: AgentNote[], activePath: string | null): string =>
  renderToStaticMarkup(<AgentNotesView notes={notes} activePath={activePath} dir="blogs/schemas-and-propositions" actions={actions} />)

test('a note about the open piece renders its markdown body with title, kind, skill, date and both actions', () => {
  const html = render([review, sibling, elsewhere, object], 'blogs/schemas-and-propositions/why-schemas-matter.md')
  const onThisPiece = html.slice(html.indexOf('Notes on this piece'), html.indexOf('Other notes in this folder'))
  expect(onThisPiece).toContain('Review of why-schemas-matter')
  expect(onThisPiece).toContain('>review<')
  expect(onThisPiece).toContain('via review')
  expect(onThisPiece).toContain('dateTime="2026-09-13T00:40:00.000Z"')
  // The body is rendered markdown, not the raw source.
  expect(onThisPiece).toMatch(/<h2[^>]*>Verdict<\/h2>/)
  expect(onThisPiece).toContain('<strong>holds</strong>')
  expect(onThisPiece).toContain('<li>keep the schema example</li>')
  expect(onThisPiece).not.toContain('## Verdict')
  expect(onThisPiece).toContain('aria-label="Open as file: Review of why-schemas-matter"')
  expect(onThisPiece).toContain('aria-label="Reveal in sidebar: Review of why-schemas-matter"')
  // The sibling note is in the collapsed section; the far-away note is in neither; objects keep theirs.
  const other = html.slice(html.indexOf('Other notes in this folder'), html.indexOf('Discarded objects'))
  expect(html).toMatch(/<details class="an-section an-collapsed"><summary/)
  expect(html).not.toContain('<details class="an-section an-collapsed" open')
  expect(other).toContain('Comments of another-piece')
  expect(other).toContain('Sibling note body.')
  expect(onThisPiece).not.toContain('Comments of another-piece')
  expect(html).not.toContain('Review of metaphor')
  expect(html.slice(html.indexOf('Discarded objects'))).toContain('aria-label="Restage"')
})

test('the source path is matched by the document it names, not by its spelling', () => {
  const spelt = prose({ path: 'essays/agent-notes/metaphor.comments.md', sourceDocument: './essays//metaphor' })
  const { onThisPiece, inThisFolder } = groupProseNotes([spelt as AgentProseNote & { noteType: 'prose' }], 'essays/metaphor.md', '')
  expect(onThisPiece.map((note) => note.path)).toEqual(['essays/agent-notes/metaphor.comments.md'])
  expect(inThisFolder).toEqual([])
})

test('with no open piece the pane says so and still offers the folder’s notes collapsed', () => {
  const html = render([sibling], null)
  expect(html).toContain('Open a piece to see the notes about it.')
  expect(html).toContain('Other notes in this folder')
  expect(render([], null)).toContain('Nothing here yet')
})

// 2026-09-26, the alpha.13 photograph: notes.create writes numbered points with a blank line between
// them, and the pane showed seven one-item lists, every point numbered "1.".
const noteBody = (body: string): string => renderToStaticMarkup(
  <AgentNotesView notes={[prose({ path: 'essays/agent-notes/metaphor.review.md', sourceDocument: 'essays/metaphor.md', body })]} activePath="essays/metaphor.md" dir="essays" actions={actions} />,
)
const lists = (html: string): string[] => [...html.matchAll(/<(ol|ul)[^>]*>/g)].map((match) => match[0])
const items = (html: string): string[] => [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) => match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' '))

test('a loose numbered list — a blank line between the items — renders as ONE list numbered 1 to 7', () => {
  const points = Array.from({ length: 7 }, (_, index) => `${index + 1}. **Point ${index + 1}.** Its reasoning, over\n   a continuation line.`)
  const html = noteBody(`The review opens with a paragraph.\n\n${points.join('\n\n')}\n\nA closing paragraph.\n`)
  expect(lists(html)).toEqual(['<ol>'])
  expect(items(html)).toEqual(Array.from({ length: 7 }, (_, index) => `Point ${index + 1}. Its reasoning, over a continuation line.`))
  expect(html).toContain('<strong>Point 1.</strong>')
  expect(html).toContain('<p>A closing paragraph.</p>')
})

test('a tight numbered list still renders as one list, and a start number other than 1 is kept', () => {
  const tight = noteBody('1. one\n2. two\n3. three\n')
  expect(lists(tight)).toEqual(['<ol>'])
  expect(items(tight)).toEqual(['one', 'two', 'three'])
  const resumed = noteBody('4. four\n\n5. five\n\n6. six\n')
  expect(lists(resumed)).toEqual(['<ol start="4">'])
  expect(items(resumed)).toEqual(['four', 'five', 'six'])
})

test('a note body never injects markup: raw HTML reads as text and an unsafe link is only its label', () => {
  const html = noteBody('Before <img src=x onerror="alert(1)"> after.\n\n[run me](javascript:alert(1)) and [site](https://example.com)\n')
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  expect(html).not.toContain('javascript:')
  expect(html).toContain('run me')
  expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer noopener">site</a>')
})

// Checkbox-lists ticket 04 (hifi-direction-1 frame 10): an agent review to tick off.
const reviewBody = [
  'The argument holds, but the opening is quick.',
  '',
  '1. [x] **The opening claim is too quick.** "Everybody knows…" invites disagreement.',
  '',
  '2. [ ] **No example of a schema.** The restaurant script would do it.',
  '',
].join('\n')
const boxed = prose({ path: 'essays/agent-notes/metaphor.review.md', sourceDocument: 'essays/metaphor.md', body: reviewBody, bodyLine: 9, bodyOffset: 140 })
const tickable = { ...actions, onToggleTask: () => {}, onResolveProposal: () => {} }
const renderBoxed = (note: AgentNote, over: Partial<Parameters<typeof AgentNotesView>[0]> = {}): string => renderToStaticMarkup(
  <AgentNotesView notes={[note]} activePath="essays/metaphor.md" dir="essays" actions={tickable} {...over} />,
)
const boxes = (html: string): string[] => [...html.matchAll(/<input[^>]*>/g)].map((match) => match[0])

test('a review with boxes shows a tickable box per point and counts what is dealt with in its heading', () => {
  const html = renderBoxed(boxed)
  expect(html).toContain('<span class="an-progress">1 of 2 dealt with</span>')
  const inputs = boxes(html)
  expect(inputs).toHaveLength(2)
  expect(inputs.every((input) => input.includes('type="checkbox"') && !input.includes('disabled'))).toBe(true)
  expect(inputs[0]).toContain('checked=""')
  expect(inputs[1]).not.toContain('checked')
  expect(inputs[1]).toContain('aria-label="Tick: **No example of a schema.** The restaurant script would do it."')
  // Each box names its line in the body it was drawn from; the heading reads the same boxes.
  expect([...html.matchAll(/data-task-line="(\d+)"/g)].map((match) => Number(match[1]))).toEqual([3, 5])
  expect(html).toContain('<strong>No example of a schema.</strong>')
})

test('the heading count follows the note file: a tick re-lists the body and the count moves', () => {
  const ticked = prose({ ...boxed, body: reviewBody.replace('2. [ ]', '2. [x]') } as AgentProseNote & { path: string; sourceDocument: string })
  expect(renderBoxed(ticked)).toContain('2 of 2 dealt with')
  expect(reviewProgress(reviewBody)).toBe('1 of 2 dealt with')
  // A note without boxes renders as it did, with no count.
  expect(reviewProgress('1. one\n\n2. two\n')).toBeNull()
  const plain = noteBody('1. one\n\n2. two\n')
  expect(plain).not.toContain('an-progress')
  expect(plain).not.toContain('<input')
  expect(items(plain)).toEqual(['one', 'two'])
})

test('a tick targets the NOTE file at the file line, never the piece', () => {
  const [, second] = readTaskLines(reviewBody)
  expect(noteTaskTarget(boxed as AgentProseNote, second)).toEqual({ path: 'essays/agent-notes/metaphor.review.md', line: 13, checked: false })
})

test('without a tick handler the boxes are drawn but cannot be ticked', () => {
  const html = renderToStaticMarkup(<AgentNotesView notes={[boxed]} activePath="essays/metaphor.md" dir="essays" actions={actions} />)
  expect(boxes(html).every((input) => input.includes('disabled'))).toBe(true)
})

test("the agent's proposed tick shows on its box with Accept and Discard", () => {
  const [, second] = readTaskLines(reviewBody)
  const from = 140 + second.from
  const change = (over: Partial<Change>): Change => ({
    id: 'c1', ts: 1, path: 'essays/agent-notes/metaphor.review.md', provenance: 'agent', editClass: 'content', category: 'other', summary: 'Tick',
    oldText: '[ ]', newText: '[x]', anchor: { from, to: from + 3 }, isCorrection: false, status: 'pending', ...over,
  } as Change)
  const paths = new Set(['essays/agent-notes/metaphor.review.md'])
  const proposals = taskProposalsFrom([
    change({}),
    change({ id: 'prose', oldText: 'quick', newText: 'hasty' }),
    change({ id: 'done', status: 'accepted' }),
    change({ id: 'piece', path: 'essays/metaphor.md' }),
  ], paths)
  expect(proposals).toEqual([{ changeId: 'c1', path: 'essays/agent-notes/metaphor.review.md', from, tick: true }])
  expect(proposalOnTask(boxed as AgentProseNote, second, proposals)?.changeId).toBe('c1')
  const html = renderBoxed(boxed, { proposals })
  expect(html).toContain('data-change-id="c1"')
  expect(html).toContain('Agent proposes ticking')
  expect(html).toContain('aria-label="Accept: tick this box"')
  expect(html).toContain('aria-label="Discard the proposal"')
  // The chip sits on the second point only.
  expect(html.indexOf('data-change-id')).toBeGreaterThan(html.indexOf('No example of a schema.'))
})

test('the Review skill writes its numbered points as open boxes', () => {
  const skill = readFileSync(new URL('../../resources/skills/review/SKILL.md', import.meta.url), 'utf8')
  expect(skill).toContain('`1. [ ] `')
})
