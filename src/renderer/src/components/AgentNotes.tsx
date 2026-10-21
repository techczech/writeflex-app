import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, ExternalLink, FolderTree, ListFilter, Network, RotateCcw, Table2, Workflow, X, type LucideIcon } from 'lucide-react'
import type { AgentNote, AgentObjectNote, AgentProseNote, Change } from '../../../preload'
import { sameWorkspaceDocument, workspaceDirectory } from '../../../shared/agent-note-paths'
import { countTaskLines, readTaskLines, type TaskLine } from '../../../shared/markdown/task-lines'
import { NoteMarkdown, type NoteTasks } from './NoteMarkdown'

const KIND_ICON: Record<AgentObjectNote['kind'], LucideIcon> = {
  query: ListFilter,
  table: Table2,
  mermaid: Workflow,
  markmap: Network,
}

function displayDocument(path: string): string {
  const name = path.split('/').at(-1)?.replace(/\.(?:md|markdown|mdx)$/i, '') ?? path
  return name.replace(/[-_]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function compactSource(source: string): string {
  const fenced = /^```(?:query|mermaid|markmap)\r?\n([\s\S]*?)\r?\n```\s*$/.exec(source)
  return (fenced?.[1] ?? source).trim()
}

function noteDate(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString()
}

export type AgentNoteActions = {
  /** Open the note file itself in an editor tab (the app's ordinary open-file path). */
  onOpenFile: (path: string) => void
  /** Reveal the note file in the Files sidebar. */
  onReveal: (path: string) => void
  onRestage: (note: AgentObjectNote) => Promise<void>
  /** Tick or untick a box of a prose note (journey B). `line` is the note FILE's 1-based line;
   *  `checked` is the state the pane shows. Absent, the boxes are drawn but cannot be ticked. */
  onToggleTask?: (path: string, line: number, checked: boolean) => void
  /** Settle an agent's proposed tick (`tasks.toggle`) from the pane. */
  onResolveProposal?: (changeId: string, action: 'accept' | 'reject') => void
}

/** A pending agent `tasks.toggle` proposal, as the pane shows it on the box it would tick. */
export type TaskProposal = { changeId: string; path: string; from: number; tick: boolean }

/**
 * The agent's pending tick proposals (Changes staged by `tasks.toggle`) on the given note paths: an
 * agent Change whose whole text is a box's brackets. `from` is the `[`'s offset in the note file.
 */
export function taskProposalsFrom(changes: Change[], paths: ReadonlySet<string>): TaskProposal[] {
  return changes.flatMap((change) => {
    if (change.provenance !== 'agent' || change.status !== 'pending' || !paths.has(change.path) || !change.anchor) return []
    const boxes = /^\[[ xX]\]$/
    if (!boxes.test(change.oldText) || !boxes.test(change.newText)) return []
    return [{ changeId: change.id, path: change.path, from: change.anchor.from, tick: change.newText !== '[ ]' }]
  })
}

/** Where a box drawn from a note's body sits in the note FILE: the tick's target. Always the note's
 *  own path, never the piece it is about (journey B). */
export function noteTaskTarget(note: Pick<AgentProseNote, 'path' | 'bodyLine'>, item: Pick<TaskLine, 'line' | 'checked'>): { path: string; line: number; checked: boolean } {
  return { path: note.path, line: note.bodyLine + item.line - 1, checked: item.checked }
}

/** The pending agent proposal on a box drawn from a note's body, if any. */
export function proposalOnTask(note: Pick<AgentProseNote, 'path' | 'bodyOffset'>, item: Pick<TaskLine, 'from'>, proposals: TaskProposal[]): TaskProposal | undefined {
  return proposals.find((proposal) => proposal.path === note.path && proposal.from === note.bodyOffset + item.from)
}

/** "n of m dealt with" for a note body with boxes, or null when it has none (frame 10). */
export function reviewProgress(body: string): string | null {
  const counts = countTaskLines(readTaskLines(body))
  return counts.total === 0 ? null : `${counts.done} of ${counts.total} dealt with`
}

/**
 * Where a prose note belongs in the pane relative to the open document (Requirement: "I need
 * to be able to see it side by side with the text it comments on"): about THIS piece, about another
 * piece in the same folder, or elsewhere. The folder is the active document's when one is open,
 * otherwise the collection the pane is showing.
 */
export function groupProseNotes(notes: AgentProseNote[], activePath: string | null, dir: string): { onThisPiece: AgentProseNote[]; inThisFolder: AgentProseNote[] } {
  const folder = activePath ? workspaceDirectory(activePath) : dir
  const onThisPiece: AgentProseNote[] = []
  const inThisFolder: AgentProseNote[] = []
  for (const note of notes) {
    if (activePath && sameWorkspaceDocument(note.sourceDocument, activePath)) onThisPiece.push(note)
    else if (workspaceDirectory(workspaceDirectory(note.path)) === folder) inThisFolder.push(note)
  }
  return { onThisPiece, inThisFolder }
}

function ProposalChip({ proposal, onResolve }: { proposal: TaskProposal; onResolve: AgentNoteActions['onResolveProposal'] }): JSX.Element {
  return (
    <span className="an-task-proposal" data-change-id={proposal.changeId}>
      <span className="an-task-proposal-label">Agent proposes {proposal.tick ? 'ticking' : 'unticking'}</span>
      {onResolve && (
        <>
          <button type="button" className="an-task-proposal-act" onClick={() => onResolve(proposal.changeId, 'accept')} aria-label={proposal.tick ? 'Accept: tick this box' : 'Accept: untick this box'} title="Accept">
            <Check className="icon sm" aria-hidden="true" />Accept
          </button>
          <button type="button" className="an-task-proposal-act" onClick={() => onResolve(proposal.changeId, 'reject')} aria-label="Discard the proposal" title="Discard">
            <X className="icon sm" aria-hidden="true" />Discard
          </button>
        </>
      )}
    </span>
  )
}

function ProseNoteCard({ note, actions, proposals }: { note: AgentProseNote; actions: AgentNoteActions; proposals: TaskProposal[] }): JSX.Element {
  const progress = reviewProgress(note.body)
  const toggle = actions.onToggleTask
  const tasks: NoteTasks | undefined = toggle
    ? {
        onToggle: (item: TaskLine) => {
          const target = noteTaskTarget(note, item)
          toggle(target.path, target.line, target.checked)
        },
        extra: (item: TaskLine) => {
          const proposal = proposalOnTask(note, item, proposals)
          return proposal ? <ProposalChip proposal={proposal} onResolve={actions.onResolveProposal} /> : null
        },
      }
    : undefined
  return (
    <article className="agent-note-row agent-prose-note" data-note-path={note.path}>
      <div className="an-meta">
        <span className="an-kind">{note.kind}</span>
        {note.skill && <span className="an-skill">via {note.skill}</span>}
        {note.created && <time dateTime={note.created}>{noteDate(note.created)}</time>}
        {progress && <span className="an-progress">{progress}</span>}
      </div>
      <h3 className="an-title">{note.title}</h3>
      <div className="an-about">About {displayDocument(note.sourceDocument)}</div>
      <NoteMarkdown text={note.body} className="an-body" tasks={tasks} />
      <div className="an-actions">
        <button type="button" className="an-action" onClick={() => actions.onOpenFile(note.path)} title={`Open ${note.path}`} aria-label={`Open as file: ${note.title}`}>
          <ExternalLink className="icon sm" aria-hidden="true" />
          Open as file
        </button>
        <button type="button" className="an-action" onClick={() => actions.onReveal(note.path)} title="Show this note in the Files sidebar" aria-label={`Reveal in sidebar: ${note.title}`}>
          <FolderTree className="icon sm" aria-hidden="true" />
          Reveal in sidebar
        </button>
      </div>
    </article>
  )
}

function ObjectNoteCard({ note, onRestage }: { note: AgentObjectNote; onRestage: AgentNoteActions['onRestage'] }): JSX.Element {
  const Icon = KIND_ICON[note.kind]
  return (
    <article className="agent-note-row">
      <div className="an-meta">
        <time dateTime={note.recordedAt}>{new Date(note.recordedAt).toLocaleString()}</time>
        <span className={`an-status ${note.status}`}>{note.status.toUpperCase()}</span>
      </div>
      <div className="an-source-document">{displayDocument(note.sourceDocument)}</div>
      {note.invalidReason && <div className="an-invalid" role="status">Invalid: {note.invalidReason}</div>}
      <div className="an-object">
        <Icon className="icon sm" aria-hidden="true" />
        <div>
          <strong>{note.summary}</strong>
          <pre>{compactSource(note.source)}</pre>
        </div>
      </div>
      <button type="button" className="an-restage" disabled={Boolean(note.invalidReason)} title={note.invalidReason ? `Cannot restage: ${note.invalidReason}` : 'Restage this object'} onClick={() => void onRestage(note)} aria-label={note.invalidReason ? `Restage unavailable: ${note.invalidReason}` : 'Restage'}>
        <RotateCcw className="icon sm" aria-hidden="true" />
        Restage
      </button>
    </article>
  )
}

/** The pane's markup for a given list — pure, so a render test can drive it without IPC. */
export function AgentNotesView({ notes, activePath, dir, error, notice, proposals = [], actions, onKeyDown }: {
  notes: AgentNote[]
  activePath: string | null
  dir: string
  error?: string
  /** A one-line status (a refused tick or undo) shown above the notes. */
  notice?: string
  proposals?: TaskProposal[]
  actions: AgentNoteActions
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void
}): JSX.Element {
  const prose = notes.filter((note): note is AgentNote & { noteType: 'prose' } => note.noteType === 'prose')
  const objects = notes.filter((note): note is AgentNote & { noteType: 'object' } => note.noteType === 'object')
  const { onThisPiece, inThisFolder } = groupProseNotes(prose, activePath, dir)
  const empty = onThisPiece.length === 0 && inThisFolder.length === 0 && objects.length === 0
  return (
    <section className="agent-notes" aria-label="Agent notes" onKeyDown={onKeyDown}>
      {error && <p className="agent-notes-error" role="status">{error}</p>}
      {!error && notice && <p className="agent-notes-notice" role="status">{notice}</p>}
      {!error && empty && (
        <p className="agent-notes-empty">Nothing here yet — notes the agent leaves about a piece appear beside it here, and agent objects you discard wait here to be restaged.</p>
      )}
      {!error && !empty && (
        <section className="an-section" aria-label="Notes on this piece">
          <h2 className="an-section-title">Notes on this piece</h2>
          {onThisPiece.length === 0 && (
            <p className="agent-notes-empty an-section-empty">{activePath ? 'No agent notes about this piece yet.' : 'Open a piece to see the notes about it.'}</p>
          )}
          {onThisPiece.map((note) => <ProseNoteCard key={note.path} note={note} actions={actions} proposals={proposals.filter((proposal) => proposal.path === note.path)} />)}
        </section>
      )}
      {inThisFolder.length > 0 && (
        <details className="an-section an-collapsed">
          <summary className="an-section-title">Other notes in this folder <span className="an-count">{inThisFolder.length}</span></summary>
          {inThisFolder.map((note) => <ProseNoteCard key={note.path} note={note} actions={actions} proposals={proposals.filter((proposal) => proposal.path === note.path)} />)}
        </details>
      )}
      {objects.length > 0 && (
        <section className="an-section" aria-label="Discarded objects">
          <h2 className="an-section-title">Discarded objects</h2>
          {objects.map((note) => <ObjectNoteCard key={note.path} note={note} onRestage={actions.onRestage} />)}
        </section>
      )}
    </section>
  )
}

/** One tick the pane made, as it now stands: what ⌘Z in the pane turns back. */
type PaneTick = { path: string; line: number; checked: boolean }

function editableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== 'checkbox')
}

