/**
 * Ticket 14, fix round 1: the placement of a recorded replacement is ONE judgement, asked by Accept
 * (`placeRecordedReplacement`) and by the sweep after another Accept (`unplaceableIn`), and the words kept
 * around a shortened record (`anchorContext`) count toward the ledger's size limits.
 */
import { test, expect, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChangeStore, type Change, type NewChange } from '../../src/main/changes'
import { unplaceableIn } from '../../src/main/outside-change'
import { placeRecordedReplacement } from '../../src/main/recorded-placement'
import { Workspace } from '../../src/main/workspace'

const roots: string[] = []
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }) })

const base = { id: 'c_1', ts: 1, provenance: 'agent', category: 'other', summary: '', status: 'pending', isCorrection: false, path: 'a.md', editClass: 'content', outsideSource: 'reader' } as const

test('the sweep never closes a replacement Accept would place: its words repeated after its place, its span still holding them', () => {
  const doc = 'A list owes its reader a reason for each entry.\n'
  const at = doc.indexOf('a reason')
  const reader = { ...base, oldText: 'a reason', newText: 'a one-line reason', anchor: { from: at, to: at + 8 } } as unknown as Change
  // Another Accept added the same words after it: the text stands twice, its span still holds it.
  const after = `${doc}Give a reason for the order too.\n`
  expect(placeRecordedReplacement(after, reader)).toEqual({ from: at, to: at + 8 })
  expect(unplaceableIn(reader, after)).toBeNull()
  // Moved by the other Accept (its span no longer holds it) and standing twice: both refuse it, alike.
  const shifted = `Preface.\n${after}`
  expect(placeRecordedReplacement(shifted, reader)).toMatchObject({ code: 'target-repeated' })
  expect(unplaceableIn(reader, shifted)).toMatchObject({ code: 'target-repeated' })
})

test('the sweep judges a shortened record by its kept words, as Accept does', () => {
  const doc = '# Why reading matters\n\nMost reading lists are too long.\n'
  const at = doc.indexOf('reading lists')
  const shortened = { ...base, oldText: 'reading ', newText: '', anchor: { from: at, to: at + 8 }, anchorContext: { before: 'Most ', after: 'lists' } } as unknown as Change
  const moved = `Preface.\n\n${doc}`
  expect(placeRecordedReplacement(moved, shortened)).toEqual({ from: at + 10, to: at + 18 })
  expect(unplaceableIn(shortened, moved)).toBeNull()
  // The place is gone, though the bare words stand once (in the title): both refuse it.
  const byHand = '# Why reading matters\n\nMost lists are too long.\n'
  expect(placeRecordedReplacement(byHand, shortened)).toMatchObject({ code: 'target-gone' })
  expect(unplaceableIn(shortened, byHand)).toMatchObject({ code: 'target-gone' })
})

test('the words kept around a record count toward the undecided-bytes limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-placement-'))
  roots.push(root)
  const changes = new ChangeStore(new Workspace(root))
  const record = (requestId: string, extra: object): { requestId: string; changes: NewChange[] } => ({
    requestId,
    changes: [{ path: 'a.md', provenance: 'agent', editClass: 'content', summary: 's', oldText: 'ab', newText: 'cd', isCorrection: false, outsideSource: 'codex', outsideRequest: { id: requestId, index: 1, count: 1, at: 1 }, ...extra } as NewChange],
  })
  const limits = { maxUndecided: 10, maxUndecidedBytes: 10, maxRefused: 10, maxPerSource: 10, maxPerRequest: 20 }
  // 4 bytes of text fit in 10; with 8 more kept around it, the same record does not.
  const [plain] = await changes.addOutside([record('r-plain', {})], limits)
  expect(plain.outcome).toBe('added')
  const [kept] = await changes.addOutside([record('r-kept', { anchorContext: { before: 'Most', after: 'list' } })], limits)
  expect(kept.outcome).toBe('full')
})

test('a legacy addition with no recorded context says so, not that the words around it changed (ticket 06, P2 of 14 review round 2)', () => {
  const legacy = { ...base, outsideSource: undefined, oldText: '', newText: 'New words.', anchor: { from: 3, to: 3 } } as unknown as Change
  const result = placeRecordedReplacement('Some text here.\n', legacy)
  expect(result).toMatchObject({ code: 'target-gone' })
  const reason = (result as { reason: string }).reason
  expect(reason).toContain('kept no words around its place')
  expect(reason).not.toContain('The words around this change are no longer')
})
