import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ChevronDown, ChevronRight, FileText, Globe, Image as ImageIcon, RotateCcw, Table2, X, type LucideIcon } from 'lucide-react'
import {
  COMPARE_WORKING, NOTHING_CHANGED, comparingText, nothingChanged, stateChipText,
  type FolioCompareEntry, type FolioComparePart, type FolioCompareResult, type FolioCompareRow, type FolioCompareSegment,
} from '../../../shared/folio-version-compare'
import { plural, versionWhen, type FolioVersionRow } from '../../../shared/folio-versions-view'
import { stagedKeptText, stagedText, takeRefusalText } from '../../../shared/folio-version-take'
import { SendUnitButton, unitAttributes, useVersionSelectionBubble, type UnitSource } from './FolioVersionSend'
import { withdrawCopy } from '../scratchpad/version-send'

/**
 * Compare two Folio versions, or a version with the working draft (ADR-0052; Folio versions ticket 08). A workspace view in the
 * Versions tab's main column, beside the timeline: the two versions chosen at the top, then every line (the Index Note, each
 * part, the files not in the outline, the inserted files) with what happened to it. A changed part opens to its two texts, side by
 * side, with the changed words marked. It reads two versions and writes nothing. The one thing it can do (ticket 09) is stage a
 * proposal: on a part that changed between a saved version and the working draft, "Take that text" files the version's text in the
 * part's margin (nothing is written to the part until the writer accepts it there) and "Keep current" leaves the part alone.
 *
 * Keyboard: the lines are buttons (Tab, then ↵ or Space opens one); ↑ and ↓ move between lines; Esc goes back to the version.
 * The Versions tab is read only, so no key here reaches a part-editing command of the working Folio (FolioRoom's `runOwn`).
 */

export type CompareChoice = { from: string; to: string }

/** What the window gives the comparison so a take can be made (ticket 09). Absent: the take buttons are not drawn. */
export type TakeHost = {
  /** Whether the part has typed text not yet saved (or an open notice that its file changed on disk): a take is refused then. */
  isUnsaved: (path: string) => boolean
  /** Opens the part in the editor with its margin (the way "Return to text" does), where the proposal waits with its Accept and Decline. */
  openPart: (path: string) => void
  /** Ticket 17: accepts or declines a suggestion through the margin's own route (the document owner's), for the three texts' "Use theirs" and "Keep mine". Absent: those buttons say it cannot be done here. */
  resolveSuggestion?: (change: { id: string; path: string }, action: 'accept' | 'reject') => Promise<{ applied: boolean; message?: string }>
}

type Loaded<T> = { state: 'loading' } | { state: 'refused'; message: string } | { state: 'unreadable' } | { state: 'ready'; value: T }

/** Rows drawn for one opened part before "Show more": a part with a great many changes is drawn in steps, never all at once. */
export const ROWS_AT_FIRST = 120
const ROWS_MORE = 200
/** How long a burst of file changes is gathered before a comparison with the working draft is read again. */
const WORKING_REREAD_MS = 400

function fileIcon(path: string): LucideIcon {
  if (/\.(csv|tsv)$/i.test(path)) return Table2
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path)) return ImageIcon
  if (/\.html?$/i.test(path)) return Globe
  return FileText
}

const labelOf = (id: string, versions: readonly FolioVersionRow[]): string => {
  if (id === COMPARE_WORKING) return 'Working draft'
  const row = versions.find((version) => version.id === id)
  return row ? `${row.name} · ${versionWhen(row.ts)}` : id
}

export type FolioVersionCompareProps = {
  dir: string
  /** The Folio's versions, newest first, for the two pickers. */
  versions: readonly FolioVersionRow[]
  choice: CompareChoice
  onChoice: (choice: CompareChoice) => void
  /** Back to the version the tab was showing. */
  onClose: () => void
  take?: TakeHost
}

