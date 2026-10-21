// A Markdown table at a phone width (375 px) scrolls inside its own box, not the whole page. Every
// table in the HTML file export and on the sharing reader page sits directly inside
// `<div class="... table-scroll">`, and the stylesheet that both pages carry has the rule for that class.
import { expect, test } from 'bun:test'
import { toHtml } from '../../src/shared/markdown/to-html'
import { renderReaderPage } from '../../sharing-service/reader-page.ts'
import { parsePublishBody } from '../../sharing-service/share-protocol.ts'

const RULE = '.table-scroll{overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch}'
const TABLE = [
  '| Alpha | Beta | Gamma | Delta | Epsilon | Zeta |',
  '| --- | --- | --- | --- | --- | --- |',
  '| A long cell with a lot of words in it to force wrapping | more text | 12 | 2026-10-19 | more | end |',
].join('\n')

test('a table in the reader page sits inside the table-scroll box, and the reader stylesheet has its rule', () => {
  const part = toHtml(TABLE, { tableRegions: true, links: 'external-only' }).html
  const page = renderReaderPage(parsePublishBody({
    revision: 1, savedAt: Date.UTC(2026, 9, 19), timeZone: 'Europe/London', sharedBy: null, kind: 'piece',
    title: 'Table test', chips: [], parts: [{ html: part }],
  }))
  expect(page).toMatch(/<div class="wf-table-region table-scroll"><table[ >]/)
  expect(page).toContain(RULE)
  expect(page.split('<table').length - 1).toBe(1)
  expect(page.split('table-scroll"><table').length - 1).toBe(1)
})

test('a table in the HTML file export sits inside the table-scroll box, and the export stylesheet has its rule', () => {
  const html = toHtml(TABLE, { standalone: true, tableRegions: true, links: 'external-only' }).html
  expect(html).toMatch(/<div class="wf-table-region table-scroll"><table[ >]/)
  expect(html).toContain(RULE)
  expect(html.split('table-scroll"><table').length - 1).toBe(1)
})

test('a copy keeps the bare table: no wrapper and no table-scroll box', () => {
  const copy = toHtml(TABLE, { links: 'external-only' }).html
  expect(copy).toMatch(/^<table[ >]/)
  expect(copy).not.toContain('table-scroll')
})
