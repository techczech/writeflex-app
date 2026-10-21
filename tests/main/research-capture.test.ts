import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityContext } from '@bridle/core'
import { buildWriteFlexManifest } from '../../src/main/capabilities'
import { captureArgv, captureInWorkspace, captureProjectFor, captureResearch, firstJsonObject, type CaptureInput } from '../../src/main/research-capture'
import { MANIFEST_NAME } from '../../src/main/folio'
import { registerResearchCaptureIpc } from '../../src/main/research-capture-ipc'
import { Workspace } from '../../src/main/workspace'
import { pauseCollectionWrites, resumeCollectionWrites } from '../../src/main/collection-write-gate'
import { researchCaptureTarget } from '../../src/renderer/src/app/research-capture-target'
import { ownerLockPath } from '../../src/main/owner-lock'
import { writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

// The verb seam of "Capture to research": a fake `scout` on the environment records its argv (one line per
// argument) and standard input, and prints the contract's JSON (or fails). No real engine runs and the verb
// itself writes no file.
let dir = ''
let fake = ''
let project = ''
const argvLog = () => join(dir, 'argv.log')
const stdinLog = () => join(dir, 'stdin.log')
const recordedArgv = async (): Promise<string[]> => (await readFile(argvLog(), 'utf8')).split('\n').filter(Boolean)

async function writeFake(options: { stdout?: string; code?: number; stderr?: string } = {}): Promise<void> {
  const stdout = options.stdout ?? JSON.stringify({ file: `${project}/research/2026-10-20-hebb.md`, manifest: true, corpus: 'writing', indexed: true, passages: 3 })
  await writeFile(join(dir, 'stdout.json'), stdout)
  await writeFile(join(dir, 'stderr.txt'), options.stderr ?? '')
  await writeFile(fake, `#!/bin/sh
: > "${argvLog()}"
for arg in "$@"; do printf '%s\\n' "$arg" >> "${argvLog()}"; done
cat > "${stdinLog()}"
cat "${join(dir, 'stderr.txt')}" >&2
cat "${join(dir, 'stdout.json')}"
exit ${options.code ?? 0}
`)
  await chmod(fake, 0o755)
}

beforeAll(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'wf-capture-')))
  fake = join(dir, 'scout')
  project = join(dir, 'talk')
  await mkdir(project)
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const input = (extra: Partial<CaptureInput> = {}): CaptureInput => ({ projectDir: project, title: 'Hebb\'s rule, one line', kind: 'evidence', body: 'Cells that fire together wire together.\n', ...extra })
const env = () => ({ override: fake })

test('spawns scout capture with the contract\'s argv, the body on standard input, and returns the parsed answer', async () => {
  await writeFake()
  const result = await captureResearch(
    input({ prompt: 'the biology rule', sources: ['scout:highlights:readings/works/hebb-1949.md:12', 'https://example.org/paper'], artefact: '/tmp/hebb-table.html' }),
    env(),
  )
  expect(result).toEqual({ ok: true, file: `${project}/research/2026-10-20-hebb.md`, corpus: 'writing', indexed: true })
  expect(await recordedArgv()).toEqual([
    'capture', '--project', project, '--kind', 'evidence', '--title', 'Hebb\'s rule, one line',
    '--prompt', 'the biology rule',
    '--source', 'scout:highlights:readings/works/hebb-1949.md:12', '--source', 'https://example.org/paper',
    '--artefact', '/tmp/hebb-table.html',
    '--by', 'app:writeflex', '--json', '-',
  ])
  expect(await readFile(stdinLog(), 'utf8')).toBe('Cells that fire together wire together.\n')
})

test('leaves out the optional flags that were not given, and spells a value that begins with a dash as --flag=value', async () => {
  await writeFake()
  await captureResearch(input({ title: '-1 degrees', prompt: '   ', sources: [''] }), env())
  expect(await recordedArgv()).toEqual(['capture', '--project', project, '--kind', 'evidence', '--title=-1 degrees', '--by', 'app:writeflex', '--json', '-'])
  expect(captureArgv(input({ kind: 'table' })).slice(0, 5)).toEqual(['capture', '--project', project, '--kind', 'table'])
})

test('scout\'s schema_version and unknown keys are tolerated; only file is required', async () => {
  await writeFake({ stdout: JSON.stringify({ schema_version: 1, file: `${project}/research/a.md`, artefact: 'research/a.png', extra: [1] }) })
  expect(await captureResearch(input(), env())).toEqual({ ok: true, file: `${project}/research/a.md`, corpus: null, indexed: false })
})

