/**
 * App-owned operations on standard widgets (ticket 04a): create a widget and insert it into a document, update a
 * widget's recipe, build, and undo; and for the workbench (04b) a preview that writes nothing
 * (`previewStandardWidgetDraft`). Create and update may also save edited source text (`sourceEdit`: a real CSV or
 * JSON file in the Folio folder, written by the guarded write only over the text the caller read) as part of their
 * one step, and create may put the embed line at a caret's line (`{ line }`, checked against `documentBasis`).
 * Main process only; the renderer reaches them through the preload bridge.
 *
 * Create and insert is ONE undoable step (contracts §14 C5 and its amendments, Dominik 2026-10-19/20):
 *   0. for a document in no Folio whose folder holds other files, the writer has answered the own-folder sheet
 *      (`placement`, required there; only a lone document in no Folio goes ahead without it). The answer carries the
 *      fingerprint of the plan the sheet showed (shared/own-folder-plan.ts); the engine plans again over the folder
 *      as it is now and refuses (`own-folder-changed`) on any difference. When documents move, the step is COPY
 *      FIRST, REMOVE LAST, with a step journal in `.writeflex/` (step-journal.ts): the chosen documents are copied
 *      into a new subfolder (own-folder.ts `copyFileGuarded`: read without following a link, only plain UTF-8 text,
 *      written as new files by the guarded write into the very folder made), their relative links carried along;
 *      the Folio's manifest, the widget and its build and the embed are written; the links elsewhere are carried
 *      after them (relative links here, wikilinks by the app's rename repair; a file that is not plain UTF-8 text is
 *      never rewritten, and named in `notices`); only then, as the last part, are the old names removed, each only
 *      over the text its copy was made from. The data file is copied into the widget's folder or moved there (its
 *      original removed in that last part), never under a name the build writes (`data-<name>` then). Every
 *      document chosen: nothing moves;
 *   1. a document in no Folio becomes one by the existing Make Folio path: the manifest written only when none
 *      exists (`assertManifestAbsent`), listing the chosen documents in the chosen order (this one alone when
 *      nothing was asked), plus the Folio's agent instructions (`writeFolioAgentInstructions`);
 *   2. `visualisations/<name>/widget.md` is written beside the Folio's manifest (the Folio folder);
 *   3. the widget is built (`buildStandardWidget`); a build with any error stops the step;
 *   4. the embed line goes into the document, only over the text the caller saw.
 * Every file written in the step is recorded (`Workspace.recordingOperationWrites`). If any part fails, all of it
 * is put back at once. Every file in a widget folder is written by the guarded write (`writeInWidgetFolder`), so a
 * folder swapped for a link puts nothing outside the Workspace. Undo puts back every file and removes the folders
 * the step made, but only while every file still holds exactly what the step wrote; otherwise it refuses and
 * changes nothing. It puts the document back first; if any file cannot be put back it stops there, keeps the rest
 * (no embed is left pointing at a removed widget) and keeps the step for another try. A step that moved documents
 * is put back (rollback and undo) by its own guarded put-back (step-put-back.ts): every rewritten or removed file
 * first, by the guarded write into the very folder the step recorded, and the files it made only after all of
 * that, so a moved document is never left in neither place.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { assertManifestAbsent, MANIFEST_NAME } from '../folio'
import { writeFolioAgentInstructions } from '../folio-agent-instructions'
import { AGENTS_FILE, CLAUDE_FILE } from '../../shared/folio-agent-files'
import { folioContaining, invalidateFolioPlaces } from '../folio-place'
import { rollBackOperationWrites, rollbackMessage } from '../operation-rollback'
import { walkNoFollowSync } from '../widget-file'
import { assertRelativeWorkspacePath, isHiddenWorkspacePath, type OperationWrite, type Workspace } from '../workspace'
import { documentLineCount, insertWidgetAtLine, insertWidgetInText, relativeEmbedPath } from '../../shared/widget-insert'
import { readContainedFile, WIDGET_MAX_BYTES } from '../widget-file'
import { buildStandardWidget, previewStandardWidget, recipePlace, SOURCE_MAX_BYTES, VISUALISATIONS_DIR, WIDGET_OUTPUT_NAME, WIDGET_REBUILT_NAME, WIDGET_RECEIPT_NAME, WIDGET_RECIPE_NAME, writeInWidgetFolder, type BuildOptions, type BuildOutcome } from './build'
import { buildError, type BuildError } from './build-errors'
import { ensureFolder, folderIdentity, FolderLeftBehind, LEFT_FOLDER, operationSeams, removeMadeFolders, type MadeFolder } from './step-folders'
import { checkedFolder, copyFileGuarded, freeWidgetFolder, isPlainTextFile, MARKDOWN_FILE, readOwnFolderFacts, removeOriginalGuarded, repairWikilinksForMoves, retargetLinksElsewhere, widgetFolderName, type CheckedFolder } from './own-folder'
import { choiceMatchesFacts, planFingerprint, planOwnFolder, widgetDataFileName, type OwnFolderChoice, type OwnFolderPlan } from '../../shared/own-folder-plan'
import { putBackMessage, putBackOne, putBackOrder, putBackStep, stepChanges, type FolderId } from './step-put-back'
import { StepJournal } from './step-journal'
import { recordingBytesBefore, type BytesBefore } from './step-bytes-before'
import { rebaseRelativeLinks } from '../relative-link-rebase'
import { checkRecipe, isRecipeMap, parseRecipeText, recipeText, RecipeWriteRefused, updatedRecipeText, type RecipeMap, type RecipeValue } from './recipe'
import { exactUtf8, intakeOutsideFile, isGenuinePick, pickStillAuthorised, RESOURCES_DIR, undoGrantWrites, type Inclusion, type IntakeResult, type OutsidePick } from './outside-files'
import { appSyncGrantStore, type GrantWrite, type SyncGrantStore } from './sync-grants'

/** Where the embed line goes: 'start', 'end', after widget N (a number), or where a caret on 1-based `line` of the
 *  document puts it (`{ line }`; needs `documentBasis`, and the line must be one of its lines). */
export type WidgetPosition = 'start' | 'end' | number | { line: number }

/** A file picked outside the document's folders (outside-files.ts), to be brought into the Folio's resources by
 *  the step: copied (`copy`) or copied and kept in sync with its original (`sync`, a grant written). Made in main
 *  from the picker's token only; never from a renderer's or an agent's words. */
export type OutsideRequest = { pick: OutsidePick; inclusion: Inclusion }

/** What the renderer sends for an outside file: the picker's opaque token and the writer's choice. */
export type PickChoice = { token: string; inclusion: Inclusion }

/** New text for the widget's CSV or JSON source, written in the same step, only over `basis` (the text the caller
 *  read). The file is the widget's own source; it must already be a real file inside the Folio folder. */
export type SourceEdit = { text: string; basis: string }

export type CreateWidgetRequest = {
  /** Workspace-relative Markdown document the widget goes into. */
  documentPath: string
  /** The widget's folder name, cleaned to letters, digits and hyphens; a free name is chosen (`-2`, `-3`, …). */
  name: string
  /** The recipe, without `widget_schema` (always 1). `source.path` is not given: name the source by `sourceFile`
   *  (workspace-relative, inside the Folio folder) or by `source.resource` (a declared resource id). */
  recipe: RecipeMap
  sourceFile?: string
  position?: WidgetPosition
  /** The document text the caller saw; the step refuses, writing nothing, when the file holds anything else. */
  documentBasis?: string
  /** Save edited text into `sourceFile` as part of the step (undone with it). */
  sourceEdit?: SourceEdit
  /** The writer's answer in the own-folder sheet (shared/own-folder-plan.ts), with the fingerprint of the plan the
   *  sheet showed. Required for a document in no Folio whose folder holds other files (refused without it:
   *  `placement-required`); refused when the folder no longer makes that plan (`own-folder-changed`). Only a lone
   *  document in no Folio goes ahead without it, its folder becoming the Folio in place. */
  placement?: OwnFolderChoice
  /** A file from outside the document's folders, brought in by the step (ticket 04c); in place of `sourceFile`. */
  outside?: OutsideRequest
}

