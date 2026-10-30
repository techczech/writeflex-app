/**
 * Whether a read of `zotero.sqlite` saw everything Zotero has committed, without opening anything
 * that writes beside the file (ADR-0047).
 *
 * Zotero keeps its database in write-ahead-log mode. The Reading Room reads it with `immutable=1`,
 * which never touches the log or takes a lock, and so may miss writes that are still only in the log.
 * A read-only open without `immutable=1` would see the log, but it creates `zotero.sqlite-shm` and an
 * empty `zotero.sqlite-wal` beside the database and leaves them there, and it holds a read lock that
 * can stop Zotero opening its database at that moment. So instead the immutable read is bracketed:
 *
 *   before ──▶ read ──▶ after
 *
 * Each side is a fingerprint of the database file (device, inode, size, modification and change time
 * in nanoseconds) and of the log (absent, or empty with its own times). The read is complete only when
 * the log held nothing before, and both fingerprints are identical: no write, checkpoint or truncation
 * happened while it ran, so the database file alone was the whole committed state. A log with content
 * (Zotero running with unsaved checkpoints, or a crash) makes the read incomplete; nothing is written
 * to find out.
 */
import { statSync } from 'node:fs'

/** The bracket's fingerprint, or null when the log holds content (or anything cannot be read). */
export function zoteroFileState(databasePath: string): string | null {
  try {
    const database = statSync(databasePath, { bigint: true })
    let log = 'none'
    try {
      const wal = statSync(`${databasePath}-wal`, { bigint: true })
      if (wal.size !== 0n) return null
      log = `empty:${wal.ino}:${wal.mtimeNs}:${wal.ctimeNs}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    return [database.dev, database.ino, database.size, database.mtimeNs, database.ctimeNs, log].join(':')
  } catch {
    return null
  }
}

/**
 * Run `read` between two fingerprints. `complete` is true only when the log was empty or absent and
 * nothing about either file changed while the read ran.
 */
export async function readBracketed<T>(databasePath: string, read: () => T | Promise<T>): Promise<{ value: T; complete: boolean }> {
  const before = zoteroFileState(databasePath)
  const value = await read()
  const after = zoteroFileState(databasePath)
  return { complete: before !== null && before === after, value }
}
