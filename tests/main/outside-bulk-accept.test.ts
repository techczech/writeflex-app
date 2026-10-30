/**
 * Accept all / Decline all from one source, and changes to the metadata placed in the frontmatter only.
 * Seams: the Workspace agent's `acceptOutsideFromSource` (each change by the single Accept) and the ledger's
 * `rejectOutside({ source })`; Changes are added exactly as the app adds them (`addOutsideRequests`), except
 * the older whole-document metadata records, which are written as an older build filed them.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { WorkspaceAgent } from '../../src/main/agent'
import { ChangeStore, closedReasonOf, type Change } from '../../src/main/changes'
import { versionTextReader } from '../../src/main/cli/history-store'
import { newRequestId, type WriteRequest } from '../../src/main/cli/request-format'
import { addOutsideRequests, type IngestOutcome } from '../../src/main/outside-change-ingest'
import { asFrontmatterForWindow } from '../../src/main/frontmatter-change'
import { unplaceableIn } from '../../src/main/outside-change'
import { MAX_CHANGES_PER_REQUEST, MAX_NEW_TEXT_BYTES, MAX_UNDECIDED_PER_SOURCE, OUTSIDE_AUTHORS } from '../../src/main/cli/review-format'
import { Workspace } from '../../src/main/workspace'

let root: string
let appData: string
let workspace: Workspace
let changes: ChangeStore
let agent: WorkspaceAgent

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-bulk-root-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-bulk-data-'))
  workspace = new Workspace(root)
  changes = new ChangeStore(workspace)
  agent = await WorkspaceAgent.create({ mode: 'work',
    workspace, appDataDir: appData, changes,
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
  })
})
afterEach(async () => {
  agent.dispose()
  for (const dir of [root, appData]) await rm(dir, { recursive: true, force: true })
})

const write = async (rel: string, text: string): Promise<void> => {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), text)
}
const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')

async function file(...requests: Array<[string, Record<string, unknown>]>): Promise<IngestOutcome[]> {
  return addOutsideRequests({
    requests: requests.map(([operation, args]) => {
      const id = newRequestId()
      return { id, request: { version: 1, id, operation, args } as WriteRequest }
    }),
    workspace, changes, now: () => new Date(),
  })
}
const idsOf = (outcomes: IngestOutcome[]): string[] => outcomes.map((outcome) => {
  if (outcome.kind !== 'filed') throw new Error(`expected a filed request, got ${outcome.kind}${outcome.kind === 'closed' ? `: ${outcome.reason}` : ''}`)
  return outcome.changes[0].id
})
const statusOf = async (id: string): Promise<string> => (await changes.get(id))!.status
/** How many accept snapshots the history holds for a document: one per single Accept that wrote. */
const acceptSnapshots = async (rel: string): Promise<string[]> => {
  if (!existsSync(join(root, '.bridle/journal.jsonl'))) return []
  const lines = (await readFile(join(root, '.bridle/journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind?: string; id: string; file?: string; capability?: string })
  const out: string[] = []
  for (const line of lines) {
    if (line.kind === 'snapshot' && line.capability === 'change.accept' && String(line.file).endsWith(`/${rel}`)) out.push((await versionTextReader(root).readSnapshotContent(line.id)) ?? '<absent>')
  }
  return out
}

const META = '---\ntitle: The talk\nstatus: draft\n---\n# The talk\n\nThe opening line.\n\nstatus: draft\n\nThe closing line.\n'

// ---- Feature 2: a change to the metadata is placed in the frontmatter, and only there ---------------------------

test('a metadata change is filed as its whole frontmatter block, survives an accepted edit to the writing, and is placed only in the frontmatter', async () => {
  await write('meta.md', META)
  const [meta, body] = idsOf(await file(
    ['set-frontmatter', { path: 'meta.md', key: 'status', value: 'final', source: 'claude-code' }],
    ['replace', { path: 'meta.md', target: 'The opening line.', with: 'A sharper opening.', source: 'claude-code' }],
  ))
  const filed = (await changes.get(meta))! as Change & { frontmatter?: true; whole?: true }
  // The body is not part of it: the body's own `status: draft` paragraph is never its target.
  const BLOCK = '---\ntitle: The talk\nstatus: draft\n---\n'
  expect(filed).toMatchObject({ oldText: BLOCK, newText: '---\ntitle: The talk\nstatus: final\n---\n', frontmatter: true, anchor: { from: 0, to: BLOCK.length } })
  expect(filed.whole).toBeUndefined()
  // Accept the body edit first: the metadata change is still placeable (it was closed as superseded before).
  expect(await agent.resolveChange(body, 'accept')).toMatchObject({ applied: true })
  expect(await statusOf(meta)).toBe('pending')
  expect(unplaceableIn((await changes.get(meta))!, await read('meta.md'))).toBeNull()
  expect(await agent.resolveChange(meta, 'accept')).toMatchObject({ applied: true })
  expect(await read('meta.md')).toBe(META.replace('status: draft\n---', 'status: final\n---').replace('The opening line.', 'A sharper opening.'))
  // The `status: draft` in the writing is untouched.
  expect(await read('meta.md')).toContain('\n\nstatus: draft\n\n')
})

test('and the other way round: accepting the metadata change leaves the body edit placeable; a second metadata change to the same block waits, never closed', async () => {
  await write('meta.md', META)
  const [title, status, body] = idsOf(await file(
    ['set-frontmatter', { path: 'meta.md', key: 'title', value: 'A longer title for the talk', source: 'codex' }],
    ['set-status', { path: 'meta.md', status: 'editing', source: 'codex' }],
    ['replace', { path: 'meta.md', target: 'The closing line.', with: 'The end.', source: 'codex' }],
  ))
  expect(await agent.resolveChange(title, 'accept')).toMatchObject({ applied: true })
  expect(await statusOf(body)).toBe('pending')
  // The block is no longer as the status change saw it: it waits (not closed by the sweep), and Accept writes nothing.
  expect(await statusOf(status)).toBe('pending')
  expect(await agent.resolveChange(status, 'accept')).toMatchObject({ applied: false })
  expect(await statusOf(status)).toBe('pending')
  expect(await agent.resolveChange(body, 'accept')).toMatchObject({ applied: true })
  expect(await read('meta.md')).toBe('---\ntitle: A longer title for the talk\nstatus: draft\n---\n# The talk\n\nThe opening line.\n\nstatus: draft\n\nThe end.\n')
})

test('a metadata change whose lines are gone from the frontmatter is not placed, and nothing is written', async () => {
  await write('meta.md', META)
  const [meta] = idsOf(await file(['set-frontmatter', { path: 'meta.md', key: 'status', value: 'final' }]))
  const edited = META.replace('status: draft\n---', 'status: review\n---')
  await write('meta.md', edited)
  expect(unplaceableIn((await changes.get(meta))!, edited)).toMatchObject({ code: 'target-gone' })
  expect(await agent.resolveChange(meta, 'accept')).toMatchObject({ applied: false })
  expect(await read('meta.md')).toBe(edited)
  expect(await statusOf(meta)).toBe('pending')
})

/** A record exactly as an older build filed a metadata request: over the whole document. */
async function legacyWhole(path: string, oldText: string, newText: string): Promise<Change> {
  const id = newRequestId()
  const [result] = await changes.addOutside([{ requestId: id, changes: [{
    path, provenance: 'agent', isCorrection: false, editClass: 'content', category: 'other', summary: `Set status in the frontmatter of ${path}`,
    oldText, newText, whole: true, author: { ...OUTSIDE_AUTHORS['claude-code'] }, outsideSource: 'claude-code',
    outsideRequest: { id, index: 1, count: 1, at: Date.now() }, ts: Date.now(),
  } as never] }], { maxUndecided: 1000, maxUndecidedBytes: 50_000_000, maxRefused: 100, maxPerSource: MAX_UNDECIDED_PER_SOURCE, maxPerRequest: MAX_CHANGES_PER_REQUEST })
  return result.changes[0]
}

test('an older whole-document metadata record still accepts, now also after an edit to the writing, and the window reads it as its lines', async () => {
  await write('old.md', META)
  const legacy = await legacyWhole('old.md', META, META.replace('status: draft\n---', 'status: final\n---'))
  expect((legacy as Change & { whole?: true }).whole).toBe(true)
  // As the window reads it: the frontmatter lines, no whole-document text, so the body carries no mark.
  expect(asFrontmatterForWindow(legacy)).toMatchObject({ oldText: '---\ntitle: The talk\nstatus: draft\n---\n', newText: '---\ntitle: The talk\nstatus: final\n---\n', frontmatter: true, anchor: { from: 0 } })
  expect((asFrontmatterForWindow(legacy) as Change & { whole?: true }).whole).toBeUndefined()
  // The ledger keeps it as filed.
  expect((await changes.get(legacy.id))!.oldText).toBe(META)
  // An edit to the writing is accepted first (by hand here); the old record is still placed, in the frontmatter only.
  await write('old.md', META.replace('The closing line.', 'The end.'))
  expect(await agent.resolveChange(legacy.id, 'accept')).toMatchObject({ applied: true })
  expect(await read('old.md')).toBe(META.replace('status: draft\n---', 'status: final\n---').replace('The closing line.', 'The end.'))
  expect(await acceptSnapshots('old.md')).toEqual([META.replace('The closing line.', 'The end.')])
})

test('an older whole-document record that changes the writing too keeps its old rule: placed only over exactly its text', async () => {
  await write('old.md', META)
  const legacy = await legacyWhole('old.md', META, `${META}A new paragraph.\n`)
  expect(asFrontmatterForWindow(legacy)).toBe(legacy)
  await write('old.md', `${META}\n`)
  expect(unplaceableIn(legacy, `${META}\n`)).toMatchObject({ code: 'document-changed' })
})

// ---- Feature 1: Accept all / Decline all from one source ---------------------------------------------------

test('Accept all from one source accepts its changes in every document, by the single Accept, and leaves every other source alone', async () => {
  await write('a.md', '# A\n\nAlpha one.\n\nAlpha two.\n')
  await write('b.md', META)
  await write('c.md', '# C\n\nGamma.\n')
  const [a1, a2, b1, b2, c1] = idsOf(await file(
    ['replace', { path: 'a.md', target: 'Alpha one.', with: 'Alpha first.', source: 'claude-code' }],
    ['insert', { path: 'a.md', text: 'Alpha three.', source: 'claude-code' }],
    ['set-frontmatter', { path: 'b.md', key: 'status', value: 'final', source: 'claude-code' }],
    ['replace', { path: 'b.md', target: 'The opening line.', with: 'Opening.', source: 'claude-code' }],
    ['replace', { path: 'c.md', target: 'Gamma.', with: 'Gamma changed.', source: 'codex' }],
  ))
  const outcome = await agent.acceptOutsideFromSource('claude-code')
  expect(outcome).toMatchObject({ accepted: 4, files: ['a.md', 'b.md'], left: [], closed: [], open: [] })
  for (const id of [a1, a2, b1, b2]) expect(await statusOf(id)).toBe('accepted')
  expect(await statusOf(c1)).toBe('pending')
  expect(await read('a.md')).toBe('# A\n\nAlpha first.\n\nAlpha two.\n\nAlpha three.')
  expect(await read('b.md')).toBe(META.replace('status: draft\n---', 'status: final\n---').replace('The opening line.', 'Opening.'))
  expect(await read('c.md')).toBe('# C\n\nGamma.\n')
  // In history exactly as single accepts: one snapshot per accepted change, each of the text it was applied to.
  expect(await acceptSnapshots('a.md')).toHaveLength(2)
  expect(await acceptSnapshots('b.md')).toHaveLength(2)
  expect(await acceptSnapshots('c.md')).toHaveLength(0)
})

test('Accept all goes from the end of each document up, so a later change stays placeable', async () => {
  // Accepted in ledger order, the first would make "bar" stand twice and the second could not be placed.
  await write('order.md', '# Order\n\nOne.\n\nThe bar.\n')
  const [first, second] = idsOf(await file(
    ['replace', { path: 'order.md', target: 'One.', with: 'One bar.', source: 'codex' }],
    ['replace', { path: 'order.md', target: 'bar', with: 'baz', source: 'codex' }],
  ))
  const outcome = await agent.acceptOutsideFromSource('codex')
  expect(outcome).toMatchObject({ accepted: 2, left: [], closed: [] })
  expect(await statusOf(first)).toBe('accepted')
  expect(await statusOf(second)).toBe('accepted')
  expect(await read('order.md')).toBe('# Order\n\nOne bar.\n\nThe baz.\n')
})

test('a change that cannot be placed is left waiting with the reason, never forced or closed; a move is left for its card', async () => {
  await write('gone.md', '# Gone\n\nKept words.\n\nWords that go.\n\nMove me.\n\nAfter here.\n')
  const [kept, goes, move] = idsOf(await file(
    ['replace', { path: 'gone.md', target: 'Kept words.', with: 'Kept, changed.', source: 'claude-code' }],
    ['replace', { path: 'gone.md', target: 'Words that go.', with: 'Never placed.', source: 'claude-code' }],
    ['move-text', { path: 'gone.md', text: 'Move me.', after: 'After here.', source: 'claude-code' }],
  ))
  // The writer removed the passage after the request was filed.
  await write('gone.md', '# Gone\n\nKept words.\n\nMove me.\n\nAfter here.\n')
  const outcome = await agent.acceptOutsideFromSource('claude-code')
  expect(outcome.accepted).toBe(1)
  expect(outcome.left.map((item) => item.id).sort()).toEqual([goes, move].sort())
  expect(outcome.left.find((item) => item.id === goes)?.reason).toContain('no longer')
  expect(await statusOf(kept)).toBe('accepted')
  expect(await statusOf(goes)).toBe('pending')
  expect(closedReasonOf((await changes.get(goes))!)).toBeNull()
  expect(await statusOf(move)).toBe('pending')
  expect(await read('gone.md')).toBe('# Gone\n\nKept, changed.\n\nMove me.\n\nAfter here.\n')
})

test('a document the window has open is not written: its changes come back, in order, for the window to accept itself', async () => {
  await write('open.md', '# Open\n\nFirst.\n\nSecond.\n')
  await write('shut.md', '# Shut\n\nThird.\n')
  const [first, second, third] = idsOf(await file(
    ['replace', { path: 'open.md', target: 'First.', with: 'First!', source: 'outside-agent' }],
    ['replace', { path: 'open.md', target: 'Second.', with: 'Second!', source: 'outside-agent' }],
    ['replace', { path: 'shut.md', target: 'Third.', with: 'Third!', source: 'outside-agent' }],
  ))
  const outcome = await agent.acceptOutsideFromSource('outside-agent', ['open.md'])
  expect(outcome).toMatchObject({ accepted: 1, files: ['shut.md'] })
  // From the end of the document up: Second, then First.
  expect(outcome.open).toEqual([{ id: second, path: 'open.md' }, { id: first, path: 'open.md' }])
  expect(await read('open.md')).toBe('# Open\n\nFirst.\n\nSecond.\n')
  expect(await statusOf(first)).toBe('pending')
  expect(await statusOf(third)).toBe('accepted')
})

test('a reader\'s items are never accepted in bulk', async () => {
  expect(await agent.acceptOutsideFromSource('reader')).toEqual({ accepted: 0, files: [], left: [], closed: [], open: [] })
})

test('Decline all from one source rejects its waiting changes in every document, held ones too, writes no document, and leaves other sources', async () => {
  await write('a.md', '# A\n\nAlpha.\n')
  await write('b.md', META)
  const [a1, b1, other] = idsOf(await file(
    ['replace', { path: 'a.md', target: 'Alpha.', with: 'Alpha!', source: 'claude-code' }],
    ['set-frontmatter', { path: 'b.md', key: 'status', value: 'final', source: 'claude-code' }],
    ['replace', { path: 'a.md', target: '# A', with: '# A!', source: 'codex' }],
  ))
  await changes.setReviewStatus(b1, 'held')
  const rejected = await changes.rejectOutside({ source: 'claude-code' })
  expect(rejected.map((change) => change.id).sort()).toEqual([a1, b1].sort())
  expect(await statusOf(a1)).toBe('rejected')
  expect(await statusOf(b1)).toBe('rejected')
  expect(await statusOf(other)).toBe('pending')
  // A plain reject: no closure reason, so it can be reopened.
  expect(closedReasonOf((await changes.get(a1))!)).toBeNull()
  expect(await read('a.md')).toBe('# A\n\nAlpha.\n')
  expect(await read('b.md')).toBe(META)
})

test('a large body is never part of a metadata change: only the block', async () => {
  const body = `${'Body words. '.repeat(Math.floor(MAX_NEW_TEXT_BYTES / 12))}\n`
  await write('big.md', `---\ntitle: Big\n---\n${body}`)
  const [id] = idsOf(await file(['set-frontmatter', { path: 'big.md', key: 'summary', value: 'One line.' }]))
  const filed = (await changes.get(id))!
  expect(filed).toMatchObject({ oldText: '---\ntitle: Big\n---\n', newText: '---\ntitle: Big\nsummary: One line.\n---\n' })
})

// ---- Fix round after review (2026-10-27): the three scenarios as the reviewer reproduced them --------------------

test('review P1 (round 1): a status change whose key was renamed to otherstatus on disk is not placed in otherstatus, in bulk or by a single Accept', async () => {
  const start = '---\nstatus: draft\n---\nBody\n'
  await write('p1.md', start)
  const [meta] = idsOf(await file(['set-frontmatter', { path: 'p1.md', key: 'status', value: 'final', source: 'codex' }]))
  const renamed = '---\notherstatus: draft\n---\nBody\n'
  await write('p1.md', renamed)
  const outcome = await agent.acceptOutsideFromSource('codex')
  expect(outcome.accepted).toBe(0)
  expect(outcome.left.map((item) => item.id)).toEqual([meta])
  expect(await agent.resolveChange(meta, 'accept')).toMatchObject({ applied: false })
  expect(await read('p1.md')).toBe(renamed)
  expect(await statusOf(meta)).toBe('pending')
})

test('review P1 (round 1), older record: a whole-document metadata record after the key was renamed and the body changed is not placed in the other key', async () => {
  const start = '---\nstatus: draft\n---\nBody\n'
  await write('p1-old.md', start)
  const legacy = await legacyWhole('p1-old.md', start, '---\nstatus: final\n---\nBody\n')
  const now = '---\notherstatus: draft\n---\nA different body\n'
  await write('p1-old.md', now)
  expect(await agent.resolveChange(legacy.id, 'accept')).toMatchObject({ applied: false })
  expect(await read('p1-old.md')).toBe(now)
  expect(await statusOf(legacy.id)).toBe('pending')
})

test('review P2 (round 1): changing title and adding summary: the first lands, the second waits with the reason, in bulk and by single Accepts in either order', async () => {
  const start = '---\ntitle: Old\n---\nBody\n'
  const pair = async (rel: string): Promise<[string, string]> => {
    await write(rel, start)
    return idsOf(await file(
      ['set-frontmatter', { path: rel, key: 'title', value: 'New', source: 'codex' }],
      ['set-frontmatter', { path: rel, key: 'summary', value: 'Summary', source: 'codex' }],
    )) as [string, string]
  }
  const [bulkTitle, bulkSummary] = await pair('bulk.md')
  const outcome = await agent.acceptOutsideFromSource('codex')
  expect(outcome.accepted).toBe(1)
  expect(outcome.left).toHaveLength(1)
  expect(outcome.left[0].reason).toBe('Metadata changed since proposed (bulk.md).')
  const landed = await read('bulk.md')
  expect(['---\ntitle: New\n---\nBody\n', '---\ntitle: Old\nsummary: Summary\n---\nBody\n']).toContain(landed)
  expect([await statusOf(bulkTitle), await statusOf(bulkSummary)].sort()).toEqual(['accepted', 'pending'])

  const [title1, summary1] = await pair('title-first.md')
  expect(await agent.resolveChange(title1, 'accept')).toMatchObject({ applied: true })
  expect(await agent.resolveChange(summary1, 'accept')).toMatchObject({ applied: false })
  expect(await read('title-first.md')).toBe('---\ntitle: New\n---\nBody\n')
  expect(await statusOf(summary1)).toBe('pending')

  const [title2, summary2] = await pair('summary-first.md')
  expect(await agent.resolveChange(summary2, 'accept')).toMatchObject({ applied: true })
  expect(await agent.resolveChange(title2, 'accept')).toMatchObject({ applied: false })
  expect(await read('summary-first.md')).toBe('---\ntitle: Old\nsummary: Summary\n---\nBody\n')
  expect(await statusOf(title2)).toBe('pending')
})

test('an added field is not added twice: when the block changed (the key is already there), the addition waits', async () => {
  await write('twice.md', '---\ntitle: Old\n---\nBody\n')
  const [summary] = idsOf(await file(['set-frontmatter', { path: 'twice.md', key: 'summary', value: 'Summary', source: 'codex' }]))
  await write('twice.md', '---\ntitle: Old\nsummary: Mine\n---\nBody\n')
  expect(await agent.resolveChange(summary, 'accept')).toMatchObject({ applied: false })
  expect(await read('twice.md')).toBe('---\ntitle: Old\nsummary: Mine\n---\nBody\n')
  expect(await statusOf(summary)).toBe('pending')
})

test('review P2: Decline all includes moves (declining writes nothing); Accept all leaves them', async () => {
  await write('mv.md', '# Mv\n\nMove me.\n\nAfter here.\n')
  const [move] = idsOf(await file(['move-text', { path: 'mv.md', text: 'Move me.', after: 'After here.', source: 'codex' }]))
  expect((await agent.acceptOutsideFromSource('codex')).left.map((item) => item.id)).toEqual([move])
  expect(await statusOf(move)).toBe('pending')
  const rejected = await changes.rejectOutside({ source: 'codex' })
  expect(rejected.map((change) => change.id)).toEqual([move])
  expect(await statusOf(move)).toBe('rejected')
  expect(await read('mv.md')).toBe('# Mv\n\nMove me.\n\nAfter here.\n')
})

// ---- Second review (2026-10-27): placement is the whole block, exactly as proposed, or nothing ------------------

test('review round 2, P1: a legacy tags-item change after the block was edited (the old item now under other) waits; the file is unchanged', async () => {
  const start = '---\ntags:\n  - Old\nother:\n  - Keep\n---\nBody\n'
  await write('r2-tags.md', start)
  const legacy = await legacyWhole('r2-tags.md', start, start.replace('  - Old', '  - New'))
  const now = '---\ntags:\n  - Mine\nother:\n  - Old\n---\nAnother body\n'
  await write('r2-tags.md', now)
  expect(await agent.resolveChange(legacy.id, 'accept')).toMatchObject({ applied: false })
  expect(await read('r2-tags.md')).toBe(now)
  expect(await statusOf(legacy.id)).toBe('pending')
})

test('review round 2, P1: an added field after the title became a block scalar waits; the scalar is never split', async () => {
  await write('r2-scalar.md', '---\ntitle: Old\n---\nBody\n')
  const [summary] = idsOf(await file(['set-frontmatter', { path: 'r2-scalar.md', key: 'summary', value: 'Summary', source: 'codex' }]))
  const now = '---\ntitle: |\n  First\n\n  Second\n---\nBody\n'
  await write('r2-scalar.md', now)
  expect(await agent.resolveChange(summary, 'accept')).toMatchObject({ applied: false })
  expect((await agent.acceptOutsideFromSource('codex')).left.map((item) => item.reason)).toEqual(['Metadata changed since proposed (r2-scalar.md).'])
  expect(await read('r2-scalar.md')).toBe(now)
  expect(await statusOf(summary)).toBe('pending')
})

test('review round 2, P2: a legacy list insertion in the middle, block unchanged, lands where it was proposed', async () => {
  const start = '---\ntags:\n  - Alpha\n  - Charlie\n---\nBody\n'
  const next = '---\ntags:\n  - Alpha\n  - Bravo\n  - Charlie\n---\nBody\n'
  await write('r2-list.md', start)
  const legacy = await legacyWhole('r2-list.md', start, next)
  expect(await agent.resolveChange(legacy.id, 'accept')).toMatchObject({ applied: true })
  expect(await read('r2-list.md')).toBe(next)
})

test('the same legacy list insertion after an edit to the writing only: the block is unchanged, so it lands, and the body is kept', async () => {
  const start = '---\ntags:\n  - Alpha\n  - Charlie\n---\nBody\n'
  await write('r2-list-body.md', start)
  const legacy = await legacyWhole('r2-list-body.md', start, start.replace('  - Charlie', '  - Bravo\n  - Charlie'))
  await write('r2-list-body.md', start.replace('Body', 'A new body'))
  expect(await agent.resolveChange(legacy.id, 'accept')).toMatchObject({ applied: true })
  expect(await read('r2-list-body.md')).toBe('---\ntags:\n  - Alpha\n  - Bravo\n  - Charlie\n---\nA new body\n')
})
