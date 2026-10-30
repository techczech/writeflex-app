import { beforeEach, describe, expect, test } from 'bun:test'
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { createScratchpadController, type ControllerPorts } from '../../src/renderer/src/scratchpad/scratchpad-controller'
import { liveAnchors, scratchpadEditing } from '../../src/renderer/src/scratchpad/scratchpad-editor'
import type { ScratchItem, ScratchpadBridge } from '../../src/shared/scratchpad-items'

// The controller over the editor seam and the bridge (ticket 01): a cut never loses prose — the text
// leaves the editor only after the Scratchpad answered, and only if the window, folder, document and
// span are still the ones captured. Insert a copy keeps the item; Put back is only for a recorded cut.

type Port = { state: EditorState; dispatch: (spec: TransactionSpec | Transaction) => void }
const makePort = (doc: string, anchor: number, head = anchor): Port => {
  const port = { state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [history(), scratchpadEditing()] }) } as Port
  port.dispatch = (spec) => { port.state = ('startState' in (spec as object) ? (spec as Transaction) : port.state.update(spec as TransactionSpec)).state }
  return port
}

type Gate = { promise: Promise<void>; open: () => void }
const gate = (): Gate => { let open = () => {}; const promise = new Promise<void>((resolve) => { open = resolve }); return { promise, open } }

let calls: Array<[string, any]>
let failSend: string | null
let failConfirm: string | null
let sendGate: Gate | null
let prepared: { ok: true; markdown: string; rewritten: number } | { ok: false; error: string } | null
let said: Array<{ message: string; action?: { label: string; run: () => void } }>
let root: string | null
let path: string | null
let port: Port | null

const bridge = {
  sendText: async (input) => {
    calls.push(['sendText', input])
    if (sendGate) await sendGate.promise
    if (failSend) return { ok: false, error: failSend }
    return { ok: true, item: { id: 'p_new000001', how: 'copy', markdown: input.markdown } as ScratchItem }
  },
  reserveCut: async (input) => { calls.push(['reserveCut', input]); return { ok: true } },
  cancelCut: async (input) => { calls.push(['cancelCut', input]); return { ok: true } },
  confirmCut: async (input) => { calls.push(['confirmCut', input]); return failConfirm ? { ok: false, error: failConfirm } : { ok: true } },
  discardCopy: async (input) => { calls.push(['discardCopy', input]); return { ok: true } },
  prepareInsert: async (input) => { calls.push(['prepareInsert', input]); return prepared ?? { ok: true, markdown: 'Inserted words.', rewritten: 0 } },
  recordUse: async (input) => { calls.push(['recordUse', input]); return { ok: true } },
  dropUse: async (input) => { calls.push(['dropUse', input]); return { ok: true } },
  releaseUses: async (input) => { calls.push(['releaseUses', input]); return { ok: true, dropped: 0 } },
} as Partial<ScratchpadBridge> as ScratchpadBridge

const ports = (): ControllerPorts => ({ bridge, view: () => port, root: () => root, activePath: () => path, say: (message, action) => { said.push({ message, ...(action ? { action } : {}) }) }, partName: (p) => p })

const TEXT = 'Keep this paragraph safe.'
const DOC = `# Essay\n\n${TEXT}\n\nTail.\n`
const select = (): Port => makePort(DOC, DOC.indexOf(TEXT), DOC.indexOf(TEXT) + TEXT.length)

beforeEach(() => {
  calls = []; failSend = null; failConfirm = null; sendGate = null; prepared = null; said = []; root = '/ws/a'; path = 'essay.md'; port = null
})

