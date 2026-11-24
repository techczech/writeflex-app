/**
 * Issue 257: read a backup tool's own verification records for one folder, read-only, and say what they prove.
 *
 * The records are those of a backup tool that keeps its settings in a dot-folder in the home folder (`~/.<tool>`,
 * the folder set in Settings › Advanced › Backup) and its status beside it in `~/.local/state/<tool>`. This reads
 * four files, and nothing else:
 *  - `config.toml` in the settings folder: `repos_dir` and this Mac's `machine_id`.
 *  - `catalogue-local.json` there, its `accepted` part (schema 3): which repositories exist, their branch, and which
 *    Macs are selected for each (`selectedOn` below follows the tool's own selection rule).
 *  - `sync-status.json` (schema 1) in the status folder, written by the tool's resident worker about every five
 *    minutes. Proof of delivery is `last_agreement` (local head and tree equal a verified remote head), confirmed by
 *    a later `last_successful_remote_check` of the same head, and counted only while `eligible_current` holds, as
 *    the tool's own folder view does. `last_publish` records a push, not delivery, and is never used as proof.
 *  - `accepted-sync-targets.json` there, when present: the branch each repository's target expects.
 *
 * The proof is bound to this exact checkout: the folder's own Git root (found on disk, so a nested repository is
 * never credited with its parent's proof) must be the catalogue's repository path under `repos_dir` after resolving
 * links, its branch must be the catalogue's, and the status row must describe that path. Anything missing, of
 * another schema, malformed, dated ahead of the clock or for another machine is "unavailable" or "stale", never
 * "protected". The returned proof has `coverage: unchecked` until src/main/local-writing.ts compares this checkout's
 * writing with it. Strings from the records reach the display only through fixed wording, which names the tool as
 * its reader does (src/main/backup-tool-adapter.ts) or as "the backup tool".
 */
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BACKUP_TOOL, FRESH_MS, FUTURE_SLACK_MS, toolNamed, toolSays, type BackupToolEvidence, type BackupToolInfo } from '../shared/remote-protection'
import type { BackupToolReader } from './backup-tool'

/** The records are small; anything larger is not read (and parsing it would hold the main process). */
const MAX_RECORD_BYTES = 8 * 1024 * 1024
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

type Json = Record<string, unknown>
const record = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null
const oid = (v: unknown): string | null => typeof v === 'string' && OID.test(v) ? v : null
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
const seconds = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : null
/** A display-safe name: printable, short. */
const label = (v: string) => v.replace(/[^\p{L}\p{N} ._'’()-]/gu, '').slice(0, 40) || 'this Mac'

/**
 * One record, read through the handle it was checked on: never through a link (O_NOFOLLOW), never a pipe or device
 * (O_NONBLOCK, then a regular-file check on the open handle), and never more than MAX_RECORD_BYTES.
 */
export async function boundedRecord(path: string, max = MAX_RECORD_BYTES): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > max) throw new Error('not a record')
    const buffer = Buffer.alloc(Math.min(info.size, max) + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > max) throw new Error('record too large')
    return buffer.subarray(0, length).toString('utf8')
  } finally { await handle.close() }
}
const bounded = (path: string) => boundedRecord(path)
async function json(path: string): Promise<unknown> { return JSON.parse(await bounded(path)) }

/** The four records read, each directly inside its folder. Nothing else in either folder is opened. */
export const RECORD_FILES = { config: 'config.toml', catalogue: 'catalogue-local.json', status: 'sync-status.json', targets: 'accepted-sync-targets.json' } as const
/** A settings folder name the status folder can be found from: one dot-folder name, no path. */
const TOOL_FOLDER = /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * The settings folder and its status folder, resolved and confined: the settings folder is a real folder named like
 * `.tool`; the status folder is exactly `<its parent>/.local/state/tool` with no link anywhere on that path. Null when
 * either cannot be trusted; a missing status folder is still returned (its records are then simply absent).
 */
export async function recordFolders(records: string): Promise<{ settings: string; status: string; home: string } | null> {
  const plainFolder = async (path: string) => { const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink() }
  try {
    // The selected folder itself is never a link: a link would redirect every record read.
    const settings = resolve(records)
    if (!TOOL_FOLDER.test(basename(settings)) || !(await plainFolder(settings))) return null
    const home = dirname(settings), status = join(home, '.local', 'state', basename(settings).slice(1))
    // Nor is any folder between the home folder and the status folder.
    for (const folder of [join(home, '.local'), join(home, '.local', 'state'), status]) {
      const there = await lstat(folder).then(() => true, () => false)
      if (!there) break // no status yet: its records are simply absent
      if (!(await plainFolder(folder))) return null
    }
    return { settings, status, home }
  } catch { return null }
}