/** `code`, for the two refusals the renderer answers itself: `placement-required` (ask the own-folder sheet first)
 *  and `own-folder-changed` (the folder changed since the sheet was drawn: show it again over the folder as it is). */
export type RefusalCode = 'placement-required' | 'own-folder-changed'
export type OperationRefusal = { ok: false; message: string; errors: BuildError[]; code?: RefusalCode; /** False when a part of a failed step could not be put back (a file, a folder or a grant was left): a pick it used is not handed back. */ nothingLeft?: boolean }
export type CreateWidgetResult =
  | { ok: true; undoId: string; documentPath: string; documentText: string; recipePath: string; outputPath: string; folio: { dir: string; created: boolean }; build: BuildOutcome; written: string[]; /** Files that moved (documents, and the data file when moved). */ moved: Array<{ from: string; to: string }>; /** Links the rename repair could not carry, to be told. */ notices: string[]; /** The outside file brought in. */ intake?: { id: string; path: string; inclusion: Inclusion } }
  | OperationRefusal

export type UpdateRecipeRequest = {
  recipePath: string
  /** Top-level recipe keys to set (a value) or remove (null). `source` may carry `file` in place of `path`. */
  patch: Record<string, RecipeValue | null>
  /** The recipe text the caller saw. */
  basis?: string
  /** Save edited text into the widget's source file (after the patch) as part of the step (undone with it). */
  sourceEdit?: SourceEdit
  /** A file from outside the document's folders, brought in as the widget's new source (ticket 04c). The patch's
   *  `source` gives its format and selection; the engine sets `source.resource`. */
  outside?: OutsideRequest
}
export type UpdateRecipeResult = { ok: true; undoId: string; recipeText: string; build: BuildOutcome; written: string[]; intake?: { id: string; path: string; inclusion: Inclusion } } | OperationRefusal

/** Why an undo did not finish. `not-held`: no such step (or another Workspace). `changed`: a file changed after the
 *  step, so nothing was undone. `incomplete`: a file could not be put back; the files after it were left as they
 *  are (the document is always first, so its embed never points at a removed widget), and the step is still held
 *  so the undo can be tried again. */
export type UndoFailure = 'not-held' | 'changed' | 'incomplete'
export type UndoResult = { ok: true; restored: string[]; /** Files the undo moved back (from their moved place to where they were). */ movedBack: Array<{ from: string; to: string }> } | { ok: false; code: UndoFailure; message: string; restored?: string[] }

const refusal = (message: string, errors: BuildError[] = []): OperationRefusal => ({ ok: false, message, errors })
const folderChanged = (label: string): OperationRefusal => ({ ok: false, errors: [], code: 'own-folder-changed', message: `${label} changed since the folder sheet was drawn, so nothing was written. Review the sheet again.` })
const placementRequired = (label: string): OperationRefusal => ({ ok: false, errors: [], code: 'placement-required', message: `${label} holds other files, so WriteFlex asks first which documents go with the widget. Nothing was written.` })
const parentDir = (path: string): string => (posix.dirname(path) === '.' ? '' : posix.dirname(path))
const inFolder = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)

export { widgetFolderName }

const DATA_FILE = /\.(csv|json)$/i

export { operationSeams }

/** A source edit checked to be written: the file and the identity its folder had when it was checked. */
type CheckedSourceEdit = { file: string; folder: string; folderId: { dev: number; ino: number }; edit: SourceEdit }


/** `edit` checked to be written into `file` (workspace-relative, already checked to be inside the Folio folder), or
 *  why it may not be. Read before any write: a real CSV or JSON file, reached without a link, holding exactly
 *  `basis`; its folder's identity is taken here, and the write commits only into that very folder. */
async function checkSourceEdit(realRoot: string, file: string, edit: SourceEdit): Promise<CheckedSourceEdit | string> {
  const problem = await sourceEditProblem(realRoot, file, edit)
  if (problem) return problem
  const folder = parentDir(file)
  const folderId = folderIdentity(realRoot, folder)
  if (!folderId) return `${file} is not a real file in real folders of the open Workspace, so the edited source was not saved.`
  operationSeams.afterSourceCheck?.(file)
  return { file, folder, folderId, edit }
}

/** Why `edit` may not be written into `file`, or null. */
async function sourceEditProblem(realRoot: string, file: string, edit: SourceEdit): Promise<string | null> {
  if (!DATA_FILE.test(file)) return `${file} is not a CSV or JSON file, so WriteFlex does not edit it here.`
  if (typeof edit.text !== 'string' || typeof edit.basis !== 'string') return 'The edited source is missing.'
  if (edit.text.trim() === '') return 'The source is empty, so it was not saved. Nothing was written.'
  if (Buffer.byteLength(edit.text, 'utf8') > SOURCE_MAX_BYTES) return `The source is larger than ${SOURCE_MAX_BYTES / 1024 / 1024} MiB, so it was not saved.`
  const read = await readContainedFile(realRoot, file, SOURCE_MAX_BYTES)
  if (!read.ok) return read.reason === 'missing' ? `${file} is missing, so the edited source was not saved.` : `${file} is not a real file in real folders of the open Workspace, so the edited source was not saved.`
  if (read.bytes.toString('utf8') !== edit.basis) return `${file} changed since it was read; nothing was written.`
  return null
}

/** Write a checked source edit inside a recorded step: the guarded write, committed only over `basis` and only into
 *  the folder that was checked. In the tick of the commit the folder is walked again without following anything and
 *  must be that very folder (same device and inode), the real folder the write commits in must be it too (a folder
 *  swapped for a link and back is caught), and the file must be a real file. A link to another folder of the
 *  Workspace (another Folio) is refused like a link to outside. */
async function writeSourceEdit(ws: Workspace, realRoot: string, checked: CheckedSourceEdit): Promise<void> {
  const { file, folder, folderId, edit } = checked
  if (edit.text === edit.basis) return
  const onlyOver = ws.commitOnlyOver(file, { kind: 'disk', text: edit.basis })
  await ws.saveFile(file, edit.text, {
    documentOnly: true,
    beforeCommit: (target) => {
      const now = folderIdentity(realRoot, folder)
      if (!now || now.dev !== folderId.dev || now.ino !== folderId.ino) throw new Error(`${folder || 'The Workspace folder'} changed while the source was being saved, so it was not saved`)
      let real: { dev: number; ino: number } | null = null
      try { if (target) { const info = lstatSync(target.folder); if (info.isDirectory()) real = { dev: info.dev, ino: info.ino } } } catch { real = null }
      if (!real || real.dev !== folderId.dev || real.ino !== folderId.ino) throw new Error(`${folder || 'The Workspace folder'} changed while the source was being saved, so it was not saved`)
      if (walkNoFollowSync(realRoot, file).kind !== 'file') throw new Error(`${file} is not a plain file, so the source was not saved`)
      onlyOver()
    },
  })
}

/** `file` (workspace-relative) as a recipe `source.path`: relative to the widget folder, inside the Folio folder. */
function sourcePathFor(file: string, bundle: string, widgetFolder: string): string | null {
  if (typeof file !== 'string' || file === '' || file.includes('\0') || /^[\\/]/.test(file) || file.includes('\\')) return null
  const normal = posix.normalize(file)
  if (normal === '..' || normal.startsWith('../') || isHiddenWorkspacePath(normal)) return null
  if (bundle !== '' && !normal.startsWith(`${bundle}/`)) return null
  return posix.relative(widgetFolder, normal)
}


