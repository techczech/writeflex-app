/** Folio creation and its inverse. Documents and Index Notes are kept; every conversion has a guarded exact inverse. */
import { assertNoRelatedFolio, folioDeclaration, declarationIsSetAside, SET_ASIDE_FILE } from './folio-declaration'
import { parkRunningOrder } from '../shared/folio-declaration'
import { indexNotePath } from './folio'

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { Workspace } from './workspace'
import { FOLIO_BACKUP_NAME, FOLIO_OWNERSHIP_NAME, MANIFEST_NAME, draftManifest } from './folio'
import { createIndexNote } from './collection'
import { type BeforeChange, NEW_CLAUDE_FILE, newAgentsFile, parseAgentsText, writeFolioAgentInstructions } from './folio-agent-instructions'
import { isHiddenWorkspacePath } from './workspace'
import { withPlanLock } from './plan-lock'
import { fileIdentityOf } from './workspace-watcher'

export const TURN_BACK_DESCRIPTION = 'Turn a Folio back into a collection. Save its manifest as .folio-backup.json and park exact originals in .folio-turn-back.json inside the folder. Remove the Running order sections from the Index Note, keeping their exact text in the backup and every other line untouched. Park generated instructions and remove only the maintained block from authored instructions. Undo restores the original manifest, Index Note and instructions exactly, or refuses if they have changed. Make Folio restores unchanged originals; otherwise it drafts a manifest and keeps the parked bytes in the backup.'

function visibleFolder(ws: Workspace, dir: string): void {
  if (dir === '') return
  if (isHiddenWorkspacePath(`${dir}/folio.md`) || dir.startsWith('/') || dir.split('/').includes('..')) {
    throw new Error('Choose a visible folder inside the workspace.')
  }
  ws.absolute(dir || '.')
}

/** Record only an import the instruction writer actually created, never a pre-existing import. */
export async function recordFolioInstructionOwnership(ws: Workspace, dir: string, written: string[]): Promise<void> {
  if (!written.includes(pathIn(dir, 'CLAUDE.md'))) return
  // Keep conversion bookkeeping out of the author's byte-preserved manifest.
  const path = pathIn(dir, FOLIO_OWNERSHIP_NAME)
  const claudeHash = createHash('sha256').update(NEW_CLAUDE_FILE, 'utf8').digest('hex')
  await ws.saveFile(path, JSON.stringify({ claudeHash }) + '\n')
}

const pathIn = (dir: string, name: string) => dir ? `${dir}/${name}` : name

