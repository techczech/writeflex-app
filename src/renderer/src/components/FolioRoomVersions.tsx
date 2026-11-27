import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Sparkles, Eye, FileDown, FileText, GitCompare, Globe, History, Image as ImageIcon, Pencil, Send, Table2, Upload, type LucideIcon } from 'lucide-react'
import { COMPARE_WORKING } from '../../../shared/folio-version-compare'
import { FolioVersionCompare, type CompareChoice, type TakeHost } from './FolioVersionCompare'
import { FolioVersionImport } from './FolioVersionImport'
import { FolioVersionDecide } from './FolioVersionDecide'
import {
  BACKUP_UNKNOWN, SAVE_SHEET_REASON, VERSION_ACTIONS, leftOutReasons, listKeyTarget, plural, shownVersionId, versionMeta, versionWhen, wordsText,
  type FolioVersionContents, type FolioVersionRow, type FolioVersionsListing, type VersionActionId,
} from '../../../shared/folio-versions-view'
import { cueTotal, draftChangeText } from '../../../shared/folio-version-changes'
import { NOTHING_APPLIED, decidedLine, revisionSummary, type RevisionStatus } from '../../../shared/folio-version-stage'
import { useFolioCues } from '../plan/folio-cues-store'

/**
 * The Versions tab of the Folio workspace (ADR-0052 § Decision 1, Folio versions ticket 05): the timeline on the left
 * (30%), the chosen version's contents on the right (70%). Read only. Save Folio version… is the save sheet's door
 * (`onSaveVersion`, ticket 04); the actions on a selected version open later tickets' surfaces and are shown disabled
 * with a plain reason until those land (`VERSION_ACTIONS`). Opening the tab writes nothing.
 */

/** The window event Open Folio Version Read-only (palette, menu) sends. `detail.handled` is set by the tab when it opened the version it shows. */
export const OPEN_READ_ONLY_EVENT = 'writeflex:folio-version-open-read-only'
/** The window event Compare Folio Versions… (palette, menu) sends (ticket 08). `detail.handled` is set by the tab when it opened a comparison. */
export const OPEN_COMPARE_EVENT = 'writeflex:folio-version-compare'
/** The window events Export This Folio Version… and Mark Version as Sent… (palette, menu) send (ticket 11). `detail.handled` is set by the tab, or by the room while a version is open read-only. */
export const OPEN_EXPORT_EVENT = 'writeflex:folio-version-export'
export const OPEN_MARK_SENT_EVENT = 'writeflex:folio-version-mark-sent'
/** The window event Import Revision from Word… (palette, menu) sends (ticket 14). `detail.handled` is set by the tab when it opened Import. */
export const OPEN_IMPORT_EVENT = 'writeflex:folio-version-import'

/**
 * Import Revision from Word… from a tab other than Versions: the command takes the writer to the Versions tab, and the tab opens Import when it
 * appears. The request lapses after a few seconds, so a Folio that never shows the tab does not open Import later.
 */
let importWaiting = 0
export function requestImportOnNextVersionsTab(): void { importWaiting = Date.now() + 4000 }
const takeImportRequest = (): boolean => { const held = importWaiting > Date.now(); importWaiting = 0; return held }

const ACTION_ICONS: Record<Exclude<VersionActionId, 'restore'>, LucideIcon> = { 'open-read-only': Eye, compare: GitCompare, export: Upload, 'mark-sent': Send }

function fileIcon(path: string): LucideIcon {
  if (/\.(csv|tsv)$/i.test(path)) return Table2
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path)) return ImageIcon
  if (/\.html?$/i.test(path)) return Globe
  return FileText
}

function rowIcon(row: FolioVersionRow): LucideIcon {
  return row.incomingFrom !== undefined ? FileDown : row.sentTo !== undefined ? Send : History
}

/** How long a burst of collection or file changes is gathered before the backup's left-out list is read again. */
const SCOPE_REREAD_MS = 250

