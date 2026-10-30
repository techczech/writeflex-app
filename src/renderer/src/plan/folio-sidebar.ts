import { useSyncExternalStore } from 'react'
import { INITIAL_SIDEBAR, sidebarAfter, type SidebarAction, type SidebarState } from '../../../shared/folio-surface'

/**
 * The workspace's sidebar column (ADR-0049, layout 1A): one small store for what the column shows (Binder or
 * Inspector) and two slots the room draws into, both keyed by the Folio's folder (a second workspace, or a stale slot
 * from the Folio just left, can never overwrite this one's). The sidebar (app shell) owns the column; the room owns the
 * selection, the writes and the editor, so it draws the binder's TEXT section and the inspector INTO the sidebar's slots
 * through portals (the room's handlers stay the room's). ⌥⌘I, ×, the switch and a click on the title row all come
 * through `dispatchSidebar`, which acts on the active Folio (the one whose room last called `activateSidebar`); the
 * transitions are `sidebarAfter` (tested).
 */

export type SidebarSlot = 'text' | 'inspector'
const states = new Map<string, SidebarState>()
const slots = new Map<string, Partial<Record<SidebarSlot, HTMLElement>>>()
let activeDir: string | null = null
const stateListeners = new Set<() => void>()
const slotListeners = new Set<() => void>()
const notify = (listeners: Set<() => void>): void => { for (const listener of [...listeners]) listener() }

const stateOf = (dir: string | null): SidebarState => (dir === null ? INITIAL_SIDEBAR : states.get(dir) ?? INITIAL_SIDEBAR)

/** Actions that take the user out of the inspector, or to another subject in it. */
const LEAVES_INSPECTOR: ReadonlySet<SidebarAction> = new Set<SidebarAction>(['toggle-inspector', 'close-inspector', 'show-binder', 'select-title-row'])

/**
 * Closing the inspector never discards a field's draft: the fields commit on blur, so a field in the inspector that has
 * focus is blurred first (synchronously, through the field's own writer). The inspector also stays mounted while hidden
 * (FolioRoom), so a draft typed and not yet blurred survives the toggle either way.
 */
function commitInspectorDraft(dir: string, active: Element | null): void {
  const slot = slots.get(dir)?.inspector
  if (slot && active && slot.contains(active) && typeof (active as HTMLElement).blur === 'function') (active as HTMLElement).blur()
}

export function dispatchSidebar(action: SidebarAction, activeElement: Element | null = typeof document === 'undefined' ? null : document.activeElement): void {
  if (activeDir === null) return
  const dir = activeDir
  const before = stateOf(dir)
  const next = sidebarAfter(before, action)
  if (next === before) return
  if (before.mode === 'inspector' && LEAVES_INSPECTOR.has(action) && (next.mode !== 'inspector' || next.titleRow !== before.titleRow)) commitInspectorDraft(dir, activeElement)
  states.set(dir, next)
  notify(stateListeners)
}
/** `dir`'s Folio is the one on screen: it starts with the binder showing and the part (not the title row) as the subject. */
export function activateSidebar(dir: string): void {
  activeDir = dir
  states.set(dir, INITIAL_SIDEBAR)
  notify(stateListeners)
}
/** The Folio's workspace left the screen: its state goes with it (its slots are the sidebar's, released by the sidebar's own refs). */
export function releaseSidebar(dir: string): void {
  states.delete(dir)
  if (activeDir === dir) activeDir = null
  notify(stateListeners)
}
export function sidebarState(dir?: string): SidebarState { return stateOf(dir ?? activeDir) }
export function useSidebarState(dir: string): SidebarState {
  return useSyncExternalStore((listener) => { stateListeners.add(listener); return () => { stateListeners.delete(listener) } }, () => stateOf(dir))
}

export function registerSidebarSlot(dir: string, name: SidebarSlot, element: HTMLElement | null): void {
  const held = slots.get(dir) ?? {}
  if ((held[name] ?? null) === element) return
  if (element) held[name] = element; else delete held[name]
  slots.set(dir, held)
  notify(slotListeners)
}
/** The element the room of `dir` draws `name` into, or null while no sidebar shows it. */
export function useSidebarSlot(dir: string, name: SidebarSlot): HTMLElement | null {
  return useSyncExternalStore((listener) => { slotListeners.add(listener); return () => { slotListeners.delete(listener) } }, () => slots.get(dir)?.[name] ?? null)
}
