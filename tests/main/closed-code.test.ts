/**
 * Every place that closes a Change records why as a code from one closed list (`closedCode`, beside
 * `closedReason`). Seams: the Change store's closing doors, the ingest of outside requests, and the
 * Workspace agent's accept. The dock's sentences are not here: the interface chooses them from the code.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceAgent } from '../../src/main/agent'
import { CLOSED_CODES, ChangeStore, bornClosed, changeJournalPath, closedCodeOf, closedReasonOf, parseChangeLine, type Change, type NewChange } from '../../src/main/changes'
import { newRequestId, type WriteRequest } from '../../src/main/cli/request-format'
import { guardedReadSeams } from '../../src/main/guarded-document-read'
import { addOutsideRequests } from '../../src/main/outside-change-ingest'
import { Workspace } from '../../src/main/workspace'
import { plantChangeAt } from '../helpers/plant-change-path'

let root: string
let appData: string
let workspace: Workspace
let changes: ChangeStore
let agent: WorkspaceAgent | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-code-root-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-code-data-'))
  workspace = new Workspace(root)
  changes = new ChangeStore(workspace)
  agent = undefined
})
afterEach(async () => {
  delete guardedReadSeams.beforeOpen
  agent?.dispose()
  for (const dir of [root, appData]) await rm(dir, { recursive: true, force: true })
})

const DOC = '# Draft\n\nOne sentence.\n\nA repeated line.\n\nA repeated line.\n'
const edit = (over: Partial<NewChange> = {}): NewChange => ({
  path: 'a.md', provenance: 'agent', editClass: 'content', category: 'wording', summary: 'Tighten.', oldText: 'One sentence.', newText: 'One.', isCorrection: false, ...over,
})
const journal = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(root, changeJournalPath()), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
const makeAgent = async (): Promise<WorkspaceAgent> => {
  agent = await WorkspaceAgent.create({ mode: 'work', workspace, appDataDir: appData, changes, onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {} })
  return agent
}
async function file(...requests: Array<[string, Record<string, unknown>]>): Promise<Change[]> {
  const outcomes = await addOutsideRequests({
    requests: requests.map(([operation, args]) => {
      const id = newRequestId()
      return { id, request: { version: 1, id, operation, args } as WriteRequest }
    }),
    workspace, changes, now: () => new Date(),
  })
  const all = await changes.list()
  return outcomes.map((outcome) => all.find((change) => (change as { outsideRequest?: { id: string } }).outsideRequest?.id === outcome.id)!)
}

test('the list is closed and defined once; a record with no code, or one this build does not know, reads as other', async () => {
  expect([...CLOSED_CODES]).toEqual(['target-gone', 'target-repeated', 'file-missing', 'not-a-document', 'document-changed', 'superseded', 'unreadable', 'other'])
  expect(closedCodeOf({ closedReason: 'a.md no longer exists.' })).toBe('other')
  for (const odd of [undefined, null, 7, 'target-gone', { closedCode: 7 }, { closedCode: 'made-up' }, { closedCode: '__proto__' }]) expect(closedCodeOf(odd)).toBe('other')
  expect(closedCodeOf({ closedCode: 'file-missing' })).toBe('file-missing')
  // The bridge's Change carries the field with the shared type (fails typecheck otherwise).
  type Bridge = NonNullable<import('../../src/preload').Change['closedCode']>
  const same: [Bridge] extends [import('../../src/shared/closed-code').ClosedCode] ? ([import('../../src/shared/closed-code').ClosedCode] extends [Bridge] ? true : never) : never = true
  expect(same).toBe(true)
  // The main process does not spell the list out again.
  expect((await import('../../src/main/changes')).CLOSED_CODES).toBe((await import('../../src/shared/closed-code')).CLOSED_CODES)
})

test('the store keeps the code beside the reason, the ledger parser passes it through, and reopening removes both', async () => {
  await writeFile(join(root, 'a.md'), DOC)
  const [one, two, three] = [await changes.add(edit()), await changes.add(edit()), await changes.add(edit())]
  const closed = await changes.close(one.id, 'a.md no longer exists.', 'file-missing')
  expect([closedReasonOf(closed), closedCodeOf(closed)]).toEqual(['a.md no longer exists.', 'file-missing'])
  expect((await changes.closeMany([{ id: two.id, reason: 'Accepted first.', code: 'superseded' }])).map(closedCodeOf)).toEqual(['superseded'])
  // A caller that gives no code records "other", never nothing.
  expect(closedCodeOf(await changes.close(three.id, 'Some other reason.'))).toBe('other')

  const lines = await journal()
  expect(lines.map((line) => line.closedCode)).toEqual(['file-missing', 'superseded', 'other'])
  // A fresh store reads what was written: the parser keeps a field it does not name.
  const reread = await new ChangeStore(new Workspace(root)).list()
  expect(reread.map(closedCodeOf)).toEqual(['file-missing', 'superseded', 'other'])
  expect(parseChangeLine(JSON.stringify({ ...lines[0], whole: true }))).toMatchObject({ closedCode: 'file-missing', whole: true })

  const reopened = await changes.setReviewStatus(one.id, 'pending')
  expect([closedReasonOf(reopened), (reopened as { closedCode?: unknown }).closedCode]).toEqual([null, undefined])
  expect((await journal())[0]).not.toHaveProperty('closedCode')

  // A record closed before the code existed has none, and reads as other.
  const old = { ...lines[1] }
  delete old.closedCode
  expect(closedCodeOf(parseChangeLine(JSON.stringify(old)))).toBe('other')
  expect(closedReasonOf(parseChangeLine(JSON.stringify(old))!)).toBe('Accepted first.')
})

test('the store\'s path rule closes with not-a-document; a refused request\'s record keeps the code it was born with when it is closed again', async () => {
  await mkdir(join(root, '.writeflex'), { recursive: true })
  // Refused at add; planted in the journal, as a hand edit would.
  const hidden = await plantChangeAt(root, changes, edit(), '.writeflex/changes.jsonl')
  const moved = await changes.setReviewStatus(hidden.id, 'held')
  expect(moved.status).toBe('rejected')
  expect(closedCodeOf(moved)).toBe('not-a-document')

  const born = await changes.add(bornClosed({ ...edit({ oldText: '', newText: '' }), outsideSource: 'codex', outsideRefused: true } as NewChange, 'The text to replace was not found in a.md.', 'target-gone', 5))
  expect([born.status, closedCodeOf(born), (born as { closedAt?: number }).closedAt]).toEqual(['rejected', 'target-gone', 5])
  const again = await changes.setReviewStatus(born.id, 'pending')
  expect([again.status, closedReasonOf(again), closedCodeOf(again)]).toEqual(['rejected', 'The text to replace was not found in a.md.', 'target-gone'])
})

test('a request refused when it is added is born closed with the code for its reason', async () => {
  await writeFile(join(root, 'a.md'), DOC)
  await mkdir(join(root, 'folder.md'))
  await symlink(join(root, 'a.md'), join(root, 'link.md'))
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['replace', { path: 'a.md', target: 'Not in the document.', with: 'x' }, 'target-gone'],
    ['replace', { path: 'a.md', target: 'A repeated line.', with: 'x' }, 'target-repeated'],
    ['insert', { path: 'a.md', text: 'x', after: 'Not in the document.' }, 'target-gone'],
    ['insert', { path: 'a.md', text: 'x', after: 'A repeated line.' }, 'target-repeated'],
    ['move-text', { path: 'a.md', text: 'Not in the document.', after: 'One sentence.' }, 'target-gone'],
    ['tick', { path: 'a.md', line: 3 }, 'target-gone'],
    ['replace', { path: 'gone.md', target: 'a', with: 'b' }, 'file-missing'],
    ['replace', { path: '.writeflex/changes.jsonl', target: 'a', with: 'b' }, 'not-a-document'],
    ['replace', { path: '../elsewhere.md', target: 'a', with: 'b' }, 'not-a-document'],
    ['replace', { path: 'folder.md', target: 'a', with: 'b' }, 'not-a-document'],
    ['replace', { path: 'link.md', target: 'One sentence.', with: 'b' }, 'not-a-document'],
    ['replace', { path: 'notes.txt', target: 'a', with: 'b' }, 'not-a-document'],
    ['replace', { path: 'a.md', target: 'One sentence.', with: 'One sentence.' }, 'other'],
    ['restore-version', { path: 'a.md', version: 'v_none' }, 'other'],
  ]
  const closed = await file(...cases.map(([operation, args]): [string, Record<string, unknown>] => [operation, args]))
  expect(closed.map((change) => change.status)).toEqual(cases.map(() => 'rejected'))
  expect(closed.map((change, index) => `${cases[index][0]} ${String(cases[index][1].path)}: ${closedCodeOf(change)}`))
    .toEqual(cases.map(([operation, args, code]) => `${operation} ${String(args.path)}: ${code}`))
  for (const change of closed) expect(closedReasonOf(change)).not.toBeNull()
})

test('accept closes with the code for what it found: the file gone, not a document, unreadable (the text gone or repeated waits)', async () => {
  const live = await makeAgent()
  const closeBy = async (prepare: () => Promise<void>, over: Partial<NewChange> = {}): Promise<Change> => {
    await rm(join(root, 'a.md'), { recursive: true, force: true })
    await writeFile(join(root, 'a.md'), DOC)
    const change = await changes.add(edit(over))
    await prepare()
    expect(await live.resolveChange(change.id, 'accept')).toMatchObject({ applied: false, closed: true })
    return (await changes.get(change.id))!
  }
  // An Accept whose text is gone or has no one place decides nothing; the Change waits, unclosed.
  const waitsBy = async (prepare: () => Promise<void>, over: Partial<NewChange> = {}): Promise<void> => {
    await rm(join(root, 'a.md'), { recursive: true, force: true })
    await writeFile(join(root, 'a.md'), DOC)
    const change = await changes.add(edit(over))
    await prepare()
    const result = await live.resolveChange(change.id, 'accept')
    expect(result.applied).toBe(false)
    expect(result.closed).toBeUndefined()
    const after = (await changes.get(change.id))!
    expect(after.status).toBe('pending')
    expect(closedReasonOf(after)).toBeNull()
  }
  await waitsBy(() => writeFile(join(root, 'a.md'), '# Draft\n\nRewritten.\n'))
  await waitsBy(async () => {}, { oldText: 'A repeated line.' })
  await waitsBy(async () => {}, { editClass: 'insert', oldText: '', newText: 'New.', insertAfter: 'Not there.' })
  expect(closedCodeOf(await closeBy(() => unlink(join(root, 'a.md'))))).toBe('file-missing')
  expect(closedCodeOf(await closeBy(async () => { await unlink(join(root, 'a.md')); await mkdir(join(root, 'a.md')) }))).toBe('not-a-document')
  expect(closedCodeOf(await closeBy(async () => { await unlink(join(root, 'a.md')); await writeFile(join(root, 'real.md'), DOC); await symlink(join(root, 'real.md'), join(root, 'a.md')) }))).toBe('not-a-document')
  expect(closedCodeOf(await closeBy(async () => {
    guardedReadSeams.beforeOpen = async () => { delete guardedReadSeams.beforeOpen; throw Object.assign(new Error('EIO: i/o error, open a.md'), { code: 'EIO' }) }
  }))).toBe('unreadable')
  // Not a document path at all: closed before anything is read. (A path in a dot-folder cannot be recorded
  // and is refused at accept without closing; a folder that links into one is recorded and closed.)
  await mkdir(join(root, '.writeflex'), { recursive: true })
  await symlink(join(root, '.writeflex'), join(root, 'notes'))
  const hidden = await changes.add(edit({ path: 'notes/changes.jsonl' }))
  expect(await live.resolveChange(hidden.id, 'accept')).toMatchObject({ applied: false, closed: true })
  expect(closedCodeOf((await changes.get(hidden.id))!)).toBe('not-a-document')
})
