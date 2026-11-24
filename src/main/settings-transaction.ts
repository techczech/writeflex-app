// WriteFlex batches app-layer reconciliation with public Bridle operations under its file lock.
import { randomUUID } from 'node:crypto'
import {
  commandsAdapter, loadState, stateProblem, changedTargets, RULE_FAILED, LIMITS,
  type OpContext, type OpResult, type SettingsState, type Actor, type WriteRoute, type WriteProposal,
} from '@app-patterns/settings'
import { MAX_FILE_BYTES, type SettingsStore, type SettingsStoreOptions, type StoreResult } from '@app-patterns/settings/node'
import { registry } from '../shared/bridle-commands'
import { schema, migrateLegacy } from '../shared/settings-schema'
import { appKeysStateError } from '../shared/keymap-overrides'
import { guardSettingsFile } from './settings-file-policy'

export type StateOperation = (state: SettingsState, ctx: OpContext) => OpResult
export type TransactionOptions = Pick<SettingsStoreOptions, 'beforeWrite' | 'maxBytes' | 'now' | 'newId' | 'log'> & { route?: WriteRoute }

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Bridle 0.2.0 keeps these helpers private. Match mutateNow's whole-batch byte fitting. */
function fitted(state: SettingsState, keep: number, max: number, log: (line: string) => void, path: string): SettingsState {
  const size = (s: SettingsState) => Buffer.byteLength(JSON.stringify(s, null, 2) + '\n', 'utf8')
  if (size(state) <= max) return state
  const groups = new Map<string, number>()
  state.changes.forEach((entry, i) => {
    const id = entry.batch !== undefined ? `b:${entry.batch}` : `e:${i}`
    groups.set(id, (groups.get(id) ?? 0) + 1)
  })
  let changes = state.changes
  for (const count of [...groups.values()].reverse()) {
    const next = changes.slice(0, changes.length - count)
    if (next.length < keep) break
    changes = next
    if (size({ ...state, changes }) <= max) {
      log(`Settings: the oldest ${state.changes.length - changes.length} changes were dropped to keep ${path} under ${max} bytes`)
      return { ...state, changes }
    }
  }
  return state
}

function judge(hook: NonNullable<TransactionOptions['beforeWrite']>, proposal: WriteProposal, log: (line: string) => void): string | null {
  // Match Bridle's frozen, bounded proposal and fail-closed verdict handling.
  const who = proposal.who
  const bounded: Actor = who.kind === 'you' ? { kind: 'you' } : who.kind === 'agent'
    ? { kind: 'agent', name: who.name.slice(0, LIMITS.name) }
    : { kind: 'app-update', version: String(who.version).slice(0, LIMITS.name) }
  let verdict: unknown
  try {
    verdict = hook(freeze(structuredClone({ ...proposal, who: bounded })))
  } catch (error) {
    log(`Settings: the app's beforeWrite rule threw (${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}); the change was not saved`)
    return RULE_FAILED
  }
  if (verdict === undefined || verdict === null) return null
  if (typeof verdict === 'object' && !Array.isArray(verdict) && 'reject' in verdict && typeof verdict.reject === 'string' && !(verdict instanceof Promise)) {
    return verdict.reject.trim().slice(0, LIMITS.text) || RULE_FAILED
  }
  log(`Settings: the app's beforeWrite rule returned ${verdict instanceof Promise ? 'a promise (it must be synchronous)' : 'something other than nothing or { reject }'}; the change was not saved`)
  if (verdict instanceof Promise) void verdict.catch(() => {})
  return RULE_FAILED
}

/** The decision, app policy and operation all see the file read under the cross-process lock. */
export async function updateSettings(store: Pick<SettingsStore, 'ready' | 'file' | 'reload'>, version: string, who: Actor, operation: StateOperation, options: TransactionOptions = {}): Promise<StoreResult> {
  guardSettingsFile(store.file)
  await store.ready
  const log = options.log ?? (() => {})
  const ctx: OpContext = { schema, commands: commandsAdapter(registry), who, now: options.now ?? Date.now, newId: options.newId ?? randomUUID }
  const result = await store.file.update<StoreResult>((read) => {
    if (read.kind === 'refused' || read.kind === 'damaged') return { result: { ok: false, code: 'refused', error: read.kind === 'refused' ? read.error : 'The settings file is unavailable.' } }
    const loaded = loadState(read.kind === 'ok' ? read.raw : undefined, { ...ctx, appVersion: version, migrate: migrateLegacy })
    if (loaded.problem) return { result: { ok: false, code: 'refused', error: 'The settings file is unavailable.' } }
    const out = operation(loaded.state, ctx)
    if (!out.ok) return { result: out }
    if (!out.entries.length && !loaded.lossy) return { result: out }
    const next = fitted(out.state, out.entries.length + loaded.entries.length, options.maxBytes ?? MAX_FILE_BYTES, log, store.file.path)
    const entries = [...out.entries, ...loaded.entries]
    if (options.beforeWrite && (out.entries.length || loaded.migrated)) {
      const reason = judge(options.beforeWrite, {
        route: options.route ?? 'migration', who, before: loaded.state, next, entries, ...changedTargets(entries),
      }, log)
      if (reason !== null) return { result: { ok: false, code: 'rejected', error: reason } }
    }
    const problem = stateProblem(next, schema, ctx.commands) ?? appKeysStateError(next.keys, next.settings['keyboard.appKeys'])
    if (problem) return { result: { ok: false, code: 'invalid-value', error: problem } }
    return { result: { ...out, state: next }, write: next }
  })
  if (!result.ok) return { ok: false, code: result.code, error: result.error }
  await store.reload()
  return result.result
}
