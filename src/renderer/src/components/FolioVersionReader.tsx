import { useEffect, useRef, useState } from 'react'
import { BackControl } from './BackControl'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, FileText, GitCompare, Library, Lock, RotateCcw, Upload } from 'lucide-react'
import { VersionBlocks, useVersionSelectionBubble } from './FolioVersionSend'
import {
  READ_ONLY_BANNER_TAIL, READ_ONLY_REFUSAL, VERSION_ACTIONS, partLead, plural, versionWhen, wordsText,
  type FolioVersionPart, type FolioVersionReading, type ReadingVersion,
} from '../../../shared/folio-versions-view'

/**
 * The read-only view of one Folio version (ADR-0052 § 3, Folio versions ticket 07): the Folio as the version saved it, in
 * the Outline, Text and Cards tabs, with the Binder listing that version's parts. NOTHING HERE WRITES. There is no editor, no field, no drag,
 * no rename and no Remove: the text is drawn by the app's own Markdown reader (`NoteMarkdown`), which shows raw HTML as text and
 * loads nothing, and every control that would change a part is absent. What is shown is the saved copy the version points to
 * (read in main by the shared reader), never the working file, so a part that has since changed, moved or gone reads as it was saved.
 */

export type ReaderTab = 'outline' | 'text' | 'cards'
export const READER_TABS: readonly ReaderTab[] = ['outline', 'text', 'cards']

/** What the reader is showing: the Index Note, or a part or file not in the outline by the label the version recorded. */
export type ReaderTarget = { kind: 'index' } | { kind: 'part'; path: string }
export const sameTarget = (a: ReaderTarget, b: ReaderTarget): boolean => a.kind === b.kind && (a.kind === 'index' || (b.kind === 'part' && a.path === b.path))

export type ReadingLoad = { state: 'loading' } | { state: 'unreadable' } | { state: 'ready'; value: FolioVersionReading }

/** Reads version `id` for reading, once per open. Writes nothing. */
export function useVersionReading(dir: string, id: string): ReadingLoad {
  const [load, setLoad] = useState<ReadingLoad>({ state: 'loading' })
  useEffect(() => {
    let live = true
    setLoad({ state: 'loading' })
    void window.writeflex.folioVersions.read(dir, id).then(
      (value) => { if (live) setLoad(value ? { state: 'ready', value } : { state: 'unreadable' }) },
      () => { if (live) setLoad({ state: 'unreadable' }) },
    )
    return () => { live = false }
  }, [dir, id])
  return load
}

/** The parts the reader lists: the version's parts in running order. */
export const readerParts = (reading: FolioVersionReading): FolioVersionPart[] => reading.contents.parts

/** The target to open first: the part the writer had selected in the working draft if the version has it (by file, else by title), else the first part, else the Index Note. */
export function firstTarget(reading: FolioVersionReading, working: { path: string | null; title: string } | null, startAt: string | null = null): ReaderTarget {
  const parts = readerParts(reading)
  // Asked to open at a part (the Scratchpad card's "Open in that version", ticket 10): that part, or the Index Note, if the version has it.
  if (startAt !== null) {
    if (startAt === reading.contents.indexPath) return { kind: 'index' }
    if (parts.some((part) => part.path === startAt) || reading.contents.unlisted.some((file) => file.path === startAt)) return { kind: 'part', path: startAt }
  }
  if (working) {
    const match = parts.find((part) => working.path !== null && part.path === working.path) ?? parts.find((part) => working.title !== '' && part.title === working.title)
    if (match) return { kind: 'part', path: match.path }
  }
  return parts[0] ? { kind: 'part', path: parts[0].path } : { kind: 'index' }
}

/** The Index Note's path as the version recorded it. */
const indexPath = (reading: FolioVersionReading): string => reading.contents.indexPath

function textOf(reading: FolioVersionReading, target: ReaderTarget): string | null {
  return target.kind === 'index' ? reading.index : reading.texts[target.path] ?? null
}

// ---- The banner -------------------------------------------------------------------------------

