// The floating Scratchpad panel (ADR-0050, ticket 01): set-aside text to read, sort and reuse. Floating
// over the text (the header drags it, the corner resizes it), docked as the right rail's Scratchpad tab,
// or collapsed to a pill. The geometry and list mechanics follow TalkWeaver's Slide Scratchpad (994e5981);
// the item model is WriteFlex's formatted text. Content changes go through the handlers App supplies
// (the controller and the bridge); this component only decides what is shown.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { GripVertical, Search } from 'lucide-react'
import {
  daySections, defaultPartName, effectiveScope, inFolder, isPlaced, listCounts, parseQuery, sourceItemOf, toggleKindInQuery, visibleItems,
  type GroupFilter, type ScratchItem, type ScratchList, type ScratchReferenceAction, type ScratchScope, type ScratchSnapshot, type ScratchSource,
} from '../../../../shared/scratchpad-items'
import type { ScratchBox } from '../../../../shared/scratchpad-layout'
import type { ScratchpadLayoutApi } from '../../scratchpad/useScratchpadLayout'
import { ItemActions, PlacementNote, ScratchpadCard, ScratchpadCompare, ScratchpadPreview, type ItemActionHandlers, type Placement, type ScratchPlace } from './ScratchpadParts'
import { ScratchpadExternalBrowser } from './ScratchpadExternal'

export type ScratchpadPanelHandlers = {
  show?: (item: ScratchItem) => void
  showAt?: (item: ScratchItem, position: number) => void
  collect?: (item: ScratchItem) => void
  collectSource?: (item: ScratchItem) => void
  reference?: (item: ScratchItem, action: ScratchReferenceAction) => void
  insert: (item: ScratchItem, mode: 'copy' | 'put-back') => void
  setStatus: (ids: string[], status: 'active' | 'rejected') => Promise<boolean>
  setGroup: (ids: string[], group: string | null) => Promise<boolean>
  createGroup: (name: string) => Promise<{ id: string; name: string } | null>
  toggleDone: (item: ScratchItem) => void
  setColour: (item: ScratchItem, colour: string | null) => void
  /** Delete forever, after this panel's confirmation; main re-checks before removing. */
  deleteForever: (item: ScratchItem) => Promise<boolean>
  /** Change place: navigate the editor to a part's end. Navigation only; never writes. */
  changePlace?: (path: string) => void
  say: (message: string) => void
}

/** The panel's own actions as the registered commands reach them (ticket 04): filled each render, so
 *  a palette or shortcut command acts on the selection, ticks and list as they stand. */
export type ScratchpadPanelCommands = {
  compareTicked: () => void
  previewSelected: () => void
  putBackSelected: () => void
  rejectSelected: () => void
  moveBackSelected: () => void
  toggleDoneSelected: () => void
  focusSearch: () => void
}

const LIST_LABEL: Record<ScratchList, string> = { candidates: 'Candidates', document: 'In this document', rejected: 'Rejected' }
const LISTS: ScratchList[] = ['candidates', 'document', 'rejected']
const plural = (n: number): string => (n === 1 ? '1 item' : `${n} items`)

