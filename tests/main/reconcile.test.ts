import { expect, test } from 'bun:test'
import { closeRefusalMessage, diskNoticeRefusalMessage, externalContentReconcileAction, mayWriteUnderDiskNotice, keepMineWrites, minimalReplace, noticeAfterRefusal, noticeForRefusedSave, reconcileReplace, sameDiskNotice, saveBasisFor, type ExternalDiskNotice } from '../../src/renderer/src/editor/reconcile'
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
  const conflict: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: 'Outside.\n' }
  expect(mayWriteUnderDiskNotice(undefined)).toBe(true) // no notice: saves run as ever
  expect(mayWriteUnderDiskNotice(conflict)).toBe(false) // auto-save, close, the Save command
  expect(mayWriteUnderDiskNotice(conflict, conflict)).toBe(true) // Keep mine, for this notice
  // A notice raised since (a later outside change) is not the one that was answered.
  expect(mayWriteUnderDiskNotice({ kind: 'changed', dirty: true, diskText: 'Outside.\n' }, conflict)).toBe(false)
  // The disk could not be read under unsaved text: the same rule.
  expect(mayWriteUnderDiskNotice({ kind: 'removed', dirty: true, diskText: null })).toBe(false)
  // A file removed under a buffer with nothing unsaved: no automatic write recreates it either (item 4);
  // Keep mine on that very notice does.
  const removed: ExternalDiskNotice = { kind: 'removed', dirty: false, diskText: null }
  expect(mayWriteUnderDiskNotice(removed)).toBe(false)
  expect(mayWriteUnderDiskNotice(removed, removed)).toBe(true)
  // An answer with no notice standing (it was cleared meanwhile) writes like any save.
  expect(mayWriteUnderDiskNotice(undefined, conflict)).toBe(true)
})

test('the refusal names the file and the two choices', () => {
  expect(diskNoticeRefusalMessage('guide/_guide_INDEX.md', { kind: 'changed', dirty: true, diskText: 'x' }))
    .toBe('_guide_INDEX.md changed on disk. Choose Reload or Keep mine above the text; nothing was saved.')
  expect(diskNoticeRefusalMessage('note.md', { kind: 'removed', dirty: true, diskText: null })).toContain('no longer readable on disk')
  expect(diskNoticeRefusalMessage('note.md', { kind: 'changed', dirty: true, diskText: 'y', again: true }))
    .toBe('note.md changed on disk again after the banner was shown. The banner now shows the newer version; nothing was saved.')
})

test('a write carries its baseline; Keep mine carries the disk text of the notice it answers', () => {
  const notice: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: 'Outside.\n' }
  expect(saveBasisFor('Seen.\n')).toEqual({ kind: 'disk', text: 'Seen.\n' })
  expect(saveBasisFor(undefined)).toEqual({ kind: 'new' }) // never read from disk
  // Under a notice, an ordinary write still carries the baseline (main refuses it over the outside version).
  expect(saveBasisFor('Seen.\n', notice)).toEqual({ kind: 'disk', text: 'Seen.\n' })
  expect(saveBasisFor('Seen.\n', notice, notice)).toEqual({ kind: 'keep-mine', text: 'Outside.\n' })
  // An answer to a notice that has since been replaced is not Keep mine to the one standing.
  expect(saveBasisFor('Seen.\n', { ...notice, diskText: 'Newer.\n' }, notice)).toEqual({ kind: 'disk', text: 'Seen.\n' })
  // Keep mine on a removed file recreates it: the file must still be absent (or empty).
  const removed: ExternalDiskNotice = { kind: 'removed', dirty: false, diskText: null }
  expect(saveBasisFor('Seen.\n', removed, removed)).toEqual({ kind: 'new' })
})

test('a save main refused becomes the changed-on-disk notice for the disk text it found', () => {
  expect(noticeForRefusedSave('Outside.\n')).toEqual({ kind: 'changed', dirty: true, diskText: 'Outside.\n' })
  expect(noticeForRefusedSave(null)).toEqual({ kind: 'removed', dirty: true, diskText: null })
  // Refused while answering a banner with Keep mine: the new notice says the disk moved again.
  const answered: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: 'Outside.\n' }
  expect(noticeForRefusedSave('Newer.\n', answered)).toEqual({ kind: 'changed', dirty: true, diskText: 'Newer.\n', again: true })
})

test('a fresh read of the version a standing notice shows does not replace that notice', () => {
  const notice: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: 'Outside.\r\n' }
  expect(sameDiskNotice(notice, 'changed', 'Outside.\r\n')).toBe(true)
  // Byte for byte (Sol M3): Keep mine is a choice against exactly the text the notice carries, so a
  // line-ending change since is a new version and a new notice.
  expect(sameDiskNotice(notice, 'changed', 'Outside.\n')).toBe(false)
  expect(sameDiskNotice(notice, 'changed', 'Newer.\n')).toBe(false)
  expect(sameDiskNotice(notice, 'removed', null)).toBe(false)
  expect(sameDiskNotice(undefined, 'changed', 'Outside.\n')).toBe(false)
  expect(sameDiskNotice({ kind: 'removed', dirty: false, diskText: null }, 'removed', null)).toBe(true)
})

