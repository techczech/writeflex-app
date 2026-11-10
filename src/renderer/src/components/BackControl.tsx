import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

/**
 * House rule R10: every main-area mode has ONE back control at the top left, "Back to <document name>",
 * and Esc does the same. The app provides the document's name once; each mode draws the control and
 * keeps its own way back.
 */
const BackNameContext = createContext<string>('text')
export const BackNameProvider = BackNameContext.Provider
export const useBackName = (): string => useContext(BackNameContext)

export function backLabel(name: string): string {
  return `Back to ${name}`
}

/** True when an Esc belongs to something else first: an open menu or dialog, or text being typed. */
function escapeBelongsElsewhere(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true
  const target = event.target as HTMLElement | null
  if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="listbox"]')) {
    // An empty search field lets Esc through; a field with text keeps Esc to clear itself.
    if (target.matches('input, textarea') && (target as HTMLInputElement).value === '') return false
    return true
  }
  // The Folio room has its own Esc steps (leave a read-only version, close the split, ...); its Back button takes Esc after them (folioRoomEscapeGoesBack).
  return !!document.querySelector('[role="menu"], [role="alertdialog"], .overlay, [aria-modal="true"], [data-testid="folio-room"]')
}

/**
 * Esc in the Folio room (R10, Sol S6). The generic Esc-back above stands aside while a room is up, because the room has
 * steps of its own: an open menu or sheet, a selection of several parts, Split, a saved version open read-only. Each of
 * those takes its Esc first and marks it handled. When all of them decline, Esc goes where the room's Back button goes.
 * Text being typed keeps its Esc.
 */
export function folioRoomEscapeGoesBack(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.defaultPrevented) return false
  const target = event.target as HTMLElement | null
  if (target?.closest?.('input, textarea, select, [contenteditable="true"], .cm-editor')) return false
  return !document.querySelector('[role="menu"], [role="alertdialog"], [role="dialog"], .overlay, [aria-modal="true"], .pal, .cv-sheet')
}

/** Esc goes back, unless something nearer wants it. */
export function useEscapeBack(onBack: (() => void) | undefined, enabled = true): void {
  const ref = useRef(onBack)
  ref.current = onBack
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (escapeBelongsElsewhere(event)) return
      event.preventDefault()
      ref.current?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

export function BackControl({ onBack, className = '', children, testId = 'back-control' }: { onBack: () => void; className?: string; children?: ReactNode; testId?: string }): JSX.Element {
  const name = useBackName()
  const label = backLabel(name)
  return (
    <button type="button" className={`back-control${className ? ` ${className}` : ''}`} data-testid={testId} title={`${label} (Esc)`} aria-label={label} onClick={onBack}>
      <ArrowLeft className="icon" aria-hidden="true" />
      <span className="back-control-label">{label}</span>
      {children}
    </button>
  )
}