test('a corpus-less capture reports corpus null and not indexed; a relative file is read against the project', async () => {
  await writeFake({ stdout: JSON.stringify({ file: 'research/2026-10-20-x.md', manifest: true, corpus: null, indexed: false, passages: 0 }) })
  expect(await captureResearch(input(), env())).toEqual({ ok: true, file: join(project, 'research/2026-10-20-x.md'), corpus: null, indexed: false })
})

test('no scout binary: a typed error, nothing spawned', async () => {
  await writeFake()
  await writeFile(argvLog(), 'untouched\n')
  const missing = await captureResearch(input(), { override: join(dir, 'no-such-scout') })
  expect(missing).toMatchObject({ ok: false, code: 'scout-missing' })
  expect((missing as { message: string }).message).toContain('scout')
  expect(await readFile(argvLog(), 'utf8')).toBe('untouched\n')
})

test('a non-zero exit is a capture-failed error with a plain sentence by class; scout\'s text goes to detail only', async () => {
  await writeFake({ code: 1, stderr: 'scout: note: reading the registry\nscout: the research folder /tmp/example-private/talk/research is read-only' })
  const result = await captureResearch(input(), env())
  expect(result).toEqual({
    ok: false, code: 'capture-failed',
    message: 'The research folder is not writable, so nothing was captured.',
    detail: 'scout: note: reading the registry\nscout: the research folder /tmp/example-private/talk/research is read-only',
  })
  await writeFake({ code: 1, stderr: 'scout: boom at /tmp/example-private/x' })
  const other = await captureResearch(input(), env()) as { message: string; detail?: string }
  expect(other.message).toBe('Scout could not file this capture, so nothing was captured.')
  expect(other.message).not.toContain('/tmp/example-private')
  expect(other.detail).toContain('/tmp/example-private/x')
})

test('a timeout is reported as a plain sentence', async () => {
  await writeFake()
  await writeFile(fake, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })
  const result = await captureResearch(input(), env(), { timeoutMs: 100 })
  expect(result).toMatchObject({ ok: false, code: 'capture-failed', message: expect.stringContaining('took too long') })
})

test('scout\'s answer is the first complete JSON object: trailing output and leading blank lines are ignored', async () => {
  const object = JSON.stringify({ file: `${project}/research/t.md`, corpus: 'writing', indexed: true })
  const expected = { ok: true, file: `${project}/research/t.md`, corpus: 'writing', indexed: true }
  await writeFake({ stdout: `${object}\nIndex complete\n` })
  expect(await captureResearch(input(), env())).toEqual(expected)
  await writeFake({ stdout: `\n\n  \n${object}\n` })
  expect(await captureResearch(input(), env())).toEqual(expected)
  await writeFake({ stdout: `note: building\n${object}\ndone {not json}\n` })
  expect(await captureResearch(input(), env())).toEqual(expected)
  expect(firstJsonObject('{\n  "file": "a{b}.md",\n  "x": {"y": 1}\n}\ntrailing')).toEqual({ file: 'a{b}.md', x: { y: 1 } })
  expect(firstJsonObject('Index complete\n[1,2]')).toBeNull()
  // The first TOP-LEVEL object wins: a nested object that happens to sit on a line of its own, or a later one-line object, does not.
  expect(firstJsonObject('building index\n{\n  "file": "a.md",\n  "meta":\n{"schema_version":1}\n,\n  "indexed": true\n}\n')).toEqual({ file: 'a.md', meta: { schema_version: 1 }, indexed: true })
  expect(firstJsonObject('{\n  "file": "a.md"\n}\n{"diagnostic":true}\n')).toEqual({ file: 'a.md' })
  expect(firstJsonObject('{"file":"a.md"}\n{"diagnostic":true}\n')).toEqual({ file: 'a.md' })
  expect(firstJsonObject('{"file":"}{\\"}","note":"{{"}\ntail')).toEqual({ file: '}{"}', note: '{{' })
  expect(firstJsonObject('no object here at all')).toBeNull()
  expect(firstJsonObject('{unbalanced')).toBeNull()
  await writeFake({ stdout: 'Index complete\n' })
  expect(await captureResearch(input(), env())).toMatchObject({ ok: false, code: 'unreadable-output' })
})

