/**
 * Ticket 17 of Folio versions: the three-text view as drawn (render seam: the read already made). The real window, the writes, the margin and the keyboard
 * are the Electron end-to-end test's (folio-version-three-text.spec.ts).
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreeTextView } from '../../src/renderer/src/components/FolioVersionThreeText'
import { DecideView } from '../../src/renderer/src/components/FolioVersionDecide'
import type { DecideList } from '../../src/shared/folio-version-decide'
import { choiceLabels, whyLine, type ThreeText, type ThreeTextRow } from '../../src/shared/folio-version-text'

const row = (over: Partial<ThreeTextRow>): ThreeTextRow => ({ key: 'text:0:0123456789abcdef:0', kind: 'both-different', herChange: 'replace', yourChange: 'replace', sent: ['Sent words.'], hers: ['Their words.'], yours: ['My words.'], state: 'open', ...over })
const same = (n: number): ThreeTextRow => row({ key: '', kind: 'same', herChange: 'none', yourChange: 'none', sent: Array(n).fill('Same.'), hers: Array(n).fill('Same.'), yours: Array(n).fill('Same.'), state: 'self' })
const view = (rows: ThreeTextRow[], settledOver?: number): ThreeText => {
  const changed = rows.filter((entry) => entry.kind !== 'same')
  return {
    revision: { id: 'fv_a', name: 'Sam Rowe’s revision', from: 'Sam Rowe' }, part: { path: 'f/one.md', title: 'Pilot overview', position: 1 }, section: { index: 0, heading: 'Pilot overview' }, rows,
    seen: { sent: 'a'.repeat(64), hers: 'b'.repeat(64), yours: 'c'.repeat(64) }, counts: { changed: changed.length, settled: settledOver ?? changed.filter((entry) => entry.state === 'self' || entry.state === 'accepted' || entry.state === 'kept' || entry.state === 'declined').length },
  }
}
const draw = (text: ThreeText, extra: Partial<Parameters<typeof ThreeTextView>[0]> = {}): string => renderToStaticMarkup(<ThreeTextView text={text} busy={null} said={null} onBack={() => undefined} onDecide={() => undefined} {...extra} />)
const textOf = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

const four: ThreeTextRow[] = [
  row({ key: 'text:0:1111111111111111:0', kind: 'only-mine', herChange: 'none', yourChange: 'replace', state: 'self', hers: ['Sent words.'] }),
  same(2),
  row({ key: 'text:0:2222222222222222:0' }),
  row({ key: 'text:0:3333333333333333:0', kind: 'only-hers', herChange: 'delete', yourChange: 'none', hers: [], yours: ['Sent words.'], state: 'waiting', changeId: 'c1' }),
  row({ key: 'text:0:4444444444444444:0', kind: 'only-hers', herChange: 'insert', yourChange: 'none', sent: [], hers: ['A new paragraph.'], yours: [], state: 'waiting', changeId: 'c2' }),
]

describe('the three texts', () => {
  test('three columns named for what each text is, the part, a chip that both changed it, and how many rows are decided', () => {
    const html = draw(view(four))
    expect(textOf(html)).toContain('Sent')
    expect(textOf(html)).toContain('Sam Rowe')
    expect(textOf(html)).toContain('Yours now')
    expect(textOf(html)).toContain('Pilot overview')
    expect(textOf(html)).toContain('both of you changed this part')
    expect(textOf(html)).toContain('1 of 4 decided')
    expect(html).toContain('data-testid="folio-three-text"')
  })

  test('one row per stretch with the three texts side by side; an unchanged stretch is one folded line, not drawn until opened', () => {
    const html = draw(view(four))
    expect(html.match(/data-testid="three-row"/g)).toHaveLength(4)
    expect(html.match(/data-testid="three-same"/g)).toHaveLength(1)
    expect(textOf(html)).toContain('2 paragraphs unchanged')
    expect(html).toContain('aria-expanded="false"')
    expect(html.match(/Same\./g)).toBeNull()
    for (const text of ['Sent words.', 'Their words.', 'My words.']) expect(html).toContain(text)
  })

  test('only the writer\'s own row decides itself: it says so and offers no choice', () => {
    const html = draw(view([four[0]!]))
    expect(textOf(html)).toContain('Only you changed this paragraph. Kept as yours.')
    expect(html).not.toContain('data-testid="three-theirs"')
    expect(html).not.toContain('data-testid="three-mine"')
    expect(html).not.toContain('data-testid="three-hand"')
    expect(html).toContain('data-chip="self"')
  })

  test('a row both changed offers Use theirs, Keep mine and Edit by hand in Text, in that order', () => {
    const html = draw(view([four[2]!]))
    const at = (testId: string): number => html.indexOf(`data-testid="${testId}"`)
    expect(at('three-theirs')).toBeGreaterThan(0)
    expect(at('three-theirs')).toBeLessThan(at('three-mine'))
    expect(at('three-mine')).toBeLessThan(at('three-hand'))
    expect(textOf(html)).toContain('Use theirs')
    expect(textOf(html)).toContain('Keep mine')
    expect(textOf(html)).toContain('Edit by hand in Text')
    expect(textOf(html)).toContain('You both changed it, in different ways.')
  })

  test('her deletion and her insertion say what she did and take their own words, still with Edit by hand', () => {
    const html = draw(view([four[3]!, four[4]!]))
    expect(textOf(html)).toContain('Sam Rowe deleted this paragraph.')
    expect(textOf(html)).toContain('Accept their deletion')
    expect(textOf(html)).toContain('Keep my paragraph')
    expect(textOf(html)).toContain('Sam Rowe added a paragraph here.')
    expect(html).toContain('>Accept</button>')
    expect(html).toContain('>Reject</button>')
    expect(html.match(/data-testid="three-hand"/g)).toHaveLength(2)
    expect(choiceLabels(four[3]!)).toEqual({ theirs: 'Accept their deletion', mine: 'Keep my paragraph' })
  })

  test('a settled row has no buttons and says how it was settled', () => {
    for (const state of ['accepted', 'kept', 'declined'] as const) {
      const html = draw(view([row({ state })]))
      expect(html).not.toContain('data-testid="three-theirs"')
      expect(html).toContain(`data-chip="${state}"`)
    }
  })

  test('the words never guess a pronoun for the co-author', () => {
    const everything = [...four, row({ kind: 'both-different', herChange: 'delete' }), row({ kind: 'both-different', yourChange: 'delete' }), row({ kind: 'both-different', herChange: 'insert', yourChange: 'insert' })]
    const html = draw(view(everything))
    expect(textOf(html).replace(/ title="[^"]*"/g, '')).not.toMatch(/\b(her|hers|she)\b/i)
    for (const entry of everything) expect(whyLine(entry, 'Sam Rowe')).not.toMatch(/\b(her|hers|she)\b/i)
  })

  test('every row is a named group whose buttons are reachable in order, and the row under focus is announced', () => {
    const html = draw(view(four))
    expect(html).toContain('aria-label="Row 3 of 4: Sam Rowe deleted this paragraph."')
    expect(html).toContain('role="list"')
    expect(html).toContain('aria-live="polite"')
    // No button is taken out of the tab order or hidden from the keyboard.
    expect(html.match(/<button[^>]*tabindex="-1"/g)).toBeNull()
  })

  test('without a host the Edit by hand button is disabled, never missing', () => {
    expect(draw(view([four[2]!]), { canOpen: false })).toContain('aria-disabled="true"')
  })

  test('a view with nothing differing says so', () => {
    expect(textOf(draw(view([same(3)])))).toContain('Nothing in this part differs between the three texts.')
  })

  test('1,200 words and 60 changed rows draw in a blink: the unchanged stretches stay folded and rows are content-visibility rows', () => {
    const rows: ThreeTextRow[] = []
    for (let i = 0; i < 60; i += 1) { rows.push(same(1)); rows.push(row({ key: `text:0:${String(i).padStart(16, '0')}:0`, sent: [`Sent paragraph ${i} ${'word '.repeat(9)}`], hers: [`Their paragraph ${i} ${'word '.repeat(9)}`], yours: [`My paragraph ${i} ${'word '.repeat(9)}`] })) }
    const started = performance.now()
    const html = draw(view(rows))
    expect(performance.now() - started).toBeLessThan(300)
    expect(html.match(/data-testid="three-row"/g)).toHaveLength(60)
  })
})

describe('the decide step offers the three texts', () => {
  const base: DecideList = {
    revision: { id: 'fv_a', name: 'Sam Rowe’s revision', from: 'Sam Rowe', by: null, ts: 0, file: 'paper.docx', withdrawn: false },
    parts: [], texts: [{ path: 'f/one.md', title: 'Pilot overview', position: 1, section: 0, heading: 'Pilot overview', both: true, total: 6, settled: 2 }],
    rows: [], matches: [], placeable: [], order: ['f/one.md'], progress: { decided: 2, total: 6 }, complete: false, offer: null,
  }
  const drawList = (list: DecideList, extra: object = {}): string => renderToStaticMarkup(<DecideView list={list} busy={null} said={null} onClose={() => undefined} onDecide={() => undefined} {...extra} />)

  test('a part both of you changed is listed with how many of its rows are decided and a button to read its three texts', () => {
    const html = drawList(base, { onOpenTexts: () => undefined })
    expect(html).toContain('data-testid="decide-text-part"')
    expect(textOf(html)).toContain('both of you changed this part')
    expect(textOf(html)).toContain('2 of 6 decided')
    expect(textOf(html)).toContain('Read the three texts')
  })

  test('without a host the part is listed without the button; with no such part the section is not drawn', () => {
    expect(textOf(drawList(base))).not.toContain('Read the three texts')
    expect(drawList({ ...base, texts: [] })).not.toContain('decide-texts')
  })
})
