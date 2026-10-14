import { Check, CornerUpLeft, Pause, RotateCcw, StickyNote, X } from 'lucide-react'
import type { Change } from '../../../preload'
import { categoryKey, categoryLabel } from './change-review'

/** A change that only ADDS text (agent insertion, or any edit whose old side is empty). */
export const isInsertionChange = (c: Change): boolean => c.editClass === 'insert' || (c.oldText === '' && c.newText !== '')
/** A change that only REMOVES text (nothing added). */
export const isDeletionChange = (c: Change): boolean => c.newText === '' && c.oldText !== ''

export function diffText(change: Change): JSX.Element {
  if (change.editClass === 'move') {
    return (
      <>
        <span className="n">Moved</span> “{change.newText || change.oldText}”
      </>
    )
  }
  if (!change.oldText) return <span className="n">+ “{change.newText}”</span>
  if (!change.newText) return <span className="o">− “{change.oldText}”</span>
  return (
    <>
      <span className="o">{change.oldText}</span> <span aria-hidden="true">→</span> <span className="n">{change.newText}</span>
    </>
  )
}

/** Compact "when" for list rows: minutes/hours today, then day-month. */
export function relativeTime(ts: number): string {
  const delta = Date.now() - ts
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return 'just now'
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))} min ago`
  if (delta < day) return `${Math.max(1, Math.round(delta / hour))} hr ago`
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(ts))
}

export function statusLabel(change: Change): string | null {
  if (change.status === 'accepted') return 'changed to new'
  if (change.status === 'rejected') return 'kept old'
  return null
}

export function changeCategoryLabel(change: Change): string {
  return categoryLabel(categoryKey(change))
}

/** Button wording per card kind: a card that creates a file reads Don't add / Add widget, a text edit Keep old / Change to new. */
export function cardWording(change: Change): { reject: string; accept: string; acceptNext: string; kind: string | null } {
  return change.newFile
    ? { reject: "Don't add", accept: 'Add widget', acceptNext: 'Add and next', kind: 'Widget' }
    : { reject: 'Keep old', accept: 'Change to new', acceptNext: 'Accept and next', kind: null }
}

function quoted(text: string): string {
  return text ? `“${text}”` : 'old'
}

function oldNewText(change: Change): JSX.Element {
  if (change.editClass === 'move') {
    return (
      <>
        <span className="n">Moved</span> {quoted(change.newText || change.oldText)}
      </>
    )
  }
  if (!change.oldText) return <span className="n">+ {quoted(change.newText)}</span>
  if (!change.newText) return <span className="o">− {quoted(change.oldText)}</span>
  return (
    <>
      <s>{change.oldText}</s> <span aria-hidden="true">→</span> <i>{change.newText}</i>
    </>
  )
}

/** The embed line a new-widget proposal adds to the document: the one `[Simulation: ...]` line the old text lacks. */
function addedEmbedLine(change: Change): string {
  const before = new Set(change.oldText.split('\n'))
  return change.newText.split('\n').find((line) => line.startsWith('[Simulation:') && !before.has(line)) ?? ''
}

/** A proposal that also creates a file says so in words instead of showing the whole document struck through. */
function newFileBody(change: Change): JSX.Element {
  const line = addedEmbedLine(change)
  return (
    <>
      <span className="n">{change.summary}</span>
      {line && <> <span aria-hidden="true">·</span> adds the line <i>{line}</i></>}
    </>
  )
}

/**
 * The file a proposal would create (widgets.create), shown before the writer decides: its path in the Workspace
 * and its complete source. Accepting writes exactly this text to exactly this path, or nothing (main checks the hash).
 */
export function NewFilePart({ change }: { change: Change }): JSX.Element | null {
  const file = change.newFile
  if (!file) return null
  return (
    <details className="card-newfile" open data-newfile-path={file.path}>
      <summary>
        <span className="card-newfile-label">New file</span> <code className="card-newfile-path">{file.path}</code>{' '}
        <span className="card-newfile-size">{file.content.length.toLocaleString('en-GB')} characters</span>
      </summary>
      <pre className="card-newfile-source" tabIndex={0} aria-label={`Full source of ${file.path}`}>{file.content}</pre>
    </details>
  )
}

function heldText(change: Change): JSX.Element {
  return (
    <>
      <span>{change.oldText || 'old'}</span> <span className="held-slash" aria-hidden="true">/</span> <i>{change.newText || 'new'}</i>
      <span> — held open, both visible</span>
    </>
  )
}

/** The single-change resolution callbacks every card variant shares. */
export type ChangeCardActions = {
  onSelect: (id: string) => void
  onAccept: (id: string) => void | Promise<boolean>
  onAcceptNext: (id: string) => void | Promise<boolean>
  onReject: (id: string) => void | Promise<boolean>
  onHold: (id: string) => void | Promise<boolean>
  onRevertToActive: (change: Change) => void | Promise<void>
  onSendOriginalToScratchpad: (change: Change) => void | Promise<void>
}

function HistoryActions({
  change,
  onRevertToActive,
  onSendOriginalToScratchpad,
}: Pick<ChangeCardActions, 'onRevertToActive' | 'onSendOriginalToScratchpad'> & { change: Change }): JSX.Element {
  return (
    <>
      {change.status === 'accepted' && (
        <button type="button" className="ca" onClick={() => void onRevertToActive(change)}>
          <RotateCcw className="icon" aria-hidden="true" />
          Revert to active
        </button>
      )}
      {!change.newFile && (
        <button type="button" className="ca" onClick={() => void onSendOriginalToScratchpad(change)}>
          <StickyNote className="icon" aria-hidden="true" />
          Send original to Scratchpad
        </button>
      )}
    </>
  )
}

export function QuietFixRow({
  change,
  onSelect,
  onRevertToActive,
  onSendOriginalToScratchpad,
}: { change: Change } & Pick<ChangeCardActions, 'onSelect' | 'onRevertToActive' | 'onSendOriginalToScratchpad'>): JSX.Element {
  return (
    <div className="quiet-fix" data-cid={change.id}>
      <button type="button" onClick={() => onSelect(change.id)} title="Show in text">
        <s>{change.oldText}</s>
        <i>{change.newText}</i>
      </button>
      <span className="card-actions">
        <HistoryActions change={change} onRevertToActive={onRevertToActive} onSendOriginalToScratchpad={onSendOriginalToScratchpad} />
      </span>
    </div>
  )
}

/** A reviewable card (agent proposal or your edit): Keep old / Change to new / Hold both — or, for a pure
 *  insertion, Discard / Insert — plus the multi-select checkbox. */
export function ProvisionalCard({
  change,
  selected,
  picked,
  onTogglePick,
  unanchored = false,
  onRevise,
  onSelect,
  onAccept,
  onAcceptNext,
  onReject,
  onHold,
  onRevertToActive,
  onSendOriginalToScratchpad,
}: {
  change: Change
  selected: boolean
  picked: boolean
  onTogglePick: (id: string) => void
  /** The change's original text has drifted out of the buffer — it cannot be shown in the document. */
  unanchored?: boolean
  /** Hand the change back to the agent to redo against the current text (pre-fills the composer). */
  onRevise?: (id: string) => void
} & ChangeCardActions): JSX.Element {
  const words = cardWording(change)
  return (
    <article
      className={`working-card provisional-card${selected ? ' sel' : ''}${picked ? ' picked' : ''}`}
      data-cid={change.id}
      data-cat={categoryKey(change)}
    >
      <label className="card-select" title="Select for a batch action">
        <input
          type="checkbox"
          checked={picked}
          onChange={() => onTogglePick(change.id)}
          aria-label="Select this change for a batch action"
        />
      </label>
      <div className="card-inner">
        <button type="button" className="card-main" onClick={() => onSelect(change.id)} title={unanchored ? 'The passage has changed since this was proposed' : 'Show in text'}>
          <span className="card-kicker">{words.kind ?? changeCategoryLabel(change)} · {change.editClass === 'insert' ? 'insertion' : change.provenance === 'writer' ? 'your edit' : 'provisional'}</span>
          <span className="card-body">{change.newFile ? newFileBody(change) : oldNewText(change)}</span>
          {unanchored && (
            <span className="card-unanchored">The passage has changed since this was proposed — it cannot be shown in the text.</span>
          )}
        </button>
        <NewFilePart change={change} />
        <div className="card-actions">
          {unanchored ? (
            <>
              {/* No meaningful "old" exists once the passage drifted: the suggestion is either dropped
                  or handed back to the agent to redo against the current text (composer is editable). */}
              <button type="button" className="ca" onClick={() => void onReject(change.id)}>Discard suggestion</button>
              {onRevise && (
                <button type="button" className="ca revise" onClick={() => onRevise(change.id)}>
                  <CornerUpLeft className="icon" aria-hidden="true" />
                  Reconsider
                </button>
              )}
            </>
          ) : change.editClass === 'insert' ? (
            <>
              {/* An insertion adds text; there is no "old" to keep, so the pair is discard vs insert. */}
              <button type="button" className="ca" onClick={() => void onReject(change.id)}>Discard</button>
              <button type="button" className="ca keep" onClick={() => void onAccept(change.id)}>
                <Check className="icon" aria-hidden="true" />
                Insert
              </button>
              <button type="button" className="ca" onClick={() => void onAcceptNext(change.id)}>Accept and next</button>
            </>
          ) : (
            <>
              <button type="button" className="ca" onClick={() => void onReject(change.id)}>{words.reject}</button>
              <button type="button" className="ca keep" onClick={() => void onAccept(change.id)}>
                <Check className="icon" aria-hidden="true" />
                {words.accept}
              </button>
              <button type="button" className="ca" onClick={() => void onAcceptNext(change.id)}>{words.acceptNext}</button>
              {!change.newFile && (
                <button type="button" className="ca hold" onClick={() => void onHold(change.id)}>
                  <Pause className="icon" aria-hidden="true" />
                  Hold both
                </button>
              )}
            </>
          )}
          <HistoryActions change={change} onRevertToActive={onRevertToActive} onSendOriginalToScratchpad={onSendOriginalToScratchpad} />
        </div>
      </div>
    </article>
  )
}

export function HeldCard({
  change,
  selected,
  onSelect,
  onAccept,
  onReject,
  onRevertToActive,
  onSendOriginalToScratchpad,
}: {
  change: Change
  selected: boolean
} & Omit<ChangeCardActions, 'onHold'>): JSX.Element {
  const words = cardWording(change)
  return (
    <article
      className={`working-card held-card${selected ? ' sel' : ''}`}
      data-cid={change.id}
      data-cat={categoryKey(change)}
    >
      <button type="button" className="card-main" onClick={() => onSelect(change.id)} title="Show in text">
        <span className="card-kicker">Workshopping</span>
        <span className="card-body">{change.newFile ? newFileBody(change) : heldText(change)}</span>
      </button>
      <NewFilePart change={change} />
      <div className="card-actions">
        <button type="button" className="ca" onClick={() => void onReject(change.id)}>{words.reject}</button>
        <button type="button" className="ca keep" onClick={() => void onAccept(change.id)}>
          <Check className="icon" aria-hidden="true" />
          {words.accept}
        </button>
        <HistoryActions change={change} onRevertToActive={onRevertToActive} onSendOriginalToScratchpad={onSendOriginalToScratchpad} />
      </div>
    </article>
  )
}

export function OtherChangeRow({
  change,
  selected,
  onSelect,
  onAccept,
  onReject,
  onRevertToActive,
  onSendOriginalToScratchpad,
}: {
  change: Change
  selected: boolean
} & Omit<ChangeCardActions, 'onHold'>): JSX.Element {
  const cat = categoryKey(change)
  const words = cardWording(change)
  const resolved = statusLabel(change)
  return (
    <div
      className={`cchange review-item${selected ? ' sel' : ''}${resolved ? ` ${change.status}` : ''}`}
      data-cid={change.id}
      data-cat={cat}
    >
      <span className="bar" aria-hidden="true" />
      <button type="button" className="chead item-main" onClick={() => onSelect(change.id)} title="Show in text">
        <span className="catdot">{categoryLabel(cat)}</span>
        <span className="cdiff txt">{change.newFile ? newFileBody(change) : diffText(change)}</span>
        <span className="meta">{change.provenance === 'writer' ? 'your edit' : change.provenance}</span>
      </button>
      {change.status === 'pending' && <NewFilePart change={change} />}
      {change.status === 'pending' && change.provenance === 'writer' ? (
        <span className="cresolved accepted">folds into version</span>
      ) : change.status === 'pending' ? (
        <span className="yn">
          <button className="imini ok" type="button" title={words.accept} aria-label={words.accept} onClick={() => void onAccept(change.id)}>
            <Check className="icon" aria-hidden="true" />
          </button>
          <button className="imini no" type="button" title={words.reject} aria-label={words.reject} onClick={() => void onReject(change.id)}>
            <X className="icon" aria-hidden="true" />
          </button>
        </span>
      ) : (
        <span className={`cresolved ${change.status}`}>{resolved}</span>
      )}
      <span className="card-actions">
        <HistoryActions change={change} onRevertToActive={onRevertToActive} onSendOriginalToScratchpad={onSendOriginalToScratchpad} />
      </span>
    </div>
  )
}