test('a project that is not a folder is refused before scout is run', async () => {
  await writeFake()
  await writeFile(argvLog(), 'untouched\n')
  expect(await captureResearch(input({ projectDir: join(dir, 'nowhere') }), env())).toMatchObject({ ok: false, code: 'not-a-directory' })
  expect(await captureResearch(input({ projectDir: fake }), env())).toMatchObject({ ok: false, code: 'not-a-directory' })
  expect(await captureResearch(input({ projectDir: 'talk' }), env())).toMatchObject({ ok: false, code: 'not-a-directory' })
  expect(await readFile(argvLog(), 'utf8')).toBe('untouched\n')
})

test('an unknown kind or a blank title is refused; an answer without a file is reported as unreadable', async () => {
  await writeFake()
  expect(await captureResearch(input({ kind: 'poem' as never }), env())).toMatchObject({ ok: false, code: 'invalid' })
  expect(await captureResearch(input({ title: '  ' }), env())).toMatchObject({ ok: false, code: 'invalid' })
  await writeFake({ stdout: 'not json' })
  expect(await captureResearch(input(), env())).toMatchObject({ ok: false, code: 'unreadable-output' })
  await writeFake({ stdout: '{"indexed":true}' })
  expect(await captureResearch(input(), env())).toMatchObject({ ok: false, code: 'unreadable-output' })
})

// --- Folio versus Piece: which folder is the project ----------------------------------------------------
let root = ''
let ws: Workspace
beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf-capture-ws-')))
  ws = new Workspace(root)
  await mkdir(join(root, 'report/part'), { recursive: true })
  await mkdir(join(root, 'essays/long-post'), { recursive: true })
  await writeFile(join(root, 'report', MANIFEST_NAME), `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'one.md', role: 'section' }] })}\n`)
  await writeFile(join(root, 'report/one.md'), '# One\n')
  await writeFile(join(root, 'report/part/two.md'), '# Two\n')
  await writeFile(join(root, 'essays/loose.md'), '# Loose\n')
  await writeFile(join(root, 'essays/long-post/long-post.md'), '# Long\n')
  await writeFile(join(root, 'essays/long-post/figure.png'), 'png')
  await writeFile(join(root, 'top.md'), '# Top\n')
  await mkdir(join(root, '.writeflex'))
  await writeFile(join(root, '.writeflex/state.md'), 'x')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test('a Piece in a Folio is captured to the Folio folder; any other Piece to its own folder; a folder to itself', async () => {
  expect(await captureProjectFor(ws, 'report/one.md')).toEqual({ dir: 'report', absolute: join(root, 'report'), folio: true })
  expect(await captureProjectFor(ws, 'report/part/two.md')).toMatchObject({ dir: 'report', folio: true })
  expect(await captureProjectFor(ws, 'essays/loose.md')).toEqual({ dir: 'essays', absolute: join(root, 'essays'), folio: false })
  expect(await captureProjectFor(ws, 'essays/long-post/long-post.md')).toMatchObject({ dir: 'essays/long-post', folio: false })
  expect(await captureProjectFor(ws, 'top.md')).toEqual({ dir: '', absolute: root, folio: false })
  expect(await captureProjectFor(ws, 'report')).toMatchObject({ dir: 'report' })
  await expect(captureProjectFor(ws, 'missing.md')).rejects.toThrow('does not exist')
  await expect(captureProjectFor(ws, '../elsewhere.md')).rejects.toThrow()
  await expect(captureProjectFor(ws, '.writeflex/state.md')).rejects.toThrow('keeps for itself')
})

test('captureInWorkspace runs scout in the resolved folder and reports the filed path relative to the Workspace', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'report/research/2026-10-20-x.md'), manifest: true, corpus: 'writing', indexed: true, passages: 1 }) })
  const result = await captureInWorkspace(ws, { project: 'report/part/two.md', title: 'X', kind: 'snippet', body: 'x' }, env())
  expect(result).toEqual({ ok: true, file: 'report/research/2026-10-20-x.md', corpus: 'writing', indexed: true, project: 'report' })
  expect((await recordedArgv())[2]).toBe(join(root, 'report'))
  await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'Y', kind: 'snippet', body: 'y' }, env())
  expect((await recordedArgv())[2]).toBe(join(root, 'essays'))
})