export function FolioVersionCompare({ dir, versions, choice, onChoice, onClose, take }: FolioVersionCompareProps): JSX.Element {
  const [load, setLoad] = useState<Loaded<FolioCompareResult>>({ state: 'loading' })
  const [tick, setTick] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const involvesWorking = choice.from === COMPARE_WORKING || choice.to === COMPARE_WORKING

  // A save, the agent's save or a restore changes the history; a file change changes the working draft.
  useEffect(() => window.writeflex.onVersionsChanged(() => setTick((value) => value + 1)), [])
  useEffect(() => {
    if (!involvesWorking) return undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; setTick((value) => value + 1) }, WORKING_REREAD_MS)
    }
    const offCollection = window.writeflex.onCollectionChanged(soon)
    const offFiles = window.writeflex.onFileChangedOnDisk(soon)
    return () => { offCollection(); offFiles(); if (timer !== null) clearTimeout(timer) }
  }, [involvesWorking])

  useEffect(() => {
    let live = true
    setLoad((previous) => (previous.state === 'ready' && previous.value.from.id === choice.from && previous.value.to.id === choice.to ? previous : { state: 'loading' }))
    void window.writeflex.folioVersions.compare(dir, choice.from, choice.to).then(
      (value) => {
        if (!live) return
        if (value === null) setLoad({ state: 'unreadable' })
        else if ('refused' in value) setLoad({ state: 'refused', message: value.refused })
        else setLoad({ state: 'ready', value })
      },
      () => { if (live) setLoad({ state: 'unreadable' }) },
    )
    return () => { live = false }
  }, [dir, choice.from, choice.to, tick])

  // The keyboard lands on the first line once the comparison is drawn, never on the working draft's editor.
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current || load.state !== 'ready') return
    landed.current = true
    if (document.activeElement?.closest('input, textarea, select, [contenteditable="true"], .cm-editor')) return
    root.current?.querySelector<HTMLElement>('[data-compare-line]')?.focus()
  }, [load.state])

  const lines = useCallback((): HTMLElement[] => [...(root.current?.querySelectorAll<HTMLElement>('[data-compare-line]') ?? [])], [])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement
    if (target.closest('select')) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    const line = target.closest<HTMLElement>('[data-compare-line]')
    if (!line || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
    const all = lines()
    const next = all[all.indexOf(line) + (event.key === 'ArrowDown' ? 1 : -1)]
    if (next) { event.preventDefault(); next.focus() }
  }

  const pickers = (
    <div className="fvc-pick">
      <label className="fvc-pickone"><span className="fvc-sr">Compare this version</span>
        <select data-testid="compare-from" value={choice.from} onChange={(event) => onChoice({ ...choice, from: event.target.value })}>
          {choiceOptions(versions, choice.from)}
        </select></label>
      <ArrowRight aria-hidden="true" className="fvc-arrow" />
      <label className="fvc-pickone"><span className="fvc-sr">with this version</span>
        <select data-testid="compare-to" value={choice.to} onChange={(event) => onChoice({ ...choice, to: event.target.value })}>
          {choiceOptions(versions, choice.to)}
        </select></label>
      <span className="fvc-push">
        <button type="button" className="fv-btn" aria-disabled="true" title="Restoring a whole Folio is not built yet." data-testid="compare-restore"><RotateCcw aria-hidden="true" />Restore the whole Folio…</button>
        <button type="button" className="fv-btn" data-testid="compare-close" onClick={onClose}><X aria-hidden="true" />Close comparison</button>
      </span>
    </div>
  )

  return (
    <div className="fvc" data-testid="folio-compare" ref={root} onKeyDown={onKeyDown}>
      {pickers}
      {load.state === 'loading' && <div className="fvc-status" aria-busy="true" data-testid="compare-loading">Comparing…</div>}
      {load.state === 'unreadable' && <div className="fr-empty" data-testid="compare-unreadable"><b>These versions could not be compared.</b>Close the comparison and choose two versions again.</div>}
      {load.state === 'refused' && <div className="fr-empty" data-testid="compare-refused"><b>These versions could not be compared.</b>{load.message}</div>}
      {load.state === 'ready' && <CompareBody dir={dir} result={load.value} {...(take ? { take, onReread: () => setTick((value) => value + 1) } : {})} />}
    </div>
  )
}

function choiceOptions(versions: readonly FolioVersionRow[], current: string): JSX.Element[] {
  const known = current === COMPARE_WORKING || versions.some((version) => version.id === current)
  return [
    <option key={COMPARE_WORKING} value={COMPARE_WORKING}>Working draft</option>,
    ...versions.map((version) => <option key={version.id} value={version.id}>{labelOf(version.id, versions)}</option>),
    ...(known ? [] : [<option key={current} value={current}>{current}</option>]),
  ]
}

