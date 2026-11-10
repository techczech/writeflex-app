/**
 * Export a saved Folio version (ADR-0052 § The eight changes 1; Folio versions ticket 11).
 *
 * The Folio export (`exportBundle`, export.ts) reads a Folio from a Workspace on disk. A version is not on disk: it is the
 * text each member had when it was saved, held in the history stores. So the version is READ through the shared reader
 * (folio-version-reader.ts, by per-file version id, never by the working path) and laid out as a Folio folder in a private
 * temporary folder, and the app's one Folio export then runs over that folder. Nothing about HTML or Word is repeated here:
 * the running order is the saved Index Note's, the titles, cover, pictures and widgets are the saved files', exactly as the
 * ordinary export would draw them for a Folio that looked like that.
 *
 * The temporary folder is made owner-only, outside every Collection, and removed when the export is over (success, refusal or
 * failure). Nothing here writes the Collection, the history or the Folio journal; marking a version as sent is separate
 * (folio-version-mark-sent.ts) and happens only after the file was written.
 *
 * A file is made from the version or not at all: when the saved text of the Index Note or of a part cannot be read, the export is
 * refused with a sentence and nothing is written, never a Folio with a part missing. An inserted file whose saved copy cannot be
 * read is left out, and the export reports it as a picture or widget it could not find, as it does for any missing file.
 */
import { chmod, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { exportBundle, exportFileName, type ExportFormat, type ExportOutcome, type HtmlExportOptions } from './export'
import { exportCollectionTitle } from './export-title'
import { MANIFEST_NAME } from './folio'
import { openVersionMembers, type VersionReaderSources } from './folio-version-reader'
import type { ListedFolioVersion } from './folio-versions'
import { Workspace } from './workspace'

/** The export cannot be made, and why, in a sentence for the person. Nothing was written. */
export class FolioVersionExportRefused extends Error {
  override readonly name = 'FolioVersionExportRefused'
  readonly code: 'not-found' | 'unreadable'
  constructor(message: string, code: 'not-found' | 'unreadable' = 'not-found') { super(message); this.code = code }
}

/** A Folio version laid out to be exported. Close it when done, whatever happened. */
export type VersionForExport = {
  version: ListedFolioVersion
  /** The Folio's folder as the version recorded it (not necessarily where the Folio is now). */
  dir: string
  /** The name the save dialog opens with: the version's own title, made safe for a file system. */
  suggestedName: (format: ExportFormat) => Promise<string>
  /** Write the export of the version to `target` (the one Folio export; `exportBundle`). */
  export: (format: ExportFormat, target: string, html?: HtmlExportOptions) => Promise<ExportOutcome>
  close: () => Promise<void>
}

const insideOf = (root: string, path: string): boolean => {
  const to = relative(root, path)
  return to !== '' && to !== '..' && !to.startsWith(`..${sep}`) && !isAbsolute(to)
}

/** A label (Collection-relative, posix) that stays inside the folder it is joined to. */
function safeLabel(label: string): boolean {
  return label !== '' && !label.includes('\u0000') && !label.includes('\\') && !posix.isAbsolute(label) && !posix.normalize(label).split('/').includes('..')
}

/** The folder a Folio at the Collection's root is laid out in, so the Index Note's own name (`_<name>_INDEX.md`) still names it. */
const rootFolderName = (indexLabel: string): string => /^_(.+)_INDEX\.md$/.exec(posix.basename(indexLabel))?.[1] ?? 'folio'

/**
 * Open version `id` of the Folio at `dir` for export: read every member's saved bytes through the shared reader and lay them out
 * as a Folio folder. Refused (`FolioVersionExportRefused`, nothing left behind) when the Folio or version is not there, when the
 * saved text of the Index Note or a part cannot be read, or when a recorded label is not a safe relative path.
 */
export async function openVersionForExport(sources: VersionReaderSources, dir: string, id: string): Promise<VersionForExport> {
  const opened = await openVersionMembers(sources, dir, id)
  if (!opened) throw new FolioVersionExportRefused('That Folio version is not in this Folio, so nothing was exported.')
  const { version } = opened
  const folioDir = posix.dirname(version.index.path) === '.' ? '' : posix.dirname(version.index.path)

  const parent = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'writeflex-version-export-')))
  const close = async (): Promise<void> => { await rm(parent, { recursive: true, force: true }).catch(() => undefined) }
  try {
    // Owner-only: the text of a version is the writer's, and it lives here for the length of one export.
    await chmod(parent, 0o700)
    const root = folioDir === '' ? join(parent, rootFolderName(version.index.path)) : join(parent, 'collection')
    await mkdir(root, { recursive: true })
    const seconds = version.ts / 1000
    for (const member of opened.members) {
      if (!safeLabel(member.path)) throw new FolioVersionExportRefused(`The saved Folio version names a file (${member.path}) that is not a path inside the Folio, so nothing was exported.`, 'unreadable')
      // A Folio at the root is laid out inside its own named folder: its members' labels are relative to the Collection root, which is that folder.
      const target = resolve(root, member.path)
      if (!insideOf(root, target)) throw new FolioVersionExportRefused(`The saved Folio version names a file (${member.path}) that is not a path inside the Folio, so nothing was exported.`, 'unreadable')
      const bytes = await opened.bytesOf(member)
      if (bytes === null) {
        // A Folio with a part missing is never exported. An inserted copy that cannot be read is left out; the export says it could not find it.
        if (member.role === 'inserted' || member.role === 'unlisted') continue
        throw new FolioVersionExportRefused(`The saved text of ${member.role === 'index' ? 'the Index Note' : `“${member.title ?? posix.basename(member.path)}”`} in “${version.name}” could not be read from the history, so nothing was exported.`, 'unreadable')
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
      // The modified date an HTML export prints for a part is the version's, not the day of the export.
      await utimes(target, seconds, seconds).catch(() => undefined)
    }
    // The Folio export follows a manifest (`_report-structure.json`), which a version does not hold: it is made here from the version's own
    // running order (its parts, in the order it saved them), so the file's order is the version's, not whatever the Folio's manifest says now.
    const partPaths = opened.members.filter((member) => member.role === 'part').map((member, at) => ({ member, at }))
      .sort((a, b) => (a.member.order ?? a.at + 1) - (b.member.order ?? b.at + 1) || a.at - b.at)
      .flatMap(({ member }) => { const own = posix.relative(folioDir, member.path); return own === '' || own.startsWith('..') ? [] : [own] })
    await writeFile(join(root, folioDir, MANIFEST_NAME), `${JSON.stringify({ schema_version: 1, content_root: '', files: partPaths.map((path) => ({ path })) }, null, 2)}\n`)
    const workspace = new Workspace(root)
    return {
      version,
      dir: folioDir,
      suggestedName: async (format) => exportFileName(await exportCollectionTitle(workspace, folioDir), format),
      export: (format, target, html) => exportBundle(workspace, { dir: folioDir, format, target, ...(html ? { html } : {}) }),
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