test('an artefact must be a visible file of the Workspace: nothing from elsewhere on the disk is pulled into research/', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'essays/research/a.md'), corpus: null, indexed: false }) })
  const outside = await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'A', kind: 'widget', body: 'a', artefact: join(dir, 'scout') }, env())
  expect(outside).toMatchObject({ ok: false, code: 'invalid' })
  for (const artefact of ['-', '../outside.png', '/etc/hosts', '.writeflex/state.md', 'essays/missing.png']) {
    await writeFile(argvLog(), 'untouched\n')
    expect(await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'A', kind: 'widget', body: 'a', artefact }, env()), artefact).toMatchObject({ ok: false, code: 'invalid' })
    expect(await readFile(argvLog(), 'utf8'), `${artefact} must not reach scout`).toBe('untouched\n')
  }
  const inside = await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'A', kind: 'widget', body: 'a', artefact: 'essays/long-post/figure.png' }, env())
  expect(inside.ok).toBe(true)
  expect(await recordedArgv()).toContain(join(root, 'essays/long-post/figure.png'))
})

test('an artefact that is a link to a tooling folder inside the Workspace (out/, release/, node_modules/) is refused, as the sidebar hides it, and scout is not spawned', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'essays/research/a.md'), corpus: null, indexed: false }) })
  await mkdir(join(root, 'out'), { recursive: true })
  await writeFile(join(root, 'out/secret.png'), 'built')
  await symlink(join(root, 'out/secret.png'), join(root, 'essays/out-link.png'))
  await writeFile(argvLog(), 'untouched\n')
  expect(await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'A', kind: 'widget', body: 'a', artefact: 'essays/out-link.png' }, env())).toMatchObject({
    ok: false, code: 'invalid', message: expect.stringContaining('not a file in this Workspace'),
  })
  expect(await readFile(argvLog(), 'utf8')).toBe('untouched\n')
})

test('an artefact swapped for a link to a tooling folder inside the Workspace after validation is refused, and scout is not spawned', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'essays/research/a.md'), corpus: null, indexed: false }) })
  await mkdir(join(root, 'out'), { recursive: true })
  await writeFile(join(root, 'out/secret.png'), 'built')
  await writeFile(argvLog(), 'untouched\n')
  const result = await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'A', kind: 'widget', body: 'a', artefact: 'essays/long-post/figure.png' }, env(), undefined, {
    seams: { afterValidated: async () => { await rm(join(root, 'essays/long-post/figure.png')); await symlink(join(root, 'out/secret.png'), join(root, 'essays/long-post/figure.png')) } },
  })
  expect(result).toMatchObject({ ok: false, code: 'invalid', message: expect.stringContaining('not a file in this Workspace') })
  expect(await readFile(argvLog(), 'utf8')).toBe('untouched\n')
})

test('a dot-named file in a visible folder is accepted as an artefact', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'essays/research/a.md'), corpus: null, indexed: false }) })
  await writeFile(join(root, 'essays/.draft.png'), 'draft')
  const result = await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'A', kind: 'widget', body: 'a', artefact: 'essays/.draft.png' }, env())
  expect(result.ok).toBe(true)
  expect(await recordedArgv()).toContain(join(root, 'essays/.draft.png'))
})

test('an artefact that is a link to a file outside the Workspace is refused, and scout is not spawned', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'essays/research/a.md'), corpus: null, indexed: false }) })
  const elsewhere = realpathSync(await mkdtemp(join(tmpdir(), 'wf-capture-out-')))
  try {
    await writeFile(join(elsewhere, 'secret.png'), 'outside')
    await symlink(join(elsewhere, 'secret.png'), join(root, 'essays/link.png'))
    await writeFile(argvLog(), 'untouched\n')
    expect(await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'A', kind: 'widget', body: 'a', artefact: 'essays/link.png' }, env())).toMatchObject({
      ok: false, code: 'invalid', message: expect.stringContaining('not a file in this Workspace'),
    })
    expect(await readFile(argvLog(), 'utf8')).toBe('untouched\n')
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
  }
})

test('an artefact inside the Workspace reaches scout as its canonical real path, not as the link it was given', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'essays/research/a.md'), corpus: null, indexed: false }) })
  await symlink(join(root, 'essays/long-post/figure.png'), join(root, 'essays/figure-link.png'))
  const result = await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'A', kind: 'widget', body: 'a', artefact: 'essays/figure-link.png' }, env())
  expect(result.ok).toBe(true)
  const argv = await recordedArgv()
  expect(argv[argv.indexOf('--artefact') + 1]).toBe(join(root, 'essays/long-post/figure.png'))
})

