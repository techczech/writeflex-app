import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Markdown } from '@bridle/react'
import { useIpcAuthFlow } from '@bridle/electron/renderer'
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  FilePlus2,
  FileSearch,
  FolderSync,
  Info,
  ListTree,
  Loader2,
  LogOut,
  MessageSquare,
  PanelRight,
  PenLine,
  Plus,
  ShieldX,
  Sparkles,
  Square,
  StickyNote,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import type { UseAgent } from '../hooks/useAgent'
import type { ActivityRow, AgentTurn, ChatTurn } from '../hooks/agent-chat'
import type { AgentState, Scrap, SkillMeta, SourceFile, ThreadMeta, ThreadRunComplete } from '../../../preload'
import { ScratchpadPane } from './ScratchpadPane'
import { PlanProposalCard, type PlanProposalCardActions } from './PlanProposalCard'
import { emptyPlanCard, type PlanCards } from '../hooks/plan-proposal-cards'
import { Digest } from './Digest'
import { AgentModelOptions, providerDisplayName, unavailableModelLine } from './AgentModelOptions'
import { ModelRefreshControl } from './ModelRefreshControl'
import {
  ArmedSkillCard,
  SkillHandoffRow,
  SkillRunningLine,
  SkillThreadBanner,
  ThreadSwitcherPopover,
  skillDisplayName,
  skillIcon,
  type SkillToast,
} from './AgentSkillSurfaces'

export { unavailableModelTitle } from './AgentModelOptions'

/** A composer focus/prefill request from App (⌘J, the toolbar Sparkles, the palette ask-row).
 *  A tick bump focuses the input post-commit — the panel may be un-hiding in the same render, and
 *  a display:none input cannot take focus until the commit lands. */
export type ComposerRequest = { tick: number; text?: string }
export type AgentConfigurationRequest = { tick: number; focus: 'model' | 'thinking' }
export type AgentActionRequest = { tick: number; action: 'new-conversation' | 'show-conversations' | 'close-current-conversation' }

/** The Scratchpad tab's data + actions (Task 20). `request.tick` lands the tab (⇧⌘J) and focuses filter. */
export type ScratchpadPanelData = {
  items: Scrap[]
  request: { tick: number; focus: boolean }
  onToggleDone: (id: string) => void
  onSetColour: (id: string, colour: string | null) => void
  onRemove: (id: string) => void
  onInsert: (scrap: Scrap) => void
  onNewScrap: () => void
  /** Sources (Task 21): reference material under research/, listed below the cuttings. */
  sources: SourceFile[]
  onOpenSource: (path: string) => void
  onRevealSource: (path: string) => void
}

type AgentPanelProps = {
  agent: UseAgent
  /** The head's PanelRight button — App hides the pane and returns the keyboard to the editor. */
  onClose: () => void
  focusRequest: ComposerRequest
  /** Palette commands open the same composer-chrome control and focus the requested field. */
  configurationRequest?: AgentConfigurationRequest
  actionRequest?: AgentActionRequest
  /** The staged row's `view` link (Task 16): opens the staged file and scrolls its suggestion's
   *  anchored sentence into view (the margin callout sits beside the first anchored one). */
  onViewSuggestion: (path: string, suggestionId?: string) => void
  /** Esc in an idle composer: hand the keyboard back to the editor (keyboard-first exit). */
  onExit: () => void
  /** The Scratchpad tab (Task 20): its cuttings and tile actions. */
  scratchpad: ScratchpadPanelData
  /** CH-1: the app shell owns Agent/Scratchpad as right-pane tabs; keep legacy chrome available by default. */
  embedded?: boolean
  activeFile: string | null
  activeCollectionDir: string | null
  onOpenDigestPiece: (path: string) => void
  /** B5 replaces this no-op door with the manager sheet. */
  onManageSkills: (skillName?: string) => void
  /** Run a folder skill from the switcher: App resolves the focused folder (ticket 10). */
  onRunFolderSkill?: (skillName: string) => void
  /** Opens Settings at the existing account surface for API-key entry and broader account work. */
  onOpenAccountSettings: () => void
  onShowSkillToast: (toast: SkillToast) => void
  /** The persistent handoff row's actions (same handlers as the transient toast's). */
  onOpenReviewing: () => void
  onOpenNotes: (path: string) => void
}

