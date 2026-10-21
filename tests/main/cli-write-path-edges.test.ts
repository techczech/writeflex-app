/**
 * Second-review parcel P10, invariants 4 to 6:
 *  - `writeflex read <doc> > copy` produces a byte-identical copy of a UTF-8 document; `--json` carries the decoded text.
 *    Schedule: the real command (src/main/writeflex-cli.ts) with its standard output a file, as a shell redirect makes it.
 *  - No program is run by the command line except by absolute path.
 *    Schedule: a `git` planted first on PATH while a version author is looked up; and every program named
 *    in the main process's source is named by its own path.
 *  - `writeflex search` returns no text from a file that is a link at the moment it is read.
 *    Schedule: the listing is taken, then a listed document is replaced by a link to text the sidebar
 *    hides (a dot-folder inside the Collection, which the Workspace's own path check admits), then the
 *    search reads it.
 * Nothing here waits on the clock: each child is waited for until it ends, within the test's own limit.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { spawn } from 'node:child_process'
import { chmod, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CommandLineWorkspace } from '../../src/main/cli/guarded-workspace'
import { OPEN_PATH } from '../../src/main/cli/run'
import { GIT_PATH, humanAuthorForWorkspace } from '../../src/main/versions'
import { writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

const TEST_MS = 60_000
const ENTRY = join(import.meta.dir, '..', '..', 'src', 'main', 'writeflex-cli.ts')
const MAIN = join(import.meta.dir, '..', '..', 'src', 'main')

let fx: WriteFixture
beforeEach(async () => { fx = await writeFixture() })
afterEach(async () => { await fx.dispose() })

/** Run the real command with its standard output going straight into `outFile`; resolves with its exit code when it ends. */
async function intoFile(argv: string[], outFile: string): Promise<{ code: number | null; err: string }> {
  const out = await open(outFile, 'w')
  try {
    const child = spawn(process.execPath, [ENTRY, ...argv], { stdio: ['ignore', out.fd, 'pipe'], env: { HOME: fx.appData, PATH: '/usr/bin:/bin' } })
    let err = ''
    child.stderr!.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    const code = await new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('close', done) })
    return { code, err }
  } finally {
    await out.close()
  }
}

test('read into a file is the document byte for byte, with and without a final line end; --json carries the decoded text', async () => {
  const documents: Record<string, string> = {
    'ends-with-line-end.md': '# With\n\nCafé, naïve, — and the last line.\n',
    'no-final-line-end.md': '# Without\n\nThe last line has no line end',
    'windows-line-ends.md': '# CRLF\r\n\r\nTwo lines.\r\n',
  }
  for (const [path, text] of Object.entries(documents)) {
    await fx.write(path, text)
    const copy = join(fx.trashed, `${path}.copy`)
    const run = await intoFile(['--root', fx.root, 'read', path], copy)
    expect(run.code, `${path}: ${run.err}`).toBe(0)
    expect((await readFile(copy)).equals(await fx.bytes(path)), path).toBe(true)
    expect((await fx.cli(['read', path])).json.result!.content, path).toBe(text)
  }
}, TEST_MS)

test('a git planted first on PATH is never run when a version\'s author is looked up: git is run by its own path', async () => {
  expect(GIT_PATH).toBe('/usr/bin/git')
  const planted = join(fx.trashed, 'planted-bin')
  const mark = join(fx.trashed, 'planted-git-ran')
  await mkdir(planted)
  await writeFile(join(planted, 'git'), `#!/bin/sh\n/usr/bin/touch '${mark}'\necho "Planted Author"\n`)
  await chmod(join(planted, 'git'), 0o755)
  const saved = process.env.PATH
  process.env.PATH = `${planted}:${saved ?? '/usr/bin:/bin'}`
  try {
    // The limit never passes: the real git is waited for until it answers.
    const author = await humanAuthorForWorkspace(fx.root, { expired: () => new Promise<void>(() => {}) })
    expect(author.name).not.toBe('Planted Author')
  } finally {
    process.env.PATH = saved
  }
  expect(existsSync(mark)).toBe(false)
}, TEST_MS)

test('every program the main process names is named by its own path', async () => {
  expect(OPEN_PATH).toBe('/usr/bin/open')
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(dir, entry.name))
      else if (entry.name.endsWith('.ts')) files.push(join(dir, entry.name))
    }
  }
  await walk(MAIN)
  const launches: string[] = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const call of source.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync|runBounded)\(\s*([^,)]+)/g)) {
      for (const literal of call[1].matchAll(/['"`]([^'"`]*)['"`]/g)) launches.push(`${file.slice(MAIN.length + 1)}: ${literal[1]}`)
    }
  }
  // The scan found the programs it is meant to judge.
  expect(launches.some((line) => line.endsWith(': /bin/ps'))).toBe(true)
  expect(launches.filter((line) => !/: \//.test(line))).toEqual([])
}, TEST_MS)

test('search returns no text from a listed document that is a link by the time it is read', async () => {
  await fx.write('.private/diary.md', '# Private\n\nThe word quillwort appears only in a hidden folder.\n')
  const hidden = join(fx.root, '.private/diary.md')
  await fx.write('visible.md', '# Visible\n\nThe word quillwort appears here too.\n')
  /** Takes the listing, then puts a link at a listed name before anything is read. */
  class SwappedAfterListing extends CommandLineWorkspace {
    override async listFiles(): ReturnType<CommandLineWorkspace['listFiles']> {
      const listed = await super.listFiles()
      await rm(join(this.root, 'notes.md'))
      await symlink(hidden, join(this.root, 'notes.md'))
      return listed
    }
  }
  const ws = new SwappedAfterListing(fx.root)
  const result = await ws.search('quillwort')
  // The schedule ran: notes.md was listed and is a link now.
  expect((await readFile(join(fx.root, 'notes.md'), 'utf8'))).toContain('only in a hidden folder')
  expect(result.matches.map((match) => match.path)).toEqual(['visible.md'])
  expect(JSON.stringify(result)).not.toContain('only in a hidden folder')
}, TEST_MS)
