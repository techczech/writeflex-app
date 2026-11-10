// WriteFlex's side of the built-in agent skill (design element 19): the few facts the portable module
// (src/main/agent-skill/, src/shared/agent-skill/) is given: app id, display name, the sentence that says what
// the skill lets the person ask for, the command, where the packaged skill is and where its state is kept.
// The state sits in its own folder, <user data>/agent-skill/ (one file per agent, app.json, history.jsonl; not a
// setting, and not in settings.json, so changes to different agents never share a file).
// No Electron import: the app's main process, the `writeflex agent` command (Node mode) and the tests all import it as it is.
import { basename, dirname, join } from 'node:path'
import { runAgentCli, type AgentCliIO } from './agent-skill/cli.ts'
import { createAgentSkills, type AgentSkills } from './agent-skill/service.ts'
import { createFileStateStore, type StateStore } from './agent-skill/state-files.ts'
import type { ActionReport } from '../shared/agent-skill/types.ts'
import { AGENT_TABLE, agentById } from '../shared/agent-skill/agents.ts'
import { AGENT_SKILL_IDENTITY, BETA_BUNDLE_ID, STABLE_BUNDLE_ID } from '../shared/agent-skill-identity.ts'

export { AGENT_SKILL_IDENTITY }

export interface AgentSkillHostParams {
  userDataDir: string
  version: string
  /** The packaged skill's folder, or null when this run carries none (a development run before the build). */
  skillDir: string | null
  /** The running app's bundle identifier (the beta build's differs), so the command it installs finds this app. */
  bundleId: string
}

/** Ids from the renderer: only strings that are in the agents table pass; anything else is dropped before main acts on it. */
export function agentIdsArg(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) if (typeof v === 'string' && AGENT_TABLE.some((d) => d.id === v) && !out.includes(v)) out.push(v)
  return out
}

/** The one dialog these two actions need; main passes Electron's dialog.showMessageBox (no Electron import here). */
export type ConfirmDialog = (options: { type: 'warning'; message: string; buttons: string[]; defaultId: number; cancelId: number; noLink: true }) => Promise<{ response: number }>

/**
 * Remove and Replace are destructive, and WriteFlex's Settings is a panel in the editor window, so main cannot tell the
 * Settings page from the editor's code by sender. Main asks the person itself, in a native dialog the page cannot click.
 * One agent per call, validated against the agents table before anything is shown; the name comes from the table.
 * Cancel (the default), a refused list or an unknown id returns a no-change report and never reaches the service.
 */
export async function confirmedAgentAction(
  kind: 'remove' | 'replace',
  ids: unknown,
  deps: { dialog: ConfirmDialog; run: (id: string) => Promise<ActionReport>; unchanged: () => Promise<ActionReport> }
): Promise<ActionReport> {
  const valid = agentIdsArg(ids)
  if (!Array.isArray(ids) || ids.length !== 1 || valid.length !== 1) return deps.unchanged()
  const name = agentById(valid[0])?.name ?? valid[0]
  const verb = kind === 'replace' ? 'Replace' : 'Remove'
  const message = kind === 'replace'
    ? `Replace your copy of the WriteFlex skill for ${name}? Any changes you made to it will be lost.`
    : `Remove the WriteFlex skill from ${name}?`
  const { response } = await deps.dialog({ type: 'warning', message, buttons: [verb, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true })
  return response === 0 ? deps.run(valid[0]) : deps.unchanged()
}

/** `writeflex agent …`: the first word of the command line, or null. */
export function agentArguments(args: readonly string[]): string[] | null {
  return args[0] === 'agent' ? args.slice(1) : null
}

/** The feature's own folder under user data: agents/<id>.json, app.json, history.jsonl (state-files.ts). */
export function agentSkillStateStore(userDataDir: string): StateStore {
  return createFileStateStore(join(userDataDir, 'agent-skill'), AGENT_TABLE.map((d) => d.id))
}

export function createWriteFlexAgentSkills(p: AgentSkillHostParams, store: StateStore = agentSkillStateStore(p.userDataDir)): AgentSkills {
  return createAgentSkills({
    appId: AGENT_SKILL_IDENTITY.appId, appName: AGENT_SKILL_IDENTITY.appName, skillName: AGENT_SKILL_IDENTITY.skillName,
    cli: { ...AGENT_SKILL_IDENTITY.cli, bundleId: p.bundleId }, version: p.version, skillDir: p.skillDir, store
  })
}

/**
 * First launch of a build that has the feature: a person who already used WriteFlex (a settings file was there) is
 * not shown the dialog over the start screen (they get the one later offer, in the status bar); a new person gets the
 * dialog. Decided once, before anything creates the settings file, and never again.
 */
export function decideOnboarding(store: StateStore, hadConfiguration: boolean): void {
  try {
    if (store.readApp()) return
    store.writeApp({ onboarded: hadConfiguration })
  } catch { /* never a startup failure */ }
}

/**
 * Where a run of the `writeflex` command (Node mode, no Electron) finds the packaged skill and the app's user data:
 * `appRoot` is the folder holding package.json (`app.asar` in a packaged app, the repository when run from source).
 * User data is the standard macOS place for the running variant (the same one the command line's undo records use).
 */
export function commandLineAgentParams(o: { appRoot: string; home: string; packageJson: unknown }): AgentSkillHostParams {
  const meta = (typeof o.packageJson === 'object' && o.packageJson !== null ? o.packageJson : {}) as Record<string, unknown>
  const beta = meta.writeflexVariant === 'beta'
  const packaged = basename(o.appRoot) === 'app.asar'
  return {
    userDataDir: join(o.home, 'Library', 'Application Support', beta ? 'writeflex-desktop-beta' : 'writeflex-desktop'),
    version: typeof meta.version === 'string' ? meta.version : '0.0.0',
    skillDir: packaged ? join(dirname(o.appRoot), 'agent-skill', AGENT_SKILL_IDENTITY.skillName) : join(o.appRoot, 'agent-skill-dist', AGENT_SKILL_IDENTITY.skillName),
    bundleId: beta ? BETA_BUNDLE_ID : STABLE_BUNDLE_ID
  }
}

export function runWriteFlexAgent(args: string[], p: AgentSkillHostParams, io: AgentCliIO, store?: StateStore): Promise<number> {
  return runAgentCli(args, createWriteFlexAgentSkills(p, store), io, process.env.WRITEFLEX_SOURCE || process.env.BRIDLE_AGENT || 'an agent', 'writeflex-agent/1')
}
