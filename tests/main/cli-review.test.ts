/**
 * Command line and skill, ticket 06: the command line's side of a shown-first operation. It checks
 * the request against what is saved on disk, writes ONE request file and nothing else, and reports
 * where the change will be seen. The app's side is run without a window (helpers/request-app.ts).
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceAgent } from '../../src/main/agent'
import { ChangeStore } from '../../src/main/changes'
import { acquireOwnerLock, releaseOwnerLock } from '../../src/main/owner-lock'
import { outsideRequestOf } from '../../src/main/outside-change'
import { REQUEST_MAX_AGE_MS } from '../../src/main/request-executor'
import { MAX_REQUESTS_PER_PASS, MAX_UNDECIDED_OUTSIDE_CHANGES, MAX_UNDECIDED_PER_SOURCE } from '../../src/main/cli/review-format'
import { MAX_ENTRIES_LISTED } from '../../src/main/cli/review-waiting'
import { newRequestId } from '../../src/main/cli/request-format'
import { runCli } from '../../src/main/cli/run'
import { Workspace } from '../../src/main/workspace'
import { YORK, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { content, inboxNames, openAsApp, outboxNames, plantRequest, type AppSide } from '../helpers/request-app'

let fx: WriteFixture
let app: AppSide | undefined
beforeEach(async () => {
  fx = await writeFixture()
  app = undefined
})
afterEach(async () => {
  await app?.close()
  await fx.dispose()
})

const QUICK = { write: { request: { waitMs: 60, pollMs: 10 } } }
const REPLACE = ['replace', 'talks/york.md', '--target', 'Intro about assessment.', '--with', 'A sharper opening.', '--source', 'claude-code']
const open = async (): Promise<AppSide> => (app = await openAsApp(fx, { changes: new ChangeStore(new Workspace(fx.root)) }))
const ledger = () => new ChangeStore(new Workspace(fx.root)).list()

test('with the app closed, an edit is filed and waits: one request file, no ledger write, no document byte changed; it is added when the Collection is opened', async () => {
  const before = await fx.snapshot({ journal: true })
  const filed = await fx.cli(REPLACE)
  expect(filed.json.error?.message ?? '').toBe('')
  expect(filed.code).toBe(0)
  expect(filed.json).not.toHaveProperty('via')
  const id = String(filed.json.result!.request)
  expect(filed.json.result).toEqual({ shown: 'when-opened', request: id, path: 'talks/york.md', changes: 1, source: 'claude-code', checked: 'saved-on-disk' })
  // The one thing written is the request, in the command line's own inbox.
  const after = await fx.snapshot({ journal: true })
  expect(Object.keys(after).filter((path) => after[path] !== before[path])).toEqual([`.writeflex/inbox/${id}.json`])
  expect(await fx.read('.writeflex/changes.jsonl')).toBe('{"change":"fixture"}\n')
  expect(existsSync(join(fx.root, '.writeflex/owner.lock'))).toBe(false)
  expect(JSON.parse(await fx.read(`.writeflex/inbox/${id}.json`))).toEqual({ version: 1, id, operation: 'replace', args: { path: 'talks/york.md', target: 'Intro about assessment.', with: 'A sharper opening.', source: 'claude-code' } })

  // Opened much later than a direct request would survive: it is still added.
  const later = (await open()).restarted({ changes: new ChangeStore(new Workspace(fx.root)), now: () => new Date(Date.now() + REQUEST_MAX_AGE_MS * 20) })
  expect((await later.drain()).review).toMatchObject({ filed: 1, left: 0 })
  const [change] = await ledger()
  expect(change).toMatchObject({ status: 'pending', path: 'talks/york.md', author: { name: 'Claude Code' }, oldText: 'Intro about assessment.', newText: 'A sharper opening.' })
  expect(outsideRequestOf(change)?.id).toBe(id)
  expect(await fx.read('talks/york.md')).toBe(YORK)
  expect(await inboxNames(fx)).toEqual([])
  expect(await outboxNames(fx)).toEqual([])
})

test('a request that could not be placed now is refused at once and nothing is filed', async () => {
  await fx.write('twice.md', 'same words\n\nsame words\n')
  const before = await fx.snapshot({ journal: true })
  const refusals: Array<[string[], string]> = [
    [['replace', 'talks/york.md', '--target', 'not in the file', '--with', 'x'], 'was not found'],
    [['replace', 'twice.md', '--target', 'same words', '--with', 'x'], 'more than once'],
    [['replace', 'talks/york.md', '--target', '', '--with', 'x'], 'is empty'],
    [['replace', '.writeflex/changes.jsonl', '--target', 'fixture', '--with', 'x'], 'dot-folder'],
    [['insert', 'talks/gone.md', '--text', 'x'], 'does not exist'],
    [['move-text', 'talks/york.md', '--text', 'Intro about assessment.', '--after', 'nowhere'], 'not found'],
    [['restore-version', 'talks/york.md', 'v_none'], 'has no saved version'],
    [['tick', 'talks/york.md', '2'], 'no checkbox'],
  ]
  for (const [argv, why] of refusals) {
    const run = await fx.cli(argv)
    expect(run.code, argv.join(' ')).toBe(1)
    expect(run.json.error, argv.join(' ')).toMatchObject({ code: 'refused' })
    expect(run.json.error!.message, argv.join(' ')).toContain(why)
    expect(run.json.error!.message).toContain('Nothing was filed')
  }
  expect(await fx.snapshot({ journal: true })).toEqual(before)
  expect((await fx.cli(['replace', 'talks/york.md', '--with', 'x'])).code).toBe(2)
})

test('with the app open, the edit is in the review dock at once and the command reports the app\'s signed answer', async () => {
  const side = await open()
  const stop = side.answering()
  try {
    const before = await content(fx)
    const filed = await fx.cli(REPLACE)
    expect(filed.json.error?.message ?? '').toBe('')
    expect(filed.code).toBe(0)
    expect(filed.json).toMatchObject({ via: 'app', result: { shown: 'now', path: 'talks/york.md', source: 'claude-code' } })
    const [change] = await ledger()
    expect((filed.json.result!.changes as Array<{ id: string }>)[0].id).toBe(change.id)
    expect(change.status).toBe('pending')
    const after = await content(fx)
    expect(Object.keys(after).filter((path) => after[path] !== before[path])).toEqual(['.writeflex/changes.jsonl'])
    // Text piped in is the replacement itself.
    const piped = await fx.cli(['insert', 'notes.md', '--stdin'], { stdin: 'A piped paragraph.\n' })
    expect(piped.json.result).toMatchObject({ shown: 'now' })
    expect((await ledger()).some((stored) => stored.newText === 'A piped paragraph.\n' && stored.author?.name === 'Outside agent')).toBe(true)
  } finally {
    await stop()
  }
})

test('with the app open and silent, the result is "sent, not confirmed" and the request stays for the app', async () => {
  const side = await open()
  const filed = await fx.cli(REPLACE, QUICK)
  expect(filed.code).toBe(3)
  expect(filed.json.result).toMatchObject({})
  expect(await inboxNames(fx)).toHaveLength(1)
  expect((await side.executor.drain()).review).toMatchObject({ filed: 1 })
  expect(await ledger()).toHaveLength(1)
})

test('with a lock that names an app and no reply key, nothing is sent: it could not be verified', async () => {
  const lock = await acquireOwnerLock(fx.root, { kind: 'app' })
  try {
    const before = await fx.snapshot({ journal: true })
    const filed = await fx.cli(REPLACE, QUICK)
    expect(filed.code).toBe(1)
    expect(filed.json.error!.message).toContain('could not be verified')
    expect(await fx.snapshot({ journal: true })).toEqual(before)
    expect(await inboxNames(fx)).toEqual([])
  } finally {
    await releaseOwnerLock(lock)
  }
})

test('waiting lists what has not been added yet; withdraw takes one back; undo says a proposed change is not its business', async () => {
  expect((await fx.cli(['waiting'])).json.result).toMatchObject({ waiting: [] })
  const first = String((await fx.cli(REPLACE)).json.result!.request)
  const second = String((await fx.cli(['insert', 'notes.md', '--text', 'More.', '--source', 'writer'])).json.result!.request)
  // A direct request left in the inbox, and a file that is not a request, are not proposed changes.
  const direct = await plantRequest(fx, 'create', { path: 'x.md' })
  await fx.write('.writeflex/inbox/readme.txt', 'stray')
  const listed = await fx.cli(['waiting'])
  expect(listed.json.result!.waiting).toEqual([
    { id: first, at: expect.any(String), operation: 'replace', path: 'talks/york.md', source: 'Claude Code' },
    { id: second, at: expect.any(String), operation: 'insert', path: 'notes.md', source: 'Outside agent' },
  ])
  expect(listed.json.result!.limits).toEqual({ entriesListed: 2000, requestsPerPass: 500, bytesPerPass: 16 * 1024 * 1024, undecidedInLedger: 1000, undecidedPerSource: 400, changesPerRequest: 20 })
  expect(listed.json.result).toMatchObject({ settled: [], undecidedInDock: { undecided: 0 }, cut: { waiting: null, settled: null }, waitingAre: expect.stringContaining('not checked or confirmed by WriteFlex') })

  const undone = await fx.cli(['undo', first])
  expect(undone.code).toBe(1)
  expect(undone.json.error!.message).toContain('"writeflex undo" does not cover it')
  expect(undone.json.error!.message).toContain('writeflex withdraw')
  expect(await inboxNames(fx)).toContain(`${first}.json`)

  const withdrawn = await fx.cli(['withdraw', first])
  expect(withdrawn.json.error?.message ?? '').toBe('')
  expect(withdrawn.json).toMatchObject({ outcome: 'done' })
  expect(withdrawn.json.result).toMatchObject({ withdrawn: true, request: first, operation: 'replace', path: 'talks/york.md' })
  expect(await inboxNames(fx)).not.toContain(`${first}.json`)
  expect(existsSync(join(fx.root, '.writeflex/owner.lock'))).toBe(false)
  expect((await fx.cli(['withdraw', first])).json.error!.message).toContain('No request')
  expect((await fx.cli(['withdraw', direct])).json.error!.message).toContain('not a proposed change waiting for review')
  expect(await inboxNames(fx)).toContain(`${direct}.json`)
  expect((await fx.cli(['withdraw', '../../notes.md'])).code).toBe(2)

  // Once the app has added it, it is no longer the command line's to take back.
  const side = await open()
  await side.executor.drain()
  expect((await ledger()).map((change) => outsideRequestOf(change)?.id)).toEqual([second])
  const late = await fx.cli(['withdraw', second])
  expect(late.code).toBe(1)
  expect(late.json.error!.message).toContain('Reject it there')
  expect((await ledger())[0].status).toBe('pending')
  expect(await fx.read('talks/york.md')).toBe(YORK)
})

test('the app checks again from scratch: an edit the command line found placeable is closed with the reason if the document changed before it was added', async () => {
  const id = String((await fx.cli(REPLACE)).json.result!.request)
  await fx.write('talks/york.md', YORK.replace('Intro about assessment.', 'Rewritten by the writer meanwhile.'))
  const side = await open()
  expect((await side.executor.drain()).review).toMatchObject({ filed: 0, closed: 1 })
  const [change] = await ledger()
  expect(change).toMatchObject({ status: 'rejected', path: 'talks/york.md', outsideRefused: true, author: { name: 'Claude Code' } })
  expect((change as { closedReason?: string }).closedReason).toContain('was not found')
  expect(outsideRequestOf(change)?.id).toBe(id)
  expect(await fx.read('talks/york.md')).toContain('Rewritten by the writer meanwhile.')
})

const seeded = (id: string, source: string, path = 'notes.md') => ({
  requestId: id,
  changes: [{ path, provenance: 'agent' as const, editClass: 'insert' as const, summary: 's', oldText: '', newText: `Seed ${id}.`, insertAfter: '', isCorrection: false, outsideSource: source, outsideRequest: { id, index: 1, count: 1, at: 1 } }],
})
const ROOMY = { maxUndecided: 5000, maxUndecidedBytes: 1e9, maxRefused: 10, maxPerSource: 5000, maxPerRequest: 20 }

test('with the review dock\'s allowance full, the command line refuses before filing and names the count', async () => {
  const store = new ChangeStore(new Workspace(fx.root))
  await store.addOutside(Array.from({ length: MAX_UNDECIDED_PER_SOURCE }, (_, index) => seeded(`s-${index}`, 'codex')), ROOMY)
  const before = await fx.snapshot({ journal: true })
  const refused = await fx.cli(['insert', 'notes.md', '--text', 'One more.', '--source', 'codex'])
  expect(refused.code).toBe(1)
  expect(refused.json.error!.message).toContain(`already holds ${MAX_UNDECIDED_PER_SOURCE} undecided changes from Codex`)
  expect(refused.json).toMatchObject({ outcome: 'needs-writer', error: { code: 'review-allowance-full' } })
  expect(await fx.snapshot({ journal: true })).toEqual(before)
  // Another source still has room.
  expect((await fx.cli(['insert', 'notes.md', '--text', 'One more.', '--source', 'claude-code'])).json.result).toMatchObject({})
  await store.addOutside(Array.from({ length: MAX_UNDECIDED_OUTSIDE_CHANGES - MAX_UNDECIDED_PER_SOURCE }, (_, index) => seeded(`t-${index}`, index % 2 ? 'claude-code' : 'outside-agent')), ROOMY)
  const full = await fx.cli(['insert', 'notes.md', '--text', 'One more.'])
  expect(full.json.error!.message).toContain(`already holds ${MAX_UNDECIDED_OUTSIDE_CHANGES} undecided changes from outside`)
  expect((await fx.cli(['waiting'])).json.result).toMatchObject({ undecidedInDock: { undecided: MAX_UNDECIDED_OUTSIDE_CHANGES, bySource: { codex: MAX_UNDECIDED_PER_SOURCE } } })
})

test('with the app closed, moving a document gives its waiting requests and the Changes already in the ledger the new path; undo puts them back', async () => {
  const onYork = String((await fx.cli(REPLACE)).json.result!.request)
  const onNotes = String((await fx.cli(['insert', 'notes.md', '--text', 'More.'])).json.result!.request)
  const original = { york: await fx.read(`.writeflex/inbox/${onYork}.json`), notes: await fx.read(`.writeflex/inbox/${onNotes}.json`) }
  await new ChangeStore(new Workspace(fx.root)).addOutside([seeded('in-dock', 'codex', 'talks/york.md'), seeded('elsewhere', 'codex', 'notes.md')], ROOMY)
  const ledgerBefore = await fx.read('.writeflex/changes.jsonl')
  const pathOf = async (request: string): Promise<string | undefined> => (await ledger()).find((change) => outsideRequestOf(change)?.id === request)?.path

  const moved = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])
  expect(moved.json.error?.message ?? '').toBe('')
  expect(moved.json.result).toMatchObject({ from: 'talks/york.md', to: 'talks/york-2026.md', waitingRequestsMoved: [onYork], reviewChangesMoved: 1 })
  expect(moved.json.result).not.toHaveProperty('pendingChangesLeft')
  expect(JSON.parse(await fx.read(`.writeflex/inbox/${onYork}.json`))).toEqual({ ...JSON.parse(original.york), args: { ...JSON.parse(original.york).args, path: 'talks/york-2026.md' } })
  expect(await fx.read(`.writeflex/inbox/${onNotes}.json`)).toBe(original.notes)
  // The Change already in the ledger follows the move (specification section 5); the other is left.
  expect(await pathOf('in-dock')).toBe('talks/york-2026.md')
  expect(await pathOf('elsewhere')).toBe('notes.md')
  expect(existsSync(join(fx.root, '.writeflex/owner.lock'))).toBe(false)

  // The folder moves next: the request and the Change follow again.
  const folder = await fx.cli(['move-folder', 'talks', 'events'])
  expect(folder.json.result).toMatchObject({ waitingRequestsMoved: [onYork], reviewChangesMoved: 1 })
  expect(JSON.parse(await fx.read(`.writeflex/inbox/${onYork}.json`)).args.path).toBe('events/york-2026.md')
  expect(await pathOf('in-dock')).toBe('events/york-2026.md')

  // Undo, twice: the folder back, then the document back.
  expect((await fx.cli(['undo'])).json.result).toMatchObject({ waitingRequestsMoved: [onYork], reviewChangesMoved: 1 })
  expect((await fx.cli(['undo'])).json.result).toMatchObject({ waitingRequestsMoved: [onYork], reviewChangesMoved: 1 })
  expect(await fx.read(`.writeflex/inbox/${onYork}.json`)).toBe(original.york)
  expect(await fx.read('.writeflex/changes.jsonl')).toBe(ledgerBefore)

  // Opened now, the app adds the request against the document where it is.
  const side = await open()
  expect((await side.executor.drain()).review).toMatchObject({ filed: 2, closed: 0 })
  expect(await fx.read('talks/york.md')).toBe(YORK)
})

test('with the app closed, a pending replace on a document the command line then moves follows it, and accepting it applies to the new file', async () => {
  // Filed with the app closed, added to the review dock when the Collection is opened, and the app closed again.
  const filed = await fx.cli(REPLACE)
  const id = String(filed.json.result!.request)
  expect((await (await open()).executor.drain()).review).toMatchObject({ filed: 1 })
  await app!.close()
  app = undefined
  const [pending] = await ledger()
  expect(pending).toMatchObject({ status: 'pending', path: 'talks/york.md' })
  expect(outsideRequestOf(pending)?.id).toBe(id)

  const moved = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])
  expect(moved.json.error?.message ?? '').toBe('')
  expect(moved.json.result).toMatchObject({ reviewChangesMoved: 1 })
  expect(moved.out + moved.err).not.toContain('still name')
  expect((await ledger()).find((change) => change.id === pending.id)).toMatchObject({ status: 'pending', path: 'talks/york-2026.md' })

  // Accepted by the app's own accept path, it applies to the document where it now is.
  const appData = await mkdtemp(join(tmpdir(), 'wf-cli-follow-agent-'))
  const workspace = new Workspace(fx.root)
  const changes = new ChangeStore(workspace)
  const agent = await WorkspaceAgent.create({ workspace, appDataDir: appData, changes, onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {} })
  try {
    expect(await agent.resolveChange(pending.id, 'accept')).toMatchObject({ applied: true })
  } finally {
    agent.dispose()
    await rm(appData, { recursive: true, force: true })
  }
  expect(await fx.read('talks/york-2026.md')).toBe(YORK.replace('Intro about assessment.', 'A sharper opening.'))
  expect(existsSync(join(fx.root, 'talks/york.md'))).toBe(false)
})

test('a move with no proposed change waiting says nothing about review and reports as before', async () => {
  const moved = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])
  expect(Object.keys(moved.json.result!).sort()).toEqual(['from', 'notices', 'repaired', 'to', 'undo'])
})

test('an inbox anything can fill is listed under limits applied before reading: the listing says it was cut and by what; withdraw scans nothing', async () => {
  const mine = String((await fx.cli(REPLACE)).json.result!.request)
  const original = await fx.read(`.writeflex/inbox/${mine}.json`)
  // Planted: more entries than one listing considers.
  await Promise.all(Array.from({ length: MAX_ENTRIES_LISTED + 50 }, (_, index) => fx.write(`.writeflex/inbox/planted-${String(index).padStart(5, '0')}.bin`, 'x')))
  const listed = await fx.cli(['waiting'])
  expect(listed.json.result).toMatchObject({ cut: { waiting: 'entries' }, limits: { entriesListed: MAX_ENTRIES_LISTED } })
  expect((listed.json.result!.waiting as unknown[]).length).toBeLessThanOrEqual(1)
  let text = ''
  await runCli(['--root', fx.root, 'waiting'], { cwd: tmpdir(), stdout: (t) => { text += t }, stderr: () => {}, write: { keyFolders: [fx.keys], appDataFolders: [fx.appData] } })
  expect(text).toContain('The list of waiting requests was cut short')
  expect(text).toContain('limit on entries')
  // A move says that not every waiting request could be followed, and still moves the document.
  const moved = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])
  expect(moved.json).toMatchObject({ outcome: 'done', result: { waitingRequestsNotFollowed: { cut: 'entries' } } })
  await fx.cli(['undo'])
  // Withdraw goes straight to the file the id names: it works however full the folder is.
  await fx.write(`.writeflex/inbox/${mine}.json`, original)
  const withdrawn = await fx.cli(['withdraw', mine])
  expect(withdrawn.json).toMatchObject({ outcome: 'done', result: { withdrawn: true, request: mine } })
  expect(existsSync(join(fx.root, `.writeflex/inbox/${mine}.json`))).toBe(false)
})

test('the count and byte limits stop the listing before a file is read', async () => {
  for (let index = 0; index < MAX_REQUESTS_PER_PASS + 3; index += 1) await plantRequest(fx, 'insert', { path: 'notes.md', text: `Planted ${index}.` }, { id: newRequestId(new Date(Date.now() - 1_000_000 + index * 1000)) })
  const byCount = await fx.cli(['waiting'])
  expect(byCount.json.result).toMatchObject({ cut: { waiting: 'requests' } })
  expect(byCount.json.result!.waiting).toHaveLength(MAX_REQUESTS_PER_PASS)
})

test('what waiting lists is what the request files state, shown as that: a planted path is capped and its hidden characters are shown, never sent to the terminal', async () => {
  const hidden = `talks/\u001b[31mred‮.md`
  const planted = await plantRequest(fx, 'insert', { path: hidden, text: 'x', source: 'claude-code' })
  const long = await plantRequest(fx, 'insert', { path: `${'p'.repeat(900)}.md`, text: 'x' })
  const listed = await fx.cli(['waiting'])
  const rows = listed.json.result!.waiting as Array<{ id: string; path: string; source: string }>
  expect(rows.find((row) => row.id === planted)).toMatchObject({ path: hidden, source: 'Claude Code' })
  expect(rows.find((row) => row.id === long)!.path).toContain('more characters not shown')
  expect(rows.find((row) => row.id === long)!.path.length).toBeLessThan(400)
  expect(listed.out).not.toContain('\u001b')
  let text = ''
  await runCli(['--root', fx.root, 'waiting'], { cwd: tmpdir(), stdout: (t) => { text += t }, stderr: () => {}, write: { keyFolders: [fx.keys], appDataFolders: [fx.appData] } })
  expect(text).not.toContain('\u001b')
  expect(text).not.toContain('‮')
  expect(text).toContain('\\u{1b}')
  expect(text).toContain('what each file states; WriteFlex has not checked them')
  expect(text).toContain('(says it is from Claude Code)')
  expect(text).not.toMatch(/WriteFlex (answered|says|filed)/)
})

test('the move-time rewrite touches only a file that is wholly a request of the expected shape', async () => {
  const good = String((await fx.cli(REPLACE)).json.result!.request)
  // Named as a request, naming the moved document, and not valid: an extra field, a wrong inner id, a direct operation, a link.
  const extra = newRequestId()
  const wrongId = newRequestId()
  const direct = newRequestId()
  const linked = newRequestId()
  const args = { path: 'talks/york.md', target: 'Intro about assessment.', with: 'x' }
  await fx.write(`.writeflex/inbox/${extra}.json`, JSON.stringify({ version: 1, id: extra, operation: 'replace', args, note: 'talks/york.md' }))
  await fx.write(`.writeflex/inbox/${wrongId}.json`, JSON.stringify({ version: 1, id: good, operation: 'replace', args }))
  await fx.write(`.writeflex/inbox/${direct}.json`, JSON.stringify({ version: 1, id: direct, operation: 'trash', args: { path: 'talks/york.md' } }))
  await fx.write('elsewhere.json', JSON.stringify({ version: 1, id: linked, operation: 'replace', args }))
  await symlink(join(fx.root, 'elsewhere.json'), join(fx.root, `.writeflex/inbox/${linked}.json`))
  const before = await fx.snapshot({ journal: true })
  const moved = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])
  expect(moved.json.result).toMatchObject({ waitingRequestsMoved: [good] })
  const after = await fx.snapshot({ journal: true })
  for (const id of [extra, wrongId, direct, linked]) expect(after[`.writeflex/inbox/${id}.json`], id).toBe(before[`.writeflex/inbox/${id}.json`])
  expect(after['elsewhere.json']).toBe(before['elsewhere.json'])
  expect(JSON.parse(await fx.read(`.writeflex/inbox/${good}.json`)).args.path).toBe('talks/york-2026.md')
})

test('with the app open and the allowance full, the refusal arrives with its code from the app; a filed answer does not repeat the fixed first line', async () => {
  const store = new ChangeStore(new Workspace(fx.root))
  await store.addOutside(Array.from({ length: MAX_UNDECIDED_PER_SOURCE - 1 }, (_, index) => seeded(`s-${index}`, 'codex')), ROOMY)
  const side = await open()
  const stop = side.answering()
  try {
    let text = ''
    const code = await runCli(['--root', fx.root, 'insert', 'notes.md', '--text', 'The last that fits.', '--source', 'codex'], { cwd: tmpdir(), stdout: (t) => { text += t }, stderr: () => {}, write: { keyFolders: [fx.keys], appDataFolders: [fx.appData] } })
    expect(code).toBe(0)
    expect(text.split('\n')[0]).toBe('Waiting for review in WriteFlex (not applied):')
    expect(text).not.toContain('Filed for review')
    expect(text.match(/review dock/g)).toHaveLength(1)
    expect(text).toContain('One change to notes.md, shown as from Codex')
  } finally {
    await stop()
  }  // The command line's own check reads the ledger and refuses first; the app's refusal is reached by
  // planting the request and having the app look at the inbox once (no waiting on a clock).
  const id = await plantRequest(fx, 'insert', { path: 'notes.md', text: 'One too many.', source: 'codex' })
  await side.executor.drain()
  expect(JSON.parse(await fx.read(`.writeflex/outbox/${id}.json`))).toMatchObject({ outcome: 'refused', code: 'review-allowance-full' })
})
