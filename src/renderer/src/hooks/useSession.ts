import { useCallback, useEffect, useRef, useState } from 'react'
import { countWords } from '../editor/word-count'

/** Dim the session chip once no word has been added for this long (PRD S14: presence, not a reset —
 *  the elapsed clock keeps running; only the chip's emphasis fades). */
const IDLE_MS = 90_000
const TICK_MS = 1_000

export type SessionState = {
  /** Report a file's current text. The FIRST report for a path fixes its baseline (words already
   *  present when first seen this window); later reports move that file's contribution to +/- words. */
  observe: (path: string, doc: string) => void
  /** Net words added across every file seen this window (may be negative after deletions). */
  sessionWords: number
  /** Wall-clock time since the window opened, as `m:ss` (the mockup's `24:06`). */
  elapsedLabel: string
  /** sessionWords per elapsed minute, rounded (0 until a minute's fraction and some words exist). */
  wpm: number
  /** True once IDLE_MS has passed with no word added — the chip dims (CSS class only). */
  idle: boolean
  /** The shared once-a-second wall-clock tick. Time-derived chrome must reuse this value. */
  now: number
}

/**
 * The writing session for one window (ADR-0007: window per workspace), spanning every tab for the
 * window's whole lifetime. It is deliberately renderer-only and unpersisted: a session is "this
 * sitting", so opening the window starts a fresh clock. App feeds `observe` from the two places a
 * file's text becomes known — the tab-activation read (baseline) and every doc change (current) —
 * which is what lets the +words tally follow edits made in background tabs after a switch back.
 */
export function useSession(): SessionState {
  const startRef = useRef(Date.now())
  const lastActivityRef = useRef(Date.now())
  const baselineRef = useRef(new Map<string, number>())
  const currentRef = useRef(new Map<string, number>())
  const [sessionWords, setSessionWords] = useState(0)
  // A once-a-second tick drives the elapsed clock and the idle re-check; it is the only thing that
  // re-renders on wall-clock time (word changes re-render through setSessionWords).
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const observe = useCallback((path: string, doc: string) => {
    const words = countWords(doc, { excludeCommentLines: true })
    const baseline = baselineRef.current
    const current = currentRef.current
    if (!baseline.has(path)) {
      // First sight: fix the baseline. This is not "activity" (the reader has added nothing yet), so
      // it neither bumps the idle clock nor moves the tally.
      baseline.set(path, words)
      current.set(path, words)
      return
    }
    if (current.get(path) === words) return // a selection-only / no-op update: ignore
    current.set(path, words)
    lastActivityRef.current = Date.now()
    let total = 0
    for (const [seenPath, base] of baseline) total += (current.get(seenPath) ?? base) - base
    setSessionWords(total)
  }, [])

  const elapsedMs = Math.max(0, now - startRef.current)
  const minutes = Math.floor(elapsedMs / 60_000)
  const seconds = Math.floor((elapsedMs % 60_000) / 1_000)
  const elapsedLabel = `${minutes}:${String(seconds).padStart(2, '0')}`
  const elapsedMinutes = elapsedMs / 60_000
  // wpm counts only words ADDED (a net-negative session is a 0 wpm session, not a negative one).
  const wpm = elapsedMinutes > 0 ? Math.round(Math.max(0, sessionWords) / elapsedMinutes) : 0
  const idle = now - lastActivityRef.current > IDLE_MS

  return { observe, sessionWords, elapsedLabel, wpm, idle, now }
}