export function CompareBody({ dir, result, take, onReread }: { dir: string; result: FolioCompareResult; take?: TakeHost; onReread?: () => void }): JSX.Element {
  const { summary } = result
  const none = nothingChanged(result)
  const total = summary.unchanged + summary.changed + summary.onlyFrom + summary.onlyTo + summary.moved
  return (
    <div className="fvc-body">
      <div className="fvc-status" role="status" data-testid="compare-summary" data-nothing-changed={none ? 'true' : 'false'}>
        <b>Comparing {comparingText(result)}.</b>{' '}
        {none ? NOTHING_CHANGED : `${summary.changed} changed, ${summary.onlyFrom + summary.onlyTo} in only one, ${summary.moved} moved, ${summary.unchanged} unchanged.`}
        {' '}<span className="fvc-total">{plural(total, 'line')}</span>
      </div>
      <section className="fv-card" data-testid="compare-sections">
        <h3>Section by section</h3>
        <Line dir={dir} result={result} entry={result.index} number="" />
        {result.parts.map((entry, at) => <Line key={entry.key} dir={dir} result={result} entry={entry} number={String(entry.toPosition ?? entry.fromPosition ?? at + 1)} {...(take ? { take } : {})} {...(onReread ? { onReread } : {})} />)}
      </section>
      {result.unlisted.length > 0 && (
        <section className="fv-card" data-testid="compare-unlisted">
          <h3>Not in the outline</h3>
          {result.unlisted.map((entry) => <Line key={entry.key} dir={dir} result={result} entry={entry} number="" />)}
        </section>
      )}
      {result.inserted.length > 0 && (
        <section className="fv-card" data-testid="compare-inserted">
          <h3>Inserted files</h3>
          {result.inserted.map((entry) => <Line key={entry.key} dir={dir} result={result} entry={entry} number="" />)}
        </section>
      )}
    </div>
  )
}

/** A line can be opened when it is text and something is there to show: a changed text, or a part on one side only. */
const opensToText = (entry: FolioCompareEntry): boolean => entry.text && !entry.unreadable && (entry.state === 'changed' || entry.state === 'only-from' || entry.state === 'only-to')

