import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Eraser,
  Eye,
  Glasses,
  Hammer,
  ListOrdered,
  MessageSquare,
  PenLine,
  Settings,
  ShieldCheck,
  Sparkles,
  StickyNote,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { SkillMeta, ThreadMeta } from '../../../preload'
import type { SkillNaming } from '../../../shared/skill-display'
import { relativeTime } from './relative-time'
import { AGENT_ICON, AGENT_ICON_CLASS } from './agent-icon'
import { readScopeLabel, runningLineText, skillDisplayName, skillDisplayNameFor } from '../../../shared/skill-display'

export type SkillToast =
  | { kind: 'staged'; skillName: string; count: number }
  | { kind: 'notes'; skillName: string; path: string | null }
  | { kind: 'error'; skillName: string; details: string | null }

export type SkillScopeChip = {
  kind: 'staged' | 'read' | 'housekeeping' | 'scratchpad'
  label: string
}

type SkillRegistryError = { source: string; message: string }

const SKILL_ICONS: Record<string, LucideIcon> = {
  'pen-line': PenLine,
  glasses: Glasses,
  eraser: Eraser,
  'list-ordered': ListOrdered,
}

/** The skill's on-screen name (ticket 11): its SKILL.md `title:`, else its name. Shared with main. */
export { skillDisplayName, skillDisplayNameFor } from '../../../shared/skill-display'

export function skillIcon(icon: string | undefined): LucideIcon {
  return icon ? SKILL_ICONS[icon] ?? Sparkles : Sparkles
}

/** ONE registry, two doors, ONE order (ADR-0027): the CONTENT.md presentation order for the
 *  bundled skills — copy-edit, review, clean-up (the loader sorts alphabetically) — with any
 *  further skills appended alphabetically. The switcher, the palette, and the ⌥⌘1/2/3 chord
 *  assignment (B3) all read THIS order. */
const PREFERRED_SKILL_ORDER = ['copy-edit', 'review', 'clean-up']
export function orderSkills<T extends { name: string }>(skills: readonly T[]): T[] {
  const rank = (name: string): number => {
    const index = PREFERRED_SKILL_ORDER.indexOf(name)
    return index === -1 ? PREFERRED_SKILL_ORDER.length : index
  }
  return [...skills].sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : 1))
}

/** The agent's icon on a control that starts an agent run (ticket 12): the same icon as the right
 *  pane's Agent tab, before the control's label, so the writer sees the agent is doing the work. */
export const AgentLaunchIcon = (): JSX.Element => <AGENT_ICON className={`icon sm ${AGENT_ICON_CLASS}`} aria-hidden="true" />

/** A skill's trigger (SKILL.md `trigger:`) as a button on the surface it acts on — the Plan pane's
 *  Help with this report (ticket 10). The same accent treatment as the armed card's Run as-is, and
 *  the agent's icon before its label (ticket 12), whatever the skill's own icon. */
export function SkillTriggerButton({
  label,
  disabled = false,
  onRun,
}: {
  label: string
  disabled?: boolean
  onRun: () => void
}): JSX.Element {
  return (
    <button type="button" className="ghost primary skill-trigger" disabled={disabled} onClick={onRun} title={label}>
      <AgentLaunchIcon />{label}
    </button>
  )
}

/** The banner's scope chips. `scope` words the read chip: a folder skill works on its folder. */
export function scopeChipsForTools(tools: string[], scope: { input: string; folder?: string | null } = { input: 'document' }): SkillScopeChip[] {
  const kinds = new Set<SkillScopeChip['kind']>()
  for (const tool of tools) {
    if (tool.startsWith('prose.')) kinds.add('staged')
    if (tool === 'files.read' || tool === 'files.list') kinds.add('read')
    if (tool.startsWith('frontmatter.') || tool.startsWith('housekeeping.') || tool.startsWith('folio.')) {
      kinds.add('housekeeping')
    }
    if (tool.startsWith('scraps.')) kinds.add('scratchpad')
  }
  const vocabulary: Record<SkillScopeChip['kind'], string> = {
    staged: 'staged edits only',
    read: readScopeLabel(scope.input, scope.folder ?? null),
    housekeeping: 'housekeeping — auto-applied',
    scratchpad: 'scratchpad',
  }
  return (['staged', 'read', 'housekeeping', 'scratchpad'] as const)
    .filter((kind) => kinds.has(kind))
    .map((kind) => ({ kind, label: vocabulary[kind] }))
}

export const ScopeIcon = ({ kind }: { kind: SkillScopeChip['kind'] }): JSX.Element => {
  const Icon = kind === 'staged' ? ShieldCheck : kind === 'read' ? Eye : kind === 'housekeeping' ? Hammer : StickyNote
  return <Icon className="icon sm" aria-hidden="true" />
}

