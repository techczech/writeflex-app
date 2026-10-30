/**
 * Review parcel P8 (second adjudication, decision 1): a decision on a Change, an autosave and every
 * snapshot restore are turns of the Collection's one write turn. Seams: the Workspace agent's
 * resolve-change operation over Changes added exactly as the app adds them (`addOutsideRequests`);
 * "Undo turn", the adoption rewind and the two desks over the agent's own snapshot store, whose
 * `restoreTo` is wrapped to record when it runs. Each test runs the schedule that broke the code
 * before it (reviewer's findings 2 and 6): a writer is stopped at a named point (after its last
 * read of a Change's status; between an accept's read of the document and its save) and the other
 * writer is started there. Order is asserted from an event log. No test waits on a clock.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { AsyncResource } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory, type Bridle } from '@bridle/core'
import { APPLIED_NOT_DISCARDED, WorkspaceAgent, type ResolveChangeResult, type ScriptedStep } from '../../src/main/agent'
import { BoardMaterialDesk } from '../../src/main/board-material-desk'
import { ChangeStore, closedReasonOf, type Change } from '../../src/main/changes'
import { newRequestId, type WriteRequest } from '../../src/main/cli/request-format'
import type { CollectionSnapshots } from '../../src/main/gated-snapshots'
import { documentSaveSeams } from '../../src/main/guarded-document-write'
import { addOutsideRequests } from '../../src/main/outside-change-ingest'
import { ScrapStore } from '../../src/main/scraps'
import { Workspace, type FileReadResult, type SaveFileOptions } from '../../src/main/workspace'
import type { PlanProposalChange } from '../../src/shared/plan-proposal'

type Deferred = { promise: Promise<void>; resolve: () => void }
const deferred = (): Deferred => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
/** Start `work` as ANOTHER writer would: from outside any turn (bound here, where none is running). */
const elsewhere = AsyncResource.bind(<T>(work: () => T): T => work())
const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))
/** Let everything that can run, run: several turns of the event loop, no clock. */
const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn += 1) await tick() }
/** Wait for a handshake: turns of the event loop until `met`, no clock. A handshake that never comes times the test out. */
const until = async (met: () => boolean): Promise<void> => { while (!met()) await tick() }

const DOC = 'a.md'
const PIECE = 'schemas/tools-of-reason.md'
const SOURCE = 'schemas/research/schank-abelson-scripts.md'
const INDEX = 'schemas/_schemas_INDEX.md'
const docText = '# Draft\n\nThe first sentence stays.\n\nThe second sentence is wordy and long.\n'
const pieceText = '---\ntitle: Tools of reason\nstatus: in progress\n---\n# Tools of reason\n\nWe reason with tools.\n'

/** A Workspace whose save of one named document can be made to fail, for a desk step that must roll back. */
class TestWorkspace extends Workspace {
  failSaveOf: string | null = null
  override async saveFile(path: string, content: string, options: SaveFileOptions = {}): Promise<FileReadResult> {
    if (path === this.failSaveOf) throw new Error('The disk refused the write.')
    return super.saveFile(path, content, options)
  }
}

let root: string
let appData: string
let workspace: TestWorkspace
let changes: ChangeStore
let scraps: ScrapStore
let agent: WorkspaceAgent | null
/** Writers waiting for the scrap store's queue or for the Collection's write turn: a decision on a Change takes both, in that order. */
const waiting = (): number => scraps.waiting + workspace.writersWaiting

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-turn-accept-root-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-turn-accept-data-'))
  workspace = new TestWorkspace(root)
  changes = new ChangeStore(workspace)
  scraps = new ScrapStore(workspace)
  agent = null
  await mkdir(join(root, 'schemas/research'), { recursive: true })
  await writeFile(join(root, DOC), docText)
  await writeFile(join(root, PIECE), pieceText)
  await writeFile(join(root, INDEX), '# Schemas\n\nCover prose.\n')
  await writeFile(join(root, SOURCE), '# Schank & Abelson, Scripts\n')
})
afterEach(async () => {
  delete documentSaveSeams.betweenCheckAndWrite
  await agent?.dispose()
  for (const dir of [root, appData]) await rm(dir, { recursive: true, force: true })
})