/**
 * The purple strip under the tabs: "Reading <name> · 15 Oct · read-only. Nothing here can be edited." with Export…, Compare with
 * working and Restore… (each disabled with its plain reason until its own ticket lands) and Back to working draft.
 */
export function ReaderBanner({ version, onBack, onCompare, onExport }: { version: ReadingVersion; onBack: () => void; /** Compare with working (ticket 08): leaves the version for the Versions tab with the comparison open. */ onCompare?: () => void; /** Export… (ticket 11): opens the export sheet for this version. */ onExport?: () => void }): JSX.Element {
  const shown = (id: 'export' | 'compare' | 'restore') => VERSION_ACTIONS.find((action) => action.id === id)!
  const Icons = { export: Upload, compare: GitCompare, restore: RotateCcw }
  return (
    <div className="fvr-banner" role="status" data-testid="reading-banner">
      <Lock aria-hidden="true" className="fvr-lock" />
      <span className="fvr-bannertext">Reading <b data-testid="reading-name">{version.name}</b> · {versionWhen(version.ts)} · read-only. {READ_ONLY_BANNER_TAIL}</span>
      <span className="fvr-push">
        {(['export', 'compare', 'restore'] as const).map((id) => {
          const action = shown(id)
          const Icon = Icons[id]
          const label = id === 'export' ? 'Export…' : id === 'compare' ? 'Compare with working' : 'Restore…'
          const run = id === 'compare' ? onCompare : id === 'export' ? onExport : undefined
          return <button key={id} type="button" className="fv-btn" data-reader-action={id} aria-disabled={run ? undefined : true} title={run ? undefined : action.reason} onClick={(event) => { event.preventDefault(); run?.() }}><Icon aria-hidden="true" />{label}</button>
        })}
        <BackControl className="fv-back" testId="reading-back" onBack={onBack} />
      </span>
    </div>
  )
}

// ---- The Binder's list of the version's parts ------------------------------------------------------

/**
 * The Binder while reading: the Folio's title row, then the version's parts in running order and "Not in the outline" as the version held
 * them. Each row selects what the reader shows. A lock stands where the working Binder has its stage dot; there is no add, no drag, no
 * rename and no remove.
 */
export function ReaderBinder({ load, version, selected, onSelect }: { load: ReadingLoad; version: ReadingVersion; selected: ReaderTarget; onSelect: (target: ReaderTarget) => void }): JSX.Element {
  const [loose, setLoose] = useState(false)
  const reading = load.state === 'ready' ? load.value : null
  const parts = reading ? readerParts(reading) : []
  const unlisted = reading?.contents.unlisted ?? []
  const ref = useRef<HTMLDivElement>(null)
  const targets: ReaderTarget[] = [{ kind: 'index' }, ...parts.map((part): ReaderTarget => ({ kind: 'part', path: part.path })), ...(loose ? unlisted.map((file): ReaderTarget => ({ kind: 'part', path: file.path })) : [])]
  const key = (target: ReaderTarget): string => (target.kind === 'index' ? 'index' : target.path)
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>('[data-reader-target]') ?? [])]
    const at = rows.findIndex((row) => row === document.activeElement)
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))
    event.preventDefault()
    const row = rows[to]
    if (row) { row.focus(); row.click() }
  }
  const row = (target: ReaderTarget, children: React.ReactNode, className = ''): JSX.Element => {
    const current = sameTarget(target, selected)
    return (
      <button type="button" role="option" aria-selected={current} key={key(target)} data-reader-target={key(target)} className={`fr-brow fvr-brow${current ? ' cur' : ''}${className}`} aria-current={current ? 'true' : undefined} tabIndex={current || (selected.kind === 'part' && !targets.some((candidate) => sameTarget(candidate, selected)) && target.kind === 'index') ? 0 : -1}
        onClick={() => onSelect(target)}>{children}</button>
    )
  }
  return (
    <div className="fr-binder fr-binder-text fvr-binder" data-testid="binder-reading" data-reading-id={version.id}>
      <div className="fr-bh"><span>Text</span><small>{reading ? `${plural(parts.length, 'part')} · read-only` : 'read-only'}</small></div>
      <div role="listbox" aria-label={`Parts of ${version.name}, read-only`} ref={ref} onKeyDown={onKeyDown}>
        {row({ kind: 'index' }, <><Library aria-hidden="true" /><span className="t">Index Note</span><Lock aria-hidden="true" className="fvr-rowlock" /></>)}
        {parts.map((part, at) => row({ kind: 'part', path: part.path }, <><span className="n">{part.order ?? at + 1}</span><span className="t">{part.title}</span><Lock aria-hidden="true" className="fvr-rowlock" /></>))}
        {loose && unlisted.map((file) => row({ kind: 'part', path: file.path }, <><FileText aria-hidden="true" /><span className="t f">{file.path.split('/').pop()}</span><Lock aria-hidden="true" className="fvr-rowlock" /></>))}
      </div>
      {load.state === 'loading' && <p className="ol-empty" role="status">Reading the version…</p>}
      {unlisted.length > 0 && (
        <div className="fr-nio" data-testid="binder-reading-not-in-outline">
          <button type="button" className="fr-brow" aria-expanded={loose} onClick={() => setLoose(!loose)}><span className="t">Not in the outline</span><span className="c">{unlisted.length}</span></button>
        </div>
      )}
    </div>
  )
}

