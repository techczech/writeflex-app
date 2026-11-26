// Review 2026-11-26 (PR 362). Ordinary tab activation no longer waits in the owner's queue
// (App.tsx activateDocument: `expected ? owner.inQueue(path, readAndShow) : readAndShow()`), so
// `owner.activated` can now run while the owner's own save of the same path is in flight.
// These tests drive the owner the way App now does and show what it decides.
import { describe, expect, it } from 'bun:test'
import { textForSave } from '../../src/shared/line-endings'
import { basisAllows } from '../../src/shared/save-basis'
import type { ExternalDiskNotice } from '../../src/renderer/src/editor/reconcile'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import { createDocumentOwner } from '../../src/renderer/src/app/document-owner'

const P = 'note.md'

function harness(start: string) {
  const registry = createUnsavedRegistry()
  const h = {
    disk: start,
    buffer: start,
    notices: new Map<string, ExternalDiskNotice>(),
    /** Runs after main has committed the write and before its answer reaches the renderer. */
    afterCommit: null as (() => void) | null,
  }
  const owner = createDocumentOwner({
    buffer: () => h.buffer,
    notice: (path) => h.notices.get(path),
    registry,
    write: async (_path, doc, basis) => {
      if (!basisAllows(basis, h.disk)) return { refused: 'disk-changed', diskText: h.disk, message: 'changed on disk' }
      const next = textForSave(doc, h.disk)
      h.disk = next
      const hook = h.afterCommit
      h.afterCommit = null
      hook?.()
      return { content: next, written: next }
    },
    setReadOnly: () => {},
    forgetBuffer: () => {},
    renameBuffer: () => {},
    replaceBuffer: (_path, diskText) => { h.buffer = diskText },
    dirtyChanged: () => {},
    report: {
      slow: () => {}, refusedByNotice: () => {}, refusedByMain: () => {}, diskChanged: () => {},
      saved: () => {}, outsideAfterWrite: () => {}, unknown: () => {},
    },
  })
  owner.activated(P, start, () => h.buffer)
  const type = (text: string): void => { h.buffer = text; owner.edited(P, text) }
  return { h, owner, type }
}

describe('PR 362: activation outside the queue while the same document saves', () => {
  it('re-activating a tab after its own save committed is not an outside change (typing during the save)', async () => {
    const { h, owner, type } = harness('Start.\n')
    type('Start.\nFirst paragraph.\n')
    let activation: ReturnType<typeof owner.activated> | null = null
    // main has written "First paragraph", its answer is not back yet; the writer typed on and
    // switched away and back, so the activation read sees the app's own write.
    h.afterCommit = () => {
      type('Start.\nFirst paragraph.\nSecond, typed during the save.\n')
      activation = owner.activated(P, h.disk, () => h.buffer)
    }
    await owner.save(P)
    // Queued (before 362) the read came after the answer and the result was 'kept'. Now it is
    // 'conflict': App raises "Changed on disk" for the app's own write, blocks the next autosave,
    // and offers Reload, which replaces the buffer with the first paragraph only.
    expect(activation).toBe('kept')
  })

  it('a read made before the save committed, applied after its answer, does not replace the saved buffer', async () => {
    const { h, owner, type } = harness('Start.\n')
    type('Start.\nMy paragraph.\n')
    const staleRead = h.disk // the activation read returned before main renamed the new file in
    await owner.save(P)
    expect(h.disk).toBe('Start.\nMy paragraph.\n')
    const action = owner.activated(P, staleRead, () => h.buffer)
    // Now: 'replaced' and the editor silently shows "Start." with the dot clear, while the disk
    // holds the paragraph; the next typing saves over a basis main rejects.
    expect(action).not.toBe('replaced')
    expect(h.buffer).toBe('Start.\nMy paragraph.\n')
  })
})
