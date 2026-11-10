/**
 * Ticket 15 of Folio versions: the banner and the timeline's second line, as drawn (render seam: the revision's status already read).
 * The margin, the real window and the ledger are the Electron end-to-end test's.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RevisionBanner } from '../../src/renderer/src/components/FolioRoomVersions'
import { decidedLine, revisionSummary, type RevisionStatus } from '../../src/shared/folio-version-stage'

const status = (over: Partial<RevisionStatus> = {}): RevisionStatus => ({
  id: 'fv_abc', name: 'Sam Rowe’s revision', ts: Date.UTC(2026, 9, 22, 14, 7), from: 'Sam Rowe', by: 'Claude Code', file: 'paper.docx', withdrawn: false,
  staged: 22, decided: 0, waitingParts: [{ path: 'f/one.md', waiting: 12 }, { path: 'f/two.md', waiting: 10 }], newSections: 1, needsYou: 1, ...over,
})

describe('the banner for a revision with suggestions waiting', () => {
  test('says who brought it in, what waits, that one match needs the writer, and that nothing is applied', () => {
    const html = renderToStaticMarkup(<RevisionBanner revision={status()} onReview={() => undefined} />)
    expect(html).toContain('<b>Claude Code</b> brought in Sam Rowe’s revision at')
    expect(html).toContain('22 suggestions in 2 parts, 1 new section; 1 match needs you.')
    expect(html).toContain('Your text is untouched until you accept changes.')
    expect(html).toContain('Review the revision')
    expect(html).toContain('data-by="Claude Code"')
  })

  test('a revision the writer brought in says "You"; with no part waiting and no host there is no button', () => {
    const html = renderToStaticMarkup(<RevisionBanner revision={status({ by: null, needsYou: 0, newSections: 0, staged: 1, waitingParts: [{ path: 'f/one.md', waiting: 1 }] })} />)
    expect(html).toContain('<b>You</b> brought in Sam Rowe’s revision')
    expect(html).toContain('1 suggestion in 1 part.')
    expect(html).not.toContain('Review the revision')
  })

  test('the timeline line counts decisions and matches to confirm in words', () => {
    expect(decidedLine(status())).toBe('0 of 22 decided · 1 match to confirm')
    expect(decidedLine(status({ decided: 3, needsYou: 0 }))).toBe('3 of 22 decided')
    expect(revisionSummary(status({ staged: 0, waitingParts: [], newSections: 0, needsYou: 2 }))).toBe('0 suggestions in 0 parts; 2 matches need you.')
  })
})
