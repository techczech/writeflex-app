import type { AmbientState } from './ambient'
// type-only: erased at runtime, keeps this module electron-free for tests
import type { BrowserWindow } from 'electron'
import type { Workspace } from './workspace'
import type { ScriptedTurn, WorkspaceAgent } from './agent'
import type { ThreadManager } from './threads'
import type { ScrapStore } from './scraps'
import type { ChangeStore } from './changes'
import type { VersionStore } from './versions'
import type { WorkspaceWatcher } from './workspace-watcher'
import type { DiaryCaptureTracker } from './diary-capture'
import type { ExplicitSessionRecorder } from './explicit-session'
import type { CloseController } from './window-close'
import type { CloseCheckpointRun } from './close-checkpoints'
import { persistDiarySession } from './diary'
import { randomUUID } from 'node:crypto'
import { recordMainProcessDiagnostic } from './shutdown'
import type { RequestInboxWatch } from './request-inbox-watch'

export type WindowState = {
  collectionPageActive?: boolean
  collectionPageFolio?: boolean
  window: BrowserWindow
  ambient: AmbientState | null
  workspace: Workspace | null
  /** Native recursive watcher bound to this window's current Workspace; disposed on rebind/close. */
  workspaceWatcher: WorkspaceWatcher | null
  /** Answers the command line's requests while this window has the Collection open; disposed on rebind/close. */
  requestInbox: RequestInboxWatch | null
  /** Readers' notes collected into this Collection's ledger (0.24 ticket 07). */
  /** Readers' notes in, and (ticket 08) outcomes and replies back: `look` runs one look now. */
  readerNotes: { dispose(): void; look?(): Promise<void> } | null
  /** Automatic Counted-Collection session accumulator; main-owned so renderer remounts cannot erase it. */
  diaryCapture: DiaryCaptureTracker | null
  diaryIdleTimer: ReturnType<typeof setTimeout> | null
  diaryRoot: string | null
  /** Writer-started Diary session. While active it owns capture and automatic eligibility stands down. */
  explicitSession: ExplicitSessionRecorder | null
  explicitDurationTimer: ReturnType<typeof setTimeout> | null
  explicitCompletionTimer: ReturnType<typeof setTimeout> | null
  agent: WorkspaceAgent | null
  /** The in-flight agent creation: binding a Workspace returns immediately (the editor is usable at
   *  once) while the agent boots in the background. Agent-needing IPC awaits this; `agent` is set —
   *  and `agent:ready` pushed — when it resolves. Null when no Workspace is bound.
   *  Since 0.7b these are VIEWS onto the ThreadManager's active thread — the manager repoints them
   *  on every activation, so the whole pre-threads agent:* IPC surface works unchanged. */
  agentReady: Promise<WorkspaceAgent> | null
  /** The window's thread world (0.7b B1): one skill-bound or chat instance per thread. */
  threads: ThreadManager | null
  /** E2e-only scripted TurnScript queues, one per THREAD (each thread's factory owns one Cache-Law
   *  session, so queues can never be shared across differently-composed threads). Null in production. */
  e2eScriptQueues: Map<string, ScriptedTurn[]> | null
  /** Which thread raised each pending approval (requestId → threadId): responses route to the owner. */
  approvalOwners: Map<string, string>
  /** Bumped on every rebind/close so a stale in-flight agent creation disposes itself on arrival
   *  instead of clobbering the newer bind's agent. */
  bindGeneration: number
  scraps: ScrapStore | null
  /** The window's Change Ledger store (ADR-0010/0011): agent suggestions, the writer's own edits, and
   *  reviewer changes, journaled to `.writeflex/changes.jsonl`. Bound alongside `scraps` on open. */
  changes: ChangeStore | null
  /** Named, authored version records for the version spine, journaled to `.writeflex/versions.jsonl`. */
  versions: VersionStore | null
  pendingFocusFile: string | null
  /** The Guide tab was asked for by a route that ran in main (Get started, a chapter link): the window's renderer takes it once. */
  guideTabWanted: boolean
  /** The 1-based line a queued focus lands on (a `writeflex://open?…&line=N` link); null = the file's top. */
  pendingFocusLine: number | null
  /** The folder focused in this window (ticket 03): workspace-relative, a view state that narrows the
   *  tree and scopes search — never a second root binding. Restored at bind from the root's recents
   *  entry (folder-focus.ts), which is also where every change is persisted. Null = whole archive. */
  folderFocus: string | null
  /** Set once the close has been resolved (the renderer saved/discarded and asked to proceed): the
   *  'close' guard then lets the window through instead of intercepting again. */
  forceClose: boolean
  /** The window's one close in flight (window-close.ts): the request to the renderer, its
   *  acknowledgement, and what happens when none comes. Set by windows.ts when the window is made. */
  closing: CloseController | null
  /** The checkpoints this window owed when it was let go (close-checkpoints.ts). The window's agent is
   *  disposed only after the run is over: its budget stops it starting documents, and the checkpoint in
   *  flight then is finished first. will-quit's 1500 ms bound is the limit on a quit's wait for it. */
  closeWork: CloseCheckpointRun | null
  /** Told when the renderer abandons a guarded close because a save failed (window:cancel-close). Set
   *  only while main itself is waiting on that close (removing the Example collection, ticket 10). */
  onCloseCancelled: (() => void) | null
  /** Unguessable authority embedded in this window's wf-asset URLs. */
  assetToken: string
  /** The root the window's page last said it loaded and shows (`renderer:ready`): null for the start
   *  screen, undefined until it has said. The vault switcher shows a new window only once this is the
   *  root it was bound to (window-switch.ts, `whenReady`). */
  rendererRoot: string | null | undefined
  /** Told on each `renderer:ready`. Set only while main waits for one (the vault switcher). */
  onRendererReady: (() => void) | null
}

