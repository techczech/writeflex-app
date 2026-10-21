/**
 * Which folder "Capture to research…" files into, from what the writer SEES. A Plan or Collection view, or a Board,
 * hides the editor: its folder is the project and nothing is prefilled (a selection in a Piece open in a background
 * tab is not what the writer is looking at). Only when a Piece is the visible surface is it the project, with the
 * text selected in it.
 */
export type ResearchCaptureView = {
  /** The folder of the Plan or Collection view that is up (`''` = the Workspace root), or null when none is. */
  collectionDir: string | null
  /** True while the Board is the active tab. */
  boardActive: boolean
  boardDir: string
  /** The Piece open in the editor, or null. */
  activePiece: string | null
}

export type ResearchCaptureTarget = { project: string; withSelection: boolean }

export function researchCaptureTarget(view: ResearchCaptureView): ResearchCaptureTarget | null {
  if (view.collectionDir !== null) return { project: view.collectionDir, withSelection: false }
  if (view.boardActive) return { project: view.boardDir, withSelection: false }
  if (view.activePiece !== null) return { project: view.activePiece, withSelection: true }
  return null
}
