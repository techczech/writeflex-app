import { useSyncExternalStore } from 'react'

/**
 * The status bar's one notice slot (house rule R2). The bar registers its slot element here; the update
 * answer card draws itself into it, so a notice never floats over the right sidebar or the composer.
 * Where there is no status bar (the Collection page) the card falls back to a strip along the bottom.
 */
let slot: HTMLElement | null = null
const listeners = new Set<() => void>()
export function registerNoticeSlot(element: HTMLElement | null): void {
  if (slot === element) return
  slot = element
  listeners.forEach((listener) => listener())
}
const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useNoticeSlot = (): HTMLElement | null => useSyncExternalStore(subscribe, () => slot)

/**
 * Where the Folio part line ("‹ 1 of 11 ›") is drawn: the status bar's Folio slot, so it is no longer a row
 * of its own above the text. Without a status bar the editor keeps its own host.
 */
let folioSlot: HTMLElement | null = null
const folioListeners = new Set<() => void>()
export function registerFolioSlot(element: HTMLElement | null): void {
  if (folioSlot === element) return
  folioSlot = element
  folioListeners.forEach((listener) => listener())
}
const subscribeFolio = (listener: () => void): (() => void) => { folioListeners.add(listener); return () => { folioListeners.delete(listener) } }
export const useFolioSlot = (): HTMLElement | null => useSyncExternalStore(subscribeFolio, () => folioSlot)

/**
 * Where the collapsed Scratchpad pill is drawn: a chip in the status bar ("Scratchpad · N"), so it never lies over the text
 * or a control (house rules R2 and R7). Without a status bar there is no chip; ⇧⌘J still opens the Scratchpad.
 */
let scratchpadSlot: HTMLElement | null = null
const scratchpadListeners = new Set<() => void>()
export function registerScratchpadSlot(element: HTMLElement | null): void {
  if (scratchpadSlot === element) return
  scratchpadSlot = element
  scratchpadListeners.forEach((listener) => listener())
}
const subscribeScratchpad = (listener: () => void): (() => void) => { scratchpadListeners.add(listener); return () => { scratchpadListeners.delete(listener) } }
export const useScratchpadSlot = (): HTMLElement | null => useSyncExternalStore(subscribeScratchpad, () => scratchpadSlot)
