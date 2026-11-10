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
import { isWholeParagraphSpan, placeRecordedReplacement, stagedContextAround, stagedInsertUnplaced } from '../../src/main/recorded-placement'
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

// ---- A suggestion staged from a co-author's revision (Folio versions ticket 15, Codex review of PR 224) --------------------------------------

const marker = { revisionId: 'fv_abc', reviewer: 'Sam Rowe', section: 0, heading: 'Findings', tracked: 1, file: 'abcdef012345' }
const PARA = 'The pilot found small gains.'
const DOC = `# Findings\n\nOpening paragraph.\n\n${PARA}\n\nClosing paragraph.\n`
function staged(doc: string, extra: object = {}): Change {
  const from = doc.indexOf(PARA)
  const context = stagedContextAround(doc, from, from + PARA.length)
  return { ...base, outsideSource: undefined, oldText: PARA, newText: 'The pilot found large gains.', anchor: { from, to: from + PARA.length }, folioRevision: marker, ...(context ? { anchorContext: context } : {}), ...extra } as unknown as Change
}

test('a staged suggestion is placed as its whole paragraph with its neighbours, wherever the paragraph has moved to', () => {
  const change = staged(DOC)
  const at = DOC.indexOf(PARA)
  expect(placeRecordedReplacement(DOC, change)).toEqual({ from: at, to: at + PARA.length })
  const moved = `New first paragraph.\n\n${DOC}`
  expect(placeRecordedReplacement(moved, change)).toEqual({ from: moved.indexOf(PARA), to: moved.indexOf(PARA) + PARA.length })
  expect(unplaceableIn(change, moved)).toBeNull()
})

test('a staged suggestion is never placed at the same words standing once elsewhere (the quotation, the pasted copy, the longer paragraph)', () => {
  const change = staged(DOC)
  for (const doc of [
    `# Findings\n\nOpening paragraph.\n\nThe writer rewrote this.\n\nClosing paragraph.\n\n> ${PARA}\n`,
    `${PARA}\n\n# Findings\n\nOpening paragraph.\n\nThe writer rewrote this.\n\nClosing paragraph.\n`,
    `# Findings\n\nOpening paragraph.\n\n${PARA} And the writer went on.\n\nClosing paragraph.\n`,
    'Something else entirely.\n',
  ]) {
    expect(placeRecordedReplacement(doc, change), doc).toMatchObject({ code: 'target-gone' })
    expect(unplaceableIn(change, doc), doc).toMatchObject({ code: 'target-gone' })
  }
})

test('the same fallback still places every other kind of proposal: a reader\'s edit and a record with no kept words are placed by their text standing once', () => {
  const doc = `Opening.\n\n${PARA}\n`
  const plain = { ...base, outsideSource: undefined, oldText: PARA, newText: 'X.', anchor: { from: 0, to: 0 } } as unknown as Change
  expect(placeRecordedReplacement(doc, plain)).toEqual({ from: doc.indexOf(PARA), to: doc.indexOf(PARA) + PARA.length })
  // The same record carrying the staged marker is refused: that fallback is not its rule.
  expect(placeRecordedReplacement(doc, { ...plain, folioRevision: marker } as unknown as Change)).toMatchObject({ code: 'target-gone' })
})

test('a staged paragraph is refused, not guessed, when it and its neighbours stand twice', () => {
  const change = staged(DOC)
  // Still at the very span it was recorded at, with the same neighbours: that is where it was made, even though a copy follows.
  expect(placeRecordedReplacement(`${DOC}\n${DOC}`, change)).toEqual({ from: DOC.indexOf(PARA), to: DOC.indexOf(PARA) + PARA.length })
  // Moved, and now standing twice with the same neighbours: no one place.
  expect(placeRecordedReplacement(`Preface.\n\n${DOC}\n${DOC}`, change)).toMatchObject({ code: 'target-repeated' })
})

test('a staged insertion needs its anchor paragraph whole, once, with the paragraph recorded after it', () => {
  const anchor = 'Opening paragraph.'
  const from = DOC.indexOf(anchor)
  const context = stagedContextAround(DOC, from, from + anchor.length, { before: false })
  const insert = { ...base, outsideSource: undefined, editClass: 'insert', oldText: '', newText: 'Her new paragraph.', insertAfter: anchor, folioRevision: marker, ...(context ? { anchorContext: context } : {}) } as unknown as Change
  expect(stagedInsertUnplaced(DOC, insert)).toBeNull()
  expect(unplaceableIn(insert, DOC)).toBeNull()
  expect(unplaceableIn(insert, `Preface.\n\n${DOC}`)).toBeNull()
  expect(unplaceableIn(insert, DOC.replace(anchor, `> ${anchor}`))).toMatchObject({ code: 'target-gone' })
  expect(unplaceableIn(insert, DOC.replace(anchor, `${anchor} Longer now.`))).toMatchObject({ code: 'target-gone' })
  expect(unplaceableIn(insert, DOC.replace('The pilot found', 'Something else found').replace(PARA, 'Something else found small gains.'))).toMatchObject({ code: 'target-gone' })
})

test('what a whole paragraph is', () => {
  const doc = 'One.\n\nTwo lines\nof text.\n\n> quoted\n'
  expect(isWholeParagraphSpan(doc, 0, 4)).toBe(true)
  expect(isWholeParagraphSpan(doc, doc.indexOf('Two'), doc.indexOf('text.') + 5)).toBe(true)
  expect(isWholeParagraphSpan(doc, doc.indexOf('Two'), doc.indexOf('Two') + 3)).toBe(false)
  expect(isWholeParagraphSpan(doc, doc.indexOf('of text.'), doc.indexOf('text.') + 5)).toBe(false)
  expect(isWholeParagraphSpan(doc, doc.indexOf('quoted'), doc.indexOf('quoted') + 6)).toBe(false)
  // A removal takes the blank line after the paragraph with it and is still whole.
  expect(isWholeParagraphSpan(doc, 0, 6)).toBe(true)
})
