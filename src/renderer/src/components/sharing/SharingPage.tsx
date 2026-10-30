// The Sharing page for the open piece (sharing ticket 03; locked frames `make-link`, `shared-one`,
// `shared-several`, `problems`). Built in the manner of the Folder dashboard: a page over the text with
// the piece's links and the selected link's detail on the left, and publishing, the address and what
// readers see on the right. When sharing is not set up on this Mac, the set-up steps show in place
// (ticket 02's SharingSetup) and return here when done.
//
// A Folio (ticket 09, frame `folio`): the same page for the whole Folio, with its parts in running
// order as readers see them, and a part missing on disk flagged in the parts list, in the right column
// (Show in Files, Remove from Folio: the Plan, where a Folio with a missing entry is changed) and on the
// link's state.
//
// Ticket 10 (frames `shared-several`, `shares-list`): the Opened column and fact (the service's count),
// and the header switch to the Shares list, the same page one level up.
//
// Ticket 07: Notes waiting (column and fact) and Notes handled (fact), from this Collection's review
// list, and the Limits panel in the right column (frame `problems`).
//
// Not in this ticket (drawn, built later): the notes in Activity (ticket 08), open notes and Live.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeft, CircleCheck, CloudOff, Copy, ExternalLink, FileText, FileWarning, FolderOpen, Globe, Layers, Link, List, Lock, MessageSquareOff, Minus, Monitor, Pencil, Plus, Power, PowerOff, RefreshCw, Search, Settings, SlidersHorizontal, TriangleAlert, Users, X } from 'lucide-react'
import { ENDED_BACK, ENDED_BY_TRASH, ENDED_REMOVAL_OWED, linkLabel, linkSettingsLabel, partMissingText, type PieceSharingView, type ShareLinkView, type SharingLinkResult } from '../../../../shared/sharing-links'
import type { SharingSetupStatus } from '../../../../shared/sharing-setup'
import { OPENED_SETTLE_MS, openedKey, openedLabel, openedTimes, type OpenedCounts } from '../../../../shared/sharing-shares-list'
import { SharingProblemRows, SharingSetup } from './SharingSetup'
import { PieceNotFoundPanel } from './SharingPieceNotFound'
import { problemRows, shortTime } from './sharing-view-model'
import { bareAddress, copyAgainText, linkState, notPublishedText, updatedLabel } from './sharing-page-model'
import { OtherLinksPanel, StateChip } from './SharingOtherLinks'
import { LimitsPanel, WaitingCell } from './SharingLimits'
import { ShareOrderPanel, useExportOrderCheck } from '../ExportOrderNotice'
import { countLabel, type LimitsActionResult, type NotesCounts } from '../../../../shared/sharing-notes'
import { ownCheckingText, ownLapsedText, ownNotAttachedText, ownUnconfirmedText, ownWaitingText } from '../../../../shared/sharing-setup'

export type SharingPageProps = {
  /** The open piece's path in this window's Workspace. */
  piecePath: string
  pieceName: string
  collectionName: string | null
  /** Ticket 09: the page is the whole Folio's (its folder, '' the Workspace itself, and its name). */
  folio?: { dir: string; name: string } | null
  /** Show a path in Files (a missing part: its Folio's folder). */
  onShowInFiles?: (path: string, kind: 'file' | 'folder') => void
  /** Open the Plan of the Folio in `dir` (Remove from Folio). */
  onOpenPlan?: (dir: string) => void
  onBack: () => void
  onFlash: (message: string) => void
  onOpenSettings: () => void
  /** Ticket 10: the header switch to the collection's Shares list. */
  onOpenSharesList?: () => void
}

type Problem = { reason: string; fix: string }

function Switch({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean }): JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={on} className="shr-sw" disabled={disabled} onClick={() => onChange(!on)}>
      <span className="trk" aria-hidden="true" />{label}
    </button>
  )
}

/** Private notes; Open notes ships with a later release (shown, not choosable). */
function NotesSeg(): JSX.Element {
  return (
    <span className="shr-seg" role="group" aria-label="Comments are">
      <button type="button" aria-pressed="true"><Lock className="icon" aria-hidden="true" />Private comments</button>
      <button type="button" aria-pressed="false" disabled title="Open comments come in a later version of WriteFlex"><Users className="icon" aria-hidden="true" />Open comments</button>
    </span>
  )
}

