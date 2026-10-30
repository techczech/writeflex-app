// The floating Scratchpad in the window (ADR-0050, ticket 01). One instance: floating over the text,
// collapsed to the pill, or docked, in which case it renders into the right rail's Scratchpad tab (there is
// one Scratchpad, not two). App mounts this once and forwards ⌘⇧X, the editor's anchor changes and the
// commands through `api`; everything else about the feature lives under src/renderer/src/scratchpad/.
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import type { ScratchMode } from '../../../shared/scratchpad-layout'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { ScratchpadPanel, type ScratchpadPanelCommands } from '../components/scratchpad/ScratchpadPanel'
import type { Placement, ScratchPlace } from '../components/scratchpad/ScratchpadParts'
import { ScratchpadSelectionBubble } from './ScratchpadSelectionBubble'
import { readFolioOpenParts } from '../components/FolioOpenButton'
import { createScratchpadController, SCRATCHPAD_SUSPENDED } from './scratchpad-controller'
import { useScratchpadInventory } from './useScratchpadInventory'
import { assetStillCurrent } from '../../../shared/scratchpad-inventory'
import { writerReviewRemovedSpans } from '../editor/writer-review'
import { insertionPoint, liveAnchors } from './scratchpad-editor'
import { useScratchpadItems } from './useScratchpadItems'
import { useScratchpadLayout } from './useScratchpadLayout'
import { defaultPartName, type ScratchItem } from '../../../shared/scratchpad-items'

export type ScratchpadHostApi = {
  /** Insert a copy of the item `id` at the caret (the Agent panel's embedded list and its drop). */
  insertById: (id: string) => void
  /** ⇧⌘J: open (in the last mode) or collapse to the pill; a docked panel behind another rail tab is shown. */
  toggle: () => void
  cut: () => Promise<unknown>
  sendCopy: () => Promise<unknown>
  /** Extend the editor selection to the section at the caret (the bubble's first step). */
  selectSection: () => void
  /** Insert a copy of the item selected in the panel at the caret. */
  insertSelected: () => void
  /** The panel commands (ticket 04): each opens the panel first, then acts on its selection/ticks. */
  compareTicked: () => void
  previewSelected: () => void
  putBackSelected: () => void
  rejectSelected: () => void
  moveBackSelected: () => void
  toggleDoneSelected: () => void
  focusSearch: () => void
  documentChanged: () => void
  syncAnchors: (before: EditorState, after: EditorState) => void
}

type Say = (message: string, action?: { label: string; run: () => void }) => void

