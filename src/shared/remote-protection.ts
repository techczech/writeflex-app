/**
 * Issue 257: whether a Git vault's writing is known to have reached its remote, from evidence only.
 *
 * Two routes can carry a Git vault to its remote: WriteFlex's own vault sync (ADR 0055) and a backup tool that runs
 * outside WriteFlex. A save puts writing on this Mac's disk and proves nothing about either route. It can only take
 * coverage away: writing saved, changed or committed after the backup tool's verified upload is "waiting" until a
 * newer proof covers it. The backup tool's state comes from the records it keeps itself, read by a reader for that
 * tool from the folder set in Settings (src/main/backup-tool.ts) and compared with this checkout by
 * src/main/local-writing.ts; WriteFlex sync's from its own send results. With no backup tool connected nothing is
 * read, and the folder is shown as saved on this Mac only.
 */
export type IgnoredGroup = { count: number; examples: string[] }
/** What the repository's Git ignore rules leave out of every commit in this folder (src/main/backup-coverage.ts). */
export type IgnoredWriting = { checkedAt: number; notes: IgnoredGroup; recovery: IgnoredGroup; history: IgnoredGroup; /** Where the rules are: ".gitignore line 2", ".git/info/exclude line 1", "global Git excludes line 4". */ sources: string[] }
/** A completed audit, one still running, or one Git could not answer. Only a completed audit can confirm no gaps. */
export type IgnoreAudit = IgnoredWriting | 'pending' | 'unavailable'

/** How the backup tool is named on screen: its label, how a sentence names it when not by that label, and where it uploads to. */
export type BackupToolInfo = { name: string; remote: string; subject?: string }
/** The wording when no backup tool is connected. */
export const NO_BACKUP_TOOL: BackupToolInfo = { name: 'Backup tool', subject: 'The backup tool', remote: 'a remote' }
/** The wording for a backup tool known only by its records. */
export const BACKUP_TOOL: BackupToolInfo = { name: 'Backup tool', subject: 'The backup tool', remote: 'its remote' }
/** The tool at the start of a sentence, and inside one. */
export const toolSays = (tool: BackupToolInfo) => tool.subject ?? tool.name
export const toolNamed = (tool: BackupToolInfo) => tool.subject ? tool.subject[0].toLowerCase() + tool.subject.slice(1) : tool.name

export type BackupToolUnavailable = 'not-connected' | 'not-installed' | 'not-managed' | 'unreadable' | 'not-verified'
/** How this checkout's writing compares with the verified upload. */
export type Coverage =
  /** Git shows nothing newer here than the verified commit and tree, and no WriteFlex save came after it. */
  | { kind: 'current' }
  /** Saved, changed or committed writing here is newer than the verified upload; `since` is the oldest such change when known. */
  | { kind: 'waiting'; since: number | null }
  /** The comparison could not be made safely or in time (no Git tools, Git failed, deadline passed): shown amber, never as backed up. */
  | { kind: 'unchecked' }
  /** This checkout's own Git does not bear the record out: another root or branch, or no remote-tracking ref holding
   *  the verified commit. Records alone never make a folder green. */
  | { kind: 'unconfirmed' }
export type BackupToolEvidence =
  /** The backup tool recorded that this checkout's commit reached its remote, observed at `verifiedAt`. */
  | { state: 'protected'; unit: string; verifiedAt: number; /** The verified commit, used only for the local comparison. */ head: string; /** The checkout's Git root and branch the record describes; the local comparison must find exactly these. */ root: string; branch: string; coverage: Coverage }
  /** The backup tool's settings do not select this Mac for the folder: it uploads nothing from here. */
  | { state: 'excluded'; unit: string; machine: string }
  /** The backup tool's record cannot be relied on now: its last verified upload, if any, and why. */
  | { state: 'stale'; unit: string; verifiedAt: number | null; why: string }
  /** The backup tool reports conflicts or blocked uploads for the folder that need a person. `elsewhere` counts those outside this folder. */
  | { state: 'conflicts'; unit: string; count: number; verifiedAt: number | null; examples: string[]; elsewhere: number }
  /** No usable evidence: never read as protected. */
  | { state: 'unavailable'; reason: BackupToolUnavailable; detail: string }

export type RemoteProtection = { /** Which backup tool the evidence is from, as shown on screen. */ tool: BackupToolInfo; evidence: BackupToolEvidence; ignored: IgnoreAudit; readAt: number }

/** WriteFlex vault sync, as the panel already shows it: on/off, its numbered state (gitState) and its last send. */
export type WriteFlexRoute = { enabled: boolean; state: number | null; lastSentAt?: number; busy?: boolean }

