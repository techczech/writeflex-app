import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { FileText } from 'lucide-react'
import type { RoomBinder } from '../../../shared/folio-room'
import type { RoomAuthoringRequest, RoomAuthoringResult } from '../../../shared/folio-room-authoring'
import { FolioBinder } from './FolioOutline'
import { ROOM_ON_SCREEN_EVENT, roomOnScreen } from '../plan/room-on-screen'
import { announceUndoToast, onOtherUndoToast, refreshRoom, subscribeRoom } from '../plan/folio-room-store'
import { dispatchSidebar, registerSidebarSlot, useSidebarState } from '../plan/folio-sidebar'

/** A Folio write through the app's save queue (the running-order hook's `write`): open buffers saved first. */
export type BinderWrite = <T>(dir: string, call: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false; message: string }>

/** The sidebar Outline slot: the open room's binder while a room is on screen, otherwise `children` (the document outline). */
export function RoomBinderSwitch({ children, contents, onOpenFile, write }: { children: ReactNode; contents?: ReactNode; onOpenFile: (path: string) => void; write?: BinderWrite }): JSX.Element {
  const [dir, setDir] = useState<string | null>(roomOnScreen)
  useEffect(() => {
    setDir(roomOnScreen())
    const onRoom = (event: Event): void => setDir((event as CustomEvent<string | null>).detail)
    window.addEventListener(ROOM_ON_SCREEN_EVENT, onRoom)
    return () => window.removeEventListener(ROOM_ON_SCREEN_EVENT, onRoom)
  }, [])
  return (
    <>
      {dir !== null && <RoomBinderPane key={dir} dir={dir} contents={contents} onOpenFile={onOpenFile} {...(write ? { write } : {})} />}
      {dir === null && children}
    </>
  )
}

/** Whether keyboard focus is in a place that types (a field or the editor): ⌘Z there is the text's own Undo. */
function focusTypes(): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return false
  return active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.closest('.cm-editor') !== null
}

/**
 * The sidebar's Outline slot while a Folio's workspace is on screen (ADR-0049, layout 1A). Header: the Binder / Inspector
 * switch and × (closes the inspector, back to the binder). Binder: the TEXT section (the room draws it into the `text`
 * slot: it owns the selection), then the Research, Notes and Ideas groups and the Folio bin (slice 5 replaces those with
 * the folders tree). Inspector: the room draws the part's, or the Folio's, details into the `inspector` slot. Before
 * ADR-0049 this was ADR-0048's binder: that Folio's Research, Notes and Ideas, then the Folio bin (drawing 4A). The room, not the last open document, decides which Folio it
 * is. It takes the room's one shared read (folio-room-store.ts), never a read of its own. A click opens the file; a
 * bin row's Restore puts the file at the Folio's top level and at the end of the running order and shows a toast with
 * its Undo (and ⌘Z), as a removal does (I-2: every write action has one Undo). The app never deletes (I-1): Show bin in
 * Finder opens the bin's folder, where the owner deletes files himself.
 */
