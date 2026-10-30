/**
 * Review parcel P8, follow-up. Five rules about how the Collection's write turn is taken, each with
 * the schedule that breaks it when the rule is not kept:
 *  1. what a request needs that can wait on a model service is waited for BEFORE the turn (`readyBeforeTurn`);
 *  2. one order for the two locks: the scrap store's queue, then the turn (`queueThenTurn`);
 *  3. the window's doors onto the review ledger are turns: a reject during an accept lands after it;
 *  4. a desk's undo checks and restores in ONE turn: a save never lands between the two;
 *  5. the write gate and ownership are asked INSIDE the turn, immediately before the write.
 * Seams: the two functions of collection-write-order.ts, the Workspace agent, the ChangeStore's
 * doors, the two desks, the Workspace's writers and the request executor. A writer is stopped at a
 * named point and the other started there; order is read from an event log. No test waits on a clock.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { AsyncResource } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { BoardMaterialDesk } from '../../src/main/board-material-desk'
import { ChangeStore } from '../../src/main/changes'
import { newRequestId, type WriteRequest } from '../../src/main/cli/request-format'
import { queueThenTurn, readyBeforeTurn, REQUEST_READINESS_WAIT_MS } from '../../src/main/collection-write-order'
import { pauseCollectionWrites, resumeCollectionWrites, WritesPausedError } from '../../src/main/collection-write-gate'
import type { CollectionSnapshots } from '../../src/main/gated-snapshots'
import { documentSaveSeams } from '../../src/main/guarded-document-write'
import { addOutsideRequests } from '../../src/main/outside-change-ingest'
import { ScrapStore } from '../../src/main/scraps'
import { Workspace } from '../../src/main/workspace'
import type { PlanProposalChange } from '../../src/shared/plan-proposal'
import { OPERATIONS_SAVING_A_VERSION } from '../../src/main/request-executor'
import { requestedVersionSave, type VersionSnapshotAgent } from '../../src/main/requested-version-save'
import { VersionStore } from '../../src/main/versions'
import { YORK, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { openAsApp, plantRequest, replyTo, type AppSide } from '../helpers/request-app'

type Deferred<T = void> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }
const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
/** Start `work` as ANOTHER writer would: from outside any turn (bound here, where none is running). */
const elsewhere = AsyncResource.bind(<T>(work: () => T): T => work())
const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))
/** Let everything that can run, run: several turns of the event loop, no clock. */
const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn += 1) await tick() }
/** Wait for a handshake: turns of the event loop until `met`, no clock. A handshake that never comes times the test out. */
const until = async (met: () => boolean): Promise<void> => { while (!met()) await tick() }
/** `promise`, with a flag that says whether it has settled. */
function watched<T>(promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let done = false
  const mark = (): void => { done = true }
  promise.then(mark, mark)
  return { promise, settled: () => done }
}
/** What `promise` rejected with, or null when it resolved. */
const refusal = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (error: unknown) => error)

const DOC = 'a.md'
const DIR = 'schemas'
const TRACKER = 'schemas/_schemas_INDEX.md'
const PIECE = 'schemas/how-humans-hallucinate.md'
const SOURCE = 'schemas/research/schank-abelson-scripts.md'
const SCRAPS = 'schemas/scraps/how-humans-hallucinate-SCRAPS.md'
const HALL = 's_mtb9yb2s0xq8'
const FAMILIES = 's_mtb9yb3a1abc'
const docText = '# Draft\n\nThe first sentence stays.\n\nThe second sentence is wordy and long.\n'
const trackerText = '# schemas\n\n## Ideas\n\n- [[frames-and-scripts]]\n'
const pieceText = '---\nstatus: editing\n---\n# How humans hallucinate\n\nWe fill gaps.\n'
const scrapsText = `## ${HALL}\nHall's high and low context cultures.\n\n## ${FAMILIES}\nFamilies share more context.\n`