/** One held step: what it wrote and the folders it made, to be put back together. `done`: the paths an earlier,
 *  stopped undo already put back; a retry expects those to hold what they held before the step. */
type HeldStep = { root: string; log: OperationWrite[]; folders: MadeFolder[]; paths: string[]; done?: Set<string>; moved?: Array<{ from: string; to: string }>; /** A step that moved documents: every file's folder as the step recorded it. Its undo is the step's guarded
 *  put-back (step-put-back.ts): every rewritten or removed file first, then the files it made. */ guarded?: Map<string, FolderId>
  /** Sync grants the step wrote (outside the Workspace, in the app's store): taken back with the files. */ grants?: GrantWrite[]; store?: SyncGrantStore | null }


/** The undo records of this process's widget steps, newest kept; an old step falls off after `limit`. */
export class StandardWidgetUndoDesk {
  readonly #held = new Map<string, HeldStep>()
  #next = 1
  constructor(private readonly limit = 20) {}

  hold(step: HeldStep): string {
    const id = `widget-step-${this.#next++}`
    this.#held.set(id, step)
    while (this.#held.size > this.limit) this.#held.delete(this.#held.keys().next().value as string)
    return id
  }

  has(id: string): boolean {
    return this.#held.has(id)
  }

  /**
   * Put back everything step `id` wrote, or refuse and change nothing when any of it changed since. Files are put
   * back newest write first, so the document (the step's last write) is restored before the widget files it points
   * at; a step that moved documents puts their old names back first and then takes the new ones away (the new one
   * holds the embed), before any widget file. The first file that cannot be put back stops the undo: nothing after it is touched, the made folders stay,
   * and the step stays held, so the undo can be tried again. A retry checks every file of the step, those already
   * put back included (each must still hold what it held before the step), so a document given its embed again
   * after the stop makes the retry refuse before any widget file is removed.
   */
  undo(ws: Workspace, id: string): Promise<UndoResult> {
    return ws.exclusiveAll(async () => {
      const step = this.#held.get(id)
      if (!step || step.root !== ws.root) return { ok: false, code: 'not-held', message: 'This widget step is no longer held for undo.' }
      const realRoot = await realpath(ws.root)
      const done = step.done ?? (step.done = new Set<string>())
      const changed = netWrites(step.log).filter((write) => !holds(realRoot, write.path, done.has(write.path) ? write.before : write.after))
      if (changed.length > 0) {
        return { ok: false, code: 'changed', message: `${changed.map((write) => write.path).join(', ')} changed after the widget was made, so nothing was undone.` }
      }
      const restored: string[] = []
      if (step.guarded) {
        // The step's guarded put-back, in its order; the first file that cannot be put back stops it before anything
        // the step made is removed.
        const folders = step.guarded
        for (const change of putBackOrder(stepChanges(step.log))) {
          if (done.has(change.path)) continue
          const outcome = await ws.outsideCallRecords(() => putBackOne(ws, realRoot, change, folders))
          if (outcome !== 'restored') {
            invalidateFolioPlaces(ws.root)
            const failed = outcome === 'changed' ? [] : [{ path: change.path, reason: outcome.reason }]
            const message = rollbackMessage(`${change.path} could not be put back, so the undo stopped there and the files it points at were kept. Try the undo again.`, { restored, changed: outcome === 'changed' ? [change.path] : [], failed })
            return { ok: false, code: 'incomplete', message, restored }
          }
          restored.push(change.path)
          done.add(change.path)
        }
      } else {
        const order = netWrites(step.log).reverse().map((write) => write.path)
        for (const path of order) {
          if (done.has(path)) continue
          const outcome = await rollBackOperationWrites(ws, step.log.filter((write) => write.path === path))
          if (outcome.changed.length || outcome.failed.length) {
            invalidateFolioPlaces(ws.root)
            const message = rollbackMessage(`${path} could not be put back, so the undo stopped there and the files it points at were kept. Try the undo again.`, { ...outcome, restored })
            return { ok: false, code: 'incomplete', message, restored }
          }
          restored.push(...outcome.restored)
          // Put back: a retry starts from the next file, but still checks this one holds what it was put back to.
          done.add(path)
        }
      }
      // Every file is back: the grants the step wrote go too, so the grant store is as it was before the step. A
      // grant that cannot be taken back stops the undo here, named; the step stays held, so it can be tried again.
      if (step.grants?.length) {
        const failed = undoGrantWrites(step.store ?? null, step.grants)
        if (failed.length) {
          invalidateFolioPlaces(ws.root)
          return { ok: false, code: 'incomplete', message: `Every file was put back, but the record of the file kept in sync could not be removed (${failed.join(' ')}), so the undo is not finished. Try the undo again.`, restored }
        }
      }
      removeMadeFolders(realRoot, step.folders)
      invalidateFolioPlaces(ws.root)
      this.#held.delete(id)
      return { ok: true, restored, movedBack: (step.moved ?? []).map((move) => ({ from: move.to, to: move.from })) }
    })
  }
}

/** Per path: the text before the step's first write and after its last. */
function netWrites(log: readonly OperationWrite[]): Array<{ path: string; before: string | null; after: string | null }> {
  const byPath = new Map<string, { path: string; before: string | null; after: string | null }>()
  for (const write of log) {
    const known = byPath.get(write.path)
    if (known) known.after = write.after
    else byPath.set(write.path, { path: write.path, before: write.before, after: write.after })
  }
  return [...byPath.values()]
}

/** Whether `path` holds exactly `text` now (null: nothing is there), read without following a link. */
function holds(realRoot: string, path: string, text: string | null): boolean {
  const walked = walkNoFollowSync(realRoot, path)
  if (text === null) return walked.kind === 'missing'
  if (walked.kind !== 'file') return false
  try { return readFileSync(join(realRoot, ...path.split('/')), 'utf8') === text } catch { return false }
}




/** The bytes of each file a step may overwrite, as they were before it (null: no file there). */
export type ExactSnapshot = ReadonlyMap<string, Buffer | null>
/** Largest file a step's snapshot reads (a built page is at most WIDGET_MAX_BYTES). */
const SNAPSHOT_MAX_BYTES = WIDGET_MAX_BYTES + 1

/** Before a step that brings a file in: every existing file it may overwrite must be text that reads back as the very
 *  same bytes, since a failed step puts files back from their text (workspace.ts). Otherwise the step is refused by
 *  name before anything is written. */
export async function exactBefore(realRoot: string, paths: readonly string[]): Promise<{ ok: true; snapshot: ExactSnapshot } | { ok: false; message: string }> {
  const snapshot = new Map<string, Buffer | null>()
  for (const raw of paths) {
    const path = posix.normalize(raw)
    if (snapshot.has(path)) continue
    const read = await readContainedFile(realRoot, path, SNAPSHOT_MAX_BYTES)
    if (!read.ok && read.reason === 'missing') { snapshot.set(path, null); continue }
    if (!read.ok) return { ok: false, message: `${path} could not be read as it is, so WriteFlex could not put it back if the step failed; nothing was written.` }
    if (exactUtf8(read.bytes) === null) return { ok: false, message: `${path} is not plain UTF-8 text, so WriteFlex could not put it back exactly if the step failed; nothing was written.` }
    snapshot.set(path, read.bytes)
  }
  return { ok: true, snapshot }
}

/** What a step that brings a file in will write, by the step's own plan: the paths it writes to, each an existing
 *  file it may overwrite or a new one. Built from the same facts the step is run from (its document, its Folio
 *  folder, whether it makes the Folio, the documents it moves, its widget folder), so a write the step makes is in it
 *  by construction; the test (standard-widgets-outside-files) runs every path with every such file present and
 *  fails if the step writes over a file not in it. Files elsewhere whose links the move carries are not in it: their
 *  writers (retargetLinksElsewhere, repairWikilinksForMoves) note the exact bytes they write over
 *  (step-bytes-before.ts), and `leftAsBefore` checks those. */
export type StepWritePlan =
  | { kind: 'create'; document: string; folio: string; makesFolio: boolean; widgetFolder: string; moves: ReadonlyArray<{ from: string; to: string }>; sourceEdit: string | null }
  | { kind: 'update'; recipePath: string; folio: string; widgetFolder: string; sourceEdit: string | null }

export function plannedWrites(plan: StepWritePlan): string[] {
  const widget = [WIDGET_RECIPE_NAME, WIDGET_OUTPUT_NAME, WIDGET_REBUILT_NAME, WIDGET_RECEIPT_NAME].map((name) => inFolder(plan.widgetFolder, name))
  // The manifest: the intake writes the file's item into it (and a sync refresh its capture).
  const folio = [inFolder(plan.folio, MANIFEST_NAME)]
  const edit = plan.sourceEdit === null ? [] : [plan.sourceEdit]
  if (plan.kind === 'update') return [plan.recipePath, ...widget, ...folio, ...edit]
  // Making a Folio writes its agent instructions (writeFolioAgentInstructions), over files that may already be there.
  const agents = plan.makesFolio ? [AGENTS_FILE, CLAUDE_FILE].map((name) => inFolder(plan.folio, name)) : []
  // The document gets its embed; a moved document is copied to its new name and its old name removed.
  const moved = plan.moves.flatMap((move) => [move.from, move.to])
  return [plan.document, ...folio, ...agents, ...widget, ...moved, ...edit]
}

/** TEST-ONLY: sees each recorded step, with its record, the snapshot it was run with and the bytes its writers noted. */
export const snapshotSeams: { afterStep?: (log: readonly OperationWrite[], snapshot: ExactSnapshot, bytesBefore: BytesBefore) => void } = {}

/** After a failed step was put back: true only when every file it wrote is byte for byte as before. A file it made is
 *  gone; a snapshotted file holds its snapshot's bytes; a file it wrote over that was not snapshotted holds the bytes
 *  its writer noted just before writing (step-bytes-before.ts), when those bytes are the very text the record kept.
 *  Anything else (no bytes noted, a record of other text, or a file that cannot be read) is not as before. */
export async function leftAsBefore(realRoot: string, log: readonly OperationWrite[], snapshot: ExactSnapshot, bytesBefore: BytesBefore = new Map()): Promise<boolean> {
  const first = new Map<string, OperationWrite>()
  for (const write of log) if (!first.has(write.path)) first.set(write.path, write)
  for (const [path, write] of first) {
    let expected: Buffer | null
    if (snapshot.has(path)) expected = snapshot.get(path)!
    else if (write.unknown) return false
    else if (write.before === null) expected = null
    else {
      const noted = bytesBefore.get(path)
      if (!noted || exactUtf8(noted) !== write.before) return false
      expected = noted
    }
    const read = await readContainedFile(realRoot, path, SNAPSHOT_MAX_BYTES).catch(() => null)
    if (!read) return false
    if (expected === null) { if (read.ok || read.reason !== 'missing') return false; continue }
    if (!read.ok || !read.bytes.equals(expected)) return false
  }
  return true
}

/** Run `step` as one recorded operation; on a throw, put back every write and folder and answer the refusal. */
async function recorded<T>(ws: Workspace, realRoot: string, step: (made: MadeFolder[]) => Promise<T>, snapshot: ExactSnapshot = new Map()): Promise<{ ok: true; value: T; log: OperationWrite[]; made: MadeFolder[] } | OperationRefusal> {
  const log: OperationWrite[] = []
  const made: MadeFolder[] = []
  const bytesBefore = new Map<string, Buffer>()
  try {
    const value = await recordingBytesBefore(bytesBefore, () => ws.recordingOperationWrites(log, () => step(made)))
    snapshotSeams.afterStep?.(log, snapshot, bytesBefore)
    return { ok: true, value, log, made }
  } catch (error) {
    snapshotSeams.afterStep?.(log, snapshot, bytesBefore)
    const outcome = await rollBackOperationWrites(ws, log)
    // Folders left are named in the answer, so it never says nothing was changed while one stands.
    outcome.failed.push(...removeMadeFolders(realRoot, made))
    if (error instanceof FolderLeftBehind) outcome.failed.push({ path: error.folder, reason: LEFT_FOLDER })
    invalidateFolioPlaces(ws.root)
    const errors = error instanceof BuildFailed ? error.errors : []
    const reason = error instanceof Error ? error.message : String(error)
    return { ...refusal(rollbackMessage(reason, outcome), errors), nothingLeft: !outcome.changed.length && !outcome.failed.length && await leftAsBefore(realRoot, log, snapshot, bytesBefore) }
  }
}

type MoveStepPlan = { document: string; folder: string; moves: ReadonlyArray<{ from: string; to: string }>; folders: Map<string, FolderId> }

/** Run a step that moves documents as one recorded operation with its step journal (step-journal.ts). On a throw,
 *  the step's guarded put-back (step-put-back.ts): everything rewritten or removed first, then what it made, and
 *  nothing it made removed when anything before could not be put back. The journal is removed when the step is done
 *  or wholly put back; otherwise it stays, for the launch notice's Clean up. */
async function recordedMove<T>(ws: Workspace, realRoot: string, plan: MoveStepPlan, step: (made: MadeFolder[], journal: StepJournal) => Promise<T>, snapshot: ExactSnapshot = new Map()): Promise<{ ok: true; value: T; log: OperationWrite[]; made: MadeFolder[] } | OperationRefusal> {
  const made: MadeFolder[] = []
  const journal = new StepJournal(realRoot, plan.document, plan.folder, plan.moves, plan.folders, made)
  try { journal.sync() } catch (error) {
    return refusal(`Nothing was changed: WriteFlex could not keep a record of the step (${error instanceof Error ? error.message : String(error)}).`)
  }
  const log = journal.log()
  const bytesBefore = new Map<string, Buffer>()
  try {
    const value = await recordingBytesBefore(bytesBefore, () => ws.recordingOperationWrites(log, () => step(made, journal)))
    journal.finish()
    snapshotSeams.afterStep?.(log, snapshot, bytesBefore)
    return { ok: true, value, log, made }
  } catch (error) {
    snapshotSeams.afterStep?.(log, snapshot, bytesBefore)
    const outcome = await putBackStep(ws, realRoot, stepChanges(log), plan.folders)
    const left = removeMadeFolders(realRoot, made)
    if (error instanceof FolderLeftBehind) left.push({ path: error.folder, reason: LEFT_FOLDER })
    invalidateFolioPlaces(ws.root)
    if (!outcome.failed.length && !outcome.kept.length) journal.finish()
    const errors = error instanceof BuildFailed ? error.errors : []
    const reason = error instanceof Error ? error.message : String(error)
    return { ...refusal(putBackMessage(reason, outcome, left), errors), nothingLeft: !outcome.changed.length && !outcome.failed.length && !outcome.kept.length && !left.length && await leftAsBefore(realRoot, log, snapshot, bytesBefore) }
  }
}

/** A refused step that wrote a grant: the grant is taken back with its files; a grant that could not be is named. */
function withGrantsTakenBack(refused: OperationRefusal, store: SyncGrantStore | null, grants: readonly GrantWrite[]): OperationRefusal {
  if (grants.length === 0) return refused
  const failed = undoGrantWrites(store, grants)
  return failed.length ? { ...refused, nothingLeft: false, message: `${refused.message} The record of the file kept in sync could not be taken back: ${failed.join(' ')}` } : refused
}

class BuildFailed extends Error {
  constructor(readonly errors: BuildError[]) { super(`the widget could not be built: ${errors.filter((error) => error.severity === 'error').map((error) => error.message).join(' ')}`) }
}

/** The recipe the caller described, as it will be written: `widget_schema: 1` first, `source.path` filled in. */
function recipeToWrite(input: RecipeMap, sourcePath: string | null): RecipeMap {
  const { widget_schema: _schema, ...rest } = input
  void _schema
  const out: RecipeMap = { widget_schema: 1 }
  for (const [key, value] of Object.entries(rest)) {
    if (key === 'source' && isRecipeMap(value)) {
      const { path: _path, file: _file, ...source } = value
      void _path; void _file
      out.source = sourcePath === null ? source : { path: sourcePath, ...source }
    } else out[key] = value
  }
  return out
}

/**
 * Create a standard widget and insert it into `request.documentPath` as one undoable step (see the module note).
 * Never throws for a refusal; the answer names it, and nothing is left written.
 */
export async function createStandardWidget(ws: Workspace, desk: StandardWidgetUndoDesk, request: CreateWidgetRequest, options: BuildOptions = {}): Promise<CreateWidgetResult> {
  const requestedPath = request.documentPath
  try { assertRelativeWorkspacePath(requestedPath) } catch { return refusal('The document must be a path inside the open Workspace.') }
  if (!MARKDOWN_FILE.test(requestedPath) || isHiddenWorkspacePath(requestedPath)) return refusal(`${requestedPath} is not a Markdown document in a visible folder, so no widget can go into it.`)
  if (!isRecipeMap(request.recipe)) return refusal('The widget settings are missing.')
  return ws.exclusiveAll(async () => {
    const realRoot = await realpath(ws.root)
    if (walkNoFollowSync(realRoot, requestedPath).kind !== 'file') return refusal(`${requestedPath} is not a real document in real folders of the open Workspace.`)
    // A step that brings a file in reads where the Folios are from disk, never from an earlier answer kept.
    if (request.outside !== undefined) invalidateFolioPlaces(ws.root)
    const current = (await ws.readFile(requestedPath)).content
    if (request.documentBasis !== undefined && request.documentBasis !== current) return refusal(`${requestedPath} changed since it was read; nothing was written.`)
    const position = request.position ?? 'end'
    if (typeof position === 'object') {
      if (request.documentBasis === undefined) return refusal('A widget placed at a line needs the document text that line was counted in; nothing was written.')
      const count = documentLineCount(request.documentBasis)
      if (!Number.isSafeInteger(position.line) || position.line < 1 || position.line > count) return refusal(`There is no line ${String(position.line)} in ${requestedPath}; it has ${count}. Nothing was written.`)
    }
    // The document is rewritten by the step (its embed): only text whose bytes read back the same.
    if (!(await isPlainTextFile(realRoot, requestedPath))) return refusal(`${requestedPath} is not plain UTF-8 text, so WriteFlex does not rewrite it; no widget was made.`)
    const folio = await folioContaining(ws, requestedPath)
    const homeFolder = parentDir(requestedPath)
    const homeLabel = homeFolder === '' ? 'The Workspace folder' : posix.basename(homeFolder)

    // The sheet's answer, carried out as the sheet drew it: planned again over the folder as it is now, and refused
    // when that plan is not the one the sheet showed. A folder that needs the sheet is refused without an answer.
    let own: OwnFolderPlan | null = null
    if (folio) {
      if (request.placement !== undefined) return folderChanged(homeLabel)
    } else {
      const answer = await readOwnFolderFacts(ws, { documentPath: requestedPath, sourceFile: request.sourceFile, name: request.name })
      if (!answer.ok) return refusal(answer.message)
      if (!answer.needed) {
        if (request.placement !== undefined) return folderChanged(homeLabel)
      } else {
        if (request.placement === undefined) return placementRequired(answer.facts.folderLabel)
        if (!choiceMatchesFacts(answer.facts, request.placement)) return folderChanged(answer.facts.folderLabel)
        own = planOwnFolder(answer.facts, request.placement)
        if (request.placement.fingerprint !== planFingerprint(own)) return folderChanged(answer.facts.folderLabel)
        if (!own.ready) return refusal(`${own.nameProblem?.text ?? 'The new folder needs a name.'} Nothing was written.`)
      }
    }
    const newFolder = own !== null && !own.inPlace ? inFolder(homeFolder, own.newFolder as string) : null
    const moving = newFolder === null ? [] : own!.moving.map((name) => ({ from: inFolder(homeFolder, name), to: inFolder(newFolder, name) }))
    const documentPath = newFolder === null ? requestedPath : inFolder(newFolder, posix.basename(requestedPath))
    const bundle = folio ? folio.dir : newFolder ?? homeFolder
    const visualisations = inFolder(bundle, VISUALISATIONS_DIR)
    const folder = freeWidgetFolder(realRoot, visualisations, request.name)
    if (folder === null) return refusal('There are too many widgets with that name; choose another.')

    const source = isRecipeMap(request.recipe.source) ? request.recipe.source : null
    const outside = request.outside
    if (outside !== undefined) {
      if (!isGenuinePick(outside.pick) || (outside.inclusion !== 'copy' && outside.inclusion !== 'sync')) return refusal('The file was not chosen in WriteFlex\'s file picker, so nothing was written.')
      if (request.sourceFile !== undefined || request.sourceEdit !== undefined) return refusal('A file brought in from outside is used as it was chosen; nothing was written.')
      if (outside.pick.documentPath !== requestedPath) return refusal(`${outside.pick.name} was chosen for ${outside.pick.documentPath}, not ${requestedPath}, so nothing was written.`)
    }
    const store = options.grants === undefined ? appSyncGrantStore() : options.grants
    let sourcePath: string | null = null
    /** The data file, when documents move: copied into the widget's folder (the original stays), or moved there. It
     *  never takes a name the build writes (`data-<name>` then, as the sheet shows). */
    let data: { from: string; to: string; mode: 'copy' | 'move' } | null = null
    if (request.sourceFile !== undefined) {
      if (newFolder !== null) {
        const original = posix.normalize(request.sourceFile)
        if (sourcePathFor(original, homeFolder, folder) === null) return refusal(`${request.sourceFile} is outside ${homeFolder || 'the Workspace folder'}, the folder this document's widgets read from.`)
        const name = widgetDataFileName(posix.basename(original))
        data = { from: original, to: `${folder}/${name}`, mode: own!.dataFile.effect === 'move' ? 'move' : 'copy' }
        sourcePath = name
      } else {
        sourcePath = sourcePathFor(request.sourceFile, bundle, folder)
        if (sourcePath === null) return refusal(`${request.sourceFile} is outside ${bundle || 'the Workspace folder'}, the folder this document's widgets read from. Bring it into the document's resources first.`)
      }
    } else if (outside === undefined && (!source || typeof source.resource !== 'string')) return refusal('Choose the file the widget is built from.')
    let checkedEdit: CheckedSourceEdit | null = null
    if (request.sourceEdit !== undefined) {
      if (request.sourceFile === undefined) return refusal('Only a widget built from a file can have its source edited here.')
      const checked = await checkSourceEdit(realRoot, posix.normalize(request.sourceFile), request.sourceEdit)
      if (typeof checked === 'string') return refusal(checked)
      checkedEdit = checked
    }
    /** The recipe as written; for an outside file, its `source.resource` is the id the intake gives it. */
    const recipeFor = (resource: string | null): RecipeMap => {
      const out = recipeToWrite(request.recipe, sourcePath)
      if (resource !== null && isRecipeMap(out.source)) {
        const { resource: _resource, ...rest } = out.source
        void _resource
        out.source = { resource, ...rest }
      }
      return out
    }
    let recipe: RecipeMap
    let text: string
    try {
      recipe = recipeFor(outside ? 'outside-file' : null)
      text = recipeText(recipe)
    } catch (error) {
      return refusal(error instanceof RecipeWriteRefused ? `The widget settings cannot be saved: ${error.message}.` : String(error))
    }
    const problems = checkRecipe(recipe)
    const recipePath = inFolder(folder, WIDGET_RECIPE_NAME)
    if (problems.length > 0) return refusal('The widget settings are not complete.', problems.map((issue) => buildError(issue, recipePath)))

    const notices: string[] = []
    const grants: GrantWrite[] = []
    let intake: IntakeResult | null = null
    /** The outside file into the Folio's resources (its manifest now exists), and the recipe naming it. */
    const bringIn = async (made: MadeFolder[], manifestExisted: boolean): Promise<void> => {
      if (outside === undefined) return
      intake = await intakeOutsideFile(ws, realRoot, bundle, made, outside.pick, outside.inclusion, grants, { store, now: options.now, manifestExisted, document: documentPath })
      text = recipeText(recipeFor(intake.id))
    }
    /** The widget, its build and the embed line, into the document as it now reads (`documentText`). */
    const makeWidget = async (made: MadeFolder[], documentText: string, intoWidgetFolder?: (widgetFolder: CheckedFolder) => Promise<void>): Promise<{ build: BuildOutcome; next: string }> => {
      ensureFolder(realRoot, visualisations, made)
      const folderId = ensureFolder(realRoot, folder, made)
      await intoWidgetFolder?.({ path: folder, id: folderId })
      // The guarded write: a widget folder swapped for a link after the checks above puts nothing outside.
      await writeInWidgetFolder(ws, realRoot, folder, folderId, recipePath, text, { exclusive: true })
      const build = await buildStandardWidget(ws, recipePath, options)
      // Any error fails the step, a receipt that could not be written included: nothing is half made.
      if (build.result === 'failed' || build.errors.some((error) => error.severity === 'error')) throw new BuildFailed(build.errors)
      const embed = relativeEmbedPath(documentPath, build.outputPath)
      const next = typeof position === 'object' ? insertWidgetAtLine(documentText, embed, position.line) : insertWidgetInText(documentText, embed, position)
      await ws.saveFile(documentPath, next, { documentOnly: true, beforeCommit: ws.commitOnlyOver(documentPath, { kind: 'disk', text: documentText }) })
      return { build, next }
    }

    // The document the file was chosen for, as it was then: a plain file reached with no link, in the same folder.
    let snapshot: ExactSnapshot = new Map()
    if (outside !== undefined) {
      const changed = await pickStillAuthorised(ws, realRoot, outside.pick)
      if (changed !== null) return refusal(changed)
      // The step writes into the pick's folder (or a folder it makes there for the document): never another Folio.
      if ((newFolder === null ? bundle : homeFolder) !== outside.pick.folder.path) return refusal(`${bundle || 'The Workspace folder'} is not the Folio ${requestedPath} is in, the document ${outside.pick.name} was chosen for, so nothing was written.`)
      // Every file the step may write over, by its own plan, as exact bytes.
      const exact = await exactBefore(realRoot, plannedWrites({
        kind: 'create', document: requestedPath, folio: bundle, makesFolio: !folio, widgetFolder: folder,
        moves: [...moving, ...(data ? [{ from: data.from, to: data.to }] : [])], sourceEdit: checkedEdit ? checkedEdit.file : null,
      }))
      if (!exact.ok) return refusal(exact.message)
      snapshot = exact.snapshot
    }
    let step: Awaited<ReturnType<typeof recorded<{ build: BuildOutcome; next: string }>>>
    let guarded: Map<string, FolderId> | undefined
    if (newFolder === null) {
      step = await recorded(ws, realRoot, async (made) => {
        // The edited source first, so the build reads it; it is one of the step's writes, undone with it.
        if (checkedEdit) await writeSourceEdit(ws, realRoot, checkedEdit)
        if (!folio) {
          // The existing Make Folio path; its parts are the documents chosen, in the chosen order (this one alone
          // when nothing was asked).
          const parts = own ? own.documents : [posix.basename(documentPath)]
          const manifest = { schema_version: 1, content_root: '', files: parts.map((path) => ({ path, role: 'section' })) }
          await assertManifestAbsent(ws, bundle)
          await ws.saveFileWithoutReadBack(inFolder(bundle, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { exclusive: true, documentOnly: true })
          await writeFolioAgentInstructions(ws, bundle)
          invalidateFolioPlaces(ws.root)
        }
        await bringIn(made, !!folio)
        return makeWidget(made, current)
      }, snapshot)
    } else {
      // Documents move. Copy first, remove last: the documents are copied (links carried along), the Folio and the
      // widget made, the embed written, the links elsewhere carried after them; the old names are removed only as
      // the step's last part. A failure or a crash before that leaves every original where it was.
      let homeChecked: CheckedFolder
      let dataHome: CheckedFolder | null = null
      try {
        homeChecked = checkedFolder(realRoot, homeFolder)
        if (data !== null) dataHome = checkedFolder(realRoot, parentDir(data.from))
      } catch (error) { return refusal(error instanceof Error ? error.message : String(error)) }
      const allMoves = [...moving, ...(data?.mode === 'move' ? [{ from: data.from, to: data.to }] : [])]
      const moves = new Map<string, string>(allMoves.map((move) => [move.from, move.to]))
      const where = (path: string): string => moves.get(path) ?? path
      guarded = new Map<string, FolderId>([[homeChecked.path, homeChecked.id], ...(dataHome ? [[dataHome.path, dataHome.id] as [string, FolderId]] : [])])
      step = await recordedMove(ws, realRoot, { document: requestedPath, folder: newFolder, moves: allMoves, folders: guarded }, async (made, journal) => {
        if (walkNoFollowSync(realRoot, newFolder).kind !== 'missing') throw new Error(`${newFolder} appeared meanwhile, so nothing was moved`)
        const ownFolder: CheckedFolder = { path: newFolder, id: ensureFolder(realRoot, newFolder, made) }
        /** What each original held when its copy was made: its old name is removed only over that text. */
        const originals: Array<{ from: string; fromFolder: CheckedFolder; read: string }> = []
        let documentText = current
        for (const move of moving) {
          const copied = await copyFileGuarded(ws, realRoot, {
            from: move.from, to: move.to, toFolder: ownFolder,
            transform: (text) => rebaseRelativeLinks(text, move.from, move.to, where).text,
            beforeWrite: (read) => journal.noteCopy(move.from, move.to, read),
            ...(move.from === requestedPath ? { expected: current } : {}),
          })
          originals.push({ from: move.from, fromFolder: homeChecked, read: copied.read })
          if (move.from === requestedPath) documentText = copied.written
        }
        const manifest = { schema_version: 1, content_root: '', files: own!.documents.map((path) => ({ path, role: 'section' })) }
        await writeInWidgetFolder(ws, realRoot, ownFolder.path, ownFolder.id, inFolder(bundle, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { exclusive: true })
        await writeFolioAgentInstructions(ws, bundle)
        invalidateFolioPlaces(ws.root)
        await bringIn(made, false)
        const widget = await makeWidget(made, documentText, async (widgetFolder) => {
          if (data === null) return
          // The data file's copy (an edit to it written in its place); a moved one keeps its original until the end.
          const edit = checkedEdit ? { expected: checkedEdit.edit.basis, replacement: checkedEdit.edit.text } : {}
          const copied = await copyFileGuarded(ws, realRoot, { from: data.from, to: data.to, toFolder: widgetFolder, ...edit, beforeWrite: (read) => journal.noteCopy(data.from, data.to, read) })
          if (data.mode === 'move') originals.push({ from: data.from, fromFolder: dataHome!, read: copied.read })
        })
        // Links elsewhere carried after the moved files (relative links here, wikilinks by the app's rename repair,
        // planned over the Workspace as it will be once the old names are gone).
        // Files the step made itself (the manifest, the agent files, the widget) are right as written: neither
        // pass reads or reports them. The moved documents are the exception: they are the step's moves.
        const movedTo = new Set(moving.map((move) => move.to))
        // Only the exact paths this step wrote (its journal's log), never a whole folder: a document that turns up
        // there meanwhile is a bystander like any other.
        const madeByStep = (path: string): boolean => !movedTo.has(path) && journal.log().some((write) => write.path === path && write.before === null && write.after !== null)
        const retargeted = await retargetLinksElsewhere(ws, realRoot, moves, movedTo, madeByStep)
        notices.push(...retargeted.notices)
        notices.push(...await repairWikilinksForMoves(ws, realRoot, moving, new Set(moves.keys()), madeByStep))
        // The commit point: the old names go, each only over the text its copy was made from.
        operationSeams.beforeRemovingOriginals?.()
        journal.setPhase('removing')
        for (const original of originals) removeOriginalGuarded(ws, realRoot, original)
        return widget
      }, snapshot)
    }
    if (!step.ok) return withGrantsTakenBack(step, store, grants)
    const written = [...new Set(netWrites(step.log).map((write) => write.path))]
    const moved = [...moving, ...(data?.mode === 'move' ? [{ from: data.from, to: data.to }] : [])]
    const undoId = desk.hold({ root: ws.root, log: step.log, folders: step.made, paths: written, ...(guarded ? { guarded, moved } : {}), ...(grants.length ? { grants, store } : {}) })
    const brought = intake as IntakeResult | null
    return {
      ok: true, undoId, documentPath, documentText: step.value.next, recipePath, outputPath: step.value.build.outputPath,
      folio: { dir: bundle, created: !folio }, build: step.value.build, written, moved, notices,
      ...(brought ? { intake: { id: brought.id, path: brought.path, inclusion: brought.item.inclusion } } : {}),
    }
  })
}

/** Change a widget's recipe (only the named top-level keys) and rebuild it, as one undoable step. A build that
 *  fails keeps the last good page and reports its errors; the recipe change stands. */
export async function updateStandardWidgetRecipe(ws: Workspace, desk: StandardWidgetUndoDesk, request: UpdateRecipeRequest, options: BuildOptions = {}): Promise<UpdateRecipeResult> {
  const recipePath = request.recipePath
  try { assertRelativeWorkspacePath(recipePath) } catch { return refusal('The recipe must be a path inside the open Workspace.') }
  const place = recipePlace(recipePath)
  if (!place || isHiddenWorkspacePath(recipePath)) return refusal(`${recipePath} is not a widget recipe (${VISUALISATIONS_DIR}/<name>/${WIDGET_RECIPE_NAME}).`)
  if (!isRecipeMap(request.patch)) return refusal('The change to the widget settings is missing.')
  return ws.exclusiveAll(async () => {
    const realRoot = await realpath(ws.root)
    if (walkNoFollowSync(realRoot, recipePath).kind !== 'file') return refusal(`${recipePath} is not a real file in real folders of the open Workspace.`)
    // A step that brings a file in reads where the Folios are from disk, never from an earlier answer kept.
    if (request.outside !== undefined) invalidateFolioPlaces(ws.root)
    const current = readFileSync(join(realRoot, ...recipePath.split('/')), 'utf8')
    if (request.basis !== undefined && request.basis !== current) return refusal(`${recipePath} changed since it was read; nothing was written.`)
    const outside = request.outside
    if (outside !== undefined) {
      if (!isGenuinePick(outside.pick) || (outside.inclusion !== 'copy' && outside.inclusion !== 'sync')) return refusal('The file was not chosen in WriteFlex\'s file picker, so nothing was written.')
      if (request.sourceEdit !== undefined) return refusal('A file brought in from outside is used as it was chosen; nothing was written.')
      if (!isRecipeMap(request.patch.source)) return refusal('Say how the chosen file is read (its format); nothing was written.')
    }
    const store = options.grants === undefined ? appSyncGrantStore() : options.grants
    const patch: Record<string, RecipeValue | null> = {}
    for (const [key, value] of Object.entries(request.patch)) {
      if (key === 'widget_schema') return refusal('widget_schema is not changed by an update.')
      if (key === 'source' && outside !== undefined && isRecipeMap(value)) {
        // Set in the step, once the intake has given the file its resource id.
        const { file: _file, path: _path, resource: _resource, ...rest } = value
        void _file; void _path; void _resource
        patch.source = { resource: 'outside-file', ...rest }
      } else if (key === 'source' && isRecipeMap(value) && typeof value.file === 'string') {
        const path = sourcePathFor(value.file, place.bundle, place.folder)
        if (path === null) return refusal(`${value.file} is outside ${place.bundle || 'the Workspace folder'}, the folder this widget reads from.`)
        const { file: _file, path: _path, ...rest } = value
        void _file; void _path
        patch.source = { path, ...rest }
      } else patch[key] = value
    }
    let next: string
    try { next = updatedRecipeText(current, patch) } catch (error) {
      return refusal(error instanceof RecipeWriteRefused ? `The widget settings cannot be saved: ${error.message}.` : String(error))
    }
    if (outside !== undefined) {
      // The widget must be one of the document the file was chosen for: in that document's Folio, by its path and
      // by the real paths of both (a recipe of another Folio is refused, whatever the request names).
      const authorised = outside.pick.documentPath
      const notIts = refusal(`${recipePath} is not a widget of ${authorised}, the document ${outside.pick.name} was chosen for, so nothing was written.`)
      const home = await folioContaining(ws, authorised).catch(() => null)
      if (!home || home.dir !== place.bundle) return notIts
      try {
        const realFolio = home.dir === '' ? realRoot : await realpath(join(realRoot, ...home.dir.split('/')))
        const realRecipe = await realpath(join(realRoot, ...recipePath.split('/')))
        if (!realRecipe.startsWith(`${realFolio}/`)) return notIts
      } catch { return notIts }
      // The Folio the widget is in must have its manifest: the file is declared there.
      if (walkNoFollowSync(realRoot, inFolder(place.bundle, MANIFEST_NAME)).kind !== 'file') return refusal(`${place.bundle || 'The Workspace folder'} has no Folio manifest, so a file from outside cannot be brought in here.`)
      const parsed = parseRecipeText(next)
      if (!parsed.ok || checkRecipe(parsed.recipe).length > 0) return refusal('The widget settings are not complete.', parsed.ok ? checkRecipe(parsed.recipe).map((issue) => buildError(issue, recipePath)) : [])
    }
    let checkedEdit: CheckedSourceEdit | null = null
    if (request.sourceEdit !== undefined) {
      // The widget's own source as the patched recipe names it: a file inside the Folio folder, never a resource.
      const parsed = parseRecipeText(next)
      const source = parsed.ok && isRecipeMap(parsed.recipe.source) ? parsed.recipe.source : null
      if (!source || typeof source.path !== 'string') return refusal('This widget does not read a file of its own, so its source cannot be edited here.')
      const file = posix.normalize(posix.join(place.folder, source.path))
      if (sourcePathFor(file, place.bundle, place.folder) === null) return refusal(`${source.path} is outside ${place.bundle || 'the Workspace folder'}, the folder this widget reads from.`)
      const checked = await checkSourceEdit(realRoot, file, request.sourceEdit)
      if (typeof checked === 'string') return refusal(checked)
      checkedEdit = checked
    }
    let snapshot: ExactSnapshot = new Map()
    if (outside !== undefined) {
      // The document the file was chosen for, as it was then: a plain file reached with no link, in the same folder.
      const changed = await pickStillAuthorised(ws, realRoot, outside.pick)
      if (changed !== null) return refusal(changed)
      if (place.bundle !== outside.pick.folder.path) return refusal(`${recipePath} is not a widget of ${outside.pick.documentPath}, the document ${outside.pick.name} was chosen for, so nothing was written.`)
      // Every file the step may write over, by its own plan, as exact bytes. The copy is new; the old source is not
      // touched.
      const exact = await exactBefore(realRoot, plannedWrites({ kind: 'update', recipePath, folio: place.bundle, widgetFolder: place.folder, sourceEdit: checkedEdit ? checkedEdit.file : null }))
      if (!exact.ok) return refusal(exact.message)
      snapshot = exact.snapshot
    }
    const grants: GrantWrite[] = []
    let intake: IntakeResult | null = null
    const step = await recorded(ws, realRoot, async (made) => {
      if (checkedEdit) await writeSourceEdit(ws, realRoot, checkedEdit)
      if (outside !== undefined) {
        intake = await intakeOutsideFile(ws, realRoot, place.bundle, made, outside.pick, outside.inclusion, grants, { store, now: options.now, manifestExisted: true, document: outside.pick.documentPath })
        next = updatedRecipeText(current, { ...patch, source: { ...(patch.source as RecipeMap), resource: intake.id } })
      }
      if (next !== current) await ws.saveFile(recipePath, next, { documentOnly: true, beforeCommit: ws.commitOnlyOver(recipePath, { kind: 'disk', text: current }) })
      const build = await buildStandardWidget(ws, recipePath, options)
      // A file brought in is kept only with a widget that builds from it: otherwise the whole step is put back
      // (the copy, its item in the manifest and its grant), and the build's errors are the answer.
      if (outside !== undefined && (build.result === 'failed' || build.errors.some((error) => error.severity === 'error'))) throw new BuildFailed(build.errors)
      return build
    }, snapshot)
    if (!step.ok) return withGrantsTakenBack(step, store, grants)
    const written = [...new Set(netWrites(step.log).map((write) => write.path))]
    const undoId = desk.hold({ root: ws.root, log: step.log, folders: step.made, paths: written, ...(grants.length ? { grants, store } : {}) })
    const brought = intake as IntakeResult | null
    return { ok: true, undoId, recipeText: next, build: step.value, written, ...(brought ? { intake: { id: brought.id, path: brought.path, inclusion: brought.item.inclusion } } : {}) }
  })
}

/** Build a widget now, in the Collection's write turn. */
export function buildStandardWidgetNow(ws: Workspace, recipePath: string, options: BuildOptions = {}): Promise<BuildOutcome> {
  return ws.exclusiveAll(() => buildStandardWidget(ws, recipePath, options))
}

export type PreviewRequest = {
  /** The document the widget is for (workspace-relative); its Folio folder (or its own folder) is where the source must be. */
  documentPath: string
  /** The recipe draft, as a create takes it (no `widget_schema`, no `source.path`). */
  recipe: RecipeMap
  /** The source file, workspace-relative, inside that folder. */
  sourceFile?: string
  /** Or a file picked outside the document's folders (ticket 04c), not yet brought in: its held bytes are the
   *  source, as the copy in the Folio's resources will be. Made in main from the picker's token only. */
  outside?: OutsidePick
  /** Edited source text not yet saved; stands in for the file's bytes. */
  sourceText?: string
  /** Set when the widget exists: the preview is built as that widget. It must be in the document's Folio
   *  `visualisations` folder; any other is refused. */
  recipePath?: string
  /** The widget's name, for a new widget (only the folder it would have; nothing is made). */
  name?: string
}
export type PreviewResult = { ok: true; html: string; title: string } | OperationRefusal

/** The page a recipe draft and its source would build, with NOTHING written (no folder, recipe, page, receipt or
 *  Folio). Bytes equal to what Create or a rebuild with the same draft and text writes. */
export async function previewStandardWidgetDraft(ws: Workspace, request: PreviewRequest): Promise<PreviewResult> {
  const documentPath = request.documentPath
  try { assertRelativeWorkspacePath(documentPath) } catch { return refusal('The document must be a path inside the open Workspace.') }
  if (!/\.(md|markdown)$/i.test(documentPath) || isHiddenWorkspacePath(documentPath)) return refusal(`${documentPath} is not a Markdown document in a visible folder.`)
  if (!isRecipeMap(request.recipe)) return refusal('The widget settings are missing.')
  // The authority is the real document: it must be a real file reached without a link, and its Folio folder (or its
  // own folder) is where the source must be and where an existing widget's recipe must be.
  const realRoot = await realpath(ws.root)
  if (walkNoFollowSync(realRoot, documentPath).kind !== 'file') return refusal(`${documentPath} is not a real document in real folders of the open Workspace.`)
  const folio = await folioContaining(ws, documentPath)
  const bundle = folio ? folio.dir : parentDir(documentPath)
  let folder: string
  if (request.recipePath !== undefined) {
    const place = recipePlace(request.recipePath)
    if (!place || isHiddenWorkspacePath(request.recipePath)) return refusal(`${request.recipePath} is not a widget recipe (${VISUALISATIONS_DIR}/<name>/${WIDGET_RECIPE_NAME}).`)
    if (place.bundle !== bundle) return refusal(`${request.recipePath} is not one of ${documentPath}'s widgets (they are in ${inFolder(bundle, VISUALISATIONS_DIR)}).`)
    folder = place.folder
  } else {
    folder = `${inFolder(bundle, VISUALISATIONS_DIR)}/${widgetFolderName(request.name ?? request.recipe.title)}`
  }
  let sourcePath: string | null
  let supplied: { folioPath: string; text: string } | undefined
  if (request.outside !== undefined) {
    if (!isGenuinePick(request.outside)) return refusal('The file was not chosen in WriteFlex\'s file picker.')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(request.outside.bytes) } catch { return refusal(`${request.outside.name} is not UTF-8 text.`) }
    // Where the copy will be: the preview's page is the one the create will build from it.
    const folioPath = `${RESOURCES_DIR}/${request.outside.name}`
    supplied = { folioPath, text }
    sourcePath = posix.relative(folder, inFolder(bundle, folioPath))
  } else {
    if (request.sourceFile === undefined) return refusal('Choose the file the widget is built from.')
    sourcePath = sourcePathFor(request.sourceFile, bundle, folder)
    if (sourcePath === null) return refusal(`${request.sourceFile} is outside ${bundle || 'the Workspace folder'}, the folder this document's widgets read from.`)
  }
  // Through the written form and back, as a create does, so the page is the one the build would make.
  let recipe: RecipeMap
  try {
    const parsed = parseRecipeText(recipeText(recipeToWrite(request.recipe, sourcePath)))
    if (!parsed.ok) return refusal('The widget settings are not complete.', parsed.errors.map((issue) => buildError(issue, inFolder(folder, WIDGET_RECIPE_NAME))))
    recipe = parsed.recipe
  } catch (error) {
    return refusal(error instanceof RecipeWriteRefused ? `The widget settings cannot be used: ${error.message}.` : String(error))
  }
  const preview = supplied
    ? await previewStandardWidget(ws, inFolder(folder, WIDGET_RECIPE_NAME), recipe, supplied.text, { folioPath: supplied.folioPath })
    : await previewStandardWidget(ws, inFolder(folder, WIDGET_RECIPE_NAME), recipe, request.sourceText)
  if (!preview.ok) return refusal('The preview could not be built.', preview.errors)
  return { ok: true, html: preview.html, title: preview.title }
}

/** The calls as the renderer makes them (preload): an outside file by its pick token, never by a path or bytes. */
export type CreateWidgetCall = Omit<CreateWidgetRequest, 'outside'> & { pick?: PickChoice }
export type UpdateRecipeCall = Omit<UpdateRecipeRequest, 'outside'> & { pick?: PickChoice; /** The document the pick was made for (with `pick`). */ documentPath?: string }
export type PreviewCall = Omit<PreviewRequest, 'outside'> & { pick?: { token: string } }
