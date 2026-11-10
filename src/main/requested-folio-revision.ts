/**
 * The app's side of an agent's `import-revision` and `withdraw-revision` (Folio versions ticket 15; ADR-0052 § Agent verbs), bound to ONE
 * Collection for the whole life of the binding, as requested-folio-version-save.ts is for a Folio save and for the same reasons: a window's
 * current Workspace and stores change under a request in flight, so nothing is looked up when the work runs, and a request that finds the
 * binding replaced is refused with nothing written.
 *
 * `import-revision` (a PROPOSAL: it stages suggestions, applies nothing and saves no text of the writer's):
 *  - reads the Word file ONCE, through the guarded reader, from a file the Collection holds (`.docx`, at most 25 MiB). A request is carried
 *    out for whatever put it in the inbox, so a path outside the Collection is never opened: an agent copies the file in first. The file
 *    goes only to the Word reader (ticket 12), which refuses anything that is not a safe .docx;
 *  - runs the one import (folio-version-import.ts `commitImport`) with the agent's options: what is settled is staged, what only the writer
 *    can settle (a close match, an ambiguous section) is reported and left. The agent can NEVER confirm a match (ADR-0052): this request
 *    takes no confirmation, so only the writer, in the app, turns a close match into a matched section;
 *  - saves the writer's current text as a version first through the Folio save that settles NOTHING (the writer's own waiting changes make
 *    it refuse `version-unsettled`, which the agent reports as `needs-writer`).
 * `withdraw-revision` (direct): takes back the staged changes of an incoming revision that are still undecided and marks the revision
 * withdrawn; no part file is touched.
 *
 * The window's binding is asked before every write (`confirmOwner`, and the binding's own `live()` inside it).
 * Electron-free: ipc.ts gives it the window's objects at bind time, tests give it their own.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { verifiedSnapshotHash } from './cli/history-store'
import { readBytes } from './cli/guarded-fs'
import { DocumentReadRefused, readDocumentBytesGuarded } from './guarded-document-read'
import { commitImport, type ImportDeps } from './folio-version-import'
import { folioSaveSheetFacts } from './folio-version-sheet'
import { withdrawRevision, type WithdrawResult } from './folio-version-stage'
import { FolioVersionStore } from './folio-versions'
import { defaultCompareSources, defaultReaderSources } from './folio-version-sources'
import { requestedFolioVersionSave, type FolioSaveOptions, type FolioVersionSaveBinding } from './requested-folio-version-save'
import { normaliseRoot } from './root-resolution'
import { IMPORT_MAX_DOCX_BYTES, fromProblem, normaliseFrom, type ImportCommitAnswer, type ImportRefused } from '../shared/folio-version-import'

export type RevisionImportInput = {
  /** The Folio's folder, Collection-relative ('' is the Collection root). */
  dir: string
  /** The Word file, Collection-relative. */
  file: string
  /** Who the revision is from. */
  from: string
  /** The Folio version she started from; absent: the one marked as sent to her, else the latest. */
  base?: string
  /** The name of the agent bringing it in: the incoming version's author, so the Versions tab can say who did. */
  by: string
}

export type RequestedRevisionImport = (input: RevisionImportInput, confirmOwner: () => Promise<void>) => Promise<ImportCommitAnswer>
export type RequestedRevisionWithdraw = (id: string, confirmOwner: () => Promise<void>) => Promise<WithdrawResult>

const CLOSED = 'WriteFlex no longer has this Collection open in that window, so nothing was done. Run the command again.'
const refused = (code: ImportRefused['code'], message: string): ImportRefused => ({ status: 'refused', code, message, nothingWritten: true })

class Closed extends Error {}

/** The stores of the binding, and the assertion that they still belong to this Collection and this window. */
function bound(binding: FolioVersionSaveBinding): { workspace: FolioVersionSaveBinding['workspace']; assertBound: () => void } {
  const root = normaliseRoot(binding.workspace.root)
  const assertBound = (): void => {
    if (!binding.live()) throw new Closed(CLOSED)
    if (normaliseRoot(binding.versions.root) !== root || normaliseRoot(binding.changes.root) !== root) throw new Closed('WriteFlex\'s stores for this window belong to another Collection, so nothing was done.')
  }
  assertBound()
  return { workspace: binding.workspace, assertBound }
}

