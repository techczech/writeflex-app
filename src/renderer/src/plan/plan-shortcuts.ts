import { eventToChord, type ShortcutLike } from '../app/shortcuts'
import { effectiveChords, resolveChord, type OverrideMap } from '../commands/chords'
import { commandRegistry } from '../commands/registry'
import type { PlanCommandName } from './plan-commands'

type PlanKeyEvent = ShortcutLike & { key: string }

/** Convert Plan-context structural and modified keys to the registry's display format. */
export function planEventChord(event: PlanKeyEvent): string | null {
  const unmodified = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  if (unmodified && /^[a-z]$/i.test(event.key)) return event.key.toLocaleUpperCase()
  // Shift alone with a letter (⇧H, ⇧T): the app's own chords always carry ⌘, ⌃ or ⌥, so this is the Folio outline's.
  if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && /^[a-z]$/i.test(event.key)) return `⇧${event.key.toLocaleUpperCase()}`
  if (unmodified && event.key === 'Enter') return '↵'
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === 'Backspace') return '⌘⌫'
  return eventToChord(event)
}

const PLAN_SHORTCUT_COMMANDS: Array<[string, PlanCommandName]> = [
  ['plan.addPart', 'add'],
  ['plan.adoptPart', 'adopt'],
  ['plan.adoptAsFrontMatter', 'adopt-front-matter'],
  ['plan.moveUp', 'move-up'],
  ['plan.moveDown', 'move-down'],
  ['plan.materialise', 'open-part'],
  ['plan.removePart', 'remove'],
  ['plan.details', 'details'],
  ['plan.role', 'role'],
  // The title buttons: H and T on the selected part, ⇧H and ⇧T on every part (their ⌃⌥⌘ chords also reach the app).
  ['title.useHeadingAsTitle', 'title-heading-to-title'],
  ['title.useTitleAsHeading', 'title-title-to-heading'],
  ['title.useHeadingsAsTitlesAll', 'titles-heading-to-title'],
  ['title.useTitlesAsHeadingsAll', 'titles-title-to-heading'],
]

export function planCommandForEvent(event: PlanKeyEvent, overrides: OverrideMap): PlanCommandName | null {
  const chord = planEventChord(event)
  if (!chord) return null
  return PLAN_SHORTCUT_COMMANDS.find(([id]) => {
    const command = commandRegistry.find((entry) => entry.id === id)
    // Every chord the command answers to, not only its first: H is the second chord of Use heading as title.
    return command ? effectiveChords(command, overrides).includes(chord) : resolveChord(id, overrides) === chord
  })?.[1] ?? null
}
