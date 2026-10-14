/**
 * The Board's material steps (docs/design/2026-09-27-scraps-and-sources-on-the-board, frames 2, 3
 * and 4): an offcut becomes an idea, a drawer scrap is added to the end of its piece (each writes two
 * files), and a source from the rail is attached to a piece (one line in one file). Each is ONE undo
 * group. Shared by main (the desk) and the renderer (the activity row).
 */

export type BoardStepKind = 'idea' | 'append' | 'source'

/** A step the Board can undo: `id` is its restore point, `activity` is the activity row's words. */
export type BoardStep = { id: string; kind: BoardStepKind; activity: string }

export type BoardStepResult =
  | { ok: true; step: BoardStep; paths: string[] }
  | { ok: false; message: string }

export type BoardUndoResult =
  | { ok: true; paths: string[] }
  | { ok: false; message: string }

export type PromoteOffcutInput = { dir: string; scrapsPath: string; scrapId: string; name: string }
export type AppendScrapInput = { piece: string; scrapId: string }
/** A research note (`source`) attached to a piece of the Collection at `dir`. */
export type AttachSourceInput = { dir: string; piece: string; source: string }

/** The activity row's words for each step (frames 3 and 4). */
export const OFFCUT_BECAME_IDEA = 'Offcut became an idea'
export const scrapAddedTo = (pieceTitle: string): string => `Scrap added to the end of ${pieceTitle}`
export const SOURCE_ATTACHED = 'Source attached'