const message = (reason: unknown): string => reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(reason)

/** How the pane resolves a proposal: the app's document-owner route (resolution-routes.ts,
 *  resolveProposalThroughOwner), so an accept never writes an open document beside a save of it. */
export type ResolveProposal = (change: Change, action: 'accept' | 'reject') => Promise<{ applied: boolean; message?: string }>

export function AgentNotes({ dir, activePath, workspaceOpen = true, onRestage, onOpenFile, onReveal, resolveProposal }: { dir: string; activePath: string | null; workspaceOpen?: boolean; resolveProposal: ResolveProposal } & Pick<AgentNoteActions, 'onRestage' | 'onOpenFile' | 'onReveal'>): JSX.Element {
  const [notes, setNotes] = useState<AgentNote[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [changes, setChanges] = useState<Change[]>([])
  // The pane's own undo (journey B): each tick is one step, turned back by ⌘Z while focus is in the
  // pane. The undo is the inverse tick, guarded like any tick — it refuses if the box changed since.
  const ticks = useRef<PaneTick[]>([])

  const reload = useCallback(async (): Promise<void> => {
    try {
      setNotes(await window.writeflex.agentNotes.list(dir))
      setError('')
    } catch (reason) {
      setError(message(reason))
    }
  }, [dir])

  const reloadProposals = useCallback(async (): Promise<void> => {
    if (!workspaceOpen) { setChanges([]); return } // no Change Ledger to ask yet
    try {
      setChanges(await window.writeflex.listChanges({ provenance: 'agent', status: 'pending' }))
    } catch {
      setChanges([]) // no workspace or ledger yet: nothing to propose
    }
  }, [workspaceOpen])

  useEffect(() => {
    void reload()
    return window.writeflex.agentNotes.onChanged(() => void reload())
  }, [reload])

  useEffect(() => {
    void reloadProposals()
    return window.writeflex.onChangesChanged(() => void reloadProposals())
  }, [reloadProposals])

  const onToggleTask = useCallback((path: string, line: number, checked: boolean): void => {
    void (async () => {
      try {
        const done = await window.writeflex.agentNotes.toggleTask(path, line, checked)
        ticks.current.push(done)
        setNotice('')
      } catch (reason) {
        setNotice(message(reason))
      }
      await reload()
    })()
  }, [reload])

  const undoTick = useCallback((): boolean => {
    const last = ticks.current.pop()
    if (!last) return false
    void (async () => {
      try {
        await window.writeflex.agentNotes.toggleTask(last.path, last.line, last.checked)
        setNotice('')
      } catch (reason) {
        setNotice(`Could not undo the tick: ${message(reason)}`)
      }
      await reload()
    })()
    return true
  }, [reload])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return
    if (editableTarget(event.target)) return
    if (undoTick()) event.preventDefault()
  }, [undoTick])

  const onResolveProposal = useCallback((changeId: string, action: 'accept' | 'reject'): void => {
    const change = changes.find((candidate) => candidate.id === changeId)
    void (async () => {
      try {
        const result = change ? await resolveProposal(change, action) : { applied: false }
        setNotice(result.applied ? '' : (result.message ?? 'That proposal is no longer live; ask the agent again.'))
      } catch (reason) {
        setNotice(message(reason))
      }
      await Promise.all([reload(), reloadProposals()])
    })()
  }, [changes, resolveProposal, reload, reloadProposals])

  const notePaths = new Set(notes.filter((note) => note.noteType === 'prose').map((note) => note.path))
  return (
    <AgentNotesView
      notes={notes}
      activePath={activePath}
      dir={dir}
      error={error || undefined}
      notice={notice || undefined}
      proposals={taskProposalsFrom(changes, notePaths)}
      actions={{ onOpenFile, onReveal, onRestage, onToggleTask, onResolveProposal }}
      onKeyDown={onKeyDown}
    />
  )
}
