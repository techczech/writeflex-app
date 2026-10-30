import { isToolDiscovery } from '../../../shared/assistant-turns'
import type { ChatMessage, Suggestion, TraceEvent, TurnExecution } from '../../../preload'

/**
 * Pure transcript model for the agent panel (Task 15) — the reducer half of useAgent, kept
 * renderer-free so `tests/main/agent-chat.test.ts` can drive it headlessly (the tab-state.ts
 * precedent). The hook feeds it four sources: the initial `agent:state` pull (hydrate), the
 * composer (prompt / complete / error / aborted), `agent:trace` pushes (activity rows), and
 * `agent:suggestions` pushes (the live pending list that enriches staged rows).
 */

/** What an activity row depicts — picks its icon and phrasing in the panel. */
export type ActivityKind = 'read' | 'list' | 'create' | 'rename' | 'staged' | 'denied' | 'undo' | 'info'

export type ActivityRow = {
  id: string
  kind: ActivityKind
  /** Leading phrase ("Created", "Read", "Staged 1 typo edit", …). */
  text: string
  /** Emphasised object of the phrase (a workspace-relative path, or "a.md → b.md" for renames). */
  target?: string
  /** Muted second line (mockup `.atext small`): "Snapshot kept", "Waiting for your review". */
  sub?: string
  /** Staged-suggestion rows carry their Suggestion id; the suggestions push enriches them. */
  suggestionId?: string
  /** True while the staged suggestion is still in the pending list ("Waiting for your review"). */
  pending?: boolean
  /** The staged edit's file (from the suggestion input) — the `view` link's target. */
  path?: string
  /** The staged capability; `plan.propose` rows render as the running-order proposal card. */
  capability?: string
  at: number
}

export type UserTurn = { kind: 'user'; id: string; text: string; at: number }

export type AgentTurn = {
  kind: 'agent'
  id: string
  /** Reply prose; null while the turn is running (activity rows stream in beneath the meta). */
  text: string | null
  error?: boolean
  activity: ActivityRow[]
  at: number
  running: boolean
  /** The turn executed housekeeping there is something to take back from — renders Undo turn. */
  undoable: boolean
  /** Receipt for this completed response; absent while running and on legacy turns. */
  execution?: TurnExecution
}

export type ChatTurn = UserTurn | AgentTurn

export type AgentChatState = {
  available: boolean
  /** Session history that predates this window's conversation — the "Earlier today" collapse. */
  history: ChatTurn[]
  /** This window's live conversation, in order. */
  turns: ChatTurn[]
  suggestions: Suggestion[]
  running: boolean
  /**
   * A USER save landed after the last agent turn began (T16 must-fix). bridle's restoreLastTurn
   * rewinds every file FIRST-snapshotted after the turn's restore point, and `user.checkpoint`
   * snapshots share that journal — so once the user has checkpointed, ⌘⇧Z would rewind THEIR work with the
   * agent's. The flag disarms `undoable` (settled turns immediately; a running turn at settle) and
   * blocks the accept-path re-arm until the next turn opens a fresh restore point.
   */
  userSavedSinceTurn: boolean
  /** Monotonic id source so turns/rows get stable React keys without impure randomness. */
  seq: number
}

export type AgentChatEvent =
  | { type: 'hydrate'; available: boolean; messages: ChatMessage[]; suggestions: Suggestion[] }
  | { type: 'replace'; available: boolean; messages: ChatMessage[]; suggestions: Suggestion[] }
  | { type: 'prompt'; text: string; at: number }
  | { type: 'prompt-silent'; at: number }
  | { type: 'trace'; event: TraceEvent }
  | { type: 'suggestions'; suggestions: Suggestion[] }
  | { type: 'complete'; messages: ChatMessage[]; suggestions: Suggestion[]; at: number }
  | { type: 'error'; message: string; at: number }
  | { type: 'aborted'; at: number }
  | { type: 'undone'; paths: string[]; at: number }
  /** A user save landed (⌘S / save-on-close) — disarm Undo turn (see userSavedSinceTurn). */
  | { type: 'user-saved' }
  /** The user accepted a staged suggestion — the apply snapshotted the pre-edit file into the last
   *  turn's restore window, so Undo turn truthfully takes it back (unless a user save disarmed it). */
  | { type: 'suggestion-applied' }
  /** A running-order proposal was accepted as its own undoable step (ticket 09): the turn's restore
   *  point no longer describes the latest change, so Undo turn disarms and ⌘⇧Z reaches the card. */
  | { type: 'plan-accepted' }

export function emptyAgentChat(): AgentChatState {
  return { available: false, history: [], turns: [], suggestions: [], running: false, userSavedSinceTurn: false, seq: 0 }
}

