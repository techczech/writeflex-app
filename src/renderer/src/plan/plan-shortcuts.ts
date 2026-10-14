import { eventToChord, type ShortcutLike } from '../app/shortcuts'
import { resolveChord, type OverrideMap } from '../commands/chords'
import type { PlanCommandName } from './plan-commands'

type PlanKeyEvent = ShortcutLike & { key: string }

/** Convert Plan-context structural and modified keys to the registry's display format. */
export function planEventChord(event: PlanKeyEvent): string | null {
  const unmodified = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  if (unmodified && /^[a-z]$/i.test(event.key)) return event.key.toLocaleUpperCase()
  if (unmodified && event.key === 'Enter') return '↵'
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === 'Backspace') return '⌘⌫'
  return eventToChord(event)
}

const PLAN_SHORTCUT_COMMANDS: Array<[string, PlanCommandName]> = [
  ['plan.addPart', 'add'],
  ['plan.adoptPart', 'adopt'],
  ['plan.moveUp', 'move-up'],
  ['plan.moveDown', 'move-down'],
  ['plan.materialise', 'open-part'],
  ['plan.removePart', 'remove'],
]

export function planCommandForEvent(event: PlanKeyEvent, overrides: OverrideMap): PlanCommandName | null {
  const chord = planEventChord(event)
  if (!chord) return null
  return PLAN_SHORTCUT_COMMANDS.find(([id]) => resolveChord(id, overrides) === chord)?.[1] ?? null
}
