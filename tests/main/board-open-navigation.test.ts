import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createDocumentOwner } from '../../src/renderer/src/app/document-owner'
import { folderIsFolio } from '../../src/renderer/src/app/folio-routing'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import type { WriteAnswer } from '../../src/renderer/src/app/write-buffer'

// Drive App's actual Board entry, tab activation and outgoing flush without an Electron window.
const app = ts.createSourceFile('App.tsx', readFileSync(new URL('../../src/renderer/src/app/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = app.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App') as ts.FunctionDeclaration
const names = new Set(['queuedFolderOpen', 'folderOpenRequest', 'collectionRenameFollow', 'boardOpenRequest', 'pendingBoardOpen', 'retireOpenBoard', 'retireBoardAndCollectionOpens', 'retireFolderOpen', 'activate', 'flushPaths', 'startBoardOpen', 'openBoard', 'resumeBoardOpen'])
const callbacks = component.body!.statements
  .filter(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => names.has(decl.name.getText(app))))
  .map(node => node.getText(app)).join('\n')
const boardEntry = ts.transpile(`
  let tabsHydrated = initiallyHydrated
  ${callbacks}
  return {
    openBoard, activate, resumeBoardOpen,
    bind: (nextRoot) => { root = nextRoot; documentWorkspaceRef.current = {}; resumeBoardOpen() },
    hydrate: (active) => { activeRef.current = active; tabsHydrated = true; resumeBoardOpen() },
  }
`, { target: ts.ScriptTarget.ES2022 })

const A = 'a/draft.md'
const B = 'b/draft.md'
const BOARD = 'board://'
const afterReply = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
const noop = (): void => {}
const refusal = { refused: true, message: 'Save refused by main' } as const
const saveFirst = { content: 'A updated', written: 'A updated' }

function barrier<T>() {
  const called = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<T>()
  return {
    started: called.promise,
    resolve: answer.resolve,
    reply: () => { called.resolve(); return answer.promise },
  }
}

function harness(initiallyHydrated = true) {
  const calls: string[] = []
  const declaration = barrier<{ isFolio: boolean }>()
  const resolution = barrier<{ collection: boolean }>()
  const persist = barrier<void>()
  const save = barrier<WriteAnswer>()
  const activeRef = { current: initiallyHydrated ? A : null as string | null }
  const documentWorkspaceRef = { current: initiallyHydrated ? {} : null }
  const refused = (message: string, announce = true) => {
    calls.push('save refused')
    if (announce) calls.push(`status:${message}`)
  }
  const owner = createDocumentOwner({
    registry: createUnsavedRegistry(),
    buffer: path => path === A ? 'A updated' : null,
    notice: () => undefined,
    write: () => { calls.push('save:a'); return save.reply() },
    setReadOnly: noop, forgetBuffer: noop, renameBuffer: noop, replaceBuffer: noop, dirtyChanged: noop,
    report: {
      slow: noop, saved: noop, diskChanged: noop, outsideAfterWrite: noop, unknown: noop,
      refusedByNotice: (_path, message, announce = true) => refused(message, announce),
      refusedByMain: (_path, message, announce = true) => refused(message, announce),
    },
  })
  const writeflex = {
    collection: {
      status: (dir: string) => {
        calls.push(`resolve:${dir}`)
        return dir === 'a' && holdResolution ? resolution.reply() : Promise.resolve({ collection: true })
      },
    },
    readFolioDeclaration: (dir: string) => {
      calls.push(`detect:${dir}`)
      return dir === 'a' ? declaration.reply() : Promise.resolve({ isFolio: false })
    },
    folioRoom: {
      setState: (dir: string, patch: object) => {
        calls.push(`persist:${dir}:${JSON.stringify(patch)}`)
        return holdPersistence ? persist.reply() : Promise.resolve()
      },
    },
  }
  let scratchpadRetirements = 0
  let holdPersistence = false
  let holdResolution = false
  const ports = {
    window: { writeflex, dispatchEvent: (event: CustomEvent) => calls.push(`focus:${event.detail}`) },
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => ({ current }),
    folioOpenNavigation: { retire: noop },
    retireScratchpadVersionOpen: () => { scratchpadRetirements += 1 },
    pendingEditorJump: { current: null },
    filesActivation: { current: null },
    initiallyHydrated, root: initiallyHydrated ? '/workspace' : undefined, activeRef, documentWorkspaceRef,
    owner, cancelAutosaveFor: noop,
    activeCollectionDir: '', boardActive: false, boardDir: 'old-board', collectionDir: null,
    setCollectionDir: (dir: string | null) => calls.push(`collection:${dir}`),
    setOpenPlanRequested: (open: boolean) => calls.push(`plan:${open}`),
    setSelectedFolderPiece: () => calls.push('clear selection'),
    flash: (message: string) => calls.push(`status:${message}`),
    collectionDirFor: async (path: string) => {
      const dir = path.split('/')[0]
      await writeflex.collection.status(dir)
      return dir
    },
    folderIsFolio,
    ROOM_VIEW_EVENT: 'writeflex:folio-room-view',
    BOARD_TAB_ID: BOARD,
    tabsRef: { current: [A, B, BOARD] },
    boardSeenStatusesRef: { current: new Set() },
    setBoardFilter: () => calls.push('clear filter'),
    setBoardDir: (dir: string) => calls.push(`board folder:${dir}`),
    openTab: (id: string) => calls.push(`focus:${id}`),
    activateTab: (path: string) => { activeRef.current = path; calls.push(`tab:${path}`) },
  }
  const entry = new Function(...Object.keys(ports), boardEntry)(...Object.values(ports)) as {
    openBoard: () => void
    activate: (path: string) => void
    bind: (root: string) => void
    hydrate: (active: string) => void
    resumeBoardOpen: () => void
  }
  return {
    ...entry, calls, declaration, resolution, persist, save,
    scratchpadRetirements: () => scratchpadRetirements,
    holdFolioPersistence: () => { holdPersistence = true },
    holdFolderResolution: () => { holdResolution = true },
    editA: () => { owner.activated(A, 'A', () => 'A'); owner.edited(A, 'A updated') },
    isASaved: () => owner.isSaved(A),
  }
}

for (const isFolio of [true, false]) {
  test(`a late ${isFolio ? 'Folio' : 'Collection'} Board result cannot replace B's Board`, async () => {
    const h = harness()
    h.openBoard()
    await h.declaration.started
    h.activate(B)
    h.openBoard()
    await afterReply()
    expect(h.calls).toContain('board folder:b')
    expect(h.calls.at(-1)).toBe(`focus:${BOARD}`)
    const beforeLateA = [...h.calls]
    h.declaration.resolve({ isFolio })
    await afterReply()
    expect(h.calls).toEqual(beforeLateA)
  })
}

test('returning to A is a new navigation lifetime for its earlier Board request', async () => {
  const h = harness()
  h.openBoard()
  await h.declaration.started
  h.activate(B)
  h.activate(A)
  const beforeLateA = [...h.calls]

  h.declaration.resolve({ isFolio: true })
  await afterReply()
  expect(h.calls).toEqual(beforeLateA)
})

test('a second Board command supersedes the first in the same navigation', async () => {
  const h = harness()
  h.openBoard()
  await h.declaration.started
  h.openBoard()
  h.declaration.resolve({ isFolio: true })
  await afterReply()

  expect(h.calls.filter(call => call.startsWith('persist:'))).toHaveLength(1)
  expect(h.calls.filter(call => call === 'collection:a')).toHaveLength(1)
})

test('a retired Board command stops after resolving its folder', async () => {
  const h = harness()
  h.holdFolderResolution()
  h.openBoard()
  await h.resolution.started
  h.activate(B)
  h.resolution.resolve({ collection: true })
  await afterReply()
  h.declaration.resolve({ isFolio: false })
  await afterReply()
  expect(h.calls).toEqual(['resolve:a', 'collection:null', 'plan:false', 'clear selection', `tab:${B}`])
})

test('a Folio preference write admitted before a later tab change cannot then navigate or focus', async () => {
  const h = harness()
  h.holdFolioPersistence()
  h.openBoard()
  await h.declaration.started
  h.declaration.resolve({ isFolio: true })
  await h.persist.started
  h.activate(B)
  const beforeReply = [...h.calls]

  h.persist.resolve()
  await afterReply()
  expect(h.calls).toEqual(beforeReply)
})

test('a live Board waits for the outgoing save before opening Folio status lanes', async () => {
  const h = harness()
  h.editA()
  h.openBoard()
  await h.save.started
  expect(h.calls).toEqual(['save:a'])
  h.save.resolve(saveFirst)
  await h.declaration.started
  h.declaration.resolve({ isFolio: true })
  await afterReply()

  expect(h.isASaved()).toBe(true)
  expect(h.calls).toEqual([
    'save:a', 'resolve:a', 'detect:a', 'persist:a:{"view":"cards","split":false,"cardsByStatus":true}',
    'clear selection', 'plan:true', 'collection:a',
  ])
})

test('a live delayed save refusal keeps the Board closed and tells the writer', async () => {
  const h = harness()
  h.editA()
  h.openBoard()
  await h.save.started
  h.save.resolve(refusal)
  await afterReply()

  expect(h.isASaved()).toBe(false)
  expect(h.calls).toContain('status:Could not save the current Piece — the Board stayed closed.')
  expect(h.calls.some(call => call.startsWith('resolve:') || call.startsWith('focus:'))).toBe(false)
})

for (const result of [saveFirst, refusal]) {
  test(`a retired Board command says nothing and stays closed after its delayed save ${'refused' in result ? 'fails' : 'succeeds'}`, async () => {
    const h = harness()
    h.editA()
    h.openBoard()
    await h.save.started
    h.activate(B)
    h.openBoard()
    await afterReply()
    expect(h.calls).toContain('board folder:b')
    const beforeReply = [...h.calls]

    h.save.resolve(result)
    await afterReply()
    h.declaration.resolve({ isFolio: true })
    await afterReply()
    expect(h.isASaved()).toBe(!('refused' in result))
    expect(h.calls).toEqual('refused' in result ? [...beforeReply, 'save refused'] : beforeReply)
  })
}

test('a launch Board command waits for root binding and opens from the restored tab once', async () => {
  const h = harness(false)
  h.openBoard()
  expect(h.scratchpadRetirements()).toBe(1)
  h.bind('/workspace')
  expect(h.calls).toEqual([])

  h.hydrate(A)
  h.resumeBoardOpen()
  await h.declaration.started
  h.declaration.resolve({ isFolio: false })
  await afterReply()

  expect(h.scratchpadRetirements()).toBe(1)
  expect(h.calls.filter(call => call.startsWith('detect:'))).toEqual(['detect:a'])
  expect(h.calls.filter(call => call === `focus:${BOARD}`)).toHaveLength(1)
  expect(h.calls).toContain('board folder:a')
})

test('navigation before tab hydration retires a waiting Board command', async () => {
  const h = harness(false)
  h.bind('/workspace')
  h.openBoard()
  h.activate(B)
  expect(h.scratchpadRetirements()).toBe(2)
  const beforeHydration = [...h.calls]

  h.hydrate(B)
  await afterReply()
  expect(h.calls).toEqual(beforeHydration)
})

test('a waiting Board command cannot open in a different workspace', async () => {
  const h = harness(false)
  h.bind('/workspace')
  h.openBoard()
  h.bind('/another-workspace')

  h.hydrate(B)
  await afterReply()
  expect(h.calls).toEqual([])
})
