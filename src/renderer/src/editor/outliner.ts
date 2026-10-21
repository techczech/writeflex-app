import type { StateCommand } from '@codemirror/state'
import { moveLineDown, moveLineUp, insertTab } from '@codemirror/commands'
import type { KeyBinding } from '@codemirror/view'
export { indentListItem, outdentListItem } from '@app-patterns/outline'

export function selectedLines(state: Parameters<StateCommand>[0]['state']): number[] {
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    for (let pos = range.from; ; ) {
      const line = state.doc.lineAt(pos)
      lines.add(line.number)
      if (line.to >= range.to) break
      pos = line.to + 1
    }
  }
  return [...lines].sort((a, b) => a - b)
}

export const outlinerKeymap: KeyBinding[] = [
  { key: 'Tab', run: insertTab },
  { key: 'Alt-ArrowUp', run: moveLineUp },
  { key: 'Alt-ArrowDown', run: moveLineDown }
]
