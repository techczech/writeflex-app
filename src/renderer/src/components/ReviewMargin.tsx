import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BlockType, type EditorView, type ViewUpdate } from '@codemirror/view'
import { AlertTriangle, Ban, Bot, CircleDot, ListFilter, Check, CheckCheck, ChevronRight, ChevronUp, CircleX, CloudOff, Copy as CopyIcon, CornerUpLeft, FilePlus, Globe, History, Info, Layers, MessageSquare, MoreHorizontal, Pause, Pencil, Reply, RotateCcw, Send, Split, Terminal, User, X } from 'lucide-react'
import type { Change } from '../../../preload'
import { cardKeyAction, describeMarginCard, describeSettledModeCard, describeSettledRow, replyCountLabel, runMarginAction, type MarginActionContext, type MarginActionId, type MarginCardDescriptor, type SettledModeCardDescriptor, type SettledRowDescriptor } from '../app/margin-card'
import { setPreferredView, setTextRoom, usePreferredView } from '../app/margin-view-store'
import { effectiveMarginView, textRoomBesideMargin, layoutEntriesFor, marginEntriesOf, MARGIN_WIDTH, paragraphEnd, paragraphKey, paragraphKeyAt, TOP_PARAGRAPH, UNDER_SPACER_GAP, updateMovesCards, viewportMovedSince, type MarginEntry, type SeenViewport } from '../app/margin-geometry'
import { isWriterTyping, layoutMargin, layoutUnder, type MarginLayout, type Placement, type TypingState, type UnderLayout } from '../app/margin-layout'
import { buildMarginModels, makeAnchorResolver, marginVisible, trackSettledHere, type MarginItem, type MarginModel, type MarginSettledRow, type MarginView } from '../app/margin-model'
import type { ReviewActions } from '../app/review-actions'
import { marginPerf } from '../app/margin-perf'
import { visibleSelection } from '../app/margin-bulk'
import { setMarginOutline } from '../editor/margin-outline'
import { metadataProposalsField, sameMetadataProposals, setMetadataProposals } from '../editor/metadata-proposals'
import { metadataProposalsOf } from '../app/metadata-proposal'
import { changeMarksOf, reviewMarksOf, sameChangeMarks, setChangeMarkHover, setChangeMarks } from '../editor/change-marks'
import { sameSpacers, setUnderSpacers, underSpacerField, type UnderSpacer } from '../editor/margin-under-spacers'
import type { MarginOutside } from '../app/margin-outside'
import { AllowanceStrip } from './OutsideDockParts'
import { marginAllowanceVisible } from './outside-dock-model'
import { filterLine } from '../app/margin-filter'
import { modeLineOf, reviewModeOf } from '../app/margin-mode'
import { EMPTY_HEAD_FILTER, type HeadControls, type HeadFilterState } from '../app/margin-head-state'

type CardActions = Pick<ReviewActions, 'acceptChange' | 'acceptAndNext' | 'rejectChange' | 'holdChange' | 'reviseChange'>

const ACTION_ICONS: Partial<Record<MarginActionId, typeof Check>> = { accept: Check, decline: X, reply: CornerUpLeft, hold: Pause, 'copy-wording': CopyIcon, dismiss: X }

/** The word on a card for its kind: the kind word is Comment (ADR-0046); your own edit is a Recorded edit. */
function kindWordOf(descriptor: Pick<MarginCardDescriptor, 'kindLabel'>, card: Pick<MarginItem, 'source'>): string {
  if (card.source.type === 'you') return 'Recorded edit'
  return descriptor.kindLabel
}

const SOURCE_ICONS = { agent: Bot, outside: Terminal, reader: User, you: User } as const
function SourceIcon({ type }: { type: MarginItem['source']['type'] }): JSX.Element {
  const Icon = SOURCE_ICONS[type]
  return <Icon className="icon mg-src" aria-hidden="true" />
}

function DiffView({ segments }: { segments: MarginCardDescriptor['segments'] }): JSX.Element {
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'del' ? <del key={index}>{segment.text}</del>
          : segment.kind === 'ins' ? <ins key={index}>{segment.text}</ins>
            : <span key={index}>{segment.text}</span>)}
    </>
  )
}

/** A reader's words on the card (0.24 ticket 07): the words it was written on when the passage changed or went, and a note's text. Text nodes only. */
function ReaderBody({ reader }: { reader: NonNullable<MarginCardDescriptor['reader']> }): JSX.Element {
  return (
    <>
      {reader.written !== null && (
        <div className="mg-written" data-margin-written><span className="lab">Written on these words</span><q>{reader.written}</q></div>
      )}
      {reader.note !== null && <p className="mg-c-note clamp" data-margin-note-text>{reader.note}</p>}
    </>
  )
}

/** Under the change: why a reader's edit could not be applied (frame `review-cannot-apply`), or that the words stand in more than one place. */
function ReaderNotices({ reader }: { reader: NonNullable<MarginCardDescriptor['reader']> }): JSX.Element | null {
  if (reader.closed) return <p className="mg-c-notice" data-margin-closed-reason><Info className="icon" aria-hidden="true" /><span>{reader.closed.reason}</span></p>
  if (reader.ambiguous) return <p className="mg-c-notice" data-margin-flag="ambiguous"><Split className="icon" aria-hidden="true" /><span>These words stand in more than one place. Shown beside the one whose surrounding words match best.</span></p>
  return null
}

/** The most a reply holds (the sharing service's OUTCOME_LIMITS.replyChars). */
const REPLY_CHARS = 1000

/** The reply box of a reader's card (0.24 ticket 08, frame `review-reply`): which card it is open on, what is typed, and what the buttons do. */
export type ReplyControls = {
  draft: { id: string; text: string } | null
  sending: boolean
  error: string | null
  onChange: (id: string, text: string) => void
  onCancel: () => void
  onSend: (change: Change, text: string, markDone: boolean) => void
}

/**
 * The writer's replies under a reader's note (frame `review-reply`): author tag, Reply, when, and Sent,
 * Not sent yet, or why it was not sent. Text nodes only. Above them, when the link's service no longer
 * holds the note, a notice that nothing more reaches the reader.
 */