/** Whether a 'suggestion-applied' event will arm Undo turn: there is a settled agent turn to hang
 *  it on, no newer turn is running (the restore point has not moved), and no user save disarmed it.
 *  Exported so the accept path can pick its status copy honestly (promise ⌘⇧Z only when true). */
export function applyArmsUndo(state: AgentChatState): boolean {
  if (state.running || state.userSavedSinceTurn) return false
  const last = state.turns[state.turns.length - 1]
  return last?.kind === 'agent' && !last.running
}

/** "Staged 1 typo edit" / "Staged 1 clarity edit" for prose.edit; capability name otherwise. */
export function stagedLabel(suggestion: Suggestion): string {
  if (suggestion.capabilityName === 'plan.propose') return 'Proposed a running order'
  if (suggestion.capabilityName === 'scraps.promote') return 'Proposed an idea from an offcut'
  if (suggestion.capabilityName === 'sources.attach') return 'Proposed a source for a piece'
  if (suggestion.capabilityName === 'prose.edit') {
    const category = (suggestion.input as { category?: string } | null)?.category
    if (typeof category === 'string' && category) return `Staged 1 ${category} edit`
  }
  return `Staged ${suggestion.capabilityName}`
}

function suggestionPath(suggestion: Suggestion): string | undefined {
  const path = (suggestion.input as { path?: unknown } | null)?.path
  return typeof path === 'string' ? path : undefined
}

/**
 * Map one trace event to an activity row, or null for events the transcript does not show
 * (`pi.*` session plumbing; `stage` policy decisions, whose `suggestion.staged` follow-up carries
 * the richer row). `metadata.path` is optional context: the e2e double supplies it; a live model
 * turn's executor traces currently do not, so every phrasing degrades to the capability alone.
 */
function activityFromTrace(event: TraceEvent, id: string): ActivityRow | null {
  if (isToolDiscovery(event.metadata?.capability)) return null
  const at = event.timestamp
  if (event.type === 'suggestion.staged') {
    const suggestionId = typeof event.metadata?.suggestionId === 'string' ? event.metadata.suggestionId : undefined
    const capability = typeof event.metadata?.capability === 'string' ? event.metadata.capability : undefined
    return {
      id, kind: 'staged', text: 'Staged 1 edit', sub: 'Waiting for your review', pending: true, at,
      ...(suggestionId ? { suggestionId } : {}), ...(capability ? { capability } : {}),
    }
  }
  if (event.type !== 'policy.decision') return null
  const capability = typeof event.metadata?.capability === 'string' ? event.metadata.capability : ''
  const decision = typeof event.metadata?.decision === 'string' ? event.metadata.decision : ''
  const path = typeof event.metadata?.path === 'string' ? event.metadata.path : undefined
  if (decision === 'stage') return null
  if (decision === 'deny') return { id, kind: 'denied', text: `${capability} was denied by policy`, at }
  if (decision === 'ask') return { id, kind: 'info', text: `Waiting for approval — ${capability}`, at }
  if (decision !== 'allow') return { id, kind: 'info', text: event.title, at }
  switch (capability) {
    case 'files.read':
      return { id, kind: 'read', text: 'Read', target: path ?? 'a file', at }
    case 'files.list':
      return { id, kind: 'list', text: 'Listed the Workspace files', at }
    case 'housekeeping.create_file':
      return { id, kind: 'create', text: 'Created', target: path ?? 'a file', sub: 'Snapshot kept', at }
    case 'notes.create':
      return { id, kind: 'create', text: 'Left a note', target: path ?? 'in agent-notes/', sub: 'Agent-authored', at }
    case 'housekeeping.rename_file':
      return { id, kind: 'rename', text: 'Renamed', target: path ?? 'a file', sub: 'Snapshot kept', at }
    default:
      return { id, kind: 'info', text: event.title, at }
  }
}

/** Session-history messages → compact turns; tool results fold into their turn as info rows. */
function turnsFromMessages(messages: ChatMessage[], seqStart: number): { turns: ChatTurn[]; seq: number } {
  const turns: ChatTurn[] = []
  let seq = seqStart
  for (const message of messages) {
    if (message.role === 'user') {
      turns.push({ kind: 'user', id: `t${seq++}`, text: message.content, at: message.createdAt })
    } else if (message.role === 'assistant') {
      turns.push({
        kind: 'agent', id: `t${seq++}`, text: message.content,
        error: message.error === true || undefined, activity: [], at: message.createdAt,
        running: false, undoable: false,
        ...(message.execution ? { execution: message.execution } : {}),
      })
    } else {
      // A tool result: attach a one-line receipt to the surrounding agent turn (skip if none yet).
      const last = turns[turns.length - 1]
      if (last?.kind !== 'agent') continue
      const line = message.content.split('\n', 1)[0].slice(0, 90)
      if (line) last.activity.push({ id: `t${seq++}`, kind: 'info', text: line, at: message.createdAt })
    }
  }
  return { turns, seq }
}

