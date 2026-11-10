// The built-in agent skill service: one module behind a small interface, called by the Settings card, the
// onboarding step, the status-bar offer, the launch refresh and the `agent` command line alike, so there is
// one implementation and one changelog (contract: agent-skill.md). No Electron import; nothing here is
// specific to one app: the id, display name, feature sentence, skill folder and command are passed in.
//
// Rules held here (the folder-level ones are in folder.ts):
//  - install covers only the agents named; an agent that was not found is never written for;
//  - a link, an unmarked folder, an edited copy and a newer copy are kept (Replace, from Settings, may
//    override an edited copy, a newer copy and a plain separately installed folder; never a link);
//  - two agents that share one real folder write it once;
//  - refresh on update rewrites only what the person installed, never adds an agent, never lowers a version;
//  - a failed write is a state (`failed` row, last result), never an exception to the caller.
import { homedir } from 'node:os'
import { AGENT_TABLE, type AgentDef } from '../../shared/agent-skill/agents.ts'
import { compareVersions } from '../../shared/agent-skill/versions.ts'
import { EMPTY_STATE } from '../../shared/agent-skill/types.ts'
import type {
  ActionReport, ActionResult, ActionRow, Actor, AgentRow, AgentSkillState, CliRow, LastResult, Offer, RowState, StatusReport
} from '../../shared/agent-skill/types.ts'
import { detectAll, nodeProbe, type DetectContext, type Found, type Probe } from './probe.ts'
import { FolderError, inspectTarget, plainReason, removeSkillFolder, resolveReal, writeSkillFolder, type Inspection } from './folder.ts'
import { loadSkillSource, type SkillSource } from './skill-source.ts'
import { installShim, refreshShim, shimStatus, type ShimLookup, type ShimSpec } from './shim.ts'
import { join } from 'node:path'
import type { StateStore } from './state-files.ts'
import { cliAcceptable } from '../../shared/agent-skill/wording.ts'

export type { StateStore }

export interface AgentSkillConfig {
  appId: string
  appName: string
  /** The folder name inside an agent's skills folder. */
  skillName: string
  /** The running app's version (stamped in the skill; they are always equal). */
  version: string
  /** Where the packaged skill is, or null when this build carries none. */
  skillDir: string | null
  cli: ShimSpec
  store: StateStore
  home?: string
  env?: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
  probe?: Probe
  now?: () => number
  /** Test seams for the command-line shim. */
  shimDir?: string
  shimLookup?: ShimLookup
  table?: readonly AgentDef[]
}

interface Entry {
  def: AgentDef
  found: Found
  /** Real path of the skill folder (null: none of its own, or it could not be resolved). */
  real: string | null
  resolveError: string | null
  insp: Inspection
}

const OK_RESULTS: ReadonlySet<ActionResult> = new Set(['installed', 'updated', 'unchanged', 'removed', 'declined'])

export interface AgentSkills {
  status(): Promise<StatusReport>
  /** `replace` is for the Settings window only; the command line never passes it. */
  install(ids: readonly string[], opts?: { replace?: boolean; who?: Actor }): Promise<ActionReport>
  remove(ids: readonly string[], opts?: { who?: Actor }): Promise<ActionReport>
  /** "Not now": final for that agent. */
  decline(ids: readonly string[], opts?: { who?: Actor }): Promise<ActionReport>
  offer(): Promise<Offer>
  /** The first-run step answered: ticked agents are installed, the rest declined. */
  answerOffer(install: readonly string[], decline: readonly string[]): Promise<ActionReport>
  /** The later offer was shown: each agent in it has had its one offer. */
  offerShown(ids: readonly string[]): Promise<void>
  /** At launch: when the running version differs from the stored one, rewrite what the person installed. */
  refresh(): Promise<ActionReport | null>
}

