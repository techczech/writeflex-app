/** Pristine copies and their provenance. Missing or uncertain lineage always fails closed. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { readdir } from 'node:fs/promises'
import { BACKUP_SUFFIX, BACKUP_RECORD_SUFFIX } from '../shared/backup-files'
import { fileIdentityOf } from './workspace-watcher'
import type { Workspace } from './workspace'

export { BACKUP_SUFFIX, BACKUP_RECORD_SUFFIX } from '../shared/backup-files'
type Boundary = Pick<Workspace, 'absolute' | 'relative'>
type RecordOfBackup = { version: 1; path: string; hash: string; createdAt: string; latestHash: string; identity: string }
export type BackupInspection = { backupPath: string; path: string; recordPath?: string; status: 'ready' | 'stale' | 'confirmation-required'; message: string }
export type BackupComparison = { path: string; backupPath: string; current: string; backup: string }
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const refusal = (): Error => new Error('This backup does not belong to the current file. Nothing was written.')
const identity = (absolute: string): string => {
  const info = lstatSync(absolute, { bigint: true })
  if (!info.isFile()) throw refusal()
  return `${info.dev}:${info.ino}`
}
function recordAt(ws: Boundary, backup: string): RecordOfBackup | null {
  const absolute = ws.absolute(`${backup.slice(0, -BACKUP_SUFFIX.length)}${BACKUP_RECORD_SUFFIX}`)
  if (!existsSync(absolute)) return null
  const record = JSON.parse(readFileSync(absolute, 'utf8')) as RecordOfBackup
  if (record.version !== 1 || typeof record.path !== 'string' || !/^[a-f0-9]{64}$/.test(record.hash)
    || !/^[a-f0-9]{64}$/.test(record.latestHash) || typeof record.identity !== 'string'
    || !Number.isFinite(Date.parse(record.createdAt))) throw refusal()
  return record
}
function belongs(ws: Boundary, backup: string, record: RecordOfBackup): boolean {
  const path = backup.slice(0, -BACKUP_SUFFIX.length)
  if (record.path !== ws.relative(ws.absolute(path))) return false
  const absolute = ws.absolute(path)
  const currentIdentity = identity(absolute)
  if (hash(readFileSync(ws.absolute(backup))) !== record.hash) return false
  const current = hash(readFileSync(absolute))
  return current === record.hash || (current === record.latestHash && currentIdentity === record.identity)
}

/** Preserve orphan evidence before publishing a fresh record and its atomic byte copy. */
export async function createBackup(ws: Workspace, path: string, source: string): Promise<void> {
  await ws.exclusiveAll(async () => {
    const backup = `${path}${BACKUP_SUFFIX}`
    if (existsSync(ws.absolute(backup))) return
    const absolute = ws.absolute(path)
    const bytes = readFileSync(absolute)
    if (!bytes.equals(Buffer.from(source))) throw new Error('The file changed before its backup was made. Nothing was written.')
    const recorded: RecordOfBackup = { version: 1, path: ws.relative(absolute), hash: hash(bytes), createdAt: new Date().toISOString(), latestHash: hash(bytes), identity: identity(absolute) }
    const text = `${JSON.stringify(recorded, null, 2)}\n`
    // A crash or a copy-only move must not turn provenance evidence into a write outage.
    const recordPath = `${path}${BACKUP_RECORD_SUFFIX}`
    if (existsSync(ws.absolute(recordPath))) {
      await ws.setAsideBackupRecord(recordPath, `.writeflex/backup-records-set-aside/${basename(recordPath)}.${randomUUID()}.json`)
    }
    await ws.saveFileWithoutReadBack(recordPath, text, { exclusive: true })
    try {
      await ws.saveFileWithoutReadBack(backup, source, { exclusive: true, allowExplicitEmpty: true, beforeCommit: () => {
        if (!readFileSync(absolute).equals(bytes) || identity(absolute) !== recorded.identity) throw refusal()
        if (readFileSync(ws.absolute(recordPath), 'utf8') !== text) throw refusal()
      } })
    } catch (error) {
      if (!existsSync(ws.absolute(backup))) {
        try { ws.removeFileOverRead(recordPath, text) } catch { /* uncertain evidence stays */ }
      }
      throw error
    }
  })
}

export async function inspectBackup(ws: Boundary, backupPath: string): Promise<BackupInspection> {
  const path = backupPath.slice(0, -BACKUP_SUFFIX.length)
  const answer = (status: BackupInspection['status'], message: string): BackupInspection => ({ backupPath, path, status, message })
  try {
    if (!backupPath.endsWith(BACKUP_SUFFIX)) throw refusal()
    identity(ws.absolute(path))
    identity(ws.absolute(backupPath))
    const record = recordAt(ws, backupPath)
    if (!record) return answer('confirmation-required', 'Compare both files and explicitly confirm before using this legacy backup.')
    if (!belongs(ws, backupPath, record)) throw refusal()
    return answer('ready', 'This backup belongs to the current file.')
  } catch {
    return answer('stale', 'This backup is stale or its file history cannot be established. Nothing was written.')
  }
}

