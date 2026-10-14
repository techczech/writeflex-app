import { Compartment, Prec, type Extension } from '@codemirror/state'
import { commandRan } from './command-ran'
import { EditorView, keymap, type KeyBinding } from '@codemirror/view'
import { formatShortcutKey } from '../app/shortcuts'
import { allBindableCommands, commandRegistry, registryCommand, type Command } from './registry'

/**
 * Assignable shortcuts (Round A T6, ADR-0028): the chord-resolution layer every binding surface
 * consults. Defaults stay in the registry's `keys`; the writer's overrides live in ONE settings
 * key, `shortcuts.overrides`, a JSON string of `Record<commandId, chord>`. Chords use the display
 * format the registry already speaks (`⌃⌥⇧⌘X`, the `formatShortcutKey` glyph order), so ledger,
 * cheat-sheet, palette and dispatch all compare the same strings.
 *
 * An override of `''` means EXPLICITLY UNASSIGNED — it hides the default (the move-it-here path);
 * a missing entry means "the default applies". No default chords for new commands (the pre-v1
 * consolidation ruling): their resolveChord is simply null until the writer assigns one.
 */

export type OverrideMap = Record<string, string>

export const SHORTCUT_OVERRIDES_KEY = 'shortcuts.overrides'

/** Parse the stored JSON-string setting; anything malformed reads as "no overrides". */
export function parseOverrides(raw: unknown): OverrideMap {
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: OverrideMap = {}
    for (const [id, chord] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof chord === 'string') out[id] = chord
    }
    return out
  } catch {
    return {}
  }
}

/** A command's default chords, display-normalised (CM specs like `Mod-t` become `⌘T`). */
export function defaultChords(command: Command): string[] {
  const keys = Array.isArray(command.keys) ? command.keys : command.keys ? [command.keys] : []
  return keys.map(formatShortcutKey)
}

/** The chords `command` actually answers to: the override when present ('' = none), else defaults. */
export function effectiveChords(command: Command, overrides: OverrideMap): string[] {
  const override = overrides[command.id]
  if (override !== undefined) return override === '' ? [] : [override]
  return defaultChords(command)
}

/** Chords displayed for one cheat-sheet row. Command references and direct registry rows resolve
 *  through effective chords; explicit literals retain their documented context or future keys. */
export function effectiveSheetChords(row: Command, overrides: OverrideMap): string[] {
  if (row.sheetSource?.kind === 'literal') return defaultChords(row)
  const command = row.sheetSource?.kind === 'command' ? registryCommand(row.sheetSource.commandId) : row
  return effectiveChords(command, overrides)
}

/** The PRIMARY effective chord for a command id: override ?? registry default ?? null. */
export function resolveChord(commandId: string, overrides: OverrideMap): string | null {
  const override = overrides[commandId]
  if (override !== undefined) return override === '' ? null : override
  const command = commandRegistry.find((entry) => entry.id === commandId)
  return command ? (defaultChords(command)[0] ?? null) : null
}

/** Labels of OTHER dispatchable commands whose EFFECTIVE chord equals `chord` — the ledger's
 *  conflict gate. Generated cheat-sheet rows document chords but never claim them. */
export function conflictsFor(chord: string, commandId: string, overrides: OverrideMap): string[] {
  const labels: string[] = []
  for (const command of commandRegistry) {
    if (command.id === commandId) continue
    if (command.claimsChord === false) continue
    if (!effectiveChords(command, overrides).includes(chord)) continue
    if (!labels.includes(command.label)) labels.push(command.label)
  }
  return labels
}

/** Ids of BINDABLE commands whose effective chord equals `chord` (the move-it-here targets). */
export function conflictingBindableIds(chord: string, commandId: string, overrides: OverrideMap): string[] {
  return allBindableCommands()
    .filter((command) => command.id !== commandId && effectiveChords(command, overrides).includes(chord))
    .map((command) => command.id)
}

/**
 * Every sheet-surfaced chord claim under `overrides` — the collision invariant's seam
 * (tests/main/command-registry.test.ts): chord → the labels claiming it. Structural typing keys
 * (↵ ⇥ ⇧⇥) are exempt as before.
 */
export function sheetChordClaims(overrides: OverrideMap): Map<string, Set<string>> {
  const structuralKeys = new Set(['↵', '⇥', '⇧⇥'])
  const claims = new Map<string, Set<string>>()
  for (const command of commandRegistry) {
    if (!command.surfaces.includes('sheet')) continue
    if (command.claimsChord === false) continue
    for (const chord of effectiveChords(command, overrides)) {
      if (structuralKeys.has(chord)) continue
      const labels = claims.get(chord) ?? new Set<string>()
      labels.add(command.label)
      claims.set(chord, labels)
    }
  }
  return claims
}

