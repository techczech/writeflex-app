/**
 * Command line: what an invocation came to. Every result path carries one `outcome` from the closed
 * list (outcome.ts) and, for an error, a `code` from the closed list; a write-kind result begins with
 * one fixed line in plain text; `--source` is also global; help and describe say what an agent needs.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { ChangeStore, type NewChange } from '../../src/main/changes'
import { acquireOwnerLock, releaseOwnerLock } from '../../src/main/owner-lock'
import { Workspace } from '../../src/main/workspace'
import { ERROR_CODES, ERROR_OUTCOME, OUTCOMES, OUTCOME_LINES, type Outcome } from '../../src/main/cli/outcome'
import { MAX_UNDECIDED_PER_SOURCE } from '../../src/main/cli/review-format'
import { parseInvocation } from '../../src/main/cli/args'
import { runCli } from '../../src/main/cli/run'
import { buildOperationTable, outcomesOf } from '../../src/main/cli/table'
import { writeFixture, type CliRun, type WriteFixture } from '../helpers/cli-write-fixture'
import { inboxNames, openAsApp, type AppSide } from '../helpers/request-app'

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
const table = buildOperationTable()

/** Plain text, as an agent sees it: what stdout and stderr carried, and the exit code. */
async function plain(argv: string[], env: Partial<Parameters<typeof runCli>[1]> = {}): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await runCli(['--root', fx.root, ...argv], { cwd: tmpdir(), stdout: (t) => { out += t }, stderr: (t) => { err += t }, openUrl: async () => {}, write: { keyFolders: [fx.keys], appDataFolders: [fx.appData], ...QUICK.write }, ...env })
  return { code, out, err }
}

/** Answers every request in the inbox with a file that is not a reply, as something else writing the outbox would. */
function plantingJunk(): () => void {
  const watching = setInterval(() => { void inboxNames(fx).then((names) => Promise.all(names.map((name) => writeFile(join(fx.root, '.writeflex/outbox', name), '{"junk":1}')))).catch(() => {}) }, 5)
  return () => clearInterval(watching)
}

const unsettle = async (): Promise<void> => {
  const ledger = new ChangeStore(new Workspace(fx.root))
  const change: NewChange = { path: 'notes.md', provenance: 'agent', editClass: 'content', summary: 'Reworded', oldText: 'See', newText: 'Look at', isCorrection: false }
  await ledger.add({ ...change, status: 'accepted' })
}

type Seen = { label: string; operation: string; outcome: string; code: number; run: CliRun }
const seen: Seen[] = []
async function drive(label: string, argv: string[], env?: Parameters<WriteFixture['cli']>[1]): Promise<CliRun> {
  const run = await fx.cli(argv, env)
  seen.push({ label, operation: argv.find((word) => table.some((op) => op.name === word)) ?? argv[0], outcome: String((run.json as { outcome?: unknown }).outcome), code: run.code, run })
  return run
}

