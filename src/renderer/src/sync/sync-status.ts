/** A view is captured before a read/action. A changed vault, mount or editor view invalidates it. */
export type SyncView = Readonly<{ vaultId: string; epoch: number; revision: number }>
export type SyncSource = { id: string; name: string; changedAt: number; revision: string }
export type SyncDocument = {
  id: string
  /** Canonical vault-relative path: slash-separated, no empty/dot segments or absolute paths. */
  path: string
  title: string
  kind: 'changed' | 'new' | 'deleted'
  pendingSince?: number
  backedUpAt?: number
  incoming?: { source: string; observedAt: number }
  review?: { sources: readonly SyncSource[] }
  recovery?: string
}
export type SyncInput = {
  view: SyncView
  /** One monotonic counter per exact view, shared by subscription publications and
   * action results; allocate at capture, before async work. Late reads cannot replace newer facts. */
  observation: number
  availability: 'unconfigured' | 'unavailable' | 'auth-denied' | 'scanner-missing' | 'ready'
  connection: 'online' | 'offline' | 'unknown'
  automatic: boolean | null
  local: { dirtyPaths: readonly string[]; complete: boolean }
  /** Null revision is a dated disk/remote observation with NO editor coverage. */
  backup: { verifiedAt: number; protectedThrough: number | null; revision: number | null; remoteRevision: string } | null
  /** This is a successful branch observation, never a cache timestamp or a push receipt. */
  check: { observedAt: number; validUntil: number; revision: number; remoteRevision: string; matches: boolean; unchangedDocuments?: number } | null
  documents: readonly SyncDocument[]
}
export type SyncRow = {
  document: SyncDocument
  mark: 'review' | 'wait' | 'late' | 'came' | 'new' | 'gone' | null
  detail: string
  sources: readonly SyncSource[]
}
export type SyncTone = 'green' | 'amber' | 'red' | 'blue' | 'grey'
export type SyncPresentation = {
  label: string
  summary: string
  heading: string
  description: string
  tone: SyncTone
  checked: string
  unchangedDocuments: number | null
  facts: { local: string; backup: string; branch: string }
  groups: { id: string; label: string; rows: SyncRow[] }[]
  marks: ReadonlyMap<string, SyncRow>
}
export const sameSyncView = (a: SyncView, b: SyncView): boolean =>
  a.vaultId === b.vaultId && a.epoch === b.epoch && a.revision === b.revision
const dated = (time: number, now: number): boolean => Number.isFinite(time) && time > 0 && time <= now
export const syncTime = (time: number, now = Date.now()): string => {
  if (!dated(time, now) || !Number.isFinite(new Date(time).getTime())) return 'time unknown'
  const date = new Date(time)
  const clock = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === new Date(now).toDateString() ? clock : `${date.toLocaleDateString('en-GB')} ${clock}`
}
/** A successful shared-branch comparison can grant at most one minute of freshness.
 * backup.remoteRevision is the backup-branch snapshot; check.remoteRevision is the
 * shared-branch head. They name distinct refs and need not be equal. */
export const MAX_SYNC_FRESHNESS_MS = 60_000
export const checkExpiresAt = (check: NonNullable<SyncInput['check']>): number => Math.min(check.validUntil, check.observedAt + MAX_SYNC_FRESHNESS_MS)