export function createAgentSkills(config: AgentSkillConfig): AgentSkills {
  const home = config.home ?? homedir()
  const env = config.env ?? process.env
  const platform = config.platform ?? process.platform
  const probe = config.probe ?? nodeProbe()
  const now = config.now ?? Date.now
  const table = config.table ?? AGENT_TABLE
  const ctx: DetectContext = { home, env, platform, probe }
  const tilde = (p: string): string => (p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p)
  const shimOpts = () => ({ spec: config.cli, home, platform, pathEnv: env.PATH ?? '', ...(config.shimDir ? { dir: config.shimDir } : {}), ...(config.shimLookup ? { lookup: config.shimLookup } : {}) })

  const knownId = (id: unknown): id is string => typeof id === 'string' && table.some((d) => d.id === id)
  // Agents are kept in a map with no prototype and looked up by own property, so no id can reach Object.prototype.
  // A state is built from the store's files; `changes` holds only the changes made in this operation. Writing
  // saves only what this operation changed: the agents it touched, the app values it altered, its new changes.
  interface Loaded { dirty: Set<string>; results: Map<string, string>; appVersion: string | null; onboarded: boolean }
  const loaded = new WeakMap<AgentSkillState, Loaded>()
  const readState = (): AgentSkillState => {
    const agents: AgentSkillState['agents'] = Object.create(null)
    for (const d of table) { const r = config.store.readAgent(d.id); if (r) agents[d.id] = { ...r } }
    const app = config.store.readApp()
    const st: AgentSkillState = { ...EMPTY_STATE, appVersion: app?.appVersion ?? null, onboarded: app?.onboarded ?? false, agents, changes: [] }
    loaded.set(st, { dirty: new Set(), results: new Map(Object.entries(agents).map(([id, a]) => [id, JSON.stringify(a.lastResult)])), appVersion: st.appVersion, onboarded: st.onboarded })
    return st
  }
  const writeState = (s: AgentSkillState): void => {
    // A state that cannot be saved is not a failure of the action; each piece is saved on its own.
    const l = loaded.get(s)
    for (const id of l?.dirty ?? []) {
      if (!Object.hasOwn(s.agents, id)) continue
      const a = s.agents[id]
      try { config.store.writeAgent(id, { choice: a.choice, offered: a.offered }) } catch { /* not saved */ }
      // The result is its own file, written only when this operation changed it.
      if (a.lastResult && JSON.stringify(a.lastResult) !== (l?.results.get(id) ?? 'null')) try { config.store.writeResult(id, a.lastResult) } catch { /* not saved */ }
    }
    for (const c of s.changes) try { config.store.appendChange(c) } catch { /* not saved */ }
    const patch: { appVersion?: string | null; onboarded?: boolean } = {}
    if (l && s.appVersion !== l.appVersion) patch.appVersion = s.appVersion
    if (l && s.onboarded !== l.onboarded) patch.onboarded = s.onboarded
    if (Object.keys(patch).length) try { config.store.writeApp(patch) } catch { /* not saved */ }
  }
  const slot = (s: AgentSkillState, id: string): AgentSkillState['agents'][string] => {
    if (!knownId(id)) throw new Error('Not an agent id.')
    loaded.get(s)?.dirty.add(id)
    return Object.hasOwn(s.agents, id) ? s.agents[id] : (s.agents[id] = { choice: null, offered: false, lastResult: null })
  }
  const slotOf = (s: AgentSkillState, id: string): AgentSkillState['agents'][string] | undefined => (Object.hasOwn(s.agents, id) ? s.agents[id] : undefined)

  const loadSource = async (): Promise<SkillSource | null> => {
    if (!config.skillDir) return null
    try { return await loadSkillSource(config.skillDir, config.appId) } catch { return null }
  }

  async function entryFor(def: AgentDef, found: Found): Promise<Entry> {
    const dir = def.skillsDir({ home, env })
    if (!dir) return { def, found, real: null, resolveError: null, insp: { kind: 'absent' } }
    try {
      const real = join(await resolveReal(dir), config.skillName)
      return { def, found, real, resolveError: null, insp: await inspectTarget(real, config.appId) }
    } catch (e) {
      return { def, found, real: null, resolveError: plainReason(e), insp: { kind: 'absent' } }
    }
  }

  async function entries(): Promise<Entry[]> {
    const found = await detectAll(ctx, table)
    return Promise.all(table.map((d) => entryFor(d, found.get(d.id) ?? { found: false, by: null })))
  }

  const nameOf = (id: string): string => table.find((d) => d.id === id)?.name ?? id

  /** Another agent whose copy this one reads (Gemini CLI reads Codex's folder). */
  const sharedWith = (e: Entry, all: readonly Entry[]): Entry | null => {
    if (!e.def.alsoReads || e.insp.kind !== 'absent') return null
    return all.find((o) => e.def.alsoReads!.includes(o.def.id) && (o.insp.kind === 'owned' || o.insp.kind === 'separate')) ?? null
  }

  function rowOf(e: Entry, all: readonly Entry[], source: SkillSource | null, st: AgentSkillState): AgentRow {
    const a = slotOf(st, e.def.id)
    const base: AgentRow = {
      id: e.def.id, name: e.def.name, found: e.found.found, state: 'not-found', version: null, newer: false,
      folder: e.real ? tilde(e.real.slice(0, e.real.lastIndexOf('/'))) : null, reason: null,
      declined: a?.choice === 'declined', canInstall: false, canRemove: false, canReplace: false, through: [], lastResult: a?.lastResult ?? null
    }
    const set = (state: RowState, extra: Partial<AgentRow> = {}): AgentRow => ({ ...base, state, ...extra })
    if (e.def.via) {
      const through = e.def.via.filter((id) => all.find((o) => o.def.id === id)?.found.found).map(nameOf)
      return set('via', { through, reason: through.length ? `Uses ${through.join(' and ')}, so it comes along with them.` : `Uses ${e.def.via.map(nameOf).join(' and ')}.` })
    }
    if (e.resolveError) return set('failed', { reason: e.resolveError, canInstall: e.found.found && !!source })
    const i = e.insp
    const canWrite = !!source
    switch (i.kind) {
      case 'owned': {
        if (i.edited) return set('changed', { version: i.version, reason: i.link ? `A link was added inside this copy, so ${config.appName} leaves it as it is.` : `You have changed this copy. ${config.appName} leaves it as it is.`, canReplace: canWrite && !i.link })
        const cmp = source ? compareVersions(i.version, source.version) : 0
        return set('installed', { version: i.version, newer: cmp === 1, canInstall: cmp === -1 && canWrite, canRemove: true, canReplace: cmp === 1 && canWrite })
      }
      case 'separate':
        return set('separate', { version: i.version, reason: i.plain ? (i.link ? 'Installed another way, with a link inside it. It is left as it is.' : 'Installed another way. Replace puts the copy that comes with the app in its place.') : 'A link to a copy that updates from where it was installed. It is left as it is.', canReplace: i.plain && !i.link && canWrite })
      case 'foreign':
        return set('kept', { reason: i.symlink ? 'Already has its own version (a link). It is left as it is.' : 'Already has its own version. It is left as it is.' })
      case 'unreadable':
        return set('failed', { reason: i.reason, canInstall: e.found.found && canWrite })
      case 'absent': {
        const via = sharedWith(e, all)
        if (via) return set('shared', { version: via.insp.kind === 'owned' || via.insp.kind === 'separate' ? via.insp.version : null, reason: `Reads the copy in ${via.def.name}'s folder.`, through: [via.def.name] })
        if (!e.found.found) return set('not-found')
        if (a?.lastResult && !a.lastResult.ok) return set('failed', { reason: a.lastResult.message, canInstall: canWrite })
        return set('not-installed', { reason: 'Found on this computer', canInstall: canWrite })
      }
    }
  }

  async function cliStatus(): Promise<CliRow> { try { return await shimStatus(shimOpts()) } catch { return { command: config.cli.command, state: 'failed', path: null, onPath: false, message: 'The command-line tool could not be checked.' } } }

  async function buildStatus(all: Entry[], source: SkillSource | null): Promise<StatusReport> {
    const st = readState()
    const agents = all.map((e) => rowOf(e, all, source, st))
    return {
      version: config.version, skillLocation: config.skillDir ? tilde(config.skillDir) : null, skillAvailable: !!source,
      agents, cli: await cliStatus(),
      noneFound: !agents.some((r) => r.found && r.state !== 'via')
    }
  }

  async function status(): Promise<StatusReport> { return buildStatus(await entries(), await loadSource()) }

  const note = (st: AgentSkillState, who: Actor, action: ActionReport['action'], r: ActionRow): void => {
    st.changes.push({ at: now(), who, action, agent: r.id, result: r.result, version: r.version })
  }
  const last = (r: ActionRow): LastResult => ({ ok: OK_RESULTS.has(r.result) || r.result === 'kept' || r.result === 'not-installed', at: now(), message: r.message })

  const sortIds = (ids: readonly string[]): string[] => {
    const wanted = new Set(ids.filter((id): id is string => typeof id === 'string'))
    const known = table.map((d) => d.id).filter((id) => wanted.has(id))
    return [...known, ...[...wanted].filter((id) => !knownId(id))]
  }

  async function ensureCli(): Promise<CliRow> { try { return await installShim(shimOpts()) } catch { return { command: config.cli.command, state: 'failed', path: null, onPath: false, message: 'The command-line tool could not be installed.' } } }

  async function report(action: ActionReport['action'], rows: ActionRow[], written: string[], cli: CliRow | null, okSet: ReadonlySet<ActionResult>): Promise<ActionReport> {
    // The skill and the command are one install: a blocked command makes the report not ok, though the skill rows stay as they are.
    return { ok: rows.length > 0 && rows.every((r) => okSet.has(r.result)) && (cli === null || cliAcceptable(cli)), action, rows, written, cli, status: await status() }
  }

  /** Write one agent's folder for install, refresh or replace. */
  async function put(e: Entry, source: SkillSource, opts: { replace: boolean; wrote: Map<string, ActionRow>; stillWanted?: () => boolean }, onlyIfOurs: boolean): Promise<ActionRow | null> {
    const id = e.def.id
    const row = (result: ActionResult, message: string, version: string | null = null): ActionRow => ({ id, name: e.def.name, result, message, version })
    if (!e.real) return row('failed', e.resolveError ?? 'The folder could not be found.')
    const prior = opts.wrote.get(e.real)
    if (prior) return { ...prior, id, name: e.def.name }
    const i = e.insp
    const folder = tilde(e.real)
    const write = async (replaces: 'nothing' | 'owned' | 'any-plain', replaceEdited: boolean, ok: ActionResult, text: string): Promise<ActionRow | null> => {
      try {
        await writeSkillFolder(e.real!, source, {
          replaces, replaceEdited, noDowngrade: !opts.replace,
          ...(opts.stillWanted ? { hooks: { beforeCommit: () => { if (!opts.stillWanted!()) throw new FolderError('The person no longer has this installed.', 'ECONSENT') } } } : {})
        })
        const r = row(ok, text, source.version)
        opts.wrote.set(e.real!, r)
        return r
      } catch (err) {
        const code = err instanceof FolderError ? err.code : undefined
        // An update never makes a copy that is gone, and never acts for a person who has since removed it.
        if (onlyIfOurs && (code === 'EABSENT' || code === 'ECONSENT')) return null
        if (code === 'ENEWER') return row('kept', `The copy in ${folder} is newer than this one, so it was kept.`)
        return row('failed', plainReason(err))
      }
    }
    switch (i.kind) {
      case 'absent':
        if (onlyIfOurs) return null
        return write('nothing', false, 'installed', `Installed in ${folder}.`)
      case 'owned': {
        const cmp = compareVersions(i.version, source.version)
        if (i.edited) {
          if (opts.replace && !i.link) return write('owned', true, 'updated', `Replaced the changed copy in ${folder}.`)
          return row('kept', i.link ? `A link was added inside the copy in ${folder}, so it was left as it is.` : `You have changed the copy in ${folder}, so it was left as it is.`, i.version)
        }
        if (cmp === 1) {
          if (opts.replace) return write('owned', false, 'updated', `Replaced the newer copy in ${folder}.`)
          return row('kept', `The copy in ${folder} is version ${i.version}, newer than this one, so it was kept.`, i.version)
        }
        const same = cmp === 0 && JSON.stringify(await currentHashes(e.real!)) === JSON.stringify(source.hashes)
        if (same) return row('unchanged', `Already installed in ${folder}.`, i.version)
        return write('owned', false, 'updated', `Updated the copy in ${folder} to version ${source.version}.`)
      }
      case 'separate':
        if (onlyIfOurs) return null
        if (i.plain && !i.link && opts.replace) return write('any-plain', false, 'updated', `Replaced the separately installed copy in ${folder}.`)
        return row('kept', i.plain ? (i.link ? `A copy installed another way, with a link inside it, is in ${folder}, so it was left as it is.` : `A copy installed another way is in ${folder}, so it was left as it is. Replace it from Settings.`) : `${folder} is a link to a copy that updates from where it was installed, so it was left as it is.`, i.version)
      case 'foreign':
        if (onlyIfOurs) return null
        return row('kept', `${folder} already has its own version, so it was left as it is.`)
      case 'unreadable':
        return row('failed', i.reason)
    }
  }

  async function currentHashes(real: string): Promise<Record<string, string>> {
    try {
      const { readFile } = await import('node:fs/promises')
      const marker = JSON.parse(await readFile(join(real, '.app-skill.json'), 'utf8')) as { files?: Record<string, string> }
      return marker.files ?? {}
    } catch { return {} }
  }

  async function install(ids: readonly string[], opts: { replace?: boolean; who?: Actor } = {}): Promise<ActionReport> {
    const who = opts.who ?? { kind: 'you' }
    const source = await loadSource()
    const all = await entries()
    const st = readState()
    const rows: ActionRow[] = []
    const wrote = new Map<string, ActionRow>()
    let anyConnected = false
    for (const id of sortIds(ids)) {
      const e = all.find((x) => x.def.id === id)
      const mk = (result: ActionResult, message: string): ActionRow => ({ id, name: e?.def.name ?? 'Unknown agent', result, message, version: null })
      if (!e) { rows.push(mk('not-found', `That is not an agent ${config.appName} knows.`)); continue }
      let r: ActionRow
      if (e.def.via) r = mk('unsupported', `${e.def.name} has no skills folder of its own: it uses ${e.def.via.map(nameOf).join(' and ')}. Install for those.`)
      else if (!e.found.found) r = mk('not-found', `${e.def.name} was not found on this computer, so nothing was written.`)
      else if (!source) r = mk('failed', `The skill that comes with ${config.appName} could not be read.`)
      else {
        const via = sharedWith(e, [...all.map((x) => (x.real && wrote.has(x.real) ? { ...x, insp: { kind: 'owned', version: source.version, edited: false, why: null, link: null } as Inspection } : x))])
        if (via) r = { id, name: e.def.name, result: 'unchanged', message: `${e.def.name} reads the copy in ${via.def.name}'s folder.`, version: source.version }
        else r = (await put(e, source, { replace: opts.replace === true, wrote }, false))!
      }
      if (['installed', 'updated', 'unchanged'].includes(r.result)) anyConnected = true
      const s = slot(st, id)
      if (anyConnected && ['installed', 'updated', 'unchanged'].includes(r.result)) s.choice = 'connected'
      s.offered = true
      s.lastResult = last(r)
      note(st, who, 'install', r)
      rows.push(r)
    }
    let cli: CliRow | null = null
    if (anyConnected) cli = await ensureCli()
    writeState(st)
    return report('install', rows, [...wrote.keys()].map(tilde), cli, new Set<ActionResult>(['installed', 'updated', 'unchanged']))
  }

  async function remove(ids: readonly string[], opts: { who?: Actor } = {}): Promise<ActionReport> {
    const who = opts.who ?? { kind: 'you' }
    const all = await entries()
    const st = readState()
    const rows: ActionRow[] = []
    const gone = new Map<string, ActionRow>()
    for (const id of sortIds(ids)) {
      const e = all.find((x) => x.def.id === id)
      const mk = (result: ActionResult, message: string): ActionRow => ({ id, name: e?.def.name ?? 'Unknown agent', result, message, version: null })
      if (!e) { rows.push(mk('not-found', `That is not an agent ${config.appName} knows.`)); continue }
      let r: ActionRow
      if (e.def.via) r = mk('unsupported', `${e.def.name} has no copy of its own: it uses ${e.def.via.map(nameOf).join(' and ')}.`)
      else if (!e.real) r = mk('failed', e.resolveError ?? 'The folder could not be found.')
      else if (gone.has(e.real)) r = { ...gone.get(e.real)!, id, name: e.def.name }
      else if (e.insp.kind === 'absent') r = mk('not-installed', sharedWith(e, all) ? `${e.def.name} has no copy of its own; it reads ${sharedWith(e, all)!.def.name}'s.` : 'There is no copy to remove.')
      else if (e.insp.kind === 'owned' && !e.insp.edited) {
        try { await removeSkillFolder(e.real, config.appId); r = mk('removed', `Removed the copy in ${tilde(e.real)}.`); gone.set(e.real, r) } catch (err) { r = mk(err instanceof FolderError && err.code === 'ECHANGED' ? 'kept' : 'failed', plainReason(err)) }
      } else if (e.insp.kind === 'owned') r = mk('kept', `You have changed the copy in ${tilde(e.real)}, so it was left as it is.`)
      else if (e.insp.kind === 'unreadable') r = mk('failed', e.insp.reason)
      else r = mk('kept', `${tilde(e.real)} was not installed by ${config.appName}, so it was left as it is.`)
      const s = slot(st, id)
      if (r.result === 'removed' || r.result === 'not-installed') s.choice = 'removed'
      s.lastResult = last(r)
      note(st, who, 'remove', r)
      rows.push(r)
    }
    writeState(st)
    return report('remove', rows, [], null, new Set<ActionResult>(['removed', 'not-installed']))
  }

  async function decline(ids: readonly string[], opts: { who?: Actor } = {}): Promise<ActionReport> {
    const who = opts.who ?? { kind: 'you' }
    const st = readState()
    const rows: ActionRow[] = []
    for (const id of sortIds(ids)) {
      if (!knownId(id)) { rows.push({ id, name: 'Unknown agent', result: 'not-found', message: `That is not an agent ${config.appName} knows.`, version: null }); continue }
      const s = slot(st, id)
      s.choice = 'declined'
      s.offered = true
      const r: ActionRow = { id, name: nameOf(id), result: 'declined', message: 'Not now.', version: null }
      note(st, who, 'decline', r)
      rows.push(r)
    }
    writeState(st)
    return report('decline', rows, [], null, new Set<ActionResult>(['declined']))
  }

  async function offer(): Promise<Offer> {
    const source = await loadSource()
    const all = await entries()
    const st = readState()
    const rows = all.map((e) => rowOf(e, all, source, st))
    const pending = rows.filter((r) => r.found && r.state === 'not-installed' && r.canInstall && !r.declined && !slotOf(st, r.id)?.offered)
    const via = rows.filter((r) => r.state === 'via' && r.found && r.through.length).map((r) => ({ name: r.name, through: r.through }))
    if (!source || pending.length === 0) {
      if (!st.onboarded) { try { config.store.writeApp({ onboarded: true }) } catch { /* asked again next time */ } }
      return { kind: 'none', agents: [], via: [] }
    }
    return { kind: st.onboarded ? 'later' : 'first-run', agents: pending, via }
  }

  async function answerOffer(ids: readonly string[], declineIds: readonly string[]): Promise<ActionReport> {
    const a = ids.length ? await install(ids, {}) : await report('install', [], [], null, new Set())
    const b = declineIds.length ? await decline(declineIds, {}) : null
    try { config.store.writeApp({ onboarded: true }) } catch { /* asked again next time */ }
    return b ? { ...a, rows: [...a.rows, ...b.rows], ok: a.ok || ids.length === 0, status: await status() } : { ...a, ok: ids.length === 0 ? true : a.ok }
  }

  async function offerShown(ids: readonly string[]): Promise<void> {
    const st = readState()
    for (const id of ids) if (knownId(id)) slot(st, id).offered = true
    writeState(st)
  }

  async function refreshInner(): Promise<ActionReport | null> {
    const st0 = readState()
    if (st0.appVersion === config.version) return null
    const source = await loadSource()
    if (!source) return null
    const who: Actor = { kind: 'app-update', version: config.version }
    const all = await entries()
    const st = readState()
    const rows: ActionRow[] = []
    const wrote = new Map<string, ActionRow>()
    const results = new Map<string, LastResult>()
    for (const e of all) {
      if (slotOf(st, e.def.id)?.choice !== 'connected' || e.def.via) continue
      // Consent is read again from the file just before anything is written, and once more as the write commits.
      const wanted = (): boolean => config.store.readAgent(e.def.id)?.choice === 'connected'
      if (!wanted()) continue
      const r = await put(e, source, { replace: false, wrote, stillWanted: wanted }, true)
      if (!r) continue
      results.set(e.def.id, last(r))
      note(st, who, 'refresh', r)
      rows.push(r)
    }
    // Refresh writes the result file and nothing else of an agent's: it has no way to touch consent.
    for (const [id, lastResult] of results) { try { config.store.writeResult(id, lastResult) } catch { /* not saved */ } }
    if (rows.length) { try { await refreshShim(shimOpts()) } catch { /* the shim is retried next update */ } }
    // A copy that could not be written is tried again at the next launch, so the update still reaches it.
    if (!rows.some((r) => r.result === 'failed')) st.appVersion = config.version
    writeState(st)
    return report('refresh', rows, [...wrote.keys()].map(tilde), null, new Set<ActionResult>(['updated', 'unchanged', 'kept']))
  }

  async function refresh(): Promise<ActionReport | null> {
    try { return await refreshInner() } catch { return null }
  }

  return { status, install, remove, decline, offer, answerOffer, offerShown, refresh }
}