test('an artefact swapped for a link out of the Workspace after it was validated is refused, and scout is not spawned', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'essays/research/a.md'), corpus: null, indexed: false }) })
  const elsewhere = realpathSync(await mkdtemp(join(tmpdir(), 'wf-capture-out-')))
  try {
    await writeFile(join(elsewhere, 'secret.png'), 'outside')
    await writeFile(argvLog(), 'untouched\n')
    const result = await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'A', kind: 'widget', body: 'a', artefact: 'essays/long-post/figure.png' }, env(), undefined, {
      seams: { afterValidated: async () => { await rm(join(root, 'essays/long-post/figure.png')); await symlink(join(elsewhere, 'secret.png'), join(root, 'essays/long-post/figure.png')) } },
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid', message: expect.stringContaining('not a file in this Workspace') })
    expect(await readFile(argvLog(), 'utf8')).toBe('untouched\n')
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
  }
})

test('the agent capability research.capture files through the same verb', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'report/research/2026-10-20-agent.md'), corpus: 'writing', indexed: true }) })
  const saved = process.env.WRITEFLEX_SCOUT_BIN
  process.env.WRITEFLEX_SCOUT_BIN = fake
  try {
    const capability = buildWriteFlexManifest(ws).capabilities.find((candidate) => candidate.name === 'research.capture')!
    expect(capability.risk).toBe('write')
    const ctx: CapabilityContext = { trigger: { id: 't', source: 'user', trust: 'interactive' }, sessionId: 's', attemptId: 'a', idempotencyKey: 'a', audit: () => {} }
    const done = await capability.execute({ project: 'report/one.md', title: 'Agent table', kind: 'table', sources: ['scout:writing:a.md:3'], body: '| a | b |\n' }, ctx)
    expect(done.isError).toBeUndefined()
    expect(done.text).toContain('report/research/2026-10-20-agent.md')
    expect(await readFile(stdinLog(), 'utf8')).toBe('| a | b |\n')
    expect(await recordedArgv()).toContain('--source')
    const refused = await capability.execute({ project: 'nowhere.md', title: 'T', kind: 'table', body: 'b' }, ctx)
    expect(refused.isError).toBe(true)
  } finally {
    if (saved === undefined) delete process.env.WRITEFLEX_SCOUT_BIN
    else process.env.WRITEFLEX_SCOUT_BIN = saved
  }
})

// --- the command line -----------------------------------------------------------------------------------
test('writeflex capture forwards to the verb with the app closed, and reports the Collection-relative file', async () => {
  const fx: WriteFixture = await writeFixture()
  const saved = process.env.WRITEFLEX_SCOUT_BIN
  process.env.WRITEFLEX_SCOUT_BIN = fake
  try {
    await writeFake({ stdout: JSON.stringify({ file: join(fx.root, 'talks/research/2026-10-20-t.md'), manifest: true, corpus: null, indexed: false }) })
    const run = await fx.cli(['capture', 'talks/york.md', '--kind', 'table', '--title', 'T', '--sources', 'scout:a:b.md:1\nhttps://example.org', '--stdin'], { stdin: '| x |\n' })
    expect(run.json.error?.message ?? '').toBe('')
    expect(run.code).toBe(0)
    expect(run.json.result).toMatchObject({ path: 'talks/research/2026-10-20-t.md', project: 'talks', corpus: null, indexed: false })
    expect(await readFile(stdinLog(), 'utf8')).toBe('| x |\n')
    expect(await recordedArgv()).toEqual(expect.arrayContaining(['--source', 'scout:a:b.md:1', 'https://example.org', 'app:writeflex']))
    const bad = await fx.cli(['capture', 'notes.md', '--kind', 'poem', '--title', 'T', '--body', 'b'])
    expect(bad.code).toBe(2)
    await writeFake({ code: 1, stderr: 'scout: no such project' })
    const failed = await fx.cli(['capture', 'notes.md', '--kind', 'snippet', '--title', 'T', '--body', 'b'])
    expect(failed.code).toBe(1)
    expect(failed.json.error?.message).not.toContain('no such project')
    expect(failed.json.error?.message).toContain('Scout could not file this capture')
  } finally {
    if (saved === undefined) delete process.env.WRITEFLEX_SCOUT_BIN
    else process.env.WRITEFLEX_SCOUT_BIN = saved
    await fx.dispose()
  }
})

