import { expect, test } from 'bun:test'
import { exportDocumentRequest } from '../../src/main/export-ipc'
import { assembleDocument, type HtmlDocumentData } from '../../src/shared/markdown/html-document'
import { htmlOutline, toHtml } from '../../src/shared/markdown/to-html'
import { readDocument } from '../../src/shared/markdown/model'
import {
  DEFAULT_EXPORT_SHEET_OPTIONS,
  exportPresetChoice,
  htmlExportOptions,
  loadExportPresetLastUsed,
  saveExportPresetLastUsed,
} from '../../src/renderer/src/components/export-sheet-options'
import { createExportPresetState, shippedExportPresetSettings, snapshotExportPresetLastUsed } from '../../src/shared/export-presets'

const FIVE_LEVELS = [
  '# One', '', '## Two', '', '#### Jumped to four', '', '##### Five', '', '### Three', '', '###### Six', '',
].join('\n')

function render(tocDepth?: number): { html: string; nav: string[] } {
  const outline = htmlOutline(readDocument(FIVE_LEVELS), '')
  const data: HtmlDocumentData = {
    frontmatter: {},
    outline,
    metadata: { title: 'Deep', description: null, purpose: null, status: null, modified: 0, words: 0 },
  }
  const html = toHtml(FIVE_LEVELS, { standalone: true, documentData: data, ...(tocDepth === undefined ? {} : { tocDepth }) }).html
  return { html, nav: [...html.matchAll(/<a class="nav-link (level-\d)" href="#[^"]*">([^<]*)<\/a>/g)].map((m) => `${m[1]} ${m[2]}`) }
}

test('the contents indents each heading to its true depth and the body keeps real tags', () => {
  const { html, nav } = render(6)
  expect(nav).toEqual([
    'level-1 One', 'level-2 Two', 'level-4 Jumped to four', 'level-5 Five', 'level-3 Three', 'level-6 Six',
  ])
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) expect(html).toContain(`<${tag} `)
})

test('toc_depth 3 lists h1-h3 only while the body still carries h4-h6', () => {
  const { html, nav } = render(3)
  expect(nav).toEqual(['level-1 One', 'level-2 Two', 'level-3 Three'])
  expect(html).toContain('Jumped to four</h4>')
  expect(html).toContain('Five</h5>')
  expect(html).toContain('Six</h6>')
})

test('an absent depth keeps the long-standing four levels', () => {
  const { nav } = render()
  expect(nav).toEqual(['level-1 One', 'level-2 Two', 'level-4 Jumped to four', 'level-3 Three'])
  expect(render().html).toBe(render(4).html)
})

test('a depth that is not 1-6 is not a choice', () => {
  const { nav } = render(9)
  expect(nav).toHaveLength(4)
})

test('contents indent is relative to the shallowest heading listed', () => {
  const md = '## Start\n\n#### Deep\n'
  const data: HtmlDocumentData = {
    frontmatter: {}, outline: htmlOutline(readDocument(md), ''),
    metadata: { title: 'T', description: null, purpose: null, status: null, modified: 0, words: 0 },
  }
  const html = assembleDocument({ title: 'T', body: toHtml(md).html, documents: [data] })
  expect(html).toContain('nav-link level-1" href="#start"')
  expect(html).toContain('nav-link level-3" href="#deep"')
})

test('the IPC payload validates tocDepth', () => {
  const base = { path: 'p.md', format: 'html', target: '/tmp/p.html' }
  expect(exportDocumentRequest({ ...base, html: { tocDepth: 5 } }).html).toEqual({ tocDepth: 5 })
  expect(() => exportDocumentRequest({ ...base, html: { tocDepth: 7 } })).toThrow()
  expect(() => exportDocumentRequest({ ...base, html: { tocDepth: 2.5 } })).toThrow()
})

test('the sheet saves the chosen depth with its last-used choice and reloads it', () => {
  const store = new Map<string, string>()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  const options = { ...DEFAULT_EXPORT_SHEET_OPTIONS, tocDepth: 6 }
  const state = { ...createExportPresetState(shippedExportPresetSettings(), null), choice: exportPresetChoice('html', options) }
  saveExportPresetLastUsed('/ws', snapshotExportPresetLastUsed(state), storage)
  const loaded = loadExportPresetLastUsed('/ws', storage)
  expect(loaded?.choice.tocDepth).toBe(6)
  expect(htmlExportOptions({ ...DEFAULT_EXPORT_SHEET_OPTIONS, tocDepth: 6 }).tocDepth).toBe(6)
  expect('tocDepth' in htmlExportOptions(DEFAULT_EXPORT_SHEET_OPTIONS)).toBe(false)
})