const states = new Map<number, WindowState>()
const pendingAgentDisposals = new Set<Promise<void>>()

/** `after`: the window's close checkpoints, which use the agent. It settles when none is in flight and
 *  none will start (close-checkpoints.ts): the agent is never disposed under a checkpoint being written. */
function trackAgentDisposal(agent: WorkspaceAgent, windowId: number, after: Promise<void>): void {
  recordMainProcessDiagnostic('agent.dispose.started', { windowId, pending: pendingAgentDisposals.size + 1 })
  const startedAt = Date.now()
  const pending = after.then(() => agent.dispose()).catch((error) => {
    recordMainProcessDiagnostic('agent.dispose.failed', { windowId, message: error instanceof Error ? error.message : String(error) })
  }).finally(() => {
    pendingAgentDisposals.delete(pending)
    recordMainProcessDiagnostic('agent.dispose.settled', { windowId, elapsedMs: Date.now() - startedAt, pending: pendingAgentDisposals.size })
  })
  pendingAgentDisposals.add(pending)
}

function trackThreadsDisposal(threads: ThreadManager, windowId: number, after: Promise<void>): void {
  recordMainProcessDiagnostic('agent.dispose.started', { windowId, pending: pendingAgentDisposals.size + 1 })
  const startedAt = Date.now()
  const pending = after.then(() => threads.disposeAll()).catch((error) => {
    recordMainProcessDiagnostic('agent.dispose.failed', { windowId, message: error instanceof Error ? error.message : String(error) })
  }).finally(() => {
    pendingAgentDisposals.delete(pending)
    recordMainProcessDiagnostic('agent.dispose.settled', { windowId, elapsedMs: Date.now() - startedAt, pending: pendingAgentDisposals.size })
  })
  pendingAgentDisposals.add(pending)
}

/** A teardown started outside the window-close path (a thread boot resolving after its manager was
 *  disposed) still needs to block will-quit until its recorder flush settles. */
export function trackPendingDisposal(pending: Promise<void>): void {
  const tracked = pending.catch(() => {}).finally(() => { pendingAgentDisposals.delete(tracked) })
  pendingAgentDisposals.add(tracked)
}

/** Electron's closed event cannot await; will-quit uses this to let Bridle finish its async flush.
 *  Loops rather than snapshotting once: a late boot's tracked teardown can join AFTER the wait
 *  began (review finding B1 round 2), and quit must cover it too. Bounded — teardowns never spawn unboundedly. */
export async function waitForAgentDisposals(): Promise<void> {
  for (let round = 0; round < 10 && pendingAgentDisposals.size > 0; round++) {
    await Promise.allSettled([...pendingAgentDisposals])
  }
}

