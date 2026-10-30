/**
 * The bracketed immutable read of `zotero.sqlite` (ADR-0047): complete only when the write-ahead log
 * was empty or absent and neither file changed while the read ran. Real SQLite files in WAL mode.
 */
import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBracketed, zoteroFileState } from '../../src/main/zotero-read-snapshot'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

/** A WAL-mode database with one row, closed cleanly (SQLite checkpoints and removes the log). */
function closedDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wf-snapshot-'))
  directories.push(directory)
  const path = join(directory, 'zotero.sqlite')
  const db = new Database(path)
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES (\'one\')')
  db.close()
  return path
}

function immutableCount(path: string): number {
  const db = new Database(`file:${path}?immutable=1`, { readonly: true })
  try {
    return (db.query('SELECT count(*) AS n FROM notes').get() as { n: number }).n
  } finally {
    db.close()
  }
}

test('a cleanly closed database reads complete, and the read writes nothing beside it', async () => {
  const path = closedDatabase()
  const before = readdirSync(join(path, '..')).sort()
  const result = await readBracketed(path, () => immutableCount(path))
  expect(result).toEqual({ complete: true, value: 1 })
  expect(readdirSync(join(path, '..')).sort()).toEqual(before)
})

test('a log with content (Zotero running, or crashed) is never complete', async () => {
  const path = closedDatabase()
  const writer = new Database(path)
  writer.exec('PRAGMA wal_autocheckpoint=0; INSERT INTO notes VALUES (\'two\')')
  try {
    expect(zoteroFileState(path)).toBeNull()
    const result = await readBracketed(path, () => immutableCount(path))
    // The immutable read misses the row still in the log, and says so.
    expect(result).toEqual({ complete: false, value: 1 })
  } finally {
    writer.close()
  }
})

test('SOL D: a write and checkpoint between the read and the check leave an empty log, and still the read is not complete', async () => {
  const path = closedDatabase()
  const result = await readBracketed(path, () => {
    const value = immutableCount(path)
    // Zotero starts, writes and checkpoints (TRUNCATE leaves an empty log) after the read but before the check.
    const writer = new Database(path)
    writer.exec('INSERT INTO notes VALUES (\'two\'); PRAGMA wal_checkpoint(TRUNCATE)')
    writer.close()
    return value
  })
  expect(result.complete).toBe(false)
  expect(immutableCount(path)).toBe(2)
})

test('a missing database is not complete', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wf-snapshot-'))
  directories.push(directory)
  expect(zoteroFileState(join(directory, 'zotero.sqlite'))).toBeNull()
  expect((await readBracketed(join(directory, 'zotero.sqlite'), () => 0)).complete).toBe(false)
})