export function RoomBinderPane({ dir, contents, onOpenFile, write }: { dir: string; contents?: ReactNode; onOpenFile: (path: string) => void; write?: BinderWrite }): JSX.Element {
  const [binder, setBinder] = useState<RoomBinder | null>(null)
  const [enrichment, setEnrichment] = useState<'pending' | 'failed' | undefined>('pending')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  // The last Restore's toast: its sentence and its Undo token (cleared by its Undo, by ×, or by another toast).
  const [toast, setToast] = useState<{ message: string; token: string } | null>(null)
  useEffect(() => subscribeRoom(dir, answer => { setBinder('error' in answer ? null : answer.model?.binder ?? null); setEnrichment('error' in answer ? 'failed' : answer.model?.enrichment) }), [dir])
  useEffect(() => onOtherUndoToast(dir, 'binder', () => setToast(null)), [dir])
  const ask = useCallback(async (request: RoomAuthoringRequest): Promise<void> => {
    if (busy) return
    setBusy(true)
    setToast(null)
    try {
      const call = (): Promise<RoomAuthoringResult> => window.writeflex.folioRoom.author(dir, request)
      const written = write ? await write(dir, call) : { ok: true as const, value: await call() }
      const answer = written.ok ? written.value : { ok: false as const, message: written.message }
      if (answer.ok && request.op === 'restore' && answer.token) {
        setMessage('')
        setToast({ message: answer.message, token: answer.token })
        announceUndoToast(dir, 'binder')
      } else {
        setMessage(answer.message)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The Folio bin could not be changed.')
    } finally {
      setBusy(false)
      refreshRoom(dir)
    }
  }, [busy, dir, write])
  const sidebar = useSidebarState(dir)
  const textSlot = useCallback((element: HTMLDivElement | null) => registerSidebarSlot(dir, 'text', element), [dir])
  const inspectorSlot = useCallback((element: HTMLDivElement | null) => registerSidebarSlot(dir, 'inspector', element), [dir])
  /** The toast's Undo and ⌘Z: the last Restore, exactly, or main's refusal (nothing written). */
  const undoRestore = useCallback((): void => {
    if (!toast) return
    void ask({ op: 'undo', token: toast.token })
  }, [toast, ask])
  useEffect(() => {
    if (!toast) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z' || focusTypes()) return
      event.preventDefault()
      undoRestore()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toast, undoRestore])
  const bin = binder?.bin ?? []
  const empty = binder === null || (binder.research.length === 0 && binder.notes.length === 0 && binder.ideas.length === 0)
  return (
    <aside className="outline fr-sidebar" aria-label="Binder" data-testid="room-binder" data-room-dir={dir} data-sidebar-mode={sidebar.mode}>
      <div className="fr-sidebody" style={{ display: sidebar.mode === 'inspector' ? 'none' : undefined }}>
      {contents && <div className="fr-sidebar-contents">{contents}</div>}
      <div className="fr-sideslot-text" ref={textSlot} />
      {enrichment ? <p className="ol-empty" role="status">{enrichment === 'pending' ? 'Loading sources…' : 'Sources could not be loaded.'}</p> : binder === null || empty ? <p className="ol-empty">No research, notes or ideas in this Folio yet.</p> : <FolioBinder binder={binder} onOpenFile={onOpenFile} />}
      {binder !== null && !enrichment && (
        <div className="fr-binder fr-bin" role="group" aria-label="Folio bin" data-testid="room-bin">
          <div className="fr-bh"><span>Bin ({bin.length})</span><small>removed parts</small>
            {bin.length > 0 && <button type="button" disabled={busy} data-action="show-bin" onClick={() => void ask({ op: 'showBin' })}>Show bin in Finder</button>}
          </div>
          {binder.binUnreadable && <p className="fr-bin-note">The bin’s list cannot be read; its files are shown by name.</p>}
          {bin.map((item) => (
            <div key={item.id} className="fr-bin-row" data-bin-item={item.name}>
              <span className="fr-brow" title={item.was ? `${item.title} · was ${item.was}${item.removedAt ? ` · removed ${new Date(item.removedAt).toLocaleString()}` : ''}` : item.title}>
                <FileText aria-hidden="true" /><span className="t">{item.name}</span>
              </span>
              <button type="button" className="fr-bin-restore" disabled={busy} data-action="restore" onClick={() => void ask({ op: 'restore', id: item.id })}>Restore</button>
            </div>
          ))}
          {toast && (
            <div className="fr-bin-toast" role="status" data-testid="bin-toast">
              <span>{toast.message}</span>
              <button type="button" className="fr-toast-undo" aria-label="Undo" title="Undo (⌘Z)" disabled={busy} onClick={undoRestore}>Undo <kbd aria-hidden="true">⌘Z</kbd></button>
              <button type="button" className="fr-toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
            </div>
          )}
          {message && <p className="fr-bin-note" role="status">{message}</p>}
        </div>
      )}
      </div>
      <div className="fr-sidebody fr-sideslot-inspector" data-testid="sidebar-inspector" ref={inspectorSlot} style={{ display: sidebar.mode === 'inspector' ? undefined : 'none' }} />
    </aside>
  )
}
