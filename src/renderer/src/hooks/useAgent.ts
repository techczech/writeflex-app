import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { AgentState, ModelChoice, Suggestion, ThinkingLevel } from '../../../preload'
import { applyArmsUndo, emptyAgentChat, reduceAgentChat, type ChatTurn } from './agent-chat'
import { latestUndoableCard, liveCardIds, reducePlanCards, type PlanCards } from './plan-proposal-cards'
import { editsFromEntries, staleMessage } from '../../../shared/plan-proposal'
import type { PlanProposalCardActions } from '../components/PlanProposalCard'

export type UseAgent = {
  /** False until a Workspace agent exists (the shell only mounts the panel with one bound). */
  available: boolean
  /** Session history that predates this window's conversation — the "Earlier today" collapse. */
  history: ChatTurn[]
  /** This window's live conversation — what the transcript renders. */
  messages: ChatTurn[]
  /** The live pending-suggestion list (Task 16 renders these as margin callouts). */
  suggestions: Suggestion[]
  running: boolean
  thread: AgentState['thread']
  /** The folder a folder skill was last launched on in the active thread (ticket 11's scope chip). */
  threadFolder: string | null
  model: AgentState['model']
  models: ModelChoice[]
  catalogue: ModelChoice[]
  thinking: ThinkingLevel
  modelNotice: string | null
  /** When the model list was last checked — the picker's "Last checked" line. */
  modelsChecked: AgentState['modelsChecked']
  /** The workspace default model new chats start on (before any fallback). */
  defaultModel: AgentState['defaults']['model'] | null
  /** "Ask first": the chat waits for the user to choose a model (candidates OpenAI first). */
  modelChoice: AgentState['modelChoice']
  completion: { id: number; outcome: 'completed' | 'error'; reply: string | null; suggestionsStaged: number } | null
  prompt: (text: string) => void
  /** The armed skill card is the one authorised empty turn; typed composer submits stay non-empty. */
  promptAsIs: () => void
  /** A folder skill's launch (ticket 10): the same empty turn, run on `folder` instead of the document. */
  promptAsIsOnFolder: (folder: string) => void
  /** A thread mutation returns its complete state; replace the panel in one commit. */
  replaceState: (state: AgentState) => void
  setModel: (provider: string, modelId: string) => Promise<void>
  setThinking: (level: ThinkingLevel) => Promise<void>
  /** Abort settles at the main-process seam before a conversation reset may replace this state. */
  abort: () => Promise<void>
  undoTurn: () => void
  /** A USER save landed (⌘S / save-on-close): disarm Undo turn — ⌘⇧Z must never rewind the
   *  writer's own save (T16 must-fix; agent writes refresh through onWorkspaceChanged instead). */
  noteUserSave: () => void
  /** An accepted suggestion landed on disk inside the last turn's restore window. Returns whether
   *  Undo turn (re)armed, so the caller's status copy only promises ⌘⇧Z when it is true. */
  noteSuggestionApplied: () => boolean
  /** Running-order proposal cards in this window, by proposal id (ticket 09). */
  planCards: PlanCards
  planActions: PlanProposalCardActions
}

/**
 * The agent panel's window-level state (Task 15): subscribes the `agent:trace` and
 * `agent:suggestions` pushes into the pure transcript reducer (agent-chat.ts) and wraps the
 * prompt/abort/undo channels. One instance lives in App so ⌘⇧Z and the palette ask-row reach the
 * same conversation the panel renders.
 */
