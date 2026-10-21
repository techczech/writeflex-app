import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { acceptedSummary, useReviewActions, type ReviewActions, type ReviewActionDeps } from '../../src/renderer/src/app/review-actions'
import type { Change, FileReadResult } from '../../src/preload'
import { acceptThroughOwner, replayAcceptRedo } from '../../src/renderer/src/app/resolution-routes'
import { createDocumentOwner } from '../../src/renderer/src/app/document-owner'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'

test('a resolved file is reconciled before the final inline-change refresh', async () => {
  const reviewActions = await import('../../src/renderer/src/app/review-actions') as typeof import('../../src/renderer/src/app/review-actions') & {
    reconcileResolvedFile?: (
      file: FileReadResult,
      reconcile: (file: FileReadResult) => void,
      refreshInlineChanges: () => Promise<void>,
    ) => Promise<void>
  }
  const order: string[] = []
  const file = { file: { path: 'draft.md', name: 'draft.md' }, content: '# Draft\n' } as FileReadResult

  expect(typeof reviewActions.reconcileResolvedFile).toBe('function')
  await reviewActions.reconcileResolvedFile!(
    file,
    () => order.push('reconcile'),
    async () => {
      order.push('refresh-inline')
    },
  )

  expect(order).toEqual(['reconcile', 'refresh-inline'])
})

for (const message of [undefined, 'Change rejected, but its Agent note failed: unavailable']) {
  test(`reject settlement announces ${message ? 'the backend warning' : 'success without a backend message'}`, async () => {
    const events: string[] = []
    let actions: ReviewActions | undefined
    const deps: ReviewActionDeps = {
      ledger: {
        resolveChange: async (id, action) => {
          events.push(`${action}:${id}`)
          return { applied: true, message }
        },
        setChangeStatus: async () => undefined,
      },
      changes: [], dockChanges: [], suggestions: [],
      editorRef: { current: null },
      recordedWriterChanges: { current: new Map() },
      acceptSuggestion: async () => false,
      rejectSuggestion: async () => false,
      savePath: async () => true,
      reloadChanges: async () => { events.push('reload') },
      refreshInlineChangesAfterReconcile: async () => undefined,
      flash: (text) => { events.push(text) },
      handleAgentWorkspaceChange: () => undefined,
      reconcileAppliedFile: () => undefined,
      acceptThroughOwner: async (_path, _id, resolve) => ({ status: 'acted', result: await resolve(), recorded: false }),
      inDocumentQueue: (_path, run) => run(),
      focusComposer: () => undefined,
      setChangesOpen: () => undefined,
      selectChange: () => undefined,
      settleChange: (id, advance) => { events.push(`settle:${id}:${advance}`) },
    }
    function Harness(): null {
      actions = useReviewActions(deps)
      return null
    }
    renderToString(createElement(Harness))
    expect(await actions!.rejectChange('opening')).toBe(true)
    expect(events).toEqual([
      'reject:opening', 'reload', message ?? 'Suggestion discarded', 'settle:opening:false',
    ])
  })
}

// ── Review round 3, finding 1 (docs/plans/quit-does-not-stall/quit-and-window-close-spec.md) ─────────
// A change whose live suggestion was consumed is resolved through the ledger. Main here is a double
// that takes calls in the order they arrive and keeps main's rule (agent.ts resolveChangeWriting): a reject
// never writes, an Apply of a discarded change and a Discard of an applied one are refused.
const DISCARDED_NOT_APPLIED = 'That suggestion was discarded, so nothing was written. Reopen it to apply it.'
const APPLIED_NOT_DISCARDED = 'That change is already applied, so it was not discarded. Undo in the editor takes it back.'
const LEDGER_CHANGE = { id: 'opening', path: 'draft.md', provenance: 'agent', status: 'pending', oldText: 'old', newText: 'new' } as unknown as Change
const LEDGER_FILE = { file: { path: 'draft.md', name: 'draft.md' }, content: 'new\n' } as FileReadResult

