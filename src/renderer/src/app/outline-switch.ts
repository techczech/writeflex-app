import type { LeftPaneTab } from './pane-layout'

/**
 * When the sidebar moves from the file list to the Outline (outline package, ticket 13).
 *
 * Opening a file from Files or Search keeps the sidebar where it is, so the writer can click through
 * files. That open ARMS the switch for that one file. The first click or keystroke inside the document
 * afterwards moves the sidebar to Outline and consumes the arm: once per opened file. Every other way of
 * opening a file (restore, quick-open, new file, links) disarms it.
 */
export type OutlineSwitchState = { armedPath: string | null }

export type OpenSource = 'files' | 'search' | 'other'

export const OUTLINE_SWITCH_IDLE: OutlineSwitchState = { armedPath: null }

type SidebarLayout = { tab: LeftPaneTab; collapsed: boolean }

/** Borrow the sidebar for either Folio surface, then restore it exactly once when that Folio is left. */
export function folioSidebarLayout(saved: SidebarLayout | null, dir: string | null, current: SidebarLayout): { saved: SidebarLayout | null; layout: SidebarLayout | null } {
  if (dir !== null) return saved === null ? { saved: current, layout: { tab: 'outline', collapsed: false } } : { saved, layout: null }
  return { saved: null, layout: saved }
}

export function noteFileOpened(_state: OutlineSwitchState, path: string, source: OpenSource): OutlineSwitchState {
  return { armedPath: source === 'files' || source === 'search' ? path : null }
}

export function noteDocumentInteraction(
  state: OutlineSwitchState,
  activePath: string | null,
  leftTab: LeftPaneTab,
): { state: OutlineSwitchState; switchToOutline: boolean } {
  if (state.armedPath === null || state.armedPath !== activePath) return { state, switchToOutline: false }
  return { state: OUTLINE_SWITCH_IDLE, switchToOutline: leftTab !== 'outline' }
}
