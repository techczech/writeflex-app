import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { useReviewActions, type ReviewActions, type ReviewActionDeps } from '../../src/renderer/src/app/review-actions'
import type { Change, FileReadResult } from '../../src/preload'
import { replayAcceptRedo } from '../../src/renderer/src/app/main-wrote-document'

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
      documentWrittenByMain: () => undefined,
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
// that takes calls in the order they arrive.
const LEDGER_CHANGE = { id: 'opening', path: 'draft.md', provenance: 'agent', status: 'pending', oldText: 'old', newText: 'new' } as unknown as Change
const LEDGER_FILE = { file: { path: 'draft.md', name: 'draft.md' }, content: 'new\n' } as FileReadResult

function ledgerHarness(options: { recorded: boolean }) {
  const main = { status: 'pending', calls: [] as string[] }
  const events: string[] = []
  let actions: ReviewActions | undefined
  const deps: ReviewActionDeps = {
    ledger: {
      resolveChange: async (id, action) => {
        main.calls.push(`${action}:${id}`)
        main.status = action === 'accept' ? 'accepted' : 'rejected'
        return action === 'accept' ? { applied: true, file: LEDGER_FILE } : { applied: true }
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
    flash: () => undefined,
    handleAgentWorkspaceChange: () => undefined,
    reconcileAppliedFile: (file) => { events.push(`reconcile:${file.content}`) },
    documentWrittenByMain: (file) => { events.push(`written-by-main:${file.content}`) },
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
  return { main, events, actions: actions!, ledger: deps.ledger }
}

test('accepting through the ledger, taken by the editor as an undoable edit: the returned file goes to documentWrittenByMain before the refresh', async () => {
  const h = ledgerHarness({ recorded: true })
  expect(await h.actions.acceptChange('opening')).toBe(true)
  expect(h.events).toEqual(['written-by-main:new\n', 'refresh-inline'])
})

test('accepting through the ledger when the editor did not take it: reconciled as before, which rebases the baseline itself', async () => {
  const h = ledgerHarness({ recorded: false })
  expect(await h.actions.acceptChange('opening')).toBe(true)
  expect(h.events).toEqual(['reconcile:new\n', 'refresh-inline'])
})

test('redo of an accept, then Discard from the review pane: main receives them in that order and the change ends rejected', async () => {
  const h = ledgerHarness({ recorded: true })
  const redone = replayAcceptRedo({
    setBaseline: () => undefined, bufferOf: () => 'new\n', setDirty: () => undefined, heldText: () => undefined, keep: () => undefined,
    hold: () => () => undefined, unknown: () => undefined, editorPresent: () => true, flash: () => undefined,
    api: { saveFile: async () => { h.main.calls.push('saveFile'); return LEDGER_FILE }, resolveChange: h.ledger.resolveChange } as never,
  }, { id: 'opening', path: 'draft.md', beforeContent: 'old\n' })
  // The redo is not waiting for anything: its first call to main is made in the turn it was asked for.
  expect(h.main.calls).toEqual(['saveFile'])
  expect(await redone).toBe(true)
  expect(await h.actions.rejectChange('opening')).toBe(true)
  expect(h.main.calls).toEqual(['saveFile', 'accept:opening', 'reject:opening'])
  expect(h.main.status).toBe('rejected')
})

test('redo of a reject, then Apply from the review pane: main receives them in that order and the change ends accepted', async () => {
  const h = ledgerHarness({ recorded: true })
  // The redo of a reject is one call to main, made at once (replaySuggestionResolution in App.tsx).
  await h.ledger.resolveChange('opening', 'reject')
  expect(await h.actions.acceptChange('opening')).toBe(true)
  expect(h.main.calls).toEqual(['reject:opening', 'accept:opening'])
  expect(h.main.status).toBe('accepted')
})