function ledgerHarness(options: { recorded: boolean }) {
  const main = { status: 'pending', calls: [] as string[] }
  const events: string[] = []
  const flashes: string[] = []
  let actions: ReviewActions | undefined
  // The real document owner and accept route, over an open draft.md (the editor's buffer is a variable).
  const registry = createUnsavedRegistry()
  let buffer: string | null = 'old\n'
  const owner = createDocumentOwner({
    buffer: () => buffer, notice: () => undefined, registry,
    write: async (_path, doc) => { main.calls.push('saveFile'); return { content: doc, written: doc } },
    setReadOnly: () => {}, forgetBuffer: () => {}, replaceBuffer: (_path, text) => { buffer = text }, dirtyChanged: () => {},
    report: { slow: () => {}, refusedByNotice: () => {}, refusedByMain: () => {}, diskChanged: () => {}, saved: () => {}, outsideAfterWrite: () => {}, unknown: () => {} },
  })
  owner.activated('draft.md', 'old\n', () => 'old\n')
  const replaceFromMain = owner.replaceFromMain.bind(owner)
  owner.replaceFromMain = (path, answer, opts) => { events.push(`written-by-main:${answer.content}`); return replaceFromMain(path, answer, opts) }
  const deps: ReviewActionDeps = {
    ledger: {
      // As main: an accept of a pending change writes it; an accept of a discarded one and a reject of an
      // applied one are refused with nothing written; a reject of a pending one writes nothing.
      resolveChange: async (id, action) => {
        main.calls.push(`${action}:${id}`)
        if (action === 'accept') {
          if (main.status === 'rejected') return { applied: false, message: DISCARDED_NOT_APPLIED }
          main.status = 'accepted'
          return { applied: true, file: LEDGER_FILE }
        }
        if (main.status === 'accepted') return { applied: false, message: APPLIED_NOT_DISCARDED }
        main.status = 'rejected'
        return { applied: true }
      },
      setChangeStatus: async () => undefined,
    },
    changes: [LEDGER_CHANGE], dockChanges: [LEDGER_CHANGE], suggestions: [],
    editorRef: { current: { recordSuggestionResolution: () => options.recorded } as never },
    recordedWriterChanges: { current: new Map() },
    acceptSuggestion: async () => false,
    rejectSuggestion: async () => false,
    savePath: async () => true,
    reloadChanges: async () => { events.push('reload') },
    refreshInlineChangesAfterReconcile: async () => { events.push('refresh-inline') },
    flash: (text) => { flashes.push(text) },
    handleAgentWorkspaceChange: () => undefined,
    reconcileAppliedFile: (file) => { events.push(`reconcile:${file.content}`) },
    acceptThroughOwner: (path, id, resolve) => acceptThroughOwner({
      owner,
      bufferOf: () => buffer,
      recordInEditor: (_path, _id, resolved) => { if (options.recorded) buffer = resolved ?? buffer; return options.recorded },
      askAbout: (_path, diskText) => { events.push(`ask:${diskText}`) },
      refusalReason: () => undefined,
    }, path, id, resolve),
    inDocumentQueue: (path, run) => owner.inQueue(path, run),
    focusComposer: () => undefined,
    setChangesOpen: () => undefined,
    selectChange: () => undefined,
    settleChange: () => undefined,
  }
  function Harness(): null {
    actions = useReviewActions(deps)
    return null
  }
  renderToString(createElement(Harness))
  return { main, events, flashes, actions: actions!, ledger: deps.ledger, owner, registry, buffer: () => buffer, setBuffer: (text: string) => { buffer = text } }
}

test('accepting through the ledger, taken by the editor as an undoable edit: the returned file goes to the owner\'s replaceFromMain before the refresh', async () => {
  const h = ledgerHarness({ recorded: true })
  expect(await h.actions.acceptChange('opening')).toBe(true)
  expect(h.events).toEqual(['written-by-main:new\n', 'refresh-inline'])
})

test('accepting through the ledger when the editor did not take it: the returned file still goes to the owner\'s replaceFromMain, never to a plain reconcile (review F3)', async () => {
  const h = ledgerHarness({ recorded: false })
  expect(await h.actions.acceptChange('opening')).toBe(true)
  expect(h.events).toEqual(['written-by-main:new\n', 'refresh-inline'])
})

