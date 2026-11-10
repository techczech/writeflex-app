// Shapes shared by main, the renderer and the command line for the built-in agent skill.
// Pure; erasable TypeScript only; no app specifics.

/** What the person sees for one agent. */
export type RowState =
  | 'not-installed'      // found, no copy of ours
  | 'installed'          // our copy, current (or newer than this app: see `newer`)
  | 'separate'           // a copy installed another way; carries metadata.app and a version
  | 'kept'               // a folder or link that is someone else's: left alone
  | 'changed'            // our copy, edited since it was installed: kept
  | 'shared'             // reads another agent's copy
  | 'via'                // runs through other agents (nothing written for it)
  | 'failed'             // the folder could not be written
  | 'not-found'          // the agent is not on this computer

export interface AgentRow {
  id: string
  name: string
  found: boolean
  state: RowState
  /** Installed (or separately installed) version, when there is one. */
  version: string | null
  /** The installed copy is newer than the one this app carries. */
  newer: boolean
  /** The folder the copy lives in, with the home folder shown as ~; null when the agent has none. */
  folder: string | null
  /** Plain words for kept, changed, shared, failed and via rows. */
  reason: string | null
  /** The person said Not now to the offer for this agent. */
  declined: boolean
  canInstall: boolean
  canRemove: boolean
  canReplace: boolean
  /** Agents this one runs through or shares a copy with (names). */
  through: string[]
  lastResult: LastResult | null
}

export interface LastResult { ok: boolean; at: number; message: string }

export interface CliRow {
  command: string
  state: 'installed' | 'not-installed' | 'kept' | 'blocked' | 'unsupported' | 'failed'
  path: string | null
  onPath: boolean
  message: string
}

export interface StatusReport {
  version: string
  /** Where the packaged skill is (for "copy this location"); null when the app carries none. */
  skillLocation: string | null
  skillAvailable: boolean
  agents: AgentRow[]
  cli: CliRow
  /** No agent found on this computer. */
  noneFound: boolean
}

export type ActionResult = 'installed' | 'updated' | 'unchanged' | 'removed' | 'kept' | 'failed' | 'not-found' | 'not-installed' | 'declined' | 'unsupported'

export interface ActionRow { id: string; name: string; result: ActionResult; message: string; version: string | null }

export interface ActionReport {
  ok: boolean
  action: 'install' | 'remove' | 'refresh' | 'decline'
  rows: ActionRow[]
  /** The folders written (real folders, home shown as ~): a folder two agents share is written once. */
  written: string[]
  cli: CliRow | null
  status: StatusReport
}

export interface Offer {
  kind: 'none' | 'first-run' | 'later'
  agents: AgentRow[]
  /** T3 Code (or another agent that runs through others) is on this computer. */
  via: Array<{ name: string; through: string[] }>
}

export type Actor = { kind: 'you' } | { kind: 'agent'; name: string } | { kind: 'app-update'; version: string }

export interface ChangeNote { at: number; who: Actor; action: ActionReport['action']; agent: string; result: ActionResult; version: string | null }

/** What the app keeps in its own settings store. */
export interface AgentSkillState {
  format: 1
  /** App version at the last refresh; a different running version triggers one. */
  appVersion: string | null
  /** The onboarding step is done (answered, or skipped because nothing was found), or this was not a first run. */
  onboarded: boolean
  agents: Record<string, { choice: 'connected' | 'declined' | 'removed' | null; offered: boolean; lastResult: LastResult | null }>
  changes: ChangeNote[]
}

export const EMPTY_STATE: AgentSkillState = { format: 1, appVersion: null, onboarded: false, agents: {}, changes: [] }
