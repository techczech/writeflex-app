// The changed-on-disk notices (src/renderer/src/app/disk-notices.ts, upkeep ticket 13) at their plain-function
// interface, with the save seam's own rule (mayWriteUnderDiskNotice, reconcile.ts) asked as the save asks it.
import { expect, test } from 'bun:test'
import { mayWriteUnderDiskNotice, type ExternalDiskNotice } from '../../src/renderer/src/editor/reconcile'
import { mergeSheetVerdict, movedNotice, stalePaths, stepForOutside, withNotice, withoutNotice, type DiskNotices } from '../../src/renderer/src/app/disk-notices'
import type { DiskMergeSession } from '../../src/renderer/src/app/disk-merge'

const P = 'notes/a.md'
const none: DiskNotices = new Map()

/** The notice the app raises when another program writes `diskText` under a buffer with the writer's text. */
function outsideChange(notices: DiskNotices, diskText: string): { notices: DiskNotices; notice: ExternalDiskNotice | undefined; cancelAutosave: boolean } {
  const step = stepForOutside(notices.get(P), { kind: 'conflict', diskText })!
  const next = step.notice === 'keep' ? notices : step.notice === 'clear' ? withoutNotice(notices, P) : withNotice(notices, P, step.notice)
  return { notices: next, notice: next.get(P), cancelAutosave: step.cancelAutosave }
}

test('a notice raised over the writer\'s text refuses the save and freezes the automatic one', () => {
  const raised = outsideChange(none, 'Their version.\n')
  expect(raised.notice).toEqual({ kind: 'changed', dirty: true, diskText: 'Their version.\n' })
  expect(raised.cancelAutosave).toBe(true)
  expect(mayWriteUnderDiskNotice(raised.notice)).toBe(false)
})

test('Keep mine writes as the answer to the notice on screen; once answered, the notice goes and saves write again', () => {
  const { notices, notice } = outsideChange(none, 'Their version.\n')
  expect(mayWriteUnderDiskNotice(notices.get(P), notice)).toBe(true)
  const answered = withoutNotice(notices, P)
  expect(answered.has(P)).toBe(false)
  expect(mayWriteUnderDiskNotice(answered.get(P))).toBe(true)
})

test('a rename moves the same notice object, so a Keep mine on it stays its answer, and leaves none behind', () => {
  const { notices, notice } = outsideChange(none, 'Their version.\n')
  const moved = movedNotice(notices, P, 'notes/b.md')
  expect(moved.get('notes/b.md')).toBe(notice!)
  expect(moved.has(P)).toBe(false)
  expect(mayWriteUnderDiskNotice(moved.get('notes/b.md'), notice)).toBe(true)
  expect(movedNotice(notices, 'notes/other.md', 'notes/c.md')).toBe(notices)
})

test('a second outside change after Keep mine is a new question; the same disk text again leaves the answered notice standing', () => {
  const first = outsideChange(none, 'Their version.\n')
  // The same version reported again (the watcher's echo): the notice clicked on stays, with its answer.
  const echo = outsideChange(first.notices, 'Their version.\n')
  expect(echo.notice).toBe(first.notice!)
  expect(mayWriteUnderDiskNotice(echo.notice, first.notice)).toBe(true)
  // Another program writes again: a new notice, which the earlier Keep mine does not answer.
  const second = outsideChange(first.notices, 'Their second version.\n')
  expect(second.notice).not.toBe(first.notice!)
  expect(mayWriteUnderDiskNotice(second.notice, first.notice)).toBe(false)
  // After the first was answered and cleared, the next change raises again too.
  const afterAnswer = outsideChange(withoutNotice(first.notices, P), 'Their second version.\n')
  expect(mayWriteUnderDiskNotice(afterAnswer.notice)).toBe(false)
})

test('cancelling Merge leaves the notice and the refused save; a newer notice makes the open sheet stale', () => {
  const { notices, notice } = outsideChange(none, 'Their version.\n')
  const session = { path: P, notice } as DiskMergeSession
  expect(mergeSheetVerdict({ session, overlayActive: 'diskMerge', active: P, notices })).toBe('stays')
  // Cancel closes the sheet and writes nothing: the notices are untouched.
  expect(notices.get(P)).toBe(notice!)
  expect(mayWriteUnderDiskNotice(notices.get(P))).toBe(false)
  expect(mergeSheetVerdict({ session, overlayActive: 'diskMerge', active: P, notices: outsideChange(notices, 'Newer.\n').notices })).toBe('stale')
  expect(mergeSheetVerdict({ session, overlayActive: 'commands', active: P, notices })).toBe('replaced')
  expect(mergeSheetVerdict({ session, overlayActive: 'diskMerge', active: 'notes/b.md', notices })).toBe('left')
})

test('a removed file is a question even over a saved buffer, raised again when unsaved text appears; clean outcomes clear', () => {
  const removed = stepForOutside(undefined, { kind: 'removed', dirty: false })!
  expect(removed.notice).toEqual({ kind: 'removed', dirty: false, diskText: null })
  expect(mayWriteUnderDiskNotice(removed.notice as ExternalDiskNotice)).toBe(false)
  expect(stepForOutside(removed.notice as ExternalDiskNotice, { kind: 'removed', dirty: false })!.notice).toBe('keep')
  expect(stepForOutside(removed.notice as ExternalDiskNotice, { kind: 'removed', dirty: true })!.notice).toEqual({ kind: 'removed', dirty: true, diskText: null })
  for (const kind of ['none', 'adopted'] as const) expect(stepForOutside(undefined, { kind })).toEqual({ notice: 'clear', cancelAutosave: false, replaced: false })
  expect(stepForOutside(undefined, { kind: 'replaced', diskText: 'x' })).toEqual({ notice: 'clear', cancelAutosave: false, replaced: true })
  expect(stepForOutside(undefined, { kind: 'skipped' })).toBeNull()
})

test('a notice whose path is neither open nor listed is stale', () => {
  const notices = withNotice(withNotice(withNotice(none, 'open.md', { kind: 'removed', dirty: true, diskText: null }), 'listed.md', { kind: 'changed', dirty: true, diskText: '' }), 'gone.md', { kind: 'removed', dirty: false, diskText: null })
  expect(stalePaths(notices, ['open.md'], new Set(['listed.md']))).toEqual(['gone.md'])
})
