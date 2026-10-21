export type ShortcutLike = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key' | 'code'>

export function isWriterModeToggleShortcut(e: ShortcutLike): boolean {
  return (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === 'KeyM'
}

export function isCheatSheetShortcut(e: ShortcutLike): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && e.code === 'Slash'
}

export type SkillChordIntent = { index: 0 | 1 | 2; openThread: boolean }

/** Physical Digit codes survive macOS Option's produced-character remapping (1 → ¡, 2 → ™, etc.). */
export function skillChordIntent(e: ShortcutLike): SkillChordIntent | null {
  if (!(e.metaKey || e.ctrlKey) || !e.altKey) return null
  const index = ({ Digit1: 0, Digit2: 1, Digit3: 2 } as const)[e.code as 'Digit1' | 'Digit2' | 'Digit3']
  return index === undefined ? null : { index, openThread: e.shiftKey }
}

export function isThreadsSwitcherShortcut(e: ShortcutLike): boolean {
  return (e.metaKey || e.ctrlKey) && e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyT'
}

export const OPEN_CHEAT_SHEET_EVENT = 'writeflex:open-cheat-sheet'

/** Crosses editor-owned DOM boundaries without weakening their event containment. */
export function requestCheatSheet(target: EventTarget): void {
  target.dispatchEvent(new CustomEvent(OPEN_CHEAT_SHEET_EVENT, { bubbles: true, composed: true }))
}

/** Physical-code → chord-key names for eventToChord. Letters/digits/F-keys are derived; this map
 *  covers the punctuation codes chords realistically land on (Option remaps produced characters on
 *  macOS — ⌥⌘[ produces '„' — so e.code is the only stable identity, the ⌥⌘R lesson). */
const CODE_KEYS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Backslash: '\\',
  Tab: '⇥',
  Enter: '↵',
}

/**
 * Normalise a keydown into the registry's display-chord format (`⌃⌥⇧⌘X`, the same glyph order
 * `formatShortcutKey` emits) — the Keycap Ledger's capture format and the dispatch tables' key.
 * Returns null for anything that is not a chord: bare/shift-only letters and digits (typing),
 * pure modifier presses, and keys outside the stable-code set. Single F-keys pass (F2 = Rename).
 * On non-macOS platforms Ctrl plays the ⌘ role, so stored chords stay portable.
 */
export function eventToChord(e: ShortcutLike, platform?: 'mac' | 'other'): string | null {
  const mac = platform ? platform === 'mac' : typeof navigator === 'undefined' || /Mac|iP/.test(navigator.platform)
  const code = e.code
  let key: string | null = null
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^F([1-9]|1[0-2])$/.test(code)) key = code
  else key = CODE_KEYS[code] ?? null
  if (!key) return null
  const command = mac ? e.metaKey : e.ctrlKey
  const control = mac ? e.ctrlKey : false
  if (!command && !control && !e.altKey && !/^F\d+$/.test(key)) return null
  const mods = [control ? '⌃' : '', e.altKey ? '⌥' : '', e.shiftKey ? '⇧' : '', command ? '⌘' : ''].join('')
  return `${mods}${key}`
}

/**
 * A modified Backspace as a chord (`⇧⌘⌫`), which `eventToChord` deliberately does not produce: ⌫ chords belong to the
 * places that own them (the editor's ⌃⌘⌫, the file tree's ⌘⌫). The app dispatcher asks for it only for the commands it
 * lists as dispatched on ⌫ (review margin ticket 04: ⇧⌘⌫ Decline all). Null without ⌘ (⌃ elsewhere) or for another key.
 */
export function backspaceChord(e: ShortcutLike, platform?: 'mac' | 'other'): string | null {
  if (e.code !== 'Backspace') return null
  const mac = platform ? platform === 'mac' : typeof navigator === 'undefined' || /Mac|iP/.test(navigator.platform)
  const command = mac ? e.metaKey : e.ctrlKey
  if (!command) return null
  const control = mac ? e.ctrlKey : false
  return `${control ? '⌃' : ''}${e.altKey ? '⌥' : ''}${e.shiftKey ? '⇧' : ''}⌘⌫`
}

/** A chord with its modifier glyphs in the order eventToChord writes them (⌃⌥⇧⌘), so `⇧⌥⌘V` and `⌥⇧⌘V` are one chord. */
export function canonicalChord(chord: string): string {
  const glyphs = '⌃⌥⇧⌘'
  const mods = [...chord].filter((ch) => glyphs.includes(ch))
  const key = [...chord].filter((ch) => !glyphs.includes(ch)).join('')
  return `${glyphs.split('').filter((g) => mods.includes(g)).join('')}${key}`
}

/** Normalise CodeMirror registry keys for palette and cheat-sheet display. */
export function formatShortcutKey(keySpec: string): string {
  if (!keySpec.includes('-')) return keySpec
  const parts = keySpec.split('-')
  let key = parts.pop() ?? ''
  const mods = parts.map((part) => part.toLowerCase())
  // Shifted punctuation is already visible in the produced glyph: ⇧/ is `?`, not `⇧/`.
  if (mods.includes('shift') && key === '/') key = '?'
  const glyphs = [
    mods.includes('ctrl') ? '⌃' : '',
    mods.includes('alt') ? '⌥' : '',
    mods.includes('shift') && key !== '?' ? '⇧' : '',
    mods.includes('mod') ? '⌘' : '',
  ].join('')
  return `${glyphs}${key.length === 1 && /[a-z]/i.test(key) ? key.toUpperCase() : key}`
}