function ReplyThread({ reader }: { reader: NonNullable<MarginCardDescriptor['reader']> }): JSX.Element | null {
  const { replies, noteGone } = reader
  if (replies.length === 0 && !noteGone) return null
  return (
    <>
      {noteGone && <p className="mg-c-notice" data-margin-note-gone><CloudOff className="icon" aria-hidden="true" /><span>This comment is no longer on the reader's page. Its outcome and your replies do not reach them.</span></p>}
      {replies.length > 0 && (
        <ol className="mg-thread" data-margin-thread>
          {replies.map((reply) => (
            <li key={reply.id} className="t-entry by-author" data-margin-reply={reply.state}>
              <div className="t-head">
                <Reply className="icon" aria-hidden="true" />
                <b>{reply.by}</b>
                <span className="mg-role r-author">author</span>
                <span className="mg-kind">Reply</span>
                <span className="mg-when">{reply.when}</span>
                {reply.state === 'sent'
                  ? <span className="mg-st sent"><Check className="icon" aria-hidden="true" />{reply.stateLabel}</span>
                  : reply.state === 'unsent' || reply.state === 'update'
                    ? <span className="mg-st unsent"><CloudOff className="icon" aria-hidden="true" />{reply.stateLabel}</span>
                    : <span className="mg-st not-sent"><Ban className="icon" aria-hidden="true" />{reply.stateLabel}</span>}
              </div>
              <p className="t-body">{reply.text}</p>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

/**
 * Reply open on a reader's card (frame `review-reply`): "Reply to <name>", the box, who sees it and when,
 * the count of 1,000; then Send reply (⌘↵), Send and mark done on a waiting note, Cancel (Esc). The
 * reply is kept as text on the note's record and sent to the link it came through; it decides nothing.
 */
function ReplyArea({ descriptor, change, reply }: { descriptor: MarginCardDescriptor; change: Change; reply: ReplyControls }): JSX.Element {
  const text = reply.draft?.text ?? ''
  const name = descriptor.name
  const length = text.trim().length
  const ready = length > 0 && text.length <= REPLY_CHARS && !reply.sending
  const markDone = descriptor.reader?.canMarkDone === true
  const send = (done: boolean): void => { if (ready) reply.onSend(change, text, done) }
  return (
    <>
      <div className="mg-reply-area" data-margin-reply-area>
        <label className="lab" htmlFor={`reply-${change.id}`}>Reply to {name}</label>
        <textarea
          id={`reply-${change.id}`}
          className="mg-reply-box"
          value={text}
          autoFocus
          rows={3}
          aria-label={`Reply to ${name}`}
          onChange={(event) => reply.onChange(change.id, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); send(false) }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); reply.onCancel() }
          }}
        />
        <div className="mg-reply-meta">
          <span><Globe className="icon sm" aria-hidden="true" /> {name} sees this on their page the next time it loads.</span>
          <span className={text.length > REPLY_CHARS ? 'over' : undefined} data-margin-reply-count>{text.length.toLocaleString('en-GB')} of {REPLY_CHARS.toLocaleString('en-GB')}</span>
        </div>
        {reply.error && <p className="mg-c-notice mg-reply-error" role="alert"><Info className="icon" aria-hidden="true" /><span>{reply.error}</span></p>}
      </div>
      <div className="mg-actions">
        <button type="button" className="mg-btn primary" data-margin-action="send-reply" disabled={!ready} onClick={() => send(false)}><Send className="icon" aria-hidden="true" />Send<kbd>⌘↵</kbd></button>
        {markDone && <button type="button" className="mg-btn" data-margin-action="send-reply-done" disabled={!ready} onClick={() => send(true)}><Check className="icon" aria-hidden="true" />Send and mark done</button>}
        <button type="button" className="mg-btn" data-margin-action="cancel-reply" onClick={reply.onCancel}><X className="icon" aria-hidden="true" />Cancel<kbd>Esc</kbd></button>
      </div>
    </>
  )
}

function KindIcon({ kind }: { kind: MarginCardDescriptor['kindLabel'] }): JSX.Element {
  return kind === 'Comment' ? <MessageSquare className="icon" aria-hidden="true" /> : kind === 'New file' ? <FilePlus className="icon" aria-hidden="true" /> : <Pencil className="icon" aria-hidden="true" />
}

function FoldedLine({ card, descriptor, onOpen }: { card: MarginItem; descriptor: MarginCardDescriptor; onOpen: () => void }): JSX.Element {
  const replies = descriptor.reader?.replies.length ?? 0
  return (
    <button type="button" className="mg-fold-line" onClick={onOpen} aria-label={`Open card ${descriptor.marker}: ${descriptor.name}`}>
      <ChevronRight className="icon" aria-hidden="true" />
      <span className="mg-num">{descriptor.marker}</span>
      <b>{descriptor.name}</b>
      {replies > 0 ? (
        // A thread folded (frame review-reply): "Jonas · 1 note" and the count of replies.
        <span className="mg-fl-sum"> · 1 comment <span className="mg-fl-rep" title={replies === 1 ? '1 reply' : `${replies} replies`} data-margin-reply-count-folded><Reply className="icon" aria-hidden="true" />{replies}</span></span>
      ) : (
        <>
          <KindIcon kind={descriptor.kindLabel} />
          <span className="mg-fl-sum">{descriptor.reader?.note ?? (card.change.newFile ? card.change.summary : card.change.newText || card.change.oldText)}</span>
        </>
      )}
      {descriptor.stale ? <span className={`mg-st ${descriptor.stale.kind === 'changed' ? 'changed' : 'failed'}`} data-margin-status={descriptor.stale.kind === 'changed' ? 'passage-changed' : 'not-placed'}>{descriptor.stale.label}</span>
        : descriptor.refused ? <span className="mg-st failed" data-margin-status="not-applied">Could not be applied</span>
          : replies > 0 && card.status === 'pending' ? <span className="mg-st open">1 open</span> : descriptor.statusSpeaks ? <span className={`mg-st ${card.status === 'closed' ? 'failed' : 'held'}`}>{descriptor.statusLabel}</span> : null}
    </button>
  )
}

/** The labelled actions of a focused card, each with its key, and More (a menu with a key on each row). Drawn always, shown by the card's focus. */
function CardActionsRow({ descriptor, change, actions, context, moreOpen, onMoreToggle, onDone, markDone, holdFocus = false }: {
  descriptor: MarginCardDescriptor
  change: Change
  actions: CardActions
  context: MarginActionContext
  moreOpen: boolean
  onMoreToggle: () => void
  onDone: (id: MarginActionId) => void
  markDone: boolean
  /** The row is drawn at rest (a stale card, ticket 06): a press must not focus the card first, or the focus-only
   *  role line appears above the buttons, moves them, and the click lands on the card instead. */
  holdFocus?: boolean
}): JSX.Element {
  const run = (id: MarginActionId): void => { onDone(id); void runMarginAction(id, change, actions, context) }
  return (
    <div className="mg-actions" data-margin-actions onMouseDown={holdFocus ? (event) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() } : undefined}>
      {descriptor.primary.map((item) => {
        const Icon = item.id === 'accept' && markDone ? CheckCheck : ACTION_ICONS[item.id]
        return (
          <button key={item.id} type="button" className={`mg-btn${item.id === 'accept' ? ' yes' : item.id === 'decline' ? ' no' : ''}`} data-margin-action={item.id} onClick={() => run(item.id)}>
            {Icon && <Icon className="icon" aria-hidden="true" />}
            {item.label}
            {item.key && <kbd>{item.key}</kbd>}
          </button>
        )
      })}
      {descriptor.more.length > 0 && <span className="mg-more-wrap">
        <button type="button" className="mg-btn icon-only" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={moreOpen} data-margin-action="more" onClick={onMoreToggle}>
          <MoreHorizontal className="icon" aria-hidden="true" />
        </button>
        {moreOpen && (
          <div className="mg-menu" role="menu">
            {descriptor.more.map((item) => (
              <button key={item.id} type="button" role="menuitem" data-margin-action={item.id} onClick={() => run(item.id)}><span>{item.label}</span>{item.key && <kbd>{item.key}</kbd>}</button>
            ))}
          </div>
        )}
      </span>}
    </div>
  )
}

export type MarginPanelProps = {
  model: MarginModel
  layout: MarginLayout | null
  /** The cards under their paragraphs (Under view). */
  underLayout?: UnderLayout | null
  /** The view actually drawn: 'under' when the editor is too narrow, whatever was chosen. */
  view: MarginView
  /** What the writer chose with the switch. */
  preferredView: MarginView
  onViewChange: (view: MarginView) => void
  selectedId: string | null
  foldedIds: ReadonlySet<string>
  onFold: (id: string) => void
  onOpen: (id: string) => void
  actions: CardActions
  context: MarginActionContext
  onSelect: (id: string) => void
  onPick: (id: string) => void
  onHover: (id: string | null) => void
  onMove: (direction: -1 | 1) => void
  controls: HeadControls
  moreOpenId: string | null
  onMoreOpen: (id: string | null) => void
  /** Changes from outside the app: allowance, arrivals, "could not be placed", other pieces. Absent = none of those rows. */
  outside?: MarginOutside
  /** Agent changes whose words are no longer in the text: flagged "Passage changed" (Decline, or Reply to send it back). */
  unanchoredIds?: ReadonlySet<string>
  /** The agent's items sent back with a note (ticket 04): their cards say Sent back until they are settled. */
  sentBackIds?: ReadonlySet<string>
  /** The reply box on a reader's card (0.24 ticket 08). Absent: no reply box is drawn. */
  reply?: ReplyControls
  now?: number
  /** The card holding DOM focus (click, Tab, a step): drawn with its ring, role line and labelled actions. */
  focusedId?: string | null
  onFocusCard?: (id: string | null) => void
  /** Called with a focused card just before Accept, Decline or Dismiss settles it, so focus can move on (ticket 09). */
  onHandOff?: (from: HTMLElement) => void
  /** Cards that arrived and have not been focused yet: a dot. */
  unreadIds?: ReadonlySet<string>
  /** The text the cards' anchors were resolved in: with it, an edit is drawn inside its sentence (ticket 13). */
  document?: string
  /** Accepts main refused because the change could not be placed, by id, with the reason (ticket 06, from 14). */
  refused?: ReadonlyMap<string, string>
}

/**
 * The line at the top of the margin while a filter hides items (frame `filter-notes`): what is shown, what is hidden,
 * and Show all, which goes back to All and Everyone in one click. Absent when nothing is filtered.
 */
export function MarginFilterLine({ model, controls }: { model: MarginModel; controls: HeadControls }): JSX.Element | null {
  const line = filterLine(model, controls.state.filter, model.counts.total)
  if (!line) return null
  return (
    <div className="mg-filterline" data-margin-filterline role="status">
      <ListFilter className="icon" aria-hidden="true" />
      <b>{line.label}.</b>
      <span>{line.hidden.charAt(0).toUpperCase() + line.hidden.slice(1)}.</span>
      <button type="button" className="mg-btn" data-margin-action="show-all" onClick={() => controls.onState({ ...controls.state, filter: {} })}>Show all</button>
    </div>
  )
}

/**
 * The top of the margin in Settled today or My edits (ticket 08, frames `settled`, `my-edits`): the mode's name, what it
 * holds, and in Settled today the Include quiet fixes switch. Nothing else is drawn above the cards in a mode.
 */
export function MarginModeLine({ model, controls }: { model: MarginModel; controls: HeadControls }): JSX.Element | null {
  const line = modeLineOf(model, controls.state.showQuiet)
  if (!line) return null
  if (line.mode === 'settled') {
    return (
      <div className="mg-modeline" data-margin-mode="settled" role="status">
        <History className="icon" aria-hidden="true" />
        <b>{line.label}</b>
        <span className="mg-modeline-n" data-margin-mode-count>{line.text}</span>
        <label className="mg-modeline-quiet">
          <input type="checkbox" checked={line.includeQuiet} data-margin-action="include-quiet" onChange={() => controls.onState({ ...controls.state, showQuiet: !controls.state.showQuiet })} />
          Include quiet fixes{line.quiet > 0 && <span className="mg-modeline-n"> {line.quiet}</span>}
        </label>
      </div>
    )
  }
  return (
    <div className="mg-modeline mine" data-margin-mode="mine" role="status">
      <div className="mg-modeline-row"><Pencil className="icon" aria-hidden="true" /><b>{line.label}</b></div>
      <p className="mg-modeline-text" data-margin-mode-count>{line.text}</p>
    </div>
  )
}

/**
 * The top of the margin (ticket 10): nothing is drawn there unless it has something to say. In Settled today or My edits
 * it is the mode's line; in review it is the filter line while a filter hides items, and the allowance line while a
 * limit on outside changes is reached. The old Review bar (title, position, switch, chips, bulk row, outside rows) is
 * gone; each of its functions lives in the status bar's review line, its count menu, the popovers or the palette.
 */
export function MarginTop({ model, controls, outside }: Pick<MarginPanelProps, 'model' | 'controls' | 'outside'>): JSX.Element | null {
  if (model.mode !== undefined && model.mode !== 'review') {
    return (
      <div className="mg-top mg-top-mode" data-margin-top>
        <MarginModeLine model={model} controls={controls} />
      </div>
    )
  }
  const filtered = filterLine(model, controls.state.filter, model.counts.total) !== null
  const allowance = marginAllowanceVisible(outside?.summary ?? null)
  if (!filtered && !allowance) return null
  return (
    <div className="mg-top" data-margin-top>
      <MarginFilterLine model={model} controls={controls} />
      {allowance && <AllowanceStrip summary={outside?.summary ?? null} onSourceBulk={outside?.onSourceBulk} />}
    </div>
  )
}

/** The leader from the passage to its card (ticket 01): out of the text, level with the words, in to the card's head. */
function Leader({ placement }: { placement: Placement }): JSX.Element | null {
  const dy = Math.round(placement.anchorTop + 12 - placement.top)
  const head = 18
  const w = 30
  const d = Math.abs(dy - head) < 2 ? `M0 ${head}H${w}` : `M0 ${dy}H12V${head}H${w}`
  const top = Math.min(dy, head) - 4
  const height = Math.abs(dy - head) + 8
  return (
    <svg className="mg-leader" aria-hidden="true" width={w} height={height} viewBox={`0 ${top} ${w} ${height}`} style={{ top }} data-margin-leader>
      <path d={d} />
      <circle cx="1.5" cy={dy} r="2.5" />
    </svg>
  )
}

/** The cards and settled rows of the margin, in the order Tab and ↑ ↓ walk them. */
const STEP_SELECTOR = '[data-margin-card], [data-margin-settled-row], [data-margin-settled-card]'

/** The actions that settle a card and so remove it from where focus is. */
const SETTLING_ACTIONS: ReadonlySet<MarginActionId> = new Set<MarginActionId>(['accept', 'decline', 'dismiss'])

/** The waiting cards of a margin, top to bottom as drawn (settled rows and settled cards are not waiting). */
function waitingCardsOf(root: ParentNode | null): HTMLElement[] {
  return [...(root?.querySelectorAll<HTMLElement>('[data-margin-card]') ?? [])].sort((a, b) => a.offsetTop - b.offsetTop)
}

/** ↑ ↓ on a card or a row: the one above or below. */
function stepFocus(event: React.KeyboardEvent<HTMLElement>): void {
  const all = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(STEP_SELECTOR) ?? [])].sort((a, b) => a.offsetTop - b.offsetTop)
  const next = all[all.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)]
  if (next) { event.preventDefault(); next.focus() }
}

