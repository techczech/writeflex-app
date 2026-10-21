import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { asksForJson, parseInvocation } from '../../src/main/cli/args'
import { exportSeams } from '../../src/main/cli/export-operation'
import type { JournalEntry } from '../../src/main/cli/journal'
import { CliError } from '../../src/main/cli/operation'
import { runCli } from '../../src/main/cli/run'
import { MAX_STDIN_BYTES, readCapped } from '../../src/main/cli/stdin'
import { buildOperationTable } from '../../src/main/cli/table'
import { unshow } from '../../src/main/cli/terminal-text'
import { parseFrontmatter } from '../../src/main/frontmatter'
import { acquireOwnerLock, ownerLockPath, releaseOwnerLock } from '../../src/main/owner-lock'
import { Workspace } from '../../src/main/workspace'
import { createdBy, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

// Review parcel P6, "command-line edges": the parser, exact paths, piped text, `read` on a terminal,
// export's claim on its target, the identity of a moved folder, the on-disk spelling of a path.
let fx: WriteFixture
let outside: string
beforeEach(async () => {
  fx = await writeFixture()
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-edges-')))
})
afterEach(async () => {
  exportSeams.beforeRename = undefined
  exportSeams.beforeClaim = undefined
  await fx.dispose()
  await rm(outside, { recursive: true, force: true })
})

const table = buildOperationTable()
const usage = (argv: string[]): string => {
  try { parseInvocation(argv, table) } catch (error) { return error instanceof CliError ? `${error.code}: ${error.message}` : String(error) }
  return 'parsed'
}

// --- `--` ends options (R3.10) -----------------------------------------------------------------------

test('after -- every word is a bare word, whatever it begins with; before it, flags are flags', () => {
  expect(parseInvocation(['read', '--', '--json'], table)).toMatchObject({ output: 'text', args: { path: '--json' } })
  expect(parseInvocation(['--json', 'read', '--', '--root=/elsewhere'], table)).toMatchObject({ output: 'json', args: { path: '--root=/elsewhere' } })
  expect(parseInvocation(['--json', 'read', '--', '--root=/elsewhere'], table)).not.toHaveProperty('root')
  expect(parseInvocation(['move', '--', '-a.md', '--to'], table).args).toEqual({ path: '-a.md', to: '--to' })
  expect(parseInvocation(['read', '--section', 'Intro', '--', '--help'], table)).toMatchObject({ operation: { name: 'read' }, args: { path: '--help', section: 'Intro' } })
  // A second -- is itself a word.
  expect(parseInvocation(['move', '--', '--', 'b.md'], table).args).toEqual({ path: '--', to: 'b.md' })
  // The operation name may itself follow the marker; a flag's value may be the marker.
  expect(parseInvocation(['--', 'read', '--json'], table)).toMatchObject({ output: 'text', operation: { name: 'read' }, args: { path: '--json' } })
  expect(parseInvocation(['create', 'a.md', '--content', '--'], table).args).toMatchObject({ path: 'a.md', content: '--' })
  // Without the marker the same token is still a flag, and an unknown one is refused, never guessed at.
  expect(usage(['read', '--nope.md'])).toStartWith('usage: read has no argument --nope.md')
  expect(asksForJson(['read', '--', '--json'])).toBe(false)
  expect(asksForJson(['read', '--json', '--', 'a.md'])).toBe(true)
})

test('a positional argument is given once: a named flag never replaces the path a bare word gave', () => {
  expect(usage(['read', 'a.md', '--path', 'b.md'])).toStartWith('usage: read was given <path> twice')
  expect(usage(['read', '--path', 'a.md', '--path', 'b.md'])).toStartWith('usage: read was given <path> twice')
  expect(usage(['move', 'a.md', 'b.md', '--to=c.md'])).toStartWith('usage: move was given <to> twice')
  expect(parseInvocation(['read', '--path', 'a.md'], table).args).toEqual({ path: 'a.md' })
})

test('a file whose name begins with dashes is read and moved as the file it is, and an error after -- is not printed as JSON', async () => {
  await fx.write('--json.md', 'dashed\n')
  expect((await fx.cli(['read', '--', '--json.md'])).json.result).toMatchObject({ content: 'dashed\n' })
  expect((await fx.cli(['move', '--', '--json.md', '-moved.md'])).json.result).toMatchObject({ from: '--json.md', to: '-moved.md' })
  expect(await fx.read('-moved.md')).toBe('dashed\n')
  let out = ''
  let err = ''
  const code = await runCli(['--root', fx.root, 'read', '--', '--json', 'extra'], { cwd: tmpdir(), stdout: (t) => { out += t }, stderr: (t) => { err += t } })
  expect({ code, out }).toEqual({ code: 2, out: '' })
  expect(err).toContain('read takes 1 bare argument')
})

// --- Paths are exact (R1.10) -------------------------------------------------------------------------

test('a path names exactly the file its characters name: whitespace twins are never confused', async () => {
  await fx.write('york.md', 'PLAIN\n')
  await fx.write(' york.md', 'SPACED\n')
  expect((await fx.cli(['read', ' york.md'])).json.result).toMatchObject({ content: 'SPACED\n', file: { path: ' york.md' } })
  expect((await fx.cli(['read', 'york.md'])).json.result).toMatchObject({ content: 'PLAIN\n' })
  // A name with a space after it is a third name, which no file has: refused, never read as its twin.
  const trailing = await fx.cli(['read', 'york.md '])
  expect(trailing.json.ok).toBe(false)
  expect(JSON.stringify(trailing.json)).not.toContain('PLAIN')
  expect((await fx.cli(['trash', 'york.md '])).json.ok).toBe(false)
  expect((await fx.cli(['move', 'york.md ', 'gone.md'])).json.ok).toBe(false)
  expect(await fx.read('york.md')).toBe('PLAIN\n')

  // Shown first: the proposal is for the file named, checked against that file's text.
  const proposed = await fx.cli(['replace', ' york.md', '--target', 'SPACED', '--with', 'X'])
  expect(proposed.json.result).toMatchObject({ path: ' york.md' })
  expect((await fx.cli(['replace', ' york.md', '--target', 'PLAIN', '--with', 'X'])).json.ok).toBe(false)

  const note = await fx.cli(['note', ' york.md', '--body', 'About the spaced one.'])
  expect(note.json.result).toMatchObject({ document: ' york.md', path: 'agent-notes/ york.notes.md' })
  expect(parseFrontmatter(await fx.read('agent-notes/ york.notes.md'))?.extra.source_document).toBe(' york.md')

  expect((await fx.cli(['move', ' york.md', ' moved'])).json.result).toMatchObject({ from: ' york.md', to: ' moved.md' })
  expect(await fx.read(' moved.md')).toBe('SPACED\n')
  expect(await fx.read('york.md')).toBe('PLAIN\n')
  expect((await fx.cli(['create', ' new', '--content', 'n'])).json.result).toMatchObject({ path: ' new.md' })
  expect(await fx.read(' new.md')).toBe(createdBy('n'))
  expect((await fx.cli(['trash', ' moved.md'])).json.result).toMatchObject({ trashed: ' moved.md' })
  expect(existsSync(join(fx.root, 'york.md'))).toBe(true)
})

test('an empty path is refused, for every kind of path argument', async () => {
  for (const argv of [['read', ''], ['create', ''], ['move', '', 'a.md'], ['move', 'notes.md', ''], ['trash', ''], ['move-folder', '', 'x'], ['replace', '', '--target', 'a', '--with', 'b']]) {
    const result = await fx.cli(argv)
    expect(result.json.ok, argv.join(' ')).toBe(false)
  }
  expect(await fx.read('notes.md')).toContain('# Notes')
})

// --- Piped text (R3.9) -------------------------------------------------------------------------------

test('--stdin is read before the owner lock is taken, once', async () => {
  let reads = 0
  let lockedWhenRead: boolean | null = null
  const created = await fx.cli(['create', 'piped.md', '--stdin'], { stdin: async () => { reads += 1; lockedWhenRead = existsSync(ownerLockPath(fx.root)); return 'piped\n' } })
  expect(created.json.ok).toBe(true)
  expect({ reads, lockedWhenRead }).toEqual({ reads: 1, lockedWhenRead: false })
  expect(await fx.read('piped.md')).toBe(createdBy('piped\n'))
  // An operation that takes no piped text never reads standard input at all.
  await fx.cli(['create', 'plain.md', '--content', 'x'], { stdin: async () => { reads += 1; return '' } })
  expect(reads).toBe(1)
})

test('piped text over the limit is refused before the lock is taken, and nothing is changed', async () => {
  const before = await fx.snapshot()
  const huge = 'x'.repeat(MAX_STDIN_BYTES + 1)
  // Another writeflex command holds the Collection: a command that reached the lock would wait and report it busy.
  const held = await acquireOwnerLock(fx.root, { kind: 'command-line' })
  try {
    const refused = await fx.cli(['create', 'huge.md', '--stdin'], { stdin: async () => huge })
    expect(refused.code).toBe(1)
    expect(refused.json.error).toMatchObject({ code: 'refused' })
    expect(refused.json.error!.message).toContain('larger than the command line takes (16 MiB')
    const shown = await fx.cli(['insert', 'notes.md', '--stdin'], { stdin: async () => huge })
    expect(shown.json.error!.message).toContain('larger than the command line takes')
  } finally {
    await releaseOwnerLock(held)
  }
  expect(await fx.snapshot()).toEqual(before)
  // Exactly the limit is taken.
  const exact = await fx.cli(['create', 'exact.md', '--stdin'], { stdin: async () => 'y'.repeat(64) })
  expect(exact.json.ok).toBe(true)
}, 30_000)

test('standard input is not read past the limit: the reader stops at the chunk that exceeds it', async () => {
  let pulled = 0
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < 100; i++) { pulled += 1; yield Buffer.alloc(4, 'a') }
  }
  await expect(readCapped(chunks(), 10)).rejects.toThrow(/larger than the command line takes/)
  expect(pulled).toBe(3)
  expect(await readCapped((async function* () { yield 'ab'; yield Buffer.from('cd') })(), 4)).toBe('abcd')
})