type Timeline = { accepted: FolioVersionsListing | null; pending: boolean; failed: boolean }
const INITIAL_TIMELINE: Timeline = { accepted: null, pending: true, failed: false }
const NO_VERSIONS: readonly FolioVersionRow[] = []
const HISTORY_UNAVAILABLE = 'The versions of this Folio could not be read.'

type OpenComparison = CompareChoice & { openedFrom: string }

type Loaded<T> = { state: 'loading' } | { state: 'unreadable' } | { state: 'ready'; value: T }

/**
 * What the tab keeps while a version is open read-only (ticket 07), so Back to working draft finds the tab as the writer left it: the
 * version that was chosen and how far the list and the contents were scrolled. Owned by the room; the tab only writes and reads it.
 */
export type VersionsMemory = { chosen: string | null; rows: number; main: number; /** The comparison open in the tab (ticket 08), so Back from a read-only version and a tab change find it again. */ compare?: OpenComparison | null }

export type VersionsEntry = { dir: string; origin: Element | null }

export type FolioRoomVersionsProps = {
  /** A one-shot focus handoff from an explicit entry into this Folio's Versions tab. */
  entry?: { current: VersionsEntry | null }
  /** Lets the room close the visible comparison before its other Escape steps. */
  closeVersionCompare?: { current: (() => void) | null }
  /** Where the tab keeps its choice and scroll for the room (ticket 07). Absent: the tab starts from the newest version each time. */
  memory?: { current: VersionsMemory }
  /** The Folio's folder. */
  dir: string
  /** Opens the save sheet (ticket 04), with a name proposed when the finishing offer of the decide step asks (ticket 16). Absent: Save Folio version… is shown disabled with its reason. */
  onSaveVersion?: (suggestedName?: string) => void
  /** Opens a version's actions as later tickets land; absent: shown disabled with the reason. */
  actions?: Partial<Record<VersionActionId, (version: FolioVersionRow) => void>>
  /** Ticket 09: what a take needs from the window. Absent: Compare draws no take buttons. */
  take?: TakeHost
}