const minutes = (time: number, now: number): number => Math.max(1, Math.floor((now - time) / 60_000))
const availabilityWords: Record<SyncInput['availability'], string> = {
  unconfigured: 'Sync is not set up for this vault', unavailable: 'Sync is unavailable',
  'auth-denied': 'Backup needs sign-in', 'scanner-missing': 'Backup safety check is unavailable', ready: '',
}
export function presentSync(input: SyncInput, now: number): SyncPresentation {
  const pending = input.documents.filter(d => d.pendingSince !== undefined)
  const oldest = Math.min(...pending.map(d => d.pendingSince!).filter(t => dated(t, now)))
  const overdue = Number.isFinite(oldest) && now - oldest >= 300_000
  const review = input.documents.some(d => d.review !== undefined)
  const recovery = input.documents.some(d => d.recovery !== undefined)
  const incoming = input.documents.some(d => d.incoming !== undefined)
  const proof = input.backup && dated(input.backup.verifiedAt, now) ? input.backup : null
  const check = input.check && dated(input.check.observedAt, now) ? input.check : null
  const saved = input.local.complete && input.local.dirtyPaths.length === 0
  const currentProof = proof !== null && proof.remoteRevision.trim().length > 0 && typeof proof.revision === 'number' && proof.revision === input.view.revision
    && proof.protectedThrough !== null && dated(proof.protectedThrough, proof.verifiedAt)
  const currentCheck = check !== null && check.remoteRevision.trim().length > 0 && check.revision === input.view.revision && check.matches
    && Number.isFinite(check.validUntil) && check.validUntil >= check.observedAt && checkExpiresAt(check) > now
  const missingDetails = input.documents.some(d => !d.recovery && !d.review && d.pendingSince === undefined && !d.incoming && (d.backedUpAt === undefined || !dated(d.backedUpAt, now)))
  const fresh = input.availability === 'ready' && input.connection === 'online' && saved
    && currentProof && currentCheck && !pending.length && !review && !incoming && !recovery && !missingDetails
  const checked = check ? `Checked ${syncTime(check.observedAt, now)}` : 'Not yet checked'
  let label = fresh ? `Up to date · checked ${syncTime(check!.observedAt, now)}`
    : currentProof ? 'Backed up · check needed' : 'Remote backup not verified'
  let tone: SyncTone = fresh ? 'green' : 'grey'
  if (pending.length || input.local.dirtyPaths.length) { label = 'Waiting to send'; tone = 'amber' }
  if (incoming) { label = 'Incoming changes'; tone = 'blue' }
  if (review) { label = currentProof ? 'Backed up · review needed' : 'Needs review'; tone = 'amber' }
  if (overdue) { label = `Backup overdue · ${minutes(oldest, now)} minutes of work`; tone = 'red' }
  const heading = label
  if (input.connection === 'offline') {
    label = `Offline · ${check ? `last checked ${syncTime(check.observedAt, now)}` : 'not yet checked'}`
    tone = overdue ? 'red' : 'amber'
  }
  if (recovery) { label = 'Recovery needed'; tone = 'red' }
  if (input.availability !== 'ready') { label = availabilityWords[input.availability]; tone = overdue || recovery ? 'red' : 'grey' }
  const groups: SyncPresentation['groups'] = []
  const marks = new Map<string, SyncRow>()
  const add = (id: string, title: string, row: SyncRow): void => {
    let group = groups.find(g => g.id === id)
    if (!group) { group = { id, label: title, rows: [] }; groups.push(group) }
    group.rows.push(row)
    marks.set(row.document.path, row)
  }
  for (const d of input.documents) {
    const row: SyncRow = { document: d, mark: null, detail: '', sources: d.review?.sources ?? [] }
    if (d.recovery !== undefined) add('recovery', 'Recovery needed', { ...row, mark: 'review', detail: d.recovery })
    else if (d.review) add('review', 'Needs review', { ...row, mark: 'review', detail: 'Needs review' })
    else if (d.pendingSince !== undefined) add('pending', 'Waiting to send', { ...row,
      mark: dated(d.pendingSince, now) && now - d.pendingSince >= 300_000 ? 'late' : 'wait',
      detail: dated(d.pendingSince, now) ? `Waiting to send · ${minutes(d.pendingSince, now)} min` : 'Waiting to send · time unknown' })
    else if (d.incoming) add('incoming', 'Came in from another source', { ...row, mark: 'came', detail: `Came in from ${d.incoming.source} · ${syncTime(d.incoming.observedAt, now)}` })
    else if (d.kind === 'new') add('new', 'New', { ...row, mark: 'new', detail: d.backedUpAt && dated(d.backedUpAt, now) ? `New · backed up ${syncTime(d.backedUpAt, now)}` : 'New · backup not verified' })
    else if (d.kind === 'deleted') add('deleted', 'Deleted', { ...row, mark: 'gone', detail: d.backedUpAt && dated(d.backedUpAt, now) ? `Deleted · backed up ${syncTime(d.backedUpAt, now)}` : 'Deleted · backup not verified' })
    else if (d.backedUpAt && dated(d.backedUpAt, now)) add('backed-up', 'Changed here and backed up', { ...row, detail: `Backed up ${syncTime(d.backedUpAt, now)}` })
    else add('unknown', 'Details unknown', { ...row, detail: 'Document details unknown · backup not verified' })
  }
  const order = ['recovery', 'review', 'pending', 'incoming', 'backed-up', 'new', 'deleted', 'unknown']
  groups.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  const offlineLabel = `Offline · ${check ? `last checked ${syncTime(check.observedAt, now)}` : 'not yet checked'}`
  const description = input.availability !== 'ready'
    ? `${availabilityWords[input.availability]}. Your local writing remains available.`
    : input.connection === 'offline' ? `${offlineLabel}. ${saved ? 'Your writing is saved here' : 'Some local changes are not yet saved'} but the latest edits may not be backed up.`
      : [pending.length && `${pending.length} waiting to send`, incoming && `${input.documents.filter(d => d.incoming).length} came in`, review && `${input.documents.filter(d => d.review).length} needs review`].filter(Boolean).join(' · ')
        || (fresh ? 'Your saved writing matches the last successful remote check.' : 'Check the remote before relying on this vault being up to date.')
  return { label, summary: [pending.length && `${pending.length} waiting to send${Number.isFinite(oldest) ? ` · oldest ${minutes(oldest, now)} min` : ' · age unknown'}`, incoming && `${input.documents.filter(d => d.incoming).length} incoming`, review && `${input.documents.filter(d => d.review).length} needs review`, recovery && 'Recovery needed'].filter(Boolean).join(' · '), heading: recovery ? 'Recovery needed' : overdue ? heading : input.availability !== 'ready' ? label : heading, description, tone, checked, groups, marks,
    unchangedDocuments: currentCheck && saved && input.connection === 'online' && input.availability === 'ready' && Number.isSafeInteger(check?.unchangedDocuments) && check!.unchangedDocuments! >= 0 ? check!.unchangedDocuments! : null,
    facts: { local: saved ? 'Saved here' : input.local.dirtyPaths.length ? `${input.local.dirtyPaths.length} documents have unsaved changes here` : 'Local save coverage unknown',
      backup: proof?.revision === null ? `Remote backup verified ${syncTime(proof.verifiedAt, now)} · editor coverage unknown` : proof ? `Remote backup verified ${syncTime(proof.verifiedAt, now)} · ${proof.protectedThrough && dated(proof.protectedThrough, proof.verifiedAt) ? `Protected through ${syncTime(proof.protectedThrough, now)}` : 'Protected-through time unknown'}` : 'Remote backup not verified',
      branch: check ? `${checked}${currentCheck ? '' : ' · a new check is needed'}` : 'Remote branch not yet checked' } }
}