const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
const turnOf = (prompt: string, step: ScriptedStep) => ({ prompt, rounds: [{ kind: 'tool-calls' as const, calls: [{ name: 'tools.enable', arguments: { names: [step.cap] } }] }, { kind: 'tool-calls' as const, calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] }, { kind: 'message' as const, text: 'Done.' }] })

async function boot(script?: Parameters<typeof scriptedSessionFactory>[0]): Promise<WorkspaceAgent> {
  agent = await WorkspaceAgent.create({ mode: 'work',
    workspace, appDataDir: appData, changes, services: { scraps },
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    ...(script ? { sessionFactory: scriptedSessionFactory(script) } : {}),
  })
  return agent
}
/** The agent's own snapshot store (the one object its desks, its rewind and its undo share). */
const storeOf = (live: WorkspaceAgent): CollectionSnapshots => (live as unknown as { snapshots: CollectionSnapshots }).snapshots

/** A Change from outside, added to the review ledger as the app adds it; its id. */
async function propose(operation: 'replace' | 'insert', args: Record<string, string>): Promise<string> {
  const id = newRequestId()
  const [outcome] = await addOutsideRequests({ requests: [{ id, request: { version: 1, id, operation, args: { path: DOC, ...args } } as WriteRequest }], workspace, changes, now: () => new Date() })
  if (outcome.kind !== 'filed') throw new Error(`not filed: ${outcome.kind}`)
  return outcome.changes[0].id
}

/**
 * THE SEAM OF FINDING 2. The decision on `changeId` that asks first is stopped holding the status it
 * read LAST before it would write (`reads`: how many times that decision reads the Change's status
 * before it places text), until the test releases it. `held` resolves when it is stopped there.
 */
function holdAfterStatusRead(changeId: string, reads: number): { held: Promise<void>; release: () => void } {
  const get = changes.get.bind(changes)
  const stopped = deferred()
  const gate = deferred()
  let seen = 0
  changes.get = async (id: string): Promise<Change | undefined> => {
    const found = await get(id)
    if (id === changeId && (seen += 1) === reads) {
      stopped.resolve()
      await gate.promise
    }
    return found
  }
  return { held: stopped.promise, release: gate.resolve }
}
/** `promise`, with a flag that says whether it has settled. */
function watched<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false
  const mark = (): void => { done = true }
  promise.then(mark, mark)
  return { promise, settled: () => done }
}
const count = (text: string, part: string): number => text.split(part).length - 1

// A persisted Change with no live suggestion reads its status twice on the way to placing its text.
const STATUS_READS_BEFORE_PLACING = 2

test('finding 2 schedule: two accepts of one persisted insertion, the first stopped after its last status read: the text is inserted once and both answer applied', async () => {
  const live = await boot()
  const id = await propose('insert', { text: 'Inserted once.', after: 'The first sentence stays.' })
  const seam = holdAfterStatusRead(id, STATUS_READS_BEFORE_PLACING)

  const first = elsewhere(() => live.resolveChange(id, 'accept'))
  await seam.held
  // The first accept holds a status of `pending`. The second accept starts now.
  const second = watched(elsewhere(() => live.resolveChange(id, 'accept')))
  // Before the turn: the second ran to its end here and inserted. With the turn: it waits its turn.
  await until(() => second.settled() || waiting() > 0)
  seam.release()

  expect(await first).toMatchObject({ applied: true })
  expect(await second.promise).toMatchObject({ applied: true })
  expect(count(await read(DOC), 'Inserted once.')).toBe(1)
  expect((await changes.get(id))?.status).toBe('accepted')
})