describe('cut', () => {
  test('saves and reserves the copy, removes the text, then confirms the cutting', async () => {
    port = select()
    sendGate = gate()
    const pending = createScratchpadController(ports()).cut()
    await Promise.resolve()
    expect(port.state.doc.toString()).toBe(DOC) // still there while the save is in flight
    sendGate.open()
    expect(await pending).toBe('cut')
    expect(port.state.doc.toString()).toBe(DOC.replace(TEXT, ''))
    expect(calls.map(([name]) => name)).toEqual(['sendText', 'reserveCut', 'confirmCut'])
    expect(calls[0][1]).toMatchObject({ root: '/ws/a', origin: 'essay.md', markdown: TEXT, heading: 'Essay' })
  })

  test('a failed save leaves the prose in place and says so', async () => {
    port = select()
    failSend = 'Writes are paused.'
    expect(await createScratchpadController(ports()).cut()).toBe('failed')
    expect(port.state.doc.toString()).toBe(DOC)
    expect(said.at(-1)!.message).toContain('still in the document')
  })

  test('an edit inside the selection while saving: the copy is kept, the text stays, and it is not recorded as a cut', async () => {
    port = select()
    sendGate = gate()
    const pending = createScratchpadController(ports()).cut()
    await Promise.resolve()
    port.dispatch({ changes: { from: DOC.indexOf('paragraph'), insert: 'new ' } })
    sendGate.open()
    expect(await pending).toBe('kept-as-copy')
    expect(port.state.doc.toString()).toContain('Keep this new paragraph safe.')
    expect(calls.map(([name]) => name)).toEqual(['sendText'])
    expect(said.at(-1)!.message).toContain('not removed')
  })

  test('a folder or document switch while saving: nothing is removed from whatever is open now', async () => {
    port = select()
    sendGate = gate()
    const pending = createScratchpadController(ports()).cut()
    await Promise.resolve()
    root = '/ws/b'
    sendGate.open()
    expect(await pending).toBe('kept-as-copy')
    expect(port.state.doc.toString()).toBe(DOC)
    expect(calls.map(([name]) => name)).toEqual(['sendText'])
  })

  test('failed confirmation keeps the saved copy protected and editor Undo can restore the cut', async () => {
    port = select()
    failConfirm = 'Disk full.'
    expect(await createScratchpadController(ports()).cut()).toBe('cut-recorded-as-copy')
    expect(port.state.doc.toString()).toBe(DOC.replace(TEXT, ''))
    expect(said.at(-1)!.message).toContain('as a copy')
  })

  test('editor Undo after a cut restores the text and never touches the saved scrap', async () => {
    port = select()
    await createScratchpadController(ports()).cut()
    undo({ state: port.state, dispatch: (tr) => port!.dispatch(tr) })
    expect(port.state.doc.toString()).toBe(DOC)
    expect(calls.map(([name]) => name)).toEqual(['sendText', 'reserveCut', 'confirmCut'])
  })
})

describe('send a copy', () => {
  test('keeps the document unchanged, and the toast Undo discards only the new copy', async () => {
    port = select()
    expect(await createScratchpadController(ports()).sendCopy()).toBe('copied')
    expect(port.state.doc.toString()).toBe(DOC)
    said.at(-1)!.action!.run()
    await Promise.resolve()
    expect(calls.map(([name]) => name)).toEqual(['sendText', 'discardCopy'])
  })
})

