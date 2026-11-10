import { useSyncExternalStore } from 'react'
import type { ReadingVersion } from '../../../shared/folio-versions-view'

/**
 * Which Folio is showing a saved version read-only (Folio versions ticket 07), kept outside the room so the pieces that live
 * beside it (the sidebar's bin and its Undo, the app's palette commands that change the working Folio) can refuse while a
 * version is open. The room owns the state; this only mirrors it, keyed by the Folio's folder.
 */
const reading = new Map<string, ReadingVersion>()
const listeners = new Set<() => void>()
const notify = (): void => { for (const listener of [...listeners]) listener() }

/** The room of `dir` opened `version` (or left it, with null). */
export function setReadingVersion(dir: string, version: ReadingVersion | null): void {
  if (version === null) { if (!reading.delete(dir)) return } else reading.set(dir, version)
  notify()
}

/** The version `dir`'s room is showing, or null. */
export function readingVersionOf(dir: string): ReadingVersion | null { return reading.get(dir) ?? null }

/** Whether any Folio's room is showing a saved version now. */
export function anyVersionRead(): boolean { return reading.size > 0 }

export function useReadingVersion(dir: string | null): ReadingVersion | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => (dir === null ? null : reading.get(dir) ?? null))
}

/** The version some Folio shows now (the status bar's chip), or null. Stable between changes. */
export function useAnyReadingVersion(): ReadingVersion | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => reading.values().next().value ?? null)
}

/** True while any Folio shows a saved version (for the app's own commands). */
export function useAnyVersionRead(): boolean {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => reading.size > 0)
}

// ---- "Open in that version" (Folio versions ticket 10) ---------------------------------------------------------------------------
// A Scratchpad card that came from a saved version asks the window to open that version read-only on that part. The card does not know
// whether the Folio's room is on screen, so it only files the request (`OPEN_VERSION_REQUEST_EVENT`, handled by the app); the app makes
// sure the Folio is open and nudges the room (`OPEN_VERSION_NUDGE_EVENT`); the room takes the request that is waiting for its Folio.

export const OPEN_VERSION_REQUEST_EVENT = 'writeflex:folio-version-open-request'
export const OPEN_VERSION_NUDGE_EVENT = 'writeflex:folio-version-open-nudge'

/** A version to open read-only, on a part by the label the version recorded for it. */
export type OpenVersionRequest = { dir: string; versionId: string; path: string }

let waiting: OpenVersionRequest | null = null
export function setWaitingOpenVersion(request: OpenVersionRequest | null): void { waiting = request }
/** The request waiting for the Folio at `dir`, taken (a request is acted on once); null when none is for it. */
export function takeWaitingOpenVersion(dir: string): OpenVersionRequest | null {
  if (!waiting || waiting.dir !== dir) return null
  const request = waiting
  waiting = null
  return request
}