/** No existing backup UI exists; this is the main-process listing seam for future callers. */
export async function listBackups(ws: Workspace, dir = ''): Promise<BackupInspection[]> {
  const out: BackupInspection[] = []
  for (const entry of await readdir(dir ? ws.absolute(dir) : ws.root, { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') out.push(...await listBackups(ws, path))
    else if (entry.name.endsWith(BACKUP_SUFFIX)) out.push(await inspectBackup(ws, path))
    else if (entry.name.endsWith(BACKUP_RECORD_SUFFIX)) {
      const backupPath = `${path.slice(0, -BACKUP_RECORD_SUFFIX.length)}${BACKUP_SUFFIX}`
      if (!existsSync(ws.absolute(backupPath))) out.push(await inspectBackup(ws, backupPath))
    }
  }
  if (!dir) {
    const aside = '.writeflex/backup-records-set-aside'
    if (existsSync(ws.absolute(aside))) {
      for (const entry of await readdir(ws.absolute(aside), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const recordPath = `${aside}/${entry.name}`
        // Orphan evidence can be malformed; the document is still named by the original sidecar.
        const suffix = entry.name.lastIndexOf(BACKUP_RECORD_SUFFIX)
        let path = suffix < 0 ? '' : entry.name.slice(0, suffix)
        try {
          const record = JSON.parse(readFileSync(ws.absolute(recordPath), 'utf8'))
          if (typeof record.path === 'string') path = record.path
        } catch { /* Keep malformed evidence visible too. */ }
        out.push({ backupPath: `${path}${BACKUP_SUFFIX}`, path, recordPath,
          status: 'stale', message: 'This backup record was set aside. Nothing was written.' })
      }
    }
  }
  return out.sort((a, b) => a.backupPath.localeCompare(b.backupPath))
}

/** Confirmation receives both complete texts; cancellation and changes during confirmation write nothing. */
export async function restoreBackup(ws: Workspace, backupPath: string, confirm?: (comparison: BackupComparison) => Promise<boolean>): Promise<void> {
  const inspection = await inspectBackup(ws, backupPath)
  if (inspection.status === 'stale') throw refusal()
  const path = inspection.path
  const current = readFileSync(ws.absolute(path), 'utf8')
  const backup = readFileSync(ws.absolute(backupPath), 'utf8')
  const checkedRecord = recordAt(ws, backupPath)
  const currentIdentity = identity(ws.absolute(path))
  const backupIdentity = identity(ws.absolute(backupPath))
  if ((inspection.status === 'confirmation-required' || checkedRecord === null) && (!confirm || !await confirm({ path, backupPath, current, backup }))) {
    throw new Error('This legacy backup needs explicit confirmation showing both files. Nothing was written.')
  }
  await ws.exclusiveAll(async () => {
    await ws.saveFileWithoutReadBack(path, backup, { allowExplicitEmpty: true, beforeCommit: () => {
      if (identity(ws.absolute(path)) !== currentIdentity || identity(ws.absolute(backupPath)) !== backupIdentity
        || readFileSync(ws.absolute(path), 'utf8') !== current || readFileSync(ws.absolute(backupPath), 'utf8') !== backup) throw refusal()
      const record = recordAt(ws, backupPath)
      if (JSON.stringify(record) !== JSON.stringify(checkedRecord) || (record && !belongs(ws, backupPath, record))) throw refusal()
    } })
  })
}

/** Called in the save's commit tick. An unrelated outside version can never start a new lineage. */
export function prepareBackupLineage(ws: Boundary & Pick<Workspace, 'recordOwnWrite' | 'forgetOwnWrites'>, path: string, onRecordWrite: (absolute: string, before: string, after: string) => void, restoredContent?: string): (content: string) => void {
  const backup = `${path}${BACKUP_SUFFIX}`
  try {
    if (!existsSync(ws.absolute(backup))) return () => {}
    const record = recordAt(ws, backup)
    if (!record) return () => {}
    // Only guarded rollback callers can supply restored bytes. The old inode was replaced by
    // the put-back; require the restored record's path, pristine copy and known version instead.
    const restoringKnownVersion = restoredContent !== undefined
      && record.path === ws.relative(ws.absolute(path))
      && hash(readFileSync(ws.absolute(backup))) === record.hash
      && (hash(restoredContent) === record.latestHash || hash(restoredContent) === record.hash)
    if (!restoringKnownVersion && !belongs(ws, backup, record)) return () => {}
    const recordPath = ws.absolute(`${backup.slice(0, -BACKUP_SUFFIX.length)}${BACKUP_RECORD_SUFFIX}`)
    const before = readFileSync(recordPath, 'utf8')
    return (content) => {
      let temp: string | undefined
      try {
        // A failed provenance update must not turn an already committed document save into a failed save.
        if (readFileSync(recordPath, 'utf8') !== before || hash(readFileSync(ws.absolute(path))) !== hash(content)) return
        const next = { ...record, latestHash: hash(content), identity: identity(ws.absolute(path)) }
        temp = ws.absolute(`${path}${BACKUP_RECORD_SUFFIX}.${randomUUID()}.tmp`)
        const after = `${JSON.stringify(next, null, 2)}\n`
        writeFileSync(temp, after, { flag: 'wx' })
        ws.recordOwnWrite(ws.relative(recordPath), fileIdentityOf(lstatSync(temp, { bigint: true })))
        try { renameSync(temp, recordPath) }
        catch (error) { ws.forgetOwnWrites(ws.relative(recordPath)); throw error }
        onRecordWrite(recordPath, before, after)
      } catch { /* stale provenance refuses restoration */ }
      finally { if (temp) { try { unlinkSync(temp) } catch { /* already renamed */ } } }
    }
  } catch { return () => {} }
}