test('redo of an accept, then Discard from the review pane: main receives them in that order, the Discard is refused as already applied, the change stays accepted and the text stays', async () => {
  // Quit spec row 113 as amended (round 4). Guard: main's refusal of a reject on an accepted record (here
  // the double's, as agent.ts resolveChangeWriting) and the flash of it in rejectChange.
  const h = ledgerHarness({ recorded: true })
  h.setBuffer('new\n') // the editor's redo
  const redone = replayAcceptRedo({
    owner: h.owner, bufferOf: () => 'new\n', heldText: (path) => h.registry.textOf(path),
    hold: (path) => h.registry.hold(path), editorPresent: () => true, flash: () => undefined,
    diskChanged: () => undefined, // the redo's write carries the buffer's baseline (save-basis)
    api: { saveFile: async () => { h.main.calls.push('put-back'); return { ...LEDGER_FILE, written: LEDGER_FILE.content } }, resolveChange: h.ledger.resolveChange } as never,
  }, { id: 'opening', path: 'draft.md', beforeContent: 'old\n' })
  // The Discard is asked for before the redo has reached main: it runs after it, in the document's queue.
  const rejected = h.actions.rejectChange('opening')
  expect(await redone).toBe(true)
  expect(await rejected).toBe(false)
  expect(h.main.calls).toEqual(['put-back', 'accept:opening', 'reject:opening'])
  expect(h.main.status).toBe('accepted')
  expect(h.flashes).toEqual([APPLIED_NOT_DISCARDED])
  expect(h.buffer()).toBe('new\n')
  expect(h.events).not.toContain('written-by-main:old\n')
})

test('redo of a reject, then Apply from the review pane: main receives them in that order, the Apply is refused, and the change stays rejected', async () => {
  // Quit spec row 113 as amended (round 4). Guard: main's refusal of an accept on a rejected record (here
  // the double's, as agent.ts resolveChangeWriting) and the flash of it in acceptChange.
  const h = ledgerHarness({ recorded: true })
  // The redo of a reject is one call to main, made at once (replaySuggestionResolution in App.tsx).
  await h.ledger.resolveChange('opening', 'reject')
  expect(await h.actions.acceptChange('opening')).toBe(false)
  expect(h.main.calls).toEqual(['reject:opening', 'accept:opening'])
  expect(h.main.status).toBe('rejected')
  expect(h.flashes).toEqual([DISCARDED_NOT_APPLIED])
  expect(h.buffer()).toBe('old\n')
  expect(h.events).not.toContain('written-by-main:old\n')
  expect(h.events).not.toContain('written-by-main:new\n')
})

// ── Ticket 04 (review margin as comments): the bulk writes. Accept all, Decline all (after its confirmation) and the
// picked Accept / Decline reach the ledger through acceptMany / rejectMany: one call per target, in document order,
// for the targets only, then one reload and one toast. The same per-change route as a single Accept or Decline, so
// readers' pages get the same outcomes. ─────────────────────────────────────────────────────────────────────────
function bulkHarness(refuse: ReadonlySet<string> = new Set()) {
  const calls: string[] = []
  const at = (id: string, n: number): Change => ({ id, path: 'draft.md', provenance: 'agent', status: 'pending', oldText: `old ${n}`, newText: `new ${n}` }) as unknown as Change
  // Document order: p1 … p5, as the dock lists them.
  const dock = [at('p1', 1), at('p2', 2), at('p3', 3), at('p4', 4), at('p5', 5)]
  let actions: ReviewActions | undefined
  const deps: ReviewActionDeps = {
    ledger: {
      // As main after ticket 14: an Accept that cannot be placed is refused and the item stays waiting.
      resolveChange: async (id, action) => {
        calls.push(`${action}:${id}`)
        return action === 'accept' && refuse.has(id) ? { applied: false, message: `The words around this change are no longer in draft.md as they were (${id})` } : { applied: true }
      },
      setChangeStatus: async (id, status) => { calls.push(`status:${id}:${status}`) },
    },
    changes: dock, dockChanges: dock, suggestions: [],
    editorRef: { current: null },
    recordedWriterChanges: { current: new Map() },
    acceptSuggestion: async () => false,
    rejectSuggestion: async () => false,
    savePath: async () => true,
    reloadChanges: async () => { calls.push('reload') },
    refreshInlineChangesAfterReconcile: async () => undefined,
    flash: (text) => { calls.push(`flash:${text}`) },
    handleAgentWorkspaceChange: () => undefined,
    reconcileAppliedFile: () => undefined,
    acceptThroughOwner: async (_path, _id, resolve) => ({ status: 'acted', result: await resolve(), recorded: false }),
    inDocumentQueue: (_path, run) => run(),
    focusComposer: (text) => { calls.push(`composer:${text}`) },
    setChangesOpen: () => undefined,
    selectChange: () => undefined,
    settleChange: () => undefined,
    onAcceptRefused: (id, reason) => { calls.push(`refused:${id}:${reason}`) },
  }
  function Harness(): null {
    actions = useReviewActions(deps)
    return null
  }
  renderToString(createElement(Harness))
  return { calls, actions: actions! }
}