export type SyncAction = 'syncNow' | 'check' | 'history' | 'review'
export type SyncSelection = { view: SyncView; document: SyncDocument }
/** Absent ports disable their controls. Navigation never writes or reconciles a document. */
export type SyncActionPorts = {
  syncNow?: (view: SyncView) => Promise<SyncInput>
  check?: (view: SyncView) => Promise<SyncInput>
  history?: (view: SyncView) => void | Promise<void>
  review?: (selection: SyncSelection) => void | Promise<void>
}
/** One subscription per vault/adapter. updateView requests an observation for an
 * exact new view; requests may coalesce for up to 250ms. Producers capture that
 * view and allocate its shared observation counter before async work, never on
 * completion. Port promises must settle within a finite client timeout and on disposal. Edits
 * invalidate delivery but do not cancel native work. Settling delivery on timeout
 * or disposal makes no claim that an already sent native operation was cancelled. */
export type SyncSubscription = { updateView: (view: SyncView) => void; unsubscribe: () => void }
export type SyncAdapter = {
  subscribe: (view: SyncView, publish: (input: unknown) => void) => SyncSubscription
  actions: SyncActionPorts
  /** Optional adapter-owned explanation; never proof or an editor acknowledgement. */
  coverageExplanation?: () => string
}
export type SyncOperation = { view: SyncView; sequence: number }
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && !v.includes('\0')
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
export const canonicalSyncPath = (v: unknown): v is string => text(v) && !v.includes('\\') && !/^(?:\/|[a-z]:[\\/])/i.test(v) && v.split('/').every(p => p !== '' && p !== '.' && p !== '..')
const date = (v: unknown, now: number): v is number => typeof v === 'number' && dated(v, now) && Number.isFinite(new Date(v).getTime())
/** Validate and detach unknown bridge data before accessing it or allowing render.
 * Bad data is diagnostic uncertainty; never silently collapse duplicate paths/IDs. */