export function SharingPage({ piecePath, pieceName, collectionName, folio = null, onShowInFiles, onOpenPlan, onBack, onFlash, onOpenSettings, onOpenSharesList }: SharingPageProps): JSX.Element {
  const folioDir = folio?.dir ?? null
  const thing = folio ? 'Folio' : 'piece'
  const [status, setStatus] = useState<SharingSetupStatus | null>(null)
  const [view, setView] = useState<PieceSharingView | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  const [name, setName] = useState('')
  const [comments, setComments] = useState(true)
  const [rename, setRename] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  /** Ticket 10: how many times each link was opened (the service's count), once main has bound the page. */
  const [opened, setOpened] = useState<OpenedCounts>({})
  /** Ticket 07: notes waiting and handled per link, and the Limits panel, once main has bound the page. */
  const [notes, setNotes] = useState<NotesCounts>({})
  const [bound, setBound] = useState(false)
  const page = useRef<HTMLDivElement | null>(null)
  const nameInput = useRef<HTMLInputElement | null>(null)
  const table = useRef<HTMLDivElement | null>(null)
  // Every answer belongs to the piece it was asked for. App mounts this page once per Workspace and
  // piece (its `key`), so a page whose piece changed is gone; `live` turns false with it, and an answer
  // that arrives after that (a make, a turn off, a reload still on its way) is dropped, never drawn
  // under another piece's heading.
  const live = useRef(true)
  // A Folio's out-of-step line (Folio room spec § 8 D-ORD-3): sharing publishes in the manifest's order. Read as the
  // page opens and again when its view changes; writes nothing until Make export follow the running order.
  const order = useExportOrderCheck(folioDir, view)

  const reload = useCallback(async (): Promise<PieceSharingView | null> => {
    const next = folioDir !== null ? await window.writeflex.sharing.folio(folioDir, piecePath) : await window.writeflex.sharing.piece(piecePath)
    if (!live.current) return null
    setView(next)
    return next
  }, [piecePath, folioDir])

  useEffect(() => {
    live.current = true
    // Main binds this window's link actions to this piece until the page closes (sharing-piece-ipc.ts).
    // A Folio's page also binds the open part's own piece links for Turn off and Copy link (review round 1, finding 3).
    void (folioDir !== null ? window.writeflex.sharing.openFolio(folioDir, piecePath) : window.writeflex.sharing.open(piecePath)).then((next) => {
      if (!live.current) return
      setView(next)
      setBound(true)
      if (next.links.length === 0 && !next.sourceGone) setMaking(true)
    }).catch(() => {})
    // Asking the service also checks your own address (ticket 05); the links are read again after it.
    void window.writeflex.sharing.status({ askService: true }).then((next) => {
      if (!live.current) return
      setStatus(next)
      void reload().catch(() => {})
    }).catch(() => {})
    const off = window.writeflex.sharing.onChanged(() => { void reload().catch(() => {}) })
    return () => {
      live.current = false
      off()
      void window.writeflex.sharing.close().catch(() => {})
    }
  }, [piecePath, folioDir, reload])

  // Your own address is trusted for a day after Cloudflare last confirmed it (sharing-own-address.ts THE
  // RULE). The view says when that ends; read it again then, so the address shown never outlives trust
  // with the page left open. Cleared when the view changes and when the page goes (its piece changed).
  const addressUntil = view?.addressUntil ?? null
  useEffect(() => {
    if (addressUntil === null) return
    // One millisecond past the end: at the end itself the rule no longer trusts it. setTimeout holds at
    // most about 24.8 days; a longer wait is cut to that and read again then.
    const wait = Math.min(Math.max(0, addressUntil - Date.now() + 1), 2_147_483_647)
    const timer = setTimeout(() => { void reload().catch(() => {}) }, wait)
    return () => clearTimeout(timer)
  }, [addressUntil, reload])

  useEffect(() => {
    if (making) nameInput.current?.focus()
    else if (page.current && !page.current.contains(document.activeElement)) page.current.focus()
  }, [making, status?.ready])

  const links = view?.links ?? []
  const sourceGone = view?.sourceGone === true
  /** Ticket 11: the piece's file is not on disk: "Piece not found", and no Turn on. */
  const notFound = view?.pieceNotFound === true
  // Opened counts: asked of main (which asks the service) once the page is bound, and again only on a
  // change that can move them (ticket 11, review 10 P3-2): a link made or gone, turned on or off, or a
  // publish finished. A publish step, or any other change, reads the view again but asks nothing.
  const counted = links.length + (view?.otherLinks ?? []).reduce((sum, group) => sum + group.links.length, 0)
  const countKey = openedKey([...links, ...(view?.otherLinks ?? []).flatMap((group) => group.links)])
  // Only the answer to the latest request is kept: an earlier one arriving late never overwrites it.
  const openedAsked = useRef(0)
  const notesAsked = useRef(0)
  const readNotes = useCallback(() => {
    const asked = ++notesAsked.current
    void window.writeflex.sharing.notes?.().then((counts) => { if (live.current && asked === notesAsked.current) setNotes(counts) }).catch(() => {})
  }, [])
  useEffect(() => {
    if (!bound || counted === 0) return
    const timer = setTimeout(() => {
      const asked = ++openedAsked.current
      void window.writeflex.sharing.opened().then((counts) => { if (live.current && asked === openedAsked.current) setOpened(counts) }).catch(() => {})
    }, OPENED_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [bound, counted, countKey])
  // Notes waiting and handled come from this Collection's own review list: read again on every change.
  useEffect(() => {
    if (!bound || counted === 0) return
    const timer = setTimeout(readNotes, OPENED_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [bound, counted, view, readNotes])
  const current = links.find((link) => link.shareId === selected) ?? links[0] ?? null
  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase()
    return words ? links.filter((link) => linkLabel(link).toLowerCase().includes(words)) : links
  }, [links, filter])

  const take = useCallback((result: SharingLinkResult): boolean => {
    if (!live.current) return false
    setView(result.view)
    if (result.ok) { setProblem(null); return true }
    setProblem(result.problem)
    return false
  }, [])

  const run = useCallback(async (what: string, action: () => Promise<SharingLinkResult>): Promise<SharingLinkResult | null> => {
    if (busy) return null
    setBusy(what)
    try {
      const result = await action()
      if (!live.current) return null
      take(result)
      return result
    } catch {
      if (live.current) setProblem({ reason: 'That did not go through.', fix: 'Try again.' })
      return null
    } finally {
      if (live.current) setBusy(null)
      // A button disabled while it ran drops the keyboard to the body (or keeps it on itself, disabled):
      // give it back to the page at once, so Esc and the page's keys still work, and again after the
      // next frame. At once, because a window in the background may not run frames.
      const settle = (): void => {
        const at = document.activeElement as HTMLElement | null
        if (live.current && page.current && (!page.current.contains(at) || (at as HTMLButtonElement | null)?.disabled === true)) page.current.focus()
      }
      settle()
      requestAnimationFrame(settle)
    }
  }, [busy, take])
  // Ticket 04 (R-B): the link follows its piece to the place main found; this page stays on the old place.
  const followTo = useCallback(async (link: ShareLinkView): Promise<void> => {
    const to = link.lost?.candidate
    const result = await run('follow-to', () => window.writeflex.sharing.followTo(link.shareId))
    if (!result?.ok || !live.current) return
    onFlash(`The link follows the piece to ${to}.`)
    await reload().catch(() => null)
  }, [run, onFlash, reload])

  const make = useCallback(async () => {
    const request = { name: name.trim() || null, comments }
    const result = await run('make', () => window.writeflex.sharing.make(folioDir !== null ? { ...request, folio: folioDir } : { ...request, path: piecePath }))
    if (result?.ok) {
      setMaking(false)
      setName('')
      setComments(true)
      if (result.shareId) setSelected(result.shareId)
      onFlash('Link made. Copy it to send it.')
    }
  }, [run, piecePath, folioDir, name, comments, onFlash])

  const copyAgain = useCallback(() => {
    const text = copyAgainText(view?.links ?? [])
    if (!text) return
    void window.writeflex.copyToClipboard(text, 'plain').then(() => onFlash('Copied the links on the Cloudflare address. Send them again.')).catch(() => onFlash('Could not copy the links.'))
  }, [view, onFlash])

  // Copy link (button and ⇧⌥⌘C): main decides the address at the moment of copying (THE RULE); the
  // page copies that answer, never the address in its last view, which may be days old.
  const copy = useCallback(async (link: ShareLinkView | null) => {
    if (!link) return
    try {
      const address = await window.writeflex.sharing.copyAddress(link.shareId)
      if (!address) { onFlash('Could not copy the link.'); return }
      await window.writeflex.copyToClipboard(address, 'plain')
      onFlash('Link copied')
      // The page showed another address: show the one just copied.
      if (address !== link.address) void reload().catch(() => {})
    } catch {
      onFlash('Could not copy the link.')
    }
  }, [onFlash, reload])

  const toggle = useCallback(async (link: ShareLinkView | null) => {
    // A link whose piece went away is turned off, never on (ticket 11; main refuses it too).
    if (!link || (sourceGone && !link.on)) return
    const result = await run(link.on ? 'off' : 'on', () => (link.on ? window.writeflex.sharing.turnOff(link.shareId) : window.writeflex.sharing.turnOn(link.shareId)))
    if (result?.ok) onFlash(link.on ? 'Link turned off. Readers who open it now see that it is off.' : 'Link turned on again, at the same address.')
  }, [run, onFlash, sourceGone])

  // The Limits panel (ticket 07): Clear handled notes and Raise the limit answer with a sentence;
  // Turn comments off is the link's own Readers can leave notes switch, turned off.
  const limitsAction = useCallback(async (what: 'clear' | 'raise', link: ShareLinkView) => {
    if (busy) return
    setBusy(what)
    try {
      const result: LimitsActionResult = what === 'clear' ? await window.writeflex.sharing.clearHandled(link.shareId) : await window.writeflex.sharing.raiseLimit(link.shareId)
      if (!live.current) return
      if (result.ok) { setProblem(null); onFlash(result.message) } else setProblem(result.problem)
      readNotes()
    } catch {
      if (live.current) setProblem({ reason: 'That did not go through.', fix: 'Try again.' })
    } finally {
      if (live.current) setBusy(null)
    }
  }, [busy, onFlash, readNotes])
  const commentsOff = useCallback(async (link: ShareLinkView) => {
    const result = await run('comments', () => window.writeflex.sharing.setComments(link.shareId, false))
    if (result?.ok) { onFlash('Comments are off for this link. Readers can still read it.'); readNotes() }
  }, [run, onFlash, readNotes])

  // Turn off a link of another kind the page lists (review round 1, findings 3 and 4). Its answer is
  // that link's own piece or Folio, so the page reads its own view again rather than drawing that one.
  const turnOffOther = useCallback(async (link: ShareLinkView) => {
    if (busy) return
    setBusy('off')
    try {
      const result = await window.writeflex.sharing.turnOff(link.shareId)
      if (!live.current) return
      if (result.ok) { setProblem(null); onFlash('Link turned off. Readers who open it now see that it is off.') } else setProblem(result.problem)
      await reload()
    } catch {
      if (live.current) setProblem({ reason: 'That did not go through.', fix: 'Try again.' })
    } finally {
      if (live.current) setBusy(null)
    }
  }, [busy, onFlash, reload])
  const otherLinks = view?.otherLinks ?? []

  // The row Tab reaches: the selected one, or the first shown when a search hides it.
  const tabRow = shown.some((link) => link.shareId === current?.shareId) ? current?.shareId : shown[0]?.shareId
  const select = useCallback((shareId: string) => { setSelected(shareId); setRename(null) }, [])

  /** The links as a list (the Skills manager's rows): Tab reaches the selected row, ↑ ↓ Home End move
   *  to another and select it, Enter or Space selects the row that has the keyboard. */
  const onRowKey = useCallback((event: KeyboardEvent<HTMLDivElement>, shareId: string) => {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(shareId); return }
    const at = shown.findIndex((link) => link.shareId === shareId)
    const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 : null
    if (to === null) return
    event.preventDefault()
    const next = shown[Math.max(0, Math.min(shown.length - 1, to))]
    if (!next) return
    select(next.shareId)
    table.current?.querySelector<HTMLElement>(`[data-share="${next.shareId}"]`)?.focus()
  }, [shown, select])

  const cancelMaking = useCallback(() => {
    if (links.length === 0) onBack()
    else { setMaking(false); setName('') }
  }, [links.length, onBack])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault()
      if (rename !== null) setRename(null)
      else if (making) cancelMaking()
      else onBack()
      return
    }
    if (mod && event.key === 'Enter' && making) { event.preventDefault(); void make(); return }
    if (!mod || !event.altKey) return
    if (event.code === 'KeyL' && !event.shiftKey) { event.preventDefault(); if (!sourceGone) setMaking(true) }
    else if (event.code === 'KeyC' && event.shiftKey) { event.preventDefault(); void copy(current) }
    else if (event.code === 'KeyO' && !event.shiftKey) { event.preventDefault(); void toggle(current) }
  }, [rename, making, cancelMaking, onBack, make, copy, current, toggle, sourceGone])

  // Not set up on this Mac: the set-up steps in place, then back to this page.
  if (status !== null && !status.ready) {
    return (
      <SharingSetup
        pieceName={pieceName}
        onBack={onBack}
        onFlash={onFlash}
        onOpenSettings={onOpenSettings}
        onDone={(next) => { setStatus(next); void reload().then((again) => { if (again) setMaking(again.links.length === 0) }) }}
        initial={{ status }}
      />
    )
  }

  const rows = problemRows(status)
  const parts = view?.folio?.parts ?? []
  const missing = parts.filter((part) => part.missing)
  const partsWord = parts.length === 1 ? '1 part' : `${parts.length} parts`
  const sub = folio ? (parts.length > 0 ? `Folio · ${folio.name} · ${partsWord}` : `Folio · ${folio.name}`) : collectionName ? `${pieceName} · ${collectionName}` : pieceName
  const state = current ? linkState(current) : null
  const readersTitle = folio ? folio.name : pieceName

  return (
    <div className="shr-overlay" data-testid="sharing-page" ref={page} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="shr-head">
        <button type="button" className="shr-btn" onClick={onBack}><ArrowLeft className="icon" aria-hidden="true" />Back to text<kbd>⌥⌘S</kbd></button>
        <div className="shr-title">
          <h2>Sharing</h2>
          <span className="shr-sub">{sub}</span>
        </div>
        <span className="grow" />
        {onOpenSharesList && (
          <span className="shr-seg" role="group" aria-label="Sharing for">
            <button type="button" aria-pressed="true">{folio ? <Layers className="icon" aria-hidden="true" /> : <FileText className="icon" aria-hidden="true" />}This {thing}</button>
            <button type="button" aria-pressed="false" onClick={onOpenSharesList}><List className="icon" aria-hidden="true" />{collectionName ? `${collectionName} · Shares list` : 'Shares list'}</button>
          </span>
        )}
      </header>
      <div className="shr-body">
        <section className="shr-left" aria-label={`Links for this ${thing}`}>
          {problem && (
            <div className="shr-errbox" role="alert">
              <X className="icon" aria-hidden="true" />
              <div><b>{problem.reason}</b><div className="shr-p">{problem.fix}</div></div>
            </div>
          )}
          {making && (
            <div className="shr-panel" data-testid="sharing-make-link">
              <div className="shr-panel-h"><Plus className="icon" aria-hidden="true" /><span>Make a link for this {thing}</span></div>
              <div className="shr-panel-b" style={{ gap: 14 }}>
                <div>
                  <span className="shr-lbl" id="shr-link-name">Name · optional</span>
                  <label className="shr-inp" style={{ maxWidth: 360 }}>
                    <input ref={nameInput} aria-labelledby="shr-link-name" placeholder="For example Marta or Workshop group" value={name} maxLength={60}
                      onChange={(event) => setName(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); void make() } }} />
                  </label>
                  <div className="shr-p shr-dim" style={{ marginTop: 4 }}>Shown on this link’s comments in the margin. Without a name the link is listed by its settings and the date it was made.</div>
                </div>
                <div className="shr-row" style={{ gap: 22, alignItems: 'flex-start' }}>
                  <div><span className="shr-lbl">Readers</span><Switch on={comments} label="Readers can leave comments" onChange={setComments} /></div>
                  <div><span className="shr-lbl">Comments are</span><NotesSeg /></div>
                </div>
                <div className="shr-p shr-dim">Private: each reader sees only their own comments and your replies. Open comments, where every reader sees all comments, come in a later version.</div>
                <div className="shr-row">
                  <button type="button" className="shr-btn primary" disabled={busy === 'make'} onClick={() => void make()}><Link className="icon" aria-hidden="true" />{busy === 'make' ? 'Making the link…' : 'Make a link'}<kbd>⌘↵</kbd></button>
                  <button type="button" className="shr-btn" onClick={cancelMaking}><X className="icon" aria-hidden="true" />Cancel<kbd>Esc</kbd></button>
                </div>
              </div>
            </div>
          )}
          <div className="shr-panel" data-testid="sharing-links">
            <div className="shr-panel-h">
              <Link className="icon" aria-hidden="true" /><span>Links for this {thing}</span><span className="grow" />
              {links.length > 0 && !making && !sourceGone && <button type="button" className="shr-btn primary small" onClick={() => setMaking(true)}><Plus className="icon" aria-hidden="true" />Make a link<kbd>⌥⌘L</kbd></button>}
            </div>
            {links.length === 0 ? (
              <div className="shr-empty"><span className="shr-chip off"><Minus className="icon" aria-hidden="true" />None yet</span><span className="shr-p">This {thing} has not been shared. Nothing has left this Mac.</span></div>
            ) : (
              <>
                {links.length > 1 && (
                  <div className="shr-tools">
                    <label className="shr-inp"><Search className="icon" aria-hidden="true" /><input aria-label="Search links by name" placeholder="Search links by name" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
                  </div>
                )}
                <div className="shr-tbl" role="table" aria-label="Links" ref={table}>
                  <div className="shr-tr th" role="row"><span role="columnheader">Name</span><span role="columnheader">Settings</span><span role="columnheader">State</span><span role="columnheader">Opened</span><span role="columnheader">Comments waiting</span><span role="columnheader">On / off</span></div>
                  {shown.map((link) => (
                    <div key={link.shareId} role="row" data-share={link.shareId} className={`shr-tr${current?.shareId === link.shareId ? ' sel' : ''}${link.on ? '' : ' off'}`}
                      tabIndex={tabRow === link.shareId ? 0 : -1} aria-selected={current?.shareId === link.shareId}
                      onClick={() => select(link.shareId)} onKeyDown={(event) => onRowKey(event, link.shareId)}>
                      <span className="shr-nm" role="cell">{linkLabel(link)}</span>
                      <span className="shr-cellset" role="cell">{link.comments ? <Lock className="icon" aria-hidden="true" /> : <MessageSquareOff className="icon" aria-hidden="true" />}{linkSettingsLabel(link)}</span>
                      <span role="cell"><StateChip link={link} limit={notes[link.shareId]?.limit !== null && notes[link.shareId]?.limit !== undefined} /></span>
                      <span role="cell" className="shr-num" data-opened={link.shareId}>{openedLabel(opened[link.shareId])}</span>
                      <WaitingCell count={notes[link.shareId]?.waiting} shareId={link.shareId} />
                      <span role="cell" onClick={(event) => event.stopPropagation()}><Switch on={link.on} label={link.on ? 'On' : 'Off'} disabled={busy !== null || (sourceGone && !link.on)} onChange={() => void toggle(link)} /></span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          {current && (
            <div className="shr-panel shr-detail-wrap" data-testid="sharing-link-detail">
              <div className="shr-panel-h"><SlidersHorizontal className="icon" aria-hidden="true" /><span>Link: {linkLabel(current)}</span><span className="grow" /><StateChip link={current} limit={!!notes[current.shareId]?.limit} /></div>
              <div className="shr-detail">
                <div className="shr-detail-main">
                  <div>
                    <span className="shr-lbl">Address</span>
                    <div className="shr-row">
                      <div className="shr-inp mono" style={{ flex: 1 }}><Link className="icon" aria-hidden="true" /><span className="shr-tx" data-testid="sharing-address">{bareAddress(current.address)}</span></div>
                      <button type="button" className="shr-btn primary" onClick={() => void copy(current)}><Copy className="icon" aria-hidden="true" />Copy link<kbd>⇧⌥⌘C</kbd></button>
                    </div>
                  </div>
                  <div>
                    <span className="shr-lbl" id="shr-rename">Name of this link · optional</span>
                    <div className="shr-row">
                      <label className="shr-inp" style={{ flex: 1 }}>
                        <input aria-labelledby="shr-rename" placeholder="No name" maxLength={60} value={rename ?? current.name ?? ''} onChange={(event) => setRename(event.target.value)}
                          onKeyDown={(event) => { if (event.key === 'Enter' && rename !== null) { event.preventDefault(); void run('rename', () => window.writeflex.sharing.rename(current.shareId, rename)).then(() => setRename(null)) } }} />
                      </label>
                      <button type="button" className="shr-btn" disabled={rename === null || busy !== null} onClick={() => void run('rename', () => window.writeflex.sharing.rename(current.shareId, rename ?? '')).then(() => setRename(null))}>
                        <Pencil className="icon" aria-hidden="true" />{current.name ? 'Rename' : 'Add a name'}
                      </button>
                    </div>
                  </div>
                  <div>
                    <span className="shr-lbl">Settings</span>
                    <div className="shr-row" style={{ gap: 14 }}>
                      <Switch on={current.comments} label="Readers can leave comments" disabled={busy !== null} onChange={(next) => void run('comments', () => window.writeflex.sharing.setComments(current.shareId, next))} />
                      <NotesSeg />
                    </div>
                  </div>
                </div>
                <div className="shr-detail-side">
                  <span className="shr-lbl">This link</span>
                  <div className="shr-pair"><span className="shr-k">Made</span><span className="shr-v">{shortTime(current.madeAt)}</span></div>
                  <div className="shr-pair"><span className="shr-k">Last published</span><span className="shr-v" data-testid="sharing-last-published">{current.publishedAt ? shortTime(current.publishedAt) : 'Not yet'}</span></div>
                  <div className="shr-pair"><span className="shr-k">Opened</span><span className="shr-v" data-testid="sharing-opened">{openedTimes(opened[current.shareId])}</span></div>
                  <div className="shr-pair"><span className="shr-k">Comments waiting</span><span className="shr-v" data-testid="sharing-notes-waiting">{countLabel(notes[current.shareId]?.waiting)}</span></div>
                  <div className="shr-pair"><span className="shr-k">Comments handled</span><span className="shr-v" data-testid="sharing-notes-handled">{countLabel(notes[current.shareId]?.handled)}</span></div>
                </div>
              </div>
              <div className="shr-detail-foot">
                <button type="button" className="shr-btn" disabled={busy !== null || (sourceGone && !current.on)} onClick={() => void toggle(current)}>
                  {current.on ? <PowerOff className="icon" aria-hidden="true" /> : <Power className="icon" aria-hidden="true" />}{current.on ? 'Turn off' : 'Turn on'}<kbd>⌥⌘O</kbd>
                </button>
                {!sourceGone && <button type="button" className="shr-btn" onClick={() => setMaking(true)}><Plus className="icon" aria-hidden="true" />Make another link<kbd>⌥⌘L</kbd></button>}
              </div>
            </div>
          )}
          {folio && parts.length > 0 && (
            <div className="shr-panel" data-testid="sharing-folio-parts">
              <div className="shr-panel-h"><Layers className="icon" aria-hidden="true" /><span>Parts of this Folio, in running order</span></div>
              <ol className="shr-parts">
                {parts.map((part, index) => (
                  <li key={`${index}:${part.path}`} className={part.missing ? 'missing' : ''} data-part-state={part.missing ? 'missing' : 'published'}>
                    <span className="n">{index + 1}</span>
                    <span className="t">{part.title}</span>
                    {part.missing
                      ? <span className="shr-chip warn"><FileWarning className="icon" aria-hidden="true" />Missing on disk</span>
                      : <span className="shr-chip ok"><CircleCheck className="icon" aria-hidden="true" />Published</span>}
                  </li>
                ))}
              </ol>
              <p className="shr-p shr-dim shr-parts-foot">Readers see the parts in this order with a contents list. A part missing on disk shows its title with “not available”.</p>
            </div>
          )}
          {otherLinks.map((group) => (
            <OtherLinksPanel key={`${group.kind}:${group.path}`} group={group} busy={busy !== null} onCopy={(link) => void copy(link)} onTurnOff={(link) => void turnOffOther(link)} />
          ))}
        </section>
        <aside className="shr-right">
          {folio && <ShareOrderPanel state={order} />}
          {folio && missing.length > 0 && current?.on && (
            <div className="shr-panel problem" data-problem="part-missing">
              <div className="shr-panel-h"><TriangleAlert className="icon" aria-hidden="true" /><span>{missing.length === 1 ? 'A part is missing' : 'Parts are missing'}</span></div>
              <div className="shr-panel-b">
                <p className="shr-p" data-testid="sharing-part-missing">
                  {/* The file name in bold, as the frame draws it; the sentence is partMissingText's. */}
                  {missing.length === 1 ? <><b>{missing[0].fileName}</b>{partMissingText(missing, parts.length).slice(missing[0].fileName.length)}</> : partMissingText(missing, parts.length)}
                </p>
                <div className="shr-row">
                  {onShowInFiles && <button type="button" className="shr-btn small" onClick={() => onShowInFiles(folio.dir, 'folder')}><FolderOpen className="icon" aria-hidden="true" />Show in Files</button>}
                  {onOpenPlan && <button type="button" className="shr-btn small" onClick={() => onOpenPlan(folio.dir)}><X className="icon" aria-hidden="true" />Remove from Folio</button>}
                </div>
              </div>
            </div>
          )}
          <SharingProblemRows rows={rows} busy={false} onPasteToken={onOpenSettings} onUpdate={onOpenSettings} />
          {view?.ownAddress?.state === 'lapsed' && (
            <div className="shr-panel problem bad" data-problem="own-address-lapsed">
              <div className="shr-panel-h"><Globe className="icon" aria-hidden="true" /><span>Own address not answering</span></div>
              <div className="shr-panel-b">
                <p className="shr-p">{ownLapsedText(view.ownAddress.hostname)}</p>
                <div className="shr-row">
                  {links.some((link) => link.on) && <button type="button" className="shr-btn primary small" onClick={copyAgain}><Copy className="icon" aria-hidden="true" />Copy the links again on the Cloudflare address</button>}
                  <button type="button" className="shr-btn small" onClick={onOpenSettings}><Settings className="icon" aria-hidden="true" />Settings › Sharing</button>
                </div>
              </div>
            </div>
          )}
          {current?.ended && (
            <div className="shr-panel problem" data-problem="ended-by-trash">
              <div className="shr-panel-h"><PowerOff className="icon" aria-hidden="true" /><span>{current.ended.back ? 'Back from the Trash' : 'Piece in the Trash'}</span></div>
              <div className="shr-panel-b">
                <p className="shr-p">{current.ended.back ? ENDED_BACK : current.ended.removed ? ENDED_BY_TRASH : ENDED_REMOVAL_OWED}</p>
                {current.ended.back && !current.on && (
                  <div className="shr-row">
                    <button type="button" className="shr-btn primary small" disabled={busy !== null} onClick={() => void run('turn-on', () => window.writeflex.sharing.turnOn(current.shareId))}>
                      <Power className="icon" aria-hidden="true" />Turn on again
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
          {(current?.lost || (notFound && current && !current.on)) && (
            <PieceNotFoundPanel link={current} where={`this ${thing}`} busy={busy !== null} offNotFound={notFound}
              onTurnOff={() => void run('turn-off', () => window.writeflex.sharing.turnOff(current.shareId))}
              onFollow={() => void followTo(current)} />
          )}
          {current?.problem && current.on && !current.ended && !current.lost && (
            <div className="shr-panel problem" data-problem="not-published">
              <div className="shr-panel-h"><CloudOff className="icon" aria-hidden="true" /><span>Not published</span></div>
              <div className="shr-panel-b">
                <p className="shr-p">{notPublishedText(current)}</p>
                <div className="shr-row">
                  <button type="button" className="shr-btn primary small" disabled={busy !== null} onClick={() => void run('retry', () => window.writeflex.sharing.retry(current.shareId))}>
                    <RefreshCw className="icon" aria-hidden="true" />{busy === 'retry' ? 'Publishing…' : 'Retry'}
                  </button>
                </div>
              </div>
            </div>
          )}
          {current && notes[current.shareId]?.limit && (
            <LimitsPanel linkName={linkLabel(current)} limit={notes[current.shareId]!.limit!} comments={current.comments} busy={busy}
              onClear={() => void limitsAction('clear', current)} onRaise={() => void limitsAction('raise', current)} onCommentsOff={() => void commentsOff(current)} />
          )}
          <div className="shr-panel" data-testid="sharing-publishing">
            <div className="shr-panel-h"><FileText className="icon" aria-hidden="true" /><span>Publishing</span></div>
            <div className="shr-panel-b">
              <div className="shr-kv"><span className="shr-k">State</span><span className="shr-v">{current ? <StateChip link={current} /> : <span className="shr-chip off"><Minus className="icon" aria-hidden="true" />Nothing published</span>}</span></div>
              <div className="shr-kv"><span className="shr-k">Last published</span><span className="shr-v">{current?.publishedAt ? shortTime(current.publishedAt) : 'Nothing yet'}</span></div>
              <div className="shr-kv"><span className="shr-k">Publishing from</span><span className="shr-v">This Mac</span></div>
              {current?.note && <p className="shr-p shr-dim" data-testid="sharing-publish-note">{current.note}</p>}
            </div>
          </div>
          <div className="shr-panel">
            <div className="shr-panel-h"><Globe className="icon" aria-hidden="true" /><span>Your address</span></div>
            <div className="shr-panel-b">
              <div className="shr-kv"><span className="shr-k">Links read</span><span className="shr-v" style={{ fontFamily: 'var(--mono)' }} data-testid="sharing-links-address">{view?.address ? bareAddress(view.address) : '…'}</span></div>
              {view?.ownAddress?.state === 'attached' && view.cloudflareAddress && <p className="shr-p shr-dim">Links sent on {bareAddress(view.cloudflareAddress)} still open.</p>}
              {view?.ownAddress?.state === 'waiting' && <p className="shr-p shr-dim">{ownWaitingText(view.ownAddress.hostname)}</p>}
              {view?.ownAddress?.state === 'not-attached' && <p className="shr-p" data-testid="sharing-own-not-attached">{ownNotAttachedText(view.ownAddress.hostname, 'settings')}</p>}
              {view?.ownAddress?.state === 'checking' && <p className="shr-p shr-dim" data-testid="sharing-own-checking">{ownCheckingText(view.ownAddress.hostname)}</p>}
              {view?.ownAddress?.state === 'unconfirmed' && <p className="shr-p" data-testid="sharing-own-unconfirmed">{ownUnconfirmedText(view.ownAddress.hostname)}</p>}
              <div className="shr-row"><button type="button" className="shr-btn small" onClick={onOpenSettings}><Settings className="icon" aria-hidden="true" />{view?.ownAddress ? 'Change in Settings' : 'Use your own address'}</button></div>
            </div>
          </div>
          {current && state && state.kind !== 'off' && (
            <div className="shr-panel">
              <div className="shr-panel-h"><Monitor className="icon" aria-hidden="true" /><span>What readers see</span></div>
              <div className="shr-panel-b">
                <div className="shr-preview">
                  <h4>{readersTitle}</h4>
                  <p>{updatedLabel(current.publishedSavedAt)} · {current.comments ? 'comments in the margin · private comments' : 'comments off'}</p>
                </div>
                <div className="shr-row"><button type="button" className="shr-btn small" onClick={() => void window.writeflex.sharing.openLink(current.shareId)}><ExternalLink className="icon" aria-hidden="true" />Open the link in your browser</button></div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