export function useAgent(opts: { onWorkspaceChanged?: () => void; onNoteCreated?: (path?: string) => void; activeFile?: string | null; activeCollectionDir?: string } = {}): UseAgent {
  const [state, dispatch] = useReducer(reduceAgentChat, undefined, emptyAgentChat)
  const [planCards, dispatchPlan] = useReducer(reducePlanCards, {})
  const planCardsRef = useRef(planCards)
  planCardsRef.current = planCards
  const turnsRef = useRef(state.turns)
  turnsRef.current = state.turns
  const [thread, setThread] = useState<AgentState['thread']>(null)
  // Read synchronously by promptAsIsOnFolder: App adopts the new thread and fires in the same tick.
  const threadIdRef = useRef<string | null>(null)
  const [threadFolders, setThreadFolders] = useState<Record<string, string>>({})
  const [model, setModelState] = useState<AgentState['model']>(null)
  const [models, setModels] = useState<ModelChoice[]>([])
  const [catalogue, setCatalogue] = useState<ModelChoice[]>([])
  const [thinking, setThinkingState] = useState<ThinkingLevel>('medium')
  const [modelNotice, setModelNotice] = useState<string | null>(null)
  const [modelsChecked, setModelsChecked] = useState<AgentState['modelsChecked']>(null)
  const [defaultModel, setDefaultModel] = useState<AgentState['defaults']['model'] | null>(null)
  const [modelChoice, setModelChoice] = useState<AgentState['modelChoice']>(null)
  const [completion, setCompletion] = useState<UseAgent['completion']>(null)
  const completionIdRef = useRef(0)
  /** A late completion from a replaced thread must never overwrite the newly adopted transcript. */
  const conversationGenerationRef = useRef(0)

  // Live mirrors for the stable callbacks below (the sidebarOpenRef pattern): running gates
  // re-entrancy the instant a key fires; undoable gates ⌘⇧Z so a stray press can never restore
  // a snapshot from an earlier app run (bridle's restoreLastTurn falls back to the store's last
  // restore point, which may predate this window).
  const runningRef = useRef(false)
  runningRef.current = state.running
  const undoableRef = useRef(false)
  undoableRef.current = state.turns.some((turn) => turn.kind === 'agent' && turn.undoable)
  // Whether a suggestion accept will arm Undo turn — read synchronously by noteSuggestionApplied
  // so the accept path can pick honest status copy before the reducer state commits.
  const applyArmsRef = useRef(false)
  applyArmsRef.current = applyArmsUndo(state)
  // Whether the in-flight turn executed housekeeping (disk writes): set from traces, read on
  // completion to refresh the file tree + outline folder scope (the T10 savedTick ledger note).
  const wroteRef = useRef(false)
  const changedRef = useRef(opts.onWorkspaceChanged)
  changedRef.current = opts.onWorkspaceChanged
  const noteCreatedRef = useRef(opts.onNoteCreated)
  noteCreatedRef.current = opts.onNoteCreated
  // The open document at send time — read synchronously in prompt() so an unqualified request defaults
  // to whatever the writer is looking at right now, not whatever it was when prompt() was memoised.
  const activeFileRef = useRef(opts.activeFile)
  activeFileRef.current = opts.activeFile
  const activeCollectionDirRef = useRef(opts.activeCollectionDir ?? '')
  activeCollectionDirRef.current = opts.activeCollectionDir ?? ''
  const suggestionIdsRef = useRef<Set<string>>(new Set())
  suggestionIdsRef.current = new Set(state.suggestions.map((suggestion) => suggestion.id))

  const adoptConfiguration = useCallback((next: AgentState) => {
    threadIdRef.current = next.thread?.id ?? null
    setThread(next.thread)
    setModelState(next.model)
    setModels(next.models)
    setCatalogue(next.catalogue)
    setThinkingState(next.thinking)
    setModelNotice(next.modelNotice)
    setModelsChecked(next.modelsChecked ?? null)
    setDefaultModel(next.defaults?.model ?? null)
    setModelChoice(next.modelChoice ?? null)
  }, [])

  useEffect(() => {
    let cancelled = false
    const hydrate = (): void => {
      void window.writeflex
        .getAgentState()
        .then((s) => {
          if (!cancelled) {
            dispatch({ type: 'hydrate', available: s.available, messages: s.messages, suggestions: s.suggestions })
            adoptConfiguration(s)
          }
        })
        .catch(() => {
          /* no workspace bound yet — the panel renders its designed empty state */
        })
    }
    hydrate()
    // The agent boots in the background after a Workspace binds; the mount-time hydrate can land
    // before it is ready (empty transcript, no models). Re-pull when the boot finishes.
    const offModels = window.writeflex.onModelsChanged((next) => {
      setModels(next.models)
      setCatalogue(next.catalogue)
      setModelNotice(next.modelNotice)
      setModelsChecked(next.modelsChecked ?? null)
    })
    const offReady = window.writeflex.onAgentReady(hydrate)
    const offTrace = window.writeflex.onTrace((event) => {
      const allowed = event.type === 'policy.decision' && event.metadata?.decision === 'allow'
      const capability = String(event.metadata?.capability ?? '')
      if (allowed && capability === 'notes.create') {
        // The same trace that draws the "Left a note" activity row (agent-chat.ts): a note about a
        // piece is a new file too (refresh the tree) and must be seen, so the host opens the pane.
        if (runningRef.current) wroteRef.current = true
        else changedRef.current?.()
        noteCreatedRef.current?.(typeof event.metadata?.path === 'string' ? event.metadata.path : undefined)
      }
      if (allowed && capability.startsWith('housekeeping.')) {
        // Electron delivers an invoke's reply on a faster internal lane than webContents.send, so
        // a turn's trace pushes routinely arrive AFTER prompt() has resolved. Both orderings must
        // refresh the workspace: mid-turn traces arm the flag completion checks; a late trace
        // (turn already settled — the write is on disk) refreshes immediately.
        if (runningRef.current) wroteRef.current = true
        else changedRef.current?.()
      }
      dispatch({ type: 'trace', event })
    })
    const offSuggestions = window.writeflex.onSuggestions((suggestions) => dispatch({ type: 'suggestions', suggestions }))
    return () => {
      cancelled = true
      offModels()
      offReady()
      offTrace()
      offSuggestions()
    }
  }, [adoptConfiguration])

  const send = useCallback((text: string, silent: boolean, runOnFolder?: string) => {
    const submitted = text.trim()
    if ((!silent && !submitted) || runningRef.current) return
    runningRef.current = true
    wroteRef.current = false
    const priorSuggestionIds = new Set(suggestionIdsRef.current)
    const conversationGeneration = conversationGenerationRef.current
    dispatch(silent ? { type: 'prompt-silent', at: Date.now() } : { type: 'prompt', text: submitted, at: Date.now() })
    window.writeflex
      .prompt(silent ? '' : submitted, activeFileRef.current, activeCollectionDirRef.current, silent ? runOnFolder : undefined)
      .then(({ messages, suggestions }) => {
        if (conversationGeneration !== conversationGenerationRef.current) return
        // Settle the ref NOW, not on the next render: a trace push arriving in the next task must
        // see the turn as over so its refresh path (above) fires immediately.
        runningRef.current = false
        dispatch({ type: 'complete', messages, suggestions, at: Date.now() })
        const reply = [...messages].reverse().find((message) => message.role === 'assistant') ?? null
        setCompletion({
          id: ++completionIdRef.current,
          outcome: reply?.error ? 'error' : 'completed',
          reply: reply?.content ?? null,
          suggestionsStaged: suggestions.filter((suggestion) => !priorSuggestionIds.has(suggestion.id)).length,
        })
        // The turn wrote to disk: refresh the tree + bump savedTick even if the user aborted the
        // UI-side turn meanwhile — the files moved either way.
        if (wroteRef.current) changedRef.current?.()
      })
      .catch((error: unknown) => {
        if (conversationGeneration !== conversationGenerationRef.current) return
        runningRef.current = false
        const message = error instanceof Error ? error.message : String(error)
        dispatch({ type: 'error', message, at: Date.now() })
        setCompletion({ id: ++completionIdRef.current, outcome: 'error', reply: message, suggestionsStaged: 0 })
      })
  }, [])

  const prompt = useCallback((text: string) => send(text, false), [send])
  const promptAsIs = useCallback(() => send('', true), [send])
  const promptAsIsOnFolder = useCallback((folder: string) => {
    const threadId = threadIdRef.current
    if (threadId && !runningRef.current) setThreadFolders((folders) => ({ ...folders, [threadId]: folder }))
    send('', true, folder)
  }, [send])

  const replaceState = useCallback((next: AgentState) => {
    conversationGenerationRef.current += 1
    runningRef.current = false
    wroteRef.current = false
    dispatch({ type: 'replace', available: next.available, messages: next.messages, suggestions: next.suggestions })
    adoptConfiguration(next)
    setCompletion(null)
  }, [adoptConfiguration])

  const setModel = useCallback(async (provider: string, modelId: string): Promise<void> => {
    const requested = `${provider}/${modelId}`
    try {
      const next = await window.writeflex.setModel(provider, modelId)
      adoptConfiguration(next)
      if (next.model?.provider !== provider || next.model.id !== modelId) {
        const actual = next.model ? `${next.model.provider}/${next.model.id}` : 'no model'
        throw new Error(`The model broker returned ${actual}.`)
      }
    } catch (error) {
      const refreshed = await window.writeflex.getAgentState().catch(() => null)
      if (refreshed) adoptConfiguration(refreshed)
      const inForce = refreshed?.model
      const actual = inForce ? `${inForce.provider}/${inForce.id}` : 'no model'
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Requested ${requested}; ${actual} is in force. Reason: ${reason}`)
    }
  }, [adoptConfiguration])

  const setThinking = useCallback(async (level: ThinkingLevel): Promise<void> => {
    adoptConfiguration(await window.writeflex.setThinking(level))
  }, [adoptConfiguration])

  const abort = useCallback(async (): Promise<void> => {
    if (!runningRef.current) return
    runningRef.current = false
    try {
      await window.writeflex.abortAgent()
    } finally {
      dispatch({ type: 'aborted', at: Date.now() })
    }
  }, [])

  const loadPlanCard = useCallback((id: string) => {
    void window.writeflex.planProposal
      .view(id)
      .then((view) => dispatchPlan({ id, event: { type: 'loaded', view } }))
      .catch(() => dispatchPlan({ id, event: { type: 'loaded', view: null } }))
  }, [])

  const undoPlan = useCallback((id: string) => {
    dispatchPlan({ id, event: { type: 'busy' } })
    void window.writeflex.planProposal
      .undo(id)
      .then((result) => {
        dispatchPlan({ id, event: { type: 'undo-result', ok: result.ok, ...(result.ok ? {} : { message: result.message }) } })
        if (result.ok) changedRef.current?.()
      })
      .catch((error: unknown) => dispatchPlan({ id, event: { type: 'undo-result', ok: false, message: error instanceof Error ? error.message : String(error) } }))
  }, [])

  const planActions = useMemo<PlanProposalCardActions>(() => ({
    onLoad: loadPlanCard,
    onAccept: (id) => {
      const card = planCardsRef.current[id]
      if (!card || card.busy) return
      const edits = card.phase === 'editing' ? editsFromEntries(card.entries) : undefined
      dispatchPlan({ id, event: { type: 'busy' } })
      void window.writeflex.planProposal
        .accept(id, edits)
        .then((result) => {
          dispatchPlan({ id, event: { type: 'accept-result', result, at: Date.now() } })
          if (result.ok) {
            dispatch({ type: 'plan-accepted' })
            changedRef.current?.()
          }
        })
        .catch((error: unknown) => dispatchPlan({ id, event: { type: 'accept-result', result: { ok: false, message: error instanceof Error ? error.message : String(error) }, at: Date.now() } }))
    },
    onEdit: (id) => dispatchPlan({ id, event: { type: 'edit' } }),
    onCancelEdit: (id) => dispatchPlan({ id, event: { type: 'cancel-edit' } }),
    onDrop: (id, changeIds) => dispatchPlan({ id, event: { type: 'drop', ids: changeIds } }),
    onRestore: (id, changeIds) => dispatchPlan({ id, event: { type: 'restore', ids: changeIds } }),
    onDrag: (id, title, to) => dispatchPlan({ id, event: { type: 'drag', title, to } }),
    onDiscard: (id) => {
      dispatchPlan({ id, event: { type: 'busy' } })
      void window.writeflex.planProposal
        .discard(id)
        .then(() => dispatchPlan({ id, event: { type: 'discarded' } }))
        .catch(() => loadPlanCard(id))
    },
    onUndo: undoPlan,
    onProposeAgain: (id) => {
      const card = planCardsRef.current[id]
      const changed = staleMessage(card?.view?.stale ?? []).replace(/\.$/, '')
      const dir = card?.view?.dir
      void window.writeflex.planProposal
        .discard(id)
        .catch(() => null)
        .then(() => {
          dispatchPlan({ id, event: { type: 'discarded' } })
          send(`${changed || 'The folder changed after your running-order proposal'}. Read the plan of ${dir ? `"${dir}"` : 'the report'} again with plan.read and propose a new order.`, false)
        })
    },
  }), [loadPlanCard, send, undoPlan])

  // A folder change can make a pending proposal stale (frame 6): re-check every live card.
  useEffect(() => {
    const recheck = () => { for (const id of liveCardIds(planCardsRef.current)) loadPlanCard(id) }
    const offCollection = window.writeflex.onCollectionChanged(recheck)
    const offSuggestions = window.writeflex.onSuggestions(recheck)
    return () => {
      offCollection()
      offSuggestions()
    }
  }, [loadPlanCard])

  const undoTurn = useCallback(() => {
    if (runningRef.current) return
    // ⌘⇧Z reaches an accepted running order when it is the latest agent change (frame 4).
    const plan = latestUndoableCard(planCardsRef.current)
    const lastTurn = [...turnsRef.current].reverse().find((turn) => turn.kind === 'agent')
    if (plan && (plan.acceptedAt ?? 0) >= (lastTurn?.at ?? 0)) {
      undoPlan(plan.id)
      return
    }
    if (!undoableRef.current) return
    void window.writeflex
      .restoreLastTurn()
      .then((paths) => {
        dispatch({ type: 'undone', paths, at: Date.now() })
        changedRef.current?.()
      })
      .catch(() => {})
  }, [])

  const noteUserSave = useCallback(() => dispatch({ type: 'user-saved' }), [])

  const noteSuggestionApplied = useCallback(() => {
    const arms = applyArmsRef.current
    dispatch({ type: 'suggestion-applied' })
    return arms
  }, [])

  return {
    available: state.available,
    history: state.history,
    messages: state.turns,
    suggestions: state.suggestions,
    running: state.running,
    thread,
    threadFolder: thread ? threadFolders[thread.id] ?? null : null,
    model,
    models,
    catalogue,
    thinking,
    modelNotice,
    modelsChecked,
    defaultModel,
    modelChoice,
    completion,
    prompt,
    promptAsIs,
    promptAsIsOnFolder,
    replaceState,
    setModel,
    setThinking,
    abort,
    undoTurn,
    noteUserSave,
    noteSuggestionApplied,
    planCards,
    planActions,
  }
}