function Line({ dir, result, entry, number, take, onReread }: { dir: string; result: FolioCompareResult; entry: FolioCompareEntry; number: string; take?: TakeHost; onReread?: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const canOpen = opensToText(entry)
  const chip = stateChipText(entry, result)
  const tone = entry.state === 'changed' ? 'warn' : entry.state === 'unchanged' ? '' : 'acc'
  const Icon = entry.kind === 'inserted' || entry.kind === 'unlisted' ? fileIcon(entry.path) : null
  const panel = `fvc-detail-${entry.key.replace(/[^a-z0-9]+/gi, '-')}`
  const label = (
    <>
      <span className="num">{number}</span>
      <span className="fvc-ltitle">{Icon && <Icon aria-hidden="true" />}<span className="fv-ptitle">{entry.title}</span>{(entry.kind === 'inserted' || entry.kind === 'unlisted') && <span className="mono fv-path">{entry.path}</span>}</span>
      <span className="fvc-chips"><span className={`fv-chip${tone ? ` ${tone}` : ''}`} data-chip={entry.state} data-testid="compare-chip">{chip}</span>{entry.unreadable && <span className="fv-chip" data-chip="unreadable">text not found</span>}</span>
    </>
  )
  return (
    <div className="fvc-line" data-testid="compare-line" data-key={entry.key} data-kind={entry.kind} data-state={entry.state}>
      {canOpen
        ? <button type="button" className="fv-sec fvc-head" data-compare-line aria-expanded={open} aria-controls={open ? panel : undefined} data-testid="compare-open" onClick={() => setOpen((value) => !value)}>
            {open ? <ChevronDown aria-hidden="true" className="fvc-chev" /> : <ChevronRight aria-hidden="true" className="fvc-chev" />}{label}
          </button>
        : <div className="fv-sec fvc-head fvc-plain" data-compare-line tabIndex={0}><span aria-hidden="true" className="fvc-chev" />{label}</div>}
      {take && <TakeActions dir={dir} result={result} entry={entry} take={take} {...(onReread ? { onReread } : {})} />}
      {open && <PartDetail id={panel} dir={dir} result={result} entry={entry} />}
    </div>
  )
}

/** A line the writer can take: a part that changed, between a saved version and the working draft, whose working bytes the comparison carries. */
export const canTake = (result: Pick<FolioCompareResult, 'from' | 'to'>, entry: FolioCompareEntry): boolean =>
  entry.kind === 'part' && entry.state === 'changed' && entry.text && !entry.unreadable && entry.workingSha256 !== undefined && result.from.working !== result.to.working

type TakeState =
  | { kind: 'idle'; note?: string }
  | { kind: 'kept' }
  | { kind: 'taking' }
  | { kind: 'refused'; message: string; /** A Scratchpad copy a failed "keep mine" take left behind: offered for removal. */ leftover?: string }
  | { kind: 'staged'; changeId: string; path: string; kept?: string }
  | { kind: 'accepted'; path: string }

/**
 * Take that text / Keep current for one changed part (ticket 09). Taking files the version's text as a proposal in the part's margin;
 * it writes no part. Undo takes the proposal back while it waits. Every state is said in words, and focus follows the action so the
 * keyboard never lands on a button that has just gone.
 */
function TakeActions({ dir, result, entry, take, onReread }: { dir: string; result: FolioCompareResult; entry: FolioCompareEntry; take: TakeHost; onReread?: () => void }): JSX.Element | null {
  const [state, setState] = useState<TakeState>({ kind: 'idle' })
  const [menu, setMenu] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  // Set from this line's own Undo until the next take, so the proposal it declined is not read back as "declined in the margin".
  const undoing = useRef(false)
  const versionEnd = result.from.working ? result.to : result.from
  const workingPath = (result.from.working ? entry.fromPath : entry.toPath) ?? entry.path
  const eligible = canTake(result, entry)
  // The focus follows the action: to the first button the new state draws.
  const kind = state.kind
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return }
    box.current?.querySelector<HTMLElement>('[data-take-focus]')?.focus()
  }, [kind])
  // While a take waits, the margin may settle it: accepted there, or declined there.
  const changeId = state.kind === 'staged' ? state.changeId : null
  useEffect(() => {
    if (changeId === null) return undefined
    let live = true
    const settle = (): void => {
      void window.writeflex.listChanges({ path: workingPath }).then((changes) => {
        if (!live || !mounted.current || undoing.current) return
        const mine = changes.find((change) => change.id === changeId)
        if (mine?.status === 'accepted') setState({ kind: 'accepted', path: workingPath })
        else if (mine?.status === 'rejected') setState({ kind: 'idle', note: 'Declined in the margin. The part was not changed.' })
      }, () => undefined)
    }
    const off = window.writeflex.onChangesChanged(settle)
    return () => { live = false; off() }
  }, [changeId, workingPath])
  if (!eligible || entry.workingSha256 === undefined) return null
  const expected = entry.workingSha256
  const title = entry.title

  const doTake = async (keepMine = false): Promise<void> => {
    setMenu(false)
    if (take.isUnsaved(workingPath)) { setState({ kind: 'refused', message: takeRefusalText('unsaved', title) }); return }
    undoing.current = false
    setState({ kind: 'taking' })
    try {
      // "Keep mine in Scratchpad" (ticket 10): main sends the text being replaced to the Scratchpad first, and stages the take only if that worked.
      const answer = await window.writeflex.folioVersions.takePart({ dir, from: result.from.id, to: result.to.id, key: entry.key, expected, ...(keepMine ? { keepMine: true as const } : {}) })
      if (!mounted.current) return
      if (answer.ok) setState({ kind: 'staged', changeId: answer.changeId, path: answer.path, ...(answer.keptItemId ? { kept: answer.keptItemId } : {}) })
      else { setState({ kind: 'refused', message: answer.message, ...(answer.keptItemId ? { leftover: answer.keptItemId } : {}) }); if (answer.reason === 'changed') onReread?.() }
    } catch {
      if (mounted.current) setState({ kind: 'refused', message: `“${title}” could not be taken just now. Nothing was taken.` })
    }
  }
  const undo = async (): Promise<void> => {
    if (state.kind !== 'staged') return
    undoing.current = true
    try {
      // One Undo, decided in main under the write turn: the take is declined only if it still waits, and the unused card goes after that.
      // If it was accepted meanwhile (another window), nothing is changed and the answer says how to go back.
      const answer = await window.writeflex.folioVersions.undoTake({ dir, changeId: state.changeId, ...(state.kept ? { keptItemId: state.kept } : {}) })
      if (answer.ok) { if (mounted.current) setState({ kind: 'idle', note: answer.message }) }
      else {
        undoing.current = false
        if (mounted.current) setState(answer.reason === 'accepted' ? { kind: 'accepted', path: workingPath } : { kind: 'refused', message: answer.message })
      }
    } catch {
      undoing.current = false
      if (mounted.current) setState({ kind: 'refused', message: 'That take could not be taken back from here. Decline it in the part’s margin.' })
    }
  }
  const removeLeftover = async (): Promise<void> => {
    if (state.kind !== 'refused' || !state.leftover) return
    const withdrawn = await withdrawCopy(state.leftover)
    if (mounted.current) setState(withdrawn ? { kind: 'idle', note: 'The copy of your text was removed from the Scratchpad. The part was not changed.' } : { ...state, message: `${state.message} The copy could not be removed from here; remove it in the Scratchpad.` })
  }

  return (
    <div className="fvc-take" ref={box} data-testid="take-actions" data-take={state.kind}>
      {(state.kind === 'idle' || state.kind === 'refused') && (
        <>
          <button type="button" className="fv-btn" data-testid="take-keep" onClick={() => setState({ kind: 'kept' })}>Keep current</button>
          <span className="fvc-split">
            <button type="button" className="fv-btn pri" data-testid="take-take" data-take-focus="" onClick={() => void doTake()}>Take that text</button>
            <button type="button" className="fv-btn pri fvc-splitmore" data-testid="take-menu" aria-haspopup="menu" aria-expanded={menu} aria-label="More ways to take that text" onClick={() => setMenu((open) => !open)}
              onKeyDown={(event) => { if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); setMenu(false) } }}><ChevronDown aria-hidden="true" /></button>
            {menu && (
              <div className="fvc-menu" role="menu" aria-label="Take that text">
                <button type="button" role="menuitem" className="fvc-menuitem" data-testid="take-keep-mine" autoFocus onClick={() => void doTake(true)}
                  onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(false); box.current?.querySelector<HTMLElement>('[data-testid="take-menu"]')?.focus() } }}>Take that text, keep mine in Scratchpad</button>
              </div>
            )}
          </span>
        </>
      )}
      {state.kind === 'taking' && <span className="fvc-status" aria-busy="true">Staging…</span>}
      {state.kind === 'kept' && (
        <>
          <span className="fvc-takemsg" data-testid="take-kept">Keeping the current text of “{title}”.</span>
          <button type="button" className="fv-btn" data-testid="take-reconsider" data-take-focus="" onClick={() => setState({ kind: 'idle' })}>Choose again</button>
        </>
      )}
      {state.kind === 'staged' && (
        <>
          <span className="fvc-takemsg" role="status" data-testid="take-staged">{state.kept ? stagedKeptText(title, versionEnd.name) : stagedText(title, versionEnd.name)}</span>
          <button type="button" className="fv-btn" data-testid="take-undo" data-take-focus="" onClick={() => void undo()}>Undo</button>
          <button type="button" className="fv-btn" data-testid="take-open-part" onClick={() => take.openPart(state.path)}>Open the part</button>
        </>
      )}
      {state.kind === 'accepted' && <span className="fvc-takemsg" role="status" data-testid="take-accepted">Accepted: “{title}” now reads as it did in “{versionEnd.name}”. Undo it in the part (⌘Z) or restore the text kept before.</span>}
      {state.kind === 'idle' && state.note && <span className="fvc-takemsg" role="status" data-testid="take-note">{state.note}</span>}
      {state.kind === 'refused' && <span className="fvc-takemsg warn" role="alert" data-testid="take-refused">{state.message}</span>}
      {state.kind === 'refused' && state.leftover && <button type="button" className="fv-btn" data-testid="take-remove-copy" onClick={() => void removeLeftover()}>Remove the copy</button>}
    </div>
  )
}