type ThreadSwitcherPopoverProps = {
  skills: SkillMeta[]
  skillErrors: SkillRegistryError[]
  threads: ThreadMeta[]
  activeThreadId: string | null
  onNewChat: () => void
  onOpenSkill: (name: string) => void
  onRunSkill: (name: string) => void
  onActivateThread: (id: string) => void
  onCloseThread: (id: string) => void
  onManageSkills: () => void
  onClose: () => void
}

export function ThreadSwitcherPopover({
  skills,
  skillErrors,
  threads,
  activeThreadId,
  onNewChat,
  onOpenSkill,
  onRunSkill,
  onActivateThread,
  onCloseThread,
  onManageSkills,
  onClose,
}: ThreadSwitcherPopoverProps): JSX.Element {
  const [activeRow, setActiveRow] = useState(0)
  const rowRefs = useRef<Array<HTMLElement | null>>([])
  const orderedSkills = orderSkills(skills)
  const recent = threads
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  const rowCount = 2 + orderedSkills.length + recent.length

  useEffect(() => {
    rowRefs.current[0]?.focus()
  }, [])

  const focusRow = useCallback((index: number) => {
    const next = Math.max(0, Math.min(index, rowCount - 1))
    setActiveRow(next)
    rowRefs.current[next]?.focus()
  }, [rowCount])

  const onRowKeyDown = useCallback((event: React.KeyboardEvent, index: number, primary: () => void, alternate?: () => void) => {
    // Skill verb buttons remain ordinary tab stops. Their native Enter must not bubble into the
    // containing roving row and also fire Open thread.
    if (event.currentTarget !== event.target && (event.target as HTMLElement).closest('button')) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusRow(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusRow(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusRow(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusRow(rowCount - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (event.metaKey && alternate) alternate()
      else primary()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }, [focusRow, onClose, rowCount])

  let rowIndex = 0
  const newChatIndex = rowIndex++
  return (
    <div className="thread-popover" role="menu" aria-label="Threads">
      <button
        ref={(node) => { rowRefs.current[newChatIndex] = node }}
        type="button"
        className="thread-row"
        tabIndex={activeRow === newChatIndex ? 0 : -1}
        onFocus={() => setActiveRow(newChatIndex)}
        onKeyDown={(event) => onRowKeyDown(event, newChatIndex, onNewChat)}
        onClick={onNewChat}
        title="Start a new chat"
      >
        <MessageSquare className="icon" aria-hidden="true" />
        <span className="thread-row-copy"><strong>New chat</strong><small>Everything the app can do</small></span>
        <kbd>↵</kbd>
      </button>

      <div className="thread-section-label">Skills</div>
      {orderedSkills.map((skill) => {
        const index = rowIndex++
        const Icon = skillIcon(skill.icon)
        return (
          <div
            key={skill.name}
            ref={(node) => { rowRefs.current[index] = node }}
            className="thread-row thread-skill-row"
            role="menuitem"
            tabIndex={activeRow === index ? 0 : -1}
            onFocus={() => setActiveRow(index)}
            onKeyDown={(event) => onRowKeyDown(event, index, () => onOpenSkill(skill.name), () => onRunSkill(skill.name))}
            title={`${skillDisplayName(skill)} — Enter opens the thread; Command-Enter runs as-is`}
          >
            <Icon className="icon" aria-hidden="true" />
            <span className="thread-row-copy">
              <strong>{skillDisplayName(skill)}</strong>
              <small title={skill.description}>{skill.description}</small>
            </span>
            <span className="thread-skill-actions">
              <button type="button" className="ghost" onClick={() => onRunSkill(skill.name)} title={`Run ${skillDisplayName(skill)} as-is (⌘↵)`}><AgentLaunchIcon />Run as-is</button>
              <button type="button" className="ghost primary" onClick={() => onOpenSkill(skill.name)} title={`Open a ${skillDisplayName(skill)} thread (↵)`}>Open thread</button>
            </span>
          </div>
        )
      })}
      {skillErrors.length > 0 && (
        <div className="thread-skill-error" role="status">A skill failed to load — {skillErrors[0].message}</div>
      )}

      {recent.length > 0 && <div className="thread-section-label">Conversations</div>}
      {recent.map((thread) => {
        const index = rowIndex++
        const meta = thread.kind === 'skill' ? skills.find((skill) => skill.name === thread.skillName) : undefined
        const Icon = thread.kind === 'skill' ? skillIcon(meta?.icon) : MessageSquare
        const kind = thread.kind === 'skill' ? skillDisplayNameFor(thread.skillName ?? '', skills) : 'Chat'
        return (
          <div
            key={thread.id}
            ref={(node) => { rowRefs.current[index] = node }}
            className="thread-row thread-conversation-row"
            role="menuitem"
            aria-current={thread.id === activeThreadId ? 'page' : undefined}
            tabIndex={activeRow === index ? 0 : -1}
            onFocus={() => setActiveRow(index)}
            onKeyDown={(event) => onRowKeyDown(event, index, () => onActivateThread(thread.id))}
            title={`Open thread: ${thread.title}`}
          >
            <button type="button" className="thread-conversation-open" onClick={() => onActivateThread(thread.id)} title={`Open thread: ${thread.title}`}>
              <Icon className="icon sm" aria-hidden="true" />
              <span className="thread-row-copy"><strong>{thread.title}</strong><small>{kind} · {relativeTime(thread.lastActiveAt)}</small></span>
            </button>
            <button
              type="button"
              className="thread-conversation-close"
              aria-label={`Close conversation: ${thread.title}`}
              title={`Close conversation: ${thread.title}`}
              onClick={() => onCloseThread(thread.id)}
            >
              <X className="icon sm" aria-hidden="true" />
            </button>
          </div>
        )
      })}

      {(() => {
        const index = rowIndex
        return (
          <button
            ref={(node) => { rowRefs.current[index] = node }}
            type="button"
            className="thread-row thread-manage-row"
            tabIndex={activeRow === index ? 0 : -1}
            onFocus={() => setActiveRow(index)}
            onKeyDown={(event) => onRowKeyDown(event, index, onManageSkills)}
            onClick={onManageSkills}
            title="Manage skills"
          >
            <Settings className="icon sm" aria-hidden="true" />
            <span className="thread-row-copy"><strong>Manage skills</strong></span>
            <ChevronRight className="icon sm" aria-hidden="true" />
          </button>
        )
      })()}
    </div>
  )
}

export function SkillThreadBanner({
  skill,
  folder = null,
  running,
  hasTranscript,
  onManageSkills,
  onRunAsIs,
}: {
  skill: SkillMeta
  /** A folder skill's launch folder in this thread, when known — the scope chip names it. */
  folder?: string | null
  running: boolean
  hasTranscript: boolean
  onManageSkills: (name: string) => void
  onRunAsIs: () => void
}): JSX.Element {
  const Icon = skillIcon(skill.icon)
  return (
    <div className="skill-thread-banner">
      <div className="skill-thread-banner-head">
        <Icon className="icon" aria-hidden="true" />
        <strong>{skillDisplayName(skill)}</strong>
        <span className="gap" />
        {/* A folder skill's run is launched on a folder (Plan pane, folder menu, palette), never here. */}
        {(hasTranscript || running) && skill.input !== 'folder' && (
          <button type="button" className="ghost" disabled={running} onClick={onRunAsIs} title={`Run ${skillDisplayName(skill)} as-is`}><AgentLaunchIcon />Run as-is</button>
        )}
        <button type="button" className="icon-button" onClick={() => onManageSkills(skill.name)} title={`Manage ${skillDisplayName(skill)}`} aria-label={`Manage ${skillDisplayName(skill)}`}>
          <ChevronDown className="icon sm" aria-hidden="true" />
        </button>
      </div>
      <div className="skill-scope-chips">
        {scopeChipsForTools(skill.tools, { input: skill.input, folder }).map((chip) => (
          <span className="skill-scope-chip" key={chip.kind}><ScopeIcon kind={chip.kind} />{chip.label}</span>
        ))}
      </div>
    </div>
  )
}

export function ArmedSkillCard({
  skill,
  activeFile,
  transcriptEmpty,
  running,
  onRunAsIs,
}: {
  skill: SkillMeta
  activeFile: string | null
  transcriptEmpty: boolean
  running: boolean
  onRunAsIs: () => void
}): JSX.Element | null {
  if (!transcriptEmpty) return null
  // A folder skill has no document to arm on: its launch points name the folder (ticket 10).
  if (skill.input === 'folder') return null
  if (!activeFile && skill.input !== 'document') return null
  const name = skillDisplayName(skill)
  const basename = activeFile?.split(/[\\/]/).at(-1) ?? activeFile
  return (
    <div className="skill-armed-card">
      <div className="skill-armed-copy">
        <strong>{basename ? `Run on ${basename}` : `Open a document to run ${name}.`}</strong>
        {basename && <small>As written — or add instructions below first.</small>}
      </div>
      {basename && (
        <button type="button" className="ghost primary" disabled={running} onClick={onRunAsIs} title={`Run ${name} as-is on ${basename}`}>
          <AgentLaunchIcon />Run as-is
        </button>
      )}
    </div>
  )
}

export function SkillCompletionToast({
  toast,
  skills = [],
  onDismiss,
  onReview,
  onOpenNotes,
}: {
  toast: SkillToast
  /** The registry, so the toast names the skill by its title (ticket 11). */
  skills?: readonly SkillNaming[]
  onDismiss: () => void
  onReview: () => void
  onOpenNotes: (path: string) => void
}): JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const name = skillDisplayNameFor(toast.skillName, skills)
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 8000)
    return () => window.clearTimeout(timer)
  }, [onDismiss, toast])

  return (
    <div className="skill-toast" role="status" aria-live="polite">
      <Sparkles className="icon sm" aria-hidden="true" />
      <div className="skill-toast-copy">
        <strong>
          {toast.kind === 'staged'
            ? `${name} staged ${toast.count} ${toast.count === 1 ? 'change' : 'changes'}`
            : toast.kind === 'notes'
              ? `${name} left notes`
              : `${name} stopped — nothing was changed.`}
        </strong>
        {toast.kind === 'staged' && <small>opens Reviewing</small>}
        {toast.kind === 'error' && detailsOpen && toast.details && <small className="skill-toast-details">{toast.details}</small>}
      </div>
      {toast.kind === 'staged' && <button type="button" className="ghost" onClick={onReview} title="Open Reviewing">Review ›</button>}
      {toast.kind === 'notes' && toast.path && <button type="button" className="ghost" onClick={() => onOpenNotes(toast.path as string)} title={`Open ${toast.path}`}>Open notes ›</button>}
      {toast.kind === 'error' && <button type="button" className="ghost" onClick={() => setDetailsOpen((open) => !open)} title="Show failure details">Details</button>}
      <button type="button" className="skill-toast-dismiss" onClick={onDismiss} title="Dismiss" aria-label="Dismiss notification"><X className="icon sm" aria-hidden="true" /></button>
    </div>
  )
}

