/**
 * Ticket 16 of Folio versions: the decide step as drawn (render seam: the list already read). The real window, the margin, the ledger and
 * the writes are the Electron end-to-end test's (folio-version-decide.spec.ts).
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DecideView } from '../../src/renderer/src/components/FolioVersionDecide'
import { STRUCTURE_CHOICES, finishedVersionName, type DecideList, type DecidePart, type StructureRow } from '../../src/shared/folio-version-decide'

const part = (over: Partial<DecidePart> = {}): DecidePart => ({
  path: 'f/one.md', title: 'Pilot overview', position: 1,
  suggestions: [{ id: 'c1', kind: 'replace', oldText: 'Old words.', newText: 'New words.', outcome: 'waiting' }, { id: 'c2', kind: 'insert', oldText: '', newText: 'An added paragraph.', outcome: 'accepted' }],
  ...over,
})
const rows: StructureRow[] = [
  { key: 'new:3', kind: 'new', section: 3, heading: 'Further work', after: 'Costs' },
  { key: 'moved:2', kind: 'moved', section: 2, heading: 'Who preferred what?', part: 'f/two.md', title: 'Who preferred what?', after: 'Costs' },
  { key: 'removed:f/five.md', kind: 'removed', part: 'f/five.md', title: 'What did we learn?' },
]
const list = (over: Partial<DecideList> = {}): DecideList => ({
  revision: { id: 'fv_a', name: 'Sam Rowe’s revision', from: 'Sam Rowe', by: null, ts: 0, file: 'paper.docx', withdrawn: false },
  parts: [part()], texts: [], rows, matches: [], placeable: [], order: ['f/one.md'], progress: { decided: 1, total: 5 }, complete: false, offer: null, ...over,
})
const draw = (over: Partial<DecideList> = {}, extra: Partial<Parameters<typeof DecideView>[0]> = {}): string =>
  renderToStaticMarkup(<DecideView list={list(over)} busy={null} said={null} onClose={() => undefined} onDecide={() => undefined} openPart={() => undefined} onSaveVersion={() => undefined} {...extra} />)

describe('the decide step', () => {
  test('says whose revision it is, how many are decided, and that nothing is applied until a change is accepted', () => {
    const html = draw()
    expect(html).toContain('Deciding on Sam Rowe’s revision')
    expect(html).toContain('1 of 5 decided')
    expect(html).toContain('Your text is untouched until you accept a change.')
    expect(html).toContain('data-state="deciding"')
    expect(html).toContain('aria-current="step"')
  })

  test('one row per part with its suggestions and "Open in Text"; the margin decides them, so there is no accept or reject button here', () => {
    const html = draw()
    expect(html.match(/data-testid="decide-part"/g)).toHaveLength(1)
    expect(html).toContain('1 of 2 decided')
    expect(html).toContain('Changes “Old words.” to “New words.”')
    expect(html).toContain('Adds “An added paragraph.”')
    expect(html).toContain('Open in Text')
    expect(html).not.toMatch(/>Accept</)
    expect(html).not.toMatch(/>Reject</)
    expect(html).not.toMatch(/>Decline</)
  })

  test('without a host there is no "Open in Text"', () => {
    expect(draw({}, { openPart: undefined })).not.toContain('Open in Text')
  })

  test('each structure row names the thing and offers its two choices, the one that changes the Folio first', () => {
    const html = draw()
    for (const kind of ['new', 'moved', 'removed'] as const) for (const entry of STRUCTURE_CHOICES[kind]) expect(html).toContain(`>${entry.label}<`)
    expect(html).toContain('A new section, “Further work”, follows “Costs”.')
    expect(html).toContain('stands elsewhere in the Word file: after “Costs”.')
    expect(html).toContain('The Word file has nothing for “What did we learn?”.')
    expect(html).not.toContain('Everything is decided')
    // The words say "their", never a guess at a pronoun for a person.
    expect(html.replace(/<[^>]+>/g, ' ').replace(/ title="[^"]*"/g, '')).not.toMatch(/\b(her|hers|she)\b/i)
    expect(html.match(/title="([^"]*)"/g)!.join(' ')).not.toMatch(/\b(her|hers|she)\b/i)
  })

  test('a decided row says what was done and has no buttons; the offer appears only when everything is decided', () => {
    const decided = rows.map((row, at) => ({ ...row, choice: (['add', 'hers', 'take-out'] as const)[at]! }))
    const partial = draw({ rows: decided })
    expect(partial).toContain('Added “Further work” as a part.')
    expect(partial).toContain('Took “What did we learn?” out of the running order. Its file is under Not in the outline.')
    expect(partial).not.toContain('data-testid="decide-add"')
    expect(partial).not.toContain('data-testid="decide-offer"')
    const finished = draw({ rows: decided, complete: true, offer: finishedVersionName('Sam Rowe'), progress: { decided: 5, total: 5 }, parts: [part({ suggestions: [{ id: 'c1', kind: 'replace', oldText: 'a', newText: 'b', outcome: 'accepted' }] })] })
    expect(finished).toContain('data-testid="decide-offer"')
    expect(finished).toContain('Save “After Sam Rowe’s revision”…')
    expect(finished).toContain('data-state="complete"')
    // Without the save sheet's door the offer says so and draws no button.
    expect(draw({ rows: decided, complete: true, offer: 'After Sam Rowe’s revision' }, { onSaveVersion: undefined })).not.toContain('data-testid="decide-save"')
  })

  test('sections of the Word file that match no part are the writer\'s to place, and the step says what waits on them', () => {
    const html = draw({ matches: [{ key: 'match:4', section: 4, heading: 'Were disagreements small or large?' }], rows: [rows[0]!] })
    expect(html).toContain('data-testid="decide-unplaced"')
    expect(html).toContain('1 section of the Word file matches no part yet')
    expect(html).toContain('“Were disagreements small or large?”')
    expect(html).toContain('Only you can say which part a section is.')
    expect(html).toContain('Sections that moved and parts the Word file lacks are listed once it is placed.')
    // The writer chooses from the parts nothing else matches, or says it is a new section; with no door to place it the choice is not drawn.
    const placed = renderToStaticMarkup(<DecideView list={list({ matches: [{ key: 'match:4', section: 4, heading: 'Were disagreements small or large?' }], rows: [], placeable: [{ label: 'f/four.md', title: 'Were disagreements small?', role: 'part' }, { label: 'f/x.md', title: 'Loose note', role: 'unlisted' }] })} busy={null} said={null} onClose={() => undefined} onDecide={() => undefined} onPlace={() => undefined} />)
    expect(placed).toContain('Choose a part…')
    expect(placed).toContain('>Were disagreements small?<')
    expect(placed).toContain('Loose note (not in the outline)')
    expect(placed).toContain('None: a new section')
    expect(html).not.toContain('data-testid="decide-place"')
  })

  test('a withdrawn revision has nothing to decide; a revision with nothing in it says so', () => {
    expect(draw({ revision: { ...list().revision, withdrawn: true } })).toContain('This revision is withdrawn')
    const empty = draw({ parts: [], rows: [], progress: { decided: 0, total: 0 } })
    expect(empty).toContain('The Word file holds nothing to decide')
    expect(empty).not.toContain('data-testid="decide-offer"')
  })

  test('a part no longer in the running order is said to be, and a closed suggestion carries its reason', () => {
    const html = draw({ parts: [part({ position: null, suggestions: [{ id: 'c3', kind: 'delete', oldText: 'Gone.', newText: '', outcome: 'closed', why: 'That text is not in the part now.' }] })] })
    expect(html).toContain('not in the outline')
    expect(html).toContain('Removes “Gone.”')
    expect(html).toContain('That text is not in the part now.')
  })

  test('a decision under way switches the buttons off and a refusal is told in words', () => {
    const html = draw({}, { busy: 'new:3', said: { tone: 'bad', text: 'The running order has changed since you looked at it, so nothing was changed.' } })
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('data-tone="bad"')
    expect(html).toContain('The running order has changed since you looked at it')
    expect(html).toContain('aria-disabled="true"')
  })
})