function PartDetail({ id, dir, result, entry }: { id: string; dir: string; result: FolioCompareResult; entry: FolioCompareEntry }): JSX.Element {
  const [part, setPart] = useState<Loaded<FolioComparePart>>({ state: 'loading' })
  const [shown, setShown] = useState(ROWS_AT_FIRST)
  useEffect(() => {
    let live = true
    setPart({ state: 'loading' })
    void window.writeflex.folioVersions.comparePart(dir, result.from.id, result.to.id, entry.key).then(
      (value) => { if (live) setPart(value ? { state: 'ready', value } : { state: 'unreadable' }) },
      () => { if (live) setPart({ state: 'unreadable' }) },
    )
    return () => { live = false }
  }, [dir, result.from.id, result.to.id, entry.key, result.summary])
  const fromName = result.from.working ? 'Working draft' : result.from.name
  const toName = result.to.working ? 'Working draft' : result.to.name
  // Send a copy to the Scratchpad (ticket 10): from either side that is a SAVED version. The working draft is the live text, which the
  // editor sends in the ordinary way; it has no version to name.
  const detail = useRef<HTMLDivElement>(null)
  const bubble = useVersionSelectionBubble(detail, dir)
  const sendFrom: SideSend | null = result.from.working ? null : { dir, source: { id: result.from.id, path: entry.fromPath ?? entry.path, side: 'version' } }
  const sendTo: SideSend | null = result.to.working ? null : { dir, source: { id: result.to.id, path: entry.toPath ?? entry.path, side: 'version' } }
  return (
    <div className="fvc-detail" id={id} data-testid="compare-detail" ref={detail}>
      {part.state === 'loading' && <div className="fvc-status" aria-busy="true">Reading both texts…</div>}
      {part.state === 'unreadable' && <div className="fvc-status">The text of this part could not be read on one side.</div>}
      {part.state === 'ready' && (
        <>
          <div className="fvc-cols fvc-colhead"><span>{fromName}</span><span>{toName}</span></div>
          <Rows rows={part.value.rows} shown={shown} {...(sendFrom ? { sendFrom } : {})} {...(sendTo ? { sendTo } : {})} />
          {part.value.rows.length > shown && <button type="button" className="fv-btn fvc-more" data-testid="compare-more" onClick={() => setShown((value) => value + ROWS_MORE)}>Show more ({part.value.rows.length - shown} left)</button>}
        </>
      )}
      {bubble}
    </div>
  )
}

