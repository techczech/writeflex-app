/** Issue 257: the remote-copy status of a Git vault, kept per vault and refreshed off every reply. Read-only: the
 *  backup tool's records (src/main/backup-tool.ts) and offline Git. Used whether vault sync is on or off. */
import { toolSays, type RemoteProtection, type BackupToolEvidence, type IgnoreAudit } from '../shared/remote-protection'
import { BACKUP_TOOL_RECORDS_KEY } from '../shared/git-sync-settings'
import { OFFLINE_GIT_ENV, localCoverage } from './local-writing'
import { NOT_CONNECTED, backupToolInfo, backupToolRecords, readBackupToolEvidence, readingForSource, singleFlight } from './backup-tool'
import { BACKUP_TOOL_READER } from './backup-tool-adapter'
import { ignoredWriting } from './backup-coverage'
import { developerToolsPresent } from './developer-tools'
import { syncGit } from './git-vault-sync-git'
import type { SettingsStore } from './settings'

/** What the remote-copy status reads and keeps per vault (issue 257): read-only Git and the backup tool's records. */
export type ProtectionHolder = { protection?: RemoteProtection; /** The records folder `protection` was read from (null: none set). */ protectionSource?: string | null; /** Bumped whenever that folder changes: a read started under an older selection never publishes. */ selection?: number; /** The last ignore-rule audit: Git's answer for the folder, whatever the records source. */ ignored?: IgnoreAudit; saves?: number[]; gitFolder: boolean; discovery: { state: string } }
export function createRemoteCopy(settings: Pick<SettingsStore, 'get'>) {
  // Issue 257. The backup tool's records (plus Git's comparison of this checkout with them) are re-read at most every
  // 30 s, and Git's ignore answer at most every 5 min or when asked on open/turn on/turn off. Neither is awaited by
  // any reply: each publishes into the slot on its own, and the next 1 s status poll shows it. The renderer expires a
  // shown proof by its own clock (presentProtection), so a slow or stuck refresh can never keep a green badge.
  const readingRecords = new Set<string>(), auditing = new Set<string>(), auditedAt = new Map<string, number>()
  const tool = backupToolInfo(BACKUP_TOOL_READER)
  const unreadable: BackupToolEvidence = { state: 'unavailable', reason: 'unreadable', detail: `${toolSays(tool)}’s records could not be read in time, so WriteFlex cannot tell whether this folder reaches ${tool.remote}.` }
  const within = <T>(work: Promise<T>, ms: number, fallback: T) => Promise.race([work.catch(() => fallback), new Promise<T>(done => setTimeout(() => done(fallback), ms))])
  const flight = singleFlight()
  /** The records folder the setting names now, or null when no backup tool is connected. */
  const recordSource = () => backupToolRecords(settings.get(BACKUP_TOOL_RECORDS_KEY), BACKUP_TOOL_READER)
  const notConnected = (slot: ProtectionHolder): RemoteProtection => ({ tool, evidence: NOT_CONNECTED, ignored: slot.ignored ?? 'pending', readAt: Date.now() })
  async function refreshRecords(root: string, slot: ProtectionHolder) {
    const from = recordSource()
    if (slot.protectionSource !== from) {
      // Another folder, or none: the reading from the old one is never shown again.
      slot.protection = from === null ? notConnected(slot) : undefined
      slot.protectionSource = from
      slot.selection = (slot.selection ?? 0) + 1
    }
    const selection = slot.selection
    if (from === null || readingRecords.has(root) || (slot.protection && Date.now() - slot.protection.readAt < 30_000)) return
    const reading = flight(`${root}\0${from}`, () => readBackupToolEvidence(root, from, BACKUP_TOOL_READER))
    if (!reading) return // the last read of this folder has not finished: wait for it rather than pile up more
    readingRecords.add(root)
    try {
      let evidence = await within(reading, 3000, unreadable)
      if (evidence.state === 'protected') {
        const place = { root: evidence.root, branch: evidence.branch }
        const local = await developerToolsPresent() ? await within(localCoverage(root, evidence.head, evidence.verifiedAt, (args, ms) => syncGit(root, {}, Math.max(1, ms)).run(args, OFFLINE_GIT_ENV), undefined, 8000, place), 10_000, { kind: 'unchecked' as const }) : { kind: 'unchecked' as const }
        // Only this checkout's Git can confirm the record; when it cannot, that is what shows. Otherwise the tool's own
        // record of newer writing is kept, with the time Git found when it found one.
        if (local.kind === 'unchecked' || local.kind === 'unconfirmed') evidence = { ...evidence, coverage: local }
        else if (evidence.coverage.kind === 'waiting') evidence = { ...evidence, coverage: local.kind === 'waiting' ? local : evidence.coverage }
        else evidence = { ...evidence, coverage: local }
      }
      // A read that finishes after the selection changed (even back to the same folder) belongs to the old one: dropped.
      if (slot.selection !== selection || recordSource() !== from) return
      slot.protection = { tool, evidence, ignored: slot.ignored ?? 'pending', readAt: Date.now() }
    } finally { readingRecords.delete(root) }
  }
  async function refreshAudit(root: string, slot: ProtectionHolder, force: boolean) {
    if (auditing.has(root) || (!force && Date.now() - (auditedAt.get(root) ?? 0) < 300_000)) return
    auditing.add(root); auditedAt.set(root, Date.now())
    try {
      const ignored = slot.gitFolder && slot.discovery.state !== 'tools-missing' && await developerToolsPresent() ? (await within(ignoredWriting(root, args => syncGit(root).run(args, OFFLINE_GIT_ENV)), 30_000, null)) ?? 'unavailable' : 'unavailable'
      slot.ignored = ignored // kept apart from the records: a change of records folder never hides known gaps
    } finally { auditing.delete(root) }
  }
  function refreshProtection(root: string, slot: ProtectionHolder, force: boolean) {
    if (force && slot.protection) slot.protection = { ...slot.protection, readAt: 0 }
    void refreshRecords(root, slot).then(() => refreshAudit(root, slot, force))
  }
  /** The proof as of now: shown only for the records folder it came from, and a WriteFlex save after the verified
   *  upload takes its coverage away at once. */
  function currentProtection(slot: ProtectionHolder): RemoteProtection | undefined {
    const shown = slot.protection && slot.protectionSource !== undefined ? { source: slot.protectionSource, reading: slot.protection } : undefined
    const read = readingForSource(shown, recordSource(), () => notConnected(slot))
    const p = read && { ...read, ignored: slot.ignored ?? 'pending' }
    if (!p || p.evidence.state !== 'protected') return p
    const r = p.evidence, later = (slot.saves ?? []).filter(t => t > r.verifiedAt)
    if (!later.length || r.coverage.kind === 'unchecked' || r.coverage.kind === 'unconfirmed') return p
    const since = Math.min(...later, ...(r.coverage.kind === 'waiting' && r.coverage.since !== null ? [r.coverage.since] : []))
    return { ...p, evidence: { ...r, coverage: { kind: 'waiting', since } } }
  }
  return { refreshProtection, currentProtection, tool }
}