// ---------------------------------------------------------------------------
// Dispatch surfaces
// ---------------------------------------------------------------------------

/** Registry commands whose chords App dispatches at window level (their live runs need App state —
 *  the status chip + flash — not just the bare StateCommand). Kept OUT of the editor keymap so a
 *  chord fires exactly once. */
export const APP_DISPATCHED_EDITOR_IDS = new Set(['view.typewriter'])

const MODIFIER_GLYPHS: Record<string, string> = { '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift', '⌘': 'Mod' }
const KEY_GLYPHS: Record<string, string> = { '←': 'ArrowLeft', '→': 'ArrowRight', '↑': 'ArrowUp', '↓': 'ArrowDown', '⌫': 'Backspace', '⇥': 'Tab', '↵': 'Enter' }

/** Split a display chord into its modifier glyphs and key ('⌥⌘J' → { mods: ['⌥','⌘'], key: 'J' }). */
export function splitChord(chord: string): { mods: string[]; key: string } {
  const mods: string[] = []
  let rest = chord
  while (rest.length > 1 && MODIFIER_GLYPHS[rest[0]]) {
    mods.push(rest[0])
    rest = rest.slice(1)
  }
  return { mods, key: rest }
}

/** A display chord as a CodeMirror key spec ('⌃⌥⇧⌘F' → 'Ctrl-Alt-Shift-Mod-f'); null when the key
 *  part is not something a CM keymap can bind. */
export function chordToCmKey(chord: string): string | null {
  const { mods, key } = splitChord(chord)
  if (!key) return null
  const cmKey = KEY_GLYPHS[key] ?? (/^[A-Z]$/.test(key) ? key.toLowerCase() : key)
  return [...mods.map((glyph) => MODIFIER_GLYPHS[glyph]), cmKey].join('-')
}

/** The dynamic editor-surface keymap: every palette command WITH a registry run, bound at its
 *  effective chord. Built from the resolver so an override retires the default in the same act. */
export function buildEditorChordKeymap(overrides: OverrideMap, report = false): KeyBinding[] {
  const bindings: KeyBinding[] = []
  for (const command of commandRegistry) {
    if (!command.surfaces.includes('palette') || !command.run || APP_DISPATCHED_EDITOR_IDS.has(command.id)) continue
    for (const chord of effectiveChords(command, overrides)) {
      const key = chordToCmKey(chord)
      // Outside a list, outdent declines Shift-Tab. Let that unhandled key return focus to
      // the preceding control (including the Reading Room divider); handled commands still
      // prevent the browser default through CodeMirror's normal keymap dispatch.
      // `report`: the live keymap tells the Guide a command ran, only when it took the key (a command that
      // declines lets the key fall through, so it is not a run). The plain keymap keeps each `run` as it is.
      const run = command.run
      const reporting: KeyBinding['run'] = (view) => { const handled = run(view); if (handled) commandRan(command.id); return handled }
      if (key) bindings.push({ key, run: report ? reporting : run, preventDefault: key !== 'Shift-Tab' })
    }
  }
  return bindings
}

/** One compartment holds the whole editor chord keymap; reconfigured in place on override changes
 *  and reapplied per swapped-in EditorState (the typewriter pattern, EditorPane.switchTo). */
export const editorChordCompartment = new Compartment()

/** Prec.highest so an assigned chord wins over the static structural keymaps below it. */
export function editorChordExtension(overrides: OverrideMap): Extension {
  return Prec.highest(keymap.of(buildEditorChordKeymap(overrides, true)))
}

export function setEditorChords(view: EditorView, overrides: OverrideMap): void {
  view.dispatch({ effects: editorChordCompartment.reconfigure(editorChordExtension(overrides)) })
}

/** True while the Keycap Ledger's capture popover is recording a chord: App's overlay-raising
 *  capture-phase keys (⇧⌘K/⇧⌘P/⌘,/? — the ones that deliberately act OVER open sheets) stand down
 *  so the popover alone hears the keystroke. */
export const shortcutCaptureActive = { current: false }

/** Changelog copy for a `shortcuts.overrides` value: the chord the entry's command holds in `raw`
 *  (`null` = the stored map before this key ever existed → that command's default). */
export function chordDisplayForLog(raw: unknown, entryLabel: string): string {
  const label = entryLabel.startsWith('Shortcut: ') ? entryLabel.slice('Shortcut: '.length) : entryLabel
  const command = allBindableCommands().find((entry) => entry.label === label)
  if (!command) return 'Defaults'
  const chord = raw === null || raw === undefined ? (defaultChords(command)[0] ?? null) : resolveChord(command.id, parseOverrides(raw))
  return chord ?? 'Not assigned'
}
