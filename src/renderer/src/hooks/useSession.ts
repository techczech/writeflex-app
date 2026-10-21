import { useCallback, useEffect, useRef, useState } from 'react'
import { countWords } from '../editor/word-count'

/** Dim the session chip once no word has been added for this long (PRD S14: presence, not a reset —
 *  the elapsed clock keeps running; only the chip's emphasis fades). */
const IDLE_MS = 90_000
const TICK_MS = 1_000
/** The pause in observed edits after which the session's words are counted. */
const COUNT_DEBOUNCE_MS = 500

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

  // Counting words is a whole-document pass, so `observe` only records the text and the count
  // happens once per pause in typing. The FIRST text seen for a path is kept until it is counted,
  // because the baseline is that text's words, not the words of whatever it has become by the pause.
  const pendingRef = useRef(new Map<string, { first: string | null; latest: string; at: number }>())
  const flushTimerRef = useRef<ReturnType<typeof setTimeout>>()

  const flush = useCallback(() => {
    clearTimeout(flushTimerRef.current)
    flushTimerRef.current = undefined
    const pending = pendingRef.current
    if (pending.size === 0) return
    const baseline = baselineRef.current
    const current = currentRef.current
    let moved = false
    for (const [path, { first, latest, at }] of pending) {
      let words: number
      if (!baseline.has(path)) {
        // First sight: fix the baseline. This is not "activity" (the reader has added nothing yet), so
        // it neither bumps the idle clock nor moves the tally.
        const firstWords = countWords(first ?? latest, { excludeCommentLines: true })
        baseline.set(path, firstWords)
        current.set(path, firstWords)
        if (first === null || first === latest) continue
        words = countWords(latest, { excludeCommentLines: true })
      } else {
        words = countWords(latest, { excludeCommentLines: true })
      }
      if (current.get(path) === words) continue // a selection-only / no-op update: ignore
      current.set(path, words)
      lastActivityRef.current = at
      moved = true
    }
    pending.clear()
    if (!moved) return
    let total = 0
    for (const [seenPath, base] of baseline) total += (current.get(seenPath) ?? base) - base
    setSessionWords(total)
  }, [])

  const observe = useCallback((path: string, doc: string) => {
    const pending = pendingRef.current
    const prior = pending.get(path)
    pending.set(path, { first: prior ? prior.first : baselineRef.current.has(path) ? null : doc, latest: doc, at: Date.now() })
    clearTimeout(flushTimerRef.current)
    flushTimerRef.current = setTimeout(flush, COUNT_DEBOUNCE_MS)
  }, [flush])
  useEffect(() => () => clearTimeout(flushTimerRef.current), [])

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