describe('insert and put back', () => {
  const item = (how: 'cut' | 'copy' | null): ScratchItem => ({
    id: how === null ? 'legacy:essay.md#s_abc' : 'p_item000001', source: how === null ? 'legacy' : 'lossless', kind: 'text', how, by: 'writer',
    createdAt: null, origin: { path: 'essay.md', heading: null }, title: 't', markdown: 'x', group: null, status: 'active', done: false, uses: [],
  })

  test('Insert a copy writes the prepared Markdown at the caret in one step and keeps the item', async () => {
    port = makePort(DOC, DOC.indexOf('Tail.'))
    expect(await createScratchpadController(ports()).insert(item('copy'), 'copy')).toBe('inserted')
    expect(port.state.doc.toString()).toBe(`# Essay\n\n${TEXT}\n\nTail.\n\nInserted words.\n`)
    expect(calls.map(([name]) => name)).toEqual(['prepareInsert'])
    expect(liveAnchors(port.state).map((a) => [a.itemId, a.mode])).toEqual([['p_item000001', 'copy']])
  })

  test('Put back is refused for a copy and for a legacy scrap of unknown kind', async () => {
    port = makePort(DOC, 0)
    expect(await createScratchpadController(ports()).insert(item('copy'), 'put-back')).toBe('refused')
    expect(await createScratchpadController(ports()).insert(item(null), 'put-back')).toBe('refused')
    expect(port.state.doc.toString()).toBe(DOC)
    expect(calls).toEqual([])
  })

  test('a refused preparation (a link that cannot be carried) writes nothing', async () => {
    port = makePort(DOC, 0)
    prepared = { ok: false, error: 'This text links outside this workspace.' }
    expect(await createScratchpadController(ports()).insert(item('cut'), 'put-back')).toBe('refused')
    expect(port.state.doc.toString()).toBe(DOC)
    expect(said.at(-1)!.message).toContain('outside this workspace')
  })

  test('a document switch during preparation writes nothing into the new document', async () => {
    port = makePort(DOC, 0)
    const controller = createScratchpadController({ ...ports(), bridge: { ...bridge, prepareInsert: async () => { path = 'other.md'; return { ok: true, markdown: 'x', rewritten: 0 } } } as ScratchpadBridge })
    expect(await controller.insert(item('cut'), 'put-back')).toBe('refused')
    expect(port.state.doc.toString()).toBe(DOC)
  })

  test('anchors gained and lost are recorded as uses with the document they are in', async () => {
    port = makePort(DOC, 0)
    const controller = createScratchpadController(ports())
    const before = port.state
    await controller.insert(item('cut'), 'put-back')
    controller.syncAnchors(before, port.state)
    const placed = port.state
    undo({ state: port.state, dispatch: (tr) => port!.dispatch(tr) })
    controller.syncAnchors(placed, port.state)
    await Promise.resolve()
    expect(calls.filter(([name]) => name === 'recordUse' || name === 'dropUse').map(([name, input]) => [name, input.id, input.use?.mode ?? null, input.use?.path ?? null])).toEqual([
      ['recordUse', 'p_item000001', 'put-back', 'essay.md'],
      ['dropUse', 'p_item000001', null, null],
    ])
  })
})

// R2: the Scratchpad never writes into a saved version, a past session's recall or a detached document,
// including when the editor switches into one while an action awaits its answer. The live document the
// version stands in front of (stashed, as EditorPane.enterHistorical keeps it) stays byte-identical.
describe('saved-version view (R2)', () => {
  const OLD = '# Essay\n\nAn older wording.\n\nTail.\n'
  const historical = (): EditorState => EditorState.create({ doc: OLD, selection: EditorSelection.single(OLD.indexOf('An'), OLD.indexOf('An') + 9), extensions: [EditorState.readOnly.of(true), history(), scratchpadEditing()] })
  const item: ScratchItem = {
    id: 'p_item000001', source: 'lossless', kind: 'text', how: 'cut', by: 'writer', createdAt: null,
    origin: { path: 'essay.md', heading: null }, title: 't', markdown: 'x', group: null, status: 'active', done: false, uses: [],
  }

  test('Insert a copy, Put back, Cut and Send a copy in a saved version write nothing anywhere', async () => {
    port = select()
    const live = port.state
    port.state = historical()
    const controller = createScratchpadController(ports())
    expect(await controller.insert(item, 'copy')).toBe('refused')
    expect(await controller.insert(item, 'put-back')).toBe('refused')
    expect(await controller.cut()).toBe('nothing')
    expect(await controller.sendCopy()).toBe('nothing')
    expect(port.state.doc.toString()).toBe(OLD)
    expect(live.doc.toString()).toBe(DOC)
    expect(calls).toEqual([])
    expect(said.at(-1)!.message).toContain('saved version')
  })

  test('the App\'s own word counts too: a version shown in an editable-looking state is still refused', async () => {
    port = select()
    const controller = createScratchpadController({ ...ports(), editable: () => false })
    expect(await controller.insert(item, 'copy')).toBe('refused')
    expect(await controller.cut()).toBe('nothing')
    expect(port.state.doc.toString()).toBe(DOC)
  })

  test('switching to a saved version while the insert is prepared: nothing is inserted into it', async () => {
    port = select()
    const live = port.state
    const controller = createScratchpadController({ ...ports(), bridge: { ...bridge, prepareInsert: async () => { port!.state = historical(); return { ok: true, markdown: 'Inserted words.', rewritten: 0 } } } as ScratchpadBridge })
    expect(await controller.insert(item, 'copy')).toBe('refused')
    expect(port.state.doc.toString()).toBe(OLD)
    expect(live.doc.toString()).toBe(DOC)
  })

  test('switching to a saved version while a cut is saved: the copy is kept and nothing is removed', async () => {
    port = select()
    const live = port.state
    sendGate = gate()
    const pending = createScratchpadController(ports()).cut()
    port.state = historical()
    sendGate.open()
    expect(await pending).toBe('kept-as-copy')
    expect(port.state.doc.toString()).toBe(OLD)
    expect(live.doc.toString()).toBe(DOC)
    expect(calls.map(([name]) => name)).toEqual(['sendText'])
  })

  test('an old insertion toast\'s Undo pressed in a saved version changes nothing', async () => {
    port = makePort(DOC, DOC.indexOf('Tail.'))
    await createScratchpadController(ports()).insert(item, 'copy')
    const live = port.state
    port.state = historical()
    said.find((entry) => entry.action)!.action!.run()
    expect(port.state.doc.toString()).toBe(OLD)
    expect(live.doc.toString()).toContain('Inserted words.')
    expect(said.at(-1)!.message).toContain('Nothing was taken out')
  })
})