/** Where a side's text came from, for "Send a copy to Scratchpad": absent for the working draft. */
export type SideSend = { dir: string; source: UnitSource }

export function Rows({ rows, shown, sendFrom, sendTo }: { rows: FolioCompareRow[]; shown: number; sendFrom?: SideSend; sendTo?: SideSend }): JSX.Element {
  const visible = useMemo(() => rows.slice(0, shown), [rows, shown])
  return (
    <div className="fvc-rows">
      {visible.map((row, at) => row.kind === 'same'
        ? <div key={at} className="fvc-same" data-testid="compare-same">{plural(row.paragraphs, 'unchanged paragraph')}</div>
        : <div key={at} className="fvc-cols fvc-changed" data-testid="compare-changed"><Side segments={row.from} {...(sendFrom && row.fromParagraphs ? { send: sendFrom, range: row.fromParagraphs } : {})} /><Side segments={row.to} {...(sendTo && row.toParagraphs ? { send: sendTo, range: row.toParagraphs } : {})} /></div>)}
    </div>
  )
}

function Side({ segments, send, range }: { segments: FolioCompareSegment[]; send?: SideSend; range?: [number, number] }): JSX.Element {
  const text = <p className="fvc-text">{segments.map((segment, at) => segment.kind === 'removed' ? <del key={at}>{segment.text}</del> : segment.kind === 'added' ? <ins key={at}>{segment.text}</ins> : <span key={at}>{segment.text}</span>)}</p>
  if (!send || !range) return text
  return (
    <div className="fvb fvc-unit" {...unitAttributes(send.source, range[0], range[1])} data-testid="compare-unit">
      <SendUnitButton dir={send.dir} source={send.source} from={range[0]} to={range[1]} />
      {text}
    </div>
  )
}