function lastAssistant(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'assistant' && message.content) return message
  }
  return null
}

function runningTurnIndex(turns: ChatTurn[]): number {
  const last = turns[turns.length - 1]
  return last?.kind === 'agent' && last.running ? turns.length - 1 : -1
}

/** The trace target: the last agent turn, running OR settled — Electron delivers an invoke's reply
 *  on a faster internal lane than `webContents.send`, so a turn's trace pushes routinely arrive
 *  AFTER its completion; the rows still belong to that turn. */
function lastAgentTurnIndex(turns: ChatTurn[]): number {
  const last = turns[turns.length - 1]
  return last?.kind === 'agent' ? turns.length - 1 : -1
}

/** A turn is undoable when it landed a housekeeping write there is a live restore point for. */
function turnUndoable(turn: AgentTurn): boolean {
  return turn.activity.some((row) => row.kind === 'create' || row.kind === 'rename')
}

/** Close the running turn (if any) with the given patch; no-op state when nothing is running. */
function settleRunning(state: AgentChatState, patch: Partial<AgentTurn>): AgentChatState {
  const index = runningTurnIndex(state.turns)
  if (index === -1) return state
  const turns = state.turns.slice()
  turns[index] = { ...(turns[index] as AgentTurn), ...patch, running: false }
  return { ...state, turns, running: false }
}

/**
 * Refresh staged rows against the live pending list: enrich found ones; when the list is
 * `authoritative` (a push or a completion — the store's full truth), also mark gone ones Reviewed.
 * Row-creation reconciles non-authoritatively: the row may simply predate its own push.
 */
function reconcileStagedRows(turns: ChatTurn[], suggestions: Suggestion[], authoritative: boolean): ChatTurn[] {
  return turns.map((turn) => {
    if (turn.kind !== 'agent' || !turn.activity.some((row) => row.suggestionId)) return turn
    const activity = turn.activity.map((row) => {
      if (!row.suggestionId) return row
      const suggestion = suggestions.find((s) => s.id === row.suggestionId)
      if (suggestion) {
        const path = suggestionPath(suggestion)
        return {
          ...row, pending: true, text: stagedLabel(suggestion), sub: 'Waiting for your review',
          ...(path ? { path } : {}), capability: suggestion.capabilityName,
        }
      }
      return authoritative && row.pending ? { ...row, pending: false, sub: 'Reviewed' } : row
    })
    return { ...turn, activity }
  })
}

