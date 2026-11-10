import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, BookOpen, ChevronDown } from 'lucide-react'
import type { Folio, Plan } from '../../../preload'
import { folioRoomEscapeGoesBack } from './BackControl'

/** One running-order part the Folio can open at: a file on disk, with the title the Plan shows. */
export type FolioOpenPart = { path: string; title: string }

const titleOfFile = (path: string): string => (path.split('/').pop() ?? path).replace(/\.md$/i, '')

/**
 * The parts "Open Folio" can open, in running order: the Plan's parts that have a file, else (a Folio with a
 * manifest but no Index Note yet) the manifest's pieces read by main. A plain folder, or a Folio whose parts are
 * all unwritten, has none and gets no button.
 */
export function folioOpenParts(folio: Folio | null, plan: Plan | null, pieces: readonly string[] | null = null): FolioOpenPart[] {
  const planned = (plan?.parts ?? []).flatMap((part) => (part.path ? [{ path: part.path, title: part.title.trim() || titleOfFile(part.path) }] : []))
  if (planned.length > 0) return planned
  if (folio === null) return []
  return (pieces ?? []).map((path) => ({ path, title: titleOfFile(path) }))
}

/** The file the main button opens: the first part, or the part at `index` when the menu chose one. */
export function folioOpenTarget(parts: readonly FolioOpenPart[], index = 0): string | null {
  return parts[index]?.path ?? null
}

/** A Folio's parts read from disk by its folder (the palette command's seam; null when `dir` is not a Folio). */
export async function readFolioOpenParts(dir: string): Promise<FolioOpenPart[]> {
  const [folio, plan, pieces] = await Promise.all([
    window.writeflex.readFolio(dir).catch(() => null),
    window.writeflex.plan.read(dir).catch(() => null),
    window.writeflex.readFolioPieces(dir).catch(() => null),
  ])
  return folioOpenParts(folio, plan, pieces?.pieces ?? null)
}

const isEditableTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  return !!element && (element.isContentEditable || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')
}

/**
 * The big primary Open Folio button on a Folio's page, with an attached Open at… menu of every part.
 * ⌘↩ presses the main button while the page is up (the page is a full overlay, so no editor chord competes).
 */
export function FolioOpenButton({ parts, onOpen, returnPath, roomEscape }: { parts: readonly FolioOpenPart[]; returnPath?: string | null; onOpen: (path: string) => void; roomEscape?: () => boolean }): JSX.Element | null {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuAt, setMenuAt] = useState<{ left: number; top: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const caret = useRef<HTMLButtonElement>(null)
  const first = returnPath && parts.some(part => part.path === returnPath) ? returnPath : folioOpenTarget(parts)

  useEffect(() => {
    if (first === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || !event.metaKey || event.altKey || event.ctrlKey || event.defaultPrevented) return
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      // ⌘↩ opens the first part; ⇧⌘↩ opens the Open at… menu to choose another.
      if (event.shiftKey) setMenuOpen(true)
      else onOpen(first)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [first, onOpen])

  // In the room the main button is the Back control (R10): Esc goes where it goes once the room's own Esc steps decline (Sol S6).
  // Registered on the window after the room's handlers have seen the key, so a step that took it has marked it handled.
  useEffect(() => {
    if (first === null || returnPath === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (!folioRoomEscapeGoesBack(event)) return
      event.preventDefault()
      // The room's own steps (Split, a selection) take the Esc first, even with the focus outside their lists.
      if (roomEscape?.()) return
      onOpen(first)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [first, onOpen, returnPath, roomEscape])

  useEffect(() => {
    if (!menuOpen) return
    const box = root.current?.getBoundingClientRect()
    // Fixed, so a bar that scrolls sideways (Manage Folio at a narrow width) never clips the menu.
    if (box) setMenuAt({ left: box.left, top: box.bottom + 4 })
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onPointer = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setMenuOpen(false) }
    window.addEventListener('pointerdown', onPointer)
    return () => window.removeEventListener('pointerdown', onPointer)
  }, [menuOpen])

  if (first === null) return null

  const closeMenu = (): void => { setMenuOpen(false); caret.current?.focus() }
  const items = (): HTMLElement[] => [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
  const onMenuKey = (event: React.KeyboardEvent): void => {
    const list = items()
    const at = list.indexOf(document.activeElement as HTMLElement)
    const move = (to: number): void => { event.preventDefault(); list[(to + list.length) % list.length]?.focus() }
    if (event.key === 'ArrowDown') move(at + 1)
    else if (event.key === 'ArrowUp') move(at - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(list.length - 1)
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu() }
    else if (event.key === 'Tab') setMenuOpen(false)
  }

  return (
    <div className="folio-open" ref={root}>
      <div className="folio-open-split">
        <button type="button" className="folio-open-main" onClick={() => onOpen(first)} aria-keyshortcuts="Meta+Enter" title={returnPath === undefined ? 'Open the Folio at its first part and show its outline (⌘↩)' : `Back to ${first.split('/').pop() ?? first} (⌘↩, Esc)`}>
          {returnPath === undefined ? <BookOpen className="icon" aria-hidden="true" /> : <ArrowLeft className="icon" aria-hidden="true" />}{returnPath === undefined ? 'Open Folio' : <span className="back-control-label">Back to {(first.split('/').pop() ?? first)}</span>}<kbd>⌘↩</kbd>
        </button>
        <button
          type="button"
          ref={caret}
          className="folio-open-caret"
          aria-label="Open at…"
          aria-keyshortcuts="Shift+Meta+Enter"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Open at… (⇧⌘↩)"
          onClick={() => setMenuOpen((open) => !open)}
          onKeyDown={(event) => { if (event.key === 'ArrowDown' && !menuOpen) { event.preventDefault(); setMenuOpen(true) } }}
        >
          <ChevronDown className="icon" aria-hidden="true" />
        </button>
      </div>
      {menuOpen && (
        <div className="folio-open-menu" role="menu" aria-label="Open at…" onKeyDown={onMenuKey} style={menuAt ? { position: 'fixed', left: menuAt.left, top: menuAt.top } : undefined}>
          <div className="folio-open-menu-head" aria-hidden="true">Open at…</div>
          {parts.map((part, index) => (
            <button key={`${index}:${part.path}`} type="button" role="menuitem" className="folio-open-item" onClick={() => { setMenuOpen(false); onOpen(part.path) }}>
              {part.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