test('the two doors onto one live proposal: the margin callout\'s apply is stopped after it wrote the document and before it recorded the Change accepted, and the dock\'s accept starts there: the text is placed once and both say applied', async () => {
  const step: ScriptedStep = { cap: 'prose.edit', input: { path: DOC, oldText: 'The second sentence is wordy and long.', newText: 'The second sentence is short.', category: 'wording', summary: 'Tighten it.' } }
  const live = await boot([turnOf('Tighten it', step)])
  await live.runScriptedTurn('Tighten it', [step])
  let staged = await changes.list()
  while (staged.length === 0) { await tick(); staged = await changes.list() }
  const [suggestion] = await live.suggestions()
  // The seam: the first record of a new status waits for the test.
  const setStatus = changes.setStatus.bind(changes)
  const stopped = deferred()
  const gate = deferred()
  let first = true
  changes.setStatus = async (id, status) => {
    if (first) { first = false; stopped.resolve(); await gate.promise }
    return setStatus(id, status)
  }

  const callout = elsewhere(() => live.applySuggestion(suggestion.id))
  await stopped.promise
  expect(await read(DOC)).toBe(docText.replace('wordy and long', 'short'))
  // Before the turn the dock's accept ran here: it found the Change still pending and its proposal
  // settled, tried to place the text again from the ledger, could not, and closed the Change.
  const dock = watched(elsewhere(() => live.resolveChange(staged[0].id, 'accept')))
  await until(() => dock.settled() || waiting() > 0)
  gate.resolve()

  expect((await callout).isError).toBeFalsy()
  expect(await dock.promise).toMatchObject({ applied: true })
  expect(await read(DOC)).toBe(docText.replace('wordy and long', 'short'))
  expect((await changes.get(staged[0].id))?.status).toBe('accepted')
})

test('accept racing reject of one Change: the accept places its text only over a Change that is pending when it writes, never over one rejected meanwhile; asked the other way round, the accept is refused and nothing is written', async () => {
  const live = await boot()
  const log: string[] = []
  const decide = (id: string, action: 'accept' | 'reject'): Promise<ResolveChangeResult> => elsewhere(() => live.resolveChange(id, action))

  // Accept asked first. Before the turn it read `pending`, then waited for the document while the
  // reject ran to its end, and then placed text for a Change that was by then rejected.
  const first = await propose('insert', { text: 'Accepted, then taken back.', after: 'The first sentence stays.' })
  const blocker = deferred()
  const holder = workspace.exclusive(DOC, async () => { await blocker.promise })
  await settle()
  const accept = decide(first, 'accept')
  await until(() => waiting() > 0)
  const reject = watched(decide(first, 'reject'))
  await until(() => reject.settled() || waiting() > 1)
  documentSaveSeams.betweenCheckAndWrite = async () => {
    delete documentSaveSeams.betweenCheckAndWrite
    log.push(`accept writes while the Change is ${(await changes.get(first))?.status}`)
  }
  blocker.resolve()
  await holder
  // One after the other, in the order asked: an accept, then a reject of an accepted Change, which the save
  // fix refuses (nothing written, it stays accepted; Undo in the editor takes the text back).
  expect(await accept).toMatchObject({ applied: true })
  expect(await reject.promise).toEqual({ applied: false, message: APPLIED_NOT_DISCARDED })
  expect(log).toEqual(['accept writes while the Change is pending'])
  expect((await changes.get(first))?.status).toBe('accepted')
  expect(count(await read(DOC), 'Accepted, then taken back.')).toBe(1)

  // Reject asked first: the accept finds the Change rejected and writes nothing.
  const second = await propose('insert', { text: 'Never placed.', after: 'The first sentence stays.' })
  const before = await read(DOC)
  const again = deferred()
  const holding = workspace.exclusive(DOC, async () => { await again.promise })
  await settle()
  const rejected = decide(second, 'reject')
  await until(() => waiting() > 0)
  const refused = decide(second, 'accept')
  await until(() => waiting() > 1)
  again.resolve()
  await holding
  expect(await rejected).toMatchObject({ applied: true })
  expect(await refused).toEqual({ applied: false, message: 'This change was rejected. Reopen it before accepting it.' })
  expect(await read(DOC)).toBe(before)
  expect((await changes.get(second))?.status).toBe('rejected')
})