export function reduceAgentChat(state: AgentChatState, event: AgentChatEvent): AgentChatState {
  switch (event.type) {
    case 'hydrate': {
      const { turns, seq } = turnsFromMessages(event.messages, state.seq)
      return { ...state, available: event.available, history: turns, suggestions: event.suggestions, seq }
    }
    case 'replace': {
      const { turns: history, seq } = turnsFromMessages(event.messages, state.seq)
      return {
        ...emptyAgentChat(),
        available: event.available,
        history,
        suggestions: event.suggestions,
        seq,
      }
    }
    case 'prompt': {
      if (state.running) return state
      let seq = state.seq
      const user: UserTurn = { kind: 'user', id: `t${seq++}`, text: event.text, at: event.at }
      const reply: AgentTurn = { kind: 'agent', id: `t${seq++}`, text: null, activity: [], at: event.at, running: true, undoable: false }
      // A new turn opens a fresh restore point AFTER any earlier user save, so the disarm resets.
      return { ...state, turns: [...state.turns, user, reply], running: true, userSavedSinceTurn: false, seq }
    }
    case 'prompt-silent': {
      if (state.running) return state
      const reply: AgentTurn = {
        kind: 'agent',
        id: `t${state.seq}`,
        text: null,
        activity: [],
        at: event.at,
        running: true,
        undoable: false,
      }
      return {
        ...state,
        turns: [...state.turns, reply],
        running: true,
        userSavedSinceTurn: false,
        seq: state.seq + 1,
      }
    }
    case 'trace': {
      const index = lastAgentTurnIndex(state.turns)
      if (index === -1) return state
      const row = activityFromTrace(event.event, `t${state.seq}`)
      if (!row) return state
      const turns = state.turns.slice()
      const turn = turns[index] as AgentTurn
      // A housekeeping row landing after the turn settled (the IPC-lane race above) must still arm
      // Undo turn; a running turn's undoable is computed once at completion as before. A user save
      // since the turn keeps it disarmed either way (see userSavedSinceTurn).
      const undoable = turn.running
        ? turn.undoable
        : turn.undoable || ((row.kind === 'create' || row.kind === 'rename') && !state.userSavedSinceTurn)
      turns[index] = { ...turn, activity: [...turn.activity, row], undoable }
      // A staged row can also land after `complete` already delivered the suggestions list, so
      // reconcile immediately (enrich-only) rather than waiting for a push that has been and gone.
      return { ...state, turns: reconcileStagedRows(turns, state.suggestions, false), seq: state.seq + 1 }
    }
    case 'suggestions':
      return { ...state, suggestions: event.suggestions, turns: reconcileStagedRows(state.turns, event.suggestions, true) }
    case 'complete': {
      const index = runningTurnIndex(state.turns)
      if (index === -1) return state
      // A user save mid-turn already shares the turn's restore window, so the settle stays disarmed.
      const undoable = turnUndoable(state.turns[index] as AgentTurn) && !state.userSavedSinceTurn
      const last = lastAssistant(event.messages)
      // A failed model request settles as a designed error row (usability review find: these were invisible).
      const settled = settleRunning(state, {
        text: last?.content ?? 'Done.', error: last?.error === true || undefined, undoable,
        ...(last?.execution ? { execution: last.execution } : {}),
      })
      return { ...settled, suggestions: event.suggestions, turns: reconcileStagedRows(settled.turns, event.suggestions, true) }
    }
    // Abort/error settle in place, but a turn that already landed a housekeeping write must keep its
    // Undo — the file is on disk and the restore point is live, exactly as on `complete`. Computing
    // undoable here (not just on complete) also covers the IPC-lane race symmetrically: a create/
    // rename trace that arrived before the settle arms Undo whether the turn finished or was stopped.
    case 'error': {
      const index = runningTurnIndex(state.turns)
      if (index === -1) return state
      const undoable = turnUndoable(state.turns[index] as AgentTurn) && !state.userSavedSinceTurn
      return settleRunning(state, { text: event.message, error: true, undoable })
    }
    case 'aborted': {
      const index = runningTurnIndex(state.turns)
      if (index === -1) return state
      const undoable = turnUndoable(state.turns[index] as AgentTurn) && !state.userSavedSinceTurn
      return settleRunning(state, { text: 'Stopped.', undoable })
    }
    case 'undone': {
      const names = event.paths.map((p) => p.split('/').at(-1) ?? p)
      const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ' …' : '')
      const text =
        event.paths.length === 0
          ? 'Turn undone — nothing needed restoring'
          : `Turn undone — ${event.paths.length} ${event.paths.length === 1 ? 'file' : 'files'} restored`
      let seq = state.seq
      const note: AgentTurn = {
        kind: 'agent',
        id: `t${seq++}`,
        text: null,
        activity: [{ id: `t${seq++}`, kind: 'undo', text, ...(shown ? { sub: shown } : {}), at: event.at }],
        at: event.at,
        running: false,
        undoable: false
      }
      // The restore point is spent: earlier turns must stop offering Undo.
      const turns = state.turns.map((turn) => (turn.kind === 'agent' && turn.undoable ? { ...turn, undoable: false } : turn))
      return { ...state, turns: [...turns, note], seq }
    }
    // A user save after the agent's turn: ⌘⇧Z's restoreLastTurn would rewind THEIR save along with
    // the agent's writes (user.checkpoint snapshots share the journal), so Undo turn disarms everywhere
    // until the next turn opens a fresh restore point. The agent-side restore semantics stay a
    // bridle-upstream ledger item; this is the renderer-side disarm (T16 must-fix).
    case 'user-saved': {
      const turns = state.turns.map((turn) => (turn.kind === 'agent' && turn.undoable ? { ...turn, undoable: false } : turn))
      return { ...state, turns, userSavedSinceTurn: true }
    }
    // Accepting a staged suggestion writes to disk under a snapshot inside the last turn's restore
    // window — Undo turn truthfully takes it back, so the settled turn (re)arms. Blocked when a
    // user save disarmed the window or a newer turn is already running (the point has moved on).
    case 'plan-accepted': {
      const turns = state.turns.map((turn) => (turn.kind === 'agent' && turn.undoable ? { ...turn, undoable: false } : turn))
      return { ...state, turns }
    }
    case 'suggestion-applied': {
      if (!applyArmsUndo(state)) return state
      const index = state.turns.length - 1
      const turns = state.turns.slice()
      turns[index] = { ...(turns[index] as AgentTurn), undoable: true }
      return { ...state, turns }
    }
  }
}