type SkillHandoffRowProps = {
  skillName: string
  /** The registry, so the row names the skill by its title (ticket 11). */
  skills?: readonly SkillNaming[]
  /** Pending staged suggestions → the `Review ›` handoff (ADR-0004: Review is the only verb). */
  stagedCount: number
  /** A written notes file → `Open notes ›` (the Review skill's housekeeping handoff). */
  notesPath: string | null
  onReview: () => void
  onOpenNotes: (path: string) => void
}

/** The PERSISTENT completion handoff (usability review verdict, skills-recheck-071: "it's not in the agent
 *  side bar which is where it should persist") — the toast is a transient echo; this row lives in
 *  the panel above the composer for as long as its fact holds (suggestions pending / notes file
 *  known), surviving thread switches and re-hydration. */
export function SkillHandoffRow({ skillName, skills = [], stagedCount, notesPath, onReview, onOpenNotes }: SkillHandoffRowProps): JSX.Element {
  const name = skillDisplayNameFor(skillName, skills)
  return (
    <div className="skill-handoff" role="status">
      {stagedCount > 0 ? (
        <>
          <ShieldCheck className="icon sm" aria-hidden="true" />
          <span className="skill-handoff-copy"><strong>{name} staged {stagedCount} {stagedCount === 1 ? 'change' : 'changes'}</strong><small>waiting in Reviewing</small></span>
          <button type="button" className="ghost" onClick={onReview} title="Open Reviewing">Review ›</button>
        </>
      ) : (
        <>
          <StickyNote className="icon sm" aria-hidden="true" />
          <span className="skill-handoff-copy"><strong>{name} left notes</strong><small title={notesPath ?? undefined}>{notesPath}</small></span>
          {notesPath && <button type="button" className="ghost" onClick={() => onOpenNotes(notesPath)} title={`Open ${notesPath}`}>Open notes ›</button>}
        </>
      )}
    </div>
  )
}

/** CONTENT.md's activation copy, live (recheck2-073: "in progress is not clear — should give a
 *  clearer message earlier, not wait on the agent to respond"): shown the INSTANT a skill run
 *  starts, before any model output, advancing once staging begins. Cancel is the same abort. */
export function SkillRunningLine({ skillName, skills = [], input = 'document', folder = null, staging, onCancel }: {
  skillName: string
  skills?: readonly SkillNaming[]
  /** The skill's `input`: a folder skill reads its launch folder, not "your document" (ticket 11). */
  input?: string
  /** A folder skill's launch folder in this thread, when known — the same memory the scope chip reads. */
  folder?: string | null
  staging: boolean
  onCancel: () => void
}): JSX.Element {
  return (
    <div className="skill-running" role="status" aria-live="polite">
      <span className="skill-running-spin" aria-hidden="true" />
      <span className="skill-running-copy">
        {runningLineText(skillDisplayNameFor(skillName, skills), staging, input, folder)}
      </span>
      <button type="button" className="ghost" onClick={onCancel} title="Stop the run (Esc)">Cancel</button>
    </div>
  )
}