test('with the app closed, an owner lock replaced after validation and before the spawn stops the capture: scout is not spawned and the ownership error is returned', async () => {
  const fx: WriteFixture = await writeFixture()
  const saved = process.env.WRITEFLEX_SCOUT_BIN
  process.env.WRITEFLEX_SCOUT_BIN = fake
  try {
    await writeFake({ stdout: JSON.stringify({ file: join(fx.root, 'talks/research/2026-10-20-t.md'), corpus: null, indexed: false }) })
    await writeFile(argvLog(), 'untouched\n')
    const stolen = { version: 1, pid: process.pid, kind: 'app', host: hostname(), startedAt: Date.now(), heartbeatAt: Date.now(), processStartedAt: null, token: 'planted' }
    const run = await fx.cli(['capture', 'talks/york.md', '--kind', 'snippet', '--title', 'T', '--body', 'b'], {
      write: { seams: { beforeWrite: async () => { await writeFile(ownerLockPath(fx.root), JSON.stringify(stolen)) } } },
    })
    expect(run.code).toBe(1)
    expect(run.json.error?.code).toBe('owner-lock-lost')
    expect(await readFile(argvLog(), 'utf8')).toBe('untouched\n')
    expect(existsSync(join(fx.root, 'talks/research'))).toBe(false)
  } finally {
    if (saved === undefined) delete process.env.WRITEFLEX_SCOUT_BIN
    else process.env.WRITEFLEX_SCOUT_BIN = saved
    await fx.dispose()
  }
})

/** Pauses the Collection's writes the moment the project is first judged: after every early look at the gate, before the spawn. */
function pauseWhenProjectJudged(workspace: Workspace): void {
  const original = workspace.classifyPath.bind(workspace)
  let paused = false
  workspace.classifyPath = ((...args: Parameters<Workspace['classifyPath']>) => {
    if (!paused) { paused = true; pauseCollectionWrites(workspace.root, 'Another WriteFlex window holds this Collection, so it is read-only here.') }
    return original(...args)
  }) as Workspace['classifyPath']
}

test('writes paused after the project was validated: scout is not spawned, from the verb, the capability and the sheet', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'essays/research/a.md'), corpus: null, indexed: false }) })
  const saved = process.env.WRITEFLEX_SCOUT_BIN
  process.env.WRITEFLEX_SCOUT_BIN = fake
  try {
    await writeFile(argvLog(), 'untouched\n')
    // The verb, paused in the seam between validation and the spawn.
    const direct = await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'A', kind: 'snippet', body: 'a' }, env(), undefined, {
      seams: { afterValidated: async () => { pauseCollectionWrites(root, 'Another WriteFlex window holds this Collection, so it is read-only here.') } },
    })
    expect(direct).toMatchObject({ ok: false, code: 'writes-paused' })
    resumeCollectionWrites(root)
    pauseWhenProjectJudged(ws)
    const capability = buildWriteFlexManifest(ws).capabilities.find((candidate) => candidate.name === 'research.capture')!
    const ctx: CapabilityContext = { trigger: { id: 't', source: 'user', trust: 'interactive' }, sessionId: 's', attemptId: 'a', idempotencyKey: 'a', audit: () => {} }
    const refused = await capability.execute({ project: 'essays/loose.md', title: 'T', kind: 'table', body: 'b' }, ctx)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('read-only')
    resumeCollectionWrites(root)
    ws = new Workspace(root)
    pauseWhenProjectJudged(ws)
    const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => unknown>()
    registerResearchCaptureIpc<string>({ handle: (channel, handler) => handlers.set(channel, handler) }, { stateForSender: () => 's', requireWorkspace: () => ws, filed: () => {} })
    const sheet = await handlers.get('research:capture')!({ sender: { id: 1 } }, { project: 'essays/loose.md', title: 'S', kind: 'evidence', body: 'b' })
    expect(sheet).toMatchObject({ ok: false, code: 'writes-paused' })
    expect(await readFile(argvLog(), 'utf8')).toBe('untouched\n')
  } finally {
    resumeCollectionWrites(root)
    if (saved === undefined) delete process.env.WRITEFLEX_SCOUT_BIN
    else process.env.WRITEFLEX_SCOUT_BIN = saved
  }
})