function StaleStatus({ descriptor }: { descriptor: MarginCardDescriptor }): JSX.Element | null {
  if (descriptor.stale) {
    const changed = descriptor.stale.kind === 'changed'
    return (
      <span className={`mg-st ${changed ? 'changed' : 'failed'}`} data-margin-status={changed ? 'passage-changed' : 'not-placed'}>
        {changed ? <History className="icon" aria-hidden="true" /> : <AlertTriangle className="icon" aria-hidden="true" />}
        {descriptor.stale.label}
      </span>
    )
  }
  if (descriptor.refused) return <span className="mg-st failed" data-margin-status="not-applied"><Ban className="icon" aria-hidden="true" />Could not be applied</span>
  return null
}

function MarginCardView({ card, descriptor, placement, props }: { card: MarginItem; descriptor: MarginCardDescriptor; placement: Placement | null; props: MarginPanelProps }): JSX.Element {
  const selected = props.selectedId === card.id
  const focused = props.focusedId === card.id
  const picked = props.controls.picked.has(card.id)
  const folded = props.foldedIds.has(card.id)
  const unread = props.unreadIds?.has(card.id) === true
  const style = placement ? { top: placement.top } : { top: 0, visibility: 'hidden' as const }
  const line = placement?.fold === 'stack' || placement?.fold === 'thread-line' || placement?.fold === 'line' || folded
  const sentBack = props.sentBackIds?.has(card.id) === true
  const stale = descriptor.stale !== null || descriptor.refused !== null
  const again = card.again === true
  const speaks = descriptor.statusSpeaks || descriptor.reader?.changed === true || sentBack || stale || again
  const exception = speaks || descriptor.reader?.ambiguous === true || descriptor.reader?.noteGone === true || descriptor.reader?.gone === true || props.unanchoredIds?.has(card.id) === true
  // An item at the top of the margin has no passage to lead to.
  const leader = placement !== null && !line && placement.paragraph !== TOP_PARAGRAPH
  const replies = descriptor.reader?.replies.length ?? 0
  const markDone = card.kind === 'note'
  const ref = useRef<HTMLElement | null>(null)
  // Accept, Decline and Dismiss take the card away: focus moves on to the next shown card first (ticket 09).
  const handOff = (id: MarginActionId): void => { if (SETTLING_ACTIONS.has(id) && ref.current) props.onHandOff?.(ref.current) }
  const quick = (id: MarginActionId): void => { props.onMoreOpen(null); handOff(id); void runMarginAction(id, card.change, props.actions, props.context) }
  return (
    <article
      ref={ref}
      className={`mg-card k-${card.kind}${card.source.type === 'outside' ? ' from-outside' : ''}${selected || focused ? ' is-focus' : ''}${selected ? ' is-selected' : ''}${picked ? ' is-picked' : ''}${unread ? ' is-new' : ''}${exception ? ' show-always' : ''}${line ? ' is-line' : ''}${placement?.fold === 'stack' ? ' in-stack' : ''}${stale ? ' is-stale' : ''}`}
      style={style}
      data-margin-card={card.id}
      data-margin-stale={descriptor.stale?.kind ?? (descriptor.refused ? 'not-applied' : undefined)}
      data-margin-open={line ? undefined : ''}
      data-kind={card.kind}
      data-status={card.status}
      data-unread={unread ? '' : undefined}
      tabIndex={0}
      aria-selected={picked || undefined}
      title={descriptor.title ?? undefined}
      onMouseEnter={() => props.onHover(card.id)}
      onMouseLeave={() => props.onHover(null)}
      onFocus={() => props.onFocusCard?.(card.id)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onFocusCard?.(null) }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button')) return
        if (event.metaKey || event.ctrlKey) { props.onPick(card.id); return }
        props.onSelect(card.id)
      }}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement).closest('textarea, input')) return
        const onCard = event.target === event.currentTarget
        // Enter and Backspace belong to a focused button inside the card; only the card itself answers them.
        const action = (event.key === 'Enter' || event.key === 'Backspace' || event.key === 'Delete') && !onCard ? null : cardKeyAction(event.key, descriptor)
        if (action) {
          event.preventDefault()
          props.onMoreOpen(null)
          handOff(action)
          void runMarginAction(action, card.change, props.actions, props.context)
        } else if (event.key === ' ' && onCard) {
          event.preventDefault()
          props.onPick(card.id)
        } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && onCard) {
          stepFocus(event)
        }
      }}
    >
      {leader && <Leader placement={placement} />}
      {unread && <span className="mg-unread" data-margin-unread aria-label="New" />}
      {line ? (
        <FoldedLine card={card} descriptor={descriptor} onOpen={() => props.onOpen(card.id)} />
      ) : (
        <div className="mg-card-full">
          <div className="mg-c-head">
            <span className="mg-num">{descriptor.marker}</span>
            <SourceIcon type={card.source.type} />
            <span className="mg-who">{descriptor.name}</span>
            <span className="mg-kind"><KindIcon kind={descriptor.kindLabel} />{kindWordOf(descriptor, card)}</span>
            <span className="mg-when" data-margin-when>{descriptor.time}</span>
            {replies > 0 && <span className="mg-rep" title={replyCountLabel(replies)}><Reply className="icon" aria-hidden="true" />{replies}</span>}
            {descriptor.hover.length > 0 && (
              <span className="mg-quick" data-margin-quick>
                {descriptor.hover.map((item) => {
                  const Icon = item.id === 'accept' && markDone ? CheckCheck : ACTION_ICONS[item.id]
                  const label = `${item.label}${item.key ? ` (${item.key})` : ''}`
                  return <button key={item.id} type="button" className={item.id === 'accept' ? 'q-yes' : item.id === 'decline' ? 'q-no' : undefined} tabIndex={-1} title={label} aria-label={label} data-margin-quick-action={item.id} onClick={() => quick(item.id)}>{Icon && <Icon className="icon" aria-hidden="true" />}</button>
                })}
              </span>
            )}
            <button type="button" className="mg-foldbtn" title="Fold this card to one line" aria-label="Fold this card to one line" onClick={() => props.onFold(card.id)}><ChevronUp className="icon" aria-hidden="true" /></button>
          </div>
          {speaks && (
            <div className="mg-c-status">
              {descriptor.statusSpeaks && (
                <span className={`mg-st ${card.status === 'held' ? 'held' : 'failed'}`} data-margin-status={card.status}>
                  {card.status === 'held' ? <Pause className="icon" aria-hidden="true" /> : <Ban className="icon" aria-hidden="true" />}
                  {descriptor.statusLabel}
                </span>
              )}
              {again && !descriptor.statusSpeaks && <><span className="mg-st open" data-margin-status="waiting-again"><CircleDot className="icon" aria-hidden="true" />Open</span><span className="mg-when">Reopened just now</span></>}
              {sentBack && <span className="mg-st sent" data-margin-status="sent-back"><Send className="icon" aria-hidden="true" />Sent back</span>}
              {descriptor.reader?.changed && <span className="mg-st changed" data-margin-flag="text-changed"><History className="icon" aria-hidden="true" />Passage changed</span>}
              {(!descriptor.reader?.changed || descriptor.stale?.kind !== 'changed') && <StaleStatus descriptor={descriptor} />}
            </div>
          )}
          {descriptor.stale?.written && <div className="mg-written" data-margin-written><span className="lab">Written on these words</span><q>{descriptor.stale.written}</q></div>}
          {descriptor.reader && <ReaderBody reader={descriptor.reader} />}
          {descriptor.segments.length > 0 && <div className="mg-c-change clamp" data-margin-change><DiffView segments={descriptor.segments} /></div>}
          {descriptor.body !== null && <p className="mg-c-note clamp" data-margin-note-text>{descriptor.body}</p>}
          {descriptor.reader?.changed && <p className="mg-c-notice"><Info className="icon" aria-hidden="true" /><span>Shown beside the nearest passage.</span></p>}
          {descriptor.reader && <ReaderNotices reader={descriptor.reader} />}
          {descriptor.stale && <p className="mg-c-notice" data-margin-stale-notice><Info className="icon" aria-hidden="true" /><span>{descriptor.stale.notice}</span></p>}
          {descriptor.refused && <p className="mg-c-notice" data-margin-refused-reason><Info className="icon" aria-hidden="true" /><span>{descriptor.refused}</span></p>}
          {descriptor.replyException && <p className="mg-c-notice mg-rest-exception" data-margin-reply-exception><CloudOff className="icon" aria-hidden="true" /><span>Your reply: {descriptor.replyException}</span></p>}
          <p className="mg-role-line" data-margin-role>{descriptor.roleLine}</p>
          {descriptor.reader && <ReplyThread reader={descriptor.reader} />}
          {descriptor.newFilePath && (
            <details className="card-newfile mg-c-newfile" open data-newfile-path={descriptor.newFilePath}>
              <summary>
                <span className="card-newfile-label">New file</span> <code className="card-newfile-path">{descriptor.newFilePath}</code>
                {card.change.newFile && <> <span className="card-newfile-size">{card.change.newFile.content.length.toLocaleString('en-GB')} characters</span></>}
              </summary>
              {card.change.newFile && <pre className="card-newfile-source" tabIndex={0} aria-label={`Full source of ${descriptor.newFilePath}`}>{card.change.newFile.content}</pre>}
            </details>
          )}
          {props.unanchoredIds?.has(card.id) && !descriptor.stale && <div className="mg-c-flag" data-margin-flag="passage-changed"><b>Passage changed</b> · the words this was written on are no longer in the text. Decline it, or Reply to send it back to the agent.</div>}
          {descriptor.reader && props.reply && props.reply.draft?.id === card.id ? <ReplyArea descriptor={descriptor} change={card.change} reply={props.reply} /> : <CardActionsRow
            descriptor={descriptor}
            change={card.change}
            actions={props.actions}
            context={props.context}
            moreOpen={props.moreOpenId === card.id}
            onMoreToggle={() => props.onMoreOpen(props.moreOpenId === card.id ? null : card.id)}
            onDone={(id) => { props.onMoreOpen(null); handOff(id) }}
            markDone={markDone}
            holdFocus={stale && !(selected || focused)}
          />}
        </div>
      )}
    </article>
  )
}