export type ProtectionTone = 'green' | 'amber' | 'red' | 'grey'
export type RouteStatus = { name: string; tone: ProtectionTone; text: string }
export type ProtectionView = {
  /** Short words for the status bar. */
  label: string
  tone: ProtectionTone
  heading: string
  /** One status per route (WriteFlex sync, the backup tool), each with its own colour. */
  routes: RouteStatus[]
  /** Sentences after the routes. */
  lines: string[]
  /** Ignored-file lines. */
  gaps: string[]
}

const MINUTE = 60_000, DAY = 86_400_000
/** Backup tool proof older than this, or newer writing waiting longer than this, is not shown as backed up. */
export const FRESH_MS = 15 * MINUTE
/** Records dated more than 30 s ahead of the clock are rejected. */
export const FUTURE_SLACK_MS = 30_000

export function protectionTime(time: number, now: number): string {
  const date = new Date(time)
  const clock = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === new Date(now).toDateString()) return `today ${clock}`
  const days = Math.max(1, Math.round((now - time) / DAY))
  const day = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  return `${day} ${clock} (${days} day${days === 1 ? '' : 's'} ago)`
}
const short = (time: number, now: number) => protectionTime(time, now).replace(/ \(.*\)$/, '')
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const quoted = (list: string[]) => list.map(e => `“${e}”`).join(', ')
const examples = (group: IgnoredGroup) => quoted(group.examples) + (group.count > group.examples.length ? ', …' : '')

export function ignoredLines(ignored: IgnoreAudit): string[] {
  if (ignored === 'pending') return ['Checking this folder’s Git ignore rules…']
  if (ignored === 'unavailable') return ['WriteFlex could not check this folder’s Git ignore rules, so it cannot say whether any notes or history are left out.']
  const lines: string[] = []
  if (ignored.notes.count) lines.push(`Git ignore rules leave out ${plural(ignored.notes.count, 'note or draft', 'notes or drafts')}: ${examples(ignored.notes)}.`)
  if (ignored.recovery.count) lines.push(`Git ignore rules leave out ${plural(ignored.recovery.count, 'WriteFlex recovery file', 'WriteFlex recovery files')}: ${examples(ignored.recovery)}.`)
  if (ignored.history.count) lines.push(`Git ignore rules leave out this collection’s history (${plural(ignored.history.count, 'file')} in ${quoted(ignored.history.examples)}).`)
  if (lines.length) lines.push(`Ignored files are never committed, so no route backs them up.${ignored.sources.length ? ` The rules are in ${ignored.sources.join('; ')}.` : ''} Remove those rules to include them.`)
  return lines
}
const hasGaps = (ignored: IgnoreAudit) => typeof ignored === 'object' && ignored.notes.count + ignored.recovery.count + ignored.history.count > 0

/** The backup tool's route on its own, judged at `now`: proof expires here, not only at the next read. */
export function backupToolStatus(evidence: BackupToolEvidence, now: number, tool: BackupToolInfo = NO_BACKUP_TOOL): RouteStatus & { label: string; heading: string } {
  const { name, remote } = tool, says = toolSays(tool), named = toolNamed(tool)
  switch (evidence.state) {
    case 'protected': {
      const at = evidence.verifiedAt
      if (at > now + FUTURE_SLACK_MS) return { name, tone: 'amber', label: 'Backup record out of date', heading: 'Backup not confirmed recently', text: `${says}’s record is dated ahead of this Mac’s clock, so it cannot be relied on.` }
      if (now - at > FRESH_MS) return { name, tone: 'amber', label: 'Backup record out of date', heading: 'Backup not confirmed recently', text: `${says} has not confirmed this folder since ${protectionTime(at, now)}.` }
      const c = evidence.coverage
      if (c.kind === 'unconfirmed') return { name, tone: 'amber', label: 'Backup not confirmed here', heading: 'Backup not confirmed by this copy', text: `${says}’s record says this folder was uploaded ${protectionTime(at, now)}, but this copy’s own Git does not show that commit on its remote, so WriteFlex cannot confirm it.` }
      if (c.kind === 'unchecked') return { name, tone: 'amber', label: 'Backed up · could not check newer writing', heading: 'Newer writing not checked', text: `${says} verified an upload ${protectionTime(at, now)}, but WriteFlex could not compare this folder’s writing with it.` }
      if (c.kind === 'waiting') {
        const since = c.since ?? at
        if (now - since > FRESH_MS) return { name, tone: 'amber', label: 'Newer writing not backed up', heading: 'Newer writing not backed up', text: `Writing here changed after ${named}’s last verified upload (${protectionTime(at, now)}) and has waited${c.since ? ` since ${protectionTime(c.since, now)}` : ''} without a newer one. It is on this Mac only.` }
        return { name, tone: 'green', label: 'Backed up · newer writing waiting', heading: `Backed up by ${named}, newer writing waiting`, text: `${says} last verified an upload of this folder to ${remote} ${protectionTime(at, now)}. Writing saved since then is on this Mac only until its next verified upload.` }
      }
      return { name, tone: 'green', label: `Backed up ${short(at, now)}`, heading: `Backed up by ${named}`, text: `${says} last verified an upload of this folder to ${remote} ${protectionTime(at, now)}, and nothing here is newer.` }
    }
    case 'excluded': return { name, tone: 'red', label: 'Not backed up from this Mac', heading: 'Not backed up from this Mac', text: `${says} is set not to keep this folder on this Mac (${evidence.machine}), so it uploads nothing you save here.` }
    case 'stale': return { name, tone: 'amber', label: 'Backup record out of date', heading: 'Backup not confirmed recently', text: `${says}’s record for this folder cannot be relied on: ${evidence.why}. ${evidence.verifiedAt ? `Its last verified upload was ${protectionTime(evidence.verifiedAt, now)}.` : 'It has no verified upload of this folder.'}` }
    case 'conflicts': {
      const named = evidence.examples.length ? ` (${evidence.examples.join('; ')}${evidence.elsewhere ? `; ${evidence.elsewhere} elsewhere in the repository` : ''})` : evidence.elsewhere ? ` (${evidence.elsewhere} elsewhere in the repository)` : ''
      return { name, tone: 'amber', label: 'Backup needs attention', heading: 'Backup needs attention', text: `${says} reports ${plural(evidence.count, 'problem')} that need${evidence.count === 1 ? 's' : ''} you${named}. New writing may not reach ${remote} until ${evidence.count === 1 ? 'it is' : 'they are'} resolved.${evidence.verifiedAt ? ` Last verified upload: ${protectionTime(evidence.verifiedAt, now)}.` : ''}` }
    }
    case 'unavailable': return evidence.reason === 'not-connected'
      ? { name, tone: 'grey', label: 'Saved on this Mac only', heading: 'No backup tool connected', text: evidence.detail }
      : { name, tone: 'grey', label: 'Backup not verified', heading: 'Remote backup not verified', text: evidence.detail }
  }
}

