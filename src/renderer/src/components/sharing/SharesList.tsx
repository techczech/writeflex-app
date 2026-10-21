// The Shares list (sharing ticket 10; spec section 4.6; locked frame `shares-list`, ADR-0045: "the Shares
// list as the same page one level up"). Every link made in this Workspace: its piece, name, settings,
// when it was made, how many times it was opened and whether it is on. From the selected row: Copy
// link, Change settings, Turn off (or on) and Open the piece (its Sharing page).
//
// Main lists the Workspace's own links and binds exactly those to this window (`sharing:open-list`,
// read again on every change); this page names a link only by its id. A link whose piece or Folio went
// away is listed and can be copied and turned off, nothing more (sharing-piece-ipc.ts).
//
// Drawn from the frame: the header with the switch, the table panel (search, the All / On / Off / Needs
// attention filters, sortable columns), the selected link's panel with its buttons and keyboard line,
// the right column's "needs attention" row and "This collection". Ticket 07: the Notes waiting and
// Handled columns and totals, and a link's "Limit reached" chip (its panel is on the link's own Sharing
// page). Ticket 04: a link whose piece is not found shows its "Piece not found" row (Turn off, Follow to).
// Added: the Opened total, the empty list,
// the not-set-up line, and Change settings opening the link's one setting in place.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, FileText, Globe, Layers, Link, List, Lock, MessageSquareOff, Minus, Power, PowerOff, Search, Settings, SlidersHorizontal, TriangleAlert, X } from 'lucide-react'
import { linkLabel, type SharingLinkResult } from '../../../../shared/sharing-links'
import {
  OPENED_SETTLE_MS, filterEntries, listTotals, needsAttention, notesTotals, openedKey, openedLabel, sameNameFolders, sortEntries,
  type ListColumn, type ListFilter, type ListSort, type OpenedCounts, type ShareListEntry, type SharesListView,
} from '../../../../shared/sharing-shares-list'
import { bareAddress } from './sharing-page-model'
import { StateChip } from './SharingOtherLinks'
import { PieceNotFoundPanel } from './SharingPieceNotFound'
import { WaitingCell } from './SharingLimits'
import { countLabel, type NotesCounts } from '../../../../shared/sharing-notes'
import { shortTime } from './sharing-view-model'

export type SharesListProps = {
  collectionName: string
  /** The open piece's own Sharing page (the header switch); absent when no piece is open. */
  onPiecePage?: () => void
  /** Open a piece (or a Folio's part) and its Sharing page. */
  onOpenPiece: (path: string) => void
  onBack: () => void
  onFlash: (message: string) => void
  onOpenSettings: () => void
  onSetUp: () => void
}

type Problem = { reason: string; fix: string }

const label = (entry: ShareListEntry): string => linkLabel(entry.link)
const madeDay = (at: number): string => new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
const COLUMNS: Array<{ column: ListColumn; title: string }> = [
  { column: 'piece', title: 'Piece' }, { column: 'name', title: 'Name' }, { column: 'settings', title: 'Settings' },
  { column: 'made', title: 'Made' }, { column: 'opened', title: 'Opened' }, { column: 'waiting', title: 'Comments waiting' }, { column: 'handled', title: 'Handled' }, { column: 'on', title: 'On / off' },
]