const OUTCOME_ICONS = { Accepted: Check, Declined: CircleX, Done: CheckCheck, Applied: Check } as const

/**
 * A row settled during this visit (ticket 06, frame `many`): dim, one line, with its outcome. Reopen replaces
 * the outcome under the pointer and answers O with focus in the row; it puts the item back to waiting.
 */
function SettledRowView({ row, descriptor, placement, props }: { row: MarginSettledRow; descriptor: SettledRowDescriptor; placement: Placement | null; props: MarginPanelProps }): JSX.Element {
  const focused = props.focusedId === row.id
  const style = placement ? { top: placement.top } : { top: 0, visibility: 'hidden' as const }
  const OutcomeIcon = OUTCOME_ICONS[descriptor.outcome]
  const reopen = (): void => { void runMarginAction('reopen', row.change, props.actions, props.context) }
  const label = `Reopen (${descriptor.primary[0]?.key ?? 'O'})`
  // The card this row replaces may have held focus; removing a focused node fires no blur, so the margin still names
  // it as focused. Take the focus over (O reopens at once) so leaving it later clears the focus as usual.
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const active = document.activeElement
    if (focused && ref.current && (active === null || active === document.body)) ref.current.focus({ preventScroll: true })
  }, [])
  return (
    <article
      ref={ref}
      className={`mg-card mg-settled-row k-${row.kind} is-line${placement?.fold === 'stack' ? ' in-stack' : ''}${focused ? ' is-focus' : ''}`}
      style={style}
      data-margin-settled-row={row.id}
      data-outcome={descriptor.outcome.toLowerCase()}
      tabIndex={0}
      aria-label={`${descriptor.marker}: ${descriptor.name}, ${descriptor.outcome}`}
      onFocus={() => props.onFocusCard?.(row.id)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onFocusCard?.(null) }}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return
        if (event.target === event.currentTarget && cardKeyAction(event.key, descriptor) === 'reopen') { event.preventDefault(); reopen() }
        else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && event.target === event.currentTarget) stepFocus(event)
      }}
    >
      <div className="mg-fold-line mg-settled-line">
        <ChevronRight className="icon" aria-hidden="true" />
        <span className="mg-num">{descriptor.marker}</span>
        <b>{descriptor.name}</b>
        <KindIcon kind={descriptor.kindLabel} />
        <span className="mg-fl-sum">{descriptor.words}</span>
        <span className={`mg-st outcome o-${descriptor.outcome.toLowerCase()}`} data-margin-outcome><OutcomeIcon className="icon" aria-hidden="true" />{descriptor.outcome}</span>
        <span className="mg-quick" data-margin-quick>
          <button type="button" tabIndex={-1} title={label} aria-label={label} data-margin-quick-action="reopen" onClick={reopen}><RotateCcw className="icon" aria-hidden="true" /></button>
        </span>
      </div>
    </article>
  )
}

/**
 * A settled item in Settled today (ticket 08, frame `settled`): the card beside its words with its outcome. Focused:
 * Return to review (accepted) or Reopen (declined), O, which is the existing reopen action; More holds Show in text
 * and Send original to Scratchpad. Hover shows Reopen in place of the time.
 */
function SettledModeCardView({ row, descriptor, placement, props }: { row: MarginSettledRow; descriptor: SettledModeCardDescriptor; placement: Placement | null; props: MarginPanelProps }): JSX.Element {
  const focused = props.focusedId === row.id
  const style = placement ? { top: placement.top } : { top: 0, visibility: 'hidden' as const }
  const OutcomeIcon = OUTCOME_ICONS[descriptor.outcome]
  const leader = placement !== null && placement.paragraph !== TOP_PARAGRAPH
  const run = (id: MarginActionId): void => { props.onMoreOpen(null); void runMarginAction(id, row.change, props.actions, props.context) }
  const reopen = descriptor.primary[0]
  const moreOpen = props.moreOpenId === row.id
  return (
    <article
      className={`mg-card mg-settled-card k-${row.kind}${focused ? ' is-focus' : ''}`}
      style={style}
      data-margin-settled-card={row.id}
      data-margin-open=""
      data-outcome={descriptor.outcome.toLowerCase()}
      tabIndex={0}
      aria-label={`${descriptor.marker}: ${descriptor.name}, ${descriptor.outcome}`}
      onMouseEnter={() => props.onHover(row.id)}
      onMouseLeave={() => props.onHover(null)}
      onFocus={() => props.onFocusCard?.(row.id)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onFocusCard?.(null) }}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey || event.target !== event.currentTarget) return
        const action = cardKeyAction(event.key, descriptor)
        if (action) { event.preventDefault(); run(action) }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') stepFocus(event)
      }}
    >
      {leader && <Leader placement={placement} />}
      <div className="mg-card-full">
        <div className="mg-c-head">
          <span className="mg-num">{descriptor.marker}</span>
          <SourceIcon type={row.source.type} />
          <span className="mg-who">{descriptor.name}</span>
          <span className="mg-kind">{descriptor.kindLabel === 'Quiet fix' ? <Pencil className="icon" aria-hidden="true" /> : <KindIcon kind={descriptor.kindLabel} />}{row.source.type === 'you' && descriptor.kindLabel !== 'Quiet fix' ? 'Recorded edit' : descriptor.kindLabel}</span>
          <span className="mg-when" data-margin-when>{descriptor.time}</span>
          <span className="mg-quick" data-margin-quick>
            <button type="button" tabIndex={-1} title={`${reopen.label} (O)`} aria-label={`${reopen.label} (O)`} data-margin-quick-action="reopen" onClick={() => run('reopen')}><RotateCcw className="icon" aria-hidden="true" /></button>
          </span>
        </div>
        <div className="mg-c-status">
          <span className={`mg-st outcome o-${descriptor.outcome.toLowerCase()}`} data-margin-outcome><OutcomeIcon className="icon" aria-hidden="true" />{descriptor.outcome}</span>
        </div>
        {descriptor.segments.length > 0 && <div className="mg-c-change clamp" data-margin-change><DiffView segments={descriptor.segments} /></div>}
        {descriptor.body !== null && <p className="mg-c-note clamp" data-margin-note-text>{descriptor.body}</p>}
        <p className="mg-role-line" data-margin-role>{descriptor.roleLine}</p>
        <div className="mg-actions" data-margin-actions>
          <button type="button" className="mg-btn" data-margin-action="reopen" onClick={() => run('reopen')}><RotateCcw className="icon" aria-hidden="true" />{reopen.label}<kbd>{reopen.key}</kbd></button>
          <span className="mg-more-wrap">
            <button type="button" className="mg-btn icon-only" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={moreOpen} data-margin-action="more" onClick={() => props.onMoreOpen(moreOpen ? null : row.id)}>
              <MoreHorizontal className="icon" aria-hidden="true" />
            </button>
            {moreOpen && (
              <div className="mg-menu" role="menu">
                {descriptor.more.map((item) => (
                  <button key={item.id} type="button" role="menuitem" data-margin-action={item.id} onClick={() => run(item.id)}><span>{item.label}</span>{item.key && <kbd>{item.key}</kbd>}</button>
                ))}
              </div>
            )}
          </span>
        </div>
      </div>
    </article>
  )
}