export function validateSyncInput(value: unknown, now = Date.now()): SyncInput | null {
  try {
    const v: unknown = structuredClone(value)
    if (!record(v) || !record(v.view) || !text(v.view.vaultId) || !integer(v.view.epoch) || !integer(v.view.revision)
      || !integer(v.observation) || !['unconfigured','unavailable','auth-denied','scanner-missing','ready'].includes(v.availability as string)
      || !['online','offline','unknown'].includes(v.connection as string) || (typeof v.automatic !== 'boolean' && v.automatic !== null)
      || !record(v.local) || typeof v.local.complete !== 'boolean' || !Array.isArray(v.local.dirtyPaths)
      || !Array.from(v.local.dirtyPaths).every(canonicalSyncPath) || new Set(v.local.dirtyPaths).size !== v.local.dirtyPaths.length
      || !Array.isArray(v.documents)) return null
    if (v.backup !== null) {
      const b = v.backup
      if (!record(b) || !date(b.verifiedAt, now) || (b.revision !== null && !integer(b.revision)) || !text(b.remoteRevision)
        || (b.protectedThrough !== null && !date(b.protectedThrough, b.verifiedAt))) return null
    }
    if (v.check !== null) {
      const c = v.check
      if (!record(c) || !date(c.observedAt, now) || typeof c.validUntil !== 'number' || !Number.isFinite(c.validUntil)
        || !Number.isFinite(new Date(c.validUntil).getTime()) || c.validUntil < c.observedAt
        || !integer(c.revision) || !text(c.remoteRevision) || typeof c.matches !== 'boolean'
        || (c.unchangedDocuments !== undefined && !integer(c.unchangedDocuments))) return null
    }
    const paths = new Set<string>(), ids = new Set<string>()
    for (const d of v.documents) {
      if (!record(d) || !text(d.id) || !canonicalSyncPath(d.path) || !text(d.title) || !['changed','new','deleted'].includes(d.kind as string)
        || paths.has(d.path) || ids.has(d.id)) return null
      paths.add(d.path); ids.add(d.id)
      for (const field of ['pendingSince','backedUpAt']) if (d[field] !== undefined && !date(d[field], now)) return null
      if (d.recovery !== undefined && !text(d.recovery)) return null
      if (d.incoming !== undefined && (!record(d.incoming) || !text(d.incoming.source) || !date(d.incoming.observedAt, now))) return null
      if (d.review !== undefined) {
        if (!record(d.review) || !Array.isArray(d.review.sources)) return null
        const sources = new Set<string>()
        for (const source of d.review.sources) {
          if (!record(source) || !text(source.id) || !text(source.name) || !text(source.revision) || !date(source.changedAt, now) || sources.has(source.id)) return null
          sources.add(source.id)
        }
      }
    }
    return v as SyncInput
  } catch { return null }
}
/** Retain dated facts only inside one vault epoch. Exact view guards still control
 * publication; retained facts are never rewritten to the new revision. */
export class SyncSession {
  current: SyncInput | null = null
  invalid = false
  private sequence = 0
  private observation = -1
  constructor(public view: SyncView, private clock: () => number = Date.now) {}
  get stale(): boolean { return this.current !== null && !sameSyncView(this.current.view, this.view) }
  reset(view: SyncView): void {
    if (sameSyncView(view, this.view)) return
    if (view.vaultId !== this.view.vaultId || view.epoch !== this.view.epoch) this.current = null
    this.view = view; this.observation = -1; this.invalid = false; this.sequence++
  }
  invalidate(): void { this.invalid = true; this.sequence++ }
  begin(): SyncOperation { return { view: this.view, sequence: ++this.sequence } }
  publish(value: unknown): boolean {
    const input = validateSyncInput(value, this.clock())
    if (!input) { this.invalidate(); return false }
    if (!sameSyncView(input.view, this.view) || input.observation <= this.observation) return false
    this.sequence++; this.current = input; this.observation = input.observation; this.invalid = false; return true
  }
  isCurrent(operation: SyncOperation): boolean {
    return operation.sequence === this.sequence && sameSyncView(operation.view, this.view)
  }
  complete(operation: SyncOperation, value: unknown): boolean {
    if (!this.isCurrent(operation)) return false
    const input = validateSyncInput(value, this.clock())
    if (!input) { this.invalidate(); return false }
    if (!sameSyncView(input.view, this.view) || input.observation <= this.observation) return false
    this.current = input; this.observation = input.observation; this.invalid = false; this.sequence++; return true
  }
}

/** App updates only at proof expiry or a pending mark's overdue boundary.
 * Minute ages and calendar rollover belong to the small display components. */
export function nextSyncBoundary(input: SyncInput, now: number, display = false): number | null {
  const times: number[] = []
  if (input.check) times.push(checkExpiresAt(input.check))
  for (const d of input.documents) if (d.pendingSince !== undefined && dated(d.pendingSince, now)) {
    times.push(d.pendingSince + 300_000)
    if (display) times.push(d.pendingSince + (Math.floor((now - d.pendingSince) / 60_000) + 1) * 60_000)
  }
  if (display && (input.backup || input.check || input.documents.length)) {
    const midnight = new Date(now); midnight.setHours(24,0,0,0); times.push(midnight.getTime())
  }
  const next = Math.min(...times.filter(t => t > now))
  return Number.isFinite(next) ? next : null
}

/** Closed folders / Folios roll up their most urgent descendant; no green mark is fabricated. */
export function syncMarkFor(marks: SyncPresentation['marks'], path: string, descendants = false): SyncRow | undefined {
  if (!descendants) return marks.get(path)
  const priority = ['review', 'late', 'wait', 'came', 'new', 'gone']
  return [...marks.values()].filter(row => row.document.path === path || row.document.path.startsWith(path + '/'))
    .filter(row => row.mark !== null).sort((a, b) => priority.indexOf(a.mark!) - priority.indexOf(b.mark!))[0]
}
