/** Palette commands that act on the open Board's selection (the plan-commands pattern). */
export const BOARD_COMMAND_EVENT = 'writeflex:board-command'

export type BoardCommandName = 'make-idea' | 'toggle-offcuts' | 'undo-step' | 'toggle-sources' | 'attach-source' | 'list-sources' | 'move-column-left' | 'move-column-right'

export function dispatchBoardCommand(command: BoardCommandName): void {
  window.dispatchEvent(new CustomEvent<BoardCommandName>(BOARD_COMMAND_EVENT, { detail: command }))
}