export function FolioRoomVersions({ dir, onSaveVersion, actions, memory, take, entry, closeVersionCompare }: FolioRoomVersionsProps): JSX.Element {
  const [timeline, setTimeline] = useState(INITIAL_TIMELINE)
  const currentTimeline = useRef(timeline)
  const readRequest = useRef(0)
  const [chosen, setChosenState] = useState<string | null>(memory?.current.chosen ?? null)
  const chosenRef = useRef(chosen)
  const setChosen = useCallback((id: string | null): void => {
    chosenRef.current = id
    if (memory) memory.current.chosen = id
    setChosenState(id)
  }, [memory])
  const [focused, setFocused] = useState<string | null>(null)
  // Ticket 08: the comparison open in the main column, if any. The tab owns it; the room's memory only carries it across a read-only visit.
  // Ticket 14: Import (steps 1 and 2) takes the main column while it is open. It writes nothing until "Bring changes into the Folio".
  const [importing, setImporting] = useState<boolean>(() => takeImportRequest())
  // Ticket 16: the incoming revision being decided, if any. It takes the main column and folds the timeline to a rail.
  const [deciding, setDeciding] = useState<string | null>(null)
  const [comparing, setComparingState] = useState<OpenComparison | null>(memory?.current.compare ?? null)
  const setComparing = useCallback((next: OpenComparison | null): void => { if (memory) memory.current.compare = next; setComparingState(next) }, [memory])
  const [contents, setContents] = useState<Loaded<FolioVersionContents>>({ state: 'loading' })
  const [tick, setTick] = useState(0)
  // Ticket 15: the incoming revisions and how many of their staged suggestions are decided. They change with the ledger, not only with the history.
  const [revisions, setRevisions] = useState<RevisionStatus[]>([])
  const [ledgerTick, setLedgerTick] = useState(0)
  const cues = useFolioCues(dir)
  const listRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const returningFocus = useRef(false)

  const readHistory = useCallback(async (): Promise<void> => {
    const request = ++readRequest.current
    const chosenAtRead = chosenRef.current
    const publish = (next: Timeline): void => {
      currentTimeline.current = next
      setTimeline(next)
    }
    if (!currentTimeline.current.pending) publish({ ...currentTimeline.current, pending: true })
    const answer = await window.writeflex.folioVersions.list(dir).catch(() => null)
    if (readRequest.current !== request) return
    const previous = currentTimeline.current.accepted
    // Main canonicalises the folder spelling. The request and this keyed tab own the answer.
    if (!answer) {
      publish({ accepted: previous, pending: false, failed: true })
      return
    }

    const active = document.activeElement
    const activeRow = active instanceof HTMLElement && listRef.current?.contains(active) ? active.dataset.versionId : undefined
    returningFocus.current = active === retryRef.current || (activeRow !== undefined && !answer.versions.some(row => row.id === activeRow))
    const selected = chosenRef.current
    // An Import completion can select an id while an older history read is in flight.
    if (selected !== null && (selected === chosenAtRead || previous?.versions.some(row => row.id === selected))
      && !answer.versions.some(row => row.id === selected)) {
      setChosen(answer.versions[0]?.id ?? null)
    }
    publish({ accepted: answer, pending: false, failed: false })
  }, [dir, setChosen])

  useLayoutEffect(() => () => { readRequest.current += 1 }, [])
  useEffect(() => window.writeflex.onChangesChanged(() => setLedgerTick((value) => value + 1)), [])
  useEffect(() => {
    let live = true
    void window.writeflex.folioVersions.revisions(dir).then((value) => { if (live) setRevisions(value) }, () => { if (live) setRevisions([]) })
    return () => { live = false }
  }, [dir, tick, ledgerTick])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void readHistory() }, SCOPE_REREAD_MS)
    }
    const offVersions = window.writeflex.onVersionsChanged(() => {
      void readHistory()
      setTick((value) => value + 1)
    })
    // The backup's left-out list depends on where the parts are now. Coalesce file and Collection events.
    const offCollection = window.writeflex.onCollectionChanged(soon)
    const offFiles = window.writeflex.onFileChangedOnDisk(soon)
    void readHistory()
    return () => { offVersions(); offCollection(); offFiles(); if (timer !== null) clearTimeout(timer) }
  }, [readHistory])

  const { accepted, failed, pending } = timeline
  const versions = accepted?.versions ?? NO_VERSIONS
  const ids = versions.map((version) => version.id)
  const shown = shownVersionId(ids, chosen)
  const shownRow = versions.find((version) => version.id === shown) ?? null
  const actionRow = useCallback((id: string): FolioVersionRow | undefined => {
    const current = currentTimeline.current
    return current.failed ? undefined : current.accepted?.versions.find(row => row.id === id)
  }, [])

  useEffect(() => {
    if (shown === null) { setContents({ state: 'loading' }); return }
    let live = true
    setContents((previous) => (previous.state === 'ready' && previous.value.id === shown ? previous : { state: 'loading' }))
    void window.writeflex.folioVersions.contents(dir, shown).then((value) => { if (live) setContents(value ? { state: 'ready', value } : { state: 'unreadable' }) }, () => { if (live) setContents({ state: 'unreadable' }) })
    return () => { live = false }
  }, [dir, shown, tick])

  // Open Folio Version Read-only (palette, menu): the version the tab shows.
  const openReadOnly = actions?.['open-read-only']
  const shownRef = useRef(shown)
  shownRef.current = shown
  const shownForAction = useCallback(() => {
    const id = shownRef.current
    return id === null ? undefined : actionRow(id)
  }, [actionRow])
  const openReadOnlyRef = useRef(openReadOnly)
  openReadOnlyRef.current = openReadOnly
  useEffect(() => {
    const onCommand = (event: Event): void => {
      const detail = (event as CustomEvent<{ handled: boolean }>).detail
      const row = shownForAction()
      if (!row || !openReadOnlyRef.current) return
      detail.handled = true
      openReadOnlyRef.current(row)
    }
    window.addEventListener(OPEN_READ_ONLY_EVENT, onCommand)
    return () => window.removeEventListener(OPEN_READ_ONLY_EVENT, onCommand)
  }, [shownForAction])
  // Compare Folio Versions… (palette, menu): the version the tab shows, against the working draft.
  const compareRef = useRef<(row: FolioVersionRow) => void>(() => undefined)
  compareRef.current = (row) => setComparing({ from: row.id, to: COMPARE_WORKING, openedFrom: row.id })
  useEffect(() => {
    const onCommand = (event: Event): void => {
      const detail = (event as CustomEvent<{ handled: boolean }>).detail
      const row = shownForAction()
      if (!row) return
      detail.handled = true
      compareRef.current(row)
    }
    window.addEventListener(OPEN_COMPARE_EVENT, onCommand)
    return () => window.removeEventListener(OPEN_COMPARE_EVENT, onCommand)
  }, [shownForAction])
  // Export This Folio Version… and Mark Version as Sent… (palette, menu): the version the tab shows.
  const exportRef = useRef(actions?.export)
  exportRef.current = actions?.export
  const markSentRef = useRef(actions?.['mark-sent'])
  markSentRef.current = actions?.['mark-sent']
  useEffect(() => {
    const on = (target: { current: ((row: FolioVersionRow) => void) | undefined }) => (event: Event): void => {
      const detail = (event as CustomEvent<{ handled: boolean }>).detail
      const row = shownForAction()
      if (!row || !target.current) return
      detail.handled = true
      target.current(row)
    }
    const onExport = on(exportRef)
    const onMark = on(markSentRef)
    window.addEventListener(OPEN_EXPORT_EVENT, onExport)
    window.addEventListener(OPEN_MARK_SENT_EVENT, onMark)
    return () => { window.removeEventListener(OPEN_EXPORT_EVENT, onExport); window.removeEventListener(OPEN_MARK_SENT_EVENT, onMark) }
  }, [shownForAction])
  // Import Revision from Word… (palette, menu): opens Import in this tab.
  const openImport = useCallback((): void => {
    if (currentTimeline.current.failed) return
    setComparing(null)
    setDeciding(null)
    setImporting(true)
  }, [setComparing])
  useEffect(() => {
    const onCommand = (event: Event): void => {
      ;(event as CustomEvent<{ handled: boolean }>).detail.handled = true
      openImport()
    }
    window.addEventListener(OPEN_IMPORT_EVENT, onCommand)
    return () => window.removeEventListener(OPEN_IMPORT_EVENT, onCommand)
  }, [openImport])
  const closeImport = useCallback((): void => {
    setImporting(false)
    requestAnimationFrame(() => listRef.current?.closest('.fv')?.querySelector<HTMLElement>('[data-testid="versions-import"]')?.focus())
  }, [])
  const closeDecide = useCallback((): void => {
    setDeciding(null)
    requestAnimationFrame(() => listRef.current?.closest('.fv')?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus())
  }, [])
  const compareOrigin = comparing?.openedFrom
  const closeCompare = useCallback((): void => {
    if (compareOrigin === undefined) return
    setComparing(null)
    const origin = listRef.current?.querySelector<HTMLElement>(`[data-version-id="${CSS.escape(compareOrigin)}"]`)
    const fallback = listRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ?? saveRef.current ?? retryRef.current
    ;(origin ?? fallback)?.focus()
  }, [compareOrigin, setComparing])
  useLayoutEffect(() => {
    if (!closeVersionCompare || compareOrigin === undefined || importing || deciding !== null) return
    closeVersionCompare.current = closeCompare
    return () => { closeVersionCompare.current = null }
  }, [closeVersionCompare, closeCompare, compareOrigin, importing, deciding])
  // Back from a version: the list and the contents are scrolled as they were left.
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !memory || contents.state !== 'ready') return
    restored.current = true
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = memory.current.rows
      if (mainRef.current) mainRef.current.scrollTop = memory.current.main
    })
  }, [contents.state, memory])

  const workflowOpen = deciding !== null || importing || comparing !== null
  useLayoutEffect(() => {
    if (accepted === null && !failed) return
    const active = document.activeElement
    const bodyHasFocus = active === document.body || active === document.documentElement
    const target = listRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ?? saveRef.current ?? retryRef.current
    const returning = returningFocus.current
    returningFocus.current = false
    const intent = entry?.current
    if (intent?.dir === dir && entry) {
      entry.current = null
      // Import and Compare have their own keyboard destinations once their contents arrive.
      if ((!workflowOpen || accepted === null) && (active === intent.origin || bodyHasFocus)) target?.focus()
    } else if (returning && bodyHasFocus) {
      target?.focus({ preventScroll: true })
    }
  }, [accepted, dir, entry, failed, workflowOpen])

  const focusRow = useCallback((id: string) => {
    setFocused(id)
    listRef.current?.querySelector<HTMLElement>(`[data-version-id="${CSS.escape(id)}"]`)?.focus()
  }, [])

  const retryNotice = failed && (
    <div className="fv-notice">
      <b role="status">{HISTORY_UNAVAILABLE}</b>{' '}
      <button ref={retryRef} type="button" className="fv-btn" aria-disabled={pending || undefined}
        onClick={() => { if (!currentTimeline.current.pending) void readHistory() }}>
        Retry versions
      </button>
    </div>
  )

  if (accepted === null) {
    return <div className="fv" data-testid="room-versions" aria-busy={!failed || undefined}>{retryNotice}</div>
  }

  const saveButton = (primary: boolean): JSX.Element => (
    <button ref={saveRef} type="button" className={`fv-btn${primary ? ' pri' : ''}`} data-testid="versions-save" aria-disabled={onSaveVersion ? undefined : true} title={onSaveVersion ? undefined : SAVE_SHEET_REASON} onClick={() => onSaveVersion?.()}>
      <History aria-hidden="true" />Save Folio version…
    </button>
  )

  if (versions.length === 0 && !workflowOpen) {
    return (
      <div className="fv-shell">
        {retryNotice}
        <div className="fv fv-none" data-testid="room-versions" data-state="empty">
          <div className="fv-empty" data-testid="versions-empty">
            <History aria-hidden="true" className="fv-empty-icon" />
            <h3>No Folio versions yet</h3>
            <p>A Folio version freezes the text of every part, in order, with the tables and widgets the text inserts. Research, data you do not insert, offcuts and the archive stay out.</p>
            {saveButton(true)}
          </div>
        </div>
      </div>
    )
  }

  const reasons = leftOutReasons(accepted)
  const backupUnavailable = accepted.backup.state === 'unavailable'
  const outIds = new Set(reasons.map((reason) => reason.id))
  const tabbable = focused !== null && ids.includes(focused) ? focused : shown

  // Ticket 15: a revision with suggestions still waiting (or matches only the writer can confirm) says so above everything, and who brought it in.
  const waiting = revisions.find((revision) => ids.includes(revision.id) && !revision.withdrawn && (revision.decided < revision.staged || (revision.structure !== undefined && revision.structure.decided < revision.structure.total) || revision.needsYou > 0))
  const revisionOf = (id: string): RevisionStatus | undefined => revisions.find((revision) => revision.id === id)
  // Ticket 16: "Review the revision" opens the decide step (the part's margin is one click on from there, "Open in Text").
  const review = (revision: RevisionStatus): void => {
    const row = actionRow(revision.id)
    if (!row || row.withdrawn) return
    setComparing(null); setImporting(false); setChosen(row.id); setDeciding(row.id)
  }
  const selectRow = (id: string, click: boolean): void => {
    if (!actionRow(id)) return
    setChosen(id)
    if (click) {
      setFocused(id)
      if (deciding !== null && deciding !== id) setDeciding(null)
    }
    if (comparing) setComparing({ ...comparing, from: id })
  }
  return (
    <div className="fv-shell">
    {retryNotice}
    {waiting && deciding === null && <RevisionBanner revision={waiting} onReview={() => review(waiting)} reviewUnavailable={failed} />}
    <div className={`fv${deciding !== null ? ' fv-folded' : ''}`} data-testid="room-versions" data-state="list" data-deciding={deciding ?? undefined}>
      <div className="fv-list" data-testid="versions-timeline">
        <div className="fv-listhead">
          {saveButton(true)}
          <button type="button" className="fv-btn" aria-pressed={importing} data-testid="versions-import" aria-disabled={failed || undefined} onClick={openImport}><FileDown aria-hidden="true" />Import revision…</button>
        </div>
        {cues.state === 'ready' && (
          // The working draft: not a version (it cannot be chosen or opened), so it is outside the listbox. It says what the Folio holds now that the last version does not.
          <div className="fv-draft" data-testid="versions-working-draft" data-state={cueTotal(cues) > 0 ? 'unsaved' : 'saved'}>
            <Pencil aria-hidden="true" className="fv-row-icon" />
            <div className="fv-row-body">
              <div className="fv-nm"><span className="fv-name">Working draft</span>{cueTotal(cues) > 0 && <span className="fv-chip draft">unsaved</span>}</div>
              <div className="fv-meta">{['now', draftAuthor(versions), draftChangeText(cues)].filter((part): part is string => part !== null).join(' · ')}</div>
            </div>
          </div>
        )}
        <div ref={listRef} className="fv-rows" role="listbox" aria-label="Folio versions, newest first" onScroll={(event) => { if (memory) memory.current.rows = event.currentTarget.scrollTop }} onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return
          if (event.key === 'Enter' || event.key === ' ') {
            const id = (event.target as HTMLElement).closest<HTMLElement>('[data-version-id]')?.dataset.versionId
            if (id) { event.preventDefault(); selectRow(id, false) }
            return
          }
          const from = (event.target as HTMLElement).closest<HTMLElement>('[data-version-id]')?.dataset.versionId ?? null
          const target = listKeyTarget(ids, from, event.key)
          if (target !== null) { event.preventDefault(); focusRow(target) }
        }}>
          {versions.map((version) => {
            const Icon = rowIcon(version)
            return (
              <div key={version.id} role="option" aria-selected={version.id === shown} aria-disabled={failed || undefined} tabIndex={version.id === tabbable ? 0 : -1} data-version-id={version.id} data-testid="version-row" title={deciding !== null ? version.name : undefined} className={`fv-row${version.id === shown ? ' sel' : ''}`}
                onClick={() => selectRow(version.id, true)} onDoubleClick={() => { const row = actionRow(version.id); if (row) openReadOnly?.(row) }} onFocus={() => setFocused(version.id)}>
                <Icon aria-hidden="true" className="fv-row-icon" />
                <div className="fv-row-body">
                  <div className="fv-nm"><span className="fv-name">{version.name}</span>
                    {version.sentTo !== undefined && <span className="fv-chip acc" data-chip="sent">sent to {version.sentTo}</span>}
                    {version.incomingFrom !== undefined && <span className="fv-chip warn" data-chip="incoming">incoming from {version.incomingFrom}</span>}
                    {revisionOf(version.id)?.by != null && <span className="fv-chip acc" data-chip="by">by {revisionOf(version.id)!.by}</span>}
                    {version.withdrawn && <span className="fv-chip" data-chip="withdrawn">withdrawn</span>}
                    {outIds.has(version.id) && <span className="fv-chip warn" data-chip="not-in-backup">not in the backup</span>}</div>
                  <div className="fv-meta" data-testid="version-meta">{revisionMeta(version, revisionOf(version.id))}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="fv-main" ref={mainRef} onScroll={(event) => { if (memory) memory.current.main = event.currentTarget.scrollTop }}>
        {(reasons.length > 0 || backupUnavailable) && (
          <div className="fv-notice" role="status" data-testid="versions-left-out">
            {backupUnavailable
              ? <p>{BACKUP_UNKNOWN}</p>
              : <><b>{reasons.length === 1 ? '1 Folio version is' : `${reasons.length} Folio versions are`} not in the backup</b>{reasons.map((reason) => <p key={reason.id} data-version-id={reason.id}>{reason.reason}</p>)}</>}
          </div>
        )}
        {deciding !== null
          ? <FolioVersionDecide dir={dir} revisionId={deciding} onClose={closeDecide} {...(take ? { openPart: take.openPart, isUnsaved: take.isUnsaved, ...(take.resolveSuggestion ? { resolveSuggestion: take.resolveSuggestion } : {}) } : {})} {...(onSaveVersion ? { onSaveVersion } : {})} />
          : importing
          ? <FolioVersionImport dir={dir} onClose={closeImport} onDone={(id) => { setChosen(id); setImporting(false) }} onDecide={(id) => { setChosen(id); setImporting(false); setDeciding(id) }} {...(onSaveVersion ? { onSaveVersion: () => onSaveVersion() } : {})} />
          : comparing
          ? <FolioVersionCompare dir={dir} versions={versions} choice={comparing} choicesUnavailable={failed} onChoice={(next) => {
            if (currentTimeline.current.failed) return
            const available = (id: string): boolean => id === COMPARE_WORKING || Boolean(actionRow(id))
            if ((next.from === comparing.from || available(next.from)) && (next.to === comparing.to || available(next.to))) setComparing({ ...next, openedFrom: comparing.openedFrom })
          }} onClose={closeCompare} {...(take ? { take } : {})} />
          : shownRow && <VersionContents row={shownRow} contents={contents} actionRow={actionRow} unavailable={failed} actions={{ ...actions, compare: (row) => compareRef.current(row) }} {...(shownRow.incomingFrom !== undefined && !shownRow.withdrawn ? { onDecide: (row: FolioVersionRow) => { if (row.incomingFrom !== undefined && !row.withdrawn) setDeciding(row.id) } } : {})} />}
      </div>
    </div>
    </div>
  )
}

/**
 * A revision with suggestions still waiting, or matches only the writer can confirm (ticket 15): who brought it in, what is waiting, and that
 * nothing is applied until the writer accepts. "Review the revision" opens the first part with a suggestion waiting, where the margin is.
 */
export function RevisionBanner({ revision, onReview, reviewUnavailable }: { revision: RevisionStatus; onReview?: () => void; reviewUnavailable?: boolean }): JSX.Element {
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(revision.ts)
  return (
    <div className="fv-banner" role="status" data-testid="revision-banner" data-revision-id={revision.id} data-by={revision.by ?? ''}>
      {revision.by !== null ? <Sparkles aria-hidden="true" /> : <FileDown aria-hidden="true" />}
      <span><b>{revision.by ?? 'You'}</b> brought in {revision.from}’s revision at {time}: <span data-testid="revision-summary">{revisionSummary(revision)}</span> {NOTHING_APPLIED}</span>
      {onReview && <button type="button" className="fv-btn pri sm" data-testid="revision-review" aria-disabled={reviewUnavailable || undefined} onClick={onReview}>Review the revision</button>}
    </div>
  )
}

/** The second line of a row: the usual one, and for an incoming revision with staged suggestions how many are decided ("22 Oct · 0 of 22 decided · 1 match to confirm"). */
function revisionMeta(row: FolioVersionRow, revision: RevisionStatus | undefined): string {
  if (!revision || revision.withdrawn || (revision.staged === 0 && revision.needsYou === 0)) return versionMeta(row)
  return [versionWhen(row.ts), decidedLine(revision)].join(' · ')
}

/** The name of the person whose version is newest among the writer's own (a co-author's revision is not the working draft's author). */
function draftAuthor(versions: readonly FolioVersionRow[]): string | null {
  return versions.find((version) => version.incomingFrom === undefined && !version.withdrawn)?.author ?? null
}

function VersionContents({ row, contents, actions, onDecide, unavailable, actionRow }: {
  row: FolioVersionRow
  contents: Loaded<FolioVersionContents>
  actions: FolioRoomVersionsProps['actions']
  onDecide?: (row: FolioVersionRow) => void
  unavailable: boolean
  actionRow: (id: string) => FolioVersionRow | undefined
}): JSX.Element {
  const held = contents.state === 'ready' && contents.value.id === row.id ? contents.value : null
  return (
    <div className="fv-contents" data-testid="version-contents" data-version-id={row.id}>
      <div className="fv-title"><h2>{row.name}</h2><span className="fv-sub">{versionWhen(row.ts)} · {row.author}{held ? ` · ${wordsText(held.words)}` : ''}</span></div>
      {row.note && <p className="fv-note">{row.note}</p>}
      {row.incomingFrom !== undefined && <p className="fv-note" data-testid="incoming-note">{`${row.incomingFrom}’s revision is kept as it arrived, with the Word file. The text below is yours as it stood when the revision came in; nothing has been applied to it.`}</p>}
      {onDecide && <div className="fv-actions"><button type="button" className="fv-btn pri" data-testid="version-decide" aria-disabled={unavailable || undefined} onClick={() => { const current = actionRow(row.id); if (current) onDecide(current) }}>Decide what to take…</button></div>}
      <div className="fv-actions" role="group" aria-label="This version">
        {VERSION_ACTIONS.map((action) => {
          const { id } = action
          if (id === 'restore') return null
          const Icon = ACTION_ICONS[id]
          const run = actions?.[id]
          return (
            <button key={action.id} type="button" className="fv-btn" data-action={action.id} aria-disabled={unavailable || !run || undefined} title={run ? undefined : action.reason} onClick={() => { const current = actionRow(row.id); if (current) run?.(current) }}>
              <Icon aria-hidden="true" />{action.label}
            </button>
          )
        })}
      </div>
      {contents.state === 'unreadable' && <div className="fr-empty"><b>This version could not be read.</b>Its record is in the history, but its parts could not be listed.</div>}
      {held && (
        <>
          <section className="fv-card" data-testid="version-parts">
            <h3>Text in this version</h3>
            {held.parts.map((part, at) => (
              <div className="fv-sec" key={part.path} data-testid="version-part"><span className="num">{part.order ?? at + 1}</span><span className="fv-ptitle">{part.title}</span><span className="fv-count">{part.words === null ? 'text not found' : wordsText(part.words)}</span></div>
            ))}
            <div className="fv-sec" data-testid="version-index"><span /><span className="fv-ptitle">Index Note</span><span className="fv-count">{held.indexWords === null ? 'text not found' : wordsText(held.indexWords)}</span></div>
          </section>
          {held.unlisted.length > 0 && (
            <section className="fv-card" data-testid="version-unlisted">
              <h3>Not in the outline · {plural(held.unlisted.length, 'Markdown file')} in the Folio folder</h3>
              {held.unlisted.map((file) => (
                <div className="fv-sec" key={file.path} data-testid="version-unlisted-file"><FileText aria-hidden="true" /><span className="mono">{file.path.split('/').pop()}</span><span className="fv-count">{file.words === null ? '' : wordsText(file.words)}</span></div>
              ))}
            </section>
          )}
          {held.inserted.length > 0 && (
            <section className="fv-card" data-testid="version-inserted">
              <h3>Inserted files and the version of each it used</h3>
              {held.inserted.map((file) => {
                const Icon = fileIcon(file.path)
                return (
                  <div className="fv-sec" key={file.path} data-testid="version-inserted-file"><Icon aria-hidden="true" /><span><span className="fv-ftitle">{file.path.split('/').pop()}</span> <span className="mono fv-path">{file.path}</span></span>
                    <span className="fv-chip acc">{file.fileVersion ? `${file.fileVersion.name} · ${versionWhen(file.fileVersion.ts)}` : 'version no longer in the history'}</span></div>
                )
              })}
            </section>
          )}
          {held.references.length > 0 && (
            <section className="fv-card" data-testid="version-references">
              <h3>Linked or too large to keep · listed, not kept</h3>
              {held.references.map((file) => (
                <div className="fv-sec" key={file.path}><FileText aria-hidden="true" /><span className="mono">{file.path}</span><span className="fv-count">{file.why === 'linked' ? 'only linked' : 'too large'}</span></div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  )
}