// ---- The body: Outline, Text, Cards ---------------------------------------------------------------

type BodyProps = {
  /** The Folio's folder, and the version being read: what a send to the Scratchpad names (ticket 10). */
  dir: string
  versionId: string
  load: ReadingLoad
  tab: ReaderTab
  selected: ReaderTarget
  onSelect: (target: ReaderTarget) => void
  onOpenText: (target: ReaderTarget) => void
}

/** The version's text, structure and cards. Read only: every part is a row or card that selects or opens, nothing more. */
export function ReaderBody({ dir, versionId, load, tab, selected, onSelect, onOpenText }: BodyProps): JSX.Element {
  if (load.state === 'loading') return <div className="fvr-body" data-testid="reading-body" aria-busy="true" />
  if (load.state === 'unreadable') return <div className="fvr-body" data-testid="reading-body"><div className="fr-empty"><b>This version could not be read.</b>Its record is in the history, but its text could not be opened. Go back to the working draft and try another version.</div></div>
  const reading = load.value
  if (tab === 'text') return <ReaderText dir={dir} versionId={versionId} reading={reading} selected={selected} onSelect={onSelect} />
  return <ReaderList reading={reading} tab={tab} selected={selected} onSelect={onSelect} onOpenText={onOpenText} />
}

function ReaderText({ dir, versionId, reading, selected, onSelect }: { dir: string; versionId: string; reading: FolioVersionReading; selected: ReaderTarget; onSelect: (target: ReaderTarget) => void }): JSX.Element {
  const parts = readerParts(reading)
  const at = selected.kind === 'part' ? parts.findIndex((part) => part.path === selected.path) : -1
  const part = at >= 0 ? parts[at] : selected.kind === 'part' ? reading.contents.unlisted.find((file) => file.path === selected.path) ?? null : null
  const text = textOf(reading, selected)
  const prev = at > 0 ? parts[at - 1] ?? null : null
  const next = at >= 0 ? parts[at + 1] ?? null : selected.kind === 'index' ? parts[0] ?? null : null
  const scroller = useRef<HTMLDivElement>(null)
  // Send a copy to the Scratchpad (ticket 10): the bubble over a selection, and the same selection for the command.
  const bubble = useVersionSelectionBubble(scroller, dir)
  useEffect(() => { scroller.current?.scrollTo?.({ top: 0 }) }, [selected.kind, selected.kind === 'part' ? selected.path : ''])
  const nav = (target: FolioVersionPart | null, side: 'prev' | 'next'): JSX.Element => (
    <button type="button" className={`fr-nav${side === 'next' ? ' r' : ''}`} data-nav={side} disabled={target === null} onClick={() => target && onSelect({ kind: 'part', path: target.path })}
      title={target ? `${side === 'prev' ? 'Previous' : 'Next'} part: ${target.title}` : side === 'prev' ? 'This is the first part' : 'This is the last part'}>
      {side === 'prev' && <ChevronLeft aria-hidden="true" />}{target ? `${target.order ?? parts.indexOf(target) + 1} ${target.title}` : side === 'prev' ? 'First part' : 'Last part'}{side === 'next' && <ChevronRight aria-hidden="true" />}
    </button>
  )
  const words = selected.kind === 'index' ? reading.contents.indexWords : part?.words ?? null
  return (
    <div className="fr-text fvr-text" data-testid="reading-text" data-text-kind="reader">
      <div className="fr-tbar">
        {nav(prev, 'prev')}
        <span className="fr-tcur">{selected.kind === 'index' ? 'Index Note' : <><b>{part?.order ?? (at >= 0 ? at + 1 : '')}</b> {part?.title ?? ''}</>}</span>
        <span className="fr-tw">{words === null ? 'text not found' : wordsText(words)} · saved copy</span>
        {nav(next, 'next')}
      </div>
      <div className="fvr-scroll" ref={scroller} tabIndex={0} role="document" aria-label={`${selected.kind === 'index' ? 'Index Note' : part?.title ?? 'Part'}, read-only`} aria-readonly="true" data-testid="reading-text-body">
        {text === null
          ? <div className="fr-empty"><b>The saved text of this part could not be found.</b>The version points to a copy that is no longer in the history.</div>
          : <article className="fvr-prose" data-readonly="true"><VersionBlocks dir={dir} source={{ id: versionId, path: selected.kind === 'index' ? indexPath(reading) : selected.path, side: 'version' }} text={text} /></article>}
      </div>
      {bubble}
    </div>
  )
}

