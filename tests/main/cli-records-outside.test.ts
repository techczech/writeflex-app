import { test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { JOURNAL_KIND, recordsDir, standardRecordsPlace } from '../../src/main/collection-records'
import { NOTES, YORK, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

// The undo journal is kept outside every Collection, in application data (collection-records.ts).
// What is planted inside a Collection is never read; what cannot be recorded is never done.

/** Everything under the REAL application-data records folders, taken before any test here runs. */
function realRecords(): string[] {
  const place = standardRecordsPlace(homedir())
  const out: string[] = []
  const walk = (dir: string): void => {
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names.sort()) { out.push(join(dir, name)); walk(join(dir, name)) }
  }
  for (const appData of [place.own, ...place.others]) for (const folder of ['collections', 'command-line-undo']) walk(join(appData, folder))
  return out
}
const REAL_BEFORE = realRecords()

let fx: WriteFixture
beforeEach(async () => { fx = await writeFixture() })
afterEach(() => fx.dispose())

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const b64 = (text: string): string => Buffer.from(text).toString('base64')
const OLD_JOURNAL = '.writeflex/cli-journal'
type Row = { id: string; undone: boolean; interrupted: boolean }
const listed = async (env?: Parameters<WriteFixture['cli']>[1]): Promise<Row[]> => (await fx.cli(['undo', '--list'], env)).json.result!.changes as Row[]

test('a journal entry or intent planted inside the Collection is not listed and undoes nothing, named or not', async () => {
  const entry = '20261007T120000000Z-0a0b0c0d'
  const intent = '20261007T130000000Z-0a0b0c0d'
  // A forged entry whose fingerprint matches the document as it stands: under the old rule, undo would have written `before` into it.
  await fx.write(`${OLD_JOURNAL}/${entry}.json`, JSON.stringify({
    version: 1, id: entry, at: new Date().toISOString(), operation: 'move', summary: 'planted', moves: [],
    files: [{ path: 'notes.md', before: b64('PLANTED\n'), after: sha(NOTES) }],
  }))
  await fx.write(`${OLD_JOURNAL}/${intent}.intent.jsonl`, [
    { version: 1, id: intent, intent: true, at: new Date().toISOString(), operation: 'move' },
    { file: { path: 'talks/york.md', before: b64('PLANTED\n'), wrote: sha(YORK) } },
  ].map((line) => `${JSON.stringify(line)}\n`).join(''))
  const before = await fx.snapshot()

  expect(await listed()).toEqual([])
  expect((await fx.cli(['undo'])).json.error!.message).toContain('nothing to undo')
  for (const id of [entry, intent]) expect((await fx.cli(['undo', id])).json.error!.message).toContain('No journal entry')
  expect(await fx.snapshot()).toEqual(before)
  expect(await fx.read('notes.md')).toBe(NOTES)

  // Planted anywhere else inside the Collection, the same; and a real change is recorded outside, beside none of it.
  await fx.write(`talks/${entry}.json`, await fx.read(`${OLD_JOURNAL}/${entry}.json`))
  const moved = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])
  expect(await fx.journalNames()).toEqual([`${moved.json.result!.undo as string}.json`])
  expect((await listed()).map((row) => row.id)).toEqual([moved.json.result!.undo as string])
  expect((await readdir(join(fx.root, OLD_JOURNAL))).sort()).toEqual([`${entry}.json`, `${intent}.intent.jsonl`])
})

test('the old journal folder inside the Collection is never opened: a link, a file or an unreadable folder there changes nothing', async () => {
  const elsewhere = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-old-journal-')))
  try {
    const stand: Array<[string, () => Promise<void>, () => Promise<void>]> = [
      ['a link to a folder', () => symlink(elsewhere, join(fx.root, OLD_JOURNAL)), () => rm(join(fx.root, OLD_JOURNAL))],
      ['a file', () => writeFile(join(fx.root, OLD_JOURNAL), 'not a folder'), () => rm(join(fx.root, OLD_JOURNAL))],
      ['a folder that cannot be listed', () => mkdir(join(fx.root, OLD_JOURNAL), { mode: 0o000 }), async () => { await chmod(join(fx.root, OLD_JOURNAL), 0o700); await rm(join(fx.root, OLD_JOURNAL), { recursive: true }) }],
    ]
    for (const [what, put, clear] of stand) {
      await put()
      try {
        const moved = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])
        expect(moved.json.error?.message ?? '', what).toBe('')
        expect((await listed()).filter((row) => !row.undone), what).toHaveLength(1)
        expect((await fx.cli(['undo'])).code, what).toBe(0)
        expect(await readdir(elsewhere), what).toEqual([])
      } finally {
        await clear()
      }
    }
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
  }
})