export function SharesList({ collectionName, onPiecePage, onOpenPiece, onBack, onFlash, onOpenSettings, onSetUp }: SharesListProps): JSX.Element {
  const [view, setView] = useState<SharesListView | null>(null)
  const [opened, setOpened] = useState<OpenedCounts>({})
  const [notes, setNotes] = useState<NotesCounts>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState<ListFilter>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<ListSort>({ column: 'made', descending: true })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const page = useRef<HTMLDivElement | null>(null)
  const table = useRef<HTMLDivElement | null>(null)
  const live = useRef(true)

  // Main binds this window to the links it lists; every read binds again (a link made since included).
  // Only the answer to the latest read is kept: an earlier one arriving late never overwrites it.
  const reloads = useRef(0)
  const reload = useCallback(async (): Promise<void> => {
    const asked = ++reloads.current
    const next = await window.writeflex.sharing.openList()
    if (live.current && asked === reloads.current) setView(next)
  }, [])

  useEffect(() => {
    live.current = true
    void reload().catch(() => {})
    const off = window.writeflex.sharing.onChanged(() => { void reload().catch(() => {}) })
    // A piece deleted, moved or no longer in a Folio: read again, so the row shows its source gone
    // (main also checks the source at the moment of each action).
    const offDocuments = window.writeflex.onCollectionChanged(() => { void reload().catch(() => {}) })
    page.current?.focus()
    return () => {
      live.current = false
      off()
      offDocuments()
      void window.writeflex.sharing.close().catch(() => {})
    }
  }, [reload])

  const entries = view?.entries ?? []
  // Opened counts come from the service, through main, for the links main bound: asked when the list is
  // first read, and again only on a change that can move them (ticket 11, review 10 P3-2): a link made or
  // gone, turned on or off, or a publish finished; the list is read again on every change, a publish step
  // included, and those ask nothing. Once things settle for a moment. Only the answer to the latest
  // request is kept: an earlier one arriving late never overwrites it.
  const openedAsked = useRef(0)
  const notesAsked = useRef(0)
  const countKey = openedKey(entries.map((entry) => entry.link))
  const listed = entries.length
  useEffect(() => {
    if (listed === 0) return
    const timer = setTimeout(() => {
      const asked = ++openedAsked.current
      void window.writeflex.sharing.opened().then((counts) => { if (live.current && asked === openedAsked.current) setOpened(counts) }).catch(() => {})
    }, OPENED_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [listed, countKey])
  // Ticket 07: notes waiting and handled, from this Collection's review list, for the links main listed: read on every change.
  useEffect(() => {
    if (!view || view.entries.length === 0) return
    const timer = setTimeout(() => {
      const askedNotes = ++notesAsked.current
      void window.writeflex.sharing.notes?.().then((counts) => { if (live.current && askedNotes === notesAsked.current) setNotes(counts) }).catch(() => {})
    }, OPENED_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [view])

  const totals = useMemo(() => listTotals(entries, opened), [entries, opened])
  const shown = useMemo(() => sortEntries(filterEntries(entries, filter, search, label), sort, opened, label, notes), [entries, filter, search, sort, opened, notes])
  const noteTotals = useMemo(() => notesTotals(entries, notes), [entries, notes])
  const folders = useMemo(() => sameNameFolders(entries), [entries])
  const current = shown.find((entry) => entry.link.shareId === selected) ?? shown[0] ?? null
  const attention = entries.filter(needsAttention)
  const lastPublished = Math.max(0, ...entries.filter((entry) => entry.link.on).map((entry) => entry.link.publishedAt ?? 0))

  const settle = useCallback(() => {
    const at = document.activeElement as HTMLElement | null
    if (live.current && page.current && (!page.current.contains(at) || (at as HTMLButtonElement | null)?.disabled === true)) page.current.focus()
  }, [])

  /** One link action; the answer is that link's own piece view, so the list reads itself again. */
  const act = useCallback(async (action: () => Promise<SharingLinkResult>, done: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await action()
      if (!live.current) return
      if (result.ok) { setProblem(null); onFlash(done) } else setProblem(result.problem)
      await reload()
    } catch {
      if (live.current) setProblem({ reason: 'That did not go through.', fix: 'Try again.' })
    } finally {
      if (live.current) setBusy(false)
      settle()
      requestAnimationFrame(settle)
    }
  }, [busy, onFlash, reload, settle])

  const toggle = useCallback((entry: ShareListEntry | null) => {
    if (!entry || (entry.sourceGone && !entry.link.on)) return
    void act(() => (entry.link.on ? window.writeflex.sharing.turnOff(entry.link.shareId) : window.writeflex.sharing.turnOn(entry.link.shareId)),
      entry.link.on ? 'Link turned off. Readers who open it now see that it is off.' : 'Link turned on again, at the same address.')
  }, [act])

  // Copy link: main decides the address at the moment of copying (THE RULE), never this page's last view.
  const copy = useCallback(async (entry: ShareListEntry | null) => {
    if (!entry) return
    try {
      const address = await window.writeflex.sharing.copyAddress(entry.link.shareId)
      if (!address) { onFlash('Could not copy the link.'); return }
      await window.writeflex.copyToClipboard(address, 'plain')
      onFlash('Link copied')
    } catch {
      onFlash('Could not copy the link.')
    }
  }, [onFlash])

  const select = useCallback((shareId: string) => { setSelected(shareId); setSettingsOpen(false) }, [])
  const tabRow = current?.link.shareId ?? null

  const onRowKey = useCallback((event: KeyboardEvent<HTMLDivElement>, entry: ShareListEntry) => {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return
    // Frame `shares-list`: Return copies, Space turns the selected link on or off, ↑ ↓ move between rows.
    if (event.key === 'Enter') { event.preventDefault(); select(entry.link.shareId); void copy(entry); return }
    if (event.key === ' ') { event.preventDefault(); select(entry.link.shareId); toggle(entry); return }
    const at = shown.findIndex((item) => item.link.shareId === entry.link.shareId)
    const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 : null
    if (to === null) return
    event.preventDefault()
    const next = shown[Math.max(0, Math.min(shown.length - 1, to))]
    if (!next) return
    select(next.link.shareId)
    table.current?.querySelector<HTMLElement>(`[data-share="${next.link.shareId}"]`)?.focus()
  }, [shown, select, copy, toggle])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault()
      if (settingsOpen) setSettingsOpen(false)
      else onBack()
      return
    }
    if (!(event.metaKey || event.ctrlKey) || !event.altKey) return
    if (event.code === 'KeyC' && event.shiftKey) { event.preventDefault(); void copy(current) }
    else if (event.code === 'KeyO' && !event.shiftKey) { event.preventDefault(); toggle(current) }
  }, [settingsOpen, onBack, copy, current, toggle])

  const sortBy = (column: ListColumn): void => setSort((before) => ({ column, descending: before.column === column ? !before.descending : column === 'made' || column === 'opened' || column === 'waiting' || column === 'handled' }))
  const filters: Array<{ id: ListFilter; text: string; count: number }> = [
    { id: 'all', text: 'All', count: totals.links }, { id: 'on', text: 'On', count: totals.on }, { id: 'off', text: 'Off', count: totals.off },
    { id: 'attention', text: 'Needs attention', count: totals.attention },
  ]
  const linksWord = totals.links === 1 ? '1 link' : `${totals.links} links`

  return (
    <div className="shr-overlay" data-testid="shares-list" ref={page} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="shr-head">
        <button type="button" className="shr-btn" onClick={onBack}><ArrowLeft className="icon" aria-hidden="true" />Back to text<kbd>⌥⌘S</kbd></button>
        <div className="shr-title">
          <h2>Sharing</h2>
          <span className="shr-sub">Shares list · {collectionName} · {linksWord}</span>
        </div>
        <span className="grow" />
        <span className="shr-seg" role="group" aria-label="Sharing for">
          <button type="button" aria-pressed="false" disabled={!onPiecePage} title={onPiecePage ? undefined : 'Open a piece to see its own links'} onClick={onPiecePage}><FileText className="icon" aria-hidden="true" />This piece</button>
          <button type="button" aria-pressed="true"><List className="icon" aria-hidden="true" />{collectionName} · Shares list</button>
        </span>
      </header>
      <div className="shr-body">
        <section className="shr-left" aria-label="Shares list">
          {problem && (
            <div className="shr-errbox" role="alert">
              <X className="icon" aria-hidden="true" />
              <div><b>{problem.reason}</b><div className="shr-p">{problem.fix}</div></div>
            </div>
          )}
          <div className="shr-panel" data-testid="shares-list-links">
            <div className="shr-panel-h"><Link className="icon" aria-hidden="true" /><span>Shares list · {collectionName}</span></div>
            {view !== null && !view.ready && entries.length === 0 ? (
              <div className="shr-empty"><span className="shr-chip off"><Minus className="icon" aria-hidden="true" />Not set up</span><span className="shr-p">Sharing is not set up on this Mac, so nothing in this collection has been shared.</span>
                <button type="button" className="shr-btn small" onClick={onSetUp}><Settings className="icon" aria-hidden="true" />Set up sharing</button></div>
            ) : entries.length === 0 ? (
              <div className="shr-empty"><span className="shr-chip off"><Minus className="icon" aria-hidden="true" />None yet</span><span className="shr-p">{view === null ? 'Reading the links…' : 'No piece in this collection has a link. Open a piece and press ⌥⌘S to make one.'}</span></div>
            ) : (
              <>
                <div className="shr-tools coll">
                  <label className="shr-inp"><Search className="icon" aria-hidden="true" /><input aria-label="Search by piece or link name" placeholder="Search by piece or link name" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
                  <span className="shr-row shr-filters" style={{ gap: 6 }} role="group" aria-label="Show">
                    {filters.map((item) => (
                      <button key={item.id} type="button" className="shr-filter" aria-pressed={filter === item.id} data-filter={item.id} onClick={() => setFilter(item.id)}>
                        {item.id === 'attention' && <TriangleAlert className="icon" aria-hidden="true" />}{item.text} {item.count}
                      </button>
                    ))}
                  </span>
                </div>
                <div className="shr-tbl" role="table" aria-label="Links in this collection" ref={table}>
                  <div className="shr-tr coll th" role="row">
                    {COLUMNS.map(({ column, title }) => (
                      <span key={column} role="columnheader" aria-sort={sort.column === column ? (sort.descending ? 'descending' : 'ascending') : 'none'}>
                        <button type="button" className={`shr-sort${sort.column === column ? ' sorted' : ''}`} onClick={() => sortBy(column)}>
                          {title}{sort.column === column && (sort.descending ? <ArrowDown className="icon" aria-hidden="true" /> : <ArrowUp className="icon" aria-hidden="true" />)}
                        </button>
                      </span>
                    ))}
                  </div>
                  {shown.length === 0 && <div className="shr-empty"><span className="shr-p">No link matches.</span></div>}
                  {shown.map((entry) => {
                    const { link } = entry
                    const isCurrent = current?.link.shareId === link.shareId
                    return (
                      <div key={link.shareId} role="row" data-share={link.shareId} className={`shr-tr coll${isCurrent ? ' sel' : ''}${link.on ? '' : ' off'}`}
                        tabIndex={tabRow === link.shareId ? 0 : -1} aria-current={isCurrent ? 'true' : undefined}
                        onClick={() => select(link.shareId)} onKeyDown={(event) => onRowKey(event, entry)}>
                        <span className="shr-nm shr-piece" role="cell">
                          {entry.kind === 'folio' ? <Layers className="icon" aria-hidden="true" /> : null}{entry.piece}
                          {/* Two pieces of one name: each also shows its folder, muted (ticket 11, review 10 P3-3). */}
                          {link.shareId in folders && <span className="shr-dim shr-folder" data-folder={link.shareId}>· {folders[link.shareId] || collectionName}</span>}
                        </span>
                        <span className="shr-cname" role="cell">
                          <span className={link.name ? 'shr-nm' : 'shr-nm shr-unnamed'}>{label(entry)}</span>
                          {(needsAttention(entry) || !!notes[link.shareId]?.limit) && <StateChip link={link} limit={!!notes[link.shareId]?.limit} />}
                        </span>
                        <span className="shr-cellset" role="cell">{link.comments ? <Lock className="icon" aria-hidden="true" /> : <MessageSquareOff className="icon" aria-hidden="true" />}{link.comments ? 'Private comments' : 'Comments off'}</span>
                        <span className="shr-dim" role="cell">{madeDay(link.madeAt)}</span>
                        <span className="shr-num" role="cell" data-opened={link.shareId}>{openedLabel(opened[link.shareId])}</span>
                        <WaitingCell count={notes[link.shareId]?.waiting} shareId={link.shareId} />
                        <span className="shr-num" role="cell" data-notes-handled={link.shareId}>{countLabel(notes[link.shareId]?.handled)}</span>
                        <span role="cell" onClick={(event) => event.stopPropagation()}>
                          <button type="button" role="switch" aria-checked={link.on} aria-label={`${label(entry)}: ${link.on ? 'on' : 'off'}`} className="shr-sw"
                            disabled={busy || (entry.sourceGone && !link.on)} onClick={() => { select(link.shareId); toggle(entry) }}>
                            <span className="trk" aria-hidden="true" />{link.on ? 'On' : 'Off'}
                          </button>
                        </span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
          {current && (
            <div className="shr-panel" data-testid="shares-list-detail">
              <div className="shr-panel-h"><SlidersHorizontal className="icon" aria-hidden="true" /><span>Link: {label(current)} · {current.piece}</span><span className="grow" /><StateChip link={current.link} /></div>
              <div className="shr-panel-b" style={{ gap: 10 }}>
                <div className="shr-inp mono"><Link className="icon" aria-hidden="true" /><span className="shr-tx" data-testid="shares-list-address">{bareAddress(current.link.address)}</span></div>
                <div className="shr-row" style={{ flexWrap: 'wrap', gap: 10 }}>
                  <button type="button" className="shr-btn primary small" onClick={() => void copy(current)}><Copy className="icon" aria-hidden="true" />Copy link<kbd>⇧⌥⌘C</kbd></button>
                  <button type="button" className="shr-btn small" aria-expanded={settingsOpen} disabled={current.sourceGone} onClick={() => setSettingsOpen((open) => !open)}><SlidersHorizontal className="icon" aria-hidden="true" />Change settings</button>
                  <button type="button" className="shr-btn small" disabled={busy || (current.sourceGone && !current.link.on)} onClick={() => toggle(current)}>
                    {current.link.on ? <PowerOff className="icon" aria-hidden="true" /> : <Power className="icon" aria-hidden="true" />}{current.link.on ? 'Turn off' : 'Turn on'}<kbd>⌥⌘O</kbd>
                  </button>
                  <button type="button" className="shr-btn small" disabled={current.openPath === null} onClick={() => { if (current.openPath) onOpenPiece(current.openPath) }}>
                    {current.kind === 'folio' ? <Layers className="icon" aria-hidden="true" /> : <FileText className="icon" aria-hidden="true" />}{current.kind === 'folio' ? 'Open the Folio' : 'Open the piece'}
                  </button>
                  <span className="shr-p shr-dim">Return copies, Space turns the selected link on or off, ↑ ↓ move between rows.</span>
                </div>
                {settingsOpen && !current.sourceGone && (
                  <div className="shr-row" style={{ gap: 14 }} data-testid="shares-list-settings">
                    <button type="button" role="switch" aria-checked={current.link.comments} className="shr-sw" disabled={busy}
                      onClick={() => void act(() => window.writeflex.sharing.setComments(current.link.shareId, !current.link.comments), current.link.comments ? 'Readers can no longer leave comments on this link.' : 'Readers can leave comments on this link.')}>
                      <span className="trk" aria-hidden="true" />Readers can leave comments
                    </button>
                    <span className="shr-p shr-dim">Private comments: each reader sees only their own comments and your replies.</span>
                  </div>
                )}
                {current.sourceGone && !current.link.lost && (
                  <p className="shr-p shr-dim" data-testid="shares-list-source-gone">
                    {current.kind === 'folio'
                      ? 'This folder is no longer a Folio. Readers of this link still see the copy published last until you turn it off.'
                      : 'This piece is no longer in the collection. Readers of this link still see the copy published last until you turn it off.'}
                  </p>
                )}
              </div>
            </div>
          )}
        </section>
        <aside className="shr-right">
          {current?.link.lost && (
            <PieceNotFoundPanel link={current.link} where={current.path || 'this Folio'} busy={busy}
              onTurnOff={() => toggle(current)}
              onFollow={() => void act(() => window.writeflex.sharing.followTo(current.link.shareId), `The link follows the piece to ${current.link.lost?.candidate ?? 'its new place'}.`)} />
          )}
          {attention.length > 0 && (
            <div className="shr-panel problem" data-problem="needs-attention">
              <div className="shr-panel-h"><TriangleAlert className="icon" aria-hidden="true" /><span>{attention.length === 1 ? '1 link needs attention' : `${attention.length} links need attention`}</span></div>
              <div className="shr-panel-b">
                {attention.map((entry) => (
                  <div className="shr-kv" key={entry.link.shareId}>
                    <span className="shr-k"><b>{label(entry)}</b> · {entry.link.lost ? 'piece not found' : entry.link.problem ? 'not published' : 'part missing'}</span>
                    <span className="shr-v"><button type="button" className="shr-btn small" onClick={() => { setFilter('all'); select(entry.link.shareId) }}><ArrowRight className="icon" aria-hidden="true" />Open</button></span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="shr-panel" data-testid="shares-list-totals">
            <div className="shr-panel-h"><List className="icon" aria-hidden="true" /><span>This collection</span></div>
            <div className="shr-panel-b">
              <div className="shr-kv"><span className="shr-k">Links</span><span className="shr-v" data-total="links">{totals.links}</span></div>
              <div className="shr-kv"><span className="shr-k">On</span><span className="shr-v" data-total="on">{totals.on}</span></div>
              <div className="shr-kv"><span className="shr-k">Opened</span><span className="shr-v" data-total="opened">{totals.opened === null ? '–' : `${totals.openedPartial ? 'at least ' : ''}${totals.opened}`}</span></div>
              <div className="shr-kv"><span className="shr-k">Comments waiting</span><span className="shr-v" data-total="waiting">{countLabel(noteTotals.waiting)}</span></div>
              <div className="shr-kv"><span className="shr-k">Comments handled</span><span className="shr-v" data-total="handled">{countLabel(noteTotals.handled)}</span></div>
            </div>
          </div>
          <div className="shr-panel">
            <div className="shr-panel-h"><FileText className="icon" aria-hidden="true" /><span>Publishing</span></div>
            <div className="shr-panel-b">
              <div className="shr-kv"><span className="shr-k">Last published</span><span className="shr-v">{lastPublished > 0 ? shortTime(lastPublished) : 'Nothing yet'}</span></div>
              <div className="shr-kv"><span className="shr-k">Publishing from</span><span className="shr-v">This Mac</span></div>
            </div>
          </div>
          <div className="shr-panel">
            <div className="shr-panel-h"><Globe className="icon" aria-hidden="true" /><span>Your address</span></div>
            <div className="shr-panel-b">
              <div className="shr-kv"><span className="shr-k">Links read</span><span className="shr-v" style={{ fontFamily: 'var(--mono)' }}>{view?.address ? bareAddress(view.address) : '…'}</span></div>
              <div className="shr-row"><button type="button" className="shr-btn small" onClick={onOpenSettings}><Settings className="icon" aria-hidden="true" />{view?.ownAddress ? 'Change in Settings' : 'Use your own address'}</button></div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
