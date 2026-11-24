/**
 * Issue 257: a backup tool's evidence for one folder, read-only.
 *
 * A backup tool is a program outside WriteFlex that commits a Git vault and uploads it to its remote. Its reader
 * (src/main/backup-tool-records.ts, set up in src/main/backup-tool-adapter.ts) knows what its records look like and
 * what they prove. WriteFlex reads them from the folder set in Settings › Advanced › Backup (this Mac only, never
 * imported), or, when that is empty, from the reader's own default place, if it has one. With no folder, no backup
 * tool is connected: nothing is read and the folder is shown as saved on this Mac only.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NO_BACKUP_TOOL, type BackupToolEvidence, type BackupToolInfo } from '../shared/remote-protection'

export type BackupToolReader = {
  /** How the tool is named on screen. */
  info: BackupToolInfo
  /** Where the tool keeps its records when nothing is set in Settings, or null for nowhere. */
  defaultRecords(home: string): string | null
  /** What the records under `records` prove about `folder`. Missing, foreign or damaged records are "unavailable", never proof. */
  read(folder: string, records: string, options: { now?: number }): Promise<BackupToolEvidence>
}

const SAVED_HERE = 'Your writing is saved on this Mac only.'
export const NOT_CONNECTED: BackupToolEvidence = { state: 'unavailable', reason: 'not-connected', detail: `No backup tool is connected, so WriteFlex has no record that this folder reaches a remote. ${SAVED_HERE}` }
const NO_READER: BackupToolEvidence = { state: 'unavailable', reason: 'not-connected', detail: `This build of WriteFlex cannot read the backup tool records in the folder set in Settings, so no backup tool is connected. ${SAVED_HERE}` }

/** The folder the reader reads: the setting when it names one, else the reader's default. */
export function backupToolRecords(setting: unknown, reader: BackupToolReader | null, home = homedir()): string | null {
  const set = typeof setting === 'string' ? setting.trim() : ''
  if (set) return set === '~' ? home : set.startsWith('~/') ? join(home, set.slice(2)) : set
  return reader?.defaultRecords(home) ?? null
}

export const backupToolInfo = (reader: BackupToolReader | null): BackupToolInfo => reader?.info ?? NO_BACKUP_TOOL

export async function readBackupToolEvidence(folder: string, setting: unknown, reader: BackupToolReader | null, options: { home?: string; now?: number } = {}): Promise<BackupToolEvidence> {
  const records = backupToolRecords(setting, reader, options.home)
  if (!records) return NOT_CONNECTED
  if (!reader) return NO_READER
  return reader.read(folder, records, { now: options.now })
}

/**
 * A reading is shown only while it came from the records folder the setting names now. When the folder changes the
 * old reading is gone at once (null: "checking" until the new folder is read); with no folder the not-connected
 * state shows straight away.
 */
export function readingForSource<T>(shown: { source: string | null; reading: T } | undefined, source: string | null, notConnected: () => T): T | undefined {
  if (source === null) return notConnected()
  return shown && shown.source === source ? shown.reading : undefined
}

/** Runs `work` for a key only when the last run for that key has settled, even if its caller stopped waiting for it:
 *  a stalled records folder never collects more reads. Null when one is still running. */
export function singleFlight(): <T>(key: string, work: () => Promise<T>) => Promise<T> | null {
  const running = new Map<string, Promise<unknown>>()
  return <T>(key: string, work: () => Promise<T>) => {
    if (running.has(key)) return null
    const run = work()
    running.set(key, run)
    run.then(() => running.delete(key), () => running.delete(key))
    return run
  }
}