describe('insertion toast Undo after later edits (R3)', () => {
  const item: ScratchItem = {
    id: 'p_item000001', source: 'lossless', kind: 'text', how: 'copy', by: 'writer', createdAt: null,
    origin: { path: 'essay.md', heading: null }, title: 't', markdown: 'x', group: null, status: 'active', done: false, uses: [],
  }

  test('typing inside the insert, then the toast Undo: refused with a pointer to ⌘Z, and the writer\'s words stay', async () => {
    port = makePort(DOC, DOC.indexOf('Tail.'))
    await createScratchpadController(ports()).insert(item, 'copy')
    const at = port.state.doc.toString().indexOf('Inserted words.') + 'Inserted'.length
    port.dispatch({ changes: { from: at, insert: ' and new' } })
    said.find((entry) => entry.action)!.action!.run()
    expect(port.state.doc.toString()).toContain('Inserted and new words.')
    expect(said.at(-1)!.message).toContain('Use Undo in the text')
  })
})

describe('documents shown afresh (R4)', () => {
  test('the controller tells main which anchors the live editor still holds for the shown document', async () => {
    port = makePort(DOC, DOC.indexOf('Tail.'))
    const controller = createScratchpadController(ports())
    await controller.insert({ id: 'p_item000001', source: 'lossless', kind: 'text', how: 'cut', by: 'writer', createdAt: null, origin: { path: 'essay.md', heading: null }, title: 't', markdown: 'x', group: null, status: 'active', done: false, uses: [] }, 'put-back')
    controller.documentShown()
    const release = calls.find(([name]) => name === 'releaseUses')![1]
    expect(release).toEqual({ root: '/ws/a', path: 'essay.md', keep: [liveAnchors(port.state)[0].useId] })
  })

  test('nothing is released from a saved version, whose state holds no anchors', () => {
    port = makePort(DOC, 0)
    port.state = EditorState.create({ doc: DOC, extensions: [EditorState.readOnly.of(true), history(), scratchpadEditing()] })
    createScratchpadController(ports()).documentShown()
    expect(calls).toEqual([])
  })
})


