import { useSyncExternalStore } from 'react'
import type { MarginView } from './margin-model'

/**
 * Where the review cards sit, as the writer chose it: Margin (the default) or Inline. One store for the margin, the
 * count menu and the status bar's Margin | Inline switch, so all three always agree.
 *
 * The key is new in 0.25 (Dominik 2026-10-19, "margin is default"): 0.24's Margin | Under bar kept its choice under
 * LEGACY_VIEW_KEY, and a stale 'under' there left a wide window drawing the cards inline with no visible switch. That
 * key is never read; it is removed on first read, so only a choice made in this build's switch is honoured.
 */
export const VIEW_KEY = 'writeflex-margin-view-v2'
export const LEGACY_VIEW_KEY = 'writeflex-margin-view'

const listeners = new Set<() => void>()
let legacyCleared = false

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

export function readPreferredView(): MarginView {
  const store = storage()
  if (!store) return 'margin'
  try {
    if (!legacyCleared) { legacyCleared = true; store.removeItem(LEGACY_VIEW_KEY) }
    return store.getItem(VIEW_KEY) === 'under' ? 'under' : 'margin'
  } catch { return 'margin' }
}

export function setPreferredView(view: MarginView): void {
  try { storage()?.setItem(VIEW_KEY, view) } catch { /* the choice just is not kept */ }
  for (const listener of [...listeners]) listener()
}

export function subscribePreferredView(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The writer's chosen view, re-rendering when any surface changes it. */
export function usePreferredView(): MarginView {
  return useSyncExternalStore(subscribePreferredView, readPreferredView, () => 'margin')
}

/**
 * The room the open editor leaves for the text beside the margin (see margin-geometry's textRoomBesideMargin), as the
 * mounted margin last measured it; null when no margin is mounted. The status bar and the count menu read it to say
 * when Margin cannot fit.
 */
let textRoom: number | null = null
const roomListeners = new Set<() => void>()

export function readTextRoom(): number | null {
  return textRoom
}

export function setTextRoom(next: number | null): void {
  if (next === textRoom) return
  textRoom = next
  for (const listener of [...roomListeners]) listener()
}

export function subscribeTextRoom(listener: () => void): () => void {
  roomListeners.add(listener)
  return () => { roomListeners.delete(listener) }
}

export function useTextRoom(): number | null {
  return useSyncExternalStore(subscribeTextRoom, readTextRoom, () => null)
}