const ACTIVITY_ICON: Record<ActivityRow['kind'], LucideIcon> = {
  read: FileSearch,
  list: ListTree,
  create: FilePlus2,
  rename: FolderSync,
  staged: PenLine,
  denied: ShieldX,
  undo: Undo2,
  info: Info,
}

const hhmm = (ts: number): string => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const truncate = (text: string, max = 90): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A rename target renders each side emphasised around the arrow, per the mockup's hist row. */
function Target({ target }: { target: string }): JSX.Element {
  const parts = target.split(' → ')
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && ' → '}
          <strong>{part}</strong>
        </span>
      ))}
    </>
  )
}

function Activity({
  row,
  withUndo,
  onUndo,
  onView,
}: {
  row: ActivityRow
  /** Render the mockup's Undo-turn ghost button inside this row's text block. */
  withUndo: boolean
  onUndo: () => void
  onView: (path: string, suggestionId?: string) => void
}): JSX.Element {
  const Icon = ACTIVITY_ICON[row.kind]
  const accent = row.kind === 'staged' && row.pending
  return (
    <div className="act" data-kind={row.kind}>
      <Icon className={accent ? 'icon sm accent' : 'icon sm'} />
      <div className="atext">
        {row.text}
        {row.target && (
          <>
            {' '}
            <Target target={row.target} />
          </>
        )}
        {row.kind === 'staged' && row.path && (
          <>
            {' — '}
            <button
              className="alink"
              title="View the staged edit in the document"
              aria-label="View the staged edit"
              onClick={() => row.path && onView(row.path, row.suggestionId)}
            >
              view
            </button>
          </>
        )}
        {row.sub && <small>{row.sub}</small>}
        {withUndo && (
          <button className="ghost" title="Undo turn (⌘⇧Z)" aria-label="Undo the agent's last turn" onClick={onUndo}>
            <Undo2 className="icon sm" />
            Undo turn <kbd>⌘⇧Z</kbd>
          </button>
        )}
      </div>
    </div>
  )
}

/** History (pre-window session content) renders as compact activity-style receipts, collapsed
 *  behind the mockup's "Earlier today" toggle. */
function HistoryRows({ history }: { history: ChatTurn[] }): JSX.Element {
  return (
    <>
      {history.map((turn) => {
        const text = turn.kind === 'user' ? turn.text : (turn.text ?? '')
        if (!text) return null
        const Icon = turn.kind === 'user' ? MessageSquare : Sparkles
        return (
          <div className="act" key={turn.id}>
            <Icon className="icon sm" />
            <div className="atext">
              {truncate(text)}
              <small>{hhmm(turn.at)}</small>
            </div>
          </div>
        )
      })}
    </>
  )
}

export function AgentReply({
  turn,
  isLatest,
  onUndo,
  onView,
  planCards = {},
  planActions,
}: {
  turn: AgentTurn
  isLatest: boolean
  onUndo: () => void
  onView: (path: string, suggestionId?: string) => void
  /** Running-order proposals render as their card in place of the staged row (ticket 09). */
  planCards?: PlanCards
  planActions?: PlanProposalCardActions
}): JSX.Element {
  // The mockup nests the Undo-turn button inside the last housekeeping row's text block; only the
  // latest turn's restore point is still live, so only it offers the button.
  const undoRowId =
    turn.undoable && isLatest
      ? [...turn.activity].reverse().find((row) => row.kind === 'create' || row.kind === 'rename')?.id
      : undefined
  return (
    <div className="msg-agent">
      <div className="msg-meta">Agent</div>
      {turn.text !== null && <Markdown text={turn.text} className={turn.error ? 'text error' : 'text'} />}
      {turn.activity.map((row) => (
        row.kind === 'staged' && row.capability === 'plan.propose' && row.suggestionId && planActions ? (
          <PlanProposalCard key={row.id} card={planCards[row.suggestionId] ?? emptyPlanCard(row.suggestionId)} actions={planActions} />
        ) : (
          <Activity key={row.id} row={row} withUndo={row.id === undoRowId} onUndo={onUndo} onView={onView} />
        )
      ))}
      {turn.undoable && isLatest && !undoRowId && (
        <button className="ghost" title="Undo turn (⌘⇧Z)" aria-label="Undo the agent's last turn" onClick={onUndo}>
          <Undo2 className="icon sm" />
          Undo turn <kbd>⌘⇧Z</kbd>
        </button>
      )}
      {turn.execution && (
        <div
          className="agent-turn-runtime"
          title={`Ran with ${turn.execution.provider}/${turn.execution.modelId} at ${turn.execution.thinkingLevel} reasoning`}
        >
          {turn.execution.modelId} · {turn.execution.thinkingLevel}
        </div>
      )}
    </div>
  )
}