test('a stale send response whose item was withdrawn cannot authorize removal', async () => {
  port = select()
  const controller = createScratchpadController({ ...ports(), bridge: {
    ...bridge,
    reserveCut: async () => ({ ok: false, error: 'This Scratchpad item is not there any more.' }),
  } })
  expect(await controller.cut()).toBe('failed')
  expect(port.state.doc.toString()).toBe(DOC)
})

test('a late editor change leaves a reserved copy, never a falsely recorded cutting', async () => {
  port = select()
  const wait = gate()
  let how = 'copy'
  const controller = createScratchpadController({ ...ports(), bridge: {
    ...bridge,
    reserveCut: async () => { await wait.promise; return { ok: true } },
    cancelCut: async () => ({ ok: true }),
    confirmCut: async () => { how = 'cut'; return { ok: true } },
  } as ScratchpadBridge })
  const result = controller.cut()
  await Promise.resolve()
  await Promise.resolve()
  port.dispatch({ changes: { from: DOC.indexOf('paragraph'), insert: 'new ' } })
  wait.open()
  expect(await result).toBe('kept-as-copy')
  expect(port.state.doc.toString()).toContain('Keep this new paragraph safe.')
  expect(how).toBe('copy')
})

describe('typed assets', () => {
  test('a typed table inserts as a real block outside a fence, once, with one Undo', async () => {
    const doc = '```md\nexample\n```\n\nTail.'
    port = makePort(doc, doc.indexOf('example') + 2)
    const markdown = '| A | B |\n|---|---|\n| 1 | 2 |'
    prepared = { ok: true, markdown, rewritten: 0 }
    const item = { id: 'p_asset0001', kind: 'table', source: 'lossless', how: 'copy', uses: [] } as unknown as ScratchItem
    expect(await createScratchpadController(ports()).insert(item, 'copy')).toBe('inserted')
    expect(port.state.doc.toString()).toContain('```\n\n' + markdown)
    expect(liveAnchors(port.state)).toHaveLength(1)
    expect(undo(port)).toBe(true)
    expect(port.state.doc.toString()).toBe(doc)
  })
  test('an unclosed code fence refuses a typed insertion before writing anything', async () => {
    const doc = '```md\nexample'
    port = makePort(doc, doc.length)
    prepared = { ok: true, markdown: '![Picture](assets/a.png)', rewritten: 0 }
    const item = { id: 'p_asset0001', kind: 'pic', source: 'lossless', how: 'copy', uses: [] } as unknown as ScratchItem
    expect(await createScratchpadController(ports()).insert(item, 'copy')).toBe('refused')
    expect(port.state.doc.toString()).toBe(doc)
  })
})

describe('select the section (ticket 04 bubble)', () => {
  test('extends the selection to the heading and everything under it, and captures nothing', () => {
    const doc = '# Essay\n\nIntro.\n\n## Choosing the reviewers\n\nReviewers were chosen.\n\n- one\n\n## Next section\n\nTail.\n'
    port = makePort(doc, doc.indexOf('Reviewers were chosen.'))
    expect(createScratchpadController(ports()).selectSection()).toBe(true)
    const { from, to } = port.state.selection.main
    const chosen = port.state.sliceDoc(from, to)
    expect(chosen).toContain('## Choosing the reviewers')
    expect(chosen).toContain('Reviewers were chosen.')
    expect(chosen).toContain('- one')
    expect(chosen).not.toContain('## Next section')
    expect(chosen).not.toContain('Intro.')
    expect(calls).toEqual([]) // selection only: no bridge write of any kind
    expect(port.state.doc.toString()).toBe(doc)
  })

  test('in a saved version (not editable) it refuses and selects nothing new', () => {
    const doc = '## Heading\n\nWords.\n'
    port = makePort(doc, 3)
    const controller = createScratchpadController({ ...ports(), editable: () => false })
    expect(controller.selectSection()).toBe(false)
    expect(port.state.selection.main.from).toBe(3)
    expect(said.map((s) => s.message).join(' ')).toContain('saved version')
  })
})