/** App-wide quit intent (set on before-quit): lets window-all-closed resume a ⌘Q that the dirty-close
 *  guard paused for its sheet. Reset when a close is cancelled so a stale intent can't quit later. */
let quitting = false
export function setQuitting(value: boolean): void {
  quitting = value
}
export function isQuitting(): boolean {
  return quitting
}

/** "A window closed or left its root": told after the window's state was removed or rebound, so
 *  `allStates()` already shows the change. The vault IPC stops the watchers of roots no window holds. */
const windowReleaseListeners = new Set<() => void>()
export function onWindowReleased(listener: () => void): () => void {
  windowReleaseListeners.add(listener)
  return () => { windowReleaseListeners.delete(listener) }
}
export function notifyWindowReleased(): void {
  for (const listener of windowReleaseListeners) {
    try {
      listener()
    } catch {
      // A listener's failure never blocks a window's close or rebind.
    }
  }
}

export function registerWindow(window: BrowserWindow): WindowState {
  const state: WindowState = { window, ambient: null, workspace: null, workspaceWatcher: null, requestInbox: null, readerNotes: null, diaryCapture: null, diaryIdleTimer: null, diaryRoot: null, explicitSession: null, explicitDurationTimer: null, explicitCompletionTimer: null, agent: null, agentReady: null, threads: null, e2eScriptQueues: null, approvalOwners: new Map(), bindGeneration: 0, scraps: null, changes: null, versions: null, pendingFocusFile: null, guideTabWanted: false, pendingFocusLine: null, folderFocus: null, forceClose: false, closing: null, closeWork: null, onCloseCancelled: null, assetToken: randomUUID(), rendererRoot: undefined, onRendererReady: null }
  const webContentsId = window.webContents.id
  states.set(webContentsId, state)
  window.on('closed', () => {
    recordMainProcessDiagnostic('window.closed', { windowId: webContentsId, hasAgent: Boolean(state.agent), hasAgentReady: Boolean(state.agentReady) })
    state.bindGeneration += 1 // a still-booting agent disposes itself on arrival (generation mismatch)
    state.workspaceWatcher?.dispose()
    state.workspaceWatcher = null
    // Its executor stops at once; windows.ts keeps the Collection's lock until it has (waitForRequestDisposals).
    void state.requestInbox?.dispose()
    state.readerNotes?.dispose()
    state.readerNotes = null
    state.requestInbox = null
    if (state.diaryIdleTimer) clearTimeout(state.diaryIdleTimer)
    state.diaryIdleTimer = null
    if (state.explicitDurationTimer) clearTimeout(state.explicitDurationTimer)
    state.explicitDurationTimer = null
    if (state.explicitCompletionTimer) clearTimeout(state.explicitCompletionTimer)
    state.explicitCompletionTimer = null
    const diaryRecord = state.explicitSession?.active
      ? state.explicitSession.close('manual')?.record ?? null
      : state.diaryCapture?.close() ?? null
    if (diaryRecord && state.diaryRoot) {
      const diaryWorkspace = [...states.values()].find((candidate) => candidate.workspace?.root === state.diaryRoot)?.workspace ?? undefined
      trackPendingDisposal(persistDiarySession(state.diaryRoot, diaryRecord, {
        ...(state.workspace ? { sourceWorkspace: state.workspace } : {}),
        ...(diaryWorkspace ? { diaryWorkspace } : {}),
      }).then(() => {}))
    }
    // The manager owns every thread instance (incl. the active one state.agent points at); its
    // disposeAll aborts in-flight turns and lets will-quit's waitForAgentDisposals cover the flush.
    // The window's close checkpoints (if any) run on this agent: it is disposed once they settle.
    const closeWork = state.closeWork?.done ?? Promise.resolve()
    if (state.threads) trackThreadsDisposal(state.threads, webContentsId, closeWork)
    else if (state.agent) trackAgentDisposal(state.agent, webContentsId, closeWork)
    states.delete(webContentsId)
    notifyWindowReleased()
  })
  return state
}

export function stateForSender(webContentsId: number): WindowState {
  const state = states.get(webContentsId)
  if (!state) throw new Error('No window state for this renderer.')
  return state
}

export function allStates(): WindowState[] {
  return [...states.values()]
}