/** Reserve a fresh child folder, then use the existing Index Note and instruction writers. */
export async function createNestedFolio(ws: Workspace, parent: string, beforeChange?: BeforeChange): Promise<string> {
  ws.assertWritable()
  visibleFolder(ws, parent)
  let dir = ''
  for (let suffix = 1; ; suffix++) {
    dir = pathIn(parent, `Untitled Folio${suffix === 1 ? '' : ` ${suffix}`}`)
    if (existsSync(ws.absolute(dir))) continue
    await assertNoRelatedFolio(ws, dir)
    try {
      await mkdir(ws.absolute(dir))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  await createIndexNote(ws, dir)
  await ws.saveFile(pathIn(dir, MANIFEST_NAME), JSON.stringify({ schema_version: 1, content_root: '', files: [] }, null, 2) + '\n', { exclusive: true })
  await recordFolioInstructionOwnership(ws, dir, await writeFolioAgentInstructions(ws, dir, beforeChange))
  return dir
}

/** Only the managed block (and its recorded separator), never an author's text. */
export function withoutFolioInstructions(text: string): string {
  if (text === newAgentsFile()) return ''
  const block = parseAgentsText(text)
  if (block.kind === 'damaged') throw new Error('The Folio instruction markers are damaged. Repair them before turning back into a collection.')
  if (block.kind !== 'block') return text
  if (text.replace(/\r\n/g, '\n') === newAgentsFile(block.body)) return ''
  const firstLine = text.slice(block.start, text.indexOf('\n', block.start))
  const recorded = /; separator=([012])/.exec(firstLine)
  // Older releases appended one newline to an existing newline, or two to a file without one.
  const separator = recorded ? Number(recorded[1]) : text.slice(0, block.start).endsWith('\n\n') ? (text.slice(0, block.start).endsWith('\n\n\n') ? 1 : 2) : 0
  const start = block.start - separator
  if (start < 0 || !/^\n*$/.test(text.slice(start, block.start))) throw new Error('The Folio instruction separator changed. Nothing was removed.')
  const end = text.startsWith('\r\n', block.end) ? block.end + 2 : text[block.end] === '\n' ? block.end + 1 : block.end
  const hash = createHash('sha256').update(block.body.replace(/\r\n?/g, '\n')).digest('hex').slice(0, 12)
  // An edited maintained part can contain the author's words: keep its body, removing only markers.
  const rawBody = text.slice(text.indexOf('\n', block.start) + 1, text.lastIndexOf('\n', block.end - 1) + 1)
  return text.slice(0, start) + (hash === block.recorded ? '' : rawBody) + text.slice(end)
}

export async function turnBackIntoCollection(ws: Workspace, dir: string, declaredPaths?: readonly string[]): Promise<string[]> {
  visibleFolder(ws, dir)
  return withPlanLock(ws, dir, () => ws.exclusiveAll(async () => {
    ws.assertWritable()
    let pending: SavedConversion | null = null
    try { pending = await savedConversion(ws, dir) } catch { /* An unreadable old receipt is archived verbatim below. */ }
    if (pending?.receipt.status === 'pending') {
      let inverse: ConversionEdit[] | undefined
      try { inverse = inverseEdits(ws, pending) } catch { /* Later author edits are kept. */ }
      // A later author edit makes recovery unsafe; archive the receipt below and start from now.
      if (inverse) await restoreSavedConversion(ws, dir, pending, inverse, declaredPaths)
    }
    const declaration = folioDeclaration(ws, dir)
    if (!declaration.isFolio && !declaration.repairNeeded) throw new Error('This folder is not a Folio.')
    const manifest = pathIn(dir, MANIFEST_NAME)
    const manifestSource = await plainText(ws, manifest)
    const source = manifestSource ?? await plainText(ws, pathIn(dir, FOLIO_BACKUP_NAME))
    const ownership = pathIn(dir, FOLIO_OWNERSHIP_NAME)
    const ownershipSource = await plainText(ws, ownership)
    let claudeHash: unknown
    try { claudeHash = ownershipSource === null ? undefined : JSON.parse(ownershipSource).claudeHash } catch { /* No verifiable ownership. */ }
    const backup = pathIn(dir, FOLIO_BACKUP_NAME)
    if (existsSync(ws.absolute(backup)) && !lstatSync(ws.absolute(backup)).isFile()) {
      throw new Error('The Folio backup must be a plain file.')
    }
    const oldBackup = await plainText(ws, backup)
    const edits: Array<{ path: string; before: string | null; after: string | null }> = [
      { path: backup, before: oldBackup, after: source },
    ]
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const path = pathIn(dir, name)
      if (!existsSync(ws.absolute(path))) { edits.push({ path, before: null, after: null }); continue }
      if (!lstatSync(ws.absolute(path)).isFile()) throw new Error('Folio instructions must be plain files. Nothing was removed.')
      const before = (await plainText(ws, path))!
      const ownedImport = typeof claudeHash === 'string' && createHash('sha256').update(before, 'utf8').digest('hex') === claudeHash
      const after = name === 'AGENTS.md' ? withoutFolioInstructions(before) : ownedImport ? before.replace(/^@AGENTS\.md(?:\r?\n|$)/m, '') : before
      edits.push({ path, before, after: name === 'AGENTS.md' && before !== '' && after === '' || name === 'CLAUDE.md' && ownedImport && after === '' ? null : after })
    }
    const index = indexNotePath(ws, dir)
    const indexSource = await plainText(ws, index)
    if (indexSource !== null) {
      const after = parkRunningOrder(indexSource)
      edits.push({ path: index, before: indexSource, after })
    } else edits.push({ path: index, before: null, after: null })
    // Ownership ends with this conversion, including when an edited file must be kept.
    edits.push({ path: ownership, before: ownershipSource, after: null })
    edits.push({ path: manifest, before: manifestSource, after: null })
    const receiptPath = pathIn(dir, FOLIO_TURN_BACK_NAME)
    const oldReceipt = await plainText(ws, receiptPath)
    // Keep older parked bytes in a separate WriteFlex-owned file, never recursively escaped JSON.
    const archive = oldReceipt === null ? [] : [await retiredReceipt(ws, dir, oldReceipt)]
    const receipt = { version: 1, status: 'pending', edits }
    const pendingSource = JSON.stringify(receipt) + '\n'
    const all = [...archive, { path: receiptPath, before: oldReceipt, after: pendingSource }, ...edits]
    if (declaredPaths && all.some(edit => !declaredPaths.includes(ws.absolute(edit.path)))) {
      throw new Error('The saved conversion changed after its snapshot. Try Turn back again; nothing was changed.')
    }
    await applyConversionEdits(ws, all)
    // A crash before this marker leaves a recoverable pending conversion. Recovery accepts only
    // each recorded before/after state, so it cannot overwrite a later author edit.
    await applyConversionEdits(ws, [{ path: receiptPath, before: pendingSource, after: JSON.stringify({ ...receipt, status: 'complete' }) + '\n' }])
    // Creating/removing metadata also changes the folder itself. Record its final identity
    // so a queued native folder event is recognised as this conversion, not a later edit.
    if (dir) ws.recordOwnWrite(dir, fileIdentityOf(lstatSync(ws.absolute(dir), { bigint: true })))
    return all.map(edit => edit.path)
  }))
}

/** A private conversion receipt parks exact originals alongside the legacy manifest backup. */
export const FOLIO_TURN_BACK_NAME = '.folio-turn-back.json'
type ConversionEdit = { path: string; before: string | null; after: string | null }

async function plainText(ws: Workspace, path: string): Promise<string | null> {
  const stat = lstatSync(ws.absolute(path), { throwIfNoEntry: false })
  if (!stat) return null
  if (!stat.isFile()) throw new Error('Folio metadata and instructions must be plain files. Nothing was changed.')
  const bytes = readFileSync(ws.absolute(path))
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${path} is not UTF-8, so it cannot be backed up exactly. Nothing was changed.`)
  return text
}

async function applyConversionEdits(ws: Workspace, edits: ConversionEdit[]): Promise<void> {
  const folder = dirname(ws.absolute(edits[0].path))
  const real = realpathSync.native(folder)
  const stat = lstatSync(folder)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a plain folder inside the workspace.')
  const inFolder = { real, dev: stat.dev, ino: stat.ino }
  const write = async (edit: ConversionEdit) => {
    assertBytes(ws, edit.path, edit.before)
    const beforeCommit = () => assertBytes(ws, edit.path, edit.before)
    if (edit.after === null) {
      ws.recordOwnWrite(edit.path, 'absent')
      try { ws.removeFileOverRead(edit.path, edit.before!, { inFolder }) }
      catch (error) { ws.forgetOwnWrites(edit.path); throw error }
    } else if (edit.before === null) await ws.saveFileOver(edit.path, edit.after, { kind: 'create' }, { allowExplicitEmpty: true, inFolder, beforeCommit })
    else await ws.saveFileOverRead(edit.path, edit.after, edit.before, { allowExplicitEmpty: true, inFolder, beforeCommit })
  }
  // Check the complete step before its first write; Undo either restores the exact versions or refuses.
  for (const edit of edits) assertBytes(ws, edit.path, edit.before)
  const applied: ConversionEdit[] = []
  try {
    for (const edit of edits) {
      if (edit.before === edit.after) continue
      await write(edit); applied.push(edit)
    }
    for (const edit of edits) assertBytes(ws, edit.path, edit.after)
  } catch (error) {
    const failed: string[] = []
    for (const edit of applied.reverse()) {
      try { await write({ path: edit.path, before: edit.after, after: edit.before }) } catch { failed.push(edit.path) }
    }
    if (failed.length) throw new Error(`${error instanceof Error ? error.message : String(error)} Could not restore: ${failed.join(', ')}.`, { cause: error })
    throw error
  }
}

function assertBytes(ws: Workspace, path: string, expected: string | null): void {
  const standing = lstatSync(ws.absolute(path), { throwIfNoEntry: false })
  const matches = expected === null
    ? !standing
    : standing?.isFile() && readFileSync(ws.absolute(path)).equals(Buffer.from(expected, 'utf8'))
  if (!matches) throw new Error(`${path} changed on disk. The conversion cannot restore it exactly.`)
}

type ConversionReceipt = { version: 1; status?: 'pending' | 'complete'; previousReceipt?: unknown; edits: ConversionEdit[] }
type SavedConversion = { source: string; receipt: ConversionReceipt }

async function savedConversion(ws: Workspace, dir: string): Promise<SavedConversion | null> {
  const source = await plainText(ws, pathIn(dir, FOLIO_TURN_BACK_NAME))
  if (source === null) return null
  let receipt: ConversionReceipt
  try { receipt = JSON.parse(source) } catch {
    throw new Error('The saved conversion could not be read.')
  }
  const allowed = new Set([MANIFEST_NAME, FOLIO_BACKUP_NAME, FOLIO_OWNERSHIP_NAME, 'AGENTS.md', 'CLAUDE.md', indexNotePath(ws, dir).split('/').at(-1)!].map(name => pathIn(dir, name)))
  if (!receipt || receipt.version !== 1 || !Array.isArray(receipt.edits) || receipt.edits.length === 0 || receipt.edits.length > allowed.size
    || (receipt.status !== undefined && receipt.status !== 'pending' && receipt.status !== 'complete')) {
    throw new Error('The saved conversion cannot be restored.')
  }
  const seen = new Set<string>()
  for (const edit of receipt.edits) {
    if (!edit || !allowed.has(edit.path) || seen.has(edit.path)
      || ![edit.before, edit.after].every(value => value === null || typeof value === 'string')) {
      throw new Error('The saved conversion cannot be restored.')
    }
    seen.add(edit.path)
  }
  return { source, receipt }
}

function inverseEdits(ws: Workspace, saved: SavedConversion): ConversionEdit[] {
  return [...saved.receipt.edits].reverse().map(edit => {
    // Pending conversions may have stopped before or after any one atomic write.
    if (saved.receipt.status === 'pending') {
      try {
        assertBytes(ws, edit.path, edit.before)
        return { path: edit.path, before: edit.before, after: edit.before }
      } catch { /* Only the recorded after state is also safe. */ }
    }
    assertBytes(ws, edit.path, edit.after)
    return { path: edit.path, before: edit.after, after: edit.before }
  })
}

function retiredReceiptPath(ws: Workspace, dir: string, source: string): string {
  const hash = createHash('sha256').update(source, 'utf8').digest('hex')
  return pathIn(dir, `.folio-turn-back-retired-${hash}.json`)
}

/** Declare the retirement file to the agent snapshot before a conversion can write it. */
export async function turnBackRetirementPaths(ws: Workspace, dir: string): Promise<string[]> {
  const source = await plainText(ws, pathIn(dir, FOLIO_TURN_BACK_NAME))
  return source === null ? [] : [retiredReceiptPath(ws, dir, source)]
}

/** Snapshot every conversion write, including receipt retirement. */
export async function folioConversionTouchedPaths(ws: Workspace, dir: string): Promise<string[]> {
  const names = [MANIFEST_NAME, 'AGENTS.md', 'CLAUDE.md', FOLIO_OWNERSHIP_NAME, FOLIO_BACKUP_NAME, FOLIO_TURN_BACK_NAME, indexNotePath(ws, dir).split('/').at(-1)!]
  return [...names.map(name => pathIn(dir, name)), ...(declarationIsSetAside(ws, dir) ? [SET_ASIDE_FILE] : []), ...await turnBackRetirementPaths(ws, dir)].map(path => ws.absolute(path))
}

/** Exact restored bytes stay intact; an Index-Note-only Folio still gets missing instructions. */
export async function writeRestoredFolioInstructions(ws: Workspace, dir: string, beforeChange?: BeforeChange): Promise<string[]> {
  if (folioDeclaration(ws, dir).manifest) return []
  const written = await writeFolioAgentInstructions(ws, dir, beforeChange, { preserveExisting: true })
  await recordFolioInstructionOwnership(ws, dir, written)
  if (written.includes(pathIn(dir, 'CLAUDE.md'))) written.push(pathIn(dir, FOLIO_OWNERSHIP_NAME))
  return written
}

async function retiredReceipt(ws: Workspace, dir: string, source: string): Promise<ConversionEdit> {
  const path = retiredReceiptPath(ws, dir, source)
  const before = await plainText(ws, path)
  if (before !== null && before !== source) throw new Error('The retired conversion backup changed. Nothing was overwritten.')
  return { path, before, after: source }
}

async function restoreSavedConversion(ws: Workspace, dir: string, saved: SavedConversion, edits: ConversionEdit[], declaredPaths?: readonly string[]): Promise<string[]> {
  // Old receipts may contain earlier parked originals. Preserve that history separately before
  // retiring the active receipt; new receipts have no nested history.
  if (saved.receipt.previousReceipt != null) {
    const archive = await retiredReceipt(ws, dir, saved.source)
    edits.push(archive)
  }
  edits.push({ path: pathIn(dir, FOLIO_TURN_BACK_NAME), before: saved.source, after: null })
  if (declaredPaths && edits.some(edit => !declaredPaths.includes(ws.absolute(edit.path)))) {
    throw new Error('The saved conversion changed after its snapshot. Try Make Folio again; nothing was changed.')
  }
  await applyConversionEdits(ws, edits)
  return edits.filter(edit => edit.before !== edit.after).map(edit => edit.path)
}

/** Strict Undo: all guards must pass. Successful restoration consumes its receipt. */
export async function restoreTurnedBackFolio(ws: Workspace, dir: string, options: { expectedSource?: string; fallback?: boolean; declaredPaths?: readonly string[] } = {}): Promise<string[] | null> {
  visibleFolder(ws, dir)
  return withPlanLock(ws, dir, () => ws.exclusiveAll(async () => {
    ws.assertWritable()
    await assertNoRelatedFolio(ws, dir)
    const { expectedSource, fallback, declaredPaths } = options
    let saved: SavedConversion | null
    let inverse: ConversionEdit[] = []
    try {
      saved = await savedConversion(ws, dir)
      if (expectedSource !== undefined && saved?.source !== expectedSource) throw new Error('The saved conversion changed. Make Folio again to see the current contents.')
      if (saved) inverse = inverseEdits(ws, saved)
    } catch (error) {
      if (fallback) return null
      throw error
    }
    return saved ? restoreSavedConversion(ws, dir, saved, inverse, declaredPaths) : null
  }))
}

/** Read-only Make preview. A stale/corrupt receipt never blocks forward conversion. */
export async function prepareMakeFolio(ws: Workspace, dir: string): Promise<{ draft: string; warning?: string; receiptSource?: string }> {
  let warning: string | undefined
  let saved: SavedConversion | null = null
  try {
    saved = await savedConversion(ws, dir)
    if (saved) inverseEdits(ws, saved)
  } catch (error) {
    warning = `${error instanceof Error ? error.message : String(error)} The parked running order and instructions were not reapplied; they are kept in ${pathIn(dir, FOLIO_TURN_BACK_NAME)}.`
    saved = null
  }
  let draftWarning: string | undefined
  const originalManifest = saved?.receipt.edits.find(edit => edit.path === pathIn(dir, MANIFEST_NAME))?.before
  const draft = originalManifest ?? await draftManifest(ws, dir, message => { draftWarning = message })
  return { draft, warning: [warning, draftWarning].filter(Boolean).join(' ') || undefined, ...(saved ? { receiptSource: saved.source } : {}) }
}

/** Exact originals and any newly supplied files are reported separately. */
export function restoredFolioMessage(added: readonly string[]): string {
  return added.length
    ? `Restored the Folio and running order. Added missing files: ${added.join(', ')}.`
    : 'Restored the Folio, running order and instructions exactly.'
}