test('every result path of every operation yields one outcome from the closed list, and every error one code from the closed list', async () => {
  seen.length = 0
  const expectations: Array<[string, Outcome, number]> = []
  const expect_ = (run: CliRun, outcome: Outcome, code: number, label: string): void => { expectations.push([label, outcome, code]); expect(run.json, label).toMatchObject({ outcome }); expect(run.code, label).toBe(code) }

  // done: reads, direct writes, help, withdraw.
  expect_(await drive('read', ['files']), 'done', 0, 'read')
  expect_(await drive('help', ['help']), 'done', 0, 'help')
  expect_(await drive('direct write', ['create', 'a.md']), 'done', 0, 'direct write')
  expect_(await drive('waiting', ['waiting']), 'done', 0, 'waiting')
  // refused: a rule said no. needs-writer is separate. usage and failed.
  expect_(await drive('export unasked', ['export', 'notes.md', '--to', join(tmpdir(), 'o.html')]), 'refused', 1, 'export unasked')
  expect(seen.at(-1)!.run.json.error!.code).toBe('confirmation-needed')
  expect_(await drive('refused write', ['create', 'a.md']), 'refused', 1, 'refused write')
  expect_(await drive('usage', ['nonsense']), 'usage', 2, 'usage')
  expect_(await drive('failed', ['compare-versions', 'notes.md', 'v_nope']), 'failed', 1, 'failed')
  // filed, with no app, then withdrawn; and refused before filing.
  const filed = await drive('filed, app closed', REPLACE)
  expect_(filed, 'filed', 0, 'filed, app closed')
  expect(filed.json.result).toMatchObject({ shown: 'when-opened' })
  expect_(await drive('withdraw', ['withdraw', String(filed.json.result!.request)]), 'done', 0, 'withdraw')
  expect_(await drive('shown-first refused', ['replace', 'talks/york.md', '--target', 'Not in the document', '--with', 'x']), 'refused', 1, 'shown-first refused')
  // needs-writer: a version save with unsettled changes; the review allowance full.
  await unsettle()
  const unsettled = await drive('unsettled version', ['save-version', 'notes.md', '--name', 'Unsettled'])
  expect_(unsettled, 'needs-writer', 1, 'unsettled version')
  expect(unsettled.json.error!.code).toBe('version-unsettled')
  const store = new ChangeStore(new Workspace(fx.root))
  const roomy = { maxUndecided: 5000, maxUndecidedBytes: 1e9, maxRefused: 10, maxPerSource: 5000, maxPerRequest: 20 }
  await store.addOutside(Array.from({ length: MAX_UNDECIDED_PER_SOURCE }, (_, index) => ({
    requestId: `s-${index}`,
    changes: [{ path: 'notes.md', provenance: 'agent' as const, editClass: 'insert' as const, summary: 's', oldText: '', newText: `Seed ${index}.`, insertAfter: '', isCorrection: false, outsideSource: 'codex' as const, outsideRequest: { id: `s-${index}`, index: 1, count: 1, at: 1 } }],
  })), roomy)
  const full = await drive('allowance full', ['insert', 'notes.md', '--text', 'One more.', '--source', 'codex'])
  expect_(full, 'needs-writer', 1, 'allowance full')
  expect(full.json.error!.code).toBe('review-allowance-full')
  // not-verified: a lock that names an app, and no key.
  const lock = await acquireOwnerLock(fx.root, { kind: 'app' })
  try {
    const unverified = await drive('owner not verified', ['create', 'b.md'], QUICK)
    expect_(unverified, 'not-verified', 1, 'owner not verified')
    expect(unverified.json.error).toMatchObject({ code: 'owner-not-verified', sent: false })
  } finally {
    await releaseOwnerLock(lock)
  }

  // With the app open: answered (done, filed now), refused by the app, silent, and answered with junk.
  app = await openAsApp(fx, { changes: new ChangeStore(new Workspace(fx.root)) })
  const stop = app.answering()
  try {
    expect_(await drive('done by the app', ['create', 'c.md']), 'done', 0, 'done by the app')
    const now = await drive('filed now', REPLACE)
    expect_(now, 'filed', 0, 'filed now')
    expect(now.json.result).toMatchObject({ shown: 'now' })
    expect_(await drive('refused by the app', ['create', 'c.md']), 'refused', 1, 'refused by the app')
    const appUnsettled = await drive('unsettled version, by the app', ['save-version', 'notes.md', '--name', 'Unsettled'])
    expect_(appUnsettled, 'needs-writer', 1, 'unsettled version, by the app')
    expect(appUnsettled.json.error!.code).toBe('version-unsettled')
  } finally {
    await stop()
  }
  expect_(await drive('silent app', ['create', 'd.md'], QUICK), 'sent-not-confirmed', 3, 'silent app')
  const stopJunk = plantingJunk()
  try {
    expect_(await drive('unreadable reply', ['create', 'e.md'], { write: { request: { waitMs: 300, pollMs: 10 } } }), 'not-verified', 3, 'unreadable reply')
  } finally {
    stopJunk()
  }

  for (const run of seen.map((one) => one.run)) {
    // One vocabulary: a result carries no outcome word of its own.
    expect(run.json.result ?? {}).not.toHaveProperty('outcome')
    expect(OUTCOMES as readonly string[]).toContain((run.json as { outcome: string }).outcome)
    if (run.json.error) expect(ERROR_CODES as readonly string[]).toContain(run.json.error.code)
    if (run.json.error) expect(ERROR_OUTCOME[run.json.error.code as keyof typeof ERROR_OUTCOME]).toBe((run.json as { outcome: Outcome }).outcome)
  }
  // Each operation lists the outcomes it can return, and every outcome seen for it is among them.
  for (const one of seen) {
    const op = table.find((candidate) => candidate.name === one.operation)
    if (op) expect(outcomesOf(op), one.label).toContain(one.outcome as Outcome)
  }
  expect(new Set(expectations.map(([, outcome]) => outcome))).toEqual(new Set(OUTCOMES))
}, 60_000)

