/** Folio creation and its inverse. Documents and Index Notes are never removed. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import type { Workspace } from './workspace'
import { FOLIO_BACKUP_NAME, FOLIO_OWNERSHIP_NAME, MANIFEST_NAME, readManifest } from './folio'
import { createIndexNote } from './collection'
import { type BeforeChange, NEW_CLAUDE_FILE, newAgentsFile, parseAgentsText, writeFolioAgentInstructions } from './folio-agent-instructions'
import { isHiddenWorkspacePath } from './workspace'
import { withPlanLock } from './plan-lock'

export const TURN_BACK_DESCRIPTION = 'Turn a Folio back into a collection. Keep its manifest as .folio-backup.json inside the folder; the backup does not make the folder a Folio. Make a Folio restores that backup, drops entries whose files no longer exist, appends new files at the end as sections, and keeps everything else byte-for-byte. Remove WriteFlex’s Folio instruction block. Remove its generated CLAUDE.md only while it matches the recorded content hash; keep edited CLAUDE.md unchanged. Keep edited instructions without their markers, all documents, the Index Note and your own instructions.'

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
  if (await readManifest(ws, parent)) throw new Error("Folios can't contain another Folio from here.")
  let dir = ''
  for (let suffix = 1; ; suffix++) {
    dir = pathIn(parent, `Untitled Folio${suffix === 1 ? '' : ` ${suffix}`}`)
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

export async function turnBackIntoCollection(ws: Workspace, dir: string, trash?: (absolute: string) => Promise<void>): Promise<string[]> {
  visibleFolder(ws, dir)
  return withPlanLock(ws, dir, () => ws.exclusiveAll(async () => {
    ws.assertWritable()
    if (!await readManifest(ws, dir)) throw new Error('This folder is not a Folio.')
    const manifest = pathIn(dir, MANIFEST_NAME)
    if (!lstatSync(ws.absolute(manifest)).isFile()) throw new Error('The manifest must be a plain file.')
    const source = (await ws.readFile(manifest)).content
    const ownership = pathIn(dir, FOLIO_OWNERSHIP_NAME)
    const ownershipSource = existsSync(ws.absolute(ownership)) ? (await ws.readFile(ownership)).content : null
    let claudeHash: unknown
    try { claudeHash = ownershipSource === null ? undefined : JSON.parse(ownershipSource).claudeHash } catch { /* No verifiable ownership. */ }
    const backup = pathIn(dir, FOLIO_BACKUP_NAME)
    if (existsSync(ws.absolute(backup)) && !lstatSync(ws.absolute(backup)).isFile()) {
      throw new Error('The Folio backup must be a plain file.')
    }
    const oldBackup = existsSync(ws.absolute(backup)) ? (await ws.readFile(backup)).content : null
    const edits: Array<{ path: string; before: string | null; after: string | null }> = [
      { path: backup, before: oldBackup, after: source },
    ]
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const path = pathIn(dir, name)
      if (!existsSync(ws.absolute(path))) continue
      if (!lstatSync(ws.absolute(path)).isFile()) throw new Error('Folio instructions must be plain files. Nothing was removed.')
      const before = (await ws.readFile(path)).content
      const ownedImport = typeof claudeHash === 'string' && createHash('sha256').update(before, 'utf8').digest('hex') === claudeHash
      const after = name === 'AGENTS.md' ? withoutFolioInstructions(before) : ownedImport ? before.replace(/^@AGENTS\.md(?:\r?\n|$)/m, '') : before
      if (before !== after) {
        edits.push({ path, before, after: name === 'CLAUDE.md' && ownedImport && after === '' ? null : after })
      }
    }
    // Ownership ends with this conversion, including when an edited file must be kept.
    if (ownershipSource !== null) edits.push({ path: ownership, before: ownershipSource, after: null })
    // Back up before removing the declaration. A failed conversion leaves the folder a Folio.
    const applied: typeof edits = []
    try {
      for (const edit of edits) {
        if (edit.after === null) {
          if (trash && edit.path === pathIn(dir, 'CLAUDE.md')) {
            await ws.assertOnDisk(edit.path, { kind: 'disk', text: edit.before! })
            await ws.moveToTrash(edit.path, trash)
          } else {
            ws.removeFileOverRead(edit.path, edit.before!)
          }
        } else {
          if (edit.before === null) await ws.saveFileOver(edit.path, edit.after, { kind: 'create' })
          else await ws.saveFileOverRead(edit.path, edit.after, edit.before, { allowExplicitEmpty: true })
        }
        applied.push(edit)
      }
      ws.removeFileOverRead(manifest, source)
    } catch (error) {
      const failed: string[] = []
      for (const edit of applied.reverse()) {
        try {
          if (edit.before === null) ws.removeFileOverRead(edit.path, edit.after!)
          else if (edit.after === null) await ws.saveFileOver(edit.path, edit.before, { kind: 'create' })
          else await ws.saveFileOverRead(edit.path, edit.before, edit.after, { allowExplicitEmpty: true })
        } catch {
          failed.push(edit.path)
        }
      }
      if (failed.length) throw new Error(`${error instanceof Error ? error.message : String(error)} Could not restore: ${failed.join(', ')}.`, { cause: error })
      throw error
    }
    return [manifest, ...edits.map(edit => edit.path)]
  }))
}
