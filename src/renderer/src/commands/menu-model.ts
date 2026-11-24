import type { EditorState } from '@codemirror/state'
import { toAccelerator, type MenuCommand } from '../../../shared/command-menu'
import { effectiveChords, type OverrideMap } from './chords'
import { commandLabel, commandRegistry, isActiveFileCommand, type Command } from './registry'

type LiveRow = { id: string; disabled?: boolean; checked?: boolean; labelName?: string }
function available(command: Command, row: LiveRow | undefined, state: EditorState | undefined, hasDocument: boolean): boolean {
  const history = command.id === 'edit.undo' || command.id === 'edit.redo'
  const appView = command.id === 'view.typewriter' || ['view.clean', 'view.markup', 'view.raw'].includes(command.id)
  return Boolean(row || command.run) && !row?.disabled
    && (!command.when || Boolean(state && command.when(state)))
    && ((history || appView) && Boolean(row) || !command.run || Boolean(hasDocument && state))
}

/** Only advertise keys that run this command from the document editor. Place-owned keys stay on their own surfaces. */
export function menuChord(command: Command, overrides: OverrideMap): string | undefined {
  // The named-skill keys open particular threads; this menu item opens the chooser.
  const isPlaceOnly = command.keysPlaceBound && !(isActiveFileCommand(command.id) && overrides[command.id] !== undefined)
  if (isPlaceOnly || command.claimsChord === false || command.id === 'skills.openThread') return undefined
  return effectiveChords(command, overrides).find(k => toAccelerator(k) !== undefined)
}

/** Keep unavailable commands in the menu even when the palette filters their rows out. `liveChecks` (state owned by mounted surfaces) wins over the row's. */
export function menuCommands(rows: readonly LiveRow[], overrides: OverrideMap, state: EditorState | undefined, hasDocument: boolean, liveChecks: Readonly<Record<string, boolean>> = {}): MenuCommand[] {
  const byId = new Map(rows.map(row => [row.id, row]))
  const commands = commandRegistry.filter(c => (c.surfaces.includes('palette') || c.surfaces.includes('menu'))).map(command => {
    const row = byId.get(command.id)
    const checked = liveChecks[command.id] ?? row?.checked
    return {
      id: command.id, label: commandLabel(command, { checked, name: row?.labelName }), task: command.task, subgroup: command.subgroup,
      chord: menuChord(command, overrides),
      enabled: available(command, row, state, hasDocument),
      // A name that already says what will happen (Pin / Unpin) needs no tick beside it.
      checked: command.labelWhenOn || command.labelNamed ? undefined : checked,
      noMenu: command.noMenu,
      nativeAccelerator: false,
    }
  })
  // A stored override may predate the ledger's collision gate. Never advertise an ambiguous key.
  const identity = (chord?: string) => toAccelerator(chord)?.split('+').sort().join('+')
  const counts = new Map<string, number>()
  for (const command of commands) {
    const key = identity(command.chord)
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return commands.map(command => (counts.get(identity(command.chord) ?? '') ?? 0) > 1 ? { ...command, chord: undefined } : command)
}

/** Recheck at click time: the editor may have changed since Electron received its model. */
export function dispatchMenuCommand<T extends LiveRow>(id: string, rows: readonly T[], state: EditorState | undefined, hasDocument: boolean, runRow: (row: T) => void, runEditor: (command: Command) => void): void {
  const command = commandRegistry.find(c => c.id === id && (c.surfaces.includes('palette') || c.surfaces.includes('menu')))
  const row = rows.find(r => r.id === id)
  if (!command || !available(command, row, state, hasDocument)) return
  if (row) runRow(row)
  else runEditor(command)
}

/** Cheap structural comparison (no serialising): the fields a menu reads, entry by entry. */
export function sameMenuModel(a: readonly MenuCommand[], b: readonly MenuCommand[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i]
    if (x.id !== y.id || x.label !== y.label || x.chord !== y.chord || x.enabled !== y.enabled || x.checked !== y.checked || x.nativeAccelerator !== y.nativeAccelerator) return false
  }
  return true
}