test('every code in the closed list maps to an outcome in the closed list, and every outcome has its fixed line', () => {
  for (const code of ERROR_CODES) expect(OUTCOMES as readonly string[]).toContain(ERROR_OUTCOME[code])
  for (const outcome of OUTCOMES) expect(OUTCOME_LINES[outcome]).toMatch(/:$/)
  expect(new Set(OUTCOMES.map((outcome) => OUTCOME_LINES[outcome])).size).toBe(OUTCOMES.length)
})

test('--source: before the operation name, from WRITEFLEX_SOURCE, or per operation; per operation wins, then the flag, then the environment', async () => {
  const withoutSource = REPLACE.slice(0, -2)
  const author = async (argv: string[], environ: Record<string, string> = {}): Promise<unknown> => {
    const run = await fx.cli(argv, { write: { request: { waitMs: 60, pollMs: 10 } } })
    return run.json.result
  }
  const parse = (argv: string[]) => parseInvocation(argv, table)
  expect(parse(['--source', 'codex', 'insert', 'notes.md', '--text', 'x']).source).toBe('codex')
  expect(parse(['--source=codex', 'insert', 'notes.md', '--text', 'x']).source).toBe('codex')
  expect(() => parse(['--source'])).toThrow('--source needs a value')

  expect(await author(withoutSource)).toMatchObject({ source: 'outside-agent' })
  expect(await author(['--source', 'codex', ...withoutSource])).toMatchObject({ source: 'codex' })
  expect(await author(['--source', 'codex', ...withoutSource, '--source', 'claude-code'])).toMatchObject({ source: 'claude-code' })

  // The environment, run directly so that the variable is the one passed in.
  const filedAs = async (argv: string[], environ: Record<string, string | undefined>): Promise<unknown> => {
    let out = ''
    await runCli(['--root', fx.root, '--json', ...argv], { cwd: tmpdir(), stdout: (t) => { out += t }, stderr: () => {}, environ, write: { keyFolders: [fx.keys], appDataFolders: [fx.appData] } })
    return (JSON.parse(out) as { result: unknown }).result
  }
  expect(await filedAs(withoutSource, { WRITEFLEX_SOURCE: 'codex' })).toMatchObject({ source: 'codex' })
  expect(await filedAs(['--source', 'claude-code', ...withoutSource], { WRITEFLEX_SOURCE: 'codex' })).toMatchObject({ source: 'claude-code' })
  expect(await filedAs([...withoutSource, '--source', 'claude-code'], { WRITEFLEX_SOURCE: 'codex' })).toMatchObject({ source: 'claude-code' })
  expect(await filedAs(withoutSource, { WRITEFLEX_SOURCE: '' })).toMatchObject({ source: 'outside-agent' })
  // An unknown value is passed through as declared and shown as an outside agent, as before.
  expect(await filedAs(withoutSource, { WRITEFLEX_SOURCE: 'someone' })).toMatchObject({ source: 'outside-agent' })
  // An operation with no source of its own ignores the global one.
  expect((await fx.cli(['--source', 'codex', 'files'])).json).toMatchObject({ ok: true, outcome: 'done' })
})