function writeFlexStatus(route: WriteFlexRoute, now: number): RouteStatus | null {
  if (!route.enabled) return null
  const sent = route.lastSentAt ? `last sent ${protectionTime(route.lastSentAt, now)}` : 'nothing sent yet'
  const name = 'WriteFlex sync'
  return route.state === 4 ? { name, tone: 'red', text: `Stopped (${sent}).` }
    : route.state === 3 ? { name, tone: 'amber', text: `On, with writing waiting to send (${sent}).` }
      : route.state === 5 ? { name, tone: 'amber', text: `On; documents need you (${sent}).` }
        : { name, tone: route.lastSentAt ? 'green' : 'grey', text: `On and up to date (${sent}).` }
}

/**
 * The one reading of both routes. WriteFlex sync, when on and up to date, speaks for the headline; the backup tool
 * is always reported beside it with its own colour. A red or amber backup tool route is never hidden, and nothing
 * turns green because of a save. `tool` names the backup tool before its first evidence arrives.
 */
export function presentProtection(protection: RemoteProtection | null | undefined, route: WriteFlexRoute, now = Date.now(), tool: BackupToolInfo = protection?.tool ?? NO_BACKUP_TOOL): ProtectionView {
  if (!protection) {
    const wf = writeFlexStatus(route, now)
    return { label: 'Checking backup…', tone: 'grey', heading: 'Checking the remote copy', routes: [...(wf ? [wf] : []), { name: tool.name, tone: 'grey', text: `Reading ${toolNamed(tool)}’s records…` }], lines: [], gaps: [] }
  }
  const wf = writeFlexStatus(route, now)
  const rs = backupToolStatus(protection.evidence, now, protection.tool)
  const gaps = ignoredLines(protection.ignored)
  const writeflexOk = route.enabled && route.state !== null && route.state <= 2 && route.lastSentAt !== undefined
  let { label, tone, heading } = writeflexOk ? { label: `Sent ${short(route.lastSentAt!, now)}`, tone: 'green' as ProtectionTone, heading: 'Sent to the remote by WriteFlex sync' } : rs
  const lines: string[] = []
  if (!route.enabled && rs.tone !== 'green') lines.push('WriteFlex saves your writing on this Mac. That alone is not a backup.')
  if (tone === 'green' && hasGaps(protection.ignored)) { tone = 'amber'; label = 'Backed up, with gaps'; heading = `${heading}, except ignored files` }
  else if (tone === 'green' && protection.ignored === 'unavailable') { tone = 'amber'; label = `${label} · ignore rules not checked` }
  // A completed audit is the only one that can confirm nothing is left out: until then the badge says so.
  else if (tone === 'green' && protection.ignored === 'pending') { label = 'Backed up · still checking'; heading = `${heading}, still checking ignore rules` }
  return { label, tone, heading, routes: [...(wf ? [wf] : []), { name: rs.name, tone: rs.tone, text: rs.text }], lines, gaps }
}
