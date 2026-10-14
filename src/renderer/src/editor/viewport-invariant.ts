import { EditorSelection, type SelectionRange } from '@codemirror/state'

/** A ledger refresh may repaint a selected revision, but only a deliberate NEW selection may navigate. */
export function shouldScrollForSelectedRevision(
  previousId: string | null,
  selectedId: string | null,
  revisionDecorationsAreVisible: boolean,
): boolean {
  return revisionDecorationsAreVisible && selectedId !== null && selectedId !== previousId
}

/** Keep a review resolution at the reader's current scroll position across CM's immediate and measured passes. */
export function preserveViewportPosition(
  scroller: { scrollTop: number },
  resolve: () => void,
  scheduleRestore: (restore: () => void) => void,
): void {
  const scrollTop = scroller.scrollTop
  resolve()
  scroller.scrollTop = scrollTop
  scheduleRestore(() => { scroller.scrollTop = scrollTop })
}

/** Preserve the writer's exact numeric selection where possible when disk content changes underneath it. */
export function clampSelectionToDocument(selection: EditorSelection, docLength: number): EditorSelection {
  const clamp = (position: number): number => Math.max(0, Math.min(position, docLength))
  const ranges = selection.ranges.map((range: SelectionRange) =>
    EditorSelection.range(
      clamp(range.anchor),
      clamp(range.head),
      range.goalColumn,
      range.bidiLevel ?? undefined,
      range.assoc,
    ))
  return EditorSelection.create(ranges, selection.mainIndex)
}