// --- the sheet's call ------------------------------------------------------------------------------------
test('research:capture answers the sheet with a Workspace-relative file or a sentence, and tells the window what was filed', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'report/research/2026-10-20-s.md'), corpus: 'writing', indexed: true }) })
  const saved = process.env.WRITEFLEX_SCOUT_BIN
  process.env.WRITEFLEX_SCOUT_BIN = fake
  const filed: string[] = []
  const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => unknown>()
  registerResearchCaptureIpc<string>({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: (id) => `window-${id}`, requireWorkspace: () => ws, filed: (_state, path) => filed.push(path),
  })
  const invoke = (input: unknown) => handlers.get('research:capture')!({ sender: { id: 3 } }, input) as Promise<unknown>
  try {
    expect(await invoke({ project: 'report/one.md', title: 'S', kind: 'evidence', body: 'b', prompt: 'p' }))
      .toEqual({ ok: true, file: 'report/research/2026-10-20-s.md', project: 'report', corpus: 'writing', indexed: true })
    expect(filed).toEqual(['report/research/2026-10-20-s.md'])
    expect(await invoke({ project: 'report/one.md', title: 'S', kind: 'poem', body: 'b' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await invoke(null)).toMatchObject({ ok: false, code: 'invalid' })
    expect(await invoke({ project: 'gone.md', title: 'S', kind: 'evidence', body: 'b' })).toMatchObject({ ok: false, code: 'not-a-directory' })
    expect(filed).toHaveLength(1)
  } finally {
    if (saved === undefined) delete process.env.WRITEFLEX_SCOUT_BIN
    else process.env.WRITEFLEX_SCOUT_BIN = saved
  }
})

// --- review fixes ----------------------------------------------------------------------------------------
test('scout is given the canonical path of the project, and a folder that is a link out of the Workspace is refused', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'real/research/a.md'), corpus: null, indexed: false }) })
  await mkdir(join(root, 'real'))
  await symlink(join(root, 'real'), join(root, 'alias'))
  await writeFile(join(root, 'real/p.md'), '# P\n')
  const result = await captureInWorkspace(ws, { project: 'alias', title: 'A', kind: 'snippet', body: 'a' }, env())
  expect(result.ok).toBe(true)
  expect((await recordedArgv())[2]).toBe(join(root, 'real'))
  const elsewhere = realpathSync(await mkdtemp(join(tmpdir(), 'wf-capture-out-')))
  try {
    await symlink(elsewhere, join(root, 'escape'))
    await writeFile(argvLog(), 'untouched\n')
    expect(await captureInWorkspace(ws, { project: 'escape', title: 'A', kind: 'snippet', body: 'a' }, env())).toMatchObject({ ok: false, code: 'not-a-directory' })
    expect(await readFile(argvLog(), 'utf8')).toBe('untouched\n')
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
  }
})

test('a project swapped for a link out of the Workspace after it was validated is refused, and scout is not spawned', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'essays/research/a.md'), corpus: null, indexed: false }) })
  const elsewhere = realpathSync(await mkdtemp(join(tmpdir(), 'wf-capture-out-')))
  try {
    await writeFile(argvLog(), 'untouched\n')
    const result = await captureInWorkspace(ws, { project: 'essays', title: 'A', kind: 'snippet', body: 'a' }, env(), undefined, {
      seams: { afterValidated: async () => { await rename(join(root, 'essays'), join(root, 'essays-moved')); await symlink(elsewhere, join(root, 'essays')) } },
    })
    expect(result).toMatchObject({ ok: false, code: 'not-a-directory' })
    expect(await readFile(argvLog(), 'utf8')).toBe('untouched\n')
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
  }
})

test('with writes paused, scout is not spawned and the gate\'s own refusal comes back from the verb, the capability and the sheet', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'essays/research/a.md'), corpus: null, indexed: false }) })
  pauseCollectionWrites(root, 'Another WriteFlex window holds this Collection, so it is read-only here.')
  const saved = process.env.WRITEFLEX_SCOUT_BIN
  process.env.WRITEFLEX_SCOUT_BIN = fake
  try {
    await writeFile(argvLog(), 'untouched\n')
    const direct = await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'A', kind: 'snippet', body: 'a' }, env())
    expect(direct).toMatchObject({ ok: false, code: 'writes-paused' })
    expect((direct as { message: string }).message).toContain('read-only')
    const capability = buildWriteFlexManifest(ws).capabilities.find((candidate) => candidate.name === 'research.capture')!
    const ctx: CapabilityContext = { trigger: { id: 't', source: 'user', trust: 'interactive' }, sessionId: 's', attemptId: 'a', idempotencyKey: 'a', audit: () => {} }
    const refused = await capability.execute({ project: 'essays/loose.md', title: 'T', kind: 'table', body: 'b' }, ctx)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('read-only')
    const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => unknown>()
    const filed: string[] = []
    registerResearchCaptureIpc<string>({ handle: (channel, handler) => handlers.set(channel, handler) }, { stateForSender: () => 's', requireWorkspace: () => ws, filed: (_s, path) => filed.push(path) })
    const sheet = await handlers.get('research:capture')!({ sender: { id: 1 } }, { project: 'essays/loose.md', title: 'S', kind: 'evidence', body: 'b' })
    expect(sheet).toMatchObject({ ok: false, code: 'writes-paused' })
    expect(filed).toEqual([])
    expect(await readFile(argvLog(), 'utf8')).toBe('untouched\n')
  } finally {
    resumeCollectionWrites(root)
    if (saved === undefined) delete process.env.WRITEFLEX_SCOUT_BIN
    else process.env.WRITEFLEX_SCOUT_BIN = saved
  }
})

