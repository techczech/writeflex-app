import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { CalendarDays, ChevronDown, Languages, UserRound, UsersRound } from 'lucide-react'
import {
  FOLIO_DETAIL_LABEL,
  folioDetailDateLabel,
  normaliseFolioDetailValue,
  statusPickerLanes,
  type FolioDetailField,
  type FolioDetailValues,
  type FolioDetails,
  type FolioDetailsRead,
} from '../../../shared/folio-details'
import { DetailCalendarPicker, DetailListPicker, statusDot, type PickerSection } from './FolioDetailPickers'
import { FolioDetailsWriter, folioDetailUnchanged } from './folio-details-writer'
import { typingInDetails } from './folio-details-keys'

/**
 * The Folio outline's Details card (0.26, design frames b1 and c1 to c3): the Folio's title, standfirst, author, date,
 * status, audience and language, kept in the Index Note's header. Title and standfirst are typed; Author, Date,
 * Status, Audience and Language are picked (FolioDetailPickers.tsx): each opens with ↓, Space or Enter, works from the
 * keyboard, and writes through the same one change as a typed field.
 *
 * Every change is one write through main (`folioDetails.set`, over the Index Note text the card last saw) and one
 * Undo step. Changes are queued in order (folio-details-writer.ts): one made while another is being saved waits for
 * it and is never dropped; a picked value shows as saving on its field until it is written. A typed field commits on Enter or when it loses focus. When the Folio's open buffers can be saved
 * first (`write`, the running-order writer's own path), they are: a change never lands under unsaved typing in the
 * Index Note. ⌘Z in the card undoes the card's last change by its token, except while a field holds typing that is
 * not committed yet, or a picker's filter box has focus: then ⌘Z is the field's own text undo. Escape closes an open
 * picker, else drops uncommitted typing and leaves the card. A refusal is said in the card, in plain words.
 */

type TypedField = 'title' | 'standfirst'
type PickedField = Exclude<FolioDetailField, TypedField>
type Drafts = Record<TypedField, string | null>

export type FolioDetailsCardHandle = {
  /** Move focus to the card's first field (the D key). */
  focus: () => void
}

/** One request of a Folio write through the editor's save of the Folio's open buffers (app/folio-running-order.ts `write`). */
export type FolioWriteThrough = <T>(dir: string, call: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false; message: string }>

export type FolioDetailsCardProps = {
  dir: string
  /** Escape: focus goes back to the running order. */
  onLeave: () => void
  write?: FolioWriteThrough
  /** The app's status line: where a change is said not saved after the card has left its Folio. */
  onStatus?: (message: string) => void
}

const NO_DRAFTS: Drafts = { title: null, standfirst: null }
const PICK_PLACEHOLDER: Record<'author' | 'audience' | 'language' | 'status', string> = {
  author: 'Type a name, or pick one used here',
  audience: 'Type an audience, or pick one used here',
  language: 'Type a language, or pick one used here',
  status: 'Type a new lane',
}

/** A field's value as the card shows it ('' when neither file says it). */
const shownOf = (details: FolioDetails | null, field: FolioDetailField): string => details?.fields[field].value ?? ''

