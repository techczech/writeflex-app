import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FolioOpenButton, folioOpenParts, folioOpenTarget } from '../../src/renderer/src/components/FolioOpenButton'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import type { Folio, Plan, PlanPart } from '../../src/renderer/src/../../preload'

const part = (title: string, path: string | null): PlanPart => ({ title, gloss: null, role: '', tags: [], path, line: 1 })
const folio: Folio = { contentRoot: '', files: [] }
const plan = (parts: PlanPart[]): Plan => ({ dir: 'guide', indexPath: 'guide/Index.md', headingLine: 1, parts, unlisted: [] })

test('the parts are the running order that have a file, with their titles', () => {
  const parts = folioOpenParts(folio, plan([part('Shape', 'guide/Shape.md'), part('Draft idea', null), part('Write', 'guide/Write.md')]))
  expect(parts).toEqual([{ path: 'guide/Shape.md', title: 'Shape' }, { path: 'guide/Write.md', title: 'Write' }])
})

test('the main button opens the first part and the menu opens the part chosen', () => {
  const parts = folioOpenParts(folio, plan([part('Shape', 'guide/Shape.md'), part('Write', 'guide/Write.md')]))
  expect(folioOpenTarget(parts)).toBe('guide/Shape.md')
  expect(folioOpenTarget(parts, 1)).toBe('guide/Write.md')
  expect(folioOpenTarget(parts, 5)).toBeNull()
})

test('a Folio with a manifest but no Folio outline yet opens from the manifest pieces', () => {
  expect(folioOpenParts(folio, null, ['guide/Shape.md', 'guide/Write.md'])).toEqual([{ path: 'guide/Shape.md', title: 'Shape' }, { path: 'guide/Write.md', title: 'Write' }])
})

test('an Index-Note Folio outline with written parts counts as a Folio page too', () => {
  expect(folioOpenParts(null, plan([part('Shape', 'guide/Shape.md')]))).toEqual([{ path: 'guide/Shape.md', title: 'Shape' }])
})

test('nothing for a plain folder or a Folio with no part on disk', () => {
  expect(folioOpenParts(null, plan([part('Idea', null)]))).toEqual([])
  expect(folioOpenParts(null, null)).toEqual([])
  expect(folioOpenParts(folio, plan([part('Idea', null)]))).toEqual([])
  expect(folioOpenParts(folio, null)).toEqual([])
  expect(folioOpenParts(null, null, ['guide/Shape.md'])).toEqual([])
  expect(renderToStaticMarkup(<FolioOpenButton parts={[]} onOpen={() => {}} />)).toBe('')
})

test('the button shows its name, its chord and a menu button', () => {
  const html = renderToStaticMarkup(<FolioOpenButton parts={[{ path: 'a.md', title: 'A' }]} onOpen={() => {}} />)
  expect(html).toContain('Open Folio')
  expect(html).toContain('⌘↩')
  expect(html).toContain('aria-label="Open at…"')
  expect(html).toContain('aria-haspopup="menu"')
})

test('Open Folio is a palette command and on the cheat-sheet', () => {
  const command = commandRegistry.find((c) => c.id === 'folio.open')
  expect(command?.label).toBe('Open Folio')
  expect(command?.surfaces).toEqual(['palette', 'sheet'])
})