// --- `read` on a terminal (R2.9) ---------------------------------------------------------------------

/** C0 and C1 control characters other than newline and tab. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
const RISKY = '# Title\n\nred\u001b[2Jalert\rover\u009b1mC1\u0007bell\ttab\u007f\n\n## Part\n\nmore\u001b]0;title\u0007\n'

async function plain(argv: string[], terminal: boolean | undefined): Promise<{ code: number; out: string }> {
  let out = ''
  const code = await runCli(['--root', fx.root, ...argv], {
    cwd: tmpdir(), stdout: (t) => { out += t }, stderr: () => {}, ...(terminal === undefined ? {} : { stdoutIsTerminal: terminal }),
    write: { keyFolders: [fx.keys], appDataFolders: [fx.appData, fx.otherAppData] },
  })
  return { code, out }
}

test('read to a terminal shows every control character; to a pipe, and under --json, the text is exact', async () => {
  await fx.write('risky.md', RISKY)
  const terminal = await plain(['read', 'risky.md'], true)
  expect(terminal.code).toBe(0)
  expect(CONTROL.test(terminal.out)).toBe(false)
  expect(terminal.out).toContain('red\\u{1b}[2Jalert\\u{d}over\\u{9b}1mC1\\u{7}bell\ttab\\u{7f}\n')
  // Shown, never removed: the printed text stands for exactly the document.
  expect(unshow(terminal.out.slice(0, -1))).toBe(RISKY)

  for (const piped of [await plain(['read', 'risky.md'], false), await plain(['read', 'risky.md'], undefined)]) expect(piped.out).toBe(RISKY)
  const json = await plain(['--json', 'read', 'risky.md'], true)
  expect(CONTROL.test(json.out)).toBe(false)
  expect((JSON.parse(json.out) as { result: { content: string } }).result.content).toBe(RISKY)

  // One section, the same rule.
  const section = await plain(['read', 'risky.md', '--section', 'Part'], true)
  expect(CONTROL.test(section.out)).toBe(false)
  expect(section.out).toContain('more\\u{1b}]0;title\\u{7}')
  expect((await plain(['read', 'risky.md', '--section', 'Part'], false)).out).toContain('more\u001b]0;title\u0007')
  // The command line's own words (help spells out the escape notation) are the same wherever they go.
  expect((await plain(['help'], true)).out).toBe((await plain(['help'], false)).out)
})

// --- Export never replaces a file (R3.5) -------------------------------------------------------------

test('export claims its target before rendering and never replaces a file put there meanwhile', async () => {
  const target = join(outside, 'notes.html')
  let claimed: { size: number } | null = null
  exportSeams.beforeRename = async (path) => {
    // The name is the command's own while it renders: an empty file stands there.
    claimed = { size: (await readFile(path)).byteLength }
    await rm(path)
    await writeFile(path, 'THEIRS')
  }
  const refused = await fx.cli(['export', 'notes.md', '--to', target, '--confirm'])
  expect(claimed).toEqual({ size: 0 })
  expect(refused.json.ok).toBe(false)
  expect(refused.json.error!.message).toContain('was replaced by another file while the export was being made')
  expect(await readFile(target, 'utf8')).toBe('THEIRS')
  expect(await readdir(outside)).toEqual(['notes.html'])

  // Written INTO the claim meanwhile (the same file, no longer empty): not replaced either.
  const second = join(outside, 'second.html')
  exportSeams.beforeRename = async (path) => { await writeFile(path, 'WRITTEN INTO') }
  expect((await fx.cli(['export', 'notes.md', '--to', second, '--confirm'])).json.ok).toBe(false)
  expect(await readFile(second, 'utf8')).toBe('WRITTEN INTO')

  // A failure after the claim removes the claim, and nothing else.
  const third = join(outside, 'third.html')
  exportSeams.beforeRename = async () => { throw new Error('render went wrong') }
  expect((await fx.cli(['export', 'notes.md', '--to', third, '--confirm'])).json.error).toMatchObject({ code: 'failed', message: 'render went wrong' })
  expect((await readdir(outside)).sort()).toEqual(['notes.html', 'second.html'])

  exportSeams.beforeRename = undefined
  expect((await fx.cli(['export', 'notes.md', '--to', third, '--confirm'])).json.result).toMatchObject({ target: third })
  expect(await readFile(third, 'utf8')).toContain('Notes')
  expect((await readdir(outside)).sort()).toEqual(['notes.html', 'second.html', 'third.html'])
})

test('export refuses a target that exists, a link at the target included, before anything is rendered', async () => {
  let rendered = false
  exportSeams.beforeRename = async () => { rendered = true }
  const taken = join(outside, 'taken.html')
  await writeFile(taken, 'MINE')
  expect((await fx.cli(['export', 'notes.md', '--to', taken, '--confirm'])).json.error!.message).toContain('already exists')
  expect(await readFile(taken, 'utf8')).toBe('MINE')
  // A dangling link is a name that is taken: nothing is created where it points.
  const pointedAt = join(outside, 'pointed-at.html')
  await symlink(pointedAt, join(outside, 'link.html'))
  expect((await fx.cli(['export', 'notes.md', '--to', join(outside, 'link.html'), '--confirm'])).json.error!.message).toContain('already exists')
  expect(existsSync(pointedAt)).toBe(false)
  expect(rendered).toBe(false)

  // The claim itself is exclusive: a file, or a link, that appears after the name was seen free is not written into or through.
  const raced = join(outside, 'raced.html')
  exportSeams.beforeClaim = async (path) => { await writeFile(path, 'THEIRS') }
  expect((await fx.cli(['export', 'notes.md', '--to', raced, '--confirm'])).json.error!.message).toContain('already exists')
  expect(await readFile(raced, 'utf8')).toBe('THEIRS')
  const racedLink = join(outside, 'raced-link.html')
  exportSeams.beforeClaim = async (path) => { await symlink(pointedAt, path) }
  expect((await fx.cli(['export', 'notes.md', '--to', racedLink, '--confirm'])).json.error!.message).toContain('already exists')
  expect(existsSync(pointedAt)).toBe(false)
  expect(rendered).toBe(false)
})

// --- Folder-move undo (R3.7) -------------------------------------------------------------------------

test('a folder move records which folder moved, and undo refuses a folder that is not the one moved', async () => {
  const before = await fx.snapshot()
  const moved = await fx.cli(['move-folder', 'talks', 'events'])
  expect(moved.json.ok).toBe(true)
  const [name] = await fx.journalNames()
  const entry = JSON.parse(await readFile(join(fx.journalDir, name), 'utf8')) as JournalEntry
  expect(entry.moves[0]).toMatchObject({ from: 'talks', to: 'events', kind: 'folder' })
  expect(Number.isSafeInteger(entry.moves[0].ino) && Number.isSafeInteger(entry.moves[0].dev)).toBe(true)

  // The moved folder is put aside and another folder stands at its name.
  await rename(join(fx.root, 'events'), join(fx.root, 'events-put-aside'))
  await mkdir(join(fx.root, 'events'))
  await writeFile(join(fx.root, 'events', 'somebody-elses.md'), 'not the folder that moved\n')
  const replaced = await fx.snapshot({ journal: true })
  const refused = await fx.cli(['undo'])
  expect(refused.json.ok).toBe(false)
  expect(refused.json.error!.message).toContain('events is not the folder that was moved there')
  expect(await fx.snapshot({ journal: true })).toEqual(replaced)

  // With the moved folder back at its name, the same undo goes through: files edited in it go back with their edits.
  await rm(join(fx.root, 'events'), { recursive: true })
  await rename(join(fx.root, 'events-put-aside'), join(fx.root, 'events'))
  await fx.write('events/added-since.md', 'added after the move\n')
  expect((await fx.cli(['undo'])).json.result).toMatchObject({ undone: entry.id })
  expect(await fx.read('talks/added-since.md')).toBe('added after the move\n')
  await rm(join(fx.root, 'talks/added-since.md'))
  expect(await fx.snapshot()).toEqual(before)
})

test('a journal entry whose folder identity is not a pair of whole numbers, or sits on a file move, is not read as an entry', async () => {
  await mkdir(fx.journalDir, { recursive: true, mode: 0o700 })
  const plant = async (id: string, move: Record<string, unknown>): Promise<void> => {
    await writeFile(join(fx.journalDir, `${id}.json`), JSON.stringify({ version: 1, id, at: new Date().toISOString(), operation: 'move-folder', summary: 'planted', moves: [move], files: [] }))
  }
  await plant('20260101T000000001Z-aaaaaaaa', { from: 'talks', to: 'events', kind: 'folder', dev: 'x', ino: 1 })
  await plant('20260101T000000002Z-bbbbbbbb', { from: 'talks', to: 'events', kind: 'folder', ino: 1 })
  await plant('20260101T000000003Z-cccccccc', { from: 'a.md', to: 'b.md', kind: 'file', dev: 1, ino: 1 })
  await plant('20260101T000000004Z-dddddddd', { from: 'talks', to: 'events', kind: 'folder' })
  const listed = (await fx.cli(['undo', '--list'])).json.result as { changes: Array<{ id: string }>; unreadable: string[] }
  expect(listed.unreadable.sort()).toEqual(['20260101T000000001Z-aaaaaaaa.json', '20260101T000000002Z-bbbbbbbb.json', '20260101T000000003Z-cccccccc.json'])
  expect(listed.changes.map((change) => change.id)).toEqual(['20260101T000000004Z-dddddddd'])
})

// --- The on-disk spelling (R1.12 correction, D15) ----------------------------------------------------
// Under Bun, which runs these tests, `realpathSync` already answers in the on-disk spelling, so this
// test holds the behaviour but cannot tell `realpathSync` from `realpathSync.native`. Node, which runs
// the app and the command line, can: scripts/smoke-command-line.ts makes the same check there.

test('a path is judged by its spelling on disk: Node_Modules is hidden where the disk ignores case, and a document where it does not', async () => {
  await fx.write('node_modules/pkg/readme.md', 'tooling\n')
  await fx.write('Release/notes.md', 'the writer\'s own\n')
  const ignoresCase = existsSync(join(fx.root, 'NODE_MODULES'))
  if (!ignoresCase) await fx.write('Node_Modules/pkg/readme.md', 'a folder of the writer\'s\n')
  const ws = new Workspace(fx.root)
  expect(ws.classifyPath('node_modules/pkg/readme.md')).toBe('hidden')
  expect(ws.classifyPath('Node_Modules/pkg/readme.md')).toBe(ignoresCase ? 'hidden' : 'document')
  // A new file under the alias is judged by where it would really be made.
  expect(ws.classifyPath('Node_Modules/pkg/new.md')).toBe(ignoresCase ? 'hidden' : 'document')
  expect(ws.classifyPath('NODE_MODULES', 'folder')).toBe(ignoresCase ? 'hidden' : 'document')
  // The exact-case decision stands: a folder really named Release is the writer's, on any disk.
  expect(ws.classifyPath('Release/notes.md')).toBe('document')
  const read = await fx.cli(['read', 'Node_Modules/pkg/readme.md'])
  expect(read.json.ok).toBe(!ignoresCase)
  if (ignoresCase) {
    expect(read.json.error!.message).toContain('under a dot-folder or an ignored folder')
    expect((await fx.cli(['create', 'Node_Modules/planted.md', '--content', 'x'])).json.ok).toBe(false)
    expect(existsSync(join(fx.root, 'node_modules/planted.md'))).toBe(false)
    // A Collection opened by a path spelled in another letter case still holds its documents.
    const respelled = new Workspace(join(dirname(fx.root), basename(fx.root).toUpperCase()))
    expect(respelled.classifyPath('notes.md')).toBe('document')
    expect(respelled.classifyPath('Node_Modules/pkg/readme.md')).toBe('hidden')
  }
})
