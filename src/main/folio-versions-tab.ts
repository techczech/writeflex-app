/**
 * What the Versions tab reads (Folio versions ticket 05): the timeline of one Folio, and the contents of the
 * version chosen. READ ONLY: nothing here appends a line, makes a folder or writes a file, so opening the tab on a
 * Folio that has no journal creates none (the store's reads treat a missing journal as empty).
 *
 * The timeline is `listFolioVersions` (ticket 03) cut down to plain rows plus the backup's own left-out list for this
 * Folio, so the tab says what the backup will do in the backup's words. The contents are the version's members: parts in
 * running order with the words they held, files not in the outline, and inserted files with the per-file version each used.
 * Words and file-version names are read from the version's saved copies, never from the working files, so they cannot
 * change after the save.
 *
 * Electron-free.
 */
import type { FolioVersionContents, FolioVersionPart, FolioVersionRow, FolioVersionsListing } from '../shared/folio-versions-view'
import { documentWordCount } from './collection'
import { indexNotePath } from './folio'
import { folioDeclaration } from './folio-declaration'
import { listFolioVersions } from './folio-version-listing'
import type { FolioVersionStore, ListedFolioVersion } from './folio-versions'
import type { Workspace } from './workspace'

/** The few fields of a per-file version the tab needs. `path` is where the file's history is now (moves followed), when the source knows it: Compare matches a file across versions by it. */
export type FileVersionFacts = { id: string; name: string; ts: number; snapshotId?: string; path?: string }

/** The seams, so a test can run the tab's reads over a synthetic Collection without a window. */
export type VersionsTabSources = {
  workspace: Workspace
  folioVersions: Pick<FolioVersionStore, 'list'>
  /** Every per-file version, by id, as `readMovedVersions` gives them (never written). */
  fileVersions: () => FileVersionFacts[] | Promise<FileVersionFacts[]>
  /** The saved text of a per-file version's snapshot; null when it is not there. */
  readSnapshot: (snapshotId: string) => Promise<string | null>
  /** Passed through to the backup's left-out read. */
  isDocument?: (path: string) => boolean
  signal?: AbortSignal
}

function rowOf(version: ListedFolioVersion): FolioVersionRow {
  return {
    id: version.id,
    name: version.name,
    ts: version.ts,
    author: version.author.name,
    ...(version.note !== undefined && version.note.trim() !== '' ? { note: version.note } : {}),
    ...(version.sentTo !== undefined ? { sentTo: version.sentTo } : {}),
    ...(version.incoming ? { incomingFrom: version.incoming.author } : {}),
    ...(version.withdrawn ? { withdrawn: true as const } : {}),
  }
}

/** The timeline of the Folio at `dir`, newest first, with what the backup leaves out. Null when `dir` is not a Folio. */
export async function readVersionsListing(sources: VersionsTabSources, dir: string): Promise<FolioVersionsListing | null> {
  let listing
  try {
    listing = await listFolioVersions(sources.workspace, sources.folioVersions, dir, { ...(sources.isDocument ? { isDocument: sources.isDocument } : {}), ...(sources.signal ? { signal: sources.signal } : {}) })
  } catch {
    return null
  }
  return {
    dir: listing.dir,
    versions: listing.versions.map(rowOf),
    backup: listing.backup.state === 'ok' ? { state: 'ok', leftOut: listing.backup.leftOut.map((entry) => ({ id: entry.id, name: entry.name, file: entry.file, reason: entry.reason, ...(entry.withdrawn ? { withdrawn: true as const } : {}) })) } : { state: 'unavailable', reason: listing.backup.reason },
  }
}

const READ_AT_ONCE = 8

async function inBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let at = 0; at < items.length; at += READ_AT_ONCE) out.push(...(await Promise.all(items.slice(at, at + READ_AT_ONCE).map(run))))
  return out
}

/**
 * The contents of one Folio version of the Folio at `dir`: null when `dir` is not a Folio or the version is not one of
 * its versions (an id from another Folio is never answered).
 */
export async function readVersionContents(sources: VersionsTabSources, dir: string, id: string): Promise<FolioVersionContents | null> {
  let versions: ListedFolioVersion[]
  try {
    // Not `listFolioVersions`: the contents do not need the backup's left-out list, which reads the whole history projection.
    if (!folioDeclaration(sources.workspace, dir).isFolio) return null
    versions = await sources.folioVersions.list(indexNotePath(sources.workspace, dir))
  } catch {
    return null
  }
  const version = versions.find((candidate) => candidate.id === id)
  if (!version) return null
  const fileVersions = new Map((await sources.fileVersions()).map((fileVersion) => [fileVersion.id, fileVersion]))

  const wordsOf = async (versionId: string): Promise<number | null> => {
    const snapshotId = fileVersions.get(versionId)?.snapshotId
    if (!snapshotId) return null
    try {
      const text = await sources.readSnapshot(snapshotId)
      return text === null ? null : documentWordCount(text)
    } catch {
      return null
    }
  }
  const titleOf = (member: { path: string; title?: string }): string => member.title?.trim() || member.path.split('/').pop()?.replace(/\.(md|markdown)$/i, '') || member.path

  const contentMembers = version.members.flatMap((member) => (member.role === 'reference' ? [] : [member]))
  const parts = contentMembers.filter((member) => member.role === 'part')
  const unlisted = contentMembers.filter((member) => member.role === 'unlisted')
  const inserted = contentMembers.filter((member) => member.role === 'inserted')
  const index = contentMembers.find((member) => member.role === 'index')

  const toPart = async (member: (typeof contentMembers)[number]): Promise<FolioVersionPart> => ({ path: member.path, title: titleOf(member), ...(member.order !== undefined ? { order: member.order } : {}), words: await wordsOf(member.versionId) })
  const [partRows, unlistedRows] = await Promise.all([inBatches(parts, toPart), inBatches(unlisted, toPart)])
  // Running order is the order the save recorded; a member with no order keeps the journal's order.
  partRows.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))

  return {
    ...rowOf(version),
    indexPath: index?.path ?? version.index.path,
    indexWords: await wordsOf(index?.versionId ?? version.index.versionId),
    parts: partRows,
    unlisted: unlistedRows,
    inserted: inserted.map((member) => {
      const used = fileVersions.get(member.versionId)
      return { path: member.path, fileVersion: used ? { name: used.name, ts: used.ts } : null }
    }),
    references: version.members.flatMap((member) => (member.role === 'reference' ? [{ path: member.path, why: member.why }] : [])),
    words: partRows.reduce((sum, part) => sum + (part.words ?? 0), 0),
  }
}
