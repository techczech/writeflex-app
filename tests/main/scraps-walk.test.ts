import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap, type KeyBinding } from '@codemirror/view'
import { ScrapStore } from '../../src/main/scraps'
import { Workspace } from '../../src/main/workspace'
import { SCRAP_DRAG_MIME, scrapEditing, writeScrapDrag } from '../../src/renderer/src/editor/scraps'

// The logic of tests/e2e/scraps.spec.ts without Electron. The disk half runs the real ScrapStore on a real
// temporary folder and reads the bytes back; the editor half runs the real ⌘⇧X binding and the {trigger}+space
// input handler on a CodeMirror state. What stays in the e2e: the pane's tiles and footer, the sidebar entry,
// the pointer drag of a tile into the document (the DOM drop handler).
const CUT = 'The machine-translation aside belongs elsewhere.'

let root: string
let ws: Workspace
let store: ScrapStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-scraps-walk-'))
  ws = new Workspace(root)
  store = new ScrapStore(ws)
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('the scraps file on disk', () => {
  test('a cut from a document in a subfolder lands in chapters/scraps/ beside it, never at the workspace root', async () => {
    const scrap = await store.add('chapters/essay.md', CUT)
    const scrapsPath = join(root, 'chapters', 'scraps', 'essay-SCRAPS.md')
    expect(existsSync(scrapsPath)).toBe(true)
    expect(existsSync(join(root, 'scraps', 'essay-SCRAPS.md'))).toBe(false)
    expect(await readFile(scrapsPath, 'utf8')).toBe(`## ${scrap.id}\n${CUT}\n`)
    // Grouped under its origin document in the pane.
    expect((await store.list()).map((item) => [item.origin, item.text])).toEqual([['chapters/essay.md', CUT]])
  })

  test('Mark done writes [x] on disk; dragging the tile into the document removes the section and, the last one, the file', async () => {
    const scrap = await store.add('chapters/essay.md', CUT)
    const scrapsPath = join(root, 'chapters', 'scraps', 'essay-SCRAPS.md')

    await store.toggleDone(scrap.id)
    expect(await readFile(scrapsPath, 'utf8')).toBe(`## ${scrap.id} [x]\n${CUT}\n`)
    expect((await store.list())[0].done).toBe(true)

    const removed = await store.remove(scrap.id) // what the drop does after inserting the text
    expect(removed.text).toBe(CUT)
    expect(existsSync(scrapsPath)).toBe(false)
    expect(await store.list()).toEqual([])
  })

  test('a scrap with a {trigger} is listed as expandable with its body', async () => {
    await mkdir(join(root, 'scraps'), { recursive: true })
    await writeFile(join(root, 'scraps', 'today-SCRAPS.md'), '## s_today {today}\nToday is [date].\n', 'utf8')
    const [scrap] = await store.list()
    expect(scrap).toMatchObject({ id: 's_today', expandTrigger: 'today', text: 'Today is [date].' })
  })
})

describe('the editor side', () => {
  type Fake = { state: EditorState; dispatch: (spec: Parameters<EditorState['update']>[0]) => void; focus: () => void }
  const open = (doc: string, anchor: number, head = anchor, opts: { cut?: string[]; expansions?: Array<{ trigger: string; text: string }> } = {}): { view: EditorView; fake: Fake } => {
    const extension = scrapEditing({ onCut: (text) => opts.cut?.push(text), onDrop: () => {}, expansions: () => opts.expansions ?? [], readClipboard: async () => '' })
    const fake = { state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [extension] }), focus: () => {} } as Fake
    fake.dispatch = (spec) => { fake.state = fake.state.update(spec).state }
    return { view: fake as unknown as EditorView, fake }
  }

  test('⌘⇧X cuts the selected prose line out of the document and hands exactly that text to the store', () => {
    const doc = `# Essay\n\n${CUT}\n\nMore body.\n`
    const cut: string[] = []
    const from = doc.indexOf(CUT)
    const { view, fake } = open(doc, from, from + CUT.length, { cut })
    const binding = fake.state.facet(keymap).flat().find((entry: KeyBinding) => entry.key === 'Mod-Shift-x')!
    expect(binding.run!(view)).toBe(true)
    expect(cut).toEqual([CUT])
    expect(fake.state.doc.toString()).toBe('# Essay\n\n\n\nMore body.\n')
  })

  test('⌘⇧X with nothing selected is not taken', () => {
    const { view, fake } = open('# Essay\n\nText.\n', 3)
    const binding = fake.state.facet(keymap).flat().find((entry: KeyBinding) => entry.key === 'Mod-Shift-x')!
    expect(binding.run!(view)).toBe(false)
  })

  test('typing {today} then a space expands the body with today\'s long British date; the space is consumed', () => {
    const doc = '# Essay\n\nWrite here: {today}'
    const { view, fake } = open(doc, doc.length, doc.length, { expansions: [{ trigger: 'today', text: 'Today is [date].' }] })
    const handler = fake.state.facet(EditorView.inputHandler)[0]
    expect(handler(view, doc.length, doc.length, ' ', () => { throw new Error('the space must not be typed') })).toBe(true)
    const today = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(new Date())
    expect(fake.state.doc.toString()).toBe(`# Essay\n\nWrite here: Today is ${today}.`)
  })

  test('a space after text that is not a registered trigger types normally', () => {
    const doc = 'Write here: {nothing}'
    const { view, fake } = open(doc, doc.length, doc.length, { expansions: [{ trigger: 'today', text: 'x' }] })
    expect(fake.state.facet(EditorView.inputHandler)[0](view, doc.length, doc.length, ' ', () => { throw new Error('unused') })).toBe(false)
  })

  test('the drag payload a tile carries is the id and text the drop re-inserts', () => {
    const written: Array<[string, string]> = []
    writeScrapDrag({ setData: (type: string, data: string) => { written.push([type, data]) }, effectAllowed: 'none' } as unknown as DataTransfer, { id: 's_a', text: CUT })
    expect(written).toEqual([[SCRAP_DRAG_MIME, JSON.stringify({ id: 's_a', text: CUT })], ['text/plain', CUT]]) // plain text rides along for other drop targets
  })
})