test('a change is recorded in this command line\'s own variant folder and listed from both; undoing the other variant\'s change writes only here', async () => {
  const release = fx.appData
  const beta = fx.otherAppData
  const asRelease = { write: { appDataFolders: [release, beta] } }
  const asBeta = { write: { appDataFolders: [beta, release] } }
  const before = await fx.snapshot()

  const first = (await fx.cli(['scrap', 'notes.md', '--text', 'one'], asRelease)).json.result!.undo
  expect(first).toBeNull() // a new scraps file: not journalled, and nothing written to application data
  expect(await readdir(release)).toEqual([])
  const byRelease = (await fx.cli(['scrap', 'notes.md', '--text', 'two'], asRelease)).json.result!.undo as string
  const byBeta = (await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'], asBeta)).json.result!.undo as string
  const releaseJournal = recordsDir(release, fx.root, JOURNAL_KIND)
  const betaJournal = recordsDir(beta, fx.root, JOURNAL_KIND)
  expect(await readdir(releaseJournal)).toEqual([`${byRelease}.json`])
  expect(await readdir(betaJournal)).toEqual([`${byBeta}.json`])
  // Private: each level is this user's alone.
  for (const dir of [join(beta, 'command-line-undo'), betaJournal]) expect((await import('node:fs')).statSync(dir).mode & 0o077, dir).toBe(0)

  // Listed from both, newest first, whichever variant asks.
  for (const as of [asRelease, asBeta]) expect((await listed(as)).map((row) => [row.id, row.undone])).toEqual([[byBeta, false], [byRelease, false]])

  // The release command line undoes the beta's move: the undone copy goes to ITS folder; the beta's is not written.
  const betaEntry = await readFile(join(betaJournal, `${byBeta}.json`), 'utf8')
  expect((await fx.cli(['undo'], asRelease)).json.result).toMatchObject({ undone: byBeta })
  expect(await readFile(join(betaJournal, `${byBeta}.json`), 'utf8')).toBe(betaEntry)
  expect((await readdir(betaJournal)).sort()).toEqual([`${byBeta}.json`])
  expect((await readdir(releaseJournal)).sort()).toEqual([`${byBeta}.json`, `${byRelease}.json`].sort())
  // Both now see it undone, and it cannot be undone twice from either.
  for (const as of [asRelease, asBeta]) {
    expect((await listed(as)).map((row) => [row.id, row.undone])).toEqual([[byBeta, true], [byRelease, false]])
    expect((await fx.cli(['undo', byBeta], as)).json.error!.message).toContain('already undone')
  }
  expect((await fx.cli(['undo'], asBeta)).json.result).toMatchObject({ undone: byRelease })
  const after = await fx.snapshot()
  delete after['scraps/notes-SCRAPS.md']
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  expect(await fx.read('talks/york.md')).toBe(YORK)

  // A folder of the other variant's that is not private is no record at all (and does not stop this variant).
  await chmod(betaJournal, 0o755)
  expect((await listed(asRelease)).map((row) => row.id).sort()).toEqual([byBeta, byRelease].sort()) // its own copies only
  await rm(join(releaseJournal, `${byBeta}.json`))
  expect((await listed(asRelease)).map((row) => row.id)).toEqual([byRelease])
})

test('a change whose undo record would be over the entry limit is refused before any file changes', async () => {
  const limit = 16 * 1024
  // Counted at the two points every change passes: before a write step begins, and between a write's check and the write itself.
  const reached = { steps: 0, writes: 0 }
  const small = { write: { maxJournalEntryBytes: limit, seams: { beforeWrite: async () => { reached.steps += 1 }, betweenCheckAndWrite: async () => { reached.writes += 1 } } } }
  const big = `# York\n\n${'A long paragraph about assessment. '.repeat(600)}\n` // about 21 kB: over the limit once encoded
  await fx.write('talks/york.md', big)
  await fx.write('scraps/notes-SCRAPS.md', `## a1b2\n${'Earlier. '.repeat(2500)}\n`)
  const before = await fx.snapshot()
  const prints = Object.fromEntries(Object.entries(before).map(([path, bytes]) => [path, sha(Buffer.from(bytes, 'base64'))]))

  for (const argv of [['scrap', 'notes.md', '--text', 'one more'], ['move', 'talks/york.md', 'deep/new/york-2026.md']]) {
    const refused = await fx.cli(argv, small)
    expect(refused.code, argv[0]).toBe(1)
    expect(refused.json, argv[0]).toMatchObject({ ok: false, outcome: 'refused', error: { code: 'refused' } })
    expect(refused.json.error!.message, argv[0]).toContain(`too large for the command line to keep a record to undo it by (the record would be over ${limit} bytes)`)
    // Not one byte and not one path: the fingerprint of every file is what it was, and no folder was made for the move.
    const after = await fx.snapshot()
    expect(Object.fromEntries(Object.entries(after).map(([path, bytes]) => [path, sha(Buffer.from(bytes, 'base64'))])), argv[0]).toEqual(prints)
    expect(existsSync(join(fx.root, 'deep')), argv[0]).toBe(false)
    // Nothing is left on record either: no entry, and no intent of a change that never began.
    expect(await fx.journalNames(), argv[0]).toEqual([])
  }
  // Not put back afterwards: never begun. No write reached the point of writing, and the move did not even reach its first step (making the folder).
  expect(reached).toEqual({ steps: 1, writes: 0 }) // the one step is the scrap's own, stopped before its write
  // The same changes under the real limit are made, recorded and undone: a record that was written can always be read back.
  const moved = await fx.cli(['move', 'talks/york.md', 'deep/new/york-2026.md'])
  expect(moved.code).toBe(0)
  expect((await fx.cli(['undo'])).json.result).toMatchObject({ undone: moved.json.result!.undo })
  expect(await fx.read('talks/york.md')).toBe(big)
  // A small change still fits a small limit.
  expect((await fx.cli(['move', 'notes.md', 'notes-2026.md'], small)).code).toBe(0)
})

test('when application data cannot be written, a change that needs an undo record is refused before anything changes, naming the folder to allow', async () => {
  const before = await fx.snapshot()
  const reached = { steps: 0, writes: 0 }
  const counting = { write: { seams: { beforeWrite: async () => { reached.steps += 1 }, betweenCheckAndWrite: async () => { reached.writes += 1 } } } }
  await chmod(fx.appData, 0o500)
  try {
    for (const argv of [['move', 'talks/york.md', 'deep/new/york-2026.md'], ['move-folder', 'talks', 'events/2026']]) {
      const refused = await fx.cli(argv, counting)
      expect(refused.code, argv[0]).toBe(1)
      expect(refused.json, argv[0]).toMatchObject({ ok: false, outcome: 'refused', error: { code: 'app-data-not-writable' } })
      const message = refused.json.error!.message
      // The command line's own folder and nothing wider: nothing the app trusts is in it.
      expect(message, argv[0]).toContain(`allow writing to this folder: ${join(fx.appData, 'command-line-undo')} .`)
      expect(message, argv[0]).not.toContain('collections')
      expect(message, argv[0]).toContain('nothing was changed')
      expect(message, argv[0]).toContain('Opening the Collection in WriteFlex also works: WriteFlex then does the writing')
      expect(await fx.snapshot(), argv[0]).toEqual(before)
      expect(existsSync(join(fx.root, 'deep')) || existsSync(join(fx.root, 'events')), argv[0]).toBe(false)
    }
    // Not put back afterwards: never begun. Neither move reached its first write step (making the folder above the new name).
    expect(reached).toEqual({ steps: 0, writes: 0 })
    // A change to an existing file's content, the same.
    await fx.write('scraps/notes-SCRAPS.md', '## a1b2\nEarlier.\n')
    const scrap = await fx.cli(['scrap', 'notes.md', '--text', 'two'], counting)
    expect(scrap.json.error).toMatchObject({ code: 'app-data-not-writable' })
    expect(reached.writes).toBe(0)
    expect(await fx.read('scraps/notes-SCRAPS.md')).toBe('## a1b2\nEarlier.\n')
    // Listing what is on record needs no write there.
    expect((await fx.cli(['undo', '--list'])).json.result).toMatchObject({ changes: [] })

    // What changes nothing existing keeps no record, writes nothing there, and is not refused for it.
    expect((await fx.cli(['create', 'new.md', '--content', 'New.\n'])).json.error?.message ?? '').toBe('')
    expect((await fx.cli(['create-folder', 'drafts'])).code).toBe(0)
    expect((await fx.cli(['duplicate', 'notes.md'])).code).toBe(0)
    expect((await fx.cli(['note', 'talks/york.md', '--body', 'A note.'])).code).toBe(0)
    expect((await fx.cli(['create', 'drafts/one.md', '--content', 'One.\n'])).code).toBe(0)
    expect((await fx.cli(['create-manifest', 'drafts'])).json.error?.message ?? '').toBe('')
    expect((await fx.cli(['trash', 'new.md'])).code).toBe(0)
    expect(await fx.read('new.md').catch(() => null)).toBeNull()
    expect(await readdir(fx.appData)).toEqual([])
  } finally {
    await chmod(fx.appData, 0o700)
  }
  // The records folder is there but may not be written (a sandbox that allows reading it): the same refusal.
  const moved = await fx.cli(['move', 'notes.md', 'notes-2026.md'])
  expect(moved.code).toBe(0)
  await chmod(fx.journalDir, 0o500)
  try {
    const refused = await fx.cli(['move', 'notes-2026.md', 'notes-2027.md'])
    expect(refused.json.error).toMatchObject({ code: 'app-data-not-writable' })
    expect(existsSync(join(fx.root, 'notes-2026.md'))).toBe(true)
    // Undo, too, must leave its mark first: refused whole, nothing put back by halves.
    const undo = await fx.cli(['undo'])
    expect(undo.json.error).toMatchObject({ code: 'app-data-not-writable' })
    expect(existsSync(join(fx.root, 'notes-2026.md'))).toBe(true)
  } finally {
    await chmod(fx.journalDir, 0o700)
  }
  expect((await fx.cli(['undo'])).json.result).toMatchObject({ undone: moved.json.result!.undo })
})

test('the default locations are under the home folder given, and the real application-data folders are not touched', async () => {
  // No `appDataFolders` here: the standard place is derived, as in production, from the home folder, which is a temporary one.
  const home = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-home-')))
  try {
    const moved = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'], { write: { home, appDataFolders: undefined } })
    expect(moved.code).toBe(0)
    const journal = recordsDir(join(home, 'Library', 'Application Support', 'writeflex-desktop'), fx.root, JOURNAL_KIND)
    expect(await readdir(journal)).toEqual([`${moved.json.result!.undo as string}.json`])
    // The beta command line writes the beta's folder.
    const again = await fx.cli(['move', 'talks/york-2026.md', 'talks/york-2027.md'], { write: { home, appDataFolders: undefined, variant: 'writeflex-desktop-beta' } })
    expect(await readdir(recordsDir(join(home, 'Library', 'Application Support', 'writeflex-desktop-beta'), fx.root, JOURNAL_KIND))).toEqual([`${again.json.result!.undo as string}.json`])
    expect(await readdir(journal)).toHaveLength(1)
    expect(await fx.journalNames()).toEqual([])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
  // After every write test in this file: the real folders hold exactly what they held before the first.
  expect(realRecords()).toEqual(REAL_BEFORE)
})

test('no source file names one of the three old record folders inside a Collection as a path', async () => {
  // The folders an earlier build kept under `.writeflex` are never opened, read or written: no code can build their path.
  const old = /['"`]\.writeflex\/(?:cli-journal|requests-handled|requests-undelivered)|['"`](?:cli-journal|requests-handled|requests-undelivered)['"`]/
  const repo = join(import.meta.dir, '..', '..')
  const allowed = new Set(['src/main/collection-records.ts']) // the one place the three names are defined, as folders under application data
  const offenders: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(repo, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) await walk(path)
      else if (/\.tsx?$/.test(entry.name) && !allowed.has(path) && old.test(await readFile(join(repo, path), 'utf8'))) offenders.push(path)
    }
  }
  await walk('src')
  expect(offenders).toEqual([])
})