// ---- ticket 06 (from 14): batch Accept counts only what was applied and names the refused; Reopen ----

test('picked Accept over a refusal counts only the applied changes and names the refused one', async () => {
  const { calls, actions } = bulkHarness(new Set(['p3']))
  await actions.acceptMany(['p1', 'p3', 'p5'])
  expect(calls.filter((call) => call.startsWith('accept:'))).toEqual(['accept:p1', 'accept:p3', 'accept:p5'])
  // The refused one is reported to the card (Could not be applied, with main's reason) and named in the toast.
  expect(calls).toContain('refused:p3:The words around this change are no longer in draft.md as they were (p3)')
  expect(calls.at(-1)).toBe('flash:Accepted 2 changes. 1 could not be applied: “old 3”.')
  expect(calls.some((call) => call.startsWith('status:'))).toBe(false)
})

test('Accept all over refusals never says "Accepted N" for what was not applied', async () => {
  const { calls, actions } = bulkHarness(new Set(['p1', 'p2', 'p3', 'p4', 'p5']))
  actions.acceptAllPending()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls.filter((call) => call.startsWith('accept:'))).toHaveLength(5)
  expect(calls.at(-1)).toBe('flash:Nothing was accepted. 5 could not be applied: “old 1”, “old 2”, “old 3” and 2 more.')
})

test('the batch summary', () => {
  expect(acceptedSummary(3, [])).toBe('Accepted 3 changes')
  expect(acceptedSummary(1, [])).toBe('Accepted 1 change')
  expect(acceptedSummary(1, ['“a”'])).toBe('Accepted 1 change. 1 could not be applied: “a”.')
})

test('Reopen from a settled row puts the item back to waiting through the existing status door, then reloads', async () => {
  const { calls, actions } = bulkHarness()
  await actions.reopenChange('p2')
  expect(calls).toEqual(['status:p2:pending', 'reload', 'flash:Suggestion reopened'])
})

test('bulk Accept: one ledger accept per target, in document order, only for the targets', async () => {
  const { calls, actions } = bulkHarness()
  // Picked out of order, and p2 / p4 (hidden by a filter, say) are not among them.
  await actions.acceptMany(['p5', 'p1', 'p3'])
  expect(calls.filter((call) => call.startsWith('accept:'))).toEqual(['accept:p1', 'accept:p3', 'accept:p5'])
  expect(calls.some((call) => /p2|p4/.test(call))).toBe(false)
  expect(calls.slice(-2)).toEqual(['reload', 'flash:Accepted 3 changes'])
})

test('bulk Decline: one ledger reject per target, in document order, the same call a single Decline makes', async () => {
  const single = bulkHarness()
  await single.actions.rejectChange('p2')
  const { calls, actions } = bulkHarness()
  await actions.rejectMany(['p4', 'p2'])
  expect(calls.filter((call) => call.startsWith('reject:'))).toEqual(['reject:p2', 'reject:p4'])
  // The bulk path writes exactly what the single path writes, per change.
  expect(single.calls.filter((call) => call.startsWith('reject:'))).toEqual(['reject:p2'])
  expect(calls.some((call) => call.startsWith('accept:') || call.startsWith('status:'))).toBe(false)
  expect(calls.at(-1)).toBe('flash:Rejected 2 changes')
})

test('nothing to act on writes nothing', async () => {
  const { calls, actions } = bulkHarness()
  await actions.acceptMany([])
  await actions.rejectMany([])
  expect(calls).toEqual([])
})

test('Send back keeps today’s message: one note to the agent composer, and no ledger call', () => {
  const { calls, actions } = bulkHarness()
  actions.sendRunBack('  Keep my examples.  ')
  expect(calls).toEqual(['composer:Revise this review run before I save a version:\n\nKeep my examples.', 'flash:Comments returned to the agent composer'])
  actions.sendRunBack('   ')
  expect(calls).toHaveLength(2)
})