/** Where everything sits: the margin's layout, or the cards under their paragraphs. */
function placementsOf(props: MarginPanelProps): Map<string, Placement> {
  if (props.view === 'under') {
    return new Map((props.underLayout?.placements ?? []).map((p) => [p.id, { id: p.id, paragraph: p.paragraph, top: p.top, height: p.height, fold: p.fold, anchorTop: p.top, hidden: false } satisfies Placement]))
  }
  return new Map((props.layout?.placements ?? []).map((p) => [p.id, p]))
}

/** The margin drawn from the model and a layout. No editor, no ledger: everything it does goes through its props. */
export function ReviewMarginPanel(props: MarginPanelProps): JSX.Element {
  const { model, layout } = props
  const now = props.now ?? Date.now()
  const placements = placementsOf(props)
  // Cards at their words, then the ones that could not be placed (at their paragraph, or at the top of the margin), then the settled rows.
  const items: MarginItem[] = [...model.cards, ...model.unplaced]
  const markerOf = (id: string, fallback: number): number => model.markers?.get(id) ?? fallback
  const descriptors = items.map((card, index) => describeMarginCard(card, markerOf(card.id, index + 1), now, props.document, { refused: props.refused?.get(card.id) ?? null }))
  const rows = (model.settled ?? []).map((row, index) => ({ row, descriptor: describeSettledRow(row, markerOf(row.id, items.length + index + 1)) }))
  // Settled today (ticket 08): the settled items are full cards, unless the crowding rule folds them to rows.
  const settledMode = model.mode === 'settled'
  const groups = props.view === 'under' ? props.underLayout?.groups ?? [] : layout?.groups ?? []
  return (
    <div className={`wf-margin ${props.view}`} data-margin-view={props.view} data-margin-count={model.cards.length}>
      <MarginTop model={model} controls={props.controls} outside={props.outside} />
      {(props.view === 'margin' || props.underLayout) && (
        <div className="mg-cards" data-margin-under-cards={props.view === 'under' ? '' : undefined}>
          {groups.map((group) => group.fold === 'stack' || (group.fold === 'line' && group.count > 1) ? (
            <div key={`g-${group.paragraph}`} className={`mg-stack-head${group.fold === 'line' ? ' as-line' : ''}`} style={{ top: group.top }} data-margin-stack>
              <Layers className="icon" aria-hidden="true" />
              {group.count} items on this paragraph
              <span className="mg-hint">{group.fold === 'line' ? 'Open to read' : 'Open one to read it'}</span>
              {group.fold === 'line' && layout && (
                <button type="button" className="mg-stack-open" aria-label="Open the cards on this paragraph" onClick={() => {
                  for (const p of layout.placements) if (p.paragraph === group.paragraph) props.onOpen(p.id)
                }} />
              )}
            </div>
          ) : null)}
          {items.map((card, index) => {
            const placement = placements.get(card.id) ?? null
            if (placement?.hidden || (props.view === 'under' && !placement)) return null
            return <MarginCardView key={card.id} card={card} descriptor={descriptors[index]} placement={placement} props={props} />
          })}
          {rows.map(({ row, descriptor }) => {
            const placement = placements.get(row.id) ?? null
            if (placement?.hidden || !placement) return null
            const folded = placement.fold === 'stack' || placement.fold === 'line' || placement.fold === 'thread-line' || props.foldedIds.has(row.id)
            if (settledMode && !folded) return <SettledModeCardView key={row.id} row={row} descriptor={describeSettledModeCard(row, descriptor.marker, now)} placement={placement} props={props} />
            return <SettledRowView key={row.id} row={row} descriptor={descriptor} placement={placement} props={props} />
          })}
        </div>
      )}
    </div>
  )
}

/** What the commands (⇧⌘C, ⇧⌥⌘V) do with the margin, reached through a ref. The bulk commands (⇧⌘A, ⇧⌘⌫, ⇧⌘R) are the app's since ticket 04. */
export type MarginControl = {
  focusHead: () => void
  /** Put DOM focus in the card (or settled card) for this item, so single letters act at once. False when it is not drawn. */
  focusCard: (id: string) => boolean
  /** ⇧⌘C: focus the first shown item; the first button at the top of the margin when none is shown. */
  focusFirst: () => void
  /** Margin to Under the passage, and back. */
  switchView: () => void
  /** Choose Margin or Under the passage (the count menu). */
  setView: (view: MarginView) => void
}

type BulkActions = Pick<ReviewActions, 'reopenChange'> & {
  /** Accept the picked cards, else the shown ones of `kind` (the app's `runTargets`; Accept all does not ask). */
  accept: (kind?: 'edit' | 'note') => void
  /** Decline the picked, else the shown edits: asks first, in the status bar. */
  decline: () => void
  /** Open (or close) Send back to the agent, in the status bar. */
  sendBack: (open: boolean) => void
  sendBackOpen: boolean
}

export type ReviewMarginProps = {
  changes: Change[]
  bulk: BulkActions
  /** The commands reach the margin through this. Set while the margin is mounted. */
  controlRef?: { current: MarginControl | null }
  chords?: HeadControls['chords']
  selectedId: string | null
  actions: CardActions
  context: MarginActionContext
  onSelect: (id: string) => void
  onMove: (direction: -1 | 1) => void
  /** Identifies the open document, so a switch of file measures again. */
  documentKey: string | null
  /** Outside-change rows (ticket 04) and the data the model needs for them. */
  outside?: MarginOutside
  /** Changes waiting in other documents, for "N waiting in M other pieces". */
  others?: Change[]
  /** "Could not be placed" records the writer dismissed. */
  dismissedIds?: ReadonlySet<string>
  /** Agent changes whose passage drifted out of the text. */
  unanchoredIds?: ReadonlySet<string>
  /** More > Accept session: accept every pending edit of the writer's in this piece. */
  onAcceptSession?: () => void
  /** The filter state, owned by the app so the status bar's All / Comments / Edits drives it too. Omitted: the margin keeps its own. */
  headFilter?: HeadFilterState
  onHeadFilter?: (next: HeadFilterState) => void
  /** The cards picked for a bulk action, owned by the app so the status bar's "N selected" acts on them. Omitted: the margin keeps its own. */
  picked?: ReadonlySet<string>
  onPicked?: (next: ReadonlySet<string>) => void
  /** The agent's items sent back with a note: marked Sent back on their cards. */
  sentBackIds?: ReadonlySet<string>
  /** Accepts main refused because the change could not be placed (ticket 06, from 14): the card says Could not be applied, with why. */
  refusedAccepts?: ReadonlyMap<string, string>
  /** Settled today (ticket 08): items reopened while the mode is on, drawn as Open cards (the app's `trackWaitingAgain`). */
  waitingAgain?: ReadonlySet<string>
}

type Bound = ReviewMarginProps & {
  view: EditorView
  /** Registers a listener for the editor's view updates; returns the unsubscribe. */
  subscribe: (listener: (update: ViewUpdate) => void) => () => void
}

const EMPTY_IDS: ReadonlySet<string> = new Set()

export { VIEW_KEY, readPreferredView } from '../app/margin-view-store'

/** Where the space under a paragraph starts: the bottom of its last line, in scroller coordinates. */
function underTopOf(view: EditorView, end: number): number {
  const scroller = view.scrollDOM
  const rect = scroller.getBoundingClientRect()
  const block = view.lineBlockAt(Math.min(end, view.state.doc.length))
  // A line followed by a block widget (the room we make here) is reported as one block holding both; the space starts under the text line.
  const text = Array.isArray(block.type) ? block.type.find((part) => part.type === BlockType.Text) : null
  const bottom = text ? text.bottom : block.bottom
  return Math.round(bottom + view.documentTop - rect.top + scroller.scrollTop)
}

function anchorTopOf(view: EditorView, pos: number): number {
  const scroller = view.scrollDOM
  const rect = scroller.getBoundingClientRect()
  const clamped = Math.min(pos, view.state.doc.length)
  const coords = view.coordsAtPos(clamped)
  const y = coords ? coords.top : view.lineBlockAt(clamped).top + view.documentTop
  return Math.round(y - rect.top + scroller.scrollTop)
}

/** What stays put when the view changes: the selected card's passage if it is on screen, else the top line, and its offset from the top of the viewport. */
function keepAnchorOf(view: EditorView, selectedFrom: number | null): { pos: number; offset: number } {
  const scroller = view.scrollDOM
  const rect = scroller.getBoundingClientRect()
  const offsetOf = (pos: number): number => view.lineBlockAt(pos).top + view.documentTop - rect.top
  if (selectedFrom !== null) {
    const pos = Math.min(selectedFrom, view.state.doc.length)
    const offset = offsetOf(pos)
    if (offset >= 0 && offset <= scroller.clientHeight) return { pos, offset }
  }
  const pos = view.lineBlockAtHeight(scroller.scrollTop).from
  return { pos, offset: offsetOf(pos) }
}