test('scout\'s stderr never reaches the sheet, the agent or the command line', async () => {
  await writeFake({ code: 1, stderr: 'scout: cannot open /tmp/example-private/secret/dir' })
  const saved = process.env.WRITEFLEX_SCOUT_BIN
  process.env.WRITEFLEX_SCOUT_BIN = fake
  const warn = console.warn
  const logged: string[] = []
  console.warn = (...parts: unknown[]) => { logged.push(parts.join(' ')) }
  try {
    const direct = await captureInWorkspace(ws, { project: 'essays/loose.md', title: 'A', kind: 'snippet', body: 'a' }, env())
    expect(JSON.stringify(direct)).not.toContain('/tmp/example-private')
    expect(direct).not.toHaveProperty('detail')
    expect(logged.join('\n')).toContain('/tmp/example-private/secret/dir')
    const capability = buildWriteFlexManifest(ws).capabilities.find((candidate) => candidate.name === 'research.capture')!
    const ctx: CapabilityContext = { trigger: { id: 't', source: 'user', trust: 'interactive' }, sessionId: 's', attemptId: 'a', idempotencyKey: 'a', audit: () => {} }
    const refused = await capability.execute({ project: 'essays/loose.md', title: 'T', kind: 'table', body: 'b' }, ctx)
    expect(JSON.stringify(refused)).not.toContain('/tmp/example-private')
    const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => unknown>()
    registerResearchCaptureIpc<string>({ handle: (channel, handler) => handlers.set(channel, handler) }, { stateForSender: () => 's', requireWorkspace: () => ws, filed: () => {} })
    const sheet = await handlers.get('research:capture')!({ sender: { id: 1 } }, { project: 'essays/loose.md', title: 'S', kind: 'evidence', body: 'b' })
    expect(JSON.stringify(sheet)).not.toContain('/tmp/example-private')
  } finally {
    console.warn = warn
    if (saved === undefined) delete process.env.WRITEFLEX_SCOUT_BIN
    else process.env.WRITEFLEX_SCOUT_BIN = saved
  }
})

test('the visible surface decides the project: a Plan, Collection or Board view wins over a Piece open behind it, with no selection', () => {
  expect(researchCaptureTarget({ collectionDir: 'B', boardActive: false, boardDir: '', activePiece: 'A/piece.md' })).toEqual({ project: 'B', withSelection: false })
  expect(researchCaptureTarget({ collectionDir: '', boardActive: false, boardDir: '', activePiece: 'A/piece.md' })).toEqual({ project: '', withSelection: false })
  expect(researchCaptureTarget({ collectionDir: null, boardActive: true, boardDir: 'C', activePiece: 'A/piece.md' })).toEqual({ project: 'C', withSelection: false })
  expect(researchCaptureTarget({ collectionDir: null, boardActive: false, boardDir: '', activePiece: 'A/piece.md' })).toEqual({ project: 'A/piece.md', withSelection: true })
  expect(researchCaptureTarget({ collectionDir: null, boardActive: false, boardDir: '', activePiece: null })).toBeNull()
})

test('a dot-named Piece is a visible file for the verb when the app is closed', async () => {
  await writeFake({ stdout: JSON.stringify({ file: join(root, 'essays/research/d.md'), corpus: null, indexed: false }) })
  await writeFile(join(root, 'essays/.draft.md'), '# Draft\n')
  await mkdir(join(root, '.hidden-stuff'))
  expect(await captureInWorkspace(ws, { project: 'essays/.draft.md', title: 'D', kind: 'snippet', body: 'd' }, env())).toMatchObject({ ok: true, project: 'essays' })
  expect(await captureInWorkspace(ws, { project: '.hidden-stuff', title: 'D', kind: 'snippet', body: 'd' }, env())).toMatchObject({ ok: false })
})
