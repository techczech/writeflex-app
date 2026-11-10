/**
 * Ticket 11 of Folio versions: the export sheet and the Mark as sent sheet as drawn (render seam). The keys, the focus trap, the save dialog
 * and the real Word file are the Electron end-to-end test's. Here: each sheet is a modal that says what it makes the file from, the mark is
 * off until asked for, the banner's Export… is on only where a handler is wired, and every key typed in a sheet stops at the sheet.
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExportVersionSheet, MarkSentSheet, sentNames, type SheetVersion } from '../../src/renderer/src/components/FolioVersionExport'
import { ReaderBanner } from '../../src/renderer/src/components/FolioVersionReader'

const VERSION: SheetVersion = { id: 'fv_abc_0123', name: 'After pilot numbers', ts: Date.UTC(2026, 9, 19, 16, 40), author: 'Dominik Lukes' }
const SENT: SheetVersion = { id: 'fv_def_0456', name: 'Draft for Sam Rowe', ts: Date.UTC(2026, 9, 15, 11, 5), author: 'Dominik Lukes', sentTo: 'Sam Rowe' }

describe('the export sheet', () => {
  const html = renderToStaticMarkup(<ExportVersionSheet dir="f" version={VERSION} versions={[VERSION, SENT]} onClose={() => undefined} />)

  test('is a modal named for the version, and says the file is made from the saved version, not the working draft', () => {
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('Export “After pilot numbers”')
    expect(html).toContain('Made from this saved version (19 Oct, ')
    expect(html).toContain('not from the working draft.')
  })

  test('offers Word and HTML, Word chosen', () => {
    expect(html).toMatch(/aria-pressed="true"[^>]*data-format="docx"/)
    expect(html).toMatch(/aria-pressed="false"[^>]*data-format="html"/)
    expect(html).toContain('Word (.docx)')
  })

  test('the mark is off and its name field is off until asked for; earlier names are offered', () => {
    expect(html).toMatch(/<input type="checkbox"[^>]*data-testid="folio-export-mark"/)
    expect(html).not.toMatch(/<input type="checkbox"[^>]*checked/)
    expect(html).toMatch(/data-testid="folio-export-sent-to"/)
    expect(html).toMatch(/disabled=""[^>]*data-testid="folio-export-sent-to"|data-testid="folio-export-sent-to"[^>]*disabled=""/)
    expect(html).toContain('<option value="Sam Rowe">')
    expect(html).toContain('The version then carries “sent to the name you give”.')
  })

  test('the main button is Export…, and the working draft is pointed to', () => {
    expect(html).toMatch(/data-testid="folio-export-submit"[^>]*>[\s\S]*?Export…/)
    expect(html).toContain('Exporting the working draft offers to save a version before it goes.')
    expect(html).toContain('A save dialog asks where the file goes.')
  })

  test('no path is typed into the sheet: the one text field is a name', () => {
    expect([...html.matchAll(/<input [^>]*>/g)].map((m) => m[0]).filter((tag) => !/type="checkbox"/.test(tag))).toHaveLength(1)
  })
})

describe('the Mark as sent sheet', () => {
  test('is a modal that names the version and starts from who it was last sent to', () => {
    const html = renderToStaticMarkup(<MarkSentSheet dir="f" version={SENT} versions={[SENT]} onClose={() => undefined} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('Mark “Draft for Sam Rowe” as sent')
    expect(html).toContain('value="Sam Rowe"')
    expect(html).toContain('“sent to Sam Rowe”')
  })

  test('a version never sent starts empty', () => {
    const html = renderToStaticMarkup(<MarkSentSheet dir="f" version={VERSION} versions={[VERSION]} onClose={() => undefined} />)
    expect(html).toContain('value=""')
    expect(html).not.toContain('data-testid="folio-mark-replaces"')
  })
})

describe('the names offered', () => {
  test('each name sent to once, in the list\'s order', () => {
    expect(sentNames([{ sentTo: 'Sam Rowe' }, {}, { sentTo: 'Alex' }, { sentTo: 'Sam Rowe' }])).toEqual(['Sam Rowe', 'Alex'])
    expect(sentNames([])).toEqual([])
  })
})

describe('the read-only banner\'s Export…', () => {
  const reading = { id: 'fv_abc_0123', name: 'After pilot numbers', ts: Date.UTC(2026, 9, 19, 16, 40), author: 'Dominik Lukes' }
  test('is on when a handler is wired and off with its reason when not', () => {
    const on = renderToStaticMarkup(<ReaderBanner version={reading} onBack={() => undefined} onExport={() => undefined} />)
    expect(on).not.toMatch(/data-reader-action="export"[^>]*aria-disabled/)
    const off = renderToStaticMarkup(<ReaderBanner version={reading} onBack={() => undefined} />)
    expect(off).toMatch(/data-reader-action="export"[^>]*aria-disabled="true"/)
  })
})