// The e2e check for ticket 16 reads the counters here; nothing in the app does.
if (typeof window !== 'undefined') (window as unknown as { __wfMarginPerf?: typeof marginPerf }).__wfMarginPerf = marginPerf

/**
 * The margin bound to the live editor: measures where each passage is, lays the cards out level with
 * it (margin-layout.ts), and keeps them aligned as the text moves. It mounts inside CodeMirror's scroller,
 * so it scrolls with the text.
 */
export function ReviewMargin({ view, subscribe, changes, bulk, controlRef, chords, selectedId, actions, context, onSelect, onMove, documentKey, outside, others, dismissedIds, unanchoredIds, onAcceptSession, headFilter: headFilterProp, onHeadFilter, picked: pickedProp, onPicked, sentBackIds, refusedAccepts, waitingAgain }: Bound): JSX.Element {
  const preferred = usePreferredView()
  // The room the editor pane leaves for the text beside the margin (panes open now, window size): decides Margin or Inline.
  const [textRoom, setRoom] = useState<number | null>(() => { const width = view.scrollDOM.getBoundingClientRect().width; return width > 0 ? textRoomBesideMargin(width) : null })
  const [revision, setRevision] = useState(0)
  // Bumped only when an editor update can have moved a passage (ticket 16); the measuring pass waits for it.
  const [geometryTick, setGeometryTick] = useState(0)
  const [foldedIds, setFolded] = useState<ReadonlySet<string>>(new Set())
  const [openIds, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [moreOpenId, setMoreOpenId] = useState<string | null>(null)
  const [measured, setMeasured] = useState<{ anchors: Map<string, number>; heights: Map<string, number>; floor: number }>({ anchors: new Map(), heights: new Map(), floor: 0 })
  const [typingTick, setTypingTick] = useState(0)
  // The filter is the app's when it passes it (the status bar's segment drives the same state); else this margin's own.
  const [ownHeadFilter, setOwnHeadFilter] = useState<HeadFilterState>(EMPTY_HEAD_FILTER)
  const headFilter = headFilterProp ?? ownHeadFilter
  const setHeadFilter = onHeadFilter ?? setOwnHeadFilter
  const [ownPicked, setOwnPicked] = useState<ReadonlySet<string>>(new Set())
  const picked = pickedProp ?? ownPicked
  const pickedRef = useRef(picked)
  pickedRef.current = picked
  const setPicked = useCallback((next: ReadonlySet<string> | ((current: ReadonlySet<string>) => ReadonlySet<string>)) => {
    const value = typeof next === 'function' ? next(pickedRef.current) : next
    if (onPicked) onPicked(value)
    else setOwnPicked(value)
  }, [onPicked])
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [unreadIds, setUnreadIds] = useState<ReadonlySet<string>>(new Set())
  const knownRef = useRef<{ key: string | null; ids: Set<string> }>({ key: null, ids: new Set() })
  // The reply box on a reader's card (0.24 ticket 08): one open at a time.
  const [replyDraft, setReplyDraft] = useState<{ id: string; text: string } | null>(null)
  const [replySending, setReplySending] = useState(false)
  const [replyError, setReplyError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const layoutRef = useRef<MarginLayout | null>(null)
  const heightsRef = useRef(new Map<string, number>())
  const typingRef = useRef<TypingState>({ lastEditAt: null, editParagraph: null, caretParagraph: null })
  const frameRef = useRef<number | null>(null)
  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const underRef = useRef<UnderLayout | null>(null)
  const toggleViewRef = useRef<() => void>(() => undefined)
  const setViewRef = useRef<(view: MarginView) => void>(() => undefined)
  const keepRef = useRef<{ pos: number; offset: number } | null>(null)

  const effective = effectiveMarginView(preferred, textRoom)
  useEffect(() => { setTextRoom(textRoom) }, [textRoom])
  useEffect(() => () => setTextRoom(null), [])
  const lastEffectiveRef = useRef(effective)
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  // The text is read from the editor only when its document changed (ticket 16), never for a selection or geometry update.
  const textRef = useRef<{ doc: unknown; text: string } | null>(null)
  const document = useMemo(() => {
    const doc = view.state.doc
    if (textRef.current?.doc === doc) return textRef.current.text
    marginPerf.textReads += 1
    const text = doc.toString()
    textRef.current = { doc, text }
    return text
  }, [view, revision, documentKey])
  const resolver = useMemo(() => makeAnchorResolver(document), [document])
  // Items settled during this visit (ticket 06): dim rows until the piece is next opened. Opening a piece starts afresh.
  const [visit, setVisit] = useState<{ key: string | null; seen: ReadonlySet<string>; settled: ReadonlySet<string> }>({ key: documentKey, seen: new Set(), settled: new Set() })
  const settledHere = visit.key === documentKey ? visit.settled : EMPTY_IDS
  const mode = reviewModeOf(headFilter)
  // One build gives the model the writer's filters ask for and, from the same resolved anchors, the facts judged before
  // any filter (what is waiting, so a filter that hides every card cannot take the margin away).
  const { model, unfiltered } = useMemo(
    () => buildMarginModels({ changes, document, view: effective, selectedId, filter: headFilter.filter, showOwnEdits: headFilter.showOwnEdits, showQuietFixes: headFilter.showQuiet, others, dismissedIds, settledHere, mode, waitingAgain, resolver }),
    [changes, document, resolver, effective, selectedId, headFilter, others, dismissedIds, settledHere, mode, waitingAgain],
  )
  // A mode (Settled today, My edits) draws the margin even with nothing waiting.
  const visible = marginVisible({ ...unfiltered, mode }, outside)
  useEffect(() => {
    const waiting = [...unfiltered.cards, ...unfiltered.unplaced].map((item) => item.id)
    setVisit((current) => {
      const base = current.key === documentKey ? current : { key: documentKey, seen: EMPTY_IDS, settled: EMPTY_IDS }
      const next = trackSettledHere(base, waiting, changes)
      return next.seen === base.seen && next.settled === base.settled && base === current ? current : { key: documentKey, ...next }
    })
  }, [unfiltered, changes, documentKey])

  // A card that arrives after the piece was opened wears a dot until it is focused once. What was there when the piece opened is read.
  useEffect(() => {
    const known = knownRef.current
    // Your own recorded edits are never new to you: My edits (ticket 08) draws them without a dot.
    const ids = unfiltered.cards.filter((card) => card.source.type !== 'you').map((card) => card.id)
    if (known.key !== documentKey) {
      knownRef.current = { key: documentKey, ids: new Set(ids) }
      setUnreadIds((current) => (current.size === 0 ? current : new Set()))
      return
    }
    const fresh = ids.filter((id) => !known.ids.has(id))
    for (const id of fresh) known.ids.add(id)
    setUnreadIds((current) => {
      const next = new Set([...current, ...fresh].filter((id) => ids.includes(id) && id !== selectedRef.current && id !== focusedId))
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next
    })
  }, [unfiltered, documentKey, focusedId])
  useEffect(() => {
    const seen = focusedId ?? selectedId
    if (seen) setUnreadIds((current) => { if (!current.has(seen)) return current; const next = new Set(current); next.delete(seen); return next })
  }, [focusedId, selectedId])

  // A card that is settled or hidden by the filter drops out of the selection (the app prunes its own).
  useEffect(() => {
    if (pickedProp) return
    const kept = visibleSelection(model, picked)
    if (kept.length !== picked.size) setPicked(new Set(kept))
  }, [model, picked, pickedProp, setPicked])
  const pick = useCallback((id: string) => setPicked((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next }), [setPicked])
  const clearPicked = useCallback(() => setPicked(new Set()), [setPicked])

  useEffect(() => {
    if (!controlRef) return
    const control: MarginControl = {
      switchView: () => toggleViewRef.current(),
      setView: (next) => setViewRef.current(next),
      focusCard: (id) => {
        const target = rootRef.current?.querySelector<HTMLElement>(`[data-margin-card="${CSS.escape(id)}"], [data-margin-settled-card="${CSS.escape(id)}"], [data-margin-settled-row="${CSS.escape(id)}"]`)
        if (!target) return false
        target.focus({ preventScroll: false })
        return true
      },
      focusFirst: () => {
        const root = rootRef.current
        const first = [...(root?.querySelectorAll<HTMLElement>(STEP_SELECTOR) ?? [])].sort((a, b) => a.offsetTop - b.offsetTop)[0]
        const target = first ?? root?.querySelector<HTMLElement>('[data-margin-top] button')
        target?.focus()
      },
      focusHead: () => {
        const root = rootRef.current
        const target = root?.querySelector<HTMLElement>('[data-margin-top] button')
        target?.focus()
      },
    }
    controlRef.current = control
    return () => { if (controlRef.current === control) controlRef.current = null }
  }, [controlRef])
  const controls: HeadControls = {
    state: headFilter,
    onState: setHeadFilter,
    picked,
    onClearPicked: clearPicked,
    onAccept: bulk.accept,
    onDecline: bulk.decline,
    sendBackOpen: bulk.sendBackOpen,
    onSendBackOpen: bulk.sendBack,
    onReopen: bulk.reopenChange,
    onAcceptSession,
    onSendOriginal: (change) => { void context.sendOriginalToScratchpad(change) },
    chords,
  }

  // `moved`: a passage may have moved, so the cards are measured again. A character typed where no passage is changes
  // the text (the model is rebuilt once per frame) but not the geometry.
  const movedRef = useRef(false)
  const entryPositionsRef = useRef<number[]>([])
  const viewportRef = useRef<SeenViewport | null>(null)
  const bump = useCallback((moved = true) => {
    if (moved) movedRef.current = true
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      setRevision((n) => n + 1)
      if (movedRef.current) { movedRef.current = false; setGeometryTick((n) => n + 1) }
    })
  }, [])

  // The cards sit below the top strip's live height. Opening "could not be placed" or "other pieces" changes that height
  // inside a child row, which does not re-render this component, so watch the strip and re-measure when it changes.
  useEffect(() => {
    const head = rootRef.current?.querySelector<HTMLElement>('[data-margin-top]')
    if (!head) return
    let last = head.offsetHeight
    const observer = new ResizeObserver(() => {
      if (head.offsetHeight === last) return
      last = head.offsetHeight
      bump()
    })
    observer.observe(head)
    return () => observer.disconnect()
  }, [bump, effective, visible])

  // The editor's updates: re-measure on any change of text or geometry, and note the writer's typing.
  useEffect(() => {
    const off = subscribe((update) => {
      if (update.docChanged) {
        const typed = update.transactions.some((tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'))
        if (typed) {
          const key = paragraphKeyAt(update.state.doc, update.state.selection.main.head)
          typingRef.current = { lastEditAt: Date.now(), editParagraph: key, caretParagraph: key }
          if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
          pauseTimerRef.current = setTimeout(() => setTypingTick((n) => n + 1), 2100)
        }
      } else if (update.selectionSet && typingRef.current.lastEditAt !== null) {
        const wasTyping = isWriterTyping(typingRef.current, Date.now())
        typingRef.current = { ...typingRef.current, caretParagraph: paragraphKeyAt(update.state.doc, update.state.selection.main.head) }
        if (wasTyping && !isWriterTyping(typingRef.current, Date.now())) setTypingTick((n) => n + 1)
      }
      // CodeMirror reports viewportChanged (and so geometryChanged) on every edit, because the viewport's offsets shift with
      // the text. Only a viewport that is not where the edit puts the old one means other lines are drawn.
      const port = update.view.viewport
      const was = viewportRef.current
      viewportRef.current = { from: port.from, to: port.to, doc: update.state.doc }
      const viewportMoved = viewportMovedSince(was, update, port)
      if (update.docChanged || update.geometryChanged || update.viewportChanged) bump(updateMovesCards({ docChanged: update.docChanged, heightChanged: update.heightChanged, viewportMoved, changes: update.changes, startState: update.startState, state: update.state }, entryPositionsRef.current))
    })
    // The scroller's own width changes when the window resizes or a side pane opens or closes; the margin's padding
    // does not change it, so the room never depends on the view it decides.
    const measureRoom = (): void => { const width = view.scrollDOM.getBoundingClientRect().width; if (width > 0) setRoom(textRoomBesideMargin(width)) }
    const observer = new ResizeObserver(() => { measureRoom(); bump() })
    const onResize = (): void => measureRoom()
    window.addEventListener('resize', onResize)
    observer.observe(view.scrollDOM)
    observer.observe(view.contentDOM)
    return () => {
      off()
      window.removeEventListener('resize', onResize)
      observer.disconnect()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current)
    }
  }, [view, subscribe, bump])

  // The scroller makes room: the text column moves left of the margin; under the passage, room for the strip above the text.
  // Changing view (the switch, the narrow window, or back) keeps the selected passage, or the top line, where it was on screen.
  useLayoutEffect(() => {
    if (lastEffectiveRef.current === effective) return
    lastEffectiveRef.current = effective
    keepRef.current = keepAnchorOf(view, model.cards.find((c) => c.id === selectedId)?.anchor.from ?? null)
  }, [effective, view, model.cards, selectedId])
  useEffect(() => {
    const keep = keepRef.current
    if (!keep) return
    keepRef.current = null
    const restore = (): void => {
      const scroller = view.scrollDOM
      const now = view.lineBlockAt(Math.min(keep.pos, view.state.doc.length)).top + view.documentTop - scroller.getBoundingClientRect().top
      if (Math.abs(now - keep.offset) > 1) scroller.scrollTop += now - keep.offset
      // The selected card comes into view too, without losing its passage (the card is under or beside it).
      const card = selectedRef.current ? rootRef.current?.querySelector<HTMLElement>(`[data-margin-card="${CSS.escape(selectedRef.current)}"]`) : null
      if (card) {
        const box = card.getBoundingClientRect()
        const area = scroller.getBoundingClientRect()
        if (box.bottom > area.bottom - 8) scroller.scrollTop += Math.min(box.bottom - area.bottom + 24, Math.max(0, box.top - area.top - 40))
        else if (box.top < area.top + 8) scroller.scrollTop -= area.top - box.top + 24
      }
    }
    const timers = [0, 60, 200, 500].map((ms) => setTimeout(restore, ms))
    return () => timers.forEach(clearTimeout)
  }, [effective, view])
  useEffect(() => {
    if (!visible) return
    const scroller = view.scrollDOM
    scroller.style.setProperty('--margin-w', `${MARGIN_WIDTH}px`)
    scroller.classList.add(effective === 'margin' ? 'wf-margin-side' : 'wf-margin-under')
    return () => {
      scroller.classList.remove('wf-margin-side', 'wf-margin-under')
      scroller.style.removeProperty('--margin-w')
      scroller.style.removeProperty('--margin-head-h')
    }
  }, [view, effective, visible])

  const typing = isWriterTyping(typingRef.current, Date.now())
  void typingTick
  // A card drawn open stays open while the writer is on it (selected, or holding keyboard focus): focus makes a card
  // taller, and in a tight piece the crowding pass would otherwise fold it into its paragraph's line under the writer's
  // hands, taking the focus with it. A folded row that takes focus stays a row until it is opened.
  //
  // The crowding rule (ticket 06, settling ticket 13's note): the selected item (a step, a click) always opens in place,
  // inside its paragraph's stack, so stepping through a crowded paragraph opens one row at a time and the crowding pass
  // never folds the item the writer is on. Keyboard focus alone (Tab passing through a stack) opens nothing: a row that
  // takes focus stays a row until it is opened (click, ↵) or selected.
  const laidOpen = useMemo(() => {
    const drawnOpen = (id: string): boolean => {
      const placed = (effective === 'under' ? underRef.current?.placements : layoutRef.current?.placements)?.find((p) => p.id === id)
      return placed?.fold === 'open'
    }
    const on = [selectedId, focusedId !== selectedId && focusedId !== null && drawnOpen(focusedId) ? focusedId : null].filter((id): id is string => id !== null && !openIds.has(id))
    return on.length === 0 ? openIds : new Set([...openIds, ...on])
  }, [openIds, selectedId, focusedId, effective])
  // Everything the margin draws: cards at their words, settled rows, and what could not be placed (ticket 06).
  // Under the passage an item with no known paragraph sits under the first one.
  const entries = useMemo<MarginEntry[]>(() => {
    const all = marginEntriesOf(model)
    return effective === 'under' ? all.map((entry) => (entry.pos === null ? { ...entry, pos: 0 } : entry)).sort((a, b) => a.pos! - b.pos!) : all
  }, [model, effective])
  entryPositionsRef.current = entries.flatMap((entry) => (entry.pos === null ? [] : [entry.pos]))
  // The cards and their order, without where in the text they stand: what the measuring pass depends on.
  const entriesKey = useMemo(() => entries.map((entry) => `${entry.id}${entry.row ? '#' : ''}`).join('|'), [entries])
  // What the drawn cards say, without where the app thinks their words stand: a list that comes back the same but for
  // re-found anchors (after a save), or with a record of your own typing added that no card draws, asks for no measuring pass.
  const changesLook = useMemo(() => {
    const drawn = new Set(entries.map((entry) => entry.id))
    return JSON.stringify(changes.filter((change) => drawn.has(change.id)), (key, value) => (key === 'anchor' ? undefined : value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changes, entriesKey])
  const layout = useMemo(() => {
    if (effective !== 'margin' || entries.length === 0) return null
    const cards = layoutEntriesFor(entries, document, { anchorTops: measured.anchors, heights: measured.heights, floor: measured.floor, foldedIds })
    if (cards.length === 0) return null
    return layoutMargin({ cards, openIds: laidOpen, typing, previous: layoutRef.current })
  }, [effective, entries, document, measured, foldedIds, laidOpen, typing])
  layoutRef.current = layout
  const underLayout = useMemo(() => {
    if (effective !== 'under' || entries.length === 0) return null
    const cards = layoutEntriesFor(entries, document, { anchorTops: measured.anchors, heights: measured.heights, floor: 0, foldedIds })
    if (cards.length === 0) return null
    return layoutUnder({ cards, openIds: laidOpen, typing, previous: underRef.current })
  }, [effective, entries, document, measured, foldedIds, laidOpen, typing])
  underRef.current = underLayout

  // Room under each paragraph for its cards: a block widget in the text flow, as tall as the cards over it.
  // While the writer types nothing is re-sent unless a card's height changed, so the text only moves by whole lines.
  useEffect(() => {
    const wanted: UnderSpacer[] = []
    if (underLayout) {
      const firstOf = new Map<string | number, number>()
      for (const entry of entries) {
        if (entry.pos === null) continue
        const key = paragraphKey(document, entry.pos)
        if (!firstOf.has(key)) firstOf.set(key, paragraphEnd(document, entry.pos))
      }
      for (const group of underLayout.groups) {
        const pos = firstOf.get(group.paragraph)
        if (pos !== undefined) wanted.push({ pos: Math.min(pos, view.state.doc.length), height: Math.max(0, Math.round(group.bottom - group.top)) + UNDER_SPACER_GAP })
      }
    }
    const current = view.state.field(underSpacerField, false) ?? []
    const sameHeights = current.length === wanted.length && current.every((c, i) => c.height === wanted[i].height)
    if (typing ? sameHeights : sameSpacers(current, wanted)) return
    view.dispatch({ effects: setUnderSpacers.of(wanted) })
  }, [underLayout, entries, document, view, typing])
  useEffect(() => () => { if ((view.state.field(underSpacerField, false) ?? []).length > 0) view.dispatch({ effects: setUnderSpacers.of([]) }) }, [view])

  // Measure when the cards, their order, what they show or the editor's geometry changed (ticket 16): where each passage
  // is and how tall each open card is. Equal measurements stop the loop. A keystroke that moves no passage measures nothing.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    marginPerf.measures += 1
    // Room above the text for the strip first, so the passages are measured where they will be.
    if (effective === 'under') { const strip = root.querySelector<HTMLElement>('[data-margin-top]'); view.scrollDOM.style.setProperty('--margin-head-h', `${strip ? strip.offsetHeight : 0}px`) }
    const anchors = new Map<string, number>()
    for (const entry of entries) {
      if (entry.pos === null) continue
      anchors.set(entry.id, effective === 'under' ? underTopOf(view, paragraphEnd(document, entry.pos)) : anchorTopOf(view, entry.pos))
    }
    for (const el of root.querySelectorAll<HTMLElement>('[data-margin-open]')) {
      const id = el.dataset.marginCard ?? el.dataset.marginSettledCard
      if (id) heightsRef.current.set(id, el.offsetHeight)
    }
    const head = root.querySelector<HTMLElement>('[data-margin-top]')
    const floor = effective === 'under' ? 0 : head ? head.offsetTop + head.offsetHeight + 12 : 0
    const heights = new Map(heightsRef.current)
    const same = (a: Map<string, number>, b: Map<string, number>): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
    if (!same(anchors, measured.anchors) || !same(heights, measured.heights) || floor !== measured.floor) setMeasured({ anchors, heights, floor })
    // `document` and `entries` are read here but stand for what `entriesKey` and `geometryTick` already say. `outside` and
    // `others` only change the top strip, whose own resize observer asks for a pass when its height changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, effective, visible, entriesKey, geometryTick, measured, textRoom, changesLook, selectedId, focusedId, laidOpen, foldedIds, openIds, moreOpenId, unreadIds, picked, headFilter, dismissedIds, unanchoredIds, sentBackIds, refusedAccepts, waitingAgain, documentKey, replyDraft, replySending, replyError, settledHere])

  // The quiet marks in the text (ticket 13): the shown cards' words, with their marker numbers. Cards the
  // filter hides are not in `model.cards`, so their words lose their marks; the selected or focused card's
  // words are outlined strongly. A quiet fix waiting with no card (Show quiet fixes off) keeps ADR-0016's
  // faint marker, unnumbered. Sent only when what is drawn would change.
  // Settled rows and items that could not be placed carry no mark: their words lost their highlight (ticket 06).
  const marks = useMemo(() => reviewMarksOf(model.cards, model.quietWaiting, model.markers), [model.cards, model.quietWaiting, model.markers])
  const markedIds = useMemo(() => new Set(marks.map((mark) => mark.id)), [marks])
  useEffect(() => {
    const next = { marks, selectedId, focusedIds: focusedId ? [focusedId] : [] }
    if (sameChangeMarks(changeMarksOf(view.state), next)) return
    view.dispatch({ effects: setChangeMarks.of(next) })
  }, [view, marks, selectedId, focusedId])
  useEffect(() => () => { if (changeMarksOf(view.state).marks.length > 0) view.dispatch({ effects: setChangeMarks.of({ marks: [], selectedId: null, focusedIds: [] }) }) }, [view])
  // The metadata panel marks the fields the shown waiting edits would change (metadata-proposals.ts).
  const proposals = useMemo(() => metadataProposalsOf(document, model.cards), [document, model.cards])
  useEffect(() => {
    if (sameMetadataProposals(view.state.field(metadataProposalsField, false) ?? [], proposals)) return
    view.dispatch({ effects: setMetadataProposals.of(proposals) })
  }, [view, proposals])
  useEffect(() => () => { if ((view.state.field(metadataProposalsField, false) ?? []).length > 0) view.dispatch({ effects: setMetadataProposals.of([]) }) }, [view])

  // Hover outlines the card's words in the text: a marked card through its mark (`is-linked`).
  // A card whose words wear no mark (your own edit, which Drafting does not draw and Reviewing draws as its own
  // struck/inserted marks) is outlined by the editor's own outline field, or on its Reviewing marks.
  const cardsRef = useRef(model.cards)
  cardsRef.current = model.cards
  const settledRef = useRef(model.settled)
  settledRef.current = model.settled
  // After Accept or Decline from a focused card: the next shown card (the one above when it was last), else the text.
  // Never the page body, which a removed card would leave focus on (ticket 09, from 13).
  const handOffFocus = useCallback((from: HTMLElement) => {
    if (!from.contains(window.document.activeElement)) return
    const cards = waitingCardsOf(rootRef.current)
    const at = cards.indexOf(from)
    const target = cards[at + 1] ?? cards[at - 1]
    if (target && target !== from) target.focus()
    else view.focus()
  }, [view])
  const markedRef = useRef(markedIds)
  markedRef.current = markedIds
  const onHover = useCallback((id: string | null) => {
    for (const el of view.contentDOM.querySelectorAll('.margin-hover')) el.classList.remove('margin-hover')
    const quiet = id !== null && markedRef.current.has(id)
    const effects = [setChangeMarkHover.of(quiet ? id : null)]
    let marked = quiet
    if (id && !quiet) for (const el of view.contentDOM.querySelectorAll(`[data-cid="${CSS.escape(id)}"]`)) { el.classList.add('margin-hover'); marked = true }
    // A settled card in Settled today outlines its words like a waiting one (it wears no mark in the text).
    const card = id && !marked ? cardsRef.current.find((c) => c.id === id) ?? settledRef.current.find((c) => c.id === id && c.anchor !== null) : null
    const range = card?.anchor && card.anchor.to > card.anchor.from ? { from: Math.min(card.anchor.from, view.state.doc.length), to: Math.min(card.anchor.to, view.state.doc.length) } : null
    view.dispatch({ effects: [...effects, setMarginOutline.of(range)] })
  }, [view])
  useEffect(() => () => onHover(null), [onHover])

  useEffect(() => {
    if (!moreOpenId) return
    const close = (event: MouseEvent): void => { if (!(event.target as HTMLElement).closest('.mg-more-wrap')) setMoreOpenId(null) }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMoreOpenId(null) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key) }
  }, [moreOpenId])

  // Reply on a reader's card opens the box in the card; the reply is kept and sent by main (changes:reader-reply).
  const marginContext = useMemo<MarginActionContext>(() => ({
    ...context,
    openReply: (id: string) => { setReplyError(null); setReplyDraft((current) => (current?.id === id ? current : { id, text: '' })) },
    // A settled row's Reopen (ticket 06) is the existing reopen action: the item waits again.
    reopen: context.reopen ?? ((id: string) => bulk.reopenChange(id)),
  }), [context, bulk])
  const replyControls = useMemo<ReplyControls>(() => ({
    draft: replyDraft,
    sending: replySending,
    error: replyError,
    onChange: (id, text) => setReplyDraft({ id, text }),
    onCancel: () => { setReplyDraft(null); setReplyError(null) },
    onSend: (change, text, markDone) => {
      const send = context.sendReaderReply
      if (!send) return
      setReplySending(true)
      setReplyError(null)
      void (async () => {
        try {
          await send(change.id, text)
          setReplyDraft(null)
          // Send and mark done: the reply is kept first, then Done (the note's accept, which writes nothing).
          if (markDone) await actions.acceptChange(change.id)
        } catch (error) {
          setReplyError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'The reply could not be kept. Try again.')
        } finally {
          setReplySending(false)
        }
      })()
    },
  }), [replyDraft, replySending, replyError, context, actions])

  const setView = useCallback((next: MarginView) => setPreferredView(next), [])
  const preferredRef = useRef(preferred)
  preferredRef.current = preferred
  setViewRef.current = setView
  toggleViewRef.current = () => setView(preferredRef.current === 'margin' ? 'under' : 'margin')

  return (
    <div ref={rootRef} className="wf-margin-root">
      {visible && <ReviewMarginPanel
        model={model}
        layout={layout}
        underLayout={underLayout}
        view={effective}
        preferredView={preferred}
        onViewChange={setView}
        selectedId={selectedId}
        foldedIds={foldedIds}
        onFold={(id) => { setFolded((s) => new Set(s).add(id)); setOpen((s) => { const n = new Set(s); n.delete(id); return n }) }}
        onOpen={(id) => {
          setFolded((s) => { const n = new Set(s); n.delete(id); return n })
          setOpen((s) => new Set(s).add(id))
        }}
        actions={actions}
        context={marginContext}
        reply={replyControls}
        onSelect={onSelect}
        onPick={pick}
        controls={controls}
        onHover={onHover}
        onMove={onMove}
        moreOpenId={moreOpenId}
        onMoreOpen={setMoreOpenId}
        focusedId={focusedId}
        onFocusCard={setFocusedId}
        onHandOff={handOffFocus}
        unreadIds={unreadIds}
        outside={outside}
        unanchoredIds={unanchoredIds}
        sentBackIds={sentBackIds}
        refused={refusedAccepts}
        document={document}
      />}
    </div>
  )
}
