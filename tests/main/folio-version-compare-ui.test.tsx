/**
 * Ticket 08 of Folio versions: the comparison as drawn (render seam: the comparison already read). The keys, the real window and the
 * disk are the Electron end-to-end test's. Here: every line says what happened to it in words, only a line with text to show can be opened,
 * nothing can be typed into, and nothing offers to take text out of either side unless the window gives it a take (ticket 09, below).
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompareBody, Rows, canTake } from '../../src/renderer/src/components/FolioVersionCompare'
import { ReaderBanner } from '../../src/renderer/src/components/FolioVersionReader'
import type { FolioCompareEntry, FolioCompareResult } from '../../src/shared/folio-version-compare'

const entry = (over: Partial<FolioCompareEntry> & Pick<FolioCompareEntry, 'key' | 'kind' | 'title' | 'state'>): FolioCompareEntry => ({ path: `f/${over.title}.md`, added: 0, removed: 0, text: true, ...over })
const RESULT: FolioCompareResult = {
  dir: 'f',
  from: { id: 'fv_a', name: 'Draft for Sam Rowe', ts: Date.UTC(2026, 9, 15, 11, 5), author: 'Dominik Lukes', working: false },
  to: { id: 'working', name: 'Working draft', ts: null, author: null, working: true },
  same: false,
  index: entry({ key: 'index', kind: 'index', title: 'Index Note', state: 'unchanged' }),
  parts: [
    entry({ key: 'part:f/one.md', kind: 'part', title: 'Pilot overview', state: 'unchanged', fromPosition: 1, toPosition: 1 }),
    entry({ key: 'part:f/two.md', kind: 'part', title: 'How are pairwise scores calculated?', state: 'changed', added: 41, removed: 18, fromPosition: 2, toPosition: 2 }),
    entry({ key: 'part:f/three.md', kind: 'part', title: 'Who preferred what?', state: 'moved', fromPosition: 3, toPosition: 5 }),
    entry({ key: 'part:f/lim.md', kind: 'part', title: 'Limitations', state: 'only-to', toPosition: 6 }),
    entry({ key: 'part:f/gone.md', kind: 'part', title: 'Costs', state: 'only-from', fromPosition: 7, text: true }),
  ],
  unlisted: [entry({ key: 'unlisted:f/notes.md', kind: 'unlisted', title: 'notes-on-judges', path: 'f/notes-on-judges.md', state: 'unchanged' })],
  inserted: [
    entry({ key: 'inserted:f/data/scores.csv', kind: 'inserted', title: 'scores.csv', path: 'f/data/scores.csv', state: 'changed', text: false, fromFile: { name: 'Folio version: A', ts: 1, ordinal: 1 }, toFile: { name: 'Folio version: B', ts: 2, ordinal: 2 } }),
    entry({ key: 'inserted:f/assets/fig.png', kind: 'inserted', title: 'fig.png', path: 'f/assets/fig.png', state: 'unchanged', text: false }),
  ],
  summary: { unchanged: 4, changed: 2, onlyFrom: 1, onlyTo: 1, moved: 1 },
}
const CANNOT_WRITE = /<input|<textarea|contenteditable|draggable|cm-editor|<form/

describe('the comparison', () => {
  const html = renderToStaticMarkup(<CompareBody dir="f" result={RESULT} />)

  test('says which two are compared and how many lines changed, in words', () => {
    expect(html).toContain('Comparing “Draft for Sam Rowe” with the working draft.')
    expect(html).toContain('2 changed, 2 in only one, 1 moved, 4 unchanged.')
    expect(html).toContain('data-nothing-changed="false"')
  })

  test('each line says what happened to it; a table says v1 → v2', () => {
    expect(html).toContain('>unchanged<')
    expect(html).toContain('>changed +41 −18<')
    expect(html).toContain('>moved 3 → 5<')
    expect(html).toContain('>only in working draft<')
    expect(html).toContain('>only in “Draft for Sam Rowe”<')
    expect(html).toContain('>v1 → v2<')
  })

  test('the Index Note, Not in the outline and Inserted files are in the same list', () => {
    expect(html).toContain('Index Note')
    expect(html).toContain('Not in the outline')
    expect(html).toContain('notes-on-judges')
    expect(html).toContain('Inserted files')
    expect(html).toContain('f/data/scores.csv')
  })

  test('only a line with text to show can be opened; the rest are plain lines the keyboard can still reach', () => {
    const buttons = [...html.matchAll(/<button[^>]*data-testid="compare-open"[^>]*>/g)].map((match) => match[0])
    // Changed part, part only in one side (two of them): three. Not the unchanged, the moved, the table or the picture.
    expect(buttons).toHaveLength(3)
    for (const button of buttons) expect(button).toContain('aria-expanded="false"')
    expect((html.match(/fvc-plain/g) ?? []).length).toBe(6)
    expect((html.match(/data-compare-line/g) ?? []).length).toBe(9)
  })

  test('nothing can be typed into, and nothing offers to take text out of either side', () => {
    expect(html).not.toMatch(CANNOT_WRITE)
    expect(html).not.toMatch(/Take that|Keep current|Compare cells|Restore the whole/)
  })
})

describe('a comparison with nothing different', () => {
  test('says so in a sentence', () => {
    const same: FolioCompareResult = { ...RESULT, same: true, parts: RESULT.parts.map((part) => ({ ...part, state: 'unchanged' as const, added: 0, removed: 0 })), inserted: [], summary: { unchanged: 8, changed: 0, onlyFrom: 0, onlyTo: 0, moved: 0 } }
    const html = renderToStaticMarkup(<CompareBody dir="f" result={same} />)
    expect(html).toContain('Nothing changed between these two.')
    expect(html).toContain('data-nothing-changed="true"')
  })
})

describe('an opened part', () => {
  test('draws unchanged stretches as a count and each change as two sides with the words marked', () => {
    const html = renderToStaticMarkup(<Rows shown={10} rows={[
      { kind: 'same', paragraphs: 3 },
      { kind: 'changed', added: 1, removed: 1, from: [{ kind: 'equal', text: 'Score is shared ' }, { kind: 'removed', text: 'after' }], to: [{ kind: 'equal', text: 'Score is shared ' }, { kind: 'added', text: 'with ties' }] },
    ]} />)
    expect(html).toContain('3 unchanged paragraphs')
    expect(html).toContain('<del>after</del>')
    expect(html).toContain('<ins>with ties</ins>')
  })

  test('draws only as many rows as asked for, so a very long part is drawn in steps', () => {
    const rows = Array.from({ length: 60 }, (_, at) => ({ kind: 'changed' as const, added: 1, removed: 1, from: [{ kind: 'removed' as const, text: `old${at}` }], to: [{ kind: 'added' as const, text: `new${at}` }] }))
    const html = renderToStaticMarkup(<Rows shown={25} rows={rows} />)
    expect((html.match(/data-testid="compare-changed"/g) ?? []).length).toBe(25)
  })
})

describe('the banner of a version being read', () => {
  const version = { id: 'fv_a', name: 'Draft for Sam Rowe', ts: Date.UTC(2026, 9, 15, 11, 5), author: 'Dominik Lukes' }
  test('Compare with working is on when the room can take the writer to the comparison, and still off without it', () => {
    const on = renderToStaticMarkup(<ReaderBanner version={version} onBack={() => {}} onCompare={() => {}} />)
    expect(on).toMatch(/data-reader-action="compare"(?![^>]*aria-disabled)/)
    expect(on).toMatch(/data-reader-action="restore"[^>]*aria-disabled="true"/)
    const off = renderToStaticMarkup(<ReaderBanner version={version} onBack={() => {}} />)
    expect(off).toMatch(/data-reader-action="compare"[^>]*aria-disabled="true"/)
  })
})

describe('Take that text / Keep current (ticket 09)', () => {
  const host = { isUnsaved: () => false, openPart: () => undefined }
  const SHA = 'a'.repeat(64)
  const taking: FolioCompareResult = { ...RESULT, parts: RESULT.parts.map((part) => (part.state === 'changed' ? { ...part, workingSha256: SHA } : part)) }
  const buttonsIn = (html: string, id: string): number => (html.match(new RegExp(`data-testid="${id}"`, 'g')) ?? []).length

  test('a part that changed between a saved version and the working draft has both buttons, and nothing else has', () => {
    const html = renderToStaticMarkup(<CompareBody dir="f" result={taking} take={host} />)
    expect(buttonsIn(html, 'take-take')).toBe(1)
    expect(buttonsIn(html, 'take-keep')).toBe(1)
    expect(html).toContain('>Take that text<')
    expect(html).toContain('>Keep current<')
    // The changed table is changed too, but it is not a part.
    expect(canTake(taking, taking.inserted[0]!)).toBe(false)
    expect(canTake(taking, taking.parts[2]!)).toBe(false)
    expect(canTake(taking, taking.parts[3]!)).toBe(false)
    expect(canTake(taking, taking.parts[4]!)).toBe(false)
  })

  test('without the window\'s take, or between two saved versions, or without the fingerprint, no button is drawn', () => {
    expect(renderToStaticMarkup(<CompareBody dir="f" result={taking} />)).not.toMatch(/Take that|Keep current/)
    const twoVersions: FolioCompareResult = { ...taking, to: { id: 'fv_b', name: 'After pilot numbers', ts: 5, author: 'Dominik Lukes', working: false } }
    expect(renderToStaticMarkup(<CompareBody dir="f" result={twoVersions} take={host} />)).not.toMatch(/Take that|Keep current/)
    expect(renderToStaticMarkup(<CompareBody dir="f" result={RESULT} take={host} />)).not.toMatch(/Take that|Keep current/)
    expect(canTake({ from: taking.to, to: taking.from }, taking.parts[1]!)).toBe(true)
  })

  test('the buttons are plain buttons the keyboard reaches in order, outside the line\'s own button, and nothing can be typed into', () => {
    const html = renderToStaticMarkup(<CompareBody dir="f" result={taking} take={host} />)
    expect(html).not.toMatch(CANNOT_WRITE)
    expect(html).toMatch(/<button type="button" class="fv-btn" data-testid="take-keep">/)
    // Not nested inside the line's own (opening) button.
    const line = html.match(/<button[^>]*data-testid="compare-open"[\s\S]*?<\/button>/)![0]
    expect(line).not.toContain('take-take')
  })
})