/** The two top-level string keys this needs from a TOML file; the tool writes them as `key = "value"`. */
export function tomlStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) break // keys after the first table belong to it
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/\\(.)/g, '$1')
  }
  return out
}

async function real(path: string): Promise<string | null> {
  try { return await realpath(path) } catch { return null }
}
const inside = (base: string, path: string) => { const r = relative(base, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }

/** The nearest folder at or above `folder` holding `.git` (a folder or a worktree file), without running Git. */
export async function gitRootOf(folder: string): Promise<string | null> {
  for (let at = folder; ; at = dirname(at)) {
    try { await lstat(join(at, '.git')); return at } catch { /* keep climbing */ }
    if (dirname(at) === at) return null
  }
}
/** The checked-out branch from HEAD, read from disk; null when detached or unreadable. */
export async function branchOf(root: string): Promise<string | null> {
  try {
    let gitDir = join(root, '.git')
    if ((await lstat(gitDir)).isFile()) {
      const pointer = /^gitdir:\s*(.+)\s*$/m.exec(await bounded(gitDir))
      if (!pointer) return null
      gitDir = resolve(root, pointer[1])
    }
    return /^ref: refs\/heads\/(.+)\s*$/.exec(await bounded(join(gitDir, 'HEAD')))?.[1] ?? null
  } catch { return null }
}

export function selectedOn(accepted: Json, repo: Json, machine: string): boolean {
  if (repo.unmanaged === true) return false
  if (!record(accepted.machines) || !(machine in accepted.machines)) return false
  const choice = record(repo.selections) ? repo.selections[machine] : undefined
  if (choice === 'selected') return true
  if (choice === 'deselected') return false
  const bucket = str(repo.bucket) && record(accepted.buckets) ? accepted.buckets[repo.bucket as string] : undefined
  const defaults = record(bucket) ? bucket.default_selected_machines : accepted.unbucketed_default_selected_machines
  return Array.isArray(defaults) && defaults.includes(machine)
}

const unavailable = (reason: Extract<BackupToolEvidence, { state: 'unavailable' }>['reason'], detail: string): BackupToolEvidence => ({ state: 'unavailable', reason, detail })
/** The status folder beside a settings folder: `<home>/.<tool>` keeps its status in `<home>/.local/state/<tool>`. */
export const statusFolder = (records: string) => join(dirname(records), '.local', 'state', basename(records).replace(/^\./, ''))

/** What the records in `options.records` (the tool's settings folder) prove about `folder`. `~` in `repos_dir` is the folder holding the settings folder, unless `home` says otherwise. */
export async function readRecordEvidence(folder: string, options: { records: string; home?: string; now?: number; tool?: BackupToolInfo }): Promise<BackupToolEvidence> {
  const now = options.now ?? Date.now()
  const tool = options.tool ?? BACKUP_TOOL, says = toolSays(tool), named = toolNamed(tool), remote = tool.remote
  const UNREADABLE = `${says}’s records on this Mac could not be read, so WriteFlex cannot tell whether this folder reaches ${remote}.`

  const blockerWords: Record<string, string> = {
    manual_changes: `changes were made that ${named} will not upload automatically`,
    blocked: 'uploads are blocked',
  }
  const schedulerWords: Record<string, string> = { paused: `${named} is paused on this Mac`, degraded: `${named} is running with problems on this Mac`, stopped: `${named} is stopped on this Mac` }
  const readinessWords: Record<string, string> = { moving: `${named} is moving this folder`, cloning: `${named} is still copying this folder`, waiting_space: `${named} is waiting for disk space for this folder`, blocked: `${named} cannot place this folder` }
  const retryWords: Record<string, string> = { remote_unreachable: `${remote} could not be reached`, auth: `${remote} refused sign-in`, rejected: `${remote} rejected the upload` }

  const notSetUp = unavailable('not-installed', `${says} is not set up on this Mac, so WriteFlex has no record that this folder reaches ${remote}.`)
  if (!(await lstat(options.records).catch(() => null))) return notSetUp
  const folders = await recordFolders(options.records)
  if (!folders) return unavailable('unreadable', UNREADABLE)
  const records = folders.settings, statusDir = folders.status, home = options.home ?? folders.home
  let config: Record<string, string>
  try { config = tomlStrings(await bounded(join(records, RECORD_FILES.config))) } catch { return notSetUp }
  const machine = config.machine_id, reposDir = config.repos_dir
  if (!machine || !reposDir) return unavailable('unreadable', UNREADABLE)
  const base = await real(reposDir.startsWith('~/') ? join(home, reposDir.slice(2)) : reposDir === '~' ? home : reposDir)
  const target = await real(folder)
  if (!base || !target) return unavailable('unreadable', UNREADABLE)
  const gitRoot = await gitRootOf(target)
  // Inside repos_dir both before and after links are resolved: a link out of the managed folders fails closed.
  if (!gitRoot || !inside(base, gitRoot)) return unavailable('not-managed', `This folder is not in a repository ${named} looks after, so ${named} does not back it up.`)
  const unitPath = relative(base, gitRoot).split(sep).join('/')

  let accepted: Json
  try {
    const catalogue = await json(join(records, RECORD_FILES.catalogue))
    if (!record(catalogue) || !record(catalogue.accepted) || catalogue.accepted.schema !== 3 || !record(catalogue.accepted.repositories) || count(catalogue.accepted.revision) === null) throw new Error('shape')
    accepted = catalogue.accepted
  } catch { return unavailable('unreadable', UNREADABLE) }

  // Exactly this checkout's repository: never a parent repository's entry for a nested checkout.
  const repo = Object.values(accepted.repositories as Json).filter(record).find(r => r.path === unitPath)
  if (!repo || repo.unmanaged === true || !str(repo.id)) return unavailable('not-managed', `${says} does not look after this folder’s repository, so it does not back it up.`)
  const unit = unitPath
  const names = record(accepted.machines) ? accepted.machines : {}
  const machineName = label(record(names[machine]) ? str((names[machine] as Json).name) ?? machine : machine)
  if (!selectedOn(accepted, repo, machine)) return { state: 'excluded', unit, machine: machineName }
  const bucket = str(repo.bucket) && record(accepted.buckets) ? accepted.buckets[repo.bucket as string] : undefined
  // The tool's own effective mode: own mode, else the bucket's default (manual when the bucket is missing),
  // else the unbucketed default, which serde fills with automatic_documents when absent.
  const mode = str(repo.mode) ?? (str(repo.bucket) ? (record(bucket) ? str(bucket.default_mode) : 'manual') : (str(accepted.unbucketed_default_mode) ?? 'automatic_documents'))
  if (mode !== 'automatic_documents') return unavailable('not-verified', `${says} does not upload this folder automatically, so WriteFlex has no verified upload to show.`)

  let status: Json
  try {
    const value = await json(join(statusDir, RECORD_FILES.status))
    if (!record(value) || value.schema !== 1 || !record(value.repositories)) throw new Error('shape')
    status = value
  } catch { return unavailable('unreadable', UNREADABLE) }
  if (status.machine_id !== machine) return unavailable('unreadable', `${says}’s upload record belongs to another computer, so it says nothing about this Mac.`)
  const entry = (status.repositories as Json)[repo.id as string]
  if (!record(entry)) return unavailable('not-verified', `${says} has not yet reported on this folder from this Mac.`)
  // The row must describe exactly this checkout and branch: its path, the branch the tool manages and the branch it
  // observed. Missing or different fields fail closed (review round 2).
  const wanted = str(repo.branch)
  if (entry.relative_path !== unitPath) return unavailable('not-verified', `${says}’s record does not describe this copy of the repository.`)
  if (!wanted || entry.managed_branch !== wanted || entry.branch !== wanted) return unavailable('not-verified', `${says}’s record is for a different branch from the one this folder uses.`)
  try {
    const targets = await json(join(statusDir, RECORD_FILES.targets))
    const target = record(targets) && record(targets.targets) ? targets.targets[repo.id as string] : undefined
    if (record(target) && target.managed_branch !== wanted) return unavailable('not-verified', `${says}’s record is for a different branch from the one this folder uses.`)
  } catch { /* an absent target list adds nothing; the row and catalogue already agree */ }
  if (entry.mode !== 'automatic_document') return unavailable('not-verified', `${says} does not upload this folder automatically, so WriteFlex has no verified upload to show.`)

  const agreement = record(entry.last_agreement) ? entry.last_agreement : null
  const agreedEvidence = agreement && record(agreement.evidence) ? agreement.evidence : null
  const check = record(entry.last_successful_remote_check) ? entry.last_successful_remote_check : null
  const checkEvidence = check && record(check.evidence) ? check.evidence : null
  const verifiedAt = seconds(agreedEvidence?.observed_at), checkedAt = seconds(checkEvidence?.observed_at), generated = seconds(status.generated_at)
  const head = oid(agreement?.head)
  const proof = agreement !== null && head !== null && oid(agreement.tree) !== null && agreement.remote_head === head
    && verifiedAt !== null && count(agreedEvidence?.sequence) !== null
    && check !== null && check.head === head && checkedAt !== null && count(checkEvidence?.sequence) !== null
    && (checkEvidence!.sequence as number) >= (agreedEvidence!.sequence as number)
  const proven = proof ? verifiedAt : null

  // Conflicts: named only inside this folder; others are counted, never named.
  const within = relative(gitRoot, target).split(sep).join('/')
  const conflicts = Array.isArray(entry.conflict_paths) ? entry.conflict_paths.filter((p): p is string => typeof p === 'string') : []
  // Files the tool's secret check holds out of uploads are not backed up: they need the writer too.
  const held = Array.isArray(entry.held_back_paths) ? entry.held_back_paths.filter((p): p is string => typeof p === 'string') : []
  if (!conflicts.length && held.length) {
    const mine = held.filter(p => !within || p === within || p.startsWith(within + '/'))
    return { state: 'conflicts', unit, count: held.length, verifiedAt: null, examples: mine.slice(0, 3).map(p => `${label(p.split('/').at(-1) ?? p)} held back by ${named}’s secret check`), elsewhere: held.length - mine.length }
  }
  const blocker = record(entry.blocker) ? entry.blocker : null
  const blockerCode = blocker ? str(blocker.code) ?? 'blocked' : null
  if (conflicts.length || (blockerCode && blockerCode !== 'protection_overdue')) {
    const mine = conflicts.filter(p => !within || p === within || p.startsWith(within + '/'))
    const examples = conflicts.length ? mine.slice(0, 3).map(p => label(p.split('/').at(-1) ?? p)) : [blockerWords[blockerCode!] ?? `${named} needs attention`]
    return { state: 'conflicts', unit, count: conflicts.length || 1, verifiedAt: proven, examples, elsewhere: conflicts.length - mine.length }
  }
  const stale = (why: string): BackupToolEvidence => ({ state: 'stale', unit, verifiedAt: proven, why })
  if ([generated, verifiedAt, checkedAt].some(t => t !== null && t > now + FUTURE_SLACK_MS)) return stale('its record is dated ahead of this Mac’s clock')
  // Proof observed after the record was written cannot come from that record's worker cycle.
  if (generated !== null && [verifiedAt, checkedAt].some(t => t !== null && t > generated + FUTURE_SLACK_MS)) return stale('its record is inconsistent')
  if (blockerCode === 'protection_overdue') return stale('changes here have not been confirmed uploaded')
  if (status.scheduler !== 'running') return stale(schedulerWords[String(status.scheduler)] ?? `${named} is not running on this Mac`)
  if (!record(status.git) || status.git.healthy !== true) return stale(`${named}’s Git check on this Mac is failing`)
  if (generated === null || now - generated > FRESH_MS) return stale(`${named} has not checked this Mac recently`)
  if (status.accepted_config_revision !== accepted.revision) return stale(`${named} on this Mac has not yet applied its latest folder settings`)
  const readiness = record(status.folder_readiness) ? status.folder_readiness[repo.id as string] : undefined
  if (record(readiness) && readiness.state !== 'ready') return stale(readinessWords[String(readiness.state)] ?? `${named} reports this folder as not ready`)
  if (record(readiness) && str(readiness.observed_path) && await real(readiness.observed_path as string) !== gitRoot) return stale(`${named}’s record describes a copy of this repository in another place`)
  const branch = await branchOf(gitRoot)
  if (branch !== wanted) return stale(branch ? `this copy is on a different branch from the one ${named} looks after` : 'this copy is not on a branch')
  if (entry.retry != null) return stale(retryWords[String(record(entry.retry) ? entry.retry.condition : '')] ? `${named} is retrying: ${retryWords[String((entry.retry as Json).condition)]}` : `${named} is retrying an upload`)
  if (entry.pending_remote_failure != null) return stale(`${named}’s last upload attempt failed`)
  if (entry.eligible_current !== true) return stale(`${named} no longer counts its last upload as current`)
  if (proven === null) return unavailable('not-verified', `${says} has not yet verified an upload of this folder from this Mac.`)
  if (now - proven > FRESH_MS || now - checkedAt! > FRESH_MS) return stale(`${named} has not confirmed this folder recently`)
  // The tool's own observation of this checkout: anything not clean or past the agreement is newer writing.
  const recordNewer = entry.clean !== true || entry.dirty_count !== 0 || entry.head !== head || entry.tree !== agreement!.tree
  return { state: 'protected', unit, verifiedAt: proven, head: head!, root: gitRoot, branch: wanted, coverage: recordNewer ? { kind: 'waiting', since: null } : { kind: 'unchecked' } }
}

/** A reader for such records, naming the tool as `tool` and looking in `defaultRecords` when nothing is set in Settings. */
export function recordsReader(tool: BackupToolInfo, defaultRecords: (home: string) => string | null): BackupToolReader {
  return { info: tool, defaultRecords, read: (folder, records, { now }) => readRecordEvidence(folder, { records, now, tool }) }
}