test('a closing window names every refused path with its own reason; one path\'s reason does not hide another', () => {
  const reason = 'a.md changed on disk. Choose Reload or Keep mine above the text; nothing was saved.'
  expect(closeRefusalMessage([{ path: 'b.md' }])).toBe('Could not save 1 document — the window stays open')
  expect(closeRefusalMessage([{ path: 'a.md', reason }])).toBe(`${reason} The window stays open.`)
  expect(closeRefusalMessage([{ path: 'a.md', reason }, { path: 'b.md' }, { path: 'c.md' }]))
    .toBe(`${reason} Could not save 2 documents — the window stays open`)
  const other = 'c.md changed on disk. Choose Reload or Keep mine above the text; nothing was saved.'
  expect(closeRefusalMessage([{ path: 'a.md', reason }, { path: 'c.md', reason: other }])).toBe(`${reason} ${other} The window stays open.`)
})

test('with the baseline\'s disk bytes known, a form-only outside change is adopted by a clean buffer and asked about over unsaved text (Sol M3)', () => {
  const baselineDisk = 'a\nb\n'
  expect(externalContentReconcileAction({ buffer: 'a\nb\n', baseline: 'a\nb\n', baselineDisk, disk: 'a\nb\n' })).toBe('none')
  expect(externalContentReconcileAction({ buffer: 'a\nb\n', baseline: 'a\nb\n', baselineDisk, disk: 'a\r\nb\r\n' })).toBe('adopt')
  expect(externalContentReconcileAction({ buffer: 'a\nb EDIT\n', baseline: 'a\nb\n', baselineDisk, disk: 'a\r\nb\r\n' })).toBe('conflict')
  expect(externalContentReconcileAction({ buffer: 'a\nb EDIT\n', baseline: 'a\nb\n', baselineDisk, disk: '\uFEFFa\nb\n' })).toBe('conflict')
  // The disk caught up with the buffer: its bytes are the basis now.
  expect(externalContentReconcileAction({ buffer: 'a\nc\n', baseline: 'a\nb\n', baselineDisk, disk: 'a\nc\n' })).toBe('adopt')
})

test('after a write of unknown outcome a buffer equal to its baseline is not clean: an outside version is asked about, never taken (Sol M2)', () => {
  const input = { buffer: 'A\n', baseline: 'A\n', baselineDisk: 'A\n', disk: 'B\n' }
  expect(externalContentReconcileAction(input)).toBe('replace')
  expect(externalContentReconcileAction({ ...input, diskUnknown: true })).toBe('conflict')
  // The disk holds the buffer's own document: nothing can be lost, its bytes become the basis.
  expect(externalContentReconcileAction({ ...input, disk: 'A\r\n', diskUnknown: true })).toBe('adopt')
})

test('main\'s refusal for the disk text a notice already shows keeps that notice, so a Keep mine queued on it stays its answer (Muse S2)', () => {
  const standing: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: 'X\n' }
  expect(noticeAfterRefusal(standing, 'X\n')).toBe(standing)
  expect(noticeAfterRefusal(standing, 'Y\n')).toEqual({ kind: 'changed', dirty: true, diskText: 'Y\n' })
  expect(noticeAfterRefusal(standing, 'X\r\n')).not.toBe(standing) // another version, byte for byte
  expect(noticeAfterRefusal(undefined, 'X\n')).toEqual({ kind: 'changed', dirty: true, diskText: 'X\n' })
  // A notice raised over a clean buffer is replaced by one that blocks writes.
  expect(noticeAfterRefusal({ kind: 'changed', dirty: false, diskText: 'X\n' }, 'X\n').dirty).toBe(true)
  // The refused write was Keep mine to the standing notice: the disk moved since, a new question.
  expect(noticeAfterRefusal(standing, 'Z\n', standing)).toEqual({ kind: 'changed', dirty: true, diskText: 'Z\n', again: true })
})

test('the basis is the baseline\'s disk bytes, or the exact text of the notice Keep mine answers', () => {
  const notice: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: 'X\r\n' }
  expect(saveBasisFor('A\r\n')).toEqual({ kind: 'disk', text: 'A\r\n' })
  expect(saveBasisFor('A\r\n', notice, notice)).toEqual({ kind: 'keep-mine', text: 'X\r\n' })
  expect(saveBasisFor(undefined)).toEqual({ kind: 'new' })
})

test('Keep mine writes whatever the dirty dot says; only a clean notice over a still-clean buffer is just dismissed (Sol S5)', () => {
  const changedOverUnsaved: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: 'X\n' }
  const changedOverClean: ExternalDiskNotice = { kind: 'changed', dirty: false, diskText: 'X\n' }
  const removed: ExternalDiskNotice = { kind: 'removed', dirty: false, diskText: null }
  // An undo cleared the dot after the notice was raised over unsaved text: the choice is still carried out.
  expect(keepMineWrites(changedOverUnsaved, false)).toBe(true)
  // A removed file is recreated by Keep mine, unsaved text or not.
  expect(keepMineWrites(removed, false)).toBe(true)
  // Raised over a clean buffer, typed into since: there is now something of the writer's to keep.
  expect(keepMineWrites(changedOverClean, true)).toBe(true)
  expect(keepMineWrites(changedOverClean, false)).toBe(false)
  expect(keepMineWrites(undefined, true)).toBe(false)
})