test('typed insertion refuses a destination edited during asynchronous preparation', async () => {
  const doc = '# Draft\n\nBody.'
  port = makePort(doc, doc.length)
  const item = { id: 'p_asset0001', kind: 'pic', source: 'lossless', how: 'copy', uses: [] } as unknown as ScratchItem
  const controller = createScratchpadController({ ...ports(), bridge: { ...bridge, prepareInsert: async () => {
    port!.dispatch({ changes: { from: port!.state.doc.length, insert: ' User edit.' } })
    return { ok: true, markdown: '![Picture](assets/a.png)', rewritten: 0 }
  } } })
  expect(await controller.insert(item, 'copy')).toBe('refused')
  expect(port.state.doc.toString()).toBe(doc + ' User edit.')
  expect(liveAnchors(port.state)).toEqual([])
})

// While the widget workbench covers the ordinary editor, the Scratchpad is suspended: no action
// may select, capture or write in the hidden editor — including one whose bridge call was already
// in flight when the workbench opened.
describe('suspended behind the widget workbench', () => {
  const textItem: ScratchItem = {
    id: 'p_item000001', source: 'lossless', kind: 'text', how: 'copy', by: 'writer', createdAt: null,
    origin: { path: 'essay.md', heading: null }, title: 't', markdown: 'x', group: null, status: 'active', done: false, uses: [],
  }

  test('cut, send a copy, insert and select-section all refuse and write nothing anywhere', async () => {
    port = select()
    const controller = createScratchpadController({ ...ports(), suspended: () => true })
    expect(await controller.cut()).toBe('nothing')
    expect(await controller.sendCopy()).toBe('nothing')
    expect(await controller.insert(textItem, 'copy')).toBe('refused')
    expect(controller.selectSection()).toBe(false)
    expect(port.state.doc.toString()).toBe(DOC)
    expect(calls).toEqual([])
    expect(said.every((entry) => entry.message.includes('widget workbench'))).toBe(true)
  })

  test('the workbench opening while an insert is prepared: nothing lands in the covered editor', async () => {
    port = makePort(DOC, DOC.indexOf('Tail.'))
    let suspendedNow = false
    const controller = createScratchpadController({
      ...ports(),
      suspended: () => suspendedNow,
      bridge: { ...bridge, prepareInsert: async () => { suspendedNow = true; return { ok: true, markdown: 'Inserted words.', rewritten: 0 } } } as ScratchpadBridge,
    })
    expect(await controller.insert(textItem, 'copy')).toBe('refused')
    expect(port.state.doc.toString()).toBe(DOC)
    expect(liveAnchors(port.state)).toEqual([])
    expect(said.at(-1)!.message).toContain('widget workbench')
  })

  test('the workbench opening while a cut is saved: the copy is kept and no words leave the document', async () => {
    port = select()
    sendGate = gate()
    let suspendedNow = false
    const pending = createScratchpadController({ ...ports(), suspended: () => suspendedNow }).cut()
    await Promise.resolve()
    suspendedNow = true
    sendGate.open()
    expect(await pending).toBe('kept-as-copy')
    expect(port.state.doc.toString()).toBe(DOC)
    expect(calls.map(([name]) => name)).toEqual(['sendText'])
    expect(said.at(-1)!.message).toContain('widget workbench opened')
  })

  test('reference actions refuse too, and an old insert toast Undo cannot take text out', async () => {
    port = makePort(DOC, DOC.indexOf('Tail.'))
    let suspendedNow = false
    const controller = createScratchpadController({ ...ports(), suspended: () => suspendedNow })
    expect(await controller.insert(textItem, 'copy')).toBe('inserted')
    const placed = port.state.doc.toString()
    const undoInsert = said.at(-1)!.action!
    suspendedNow = true
    const refItem = { ...textItem, kind: 'ref' } as ScratchItem
    expect(await controller.reference(refItem, 'cite')).toBe('refused')
    undoInsert.run()
    expect(port.state.doc.toString()).toBe(placed)
    expect(said.at(-1)!.message).toContain('widget workbench')
  })
})