test('accept racing the sweep that closes a competing Change: of two edits to one passage, one is accepted and the other is closed exactly once, and each answer is what the ledger records', async () => {
  const live = await boot()
  const short = await propose('replace', { target: 'wordy and long', with: 'short' })
  const brief = await propose('replace', { target: 'wordy and long', with: 'brief' })
  // Every time a Change is closed, by the sweep (closeMany) or by an accept that cannot place it (close).
  const closures: string[] = []
  const close = changes.close.bind(changes)
  const closeMany = changes.closeMany.bind(changes)
  changes.close = async (id, reason, code) => { closures.push(id); return close(id, reason, code) }
  changes.closeMany = async (wanted) => { const closed = await closeMany(wanted); closures.push(...closed.map((change) => change.id)); return closed }
  // "brief" is stopped holding `pending`. "short" is then accepted, and its sweep closes "brief".
  const seam = holdAfterStatusRead(brief, STATUS_READS_BEFORE_PLACING)

  const acceptBrief = elsewhere(() => live.resolveChange(brief, 'accept'))
  await seam.held
  const acceptShort = watched(elsewhere(() => live.resolveChange(short, 'accept')))
  await until(() => acceptShort.settled() || waiting() > 0)
  seam.release()
  const answers = { [brief]: await acceptBrief, [short]: await acceptShort.promise }

  const ledger = { [brief]: (await changes.get(brief))!, [short]: (await changes.get(short))! }
  const winner = [brief, short].filter((id) => ledger[id].status === 'accepted')
  expect(winner).toHaveLength(1)
  const loser = winner[0] === brief ? short : brief
  expect(answers[winner[0]]).toMatchObject({ applied: true })
  expect(closedReasonOf(ledger[loser])).toBeTruthy()
  expect(answers[loser]).toEqual({ applied: false, closed: true, message: closedReasonOf(ledger[loser])! })
  // Closed once: not closed by the sweep and then closed again, with another reason, by its own accept.
  expect(closures).toEqual([loser])
  const text = await read(DOC)
  expect(text).toContain(winner[0] === brief ? 'is brief.' : 'is short.')
  expect(text).not.toContain(winner[0] === brief ? 'is short.' : 'is brief.')
})

test('autosave racing accept (the betweenCheckAndWrite seam): an editor save of the same document that arrives between the accept\'s read and its commit lands after the commit, and then does what an editor save always does: it writes the editor\'s buffer over the file', async () => {
  const live = await boot()
  const id = await propose('replace', { target: 'wordy and long', with: 'short' })
  const accepted = docText.replace('wordy and long', 'short')
  // The editor's buffer: the document as the editor last read it (before the accept) plus a line typed since.
  const buffer = `${docText}\nTyped by the writer meanwhile.\n`
  const log: string[] = []
  let autosave!: Promise<unknown>
  documentSaveSeams.betweenCheckAndWrite = async () => {
    delete documentSaveSeams.betweenCheckAndWrite
    log.push('accept: read, not yet saved')
    // Based on the document as the editor last read it (save fix): the accepted text is a version it did not see.
    autosave = elsewhere(() => workspace.saveEditorText(DOC, buffer, { kind: 'disk', text: docText }).then(async () => { log.push('autosave: saved') }, (error: Error) => { log.push(`autosave: refused (${error.name})`) }))
    await settle()
    log.push(`accept: saving; ${workspace.writersWaiting} waiting; on disk: ${(await read(DOC)) === docText ? 'the document as read' : 'SOMETHING ELSE'}`)
  }
  // Told just before each save's rename: what the file holds then is what that save replaces.
  const commit = workspace.recordOwnWrite.bind(workspace)
  workspace.recordOwnWrite = (path, at) => {
    if (path === DOC) log.push(`a save commits over ${readFileSync(join(root, DOC), 'utf8') === accepted ? 'the accepted text' : 'the document as read'}`)
    commit(path, at)
  }

  expect(await live.resolveChange(id, 'accept')).toMatchObject({ applied: true })
  await autosave

  expect(log).toEqual([
    'accept: read, not yet saved',
    'accept: saving; 1 waiting; on disk: the document as read',
    'a save commits over the document as read',
    'autosave: refused (DiskChangedUnderBuffer)',
  ])
  // The save fix replaces decision 1: the editor's save says which version it was based on, and the
  // buffer, which never held the accepted text, is not written over it (the editor raises its notice).
  expect(await read(DOC)).toBe(accepted)
  expect((await changes.get(id))?.status).toBe('accepted')
})

