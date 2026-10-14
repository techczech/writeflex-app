import { expect, test } from 'bun:test'
import { diskNoticeRefusalMessage, externalContentReconcileAction, mayWriteUnderDiskNotice, minimalReplace, reconcileReplace, type ExternalDiskNotice } from '../../src/renderer/src/editor/reconcile'
import { deriveCleanWriterDocument, type WriterPendingChange } from '../../src/renderer/src/editor/writer-review'

test('minimalReplace trims the common prefix and suffix', () => {
  expect(minimalReplace('The old draft.', 'The new draft.')).toEqual({ from: 4, to: 7, insert: 'new' })
  expect(minimalReplace('abc', 'abc')).toBeNull()
  expect(minimalReplace('abc', 'abXc')).toEqual({ from: 2, to: 2, insert: 'X' })
  expect(minimalReplace('abXc', 'abc')).toEqual({ from: 2, to: 3, insert: '' })
  expect(minimalReplace('', 'hello')).toEqual({ from: 0, to: 0, insert: 'hello' })
})

test('byte-identical disk content is a no-op even when the saved baseline is stale', () => {
  expect(externalContentReconcileAction({
    buffer: 'The current draft.',
    baseline: 'The older baseline.',
    disk: 'The current draft.',
  })).toBe('none')
})

test('a disk read that differs from the buffer only in line endings or BOM is a no-op (bug 01)', () => {
  expect(externalContentReconcileAction({ buffer: 'a\nb\n', baseline: 'a\nb\n', disk: 'a\r\nb\r\n' })).toBe('none')
  expect(externalContentReconcileAction({ buffer: 'a\nb EDIT\n', baseline: 'a\nb\n', disk: 'a\r\nb\r\n' })).toBe('none')
  expect(externalContentReconcileAction({ buffer: 'a\nb EDIT\n', baseline: 'a\nb\n', disk: 'a\r\nc\r\n' })).toBe('conflict')
})

const change = (from: number, to: number, oldText: string, newText: string): WriterPendingChange => ({
  localId: `wr_${from}`,
  oldText,
  newText,
  anchor: { from, to },
  createdAt: 1,
})

/** Apply a raw-coordinate replace and confirm the buffer now derives to `next` with `survivors` intact. */
function applyAndCheck(
  raw: string,
  changes: WriterPendingChange[],
  next: string,
): { newRaw: string; spec: ReturnType<typeof reconcileReplace> } {
  const clean = deriveCleanWriterDocument(raw, changes)
  const spec = reconcileReplace(changes, clean, next)
  if (!spec) return { newRaw: raw, spec }
  const newRaw = raw.slice(0, spec.from) + spec.insert + raw.slice(spec.to)
  return { newRaw, spec }
}

test('identity when disk matches the derived text', () => {
  const raw = 'The oldnew draft.'
  const changes = [change(4, 10, 'old', 'new')]
  expect(reconcileReplace(changes, deriveCleanWriterDocument(raw, changes), 'The new draft.')).toBeNull()
})

test('a disk edit AFTER a struck deletion leaves the strike in the raw buffer', () => {
  // raw keeps struck 'old ' (deletion pending); clean = "The draft. tail"; disk changed 'tail' → 'coda'.
  const raw = 'The old draft. tail'
  const changes = [change(4, 8, 'old ', '')]
  const clean = deriveCleanWriterDocument(raw, changes)
  expect(clean).toBe('The draft. tail')
  const { newRaw } = applyAndCheck(raw, changes, 'The draft. coda')
  expect(newRaw).toBe('The old draft. coda') // strike survives; only the tail moved
})

test('a disk edit BEFORE a pending insertion leaves the insertion tracked', () => {
  // raw == clean here (pure insertion keeps its text in both): 'brand ' inserted at 4.
  const raw = 'The brand draft ends.'
  const changes = [change(4, 10, '', 'brand ')]
  const clean = deriveCleanWriterDocument(raw, changes)
  expect(clean).toBe(raw)
  const { newRaw, spec } = applyAndCheck(raw, changes, 'The brand draft stops.')
  expect(newRaw).toBe('The brand draft stops.')
  // The replacement window sits entirely after the insertion span (marks map through unharmed).
  expect(spec!.from).toBeGreaterThanOrEqual(10)
})

test('a disk edit at the very boundary of a strike steps over it', () => {
  // Strike right where the disk edit begins: prefix trim stops at the strike's clean position.
  const raw = 'AB XX tail.'.replace('XX ', 'XX ') // raw: 'AB XX tail.' with 'XX ' struck at 3..6
  const changes = [change(3, 6, 'XX ', '')]
  const clean = deriveCleanWriterDocument(raw, changes)
  expect(clean).toBe('AB tail.')
  const { newRaw } = applyAndCheck(raw, changes, 'AB coda.')
  expect(newRaw).toBe('AB XX coda.') // strike survives, tail replaced
})

test('a disk edit INSIDE a pending replacement folds that change, not the document', () => {
  // raw 'The oldnew draft.' — replacement pending (old struck, new inserted). Disk rewrote 'new' → 'big'.
  const raw = 'The oldnew draft.'
  const changes = [change(4, 10, 'old', 'new')]
  const clean = deriveCleanWriterDocument(raw, changes)
  expect(clean).toBe('The new draft.')
  const { newRaw } = applyAndCheck(raw, changes, 'The big draft.')
  // The whole span folds to the disk text — degraded but local; the rest of the document is untouched.
  expect(newRaw).toBe('The big draft.')
})

test('a buffer under an unanswered changed-on-disk notice is written only by the answer to that notice', () => {
  const conflict: ExternalDiskNotice = { kind: 'changed', dirty: true }
  expect(mayWriteUnderDiskNotice(undefined)).toBe(true) // no notice: saves run as ever
  expect(mayWriteUnderDiskNotice(conflict)).toBe(false) // auto-save, close, the Save command
  expect(mayWriteUnderDiskNotice(conflict, conflict)).toBe(true) // Keep mine, for this notice
  // A notice raised since (a later outside change) is not the one that was answered.
  expect(mayWriteUnderDiskNotice({ kind: 'changed', dirty: true }, conflict)).toBe(false)
  // The disk could not be read under unsaved text: the same rule.
  expect(mayWriteUnderDiskNotice({ kind: 'removed', dirty: true })).toBe(false)
  // Raised over a buffer with nothing unsaved: there was no second version to choose between.
  expect(mayWriteUnderDiskNotice({ kind: 'removed', dirty: false })).toBe(true)
  // An answer with no notice standing (it was cleared meanwhile) writes like any save.
  expect(mayWriteUnderDiskNotice(undefined, conflict)).toBe(true)
})

test('the refusal names the file and the two choices', () => {
  expect(diskNoticeRefusalMessage('guide/_guide_INDEX.md', { kind: 'changed', dirty: true }))
    .toBe('_guide_INDEX.md changed on disk. Choose Reload or Keep mine above the text; nothing was saved.')
  expect(diskNoticeRefusalMessage('note.md', { kind: 'removed', dirty: true })).toContain('no longer readable on disk')
})