test('help: no name runs into its summary, each line shows its behaviour; help and describe --json carry behaviour, outcomes and arguments', async () => {
  const help = await plain(['help'])
  expect(help.code).toBe(0)
  const longest = Math.max(...table.map((op) => op.name.length))
  const labels = { direct: 'direct', 'shown-first': 'shown first', asks: 'asks' }
  for (const op of table) {
    const line = help.out.split('\n').find((candidate) => candidate.startsWith(`  ${op.name} `))
    expect(line, op.name).toBeDefined()
    expect(line!.startsWith(`  ${op.name.padEnd(longest + 2)}${labels[op.behaviour].padEnd(13)}${op.summary}`), op.name).toBe(true)
  }
  expect(help.out).toContain('normalise-frontmatter  ')
  const json = (await fx.cli(['help'])).json.result as { groups: Array<{ operations: Array<{ name: string; behaviour: string; outcomes: string[]; args: unknown[] }> }>; outcomes: Array<{ outcome: string }>; errorCodes: unknown[] }
  const operations = json.groups.flatMap((group) => group.operations)
  expect(operations).toHaveLength(table.length)
  for (const operation of operations) {
    expect(typeof operation.behaviour, operation.name).toBe('string')
    expect(Array.isArray(operation.outcomes), operation.name).toBe(true)
    expect(Array.isArray(operation.args), operation.name).toBe(true)
  }
  expect(operations.find((operation) => operation.name === 'replace')!.outcomes).toContain('filed')
  expect(operations.find((operation) => operation.name === 'files')!.outcomes).not.toContain('filed')
  expect(json.outcomes.map((one) => one.outcome)).toEqual([...OUTCOMES])
  const described = (await fx.cli(['describe', 'save-version'])).json.result as { behaviour: string; outcomes: string[]; args: unknown[]; example: string }
  expect(described.behaviour).toBe('direct')
  expect(described.outcomes).toContain('needs-writer')
  expect(described.example).toContain('writeflex save-version')
  expect(Array.isArray(described.args)).toBe(true)
  // describe in plain text ends with one example; every operation has one.
  for (const op of table) {
    const text = (await plain(['describe', op.name])).out.trimEnd().split('\n')
    expect(text.at(-2), op.name).toBe('Example:')
    expect(text.at(-1)!.trim().startsWith('writeflex '), op.name).toBe(true)
  }
  const undo = (await plain(['describe', 'undo'])).out
  expect(undo).toContain('NOT undone')
  expect(undo).toContain('undo never deletes')
})

test('plain text: a write-kind result begins with the fixed line of its outcome; a read is unchanged', async () => {
  const first = (text: string): string => text.split('\n')[0]
  // direct, done
  expect(first((await plain(['create', 'a.md'])).out)).toBe('Done:')
  // shown first, filed (app closed), with where it is
  const filed = await plain(REPLACE)
  expect(filed.code).toBe(0)
  expect(first(filed.out)).toBe('Waiting for review in WriteFlex (not applied):')
  expect(filed.out).toContain('when the Collection is next opened')
  // asks, refused
  const refused = await plain(['export', 'notes.md', '--to', join(tmpdir(), 'o.html')])
  expect(refused.code).toBe(1)
  expect(refused.err).toContain('writeflex: Refused: Export refused')
  // needs the writer first
  await unsettle()
  expect((await plain(['save-version', 'notes.md', '--name', 'U'])).err).toContain('writeflex: The writer must act in WriteFlex first: ')
  // a read stays pipeable: exactly its own text
  const read = await plain(['read', 'notes.md'])
  expect(read.out).toBe(await fx.read('notes.md'))
  expect((await plain(['files'])).out.split('\n')[0]).not.toMatch(/:$/)
  // the app open: filed now; silent; unverified
  app = await openAsApp(fx, { changes: new ChangeStore(new Workspace(fx.root)) })
  const silent = await plain(['create', 'd.md'])
  expect(silent.code).toBe(3)
  expect(first(silent.out)).toBe('Sent to WriteFlex, not confirmed:')
  const stop = app.answering()
  try {
    const now = await plain(['insert', 'notes.md', '--text', 'More.', '--source', 'codex'])
    expect(first(now.out)).toBe('Waiting for review in WriteFlex (not applied):')
    expect(now.out).toContain("It is in WriteFlex's review dock now.")
    expect(first((await plain(['create', 'f.md'])).out)).toBe('Done:')
  } finally {
    await stop()
  }
  const stopJunk = plantingJunk()
  try {
    const junk = await plain(['create', 'e.md'], { write: { keyFolders: [fx.keys], appDataFolders: [fx.appData], request: { waitMs: 300, pollMs: 10 } } })
    expect(junk.code).toBe(3)
    expect(first(junk.out)).toBe('Could not be verified:')
    expect(junk.out).toContain('WAS sent')
  } finally {
    stopJunk()
  }
}, 30_000)