/**
 * The agent pane (Task 15, mockup `.agent`): tabbed head (Agent | Scratchpad), the chat transcript
 * with activity rows, and the bottom console composer — a prompt mark, a single line and ⏎.
 * Never a Send button. Scratchpad is a designed empty state from Task 20.
 */
export function AgentPanel({
  agent,
  onClose,
  focusRequest,
  configurationRequest,
  actionRequest,
  onViewSuggestion,
  onExit,
  scratchpad,
  embedded = false,
  activeFile,
  activeCollectionDir,
  onOpenDigestPiece,
  onManageSkills,
  onRunFolderSkill,
  onOpenAccountSettings,
  onShowSkillToast,
  onOpenReviewing,
  onOpenNotes,
}: AgentPanelProps): JSX.Element {
  const [tab, setTab] = useState<'agent' | 'scratchpad'>('agent')
  const [histOpen, setHistOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [threadsOpen, setThreadsOpen] = useState(false)
  const [configurationOpen, setConfigurationOpen] = useState(false)
  const refreshModels = () => { void window.writeflex.modelPickerOpened().catch(() => {}) }
  useEffect(() => {
    if (configurationOpen) refreshModels()
  }, [configurationOpen])
  const [configurationBusy, setConfigurationBusy] = useState(false)
  const [modelSwitchError, setModelSwitchError] = useState('')
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [skillErrors, setSkillErrors] = useState<Array<{ source: string; message: string }>>([])
  const [threads, setThreads] = useState<ThreadMeta[]>([])
  const [threadError, setThreadError] = useState('')
  const auth = useIpcAuthFlow(window.writeflex.auth, { defaultProviderId: 'openai-codex' })
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const threadHeaderRef = useRef<HTMLDivElement | null>(null)
  const threadButtonRef = useRef<HTMLButtonElement | null>(null)
  const modelSelectRef = useRef<HTMLSelectElement | null>(null)
  const thinkingSelectRef = useRef<HTMLSelectElement | null>(null)
  const accountButtonRef = useRef<HTMLButtonElement | null>(null)
  const handledCompletionRef = useRef(0)
  const reviewCompletionAwaitingPathRef = useRef<number | null>(null)
  // Stick-to-bottom bookkeeping: a passive scroll listener keeps `atBottom` current so the
  // autoscroll effect only follows streaming updates for a reader already at the foot of the log —
  // never yanking one who scrolled up into history. `forceScroll` overrides it for the reader's own
  // submit, whose message should always come into view.
  const atBottomRef = useRef(true)
  const forceScrollRef = useRef(false)

  const refreshThreadData = useCallback(async (): Promise<void> => {
    try {
      const [skillResult, threadResult] = await Promise.all([
        window.writeflex.skills.list(),
        window.writeflex.threads.list(),
      ])
      setSkills(skillResult.skills)
      setSkillErrors(skillResult.errors)
      setThreads(threadResult.threads)
      setThreadError(threadResult.error ?? '')
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void refreshThreadData()
  }, [agent.thread?.id, refreshThreadData])

  const closeThreads = useCallback(() => {
    setThreadsOpen(false)
    window.requestAnimationFrame(() => threadButtonRef.current?.focus())
  }, [])

  useEffect(() => {
    if (!threadsOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!threadHeaderRef.current?.contains(event.target as Node)) closeThreads()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeThreads()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closeThreads, threadsOpen])

  const adoptThreadState = useCallback(async (operation: () => Promise<AgentState>): Promise<void> => {
    try {
      const next = await operation()
      agent.replaceState(next)
      setThreadError('')
      closeThreads()
      await refreshThreadData()
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : String(error))
    }
  }, [agent, closeThreads, refreshThreadData])

  const startNewConversation = useCallback(async (): Promise<void> => {
    // `abort()` reads useAgent's live running ref, so a click in the same task as Submit cannot see
    // a stale render and skip the abort. An idle abort is deliberately a no-op.
    await agent.abort().catch(() => {})
    setDraft('')
    await adoptThreadState(() => window.writeflex.threads.newChat())
  }, [adoptThreadState, agent])

  const closeThread = useCallback(async (id: string): Promise<void> => {
    await adoptThreadState(() => window.writeflex.threads.close(id))
  }, [adoptThreadState])

  const runSkillFromSwitcher = useCallback(async (name: string): Promise<void> => {
    // usability review verdict (skills-gate4-070 item 6): a run must be WATCHABLE — no fire-and-forget
    // background thread whose only signal is a late toast. Run as-is opens the thread and fires
    // in view, exactly the armed card's path.
    if (onRunFolderSkill && skills.find((skill) => skill.name === name)?.input === 'folder') {
      closeThreads()
      onRunFolderSkill(name)
      return
    }
    try {
      const next = await window.writeflex.threads.openSkill(name)
      agent.replaceState(next)
      setThreadError('')
      closeThreads()
      await refreshThreadData()
      if (activeFile) agent.promptAsIs()
    } catch (error) {
      setThreadError(error instanceof Error ? error.message : String(error))
    }
  }, [activeFile, agent, closeThreads, onRunFolderSkill, refreshThreadData, skills])

  useEffect(() => window.writeflex.threads.onRunComplete((payload: ThreadRunComplete) => {
    if (payload.outcome === 'error') {
      onShowSkillToast({ kind: 'error', skillName: payload.skillName, details: payload.reply })
    } else if (payload.skillName === 'review') {
      // B1's completion payload has no created path; the active-thread path is enriched below from
      // the activity row, while one-shot Review can only state the completed fact in this parcel.
      onShowSkillToast({ kind: 'notes', skillName: payload.skillName, path: null })
    } else if (payload.suggestionsStaged > 0) {
      onShowSkillToast({ kind: 'staged', skillName: payload.skillName, count: payload.suggestionsStaged })
    }
    void refreshThreadData()
  }), [onShowSkillToast, refreshThreadData])

  // A ⌘J / Sparkles / ask-row request: land on the Agent tab, prefill if text came along, focus.
  useEffect(() => {
    if (focusRequest.tick === 0) return
    setTab('agent')
    if (focusRequest.text !== undefined) setDraft(focusRequest.text)
    inputRef.current?.focus()
    // A prefilled quotation leaves the caret after it, ready for the question.
    if (focusRequest.text) requestAnimationFrame(() => { const input = inputRef.current; if (input) input.setSelectionRange(input.value.length, input.value.length) })
  }, [focusRequest])

  // "Ask first": a chat whose model is gone (and whose provider offers no other) opens the existing
  // model popover, where the notice sits beside the picker and the candidates come first.
  const pointAtModelPicker = useCallback((): void => {
    setTab('agent')
    setConfigurationOpen(true)
    window.requestAnimationFrame(() => modelSelectRef.current?.focus())
  }, [])
  const choiceThreadId = agent.modelChoice ? agent.thread?.id ?? '' : null
  useEffect(() => {
    if (choiceThreadId !== null) pointAtModelPicker()
  }, [choiceThreadId, pointAtModelPicker])

  useEffect(() => {
    if (!configurationRequest?.tick) return
    setTab('agent')
    setConfigurationOpen(true)
    window.requestAnimationFrame(() => {
      const target = configurationRequest.focus === 'model' ? modelSelectRef.current : thinkingSelectRef.current
      target?.focus()
    })
  }, [configurationRequest])

  useEffect(() => {
    if (!actionRequest?.tick) return
    if (actionRequest.action === 'new-conversation') void startNewConversation()
    else if (actionRequest.action === 'show-conversations') {
      setThreadsOpen(true)
      void refreshThreadData()
    } else if (agent.thread?.id) void closeThread(agent.thread.id)
  }, [actionRequest, agent.thread?.id, closeThread, refreshThreadData, startNewConversation])

  const configuredProviderIds = auth.providers.filter((provider) => provider.configured).map((provider) => provider.id)
  const supportedProviderIds = auth.providers.map((provider) => provider.id)
  // ⇧⌘J (and the palette's Open Scratchpad): land on the Scratchpad tab; ScratchpadPane focuses its filter.
  useEffect(() => {
    if (scratchpad.request.tick === 0) return
    setTab('scratchpad')
  }, [scratchpad.request])

  // Track whether the transcript sits at (or within 48px of) the bottom, updated passively on every
  // scroll so the autoscroll effect below can decide whether to follow new content.
  const BOTTOM_THRESHOLD = 48
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD
    }
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Keep the newest turn in view as the conversation grows (and when history expands) — but only
  // stick to the bottom when the reader is already there, or on their own submit (forceScroll).
  // A reader scrolled up into history is left in place while traces stream in beneath them.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (forceScrollRef.current || atBottomRef.current) {
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
    }
    forceScrollRef.current = false
  }, [agent.messages, agent.suggestions, histOpen])

  // Long instructions WRAP and the composer grows to eight lines before scrolling. Measured after every
  // draft change (typed, pasted, prefilled by Ask the agent, or cleared on send), so a prefilled
  // quotation is never hidden in a one-line box. usability review note 2026-07-23; cap raised 5 → 8 lines (fix 2026-10-12).
  const COMPOSER_MAX_LINES = 8
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 18
    el.style.height = `${Math.min(el.scrollHeight, Math.round(lineHeight * COMPOSER_MAX_LINES))}px`
    // tab/embedded: the textarea mounts when the Agent tab opens, and a draft already set must be measured then.
  }, [draft, tab, embedded])

  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // Submit only on a plain ⏎ — a held modifier (⇧/⌘/⌃/⌥) is never an accidental send.
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      if (agent.running) return
      const text = draft.trim()
      if (!text) return
      // "Ask first": never send while the chat waits for a model; the draft stays, the picker opens.
      if (agent.modelChoice) {
        pointAtModelPicker()
        return
      }
      // The reader's own message must come into view even if they were scrolled up reading history.
      forceScrollRef.current = true
      agent.prompt(text)
      setDraft('')
    } else if (e.key === 'Escape') {
      // Esc only acts from the focused composer: abort a running turn, else exit to the editor.
      e.preventDefault()
      e.stopPropagation()
      if (agent.running) agent.abort()
      else onExit()
    }
  }

  // Keyboard path across the tab pair (WAI-ARIA tabs: arrows move, the pair is one stop).
  function onTablistKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    setTab((current) => (current === 'agent' ? 'scratchpad' : 'agent'))
  }

  const latestAgentTurn = [...agent.messages].reverse().find((t): t is AgentTurn => t.kind === 'agent')
  const currentModel = agent.model
    ? agent.catalogue.find((model) => model.provider === agent.model?.provider && model.id === agent.model?.id)
    : null
  const currentModelName = currentModel?.name ?? agent.model?.id ?? 'No model'
  const currentModelAvailable = agent.model
    ? agent.models.some((model) => model.provider === agent.model?.provider && model.id === agent.model?.id)
    : false
  const configurationLabel = `Model and reasoning for this chat: ${currentModelName}; ${agent.thinking}`
  const empty = agent.messages.length === 0 && agent.history.length === 0
  const activeSkill = agent.thread?.kind === 'skill'
    ? skills.find((skill) => skill.name === agent.thread?.skillName) ?? null
    : null
  const activeSkillIcon = activeSkill ? skillIcon(activeSkill.icon) : null
  // The persistent handoff's notes fact: the latest turn's create row naming a .review.md.
  const skillNotesPath = activeSkill?.name === 'review'
    ? latestAgentTurn?.activity.find((row) => row.kind === 'create' && row.target?.endsWith('.review.md'))?.target ?? null
    : null

  useEffect(() => {
    const completion = agent.completion
    if (!completion || !activeSkill) return
    if (activeSkill.name === 'review' && completion.outcome === 'completed') {
      const path = latestAgentTurn?.activity.find((row) => row.kind === 'create' && row.target?.endsWith('.review.md'))?.target ?? null
      if (handledCompletionRef.current !== completion.id) {
        handledCompletionRef.current = completion.id
        reviewCompletionAwaitingPathRef.current = path ? null : completion.id
        onShowSkillToast({ kind: 'notes', skillName: activeSkill.name, path })
      } else if (reviewCompletionAwaitingPathRef.current === completion.id && path) {
        // Executor traces can arrive after prompt() resolves. Replace the fact-only toast with the
        // actionable one as soon as the create row supplies the .review.md path.
        reviewCompletionAwaitingPathRef.current = null
        onShowSkillToast({ kind: 'notes', skillName: activeSkill.name, path })
      }
      return
    }
    if (handledCompletionRef.current === completion.id) return
    handledCompletionRef.current = completion.id
    if (completion.outcome === 'error') {
      onShowSkillToast({ kind: 'error', skillName: activeSkill.name, details: completion.reply })
      return
    }
    if (completion.suggestionsStaged > 0) {
      onShowSkillToast({ kind: 'staged', skillName: activeSkill.name, count: completion.suggestionsStaged })
    }
  }, [activeSkill, agent.completion, latestAgentTurn, onShowSkillToast])

  return (
    <>
      {!embedded && (
        <div className="agent-head">
        <div className="rtabs" role="tablist" aria-label="Right panel" onKeyDown={onTablistKeyDown}>
          <button
            className="rtab"
            role="tab"
            aria-selected={tab === 'agent'}
            tabIndex={tab === 'agent' ? 0 : -1}
            title="Agent (⌘J)"
            onClick={() => setTab('agent')}
          >
            <Sparkles className="icon sm" />
            Agent
          </button>
          <button
            className="rtab"
            role="tab"
            aria-selected={tab === 'scratchpad'}
            tabIndex={tab === 'scratchpad' ? 0 : -1}
            title="Scratchpad (⇧⌘J lands with Scratchpad)"
            onClick={() => setTab('scratchpad')}
          >
            <StickyNote className="icon sm" />
            Scratchpad
          </button>
        </div>
        <span className="pane-head-gap" />
        <button className="tbtn" title="Close (⌘J reopens)" aria-label="Close panel" onClick={onClose}>
          <PanelRight className="icon" />
        </button>
      </div>
      )}

      {embedded || tab === 'agent' ? (
        <div className="rview">
          <div className="thread-header" ref={threadHeaderRef}>
            <button
              ref={threadButtonRef}
              type="button"
              className="thread-header-title"
              aria-haspopup="menu"
              aria-expanded={threadsOpen}
              onClick={() => setThreadsOpen((open) => !open)}
              title="Switch threads"
            >
              <strong>Threads</strong><ChevronDown className="icon sm" aria-hidden="true" />
            </button>
            <span className="gap" />
            <button type="button" className="ghost" onClick={() => void startNewConversation()} title="Start a new chat">
              <Plus className="icon sm" aria-hidden="true" />New
            </button>
            {threadsOpen && (
              <ThreadSwitcherPopover
                skills={skills}
                skillErrors={skillErrors}
                threads={threads}
                activeThreadId={agent.thread?.id ?? null}
                onNewChat={() => void startNewConversation()}
                onOpenSkill={(name) => void adoptThreadState(() => window.writeflex.threads.openSkill(name))}
                onRunSkill={(name) => void runSkillFromSwitcher(name)}
                onActivateThread={(id) => void adoptThreadState(() => window.writeflex.threads.activate(id))}
                onCloseThread={(id) => void closeThread(id)}
                onManageSkills={() => { closeThreads(); onManageSkills() }}
                onClose={closeThreads}
              />
            )}
          </div>
          {threadError && <div className="thread-inline-error" role="status">{threadError}</div>}
          {activeSkill && (
            <SkillThreadBanner
              skill={activeSkill}
              folder={agent.threadFolder}
              running={agent.running}
              hasTranscript={!empty}
              onManageSkills={onManageSkills}
              onRunAsIs={agent.promptAsIs}
            />
          )}
          <Digest dir={activeCollectionDir} onOpenPiece={onOpenDigestPiece} />
          <div className="agent-transcript" ref={scrollRef} role="log" aria-label="Agent conversation">
            {agent.history.length > 0 && (
              <>
                <button
                  className={histOpen ? 'hist-toggle open' : 'hist-toggle'}
                  aria-expanded={histOpen}
                  title="Earlier in this session"
                  onClick={() => setHistOpen((open) => !open)}
                >
                  <ChevronRight className="icon sm chev" />
                  Earlier today
                </button>
                <div className={histOpen ? 'hist-items open' : 'hist-items'}>
                  <HistoryRows history={agent.history} />
                </div>
              </>
            )}
            {activeSkill && (
              <ArmedSkillCard
                skill={activeSkill}
                activeFile={activeFile}
                transcriptEmpty={empty}
                running={agent.running}
                onRunAsIs={agent.promptAsIs}
              />
            )}
            {empty && !activeSkill && (
              <div className="rpane-empty">
                <Sparkles className="icon" />
                <p>
                  Ask for a read-through, a tighter opening, or a new file. Prose changes are always staged for your
                  review; housekeeping is snapshotted and undoable.
                </p>
                <p className="hint">
                  <kbd>⌘J</kbd> focuses the console
                </p>
              </div>
            )}
            {agent.messages.map((turn, index) => {
              const prev = agent.messages[index - 1]
              // A time divider opens the conversation and reappears after a half-hour lull.
              const divider =
                turn.kind === 'user' && (!prev || turn.at - prev.at > 30 * 60_000) ? (
                  <div className="chat-divider">{hhmm(turn.at)}</div>
                ) : null
              return (
                <div key={turn.id}>
                  {divider}
                  {turn.kind === 'user' ? (
                    <div className="msg-user">
                      <div className="msg-meta">You</div>
                      <div className="bubble">{turn.text}</div>
                    </div>
                  ) : (
                    <>
                      <AgentReply
                        turn={turn}
                        isLatest={turn === latestAgentTurn}
                        onUndo={agent.undoTurn}
                        onView={onViewSuggestion}
                        planCards={agent.planCards}
                        planActions={agent.planActions}
                      />
                      {turn.running && activeSkill && (
                        <SkillRunningLine
                          skillName={activeSkill.name}
                          skills={skills}
                          input={activeSkill.input}
                          folder={agent.threadFolder}
                          staging={turn.activity.some((row) => row.kind === 'staged' || row.kind === 'create')}
                          onCancel={agent.abort}
                        />
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>
          {activeSkill && !agent.running && (agent.suggestions.length > 0 || skillNotesPath) && (
            <SkillHandoffRow
              skillName={activeSkill.name}
              skills={skills}
              stagedCount={agent.suggestions.length}
              notesPath={skillNotesPath}
              onReview={onOpenReviewing}
              onOpenNotes={onOpenNotes}
            />
          )}
          <div className="agent-composer">
            <div className="agent-configuration">
              <button
                type="button"
                className={currentModelAvailable ? 'agent-configuration-summary' : 'agent-configuration-summary unavailable'}
                aria-label={configurationLabel}
                aria-expanded={configurationOpen}
                title={configurationLabel}
                onClick={() => setConfigurationOpen((open) => !open)}
              >
                <Cpu className="icon sm" aria-hidden="true" />
                <span>{currentModelName} · {agent.thinking}</span>
                <ChevronDown className="icon sm" aria-hidden="true" />
              </button>
              {configurationOpen && (
                <div className="agent-configuration-popover" role="group" aria-label="Model and reasoning for this chat">
                  <label>
                    <span>Model</span>
                    <select
                      ref={modelSelectRef}
                      onPointerDown={refreshModels}
                      onKeyDown={(event) => {
                        if ([' ', 'Enter', 'ArrowDown', 'ArrowUp', 'F4'].includes(event.key)) refreshModels()
                      }}
                      aria-label="Model for this chat"
                      value={agent.model ? `${agent.model.provider}::${agent.model.id}` : ''}
                      disabled={agent.running || configurationBusy}
                      onChange={async (event) => {
                        const [provider, ...id] = event.target.value.split('::')
                        setConfigurationBusy(true)
                        setModelSwitchError('')
                        try {
                          await agent.setModel(provider, id.join('::'))
                        } catch (error: unknown) {
                          setModelSwitchError(error instanceof Error ? error.message : String(error))
                        } finally {
                          setConfigurationBusy(false)
                        }
                      }}
                    >
                      {!agent.model && <option value="">No model</option>}
                      <AgentModelOptions current={agent.model} catalogue={agent.catalogue} models={agent.models} configuredProviderIds={configuredProviderIds} supportedProviderIds={supportedProviderIds} {...(agent.modelChoice ? { leading: agent.modelChoice.candidates } : {})} />
                    </select>
                  </label>
                  <label>
                    <span>Reasoning</span>
                    <select
                      ref={thinkingSelectRef}
                      aria-label="Reasoning level for this chat"
                      value={agent.thinking}
                      disabled={agent.running || configurationBusy}
                      onChange={async (event) => {
                        setConfigurationBusy(true)
                        try {
                          await agent.setThinking(event.target.value as 'minimal' | 'low' | 'medium' | 'high')
                        } catch (error: unknown) {
                          setThreadError(error instanceof Error ? error.message : String(error))
                        } finally {
                          setConfigurationBusy(false)
                        }
                      }}
                    >
                      <option value="minimal">minimal</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                  </label>
                  {!currentModelAvailable && agent.model && !agent.modelChoice && (
                    <small role="status">
                      {unavailableModelLine({
                        current: agent.model,
                        currentName: currentModelName,
                        providerSignedIn: configuredProviderIds.includes(agent.model.provider),
                        defaultModel: agent.defaultModel,
                        catalogue: agent.catalogue,
                        models: agent.models,
                      })}
                    </small>
                  )}
                  {!currentModelAvailable && !agent.model && <small role="status">This model is unavailable until its provider is configured in Settings.</small>}
                  {agent.modelNotice && <small role="status">{agent.modelNotice}</small>}
                  {modelSwitchError && <small role="status">{modelSwitchError}</small>}
                  <ModelRefreshControl checked={agent.modelsChecked} />
                  <div className="agent-provider-list" aria-label="Assistant accounts">
                    {auth.providers.map((provider, index) => {
                      const providerName = providerDisplayName(provider)
                      const oauth = provider.authLanes.includes('oauth')
                      return (
                        <div className="agent-provider-row" key={provider.id}>
                          <span><strong>{providerName}</strong><small>{provider.configured ? 'Configured' : 'Signed out'}</small></span>
                          {provider.configured ? (
                            <button ref={index === 0 ? accountButtonRef : undefined} type="button" className="ghost" onClick={() => auth.logout(provider.id)} title={`Sign out of ${providerName}`}>
                              <LogOut className="icon sm" aria-hidden="true" />Sign out
                            </button>
                          ) : (
                            <button ref={index === 0 ? accountButtonRef : undefined} type="button" className="ghost" onClick={() => oauth ? void auth.login(provider.id) : onOpenAccountSettings()} title={oauth ? `Sign in to ${providerName}` : `Add ${providerName} key in Settings`}>
                              {oauth ? 'Sign in' : 'Add key'}
                            </button>
                          )}
                        </div>
                      )
                    })}
                    <button type="button" className="agent-manage-accounts" onClick={onOpenAccountSettings}>Manage accounts in Settings</button>
                  </div>
                </div>
              )}
            </div>
            <div className="agent-console">
              <span className="prompt-mark" aria-hidden="true">{activeSkillIcon ? (() => { const Icon = activeSkillIcon; return <Icon className="icon sm" /> })() : '›'}</span>
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                placeholder={activeSkill ? 'Add instructions — e.g. “keep my terms, focus on §2”' : 'Message the agent…'}
                aria-label={activeSkill ? `Message ${skillDisplayName(activeSkill)}` : 'Message the agent'}
                title="Message the agent (⌘J)"
                disabled={configurationBusy}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onComposerKeyDown}
              />
              {agent.running ? (
                <>
                  <Loader2 className="icon sm spin" aria-hidden="true" />
                  <button className="console-stop" title="Stop the turn (Esc)" aria-label="Stop the turn" onClick={agent.abort}>
                    <Square className="icon sm" />
                  </button>
                </>
              ) : (
                <kbd>⏎</kbd>
              )}
            </div>
          </div>
        </div>
      ) : (
        <ScratchpadPane
          scraps={scratchpad.items}
          focusTick={scratchpad.request.focus ? scratchpad.request.tick : 0}
          onToggleDone={scratchpad.onToggleDone}
          onSetColour={scratchpad.onSetColour}
          onRemove={scratchpad.onRemove}
          onInsert={scratchpad.onInsert}
          onNewScrap={scratchpad.onNewScrap}
          sources={scratchpad.sources}
          onOpenSource={scratchpad.onOpenSource}
          onRevealSource={scratchpad.onRevealSource}
        />
      )}
    </>
  )
}
