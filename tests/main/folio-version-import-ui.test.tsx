/**
 * Ticket 14 of Folio versions: Import steps 1 and 2 as drawn (render seam). The keys, the focus, the system dialog and the real Word file are the
 * Electron end-to-end test's. Here: step 1 is a workspace view (not a modal) that takes no typed path, the match table names every state, a close
 * match and an ambiguous section each ask the writer, and "Bring changes into the Folio" is off while any decision is open.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FolioVersionImport, MatchStep } from '../../src/renderer/src/components/FolioVersionImport'
import { CONFIDENCE_WORDS, type ImportPrepared } from '../../src/shared/folio-version-import'

const noop = (): void => undefined
const base = { status: 'ready', from: 'Sam Rowe', bases: [], baseId: 'fv_a', baseReason: 'sent', baseNote: null, changedSince: 2, safetyName: 'Before importing Sam Rowe’s revision' } as const

const prepared = (over: Partial<ImportPrepared> = {}): ImportPrepared => ({
  status: 'ready',
  file: { name: 'SR comments.docx', sha256: 'a'.repeat(64), bytes: 2048, reviewers: ['Sam Rowe'], changes: 61, sections: 6, tables: 0, figures: 0, limitations: [] },
  bases: { ...base },
  mechanism: 'judgement-stub',
  noHeadingStyles: false,
  items: [
    { status: 'exact', section: { index: 0, heading: 'Pilot overview' }, part: { path: 'f/1.md', title: 'Pilot overview' }, moved: false },
    { status: 'proposed', section: { index: 1, heading: 'Who preferred which approach?' }, part: { path: 'f/2.md', title: 'Who preferred what?' }, confidence: 'likely', reason: 'The heading shares most of its words with “Who preferred what?”.', source: 'judgement-stub', moved: false },
    { status: 'ambiguous', reason: 'heading-appears-twice', message: 'The heading “Costs” appears 2 times in the Word file. Say which section is which.', sections: [{ index: 2, heading: 'Costs' }, { index: 3, heading: 'Costs' }], candidates: [{ path: 'f/3.md', title: 'Costs' }] },
    { status: 'exact', section: { index: 4, heading: 'Wrap-up' }, part: { path: 'f/4.md', title: 'Wrap-up' }, moved: true },
    { status: 'new', section: { index: 5, heading: 'Limitations' } },
  ],
  missing: [{ path: 'f/5.md', title: 'Inspect the passages' }],
  parts: [1, 2, 3, 4, 5].map((n) => ({ path: `f/${n}.md`, title: `Part ${n}`, role: 'part' as const })),
  needs: 3,
  unusedResolutions: [],
  confidenceWords: CONFIDENCE_WORDS,
  ...over,
})

const step2 = (data: ImportPrepared, extra: { decisions?: Array<{ section: number; part: string | null }>; busy?: 'writing' | null } = {}): string =>
  renderToStaticMarkup(<MatchStep prepared={data} decisions={extra.decisions ?? []} busy={extra.busy ?? null} onDecide={noop} onBack={noop} onCancel={noop} onBring={noop} />)

describe('step 1', () => {
  const html = renderToStaticMarkup(<FolioVersionImport dir="f" onClose={noop} onDone={noop} onSaveVersion={noop} />)

  test('is a workspace view with a three-step stepper, not a modal', () => {
    expect(html).toContain('data-testid="folio-import"')
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain('aria-modal')
    expect(html).toContain('1 Choose the file')
    expect(html).toContain('2 Match sections')
    expect(html).toContain('3 Decide')
    expect(html).toMatch(/aria-current="step"[^>]*>1 Choose the file/)
  })

  test('the file is chosen by the system dialog: the only text field is the name she is from, and there is no path to type', () => {
    expect([...html.matchAll(/<input [^>]*>/g)]).toHaveLength(1)
    expect(html).toContain('data-testid="import-from"')
    expect(html).toContain('None chosen yet')
    expect(html).toContain('Choose a file…')
  })

  test('Match sections is off until there is a file and a name, and Cancel is there', () => {
    expect(html).toMatch(/data-testid="import-match"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*data-testid="import-match"/)
    expect(html).toContain('data-testid="import-cancel"')
    expect(html).toContain('It is saved first as a version, so nothing can be lost.')
  })
})

describe('step 2: the match table', () => {
  const html = step2(prepared())

  test('names every state: exact, close, ambiguous, new, moved and not in the Word file', () => {
    for (const status of ['exact', 'close', 'ambiguous', 'new', 'missing']) expect(html).toContain(`data-status="${status}"`)
    expect(html).toContain('exact heading')
    expect(html).toContain('close · likely')
    expect(html).toContain('needs you')
    expect(html).toContain('new section')
    expect(html).toContain('not in the Word file')
    expect(html).toContain('data-chip="moved"')
  })

  test('a close match shows its reason and asks: same part, or something else', () => {
    expect(html).toContain('The heading shares most of its words with “Who preferred what?”.')
    expect(html).toContain('data-testid="import-same"')
    expect(html).toContain('data-testid="import-different"')
    expect(html).toContain('None: a new section')
  })

  test('each ambiguous section has its own part to choose, with no part and a new section as an answer', () => {
    expect([...html.matchAll(/data-testid="import-place"/g)]).toHaveLength(2)
    expect(html).toContain('Choose a part…')
    expect(html).toContain('No part: a new section')
    expect(html).toContain('Say which section is which.')
  })

  test('it is a real table with column headers, and says nothing is applied yet', () => {
    expect(html).toMatch(/<table[^>]*data-testid="import-table"/)
    expect([...html.matchAll(/<th scope="col"/g)]).toHaveLength(4)
    expect(step2(prepared({ needs: 0 }))).toContain('Nothing is applied yet.')
  })

  test('Bring changes into the Folio is off, with its reason, while a decision is open; on when none is; off while writing', () => {
    expect(html).toMatch(/data-testid="import-bring"[^>]*aria-disabled="true"/)
    expect(html).toContain('3 matches still need your decision.')
    expect(step2(prepared({ needs: 0 }))).not.toMatch(/data-testid="import-bring"[^>]*aria-disabled/)
    expect(step2(prepared({ needs: 0 }), { busy: 'writing' })).toMatch(/data-testid="import-bring"[^>]*aria-disabled="true"/)
  })

  test('says who judged the close matches: a guess from words, not a reading', () => {
    expect(html).toContain('data-testid="import-mechanism"')
    expect(html).toContain('not a reading of what the sections mean')
  })

  test('a section the writer decided names the choice, and a decision that could not stand says why', () => {
    const decided = prepared({
      needs: 0,
      items: [
        { status: 'confirmed', section: { index: 0, heading: 'Who preferred which approach?' }, part: { path: 'f/2.md', title: 'Part 2' }, source: 'writer', moved: false },
        { status: 'new', section: { index: 1, heading: 'Zed' } },
      ],
      unusedResolutions: [{ section: 1, why: 'That part is already matched to another section.' }],
    })
    const out = step2(decided, { decisions: [{ section: 0, part: 'f/2.md' }, { section: 1, part: null }] })
    expect(out).toContain('your choice')
    expect(out).toContain('You chose this part.')
    expect(out).toContain('You said it is none of the parts.')
  })

  test('hostile text from her file is text: a heading with markup is escaped', () => {
    const out = step2(prepared({ items: [{ status: 'new', section: { index: 0, heading: '<img src=x onerror=alert(1)>' } }], missing: [], needs: 0 }))
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})