export function ScratchpadHost({
  api, root, activePath, assetBaseUrl, view, say, dockSlot, dockVisible, railOpen, openDock, editorPath, editable, suspended = false, liveKey, buffer, owned, navigate, partName = defaultPartName, externalSources = null, onOpenSettings, onModeChange,
}: {
  /** The editor shows the live document (not a saved version or a past session); see the controller.
   *  Inventory buffers are RAW editor text plus excluded old-role spans (the one coordinate contract). */
  buffer: (path: string) => { content: string; removedSpans: Array<{ from: number; to: number }> } | null
  owned: (path: string) => boolean
  navigate: (path: string) => void
  editable?: () => boolean
  /** The widget workbench covers the ordinary editor: the Scratchpad (pill, panel, bubble, dock)
   *  is not rendered or reachable, its layout/selection/groups are kept as they stand, and no
   *  Scratchpad action may target the covered editor. */
  suspended?: boolean
  /** Changes when the editor leaves or enters a saved version, so the live state is looked at again. */
  liveKey?: unknown
  api: Ref<ScratchpadHostApi>
  root: string | null
  activePath: string | null
  assetBaseUrl: string | null
  view: () => EditorView | null
  say: Say
  /** The rail tab's slot the docked panel renders into. */
  dockSlot: HTMLElement | null
  /** The rail is open on the Scratchpad tab. */
  dockVisible: boolean
  /** The right rail is open (on any tab): the pill keeps clear of it. */
  railOpen: boolean
  openDock: () => void
  /** The document the editor holds right now (it can lag the active tab while a switch loads). */
  editorPath?: () => string | null
  partName?: (path: string) => string
  /** The Settings › Scratchpad switches as they stand; a source tab exists only while on. */
  externalSources?: { talkweaver: boolean; slidewell: boolean } | null
  onOpenSettings?: () => void
  /** Report the actual mode so the rail can use its dock-specific width. */
  onModeChange?: (mode: ScratchMode) => void
}): JSX.Element | null {
  const bridge = window.writeflex.scratchpad
  const layout = useScratchpadLayout()
  const data = useScratchpadItems(bridge, root, activePath, window.writeflex.onScrapsChanged, say)
  const inventory = useScratchpadInventory(bridge, root, activePath, layout.layout.mode !== 'collapsed', buffer, owned)
  const [pendingShow, setPendingShow] = useState<ScratchItem | null>(null)
  const [pendingPlace, setPendingPlace] = useState<string | null>(null)
  const [showingSource, setShowingSource] = useState(false)
  const [focusTick, setFocusTick] = useState(0)
  const [selectionTick, setSelectionTick] = useState(0)
  const [places, setPlaces] = useState<ScratchPlace[]>([])
  const [avoidTop, setAvoidTop] = useState<number | null>(null)
  const displayPartName = useCallback((path: string) => places.find(place => place.path === path)?.name ?? partName(path), [places, partName])
  const selectedRef = useRef<string | null>(null)
  const panelCommands = useRef<ScratchpadPanelCommands | null>(null)

  const live = useRef({ root, activePath, view, say, partName: displayPartName, editorPath, editable, suspended, navigate })
  live.current = { root, activePath, view, say, partName: displayPartName, editorPath, editable, suspended, navigate }
  /** The covered editor is never a Scratchpad target: suspended counts as not editable here too. */
  const editorUsable = (): boolean => !live.current.suspended && (live.current.editable?.() ?? true)
  const controller = useMemo(() => createScratchpadController({
    bridge,
    view: () => live.current.view(),
    root: () => live.current.root,
    activePath: () => (live.current.editorPath ? live.current.editorPath() : live.current.activePath),
    say: (message, action) => live.current.say(message, action),
    partName: (path) => live.current.partName(path),
    editable: () => live.current.editable?.() ?? true,
    suspended: () => live.current.suspended,
  }), [bridge])

  // A document shown afresh: uses this window recorded there whose anchors are gone no longer hold their
  // items out of Candidates (controller.documentShown). After a frame, so the editor has switched.
  useEffect(() => {
    if (!root || !activePath) return
    const frame = requestAnimationFrame(() => {
      const now = live.current.editorPath ? live.current.editorPath() : live.current.activePath
      if (now === activePath) controller.documentShown()
    })
    return () => cancelAnimationFrame(frame)
  }, [root, activePath, liveKey, controller])

  const show = useCallback(async (item: ScratchItem) => {
    if (!root || !editorUsable()) { say(live.current.suspended ? SCRATCHPAD_SUSPENDED : 'Return to the current text before showing a Scratchpad source.'); return }
    if (item.document) {
      const current = await bridge.inventory({ root, activePath: item.origin.path, scope: 'part' })
      if (live.current.root !== root || live.current.suspended) return
      // A cited reference may be shown at any of its recorded citation ranges; that exact range
      // and its exact Markdown must still be one of the reference's live positions.
      const stillThere = current.ok && current.items.some(now => item.kind === 'ref' && item.cited
        ? now.id === item.id && now.cited?.positions.some(position => position.from === item.document!.from && position.to === item.document!.to && position.markdown === item.markdown)
        : now.id === item.id && now.markdown === item.markdown)
      if (!stillThere) { say('That source changed. Refresh In this document and try again.'); inventory.reload(); return }
    }
    setPendingShow(item)
    const path = item.document ? item.origin.path : item.uses.find(use => use.mode === 'put-back' && !use.unverified)?.path
    if (!path) { say('That placement cannot be confirmed any more.'); setPendingShow(null); return }
    live.current.navigate(path)
  }, [root, bridge, inventory.reload, say])
  useEffect(() => {
    if (!pendingShow) return
    const folder = root
    let attempts = 0
    let flash: ReturnType<typeof setTimeout> | undefined
    const timer = setInterval(() => {
      const item = pendingShow
      const path = item.document ? item.origin.path : item.uses.find(use => use.mode === 'put-back' && !use.unverified)?.path
      const current = live.current
      const view = current.view()
      const shown = current.editorPath?.() ?? current.activePath
      if (current.root !== folder || current.suspended || !(current.editable?.() ?? true)) { clearInterval(timer); setPendingShow(null); return }
      if (!view || shown !== path) {
        if (++attempts > 40) { clearInterval(timer); setPendingShow(null); current.say('The source document could not be opened. Nothing was changed.') }
        return
      }
      clearInterval(timer)
      const anchor = item.document ? item.document : liveAnchors(view.state).find(anchor => anchor.itemId === item.id && anchor.mode === 'put-back')
      if (!anchor || (item.document && !assetStillCurrent(item, { raw: view.state.doc.toString(), removedSpans: writerReviewRemovedSpans(view.state) }))) {
        current.say('That source changed. Refresh In this document and try again.'); setPendingShow(null); return
      }
      view.dispatch({ selection: { anchor: anchor.from, head: anchor.to }, scrollIntoView: true })
      view.focus()
      setShowingSource(true)
      flash = setTimeout(() => { setShowingSource(false); setPendingShow(null) }, 1700)
    }, 50)
    return () => { clearInterval(timer); clearTimeout(flash) }
  }, [pendingShow, root])
  const collect = useCallback(async (item: ScratchItem) => {
    if (!root || !item.document || item.kind === 'text') return
    if (item.kind === 'ref' || item.kind === 'evidence') {
      // A cited reference in the inventory collects as a canonical-source pointer, by its citation id.
      if (!item.ref) return
      const collected = await data.collectSource(item.ref.sourceId)
      if (live.current.root !== root) return
      if (collected) say(`Added ${item.title} to the Scratchpad. The source is unchanged.`)
      inventory.reload()
      return
    }
    const reply = await bridge.collectAsset({ root, origin: item.origin.path, kind: item.kind, markdown: item.markdown, from: item.document.from, to: item.document.to })
    if (live.current.root !== root) return
    say(reply.ok ? `Added ${item.title} to the Scratchpad. The source is unchanged.` : reply.error)
    inventory.reload()
  }, [bridge, root, say, inventory.reload, data.collectSource])
  const collectSource = useCallback(async (item: ScratchItem) => {
    if (!item.ref) return
    const collected = await data.collectSource(item.ref.sourceId)
    if (collected) say(`Collected ${item.title} to the Scratchpad. Nothing was copied yet.`)
  }, [data.collectSource, say])
  const showAt = useCallback((item: ScratchItem, position: number) => {
    const at = item.cited?.positions[position]
    if (!at || !item.document) return
    void show({ ...item, markdown: at.markdown, document: { ...item.document, from: at.from, to: at.to, line: at.line } })
  }, [show])

  // Change place (ticket 04): the parts it can go to — the Folio's running order when the document
  // is in one (read the same way Open Folio reads it), else the open document alone.
  const folioDir = data.snapshot.folioDir
  useEffect(() => {
    let live = true
    if (!root || !activePath) { setPlaces([]); return }
    if (folioDir === null) { setPlaces([{ path: activePath, name: partName(activePath) }]); return }
    void readFolioOpenParts(folioDir).then((parts) => {
      if (!live) return
      const list = parts.map((part) => ({ path: part.path, name: part.title }))
      setPlaces(list.some((part) => part.path === activePath) ? list : [...list, { path: activePath, name: partName(activePath) }])
    }).catch(() => { if (live) setPlaces([{ path: activePath, name: partName(activePath) }]) })
    return () => { live = false }
  }, [root, activePath, folioDir, partName])

  /** Navigate to a part and put the caret at its end. Moves the cursor only; writes nothing. */
  const changePlace = useCallback((path: string) => {
    if (live.current.suspended) { live.current.say(SCRATCHPAD_SUSPENDED); return }
    const current = live.current
    const editor = current.view()
    const shown = current.editorPath?.() ?? current.activePath
    if (editor && shown === path) {
      editor.dispatch({ selection: { anchor: editor.state.doc.length }, scrollIntoView: true })
      editor.focus()
      return
    }
    setPendingPlace(path)
    current.navigate(path)
  }, [])
  useEffect(() => {
    if (!pendingPlace) return
    let attempts = 0
    const timer = setInterval(() => {
      const current = live.current
      const editor = current.view()
      const shown = current.editorPath?.() ?? current.activePath
      if (current.suspended) { clearInterval(timer); setPendingPlace(null); return }
      if (!editor || shown !== pendingPlace) {
        if (++attempts > 40) { clearInterval(timer); setPendingPlace(null); current.say('That part could not be opened. Nothing was written.') }
        return
      }
      clearInterval(timer)
      setPendingPlace(null)
      editor.dispatch({ selection: { anchor: editor.state.doc.length }, scrollIntoView: true })
      editor.focus()
    }, 50)
    return () => clearInterval(timer)
  }, [pendingPlace])

  // While a saved version's banner is up, the floating panel keeps below it (ticket 04
  // carry-forward): measure the banner as rendered, never guess its height.
  useEffect(() => {
    const measure = (): void => {
      const banner = document.querySelector<HTMLElement>('.historical-banner')
      setAvoidTop(banner ? Math.round(banner.getBoundingClientRect().bottom) + 8 : null)
    }
    const frame = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', measure) }
  }, [liveKey, activePath])

  const mode = layout.layout.mode
  useEffect(() => { onModeChange?.(mode) }, [mode, onModeChange])
  // Docking means the rail's Scratchpad tab: open it when the panel docks.
  useEffect(() => { if (mode === 'docked') openDock() }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps
  // The placement note follows the caret while the panel is open; the selection bubble follows the
  // selection even when the panel is the pill, so this runs in every mode.
  useEffect(() => {
    let frame = 0
    const bump = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setSelectionTick((t) => t + 1)) }
    document.addEventListener('selectionchange', bump)
    document.addEventListener('keyup', bump)
    return () => { cancelAnimationFrame(frame); document.removeEventListener('selectionchange', bump); document.removeEventListener('keyup', bump) }
  }, [mode])

  // The pill sits at the bottom right of the text column, never over the rail (its composer, its lists).
  const [pillRight, setPillRight] = useState(20)
  useEffect(() => {
    const rail = railOpen ? document.querySelector<HTMLElement>('aside.right-pane') : null
    const measure = (): void => {
      const left = rail?.getBoundingClientRect().left ?? window.innerWidth
      setPillRight(Math.max(20, Math.round(window.innerWidth - left + 20)))
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = rail && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (rail) observer?.observe(rail)
    return () => { window.removeEventListener('resize', measure); observer?.disconnect() }
  }, [railOpen, mode])

  const editor = view()
  const placement: Placement = useMemo(() => {
    if (!editor || !activePath) return null
    return { part: displayPartName(activePath), after: insertionPoint(editor.state).after }
  }, [editor, activePath, partName, selectionTick]) // eslint-disable-line react-hooks/exhaustive-deps

  const insert = useCallback((item: ScratchItem, how: 'copy' | 'put-back') => { void controller.insert(item, how) }, [controller])

  /** A registered panel command: bring the panel up first (pill, or the rail tab), then act. */
  const openPanelThen = useCallback((run: (commands: ScratchpadPanelCommands) => void) => {
    if (live.current.suspended) { live.current.say(SCRATCHPAD_SUSPENDED); return }
    if (mode === 'collapsed') layout.expand()
    else if (mode === 'docked' && !dockVisible) openDock()
    requestAnimationFrame(() => { if (panelCommands.current) run(panelCommands.current) })
  }, [mode, dockVisible, layout, openDock])

  useImperativeHandle(api, () => ({
    toggle: () => {
      if (live.current.suspended) { live.current.say(SCRATCHPAD_SUSPENDED); return }
      if (mode === 'docked' && !dockVisible) { openDock(); setFocusTick((t) => t + 1); return }
      if (mode === 'collapsed') { layout.expand(); setFocusTick((t) => t + 1); return }
      layout.collapse()
    },
    insertById: (id) => {
      const item = data.snapshot.items.find((entry) => entry.id === id)
      if (!item) { live.current.say('That Scratchpad item is not there any more.'); return }
      void controller.insert(item, 'copy')
    },
    cut: () => controller.cut(),
    sendCopy: () => controller.sendCopy(),
    selectSection: () => { controller.selectSection() },
    compareTicked: () => openPanelThen((commands) => commands.compareTicked()),
    previewSelected: () => openPanelThen((commands) => commands.previewSelected()),
    putBackSelected: () => openPanelThen((commands) => commands.putBackSelected()),
    rejectSelected: () => openPanelThen((commands) => commands.rejectSelected()),
    moveBackSelected: () => openPanelThen((commands) => commands.moveBackSelected()),
    toggleDoneSelected: () => openPanelThen((commands) => commands.toggleDoneSelected()),
    focusSearch: () => openPanelThen((commands) => commands.focusSearch()),
    insertSelected: () => {
      const item = data.snapshot.items.find((entry) => entry.id === selectedRef.current)
      if (!item) { live.current.say('Select a Scratchpad item first, then insert a copy.'); return }
      void controller.insert(item, 'copy')
    },
    documentChanged: () => { inventory.reload(); data.reload() },
    syncAnchors: (before, after) => controller.syncAnchors(before, after),
  }), [mode, dockVisible, openDock, layout, controller, data.snapshot.items, data.reload, inventory.reload])

  if (!root) return null
  const panel = (
    <ScratchpadPanel
      root={root}
      sources={data.sources}
      inventory={inventory.items}
      inventoryNotices={inventory.notices}
      onDocumentScope={inventory.setScope}
      showingSource={showingSource}
      layout={layout}
      snapshot={data.snapshot}
      loadError={data.loadError}
      activePath={activePath}
      assetBaseUrl={assetBaseUrl}
      partName={displayPartName}
      placement={placement}
      focusTick={focusTick}
      selectionRef={selectedRef}
      commandRef={panelCommands}
      places={places}
      avoidTop={avoidTop}
      docked={mode === 'docked'}
      externalSources={externalSources}
      onOpenSettings={onOpenSettings}
      pillRight={pillRight}
      handlers={{
        show: (item) => { void show(item) },
        showAt,
        collect: (item) => { void collect(item) },
        collectSource: (item) => { void collectSource(item) },
        reference: (item, action) => { void controller.reference(item, action) },
        insert,
        setStatus: data.setStatus,
        setGroup: data.setGroup,
        createGroup: data.createGroup,
        toggleDone: (item) => { void data.toggleDone(item) },
        setColour: (item, colour) => { void data.setColour(item, colour) },
        deleteForever: data.deleteForever,
        changePlace,
        say: (message) => say(message),
      }}
    />
  )
  const bubble = (
    <ScratchpadSelectionBubble
      view={editor}
      tick={selectionTick}
      onSelectSection={() => { controller.selectSection() }}
      onSendCopy={() => { void controller.sendCopy() }}
      onCut={() => { void controller.cut() }}
    />
  )
  // Suspended (the widget workbench is up): the whole Scratchpad — pill, panel, bubble and dock —
  // leaves the screen and the pointer's way, without unmounting it: layout, selection, ticks and
  // groups are exactly as they were when the writer comes back. `display: contents` keeps the
  // wrapper out of the layout while the Scratchpad is live.
  const suspensionStyle = { display: suspended ? 'none' : 'contents' } as const
  const suspendedNote = (
    <div className="sp-rail-away">
      <p>The Scratchpad is paused while the widget workbench is open. It comes back as it was when you return to the document.</p>
    </div>
  )
  if (mode === 'docked') return (
    <>
      {dockSlot ? createPortal(
        <>
          <div style={suspensionStyle} aria-hidden={suspended || undefined} data-testid="scratchpad-suspension">{panel}</div>
          {suspended ? suspendedNote : null}
        </>,
        dockSlot,
      ) : null}
      <div style={suspensionStyle} aria-hidden={suspended || undefined}>{bubble}</div>
    </>
  )
  return (
    <>
      <div style={suspensionStyle} aria-hidden={suspended || undefined} data-testid="scratchpad-suspension">
        {panel}
        {bubble}
      </div>
      {dockSlot ? createPortal(
        suspended ? suspendedNote : (
          <div className="sp-rail-away">
            <p>The Scratchpad is {mode === 'collapsed' ? 'collapsed to the pill at the bottom right' : 'floating over the text'}.</p>
            <button type="button" onClick={layout.dock}>Dock it here</button>
          </div>
        ),
        dockSlot,
      ) : null}
    </>
  )
}
