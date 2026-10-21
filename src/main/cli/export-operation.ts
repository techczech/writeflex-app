/**
 * Export a document or a Folio to a file. The one operation that writes OUTSIDE the Collection, so it
 * asks: without `--confirm` it refuses before anything is read. The flag is not the stop (an agent can
 * add it); the stop is the calling agent's own permission prompt, and the skill tells agents never to
 * add the flag without asking.
 *
 * It writes exactly one file, the target, and NEVER REPLACES A FILE, on any disk. Before anything is
 * rendered the target's name is CLAIMED: an empty file is created there with a create that fails if
 * anything at all stands at the name and that follows no link. Rendering can take long; the name is
 * the command's own for all of it. The export is staged beside the target under a temporary name and
 * renamed over the claim, after the claim is seen to be still the file this command made (same file,
 * still empty). If something else stands there by then, the export is refused and that file is left
 * exactly as it is. On any failure the claim is removed, and only if it is still the command's own.
 * A target inside the Collection must be a path the sidebar would show.
 *
 * What remains: between that last look and the rename, a program on this Mac could put another file
 * at the name, and the rename would replace it. Node cannot rename only-if-unchanged. A sync client
 * does not do this to a name that already holds a file.
 *
 * Export is never passed to the app as a request (request-format.ts says why). While the app has the
 * Collection open, the command line still exports by itself: it reads through the guarded Workspace,
 * takes no lock, and says in its result that it exported what is saved on disk. In that case a target
 * INSIDE the Collection is refused, because that would be a write to a Collection another owner holds.
 */
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep, isAbsolute } from 'node:path'
import { assertCollectionWritable } from '../collection-write-gate'
import type { ExportFormat, ExportOutcome } from '../export'
import { CliError, type Operation } from './operation'
import { visiblePath } from './paths'
import { applied, writeAccess } from './write-support'

/** @internal Test seams. `beforeClaim` runs after the target was looked at and found free, before its name is claimed;
 *  `beforeRename` after the export was rendered to its staged file, before the claim is looked at and renamed over. */
export const exportSeams: { beforeClaim?: (target: string) => Promise<void>; beforeRename?: (target: string) => Promise<void> } = {}

const TAKEN = (target: string): CliError => new CliError(`${target} already exists. Export does not replace a file; choose another name.`)

type Claim = { ino: number; dev: number }

/** Take `target`'s name: an empty file, created only if nothing stands there, following no link. */
async function claimName(target: string): Promise<Claim> {
  let handle
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ELOOP') throw TAKEN(target)
    throw new CliError(`${target} could not be created (${code ?? (error instanceof Error ? error.message : String(error))}). Nothing was written.`, 'failed')
  }
  try {
    const made = await handle.stat()
    return { ino: made.ino, dev: made.dev }
  } finally {
    await handle.close()
  }
}

/** Whether the file standing at `target` is still the claim: the same file, still empty, not a link. */
async function claimStands(target: string, claim: Claim): Promise<boolean> {
  const standing = await lstat(target).catch(() => null)
  return !!standing && standing.isFile() && standing.ino === claim.ino && standing.dev === claim.dev && standing.size === 0
}

const FORMAT_BY_EXTENSION: Record<string, ExportFormat> = { '.html': 'html', '.htm': 'html', '.docx': 'docx' }