export function ScratchpadPanel({
  layout, snapshot, loadError, activePath, root = null, showingSource = false, inventory = [], sources = [], inventoryNotices = [], onDocumentScope, assetBaseUrl, partName = defaultPartName, placement, focusTick, handlers, docked, selectionRef, pillRight = 20, places = [], avoidTop = null, commandRef, externalSources = null, onOpenSettings,
}: {
  showingSource?: boolean
  root?: string | null
  /** Canonical Folio sources not yet collected, shown as collectable candidate cards. */
  sources?: ScratchSource[]
  inventory?: ScratchItem[]
  inventoryNotices?: string[]
  onDocumentScope?: (scope: 'part' | 'folio') => void
  layout: ScratchpadLayoutApi
  snapshot: ScratchSnapshot
  loadError: string | null
  activePath: string | null
  assetBaseUrl: string | null
  partName?: (path: string) => string
  /** Where an insert would land now (the live caret), or null when no document has a caret. */
  placement: Placement
  /** Bumped by ⇧⌘J: the keyboard lands in search. */
  focusTick: number
  handlers: ScratchpadPanelHandlers
  /** Rendered inside the rail tab rather than over the text. */
  docked: boolean
  /** Kept up to date with the item the panel has selected, for the Insert a copy command. */
  selectionRef?: MutableRefObject<string | null>
  /** The collapsed pill's distance from the window's right edge (clear of the right rail). */
  pillRight?: number
  /** The parts Change place can navigate to (the Folio's running order, or the open document). */
  places?: readonly ScratchPlace[]
  /** Keep the floating panel's top at or below this y (the saved-version banner's bottom), so its
   *  Return to current button stays reachable while the panel floats (ticket 04 carry-forward). */
  avoidTop?: number | null
  /** Filled each render with the actions the registered Scratchpad commands run. */
  commandRef?: MutableRefObject<ScratchpadPanelCommands | null>
  /** The Settings › Scratchpad switches (ticket 05): a source tab exists only for a source
   *  that is on; with both off there are no source tabs and no wording about either app. */
  externalSources?: { talkweaver: boolean; slidewell: boolean } | null
  /** Open Settings at its Scratchpad section (an unavailable source tab's way out). */
  onOpenSettings?: () => void
}): JSX.Element {
  const { items, groups, notices, folioDir } = snapshot
  // Uncollected canonical sources sit beside the collected candidates as pointer cards.
  const canonicalCards = useMemo(() => sources.filter((source) => !source.collectedId).map(sourceItemOf), [sources])
  const pool = useMemo(() => [...items, ...canonicalCards], [items, canonicalCards])
  const [scope, setScope] = useState<ScratchScope>('folio')
  // Source tabs exist only while a connection is on; turning the shown one off returns here.
  const [sourceTab, setSourceTab] = useState<'folio' | 'talkweaver' | 'slidewell'>('folio')
  useEffect(() => {
    if (sourceTab === 'talkweaver' && !externalSources?.talkweaver) setSourceTab('folio')
    if (sourceTab === 'slidewell' && !externalSources?.slidewell) setSourceTab('folio')
  }, [externalSources, sourceTab])
  const [list, setList] = useState<ScratchList>('candidates')
  const [docScope, setDocScope] = useState<'part' | 'folio'>('part')
  const [group, setGroup] = useState<GroupFilter>('all')
  const [query, setQuery] = useState('')
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [single, setSingle] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [compareIds, setCompareIds] = useState<string[] | null>(null)
  // Keep the reviewed item/version fixed while the dialog is open; list refreshes cannot re-authorise it.
  const [confirmItem, setConfirmItem] = useState<ScratchItem | null>(null)
  const [pulse, setPulse] = useState(false)
  const [menu, setMenu] = useState<null | 'scope' | 'filter' | { move: string[] } | 'new'>(null)
  const [newName, setNewName] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)

  useEffect(() => { if (focusTick > 0) searchRef.current?.focus() }, [focusTick])
  useEffect(() => { if (selectionRef) selectionRef.current = previewId ?? single }, [selectionRef, previewId, single])
  // A choice that points at something gone is dropped.
  useEffect(() => {
    const ids = new Set([...pool, ...inventory].map((i) => i.id))
    setTicked((t) => (t.size === 0 || [...t].every((id) => ids.has(id)) ? t : new Set([...t].filter((id) => ids.has(id)))))
    setSingle((s) => (s && !ids.has(s) ? null : s))
    setPreviewId((p) => (p && !ids.has(p) ? null : p))
    setCompareIds((c) => {
      if (!c) return c
      const kept = c.filter((id) => ids.has(id))
      return kept.length >= 2 ? (kept.length === c.length ? c : kept) : null
    })
    setConfirmItem((item) => (item && !ids.has(item.id) ? null : item))
  }, [pool, inventory])
  useEffect(() => { if (group !== 'all' && group !== 'ungrouped' && !groups.some((g) => g.id === group)) setGroup('all') }, [groups, group])

  const shownScope = effectiveScope(scope, folioDir)
  const context = { scope, activePath, folioDir }
  const counts = useMemo(() => listCounts(pool, context), [pool, scope, activePath, folioDir]) // eslint-disable-line react-hooks/exhaustive-deps
  const placedHere = (item: ScratchItem): boolean => item.uses.some((use) => use.mode === 'put-back' && (docScope === 'folio' && folioDir !== null ? inFolder(use.path, folioDir) : use.path === activePath))
  const visible = useMemo(() => {
    if (list !== 'document') return visibleItems(pool, { ...context, list, group, query })
    return visibleItems([...inventory, ...items.filter((item) => isPlaced(item) && placedHere(item))], { ...context, scope: 'workspace', list, group, query })
  }, [items, pool, inventory, list, group, query, scope, activePath, folioDir, docScope]) // eslint-disable-line react-hooks/exhaustive-deps
  const documentCount = useMemo(() => inventory.length + items.filter((item) => item.status === 'active' && isPlaced(item) && placedHere(item)).length, [items, inventory, activePath, folioDir, docScope]) // eslint-disable-line react-hooks/exhaustive-deps
  const sections = useMemo(() => daySections(visible), [visible])
  const terms = useMemo(() => parseQuery(query).terms, [query])
  const byId = useMemo(() => new Map([...pool, ...inventory].map((i) => [i.id, i])), [pool, inventory])
  const groupOf = (id: string | null) => groups.find((g) => g.id === id) ?? null

  const targetIds = (): string[] => (ticked.size > 0 ? [...ticked] : single ? [single] : [])
  const clearSelection = (): void => { setTicked(new Set()); setSingle(null); setMenu(null) }
  const reject = (ids: string[]): void => { void handlers.setStatus(ids, 'rejected').then((ok) => { if (ok) { handlers.say(`Rejected ${ids.length}. Nothing was deleted.`); clearSelection(); setPreviewId(null) } }) }
  const moveBack = (ids: string[]): void => { void handlers.setStatus(ids, 'active').then((ok) => { if (ok) { handlers.say(`Moved ${ids.length} back to Candidates.`); clearSelection(); setPreviewId(null) } }) }
  const moveTo = (ids: string[], target: string | null): void => {
    void handlers.setGroup(ids, target).then((ok) => {
      if (ok) { handlers.say(`Moved ${ids.length} to ${target ? groupOf(target)?.name ?? 'the group' : 'Ungrouped'}.`); setMenu(null); setTicked(new Set()) }
    })
  }
  const makeGroup = (ids: string[]): void => {
    const name = newName.trim()
    if (!name) return
    void handlers.createGroup(name).then((made) => {
      if (!made) return
      setNewName('')
      handlers.say(`Created the group ${made.name}.`)
      if (ids.length) moveTo(ids, made.id)
      else setMenu(null)
    })
  }
  const focusCard = (id: string | null): void => {
    if (!id) return
    const target = (): HTMLElement | null | undefined => panelRef.current?.querySelector<HTMLElement>(`[data-item="${id.replace(/["\\]/g, '\\$&')}"]`)
    const existing = target()
    if (existing) existing.focus()
    else requestAnimationFrame(() => target()?.focus())
  }
  const closePreview = (): void => { const id = previewId; setPreviewId(null); focusCard(id) }
  const closeCompare = (): void => { const id = compareIds?.[0] ?? null; setCompareIds(null); focusCard(id) }
  const openCompare = (): void => {
    const tickedVisible = visible.filter((item) => ticked.has(item.id))
    const chosen = tickedVisible.length > 0 ? tickedVisible : [...ticked].flatMap((id) => { const item = byId.get(id); return item ? [item] : [] })
    if (chosen.length < 2) { handlers.say('Compare takes 2 to 4 items. Tick at least two first.'); return }
    if (chosen.length > 4) { handlers.say('Compare side by side takes 2 to 4 items. Untick some to compare.'); return }
    setCompareIds(chosen.map((item) => item.id))
  }
  const takeOut = (item: ScratchItem): void => {
    setCompareIds((current) => {
      if (!current) return current
      const kept = current.filter((id) => id !== item.id)
      return kept.length >= 2 ? kept : null
    })
  }
  const confirmDelete = (item: ScratchItem): void => {
    void handlers.deleteForever(item).then((ok) => {
      setConfirmItem(null)
      if (ok) {
        handlers.say('Deleted forever. This cannot be undone.')
        setTicked((t) => { const next = new Set(t); next.delete(item.id); return next })
        if (single === item.id) setSingle(null)
        if (previewId === item.id) setPreviewId(null)
      }
    })
  }
  const itemHandlers: ItemActionHandlers = {
    show: handlers.show,
    showAt: handlers.showAt,
    collect: handlers.collect,
    collectSource: handlers.collectSource,
    reference: handlers.reference,
    insert: handlers.insert,
    toggleDone: handlers.toggleDone,
    setColour: handlers.setColour,
    reject,
    moveBack,
    openMove: (ids) => setMenu({ move: ids }),
    deleteForever: (item) => setConfirmItem(item),
  }

  // The registered commands act here, on the selection and ticks as they stand (ticket 04).
  if (commandRef) {
    const chosenItem = (): ScratchItem | null => (previewId ? byId.get(previewId) ?? null : null) ?? (single ? byId.get(single) ?? null : null)
    commandRef.current = {
      compareTicked: openCompare,
      previewSelected: () => { const item = chosenItem(); if (!item) { handlers.say('Select a Scratchpad item first, then open its big preview.'); return } setSingle(item.id); setPreviewId(item.id) },
      putBackSelected: () => { const item = chosenItem(); if (!item) { handlers.say('Select a Scratchpad item first, then put it back.'); return } handlers.insert(item, 'put-back') },
      rejectSelected: () => { const ids = targetIds(); if (ids.length === 0) { handlers.say('Select or tick Scratchpad items first, then reject them.'); return } reject(ids) },
      moveBackSelected: () => { const ids = targetIds(); if (ids.length === 0) { handlers.say('Select or tick rejected items first, then move them back.'); return } moveBack(ids) },
      toggleDoneSelected: () => { const item = chosenItem(); if (!item) { handlers.say('Select a Scratchpad item first, then mark it done.'); return } handlers.toggleDone(item) },
      focusSearch: () => searchRef.current?.focus(),
    }
  }

  const onCardKey = (item: ScratchItem) => (event: KeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      const index = visible.findIndex((entry) => entry.id === item.id)
      const next = visible[index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1)]
      if (next) { event.preventDefault(); setSingle(next.id); focusCard(next.id) }
      return
    }
    if ((item.source === 'document' || item.source === 'canonical') && (event.key === 'Backspace' || event.key === 'Delete' || event.key === ' ')) return
    if (event.key === 'Enter') { event.preventDefault(); setSingle(item.id); setPreviewId(item.id) }
    else if (event.key === ' ') { event.preventDefault(); setTicked((t) => { const next = new Set(t); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next }) }
    else if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); if (item.status === 'rejected') moveBack([item.id]); else reject([item.id]) }
  }

  // ── geometry: header drag and corner resize (floating only) ──
  const drag = (kind: 'move' | 'resize') => (event: ReactPointerEvent<HTMLElement>): void => {
    if (layout.layout.mode !== 'float' || event.button !== 0) return
    if (kind === 'move' && (event.target as HTMLElement).closest('button, input, select, [role="menu"]')) return
    event.preventDefault()
    const start = { x: event.clientX, y: event.clientY, box: layout.layout.box }
    const next = (e: PointerEvent): ScratchBox => kind === 'move'
      ? { ...start.box, x: start.box.x + e.clientX - start.x, y: start.box.y + e.clientY - start.y }
      : { ...start.box, w: start.box.w + e.clientX - start.x, h: start.box.h + e.clientY - start.y }
    const onMove = (e: PointerEvent): void => layout.setBox(next(e), false)
    const onUp = (e: PointerEvent): void => {
      layout.setBox(next(e), true)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const activeCount = counts.candidates + documentCount
  // A new arrival pulses the collapsed pill (design state 1): the count rose while it was a pill.
  const pillCount = useRef<number | null>(null)
  useEffect(() => {
    if (layout.layout.mode !== 'collapsed') { pillCount.current = activeCount; return }
    if (pillCount.current !== null && activeCount > pillCount.current) {
      setPulse(true)
      const timer = setTimeout(() => setPulse(false), 1600)
      pillCount.current = activeCount
      return () => clearTimeout(timer)
    }
    pillCount.current = activeCount
  }, [activeCount, layout.layout.mode])
  if (layout.layout.mode === 'collapsed') {
    return (
      <button type="button" className={`sp-pill${pulse ? ' pulse' : ''}`} style={{ right: pillRight }} onClick={layout.expand} title="Show the Scratchpad (⇧⌘J)">
        Scratchpad · {activeCount} <span className="sp-pill-expand">Expand</span>
      </button>
    )
  }

  const box = layout.layout.box
  const scopeLabel = shownScope === 'workspace' ? 'Everything in this workspace'
    : shownScope === 'folio' ? `Folio: ${folioDir === '' ? 'this workspace' : (folioDir ?? '').split('/').pop()}`
    : `Document: ${activePath ? activePath.split('/').pop() : 'none open'}`
  const preview = previewId ? byId.get(previewId) ?? null : null
  const compared = compareIds ? compareIds.flatMap((id) => { const item = byId.get(id); return item ? [item] : [] }) : null
  const selected = single ? byId.get(single) ?? null : null
  // While a saved version is shown, the floating box starts below its banner (avoidTop), shrinking
  // rather than covering Return to current; the stored box itself is untouched.
  const floatTop = avoidTop !== null && !docked ? Math.max(box.y, avoidTop) : box.y
  const floatHeight = floatTop !== box.y && typeof window !== 'undefined' ? Math.max(320, Math.min(box.h, window.innerHeight - floatTop - 8)) : box.h
  const groupLabel = group === 'all' ? 'All items' : group === 'ungrouped' ? 'Ungrouped' : groupOf(group)?.name ?? 'All items'
  const emptyFor = (): JSX.Element => {
    if (query.trim()) return <p className="sp-empty-line">Nothing matches.</p>
    if (list === 'rejected') return <div className="sp-empty"><h3>Nothing rejected</h3><p>Rejected items stay here and can be moved back. Nothing is deleted.</p></div>
    if (list === 'document') return <div className="sp-empty"><h3>No objects here yet</h3><p>Pictures, SVG, tables, widgets, cited references and text put back from the Scratchpad appear here, including unsaved changes.</p></div>
    return (
      <div className="sp-empty">
        <h3>Nothing set aside yet</h3>
        <p>Select text in your document and send a copy here, or cut it to move it.{shownScope === 'document' && folioDir === null ? ' Scraps cut from other documents stay out of sight unless you choose Everything in this workspace.' : ''}</p>
      </div>
    )
  }

  return (
    <section
      ref={panelRef}
      className={`sp-panel ${docked ? 'docked' : 'floating'}${showingSource ? ' showing-source' : ''}`}
      aria-label="Scratchpad"
      style={docked ? undefined : { left: box.x, top: floatTop, width: box.w, height: floatHeight }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        if (confirmItem) { event.stopPropagation(); setConfirmItem(null) }
        else if (menu) { event.stopPropagation(); setMenu(null) }
      }}
    >
      <header className="sp-head" onPointerDown={drag('move')}>
        {!docked ? <GripVertical size={14} className="sp-grip" aria-hidden="true" /> : null}
        <h2>Scratchpad</h2>
        <span className="sp-count" aria-label={`${activeCount} items`}>{activeCount}</span>
        <div className="sp-scope">
          <button type="button" className="sp-scope-btn" aria-haspopup="menu" aria-expanded={menu === 'scope'} onClick={() => setMenu(menu === 'scope' ? null : 'scope')} title={scopeLabel}>{scopeLabel}</button>
          {menu === 'scope' ? (
            <div className="sp-menu" role="menu" aria-label="Show scraps from">
              <div className="sp-menu-head">Show scraps from</div>
              {folioDir !== null ? <button type="button" role="menuitemradio" aria-checked={shownScope === 'folio'} onClick={() => { setScope('folio'); setMenu(null) }}>This Folio</button> : null}
              <button type="button" role="menuitemradio" aria-checked={shownScope === 'document'} onClick={() => { setScope('document'); setMenu(null) }}>This document</button>
              <button type="button" role="menuitemradio" aria-checked={shownScope === 'workspace'} onClick={() => { setScope('workspace'); setMenu(null) }}>Everything in this workspace</button>
            </div>
          ) : null}
        </div>
        <span className="sp-head-gap" />
        {docked ? <button type="button" onClick={layout.float}>Float</button> : <button type="button" onClick={layout.dock}>Dock to the right</button>}
        <button type="button" onClick={layout.collapse}>Collapse</button>
      </header>

      {/* Source tabs (ticket 05): present only while at least one connection is on. Each
          switch adds and removes only its own tab; the standalone Scratchpad has none. */}
      {externalSources && (externalSources.talkweaver || externalSources.slidewell) ? (
        <nav className="sp-tabs sp-source-tabs" role="tablist" aria-label="Sources">
          <button type="button" role="tab" aria-selected={sourceTab === 'folio'} className={sourceTab === 'folio' ? 'on' : ''} onClick={() => setSourceTab('folio')}>{folioDir !== null ? 'This Folio' : 'This document'}</button>
          {externalSources.talkweaver ? <button type="button" role="tab" aria-selected={sourceTab === 'talkweaver'} className={sourceTab === 'talkweaver' ? 'on' : ''} onClick={() => setSourceTab('talkweaver')}>TalkWeaver vaults</button> : null}
          {externalSources.slidewell ? <button type="button" role="tab" aria-selected={sourceTab === 'slidewell'} className={sourceTab === 'slidewell' ? 'on' : ''} onClick={() => setSourceTab('slidewell')}>SlideWell</button> : null}
        </nav>
      ) : null}

      {confirmItem && (preview || compared) ? (
        <div className="sp-confirm sp-confirm-top" role="alertdialog" aria-labelledby="sp-confirm-title-top" aria-describedby="sp-confirm-note-top">
          <h3 id="sp-confirm-title-top">Delete this forever?</h3>
          <p id="sp-confirm-note-top">This removes “{confirmItem.title}” from the Scratchpad{(confirmItem.kind === 'ref' || confirmItem.kind === 'evidence') ? '; its source record is not touched' : ''}. It cannot be undone.</p>
          <div className="sp-actions">
            <button type="button" autoFocus onClick={() => setConfirmItem(null)}>Cancel</button>
            <button type="button" className="danger" onClick={() => confirmDelete(confirmItem)}>Delete forever</button>
          </div>
        </div>
      ) : null}
      {compared && compared.length >= 2 ? (
        <ScratchpadCompare items={compared} root={root} partName={partName} assetBaseUrl={assetBaseUrl} handlers={itemHandlers} placement={placement} places={places} activePath={activePath} onChangePlace={handlers.changePlace} onBack={closeCompare} onTakeOut={takeOut} />
      ) : preview ? (
        <ScratchpadPreview item={preview} root={root} partName={partName} assetBaseUrl={assetBaseUrl} handlers={itemHandlers} placement={placement} places={places} activePath={activePath} onChangePlace={handlers.changePlace} onBack={closePreview} />
      ) : sourceTab !== 'folio' ? (
        <ScratchpadExternalBrowser key={sourceTab} source={sourceTab} root={root} activePath={activePath} say={handlers.say} onOpenSettings={onOpenSettings} />
      ) : (
        <>
          <div className="sp-search-row">
            <label className="sp-search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder="Search text, titles, sources and file names"
                title="Type a kind before your words: text: — or from: and a document name"
                aria-label="Search the Scratchpad"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery('') } }}
              />
              {query ? <button type="button" className="sp-clear" onClick={() => setQuery('')}>Clear</button> : null}
            </label>
            <div className="sp-filter">
              <button type="button" aria-haspopup="menu" aria-expanded={menu === 'filter'} onClick={() => setMenu(menu === 'filter' ? null : 'filter')}>{groupLabel} ▾</button>
              {menu === 'filter' || menu === 'new' ? (
                <div className="sp-menu right" role="menu" aria-label="Show group">
                  <div className="sp-menu-head">Show group</div>
                  <button type="button" role="menuitemradio" aria-checked={group === 'all'} onClick={() => { setGroup('all'); setMenu(null) }}>All items</button>
                  <button type="button" role="menuitemradio" aria-checked={group === 'ungrouped'} onClick={() => { setGroup('ungrouped'); setMenu(null) }}>Ungrouped</button>
                  {groups.map((g) => <button key={g.id} type="button" role="menuitemradio" aria-checked={group === g.id} onClick={() => { setGroup(g.id); setMenu(null) }}>{g.name}</button>)}
                  {menu === 'new' ? (
                    <form className="sp-new-group" onSubmit={(event) => { event.preventDefault(); makeGroup([]) }}>
                      <input autoFocus value={newName} placeholder="Group name" aria-label="Group name" onChange={(event) => setNewName(event.target.value)} />
                      <button type="submit">Create</button>
                    </form>
                  ) : <button type="button" role="menuitem" onClick={() => setMenu('new')}>New group…</button>}
                </div>
              ) : null}
            </div>
          </div>
          <div className="sp-chips" role="group" aria-label="Kinds">
            {(['text', 'pic', 'svg', 'table', 'widget', 'ref', 'evidence'] as const).map(kind => <button key={kind} type="button" className={`sp-chip${parseQuery(query).kinds.includes(kind) ? ' on' : ''}`} aria-pressed={parseQuery(query).kinds.includes(kind)} onClick={() => setQuery(toggleKindInQuery(query, kind))}>{({ text: 'Text', pic: 'Pictures', svg: 'SVG', table: 'Tables', widget: 'Widgets', ref: 'References', evidence: 'Evidence' })[kind]} <span>{(list === 'document' ? inventory : pool).filter(item => item.kind === kind && item.status === 'active').length}</span></button>)}
          </div>
          <nav className="sp-tabs" role="tablist" aria-label="Lists">
            {LISTS.map((key) => (
              <button key={key} type="button" role="tab" aria-selected={list === key} className={list === key ? 'on' : ''} onClick={() => { setList(key); clearSelection() }}>
                {LIST_LABEL[key]} <span>{key === 'document' ? documentCount : counts[key]}</span>
              </button>
            ))}
          </nav>
          {list === 'document' && folioDir !== null ? (
            <div className="sp-doc-scope" role="group" aria-label="Where">
              <button type="button" aria-pressed={docScope === 'part'} className={docScope === 'part' ? 'on' : ''} onClick={() => { setDocScope('part'); onDocumentScope?.('part') }}>This part</button>
              <button type="button" aria-pressed={docScope === 'folio'} className={docScope === 'folio' ? 'on' : ''} onClick={() => { setDocScope('folio'); onDocumentScope?.('folio') }}>Whole Folio</button>
            </div>
          ) : null}
          <div className="sp-list" role="listbox" aria-label={LIST_LABEL[list]} aria-multiselectable="true">
            {loadError ? <p className="sp-notice">{loadError}</p> : null}
            {list === 'document' ? inventoryNotices.map(notice => <p key={notice} className="sp-notice">{notice}</p>) : null}
            {notices.map((notice) => <p key={notice} className="sp-notice">{notice}</p>)}
            {list === 'rejected' && visible.length ? <p className="sp-note">Rejected items are kept. Move one back to see it among the candidates again.</p> : null}
            {visible.length ? <p className="sp-summary"><b>{plural(visible.length)}</b>{query.trim() ? ` match “${query.trim()}”` : ', newest first'}</p> : emptyFor()}
            {sections.map((section) => (
              <div key={section.key} className="sp-section">
                <h3 className="sp-section-head">{section.label}</h3>
                <div className="sp-grid">
                  {section.items.map((item) => (
                    <ScratchpadCard
                      key={item.id}
                      item={item}
                      group={groupOf(item.group)}
                      selected={single === item.id}
                      ticked={ticked.has(item.id)}
                      terms={terms}
                      assetBaseUrl={assetBaseUrl}
                      partName={partName}
                      onSelect={() => setSingle(item.id)}
                      onOpen={() => { setSingle(item.id); setPreviewId(item.id) }}
                      onTick={(on) => item.source !== 'document' && setTicked((t) => { const next = new Set(t); if (on) next.add(item.id); else next.delete(item.id); return next })}
                      onKeyDown={onCardKey(item)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <footer className="sp-foot">
            {confirmItem ? (
              <div className="sp-confirm" role="alertdialog" aria-labelledby="sp-confirm-title" aria-describedby="sp-confirm-note">
                <h3 id="sp-confirm-title">Delete this forever?</h3>
                <p id="sp-confirm-note">This removes “{confirmItem.title}” from the Scratchpad{(confirmItem.kind === 'ref' || confirmItem.kind === 'evidence') ? '; its source record is not touched' : ''}. It cannot be undone.</p>
                <div className="sp-actions">
                  <button type="button" autoFocus onClick={() => setConfirmItem(null)}>Cancel</button>
                  <button type="button" className="danger" onClick={() => confirmDelete(confirmItem)}>Delete forever</button>
                </div>
              </div>
            ) : ticked.size > 0 ? (
              <div className="sp-batch">
                <b>{ticked.size} selected</b>
                <button type="button" disabled={ticked.size < 2 || ticked.size > 4} onClick={openCompare}>Compare side by side</button>
                <button type="button" onClick={() => setMenu({ move: [...ticked] })}>Move to group… ▾</button>
                {list === 'rejected' ? <button type="button" onClick={() => moveBack([...ticked])}>Move back</button> : <button type="button" onClick={() => reject([...ticked])}>Reject</button>}
                <button type="button" onClick={clearSelection}>Clear selection</button>
                {ticked.size > 4 ? <span className="sp-batch-hint">Compare side by side takes 2 to 4 items. Untick some to compare.</span> : ticked.size < 2 ? <span className="sp-batch-hint">Compare takes 2 to 4 items.</span> : null}
              </div>
            ) : selected ? (
              <>
                <div className="sp-selected">
                  <span>Selected: <b>{selected.title}</b></span>
                  <button type="button" className="sp-link" onClick={() => setPreviewId(selected.id)}>Open big preview</button>
                </div>
                <ItemActions item={selected} handlers={itemHandlers} canInsert={placement !== null} />
                {selected.source !== 'document' && selected.source !== 'canonical' ? <PlacementNote placement={placement} reference={selected.kind === 'ref' || selected.kind === 'evidence'} places={places} activePath={activePath} onChangePlace={handlers.changePlace} /> : null}
              </>
            ) : (
              <p className="sp-hint">Click an item to see what you can do with it. Tick several to move, reject or compare them together.</p>
            )}
          </footer>
        </>
      )}
      {menu && typeof menu === 'object' ? (
        <div className="sp-menu sp-move" role="menu" aria-label={`Move ${menu.move.length} to`}>
          <div className="sp-menu-head">Move {menu.move.length} to</div>
          <button type="button" role="menuitem" onClick={() => moveTo(menu.move, null)}>Ungrouped</button>
          {groups.map((g) => <button key={g.id} type="button" role="menuitem" onClick={() => moveTo(menu.move, g.id)}>{g.name}</button>)}
          <form className="sp-new-group" onSubmit={(event) => { event.preventDefault(); makeGroup(menu.move) }}>
            <input value={newName} placeholder="Group name" aria-label="New group name" onChange={(event) => setNewName(event.target.value)} />
            <button type="submit">Create</button>
          </form>
          <button type="button" role="menuitem" onClick={() => setMenu(null)}>Cancel</button>
        </div>
      ) : null}
      {!docked ? <span className="sp-resize" aria-hidden="true" onPointerDown={drag('resize')} /> : null}
    </section>
  )
}