// ---- Finding 6: every snapshot restore is a turn ----

/**
 * THE SEAM OF FINDING 6. Accept a Change to `a.md` and, while that accept is between its read of the
 * document and its save, ask for a restore (`start`). The store's `restoreTo` is wrapped to record
 * when it runs and what `a.md` holds at that moment. Returns the event log.
 */
async function restoreAskedDuringAccept(live: WorkspaceAgent, start: () => Promise<unknown>, store: CollectionSnapshots = storeOf(live)): Promise<string[]> {
  const inserted = `Inserted for restore ${restoresAsked += 1}.`
  const id = await propose('insert', { text: inserted })
  const log: string[] = []
  const turns = (live as unknown as { bridle: Bridle }).bridle.turns
  const undoTurn = turns.undo
  turns.undo = async (...args) => {
    restoring = true
    log.push(`restore runs; the accept ${(await read(DOC)).includes(inserted) ? 'has committed' : 'HAS NOT COMMITTED'}`)
    return undoTurn(...args)
  }
  const restoreTo = store.restoreTo
  let restoring = false
  store.restoreTo = async (point, opts) => {
    restoring = true
    log.push(`restore runs; the accept ${(await read(DOC)).includes(inserted) ? 'has committed' : 'HAS NOT COMMITTED'}`)
    return restoreTo(point, opts)
  }
  // A failed operation's rollback (R7, save fix) is not Bridle's restoreTo: it puts back only what the
  // operation wrote, and starts by stepping outside the call's records. That is when it runs.
  const outsideCallRecords = workspace.outsideCallRecords
  workspace.outsideCallRecords = async (call) => {
    restoring = true
    log.push(`restore runs; the accept ${(await read(DOC)).includes(inserted) ? 'has committed' : 'HAS NOT COMMITTED'}`)
    return outsideCallRecords.call(workspace, call)
  }
  let restore!: Promise<unknown>
  documentSaveSeams.betweenCheckAndWrite = async (path) => {
    if (path !== DOC) return
    delete documentSaveSeams.betweenCheckAndWrite
    log.push('accept: read, not yet saved')
    restore = elsewhere(start)
    // Before the turn the restore ran here. With it, the restore (or a save its caller makes first) waits.
    await until(() => restoring || waiting() > 0)
    await settle()
    log.push('accept: saving')
  }
  expect(await live.resolveChange(id, 'accept')).toMatchObject({ applied: true })
  await restore
  store.restoreTo = restoreTo
  turns.undo = undoTurn
  workspace.outsideCallRecords = outsideCallRecords
  return log
}
let restoresAsked = 0
const AFTER_THE_COMMIT = ['accept: read, not yet saved', 'accept: saving', 'restore runs; the accept has committed']

test('finding 6 schedule: "Undo turn" asked while an accept is between its read and its save runs after the commit', async () => {
  const step: ScriptedStep = { cap: 'housekeeping.create_file', input: { path: 'schemas/new-note.md', content: '# New\n' } }
  const live = await boot([turnOf('make a note', step)])
  await live.runScriptedTurn('make a note', [step])

  const log = await restoreAskedDuringAccept(live, () => live.restoreLastTurn())

  expect(log).toEqual(AFTER_THE_COMMIT)
})

test('finding 6 schedule: the rewind of a refused adoption asked while an accept is between its read and its save runs after the commit', async () => {
  const live = await boot()
  await storeOf(live).beginRestorePoint('an adoption', undefined, { proposalId: 'the-proposal' })
  // The rewind puts back what the adoption wrote (R7, save fix): here it wrote nothing.
  const rewindAdoption = (live as unknown as { rewindAdoption(proposalId: string, written: unknown[]): Promise<string | null> }).rewindAdoption.bind(live)
  const rewind = (proposalId: string): Promise<string | null> => rewindAdoption(proposalId, [])

  // The journal the rewind acts on (the adoption's restore point and what follows it) is read inside
  // its turn as well: every read of the journal it makes sees the accept's snapshot already there.
  const store = storeOf(live)
  const entries = store.entries
  const journalReads: string[] = []
  store.entries = async () => {
    const journal = await entries()
    journalReads.push(journal.some((entry) => entry.kind === 'snapshot' && entry.file.endsWith(`/${DOC}`)) && (await read(DOC)).includes('Inserted for restore') ? 'after the commit' : 'BEFORE THE COMMIT')
    return journal
  }

  const log = await restoreAskedDuringAccept(live, () => rewind('the-proposal'))

  expect(log).toEqual(AFTER_THE_COMMIT)
  expect(journalReads).toEqual(['after the commit'])
})

