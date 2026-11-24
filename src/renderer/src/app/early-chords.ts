/**
 * The first shortcut after launch (roadmap shortcut-lost-at-launch). The page takes keys a few
 * milliseconds before React has committed the app and its keyboard effect has put the chord listener in
 * place; a chord pressed in between reached no listener and was lost (traced: keydown at +12 ms,
 * listener at +17 ms, 11 of 40 runs).
 *
 * Three steps. `holdEarlyChords` (main.tsx, before React mounts) notes ⌘ and ⌃ chords. `stopHoldingEarlyChords`
 * (the app's chord listener is live) notes no more: later keys reach the app itself. `releaseEarlyChords`
 * (the saved shortcut settings have loaded) hands each noted chord to the app, which runs it only if it is
 * one of the few commands that are safe to run late, as bound now, and has a handler; anything else is
 * dropped. The recovery screen calls `abandonEarlyChords`.
 *
 * Never noted: keys typed while an input method is composing (a composing key carries a physical code that
 * can look like ⌘W), dead keys, auto-repeats, keys aimed at a text field. Escape or the window losing focus
 * forgets what was noted, as the writer has moved on. Nothing is prevented: no key is taken from anyone.
 */
export type EarlyChord = { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

type KeyLike = EarlyChord & { isComposing?: boolean; keyCode?: number; repeat?: boolean; target?: unknown }
type ListenerTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

/** A writer presses one or two shortcuts at launch; anything more is not a shortcut. */
export const EARLY_CHORD_LIMIT = 4
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'OS'])

let state: 'idle' | 'holding' | 'stopped' | 'done' = 'idle'
let host: ListenerTarget | null = null
const noted: EarlyChord[] = []

function textTarget(target: unknown): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null
  return typeof element?.closest === 'function' && element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor') !== null
}

function noteKey(e: KeyLike): void {
  if (e.key === 'Escape') { noted.length = 0; return }
  if (state !== 'holding') return
  if (e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead' || e.repeat) return
  if (!(e.metaKey || e.ctrlKey) || MODIFIER_KEYS.has(e.key) || textTarget(e.target)) return
  if (noted.length >= EARLY_CHORD_LIMIT) return
  noted.push({ key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey })
}
function onBlur(): void { noted.length = 0 }
const onKeyDown = noteKey as unknown as EventListener

function detach(): void {
  host?.removeEventListener('keydown', onKeyDown, true)
  host?.removeEventListener('blur', onBlur)
  host = null
}

/** Before the app mounts. */
export function holdEarlyChords(target: ListenerTarget = window): void {
  if (state !== 'idle') return
  state = 'holding'
  host = target
  target.addEventListener('keydown', onKeyDown, true)
  target.addEventListener('blur', onBlur)
}

/** The app's chord listener is live: later keys are its own. Escape and blur still forget what was noted. */
export function stopHoldingEarlyChords(): void {
  if (state === 'holding') state = 'stopped'
}

/** The saved shortcuts have loaded: each noted chord goes to `deliver`, in order, once; then this is done. */
export function releaseEarlyChords(deliver: (chord: EarlyChord) => void): void {
  if (state !== 'holding' && state !== 'stopped') return
  state = 'done'
  detach()
  for (const chord of noted.splice(0)) deliver(chord)
}

/** The app will not start (the recovery screen): forget everything and listen no more. */
export function abandonEarlyChords(): void {
  state = 'done'
  detach()
  noted.length = 0
}

/** Tests only. */
export function resetEarlyChordsForTest(): void {
  detach()
  state = 'idle'
  noted.length = 0
}
