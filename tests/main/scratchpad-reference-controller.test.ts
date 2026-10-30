import { beforeEach, expect, test } from 'bun:test'
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { createScratchpadController, type ControllerPorts } from '../../src/renderer/src/scratchpad/scratchpad-controller'
import { scratchpadEditing } from '../../src/renderer/src/scratchpad/scratchpad-editor'
import type { ScratchItem, ScratchpadBridge } from '../../src/shared/scratchpad-items'

// Ticket 03 controller seam: Cite/Link/Quote are one undoable editor transaction each in the part
// open at the click; Attach writes no text and undoes through the evidence token. The candidate
// is retained after every act.

type Port = { state: EditorState; dispatch: (spec: TransactionSpec | Transaction) => void }
const makePort = (doc: string, anchor: number): Port => {
  const port = { state: EditorState.create({ doc, selection: EditorSelection.single(anchor), extensions: [history(), scratchpadEditing()] }) } as Port
  port.dispatch = (spec) => { port.state = ('startState' in (spec as object) ? (spec as Transaction) : port.state.update(spec as TransactionSpec)).state }
  return port
}

let calls: Array<[string, any]>
let said: Array<{ message: string; action?: { label: string; run: () => void } }>
let port: Port
let path: string
let failPrepare: string | null

const CHIP = '[⟨Lea and Street 1998⟩](zotero://select/library/items/ABCD1234)'
const QUOTE = `> “Words.”\n>\n> ${CHIP}`

const bridge = {
  prepareReference: async (input) => {
    calls.push(['prepareReference', input])
    if (failPrepare) return { ok: false, error: failPrepare }
    return { ok: true, markdown: input.action === 'quote' ? QUOTE : CHIP, style: input.action === 'quote' ? 'block' : 'inline', label: 'Lea and Street 1998' }
  },
  attachReference: async (input) => { calls.push(['attachReference', input]); return { ok: true, token: 'ev:test-token', part: 'Details', label: 'Lea and Street 1998', message: 'Saved the evidence and notes.' } },
  undoAttach: async (input) => { calls.push(['undoAttach', input]); return { ok: true, message: 'Undone.' } },
  recordUse: async (input) => { calls.push(['recordUse', input]); return { ok: true } },
  dropUse: async (input) => { calls.push(['dropUse', input]); return { ok: true } },
} as Partial<ScratchpadBridge> as ScratchpadBridge

const item = (kind: 'ref' | 'evidence'): ScratchItem => ({
  id: 'p_ref000001', source: 'lossless', kind, how: 'copy', by: 'writer', createdAt: null,
  origin: { path: 'pangram/contents/01-summary.md', heading: null }, title: 'Lea and Street 1998', markdown: CHIP,
  group: null, status: 'active', done: false, uses: [],
  ref: { sourceId: 'ref:zotero:library/ABCD1234', citationId: 'zotero:library/ABCD1234', evidenceKind: 'zotero', target: 'zotero://select/library/items/ABCD1234', label: 'Lea and Street 1998' },
})

const DOC = '# Details\n\nA paragraph to cite in.\n'
const ports = (): ControllerPorts => ({ bridge, view: () => port, root: () => '/ws', activePath: () => path, say: (message, action) => { said.push({ message, ...(action ? { action } : {}) }) }, partName: (p) => p.split('/').pop()! })

beforeEach(() => {
  calls = []; said = []; failPrepare = null; path = 'pangram/contents/02-report.md'
  port = makePort(DOC, DOC.indexOf('cite') + 4)
})

test('cite lands inline at the caret as one transaction; toast Undo and ⌘Z each remove exactly it', async () => {
  const controller = createScratchpadController(ports())
  expect(await controller.reference(item('ref'), 'cite')).toBe('inserted')
  const after = port.state.doc.toString()
  expect(after).toBe(DOC.replace('cite', `cite${CHIP}`))
  expect(calls[0]).toEqual(['prepareReference', { root: '/ws', id: 'p_ref000001', action: 'cite', destination: path }])
  said.at(-1)!.action!.run()
  expect(port.state.doc.toString()).toBe(DOC)
  expect(await controller.reference(item('ref'), 'cite')).toBe('inserted')
  undo({ state: port.state, dispatch: port.dispatch })
  expect(port.state.doc.toString()).toBe(DOC)
})

test('quote lands as a block after the caret paragraph with an anchor; a failed prepare writes nothing', async () => {
  const controller = createScratchpadController(ports())
  expect(await controller.reference(item('evidence'), 'quote')).toBe('inserted')
  expect(port.state.doc.toString()).toContain(QUOTE)
  said.at(-1)!.action!.run()
  expect(port.state.doc.toString()).toBe(DOC)
  failPrepare = 'That source is not in the Folio\'s evidence any more.'
  expect(await controller.reference(item('evidence'), 'quote')).toBe('refused')
  expect(port.state.doc.toString()).toBe(DOC)
})

test('attach writes no text and undoes through the evidence token for the destination part', async () => {
  const controller = createScratchpadController(ports())
  expect(await controller.reference(item('ref'), 'attach')).toBe('inserted')
  expect(port.state.doc.toString()).toBe(DOC)
  expect(calls.at(-1)).toEqual(['attachReference', { root: '/ws', id: 'p_ref000001', destination: path }])
  said.at(-1)!.action!.run()
  await Promise.resolve()
  expect(calls.at(-1)).toEqual(['undoAttach', { root: '/ws', id: 'p_ref000001', token: 'ev:test-token', destination: path }])
})

test('a text item never takes the reference path, and a reference never takes the insert path', async () => {
  const controller = createScratchpadController(ports())
  const text = { ...item('ref'), kind: 'text' as const, ref: undefined }
  expect(await controller.reference(text, 'cite')).toBe('refused')
  expect(await controller.insert(item('ref'), 'copy')).toBe('refused')
  expect(port.state.doc.toString()).toBe(DOC)
  expect(calls).toEqual([])
})