test('finding 6 schedule: the Board desk\'s undo, and the rollback of a Board step that failed, asked while an accept is between its read and its save run after the commit', async () => {
  const live = await boot()
  const host = live.hostSnapshots()
  // The desk refuses an undo when a later host snapshot stands in the journal, and an accept takes
  // one. So that the undo reaches its restore here, the desk reads the journal as it stood before
  // the accept; when it reads it and when it restores are both recorded.
  let journal: Awaited<ReturnType<CollectionSnapshots['entries']>> | null = null
  const log: string[] = []
  const snapshots: CollectionSnapshots = {
    ...host.snapshots,
    entries: async () => { if (journal) log.push('undo: checks'); return journal ?? host.snapshots.entries() },
  }
  const board = new BoardMaterialDesk(workspace, { ...host, snapshots }, new ScrapStore(workspace))
  const step = await board.attachSource({ dir: 'schemas', piece: PIECE, source: SOURCE })
  if (!step.ok) throw new Error(step.message)
  journal = await host.snapshots.entries()

  const undo = await restoreAskedDuringAccept(live, async () => { expect(await board.undo(step.step.id)).toMatchObject({ ok: true }) }, snapshots)
  expect(undo).toEqual(AFTER_THE_COMMIT)
  // Its check ran in the same turn as its restore, so after the accept's commit as well.
  expect(log).toEqual(['undo: checks'])
  expect(await read(PIECE)).toBe(pieceText)

  // A step whose write fails after its restore point is made: its rollback is a restore too.
  journal = null
  workspace.failSaveOf = PIECE
  const rollback = await restoreAskedDuringAccept(live, async () => { expect(await board.attachSource({ dir: 'schemas', piece: PIECE, source: SOURCE })).toMatchObject({ ok: false }) }, snapshots)
  expect(rollback).toEqual(AFTER_THE_COMMIT)
})

test('finding 6 schedule: the Folio outline desk\'s undo, and the rollback of a running order settled elsewhere, asked while an accept is between its read and its save run after the commit', async () => {
  const planned: PlanProposalChange[] = [{ op: 'insert', title: 'Tools of reason' }]
  const step: ScriptedStep = { cap: 'plan.propose', input: { dir: 'schemas', changes: planned } }
  const live = await boot([turnOf('order one', step), turnOf('order two', step)])
  const proposeOrder = async (prompt: string): Promise<string> => (await live.runScriptedTurn(prompt, [step])).suggestions.filter((suggestion) => suggestion.capabilityName === 'plan.propose').at(-1)!.id

  const first = await proposeOrder('order one')
  expect((await live.acceptPlanProposal(first)).ok).toBe(true)
  const undo = await restoreAskedDuringAccept(live, async () => { expect(await live.undoPlanProposal(first)).toMatchObject({ ok: true }) })
  expect(undo).toEqual(AFTER_THE_COMMIT)

  // The proposal turns out to be settled elsewhere after the step wrote: the step is rolled back.
  const second = await proposeOrder('order two')
  const proposals = (live as unknown as { bridle: { proposals: { settleAsHost: (...args: unknown[]) => Promise<unknown> } } }).bridle.proposals
  const settleAsHost = proposals.settleAsHost
  const rollback = await restoreAskedDuringAccept(live, async () => {
    // Only the running order's own settlement is refused; the accept of the Change settles nothing here.
    proposals.settleAsHost = async () => ({ refused: 'already-settled' })
    try { expect(await live.acceptPlanProposal(second)).toMatchObject({ ok: false }) } finally { proposals.settleAsHost = settleAsHost }
  })
  expect(rollback).toEqual(AFTER_THE_COMMIT)
})