function ReaderList({ reading, tab, selected, onSelect, onOpenText }: { reading: FolioVersionReading; tab: 'outline' | 'cards'; selected: ReaderTarget; onSelect: (target: ReaderTarget) => void; onOpenText: (target: ReaderTarget) => void }): JSX.Element {
  const parts = readerParts(reading)
  const listRef = useRef<HTMLDivElement>(null)
  const chosen = selected.kind === 'part' && parts.some((part) => part.path === selected.path) ? selected.path : parts[0]?.path ?? null
  const move = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || parts.length === 0) return
    const at = Math.max(0, parts.findIndex((part) => part.path === chosen))
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0
    let to: number | null = step !== 0 ? Math.min(parts.length - 1, Math.max(0, at + step)) : event.key === 'Home' ? 0 : event.key === 'End' ? parts.length - 1 : null
    if (to === null) {
      if (event.key === 'Enter' && chosen !== null) { event.preventDefault(); onOpenText({ kind: 'part', path: chosen }) }
      return
    }
    event.preventDefault()
    const target = parts[to]!
    onSelect({ kind: 'part', path: target.path })
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-reader-part="${CSS.escape(target.path)}"]`)?.focus())
  }
  const item = (part: FolioVersionPart, at: number): JSX.Element => {
    const current = part.path === chosen
    const text = reading.texts[part.path] ?? null
    const lead = partLead(text)
    const common = { role: 'option' as const, 'aria-selected': current, tabIndex: current ? 0 : -1, 'data-reader-part': part.path, onClick: () => onSelect({ kind: 'part', path: part.path }), onDoubleClick: () => onOpenText({ kind: 'part', path: part.path }) }
    if (tab === 'cards') {
      return (
        <div key={part.path} {...common} className="fr-card fvr-card">
          <div className="fr-strip" />
          <div className="fr-ct"><span className="n">{part.order ?? at + 1}</span><span>{part.title}</span></div>
          <div className={`fr-cs${lead ? '' : ' none'}`}>{text === null ? 'Saved text not found' : lead}</div>
          <div className="fr-cf"><span className="fr-stage idea"><Lock aria-hidden="true" className="fvr-rowlock" />saved</span><span className="g" /><span className="w">{part.words === null ? 'text not found' : wordsText(part.words)}</span></div>
        </div>
      )
    }
    return (
      <div key={part.path} {...common} className="fvr-olrow">
        <span className="num">{part.order ?? at + 1}</span>
        <span className="ttl">{part.title}</span>
        <span className="lead">{text === null ? 'Saved text not found' : lead}</span>
        <span className="wds">{part.words === null ? '' : wordsText(part.words)}</span>
      </div>
    )
  }
  return (
    <div className="fvr-body" data-testid="reading-body" data-reader-tab={tab}>
      {parts.length === 0
        ? <div className="fr-empty" data-testid="reading-no-parts"><b>This version has no parts.</b>Its Index Note is the only text; open it from the Binder or the Text tab.</div>
        : <div ref={listRef} className={tab === 'cards' ? 'fr-cards fvr-cards' : 'fvr-outline'} role="listbox" aria-label={`Parts of this version, in running order, read-only`} onKeyDown={move} data-testid={tab === 'cards' ? 'reading-cards' : 'reading-outline'}>
          {parts.map(item)}
        </div>}
      {reading.contents.unlisted.length > 0 && tab === 'outline' && (
        <div className="fvr-nio" data-testid="reading-unlisted">
          <h3>Not in the outline · {plural(reading.contents.unlisted.length, 'Markdown file')}</h3>
          {reading.contents.unlisted.map((file) => (
            <button type="button" key={file.path} className="fvr-nio-row" data-reader-unlisted={file.path} onClick={() => onOpenText({ kind: 'part', path: file.path })}><FileText aria-hidden="true" /><span>{file.path.split('/').pop()}</span><small>{file.words === null ? '' : wordsText(file.words)}</small></button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- One open version ---------------------------------------------------------------------------

export type ReadingSessionProps = {
  dir: string
  version: ReadingVersion
  tab: ReaderTab
  onTab: (tab: ReaderTab) => void
  /** The part selected in the working draft, so the reader opens on the same part when the version has it. */
  working: { path: string | null; title: string } | null
  /** The part to open on, by the label the version recorded (the Scratchpad card's "Open in that version"); absent: as `working` says. */
  startAt?: string | null
  /** The sidebar slot the Binder's list is drawn into; absent while no sidebar shows it. */
  binderSlot: HTMLElement | null
  onBack: () => void
  /** Compare with working (ticket 08). */
  onCompare?: () => void
  /** Export… (ticket 11). */
  onExport?: () => void
}

/**
 * A version open for reading: the banner, the body for the chosen tab and (in the sidebar slot) the Binder's list of that version's
 * parts. Its own state is only what is selected to read; the working Folio's state is not touched, so Back is exactly where the writer left.
 */
export function ReadingSession({ dir, version, tab, onTab, working, startAt = null, binderSlot, onBack, onCompare, onExport }: ReadingSessionProps): JSX.Element {
  const load = useVersionReading(dir, version.id)
  const [target, setTarget] = useState<ReaderTarget | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const selected: ReaderTarget = target ?? (load.state === 'ready' ? firstTarget(load.value, working, startAt) : { kind: 'index' })
  // Once the version is read, the keyboard moves into it (the button that opened it has gone), never into a working file.
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current || load.state === 'loading') return
    landed.current = true
    root.current?.querySelector<HTMLElement>('.fvr-scroll, [role="option"][tabindex="0"], [data-testid="reading-back"]')?.focus()
  }, [load.state])
  const openText = (next: ReaderTarget): void => { setTarget(next); onTab('text') }
  return (
    <div className="fvr" data-testid="room-reading" data-version-id={version.id} data-reader-tab={tab} ref={root}>
      <ReaderBanner version={version} onBack={onBack} {...(onCompare ? { onCompare } : {})} {...(onExport ? { onExport } : {})} />
      <ReaderBody dir={dir} versionId={version.id} load={load} tab={tab} selected={selected} onSelect={setTarget} onOpenText={openText} />
      {binderSlot && createPortal(<ReaderBinder load={load} version={version} selected={selected} onSelect={setTarget} />, binderSlot)}
    </div>
  )
}

export { READ_ONLY_REFUSAL }