let root: string
let appData: string
let workspace: Workspace
let changes: ChangeStore
let scraps: ScrapStore
let agent: WorkspaceAgent | null
/** Writers waiting for the scrap store's queue or for the Collection's write turn. */
const waiting = (): number => scraps.waiting + workspace.writersWaiting

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-turn-order-root-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-turn-order-data-'))
  workspace = new Workspace(root)
  changes = new ChangeStore(workspace)
  scraps = new ScrapStore(workspace)
  agent = null
  await mkdir(join(root, 'schemas/scraps'), { recursive: true })
  await mkdir(join(root, 'schemas/research'), { recursive: true })
  await writeFile(join(root, DOC), docText)
  await writeFile(join(root, TRACKER), trackerText)
  await writeFile(join(root, PIECE), pieceText)
  await writeFile(join(root, SCRAPS), scrapsText)
  await writeFile(join(root, SOURCE), '# Schank & Abelson, Scripts\n')
})
afterEach(async () => {
  delete documentSaveSeams.betweenCheckAndWrite
  resumeCollectionWrites(root)
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
const storeOf = (live: WorkspaceAgent): CollectionSnapshots => (live as unknown as { snapshots: CollectionSnapshots }).snapshots

/** A Change to `a.md` from outside, added to the review ledger as the app adds it: its id and its request's. */
async function propose(operation: 'replace' | 'insert', args: Record<string, string>): Promise<{ id: string; request: string }> {
  const request = newRequestId()
  const [outcome] = await addOutsideRequests({ requests: [{ id: request, request: { version: 1, id: request, operation, args: { path: DOC, ...args } } as WriteRequest }], workspace, changes, now: () => new Date() })
  if (outcome.kind !== 'filed') throw new Error(`not filed: ${outcome.kind}`)
  return { id: outcome.changes[0].id, request }
}

/** A live `scraps.promote` proposal staged by a scripted agent turn, and its Change in the ledger. */
async function stagedPromotion(): Promise<{ live: WorkspaceAgent; changeId: string; newTracker: string }> {
  const step: ScriptedStep = { cap: 'scraps.promote', input: { dir: DIR, origin: PIECE, id: HALL, name: 'Context everywhere' } }
  const live = await boot([turnOf('Turn the Hall scrap into an idea', step)])
  await live.runScriptedTurn('Turn the Hall scrap into an idea', [step])
  let staged = await changes.list()
  while (staged.length === 0) { await tick(); staged = await changes.list() }
  return { live, changeId: staged[0].id, newTracker: staged[0].newText }
}

// ---- 1. Ready before the turn ----

test('what a request needs is waited for before the queue and the turn are taken: while readiness is held open the turn is free and a save lands; the work then has it at once, or null when it failed', async () => {
  const log: string[] = []
  const agentReady = deferred<string>()
  const never = { needs: (operation: string) => operation === 'save-version', limitMs: 0, expired: () => new Promise<void>(() => {}) }
  const prepared = readyBeforeTurn(() => agentReady.promise, (work) => queueThenTurn(scraps, workspace, work), never)

  const carried = prepared.exclusive(async () => { log.push(`request carried out, with ${prepared.had()}, holding the turn`); return 'reply' }, 'save-version')
  await settle()
  // Readiness is still open. Neither lock is held or asked for: a save and a scrap go straight through.
  expect(waiting()).toBe(0)
  await workspace.saveEditorText(DOC, 'Saved while the agent was starting.\n', { kind: 'disk', text: await read(DOC) })
  await scraps.add(DOC, 'A scrap added meanwhile.')
  log.push('save landed')
  agentReady.resolve('the agent')
  expect(await carried).toBe('reply')
  expect(log).toEqual(['save landed', 'request carried out, with the agent, holding the turn'])
  expect(await read(DOC)).toBe('Saved while the agent was starting.\n')

  // Readiness that fails is not waited for again inside the turn: the work finds nothing in hand.
  const failing = readyBeforeTurn<string>(() => Promise.reject(new Error('the boot failed')), (work) => queueThenTurn(scraps, workspace, work), never)
  expect(await failing.exclusive(async () => failing.had(), 'save-version')).toBeNull()
})

/**
 * The app's side of a fixture Collection wired as ipc.ts wires it: readiness (the agent and the
 * author) is waited for before the turn, only by the operations that save a version, and for no
 * longer than a limit. Here the agent NEVER becomes ready, and the limit passes when the test says.
 */
async function appWhoseAgentNeverStarts(fx: WriteFixture): Promise<{ app: AppSide; expire: () => void; asked: () => number }> {
  const expiry = deferred()
  let asked = 0
  let appWorkspace!: Workspace
  const before = readyBeforeTurn<{ agent: VersionSnapshotAgent; author: { name: string } }>(
    () => { asked += 1; return new Promise(() => {}) },
    (work) => appWorkspace.exclusiveAll(work),
    { needs: (operation) => OPERATIONS_SAVING_A_VERSION.has(operation), limitMs: REQUEST_READINESS_WAIT_MS, expired: () => expiry.promise },
  )
  // The executor is made before its Workspace is known here, so the version saver is bound on first use.
  let saver: ReturnType<typeof requestedVersionSave> | null = null
  const app = await openAsApp(fx, {
    exclusive: before.exclusive,
    saveVersion: (input, confirmOwner) => (saver ??= requestedVersionSave({
      workspace: appWorkspace, versions: new VersionStore(appWorkspace), changes: new ChangeStore(appWorkspace), live: () => true,
      agent: async () => before.had()?.agent ?? null,
      author: async () => before.had()?.author ?? { name: 'App Writer' },
    }))(input, confirmOwner),
  })
  appWorkspace = app.workspace
  return { app, expire: () => expiry.resolve(), asked: () => asked }
}

test('the agent never becomes ready: a move request is carried out at once, without waiting for it', async () => {
  const fx = await writeFixture()
  const { app, asked } = await appWhoseAgentNeverStarts(fx)
  try {
    const id = await plantRequest(fx, 'move', { path: 'talks/york.md', to: 'talks/york-2026.md' })
    // The limit never passes in this test: a request that waited for readiness would never be answered.
    await app.executor.drain()

    expect((await replyTo(fx, id)).outcome).toBe('applied')
    expect(existsSync(join(fx.root, 'talks/york-2026.md'))).toBe(true)
    expect(asked()).toBe(0)
  } finally {
    await app.close()
    await fx.dispose()
  }
})

test('the agent never becomes ready: a save-version request waits holding no lock (a save lands meanwhile) and is refused when the limit passes, with "no history store open yet"', async () => {
  const fx = await writeFixture()
  const { app, expire, asked } = await appWhoseAgentNeverStarts(fx)
  try {
    const id = await plantRequest(fx, 'save-version', { path: 'talks/york.md', name: 'Before the talk' })
    const drained = watched(app.executor.drain())
    await until(() => asked() === 1)
    await settle()
    // Waiting for the agent: not answered, and neither the turn nor anything else is held.
    expect(drained.settled()).toBe(false)
    expect(app.workspace.writersWaiting).toBe(0)
    await app.workspace.saveEditorText('talks/york.md', `${YORK}\nSaved while the request waited.\n`, { kind: 'disk', text: await fx.read('talks/york.md') })
    expect(await fx.read('talks/york.md')).toBe(`${YORK}\nSaved while the request waited.\n`)
    expire()
    await drained.promise

    const reply = await replyTo(fx, id)
    expect(reply.outcome).toBe('refused')
    expect(reply.reason).toBe('WriteFlex has no history store open for this Collection yet. Try again in a moment.')
  } finally {
    await app.close()
    await fx.dispose()
  }
})

test('the agent never becomes ready: a create request creates the document when the limit passes, with exactly the text given, and says the history record was not written and why', async () => {
  const fx = await writeFixture()
  const { app, expire, asked } = await appWhoseAgentNeverStarts(fx)
  try {
    const id = await plantRequest(fx, 'create', { path: 'made.md', content: '# Made\n', source: 'claude-code' })
    const drained = watched(app.executor.drain())
    await until(() => asked() === 1)
    await settle()
    expect(drained.settled()).toBe(false)
    expect(existsSync(join(fx.root, 'made.md'))).toBe(false)
    expire()
    await drained.promise

    const reply = await replyTo(fx, id)
    expect(reply.outcome).toBe('applied')
    expect(await fx.read('made.md')).toBe('# Made\n')
    const createdBy = (reply.result as { createdBy: { frontmatter: boolean; history: unknown; note: string } }).createdBy
    expect(createdBy.frontmatter).toBe(false)
    expect(createdBy.history).toBeNull()
    expect(createdBy.note).toContain('the history record could not be written (WriteFlex has no history store open for this Collection yet. Try again in a moment.)')
  } finally {
    await app.close()
    await fx.dispose()
  }
})

// ---- 2. One order: the scrap store's queue, then the turn ----

test('a request that holds the scrap store\'s queue and is about to take the turn, and an accept of a scraps.promote proposal asked meanwhile, both finish, the request first', async () => {
  const { live, changeId, newTracker } = await stagedPromotion()
  const log: string[] = []
  const gates = { hasQueue: deferred(), hasTurn: deferred() }
  // A request being carried out, as the executor takes its two locks (ipc.ts): the queue, then the turn.
  const request = scraps.exclusive(async () => {
    log.push('request: has the queue')
    await gates.hasQueue.promise
    await workspace.exclusiveAll(async () => {
      log.push('request: has the turn')
      await gates.hasTurn.promise
      await workspace.saveFile(DOC, 'Written by the request.\n')
    })
    log.push('request: done')
  })
  await until(() => log.length === 1)
  // Taken turn-first, the accept would now hold the turn and wait for the queue, and the request
  // would hold the queue and wait for the turn: neither would ever finish.
  const accept = elsewhere(() => live.resolveChange(changeId, 'accept').then((result) => { log.push(`accept: ${result.applied ? 'applied' : result.message}`); return result }))
  await until(() => scraps.waiting > 0)
  expect(workspace.writersWaiting).toBe(0)
  gates.hasQueue.resolve()
  await until(() => log.length === 2)
  gates.hasTurn.resolve()
  await Promise.all([request, accept])

  expect(log).toEqual(['request: has the queue', 'request: has the turn', 'request: done', 'accept: applied'])
  expect(await read(TRACKER)).toBe(newTracker)
  expect(await read(SCRAPS)).toBe(`## ${FAMILIES}\nFamilies share more context.\n`)
  expect(await read(DOC)).toBe('Written by the request.\n')
})

test('two accepts of one scraps.promote Change, the first stopped after its capability wrote and before it recorded the Change accepted: the idea is made once and both answer applied', async () => {
  const { live, changeId, newTracker } = await stagedPromotion()
  const setStatus = changes.setStatus.bind(changes)
  const stopped = deferred()
  const gate = deferred()
  let first = true
  changes.setStatus = async (id, status) => {
    if (first) { first = false; stopped.resolve(); await gate.promise }
    return setStatus(id, status)
  }

  const one = elsewhere(() => live.resolveChange(changeId, 'accept'))
  await stopped.promise
  expect(await read(TRACKER)).toBe(newTracker)
  // Outside the turn, this second accept found the Change still pending and its proposal settled,
  // and tried to place the tracker's text again from the ledger.
  const two = watched(elsewhere(() => live.resolveChange(changeId, 'accept')))
  await until(() => two.settled() || waiting() > 0)
  gate.resolve()

  expect(await one).toMatchObject({ applied: true })
  expect(await two.promise).toMatchObject({ applied: true })
  expect(await read(TRACKER)).toBe(newTracker)
  expect(await read(SCRAPS)).toBe(`## ${FAMILIES}\nFamilies share more context.\n`)
  expect((await changes.get(changeId))?.status).toBe('accepted')
})

// ---- 3. The window's doors onto the ledger are turns ----

test('a reject from the review pane\'s status door, and the clearing of what came from outside, asked while an accept is between its read and its save, land after the accept: the ledger ends as the reject left it', async () => {
  const live = await boot()
  const accepted = await propose('replace', { target: 'wordy and long', with: 'short' })
  const other = await propose('insert', { text: 'Another proposal.', after: 'The first sentence stays.' })
  const log: string[] = []
  let reject!: { promise: Promise<unknown>; settled: () => boolean }
  let clear!: { promise: Promise<unknown>; settled: () => boolean }
  documentSaveSeams.betweenCheckAndWrite = async () => {
    delete documentSaveSeams.betweenCheckAndWrite
    reject = watched(elsewhere(() => changes.setReviewStatus(accepted.id, 'rejected')))
    clear = watched(elsewhere(() => changes.rejectOutside({ requestId: other.request })))
    // Before: both wrote the ledger here, and the accept then recorded `accepted` over the reject.
    await until(() => (reject.settled() && clear.settled()) || workspace.writersWaiting > 1)
    await settle()
    log.push(`accept saves; the ledger says ${(await changes.get(accepted.id))?.status} and ${(await changes.get(other.id))?.status}`)
  }

  expect(await live.resolveChange(accepted.id, 'accept')).toMatchObject({ applied: true })
  await Promise.all([reject.promise, clear.promise])

  expect(log).toEqual(['accept saves; the ledger says pending and pending'])
  // The reject was asked for during the accept and applied after it: it is the last word.
  expect((await changes.get(accepted.id))?.status).toBe('rejected')
  expect((await changes.get(other.id))?.status).toBe('rejected')
})

// ---- 4. A desk's undo checks and restores in one turn ----

test('the Board desk\'s undo: a save of the step\'s file that arrives after the undo checked the file and before it restored waits, and lands after the restore', async () => {
  const live = await boot()
  const host = live.hostSnapshots()
  const typed = `${pieceText}\nTyped while the undo ran.\n`
  const log: string[] = []
  let save: { promise: Promise<unknown>; settled: () => boolean } | null = null
  let undoing = false
  const snapshots: CollectionSnapshots = {
    ...host.snapshots,
    // The desk reads the journal after it has checked that the step's files are unchanged.
    entries: async () => {
      if (undoing && !save) {
        log.push('undo: checked the file')
        save = watched(elsewhere(() => workspace.saveFile(PIECE, typed).then(() => { log.push('save: landed') })))
        const asked = save
        await until(() => asked.settled() || workspace.writersWaiting > 0)
      }
      return host.snapshots.entries()
    },
    restoreTo: async (id, opts) => { log.push('undo: restores'); return host.snapshots.restoreTo(id, opts) },
  }
  const board = new BoardMaterialDesk(workspace, { ...host, snapshots }, scraps)
  const step = await board.attachSource({ dir: DIR, piece: PIECE, source: SOURCE })
  if (!step.ok) throw new Error(step.message)
  undoing = true

  expect(await board.undo(step.step.id)).toMatchObject({ ok: true })
  await save!.promise

  // Between the two, the restore would have written the old file over the save and reported success.
  expect(log).toEqual(['undo: checked the file', 'undo: restores', 'save: landed'])
  expect(await read(PIECE)).toBe(typed)
})

test('the Folio outline desk\'s undo: a save of the Index Note that arrives after the undo checked it and before it restored waits, and lands after the restore', async () => {
  const planned: PlanProposalChange[] = [{ op: 'insert', title: 'How humans hallucinate' }]
  const step: ScriptedStep = { cap: 'plan.propose', input: { dir: DIR, changes: planned } }
  const live = await boot([turnOf('order', step)])
  const id = (await live.runScriptedTurn('order', [step])).suggestions.filter((suggestion) => suggestion.capabilityName === 'plan.propose').at(-1)!.id
  expect((await live.acceptPlanProposal(id)).ok).toBe(true)
  const typed = `${trackerText}\nTyped while the undo ran.\n`
  const log: string[] = []
  const store = storeOf(live)
  const { entries, restoreTo } = store
  let save: { promise: Promise<unknown>; settled: () => boolean } | null = null
  store.entries = async () => {
    if (!save) {
      log.push('undo: checked the files')
      save = watched(elsewhere(() => workspace.saveFile(TRACKER, typed).then(() => { log.push('save: landed') })))
      const asked = save
      await until(() => asked.settled() || workspace.writersWaiting > 0)
    }
    return entries()
  }
  store.restoreTo = async (point, opts) => { log.push('undo: restores'); return restoreTo(point, opts) }

  expect(await live.undoPlanProposal(id)).toMatchObject({ ok: true })
  await save!.promise

  expect(log).toEqual(['undo: checked the files', 'undo: restores', 'save: landed'])
  expect(await read(TRACKER)).toBe(typed)
})

// ---- 5. The write gate and ownership are asked inside the turn ----

test('saving is paused while writers wait for the turn: a trash, a save, an editor save of unchanged text, a create, a rename, a copy, a folder rename and a pasted picture each report the pause, and nothing is trashed or written', async () => {
  await mkdir(join(root, 'drafts'))
  const trashed: string[] = []
  const gate = deferred()
  const holder = workspace.exclusiveAll(async () => { await gate.promise })
  await settle()
  // Each is asked while saving is allowed, and passes its first check.
  const asked = [
    workspace.moveToTrash(DOC, async (absolute) => { trashed.push(absolute) }),
    workspace.saveFile(DOC, 'Saved after the pause.\n'),
    workspace.saveEditorText(DOC, docText, { kind: 'disk', text: docText }),
    workspace.createFile('new.md', '# New\n'),
    workspace.renameFile(DOC, 'renamed.md'),
    workspace.duplicateFile(DOC),
    workspace.renameFolder('drafts', 'kept'),
    workspace.saveImage(new Uint8Array([1, 2, 3]), 'png'),
    scraps.add(DOC, 'A scrap.'),
    changes.setReviewStatus('no-such-change', 'rejected'),
  ].map(refusal)
  await until(() => waiting() === asked.length)
  // Another owner takes the Collection while they wait.
  pauseCollectionWrites(root, 'Another copy of WriteFlex has this Collection open.')
  gate.resolve()
  await holder

  const refusals = await Promise.all(asked)
  // The ledger door has no write to refuse for an unknown id; every writer of the Collection is refused.
  for (const error of refusals.slice(0, -1)) expect(error).toBeInstanceOf(WritesPausedError)
  expect(trashed).toEqual([])
  expect(await read(DOC)).toBe(docText)
  for (const name of ['new.md', 'renamed.md', 'a (copy).md', 'kept', 'assets', 'scraps']) expect(existsSync(join(root, name))).toBe(false)
  expect(existsSync(join(root, 'drafts'))).toBe(true)
})

test('the app stops holding the Collection while a request waits for the turn: the request is refused and nothing is moved', async () => {
  const fx = await writeFixture()
  const app = await openAsApp(fx)
  try {
    const gate = deferred()
    const holder = app.workspace.exclusiveAll(async () => { await gate.promise })
    await settle()
    const id = await plantRequest(fx, 'move', { path: 'talks/york.md', to: 'talks/york-2026.md' })
    const drained = app.executor.drain()
    // The request passed its ownership check and is waiting its turn. The lock is lost now.
    await until(() => app.workspace.writersWaiting > 0)
    app.owns.value = false
    gate.resolve()
    await holder
    await drained

    expect((await replyTo(fx, id)).outcome).toBe('refused')
    expect(existsSync(join(fx.root, 'talks/york.md'))).toBe(true)
    expect(existsSync(join(fx.root, 'talks/york-2026.md'))).toBe(false)
    expect(app.changed).toEqual([])
  } finally {
    await app.close()
    await fx.dispose()
  }
})
