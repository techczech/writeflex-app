import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pauseCollectionWrites, resumeCollectionWrites } from '../../src/main/collection-write-gate'
import { STALE_TEMPORARY_MS, removeStaleTemporaryFiles } from '../../src/main/cli/stale-temporary-files'
import { MANIFEST_NAME } from '../../src/main/folio'
import { writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

// Ticket 05 follow-up: a write killed between staging and rename leaves a temporary file; it is cleared later.
let fx: WriteFixture
let outside: string
beforeEach(async () => {
  fx = await writeFixture()
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-stale-outside-')))
})
afterEach(async () => {
  resumeCollectionWrites(fx.root)
  await fx.dispose()
  await rm(outside, { recursive: true, force: true })
})

const OLD = new Date(Date.now() - STALE_TEMPORARY_MS - 60_000)
const plant = async (rel: string, old = true): Promise<void> => {
  await fx.write(rel, 'left behind\n')
  if (old) await utimes(join(fx.root, rel), OLD, OLD)
}

/** The command line's own leftovers, in the places it makes them. */
const LEFT_BEHIND = [
  'talks/york.md.0a1b2c3d.tmp', 'notes.md.deadbeef.tmp', 'drafts/deep/new.markdown.00000000.tmp', `talks/${MANIFEST_NAME}.0a1b2c3d.tmp`,
  '.writeflex/inbox/.20261007T120000000Z-0a0b0c0d0a0b0c0d.json.0a1b2c3d.tmp',
  '.writeflex/outbox/.20261007T120000000Z-0a0b0c0d0a0b0c0d.json.0a1b2c3d.tmp',
]
/** Old files with merely similar names, and matching names where the command line never writes: all the user's or the app's. */
const NOT_OURS = [
  'notes.md.tmp', 'draft.12345678.tmp', 'notes.md.backup01.tmp', 'notes.md.0A1B2C3D9.tmp', 'talks/york.md.0a1b2c3d.tmp.md', 'talks/york.md.0a1b2c3d.tmp.bak',
  'picture.png.0a1b2c3d.tmp', 'york.md.0a1b2c3.tmp', 'tmp', '.tmp',
  '.git/hooks/readme.md.0a1b2c3d.tmp', '.obsidian/notes.md.0a1b2c3d.tmp', 'node_modules/pkg/readme.md.0a1b2c3d.tmp',
  '.writeflex/versions.md.0a1b2c3d.tmp', '.writeflex/rescue/notes.md.0a1b2c3d.tmp', '.bridle/notes.md.0a1b2c3d.tmp',
  '.writeflex/cli-journal/notes.md.0a1b2c3d.tmp', '.writeflex/inbox/notes.md.0a1b2c3d.tmp',
  // The folders an earlier build kept its journal and records in are not visited: nothing in them is read or removed.
  '.writeflex/cli-journal/20261007T120000000Z-0a0b0c0d.0a1b2c3d.tmp',
  '.writeflex/requests-handled/.20261007T120000000Z-0a0b0c0d0a0b0c0d.json.0a1b2c3d.tmp',
  '.writeflex/requests-undelivered/.20261007T120000000Z-0a0b0c0d0a0b0c0d.json.0a1b2c3d.tmp',
]

test('the command line\'s own stale temporary files are removed; a similar name, a fresh file and anything behind a link are left', async () => {
  for (const rel of [...LEFT_BEHIND, ...NOT_OURS]) await plant(rel)
  await plant('talks/intro.md.0a1b2c3d.tmp', false) // a write in progress
  // A linked folder is not entered; a link named like a leftover is not removed.
  await writeFile(join(outside, 'kept.md.0a1b2c3d.tmp'), 'outside\n')
  await utimes(join(outside, 'kept.md.0a1b2c3d.tmp'), OLD, OLD)
  await symlink(outside, join(fx.root, 'linked-folder'))
  await symlink(join(outside, 'kept.md.0a1b2c3d.tmp'), join(fx.root, 'talks/link.md.0a1b2c3d.tmp'))
  const documents = await fx.snapshot()

  const removed = await removeStaleTemporaryFiles(fx.root)
  expect(removed).toEqual([...LEFT_BEHIND].sort())
  for (const rel of LEFT_BEHIND) expect(existsSync(join(fx.root, rel)), rel).toBe(false)
  for (const rel of [...NOT_OURS, 'talks/intro.md.0a1b2c3d.tmp', 'talks/link.md.0a1b2c3d.tmp']) expect(existsSync(join(fx.root, rel)), rel).toBe(true)
  expect(existsSync(join(outside, 'kept.md.0a1b2c3d.tmp'))).toBe(true)
  // No document and no store of the app's was touched.
  const after = await fx.snapshot()
  for (const [path, bytes] of Object.entries(after)) expect(documents[path], path).toBe(bytes)
  expect(await removeStaleTemporaryFiles(fx.root)).toEqual([])
})

test('the next command-line write to the Collection clears them; a read does not', async () => {
  await plant('talks/york.md.0a1b2c3d.tmp')
  await plant('notes.md.backup01.tmp')
  expect((await fx.cli(['files'])).code).toBe(0)
  expect(existsSync(join(fx.root, 'talks/york.md.0a1b2c3d.tmp'))).toBe(true)
  expect((await fx.cli(['create', 'new.md', '--content', 'x'])).code).toBe(0)
  expect(existsSync(join(fx.root, 'talks/york.md.0a1b2c3d.tmp'))).toBe(false)
  expect(existsSync(join(fx.root, 'notes.md.backup01.tmp'))).toBe(true)
})

test('nothing is removed while the Collection may not be written, or from a .writeflex folder that is a link', async () => {
  await plant('talks/york.md.0a1b2c3d.tmp')
  pauseCollectionWrites(fx.root, 'paused')
  expect(await removeStaleTemporaryFiles(fx.root)).toEqual([])
  resumeCollectionWrites(fx.root)

  const leftover = '.20261007T120000000Z-0a0b0c0d0a0b0c0d.json.0a1b2c3d.tmp'
  await mkdir(join(outside, 'outbox'))
  await writeFile(join(outside, 'outbox', leftover), 'outside\n')
  await utimes(join(outside, 'outbox', leftover), OLD, OLD)
  await mkdir(join(fx.root, '.writeflex'), { recursive: true })
  await symlink(join(outside, 'outbox'), join(fx.root, '.writeflex/outbox'))
  expect(await removeStaleTemporaryFiles(fx.root)).toEqual(['talks/york.md.0a1b2c3d.tmp'])
  expect(existsSync(join(outside, 'outbox', leftover))).toBe(true)
})
