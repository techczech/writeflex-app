import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { Workspace } from '../../src/main/workspace'
import { actionLayoutAt, filterActionGroups, insertObjectRows } from '../../src/renderer/src/commands/actions-here'
import { parseTable } from '../../src/renderer/src/editor/object-editors/table-editor'
import { buildTable, insertFootnote, isSvgFile, isSvgText } from '../../src/renderer/src/editor/insert-objects'
import { insertBlockObject } from '../../src/renderer/src/editor/insert-block-object'
import { sanitiseSvg } from '../../src/shared/sanitise-svg'

// The logic of tests/e2e/insert-objects.spec.ts without Electron. What stays in the e2e: the drawn menu and
// grid editor, mermaid/markmap rendering (needs a DOM), the ↓-escape from a trailing block and the ``` key
// (renderer key handlers).

// The one-pixel PNG the e2e dropped on the editor.
const PIXEL_PNG = Uint8Array.from(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252, 255, 31, 0, 2, 235, 1, 245, 105, 118, 102, 144, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))

describe('dropping an image file saves it (the real main-process write, on a real folder)', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-insert-objects-')) })
  afterEach(() => rm(root, { recursive: true, force: true }))

  test('the bytes land under assets/pasted-<stamp>.png exactly as dropped, and a second drop never overwrites the first', async () => {
    const ws = new Workspace(root)
    const first = await ws.saveImage(PIXEL_PNG, 'png')
    expect(first.path).toMatch(/^assets\/pasted-\d{4}-\d{2}-\d{2}-\d{6}\.png$/)
    expect(`![pasted image](${first.path})`).toMatch(/^!\[pasted image\]\(assets\/pasted-/) // the link the editor inserts
    expect(new Uint8Array(await readFile(join(root, first.path)))).toEqual(PIXEL_PNG)

    const second = await ws.saveImage(Uint8Array.from([1, 2, 3]), 'png')
    expect(second.path).not.toBe(first.path)
    expect(new Uint8Array(await readFile(join(root, first.path)))).toEqual(PIXEL_PNG) // the first is untouched
    expect(new Uint8Array(await readFile(join(root, second.path)))).toEqual(Uint8Array.from([1, 2, 3]))
    expect((await readdir(join(root, 'assets'))).sort()).toEqual([first.path, second.path].map((p) => p.replace('assets/', '')).sort())
  })

  test('the same write through the document-only door a document-only folder uses', async () => {
    const ws = new Workspace(root)
    const saved = await ws.saveImage(PIXEL_PNG, 'png', { documentOnly: true })
    expect(saved.path).toMatch(/^assets\/pasted-.*\.png$/)
    expect(new Uint8Array(await readFile(join(root, saved.path)))).toEqual(PIXEL_PNG)
  })
})

describe('the ⌘K Insert object list', () => {
  const rows = insertObjectRows({})
  const paragraph = actionLayoutAt('paragraph', null, {}).groups

  test('lists eleven objects, Widget… after Image…', () => {
    expect(rows.map((row) => row.label)).toEqual(['Table', 'Image…', 'Widget…', 'Code block', 'Flow diagram', 'Mind map', 'SVG', 'Divider', 'Footnote', 'Metadata', 'Reference…'])
    expect(rows).toHaveLength(11)
  })

  test('typing "tab" filters it to the one Table row', () => {
    const shown = filterActionGroups(paragraph, 'tab', rows).flatMap((group) => group.rows)
    expect(shown.filter((row) => row.id === 'insert.table')).toHaveLength(1)
    expect(rows.filter((row) => `${row.label} ${row.keywords}`.toLowerCase().includes('tab'))).toHaveLength(1)
  })
})

/** The slice of an EditorView that insertBlockObject uses. */
function viewOf(doc: string, anchor: number) {
  let state = EditorState.create({ doc, selection: { anchor } })
  const view = { get state() { return state }, dispatch(spec: Parameters<EditorState['update']>[0]) { state = state.update(spec).state }, focus() {} }
  return { view: view as unknown as EditorView, doc: () => state.doc.toString() }
}

describe('inserted objects', () => {
  test('the table lands as a 3x3 skeleton (header plus three body rows) on its own lines', () => {
    const { view, doc } = viewOf('# Objects\n\nStart here.', '# Objects\n\nStart here.'.length)
    insertBlockObject(view, buildTable(), { open: true })
    expect(doc()).toBe(`# Objects\n\nStart here.\n\n${buildTable()}`)
    const model = parseTable(buildTable())
    expect(model!.cells).toHaveLength(4) // the header and three body rows
    expect(model!.cells.flat()).toHaveLength(12) // the grid editor opens twelve cell textareas
  })

  test('Footnote inserts the next marker at the caret and its definition at the end', () => {
    const doc = '# Objects\n\nStart here.'
    const result = insertFootnote(doc, doc.length)
    expect(result).toContain('[^1]')
    expect(result).toContain('[^1]:')
    expect(result).toBe('# Objects\n\nStart here.[^1]\n\n[^1]: ')
  })

  test('Footnote put before a later marker renumbers by marker position', () => {
    const result = insertFootnote('Start here. Later[^8].\n\n[^8]: later', 0)
    expect(result).toContain('[^1]Start here. Later[^2].')
    expect(result).toContain('[^1]:')
    expect(result).toContain('[^2]: later')
  })
})

describe('SVG on the way in', () => {
  const circle = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
  test('pasted SVG text is recognised and renders a sanitised object with its circle', () => {
    expect(isSvgText(circle)).toBe(true)
    const result = sanitiseSvg(circle)
    expect('svg' in result && result.svg.match(/<circle/g)).toHaveLength(1)
  })

  test('an .svg file (dropped or pasted) is recognised as SVG text to embed, never as an asset', () => {
    const file = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="12" height="8"/></svg>'
    expect(isSvgFile({ name: 'shape.svg', type: 'image/svg+xml' })).toBe(true)
    expect(isSvgText(file)).toBe(true)
    const result = sanitiseSvg(file)
    expect('svg' in result && result.svg.match(/<rect/g)).toHaveLength(1)
  })

  test('hostile SVG never executes: it fails closed with an error and no script reaches the output', () => {
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg" onload="globalThis.__svgExecuted=true"><script>globalThis.__svgExecuted=true</script><rect width="20" height="20"/></svg>'
    expect(isSvgText(hostile)).toBe(true) // it is pasted as an svg block, and shown as an error beside its source
    const result = sanitiseSvg(hostile)
    expect(result).toHaveProperty('error')
    expect(JSON.stringify(result)).not.toContain('__svgExecuted')
  })
})