/** The Word file the request names, read once through the guarded reader; the sentence why not otherwise. */
async function readCollectionWordFile(workspace: FolioVersionSaveBinding['workspace'], file: string): Promise<{ name: string; bytes: Buffer } | ImportRefused> {
  if (typeof file !== 'string' || file === '' || file.length > 4096 || file.includes('\0') || posix.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.includes('\\')) {
    return refused('file-not-in-collection', 'Name the Word file by a path inside the Collection. WriteFlex does not open files outside it on request: copy the file into the Collection first. Nothing was done.')
  }
  if (!/\.docx$/i.test(file)) return refused('not-a-word-file', 'That is not a .docx file, so WriteFlex did not open it. Nothing was done.')
  try {
    const read = await readDocumentBytesGuarded(workspace, file, { maxBytes: IMPORT_MAX_DOCX_BYTES })
    return { name: posix.basename(file), bytes: read.bytes }
  } catch (error) {
    if (error instanceof DocumentReadRefused) {
      if (error.code === 'too-large') return refused('too-large', 'This file is too large for WriteFlex to read safely. Nothing was done.')
      return refused('file-not-in-collection', `${error.message} Nothing was done.`)
    }
    return refused('unreadable-file', 'WriteFlex could not read that file. Nothing was done.')
  }
}

export function requestedRevisionImport(binding: FolioVersionSaveBinding, options: FolioSaveOptions = {}): RequestedRevisionImport {
  const save = requestedFolioVersionSave(binding, options)
  return async (input, confirmOwner) => {
    let assertBound: () => void
    let workspace: FolioVersionSaveBinding['workspace']
    try { ({ workspace, assertBound } = bound(binding)) } catch (error) { return refused('collection-closed', error instanceof Error ? error.message : CLOSED) }
    const problem = fromProblem(input.from)
    if (problem !== null) return refused('bad-name', `${problem} Nothing was done.`)
    const file = await readCollectionWordFile(workspace, input.file)
    if ('status' in file) return file
    const author = await binding.author()
    const folioVersions = new FolioVersionStore(workspace)
    const owner = async (): Promise<void> => { await confirmOwner(); assertBound() }
    const deps: ImportDeps = {
      workspace, folioVersions, changes: binding.changes, readWorking: (path) => readBytes(workspace, path).catch(() => null),
      reader: defaultReaderSources(workspace), compare: defaultCompareSources(workspace),
      sheetFacts: (dir) => folioSaveSheetFacts({
        workspace, versions: binding.versions, changes: binding.changes, folioVersions, author,
        snapshotHash: (snapshotId) => verifiedSnapshotHash(workspace.root, snapshotId), readBytes: (path) => readBytes(workspace, path),
      }, dir),
      confirmOwner: owner,
      // The Folio save that settles nothing: the writer's own waiting changes make it refuse `version-unsettled`.
      save: ({ dir, name }) => save({ dir, name }, confirmOwner),
    }
    const sha = createHash('sha256').update(file.bytes).digest('hex')
    const answer = await commitImport(deps, { dir: input.dir, from: normaliseFrom(input.from), ...(input.base !== undefined ? { base: input.base } : {}), fileSha256: sha }, file, { agent: { by: { name: input.by } } })
    if (answer.status === 'done' || !answer.nothingWritten) binding.onSaved?.()
    return answer
  }
}

export function requestedRevisionWithdraw(binding: FolioVersionSaveBinding): RequestedRevisionWithdraw {
  return async (id, confirmOwner) => {
    const { workspace, assertBound } = bound(binding)
    const result = await withdrawRevision({
      workspace, changes: binding.changes, folioVersions: new FolioVersionStore(workspace),
      readWorking: async () => null,
      confirmOwner: async () => { await confirmOwner(); assertBound() },
    }, id)
    binding.onSaved?.()
    return result
  }
}