const isUndoKey = (event: ReactKeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z'

export const FolioDetailsCard = forwardRef<FolioDetailsCardHandle, FolioDetailsCardProps>(function FolioDetailsCard({ dir, onLeave, write, onStatus }, ref) {
  const [read, setRead] = useState<FolioDetailsRead | null>(null)
  const [drafts, setDrafts] = useState<Drafts>(NO_DRAFTS)
  const [message, setMessage] = useState<string | null>(null)
  const [open, setOpen] = useState<PickedField | null>(null)
  const [values, setValues] = useState<FolioDetailValues | null>(null)
  const [pending, setPending] = useState<ReadonlyMap<FolioDetailField, string | null>>(new Map())
  const draftsRef = useRef<Drafts>(NO_DRAFTS)
  const writeRef = useRef(write)
  writeRef.current = write
  const statusRef = useRef(onStatus)
  statusRef.current = onStatus
  const writerRef = useRef<FolioDetailsWriter | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const details = read?.ok ? read : null

  const setDraft = useCallback((field: TypedField, value: string | null) => {
    draftsRef.current = { ...draftsRef.current, [field]: value }
    setDrafts(draftsRef.current)
  }, [])

  // One writer per Folio: its changes, Undos and re-reads run in order. Leaving the Folio detaches it (what it had
  // queued still lands, in its own Folio) and starts the next one's.
  useEffect(() => {
    draftsRef.current = NO_DRAFTS
    setDrafts(NO_DRAFTS)
    setMessage(null)
    setOpen(null)
    setValues(null)
    setPending(new Map())
    const writer = new FolioDetailsWriter(
      dir,
      window.writeflex.folioDetails,
      (call) => (writeRef.current ? writeRef.current(dir, call) : call().then((value) => ({ ok: true as const, value }))),
      { read: setRead, message: setMessage, pending: setPending, elsewhere: (message) => statusRef.current?.(message) },
    )
    writerRef.current = writer
    void writer.reload()
    const off = window.writeflex.onCollectionChanged(() => { void writer.reload() })
    return () => { off(); writer.detach() }
  }, [dir])

  useImperativeHandle(ref, () => ({
    focus: () => {
      cardRef.current?.scrollIntoView({ block: 'nearest' })
      titleRef.current?.focus()
    },
  }), [])

  const focusField = useCallback((field: FolioDetailField) => {
    cardRef.current?.querySelector<HTMLElement>(`[data-folio-detail="${field}"]`)?.focus()
  }, [])

  /** Write `field` (null removes it), queued after any change still being saved. Resolves whether it was written. */
  const setField = useCallback((field: FolioDetailField, value: string | null): Promise<boolean> =>
    writerRef.current ? writerRef.current.set(field, value) : Promise.resolve(false), [])

  /** Write a typed field from its draft, if the draft says something else than the card shows (or a queued change leaves). */
  const commit = useCallback(async (field: TypedField) => {
    const draft = draftsRef.current[field]
    if (draft === null || !details) return
    const value = normaliseFolioDetailValue(draft)
    if (folioDetailUnchanged(value, writerRef.current?.queued(field), shownOf(details, field))) { setDraft(field, null); return }
    const done = await setField(field, value)
    // Only the typing that was sent is dropped: anything typed while the write was pending stays in the field.
    if (done && draftsRef.current[field] === draft) setDraft(field, null)
  }, [details, setDraft, setField])

  const choose = useCallback(async (field: PickedField, value: string | null) => {
    // The picker closes and its field shows the choice as saving (`pending`) until it is written; a refusal is said.
    setOpen(null)
    requestAnimationFrame(() => focusField(field))
    // Compared with the value a change still queued for the field will leave, so the last choice is the one written.
    const shown = details?.fields[field].from === 'index' ? shownOf(details, field) : null
    if (!folioDetailUnchanged(value, writerRef.current?.queued(field), shown)) await setField(field, value)
  }, [details, focusField, setField])

  const closePicker = useCallback((field: PickedField) => {
    setOpen(null)
    requestAnimationFrame(() => focusField(field))
  }, [focusField])

  const openPicker = useCallback((field: PickedField) => {
    if (!details) return
    setOpen(field)
    if (field === 'author' || field === 'audience' || field === 'language') {
      void window.writeflex.folioDetails.values().then((answer) => { if (answer.ok) setValues(answer) }).catch(() => undefined)
    }
  }, [details])

  const undo = useCallback(() => { void writerRef.current?.undo() }, [])

  // Edit ▸ Undo (a click: the key is the renderer's, see menu.ts) acts here only while focus is inside the card, and by
  // the same "typing in a field" check as the physical ⌘Z: a picker's filter box or uncommitted typing takes the
  // field's own text undo; anywhere else the app handles it.
  useEffect(() => window.writeflex.onMenuAction((action) => {
    if (action !== 'undo' || !cardRef.current?.contains(document.activeElement)) return
    if (typingInDetails(document.activeElement as HTMLElement | null, draftsRef.current)) document.execCommand('undo')
    else undo()
  }), [undo])

  const leave = useCallback(() => {
    // Uncommitted typing is dropped before focus moves, so the blur that follows writes nothing.
    draftsRef.current = NO_DRAFTS
    setDrafts(NO_DRAFTS)
    onLeave()
  }, [onLeave])

  const onCardKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isUndoKey(event)) {
      // Typing not committed yet, or a picker's filter box: the field's own text undo.
      if (typingInDetails(event.target as HTMLElement, draftsRef.current)) return
      event.preventDefault()
      event.stopPropagation()
      undo()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      leave()
    }
  }, [leave, undo])

  const fieldKeyDown = (field: TypedField) => (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void commit(field)
    }
  }

  if (read && !read.ok) {
    return (
      <section className="folio-details" aria-label="Folio details" data-folio-details="true">
        <div className="plan-bar"><h2>Details <span className="plan-bar-note">what the cover, the export and the Board read</span></h2></div>
        <p className="unlisted-note folio-details-unavailable" data-folio-details-refused={read.refused}>{read.message}</p>
      </section>
    )
  }

  const typedValue = (field: TypedField): string => drafts[field] ?? shownOf(details, field)
  const inherited = (field: FolioDetailField): string | undefined => (details?.fields[field].from === 'title-page' && details.titlePagePath
    ? `From the title page (${details.titlePagePath}). A change is saved in the Index Note.`
    : undefined)

  const usedSection = (field: 'author' | 'audience' | 'language'): PickerSection[] => {
    const current = shownOf(details, field)
    const used = values?.[field] ?? []
    const sections: PickerSection[] = [{
      heading: 'Used in this workspace',
      options: used.map((entry) => ({
        value: entry.value,
        label: entry.value,
        hint: field === 'author' && values?.you && entry.value.toLocaleLowerCase() === values.you.toLocaleLowerCase()
          ? `you · ${entry.count} ${entry.count === 1 ? 'file' : 'files'}`
          : `${entry.count} ${entry.count === 1 ? 'file' : 'files'}`,
        current: entry.value === current,
      })),
    }]
    // The value the Folio holds now is always on the list, even when no other file uses it.
    if (current !== '' && !used.some((entry) => entry.value === current)) sections[0].options.unshift({ value: current, label: current, current: true })
    sections.push({ heading: 'No value', options: [{ value: null, label: `No ${FOLIO_DETAIL_LABEL[field].toLocaleLowerCase()}`, hint: 'Takes the key out of the header' }] })
    return sections.filter((section) => section.options.length > 0)
  }

  const statusSections = (): PickerSection[] => {
    const current = details?.fields.status.from === 'index' ? shownOf(details, 'status') : ''
    const lanes = statusPickerLanes(current === '' ? null : current)
    const sections: PickerSection[] = [{
      heading: 'Board lanes',
      options: [
        { value: null, label: 'No status', hint: 'Unsorted on the Board', current: current === '' },
        ...lanes.board.map((lane) => ({ value: lane, label: lane, dot: statusDot(lane), current: lane.toLocaleLowerCase() === current.toLocaleLowerCase() })),
      ],
    }]
    if (lanes.own) sections.push({ heading: 'This Folio’s own lane', options: [{ value: lanes.own, label: lanes.own, dot: statusDot(lanes.own), current: true }] })
    return sections
  }

  const pickedField = (field: PickedField, icon: JSX.Element | null, extra?: JSX.Element) => {
    // A choice still being saved shows on its field, marked as saving, until it is written.
    const saving = pending.has(field)
    const raw = saving ? pending.get(field) ?? null : details?.fields[field].value ?? null
    const value = raw === null ? null : field === 'date' ? folioDetailDateLabel(raw) : raw
    const dot = field === 'status' && raw !== null ? <span className="fd-dot" style={{ background: statusDot(raw) }} aria-hidden="true" /> : extra
    return (
      <div className="fd-wrap" onBlur={(event) => { if (open === field && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(null) }}>
        <div
          className={`fd-in fd-pick${details?.fields[field].from === 'title-page' && !saving ? ' fd-inherited' : ''}${open === field ? ' fd-open' : ''}${saving ? ' fd-saving' : ''}`}
          tabIndex={0}
          role="combobox"
          aria-haspopup="dialog"
          aria-expanded={open === field}
          aria-label={FOLIO_DETAIL_LABEL[field]}
          aria-description={`${value ?? 'Not set'}${saving ? ' (saving)' : ''}`}
          aria-busy={saving || undefined}
          data-folio-detail={field}
          data-folio-detail-saving={saving ? 'true' : undefined}
          data-folio-detail-from={details?.fields[field].from ?? undefined}
          title={inherited(field)}
          onClick={() => (open === field ? setOpen(null) : openPicker(field))}
          onKeyDown={(event) => {
            if (open === field || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
            if (event.key === 'ArrowDown' || event.key === ' ' || event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              openPicker(field)
            }
          }}
        >
          {dot}{icon}
          <span className={`fd-v${value === null ? ' fd-ph' : ''}`}>{value ?? 'Not set'}</span>
          {saving && <span className="fd-saving-note">Saving…</span>}
          {field !== 'date' && <ChevronDown className="fd-icon fd-chev" aria-hidden="true" />}
        </div>
        {open === field && details && (field === 'date'
          ? <DetailCalendarPicker value={details.fields.date.value} onChoose={(iso) => void choose('date', iso)} onClose={() => closePicker('date')} />
          : <DetailListPicker
            label={FOLIO_DETAIL_LABEL[field]}
            sections={field === 'status' ? statusSections() : usedSection(field)}
            placeholder={PICK_PLACEHOLDER[field]}
            newLabel={(typed) => (field === 'status' ? `Use the lane “${typed}”` : `Use “${typed}”`)}
            onChoose={(chosen) => void choose(field, chosen)}
            onClose={() => closePicker(field)}
          />)}
      </div>
    )
  }

  return (
    <section className="folio-details" aria-label="Folio details" data-folio-details="true">
      <div className="plan-bar"><h2>Details <span className="plan-bar-note">what the cover, the export and the Board read</span></h2></div>
      <div className="fd-card" ref={cardRef} role="group" aria-label="Folio details" onKeyDown={onCardKeyDown}>
        <div className="fd-grid">
          <label htmlFor="folio-detail-title">Title</label>
          <input
            id="folio-detail-title"
            ref={titleRef}
            className={`fd-in fd-title${details?.fields.title.from === 'title-page' && drafts.title === null ? ' fd-inherited' : ''}`}
            data-folio-detail="title"
            value={typedValue('title')}
            placeholder="The Folio’s title"
            title={drafts.title === null ? inherited('title') : undefined}
            disabled={!details}
            onChange={(event) => setDraft('title', event.target.value)}
            onKeyDown={fieldKeyDown('title')}
            onBlur={() => void commit('title')}
          />
          <label htmlFor="folio-detail-standfirst" className="fd-top">Standfirst</label>
          <textarea
            id="folio-detail-standfirst"
            className={`fd-in fd-area${details?.fields.standfirst.from === 'title-page' && drafts.standfirst === null ? ' fd-inherited' : ''}`}
            data-folio-detail="standfirst"
            rows={2}
            value={typedValue('standfirst')}
            placeholder="One or two sentences for the cover, under the title"
            title={drafts.standfirst === null ? inherited('standfirst') : undefined}
            disabled={!details}
            onChange={(event) => setDraft('standfirst', event.target.value)}
            onKeyDown={fieldKeyDown('standfirst')}
            onBlur={() => void commit('standfirst')}
          />
          <span className="fd-label">Author</span>
          <div className="fd-row3">
            {pickedField('author', <UserRound className="fd-icon" aria-hidden="true" />)}
            <div className="fd-sub"><span className="fd-l">Date</span>{pickedField('date', <CalendarDays className="fd-icon" aria-hidden="true" />)}</div>
            <div className="fd-sub"><span className="fd-l">Status</span>{pickedField('status', null, <span className="fd-dot" aria-hidden="true" />)}</div>
          </div>
          <span className="fd-label">Audience</span>
          <div className="fd-row2">
            {pickedField('audience', <UsersRound className="fd-icon" aria-hidden="true" />)}
            <div className="fd-sub"><span className="fd-l">Language</span>{pickedField('language', <Languages className="fd-icon" aria-hidden="true" />)}</div>
          </div>
        </div>
        {message && <p className="fd-message" role="alert" data-folio-details-message="true">{message}</p>}
        <div className="fd-foot">
          <span title={details?.indexPath}>Saved in the Index Note header · <kbd>⌘Z</kbd> undoes</span>
          <span className="fd-grow" />
          <span><kbd>D</kbd> details</span>
          <span><kbd>⇥</kbd> next field</span>
          <span><kbd>↓</kbd> open a picker</span>
          <span><kbd>esc</kbd> back to the list</span>
        </div>
      </div>
    </section>
  )
})