export const EXPORT_OPERATIONS: Operation[] = [
  {
    name: 'export', group: 'Share and export', behaviour: 'asks', writes: (args) => args.confirm === true,
    summary: 'Export a document, or a folder as one file, to HTML or Word. Writes outside the Collection, so it needs --confirm.',
    args: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative path of a document, or of a folder to export whole.' },
      { name: 'to', type: 'string', required: true, description: 'The file to write. It must not exist yet; its folder must.' },
      { name: 'format', type: 'string', description: 'html or docx. Default: by the target\'s extension.' },
      { name: 'confirm', type: 'boolean', description: 'Required. Never add it without asking the person: this writes a file outside the Collection.' },
    ],
    run: async (ctx, args) => {
      if (args.confirm !== true) {
        throw new CliError('Export refused: it writes a file outside the Collection, so it must be asked for. Ask the person, then run it again with --confirm. Nothing was written.', 'refused', 'confirmation-needed')
      }
      // With the app owning the Collection there is no write access, and none is needed to read.
      const ws = ctx.appOwnsCollection ? ctx.workspace : writeAccess(ctx).workspace
      const typedTarget = resolve(ctx.cwd, String(args.to))
      const format = args.format === undefined ? FORMAT_BY_EXTENSION[extname(typedTarget).toLowerCase()] : (String(args.format).toLowerCase() as ExportFormat)
      if (format !== 'html' && format !== 'docx') throw new CliError('Give --format html or --format docx, or a target ending in .html or .docx.', 'usage')
      let folder = false
      try { folder = String(args.path) === '.' || statSync(ws.absolute(String(args.path))).isDirectory() } catch { /* a document, or nothing */ }
      const path = folder ? visiblePath(ws, String(args.path), { allowRoot: true }) : visiblePath(ws, String(args.path), { markdown: true })

      // The target's folder, links resolved; the file itself must be a free name (a link there counts as taken).
      let targetFolder: string
      try { targetFolder = await realpath(dirname(typedTarget)) } catch { throw new CliError(`The folder to export into does not exist: ${dirname(typedTarget)}`) }
      const target = join(targetFolder, basename(typedTarget))
      if (await lstat(target).catch(() => null)) throw new CliError(`${target} already exists. Export does not replace a file; choose another name.`)
      const inCollection = relative(await realpath(ws.root), target)
      if (!(inCollection === '..' || inCollection.startsWith(`..${sep}`) || isAbsolute(inCollection))) {
        // An export into the Collection is a write to it: same path rule, same gate, same lock.
        if (ws.classifyPath(inCollection, 'file') !== 'document') throw new CliError(`${target} is in a folder WriteFlex keeps for itself or hides; export there is refused.`)
        if (ctx.appOwnsCollection) throw new CliError(`${target} is inside the Collection, which WriteFlex has open, so the command line may not write there. Export to a file outside the Collection, or close the Collection in WriteFlex first. Nothing was written.`)
        assertCollectionWritable(ws.root)
      }

      const staged = join(targetFolder, `.${basename(target)}.${randomBytes(4).toString('hex')}.tmp`)
      // The name is taken before the (possibly long) render, so nothing else can be given it meanwhile.
      await exportSeams.beforeClaim?.(target)
      const claim = await claimName(target)
      let outcome: ExportOutcome
      let placed = false
      try {
        const { exportBundle, exportDocument } = await import('../export')
        outcome = folder ? await exportBundle(ws, { dir: path, format, target: staged }) : await exportDocument(ws, { path, format, target: staged })
        await exportSeams.beforeRename?.(target)
        // Renamed only over the command's own empty claim: whatever else stands there now is not replaced.
        if (!(await claimStands(target, claim))) throw new CliError(`${target} was replaced by another file while the export was being made, so the export was not written there. That file was left as it is; choose another name.`)
        await rename(staged, target)
        placed = true
      } catch (error) {
        throw error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error), 'failed')
      } finally {
        await unlink(staged).catch(() => {})
        if (!placed && await claimStands(target, claim)) await unlink(target).catch(() => {})
      }
      const pictures = [...outcome.missingImages.map((source) => `picture not found: ${source}`), ...outcome.unreadableImages.map((source) => `picture could not be read: ${source}`)]
      const fromDisk = ctx.appOwnsCollection ? '\nThis is what is saved on disk. WriteFlex has the Collection open and may hold text it has not saved yet; that text is not in the export.' : ''
      return applied(
        `Exported ${path === '' ? 'the Collection' : path} to ${target} (${format === 'html' ? 'HTML' : 'Word'}, ${outcome.pieces} piece${outcome.pieces === 1 ? '' : 's'}).${pictures.length ? `\n${pictures.map((line) => `  - ${line}`).join('\n')}` : ''}${fromDisk}`,
        {
          target, format, pieces: outcome.pieces, missingImages: outcome.missingImages, unreadableImages: outcome.unreadableImages,
          // Always what is on disk; `appOpen` says the app may hold unsaved text that is therefore not in it.
          source: 'saved-on-disk', appOpen: ctx.appOwnsCollection === true,
        },
      )
    },
  },
]
