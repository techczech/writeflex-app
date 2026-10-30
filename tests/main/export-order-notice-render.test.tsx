/**
 * Ticket 07 (Folio room, spec § 8 D-ORD-3): the out-of-step line as the export sheet and the Share page draw it.
 * The wording is the spec's; `unreadable` shows the Plan's manifest message with no repair; no line otherwise.
 */
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExportOrderNotice, latestReads, ShareOrderPanel, type ExportOrderState } from '../../src/renderer/src/components/ExportOrderNotice'
import { exportOrderLine, partsNotInExport, type ExportOrderAgreement } from '../../src/shared/export-order-agreement'

const UNREADABLE = 'This Folio’s manifest could not be read, so its outline cannot be shown. Check the manifest file, then reopen the Folio.'

function state(agreement: ExportOrderAgreement, extra: Partial<ExportOrderState> = {}): ExportOrderState {
  return { line: exportOrderLine(agreement, UNREADABLE), said: null, busy: false, pieces: null, repair: () => {}, dismiss: () => {}, ...extra }
}

const differs: ExportOrderAgreement = { kind: 'disagree', orderDiffers: { index: ['b', 'a'], manifest: ['a', 'b'] }, notInExport: ['c', 'd'], notInRunningOrder: [] }

test('the export sheet\'s line: both sentences and both buttons, in the amber notice', () => {
  const html = renderToStaticMarkup(<ExportOrderNotice state={state(differs)} onExportAnyway={() => {}} />)
  expect(html).toContain('class="export-warn export-order"')
  expect(html).toContain('<b>The export order does not match the running order</b>')
  expect(html).toContain('2 parts are not in the export')
  expect(html).toContain('Make export follow the running order')
  expect(html).toContain('Export anyway')
})

test('the Share page\'s line: a problem panel with the same sentences and buttons', () => {
  const html = renderToStaticMarkup(<ShareOrderPanel state={state(differs)} />)
  expect(html).toContain('data-problem="export-order"')
  expect(html).toContain('The export order does not match the running order')
  expect(html).toContain('2 parts are not in the export')
  expect(html).toContain('Make export follow the running order')
  expect(html).toContain('Export anyway')
})

test('unreadable shows the Plan\'s manifest message and no repair; agree, no-manifest and Not-in-the-outline-only show nothing', () => {
  const unreadable = renderToStaticMarkup(<ExportOrderNotice state={state({ kind: 'unreadable' })} onExportAnyway={() => {}} />)
  expect(unreadable).toContain(UNREADABLE)
  expect(unreadable).not.toContain('Make export follow')
  expect(unreadable).not.toContain('Export anyway')
  for (const agreement of [{ kind: 'agree' }, { kind: 'no-manifest' }, { kind: 'disagree', notInExport: [], notInRunningOrder: ['x'] }] as ExportOrderAgreement[]) {
    expect(renderToStaticMarkup(<ExportOrderNotice state={state(agreement)} onExportAnyway={() => {}} />)).toBe('')
    expect(renderToStaticMarkup(<ShareOrderPanel state={state(agreement)} />)).toBe('')
  }
})

test('a refusal or a repair is said; while the repair runs both buttons are off', () => {
  const refused = renderToStaticMarkup(<ExportOrderNotice state={state(differs, { said: { ok: false, text: 'The running order changed while the export order was being repaired. Check it again.' } })} onExportAnyway={() => {}} />)
  expect(refused).toContain('role="alert"')
  expect(refused).toContain('Check it again.')
  const busy = renderToStaticMarkup(<ExportOrderNotice state={state(differs, { busy: true })} onExportAnyway={() => {}} />)
  expect(busy.match(/disabled=""/g)?.length).toBe(2)
  expect(busy).toContain('Changing the export order…')
  const done = renderToStaticMarkup(<ExportOrderNotice state={{ ...state({ kind: 'agree' }), said: { ok: true, text: 'Export and sharing now follow the running order.' } }} onExportAnyway={() => {}} />)
  expect(done).toContain('class="export-done"')
})

test('the repair action has the same amber style on both sheets', () => {
  expect(renderToStaticMarkup(<ExportOrderNotice state={state(differs)} onExportAnyway={() => {}} />)).toContain('export-order-repair')
  const share = renderToStaticMarkup(<ShareOrderPanel state={state(differs)} />)
  expect(share).toContain('class="shr-btn small export-order-repair"')
  expect(share).not.toContain('shr-btn primary')
})

test('only the latest read is applied: an older answer arriving late, or one after cancel, is dropped', async () => {
  const pending = new Map<string, (value: string) => void>()
  const applied: string[] = []
  const reads = latestReads((dir: string) => new Promise<string>((resolve) => { pending.set(dir, resolve) }), (value) => applied.push(value))
  const first = reads.read('old')
  const second = reads.read('new')
  pending.get('new')!('new answer')
  await second
  pending.get('old')!('old answer')
  await first
  expect(applied).toEqual(['new answer'])
  const third = reads.read('again')
  reads.cancel()
  pending.get('again')!('after cancel')
  await third
  expect(applied).toEqual(['new answer'])
})

test('the count sentence says one part or N parts', () => {
  expect(partsNotInExport(1)).toBe('1 part is not in the export')
  expect(partsNotInExport(2)).toBe('2 parts are not in the export')
})
