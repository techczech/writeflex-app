/**
 * The shared reader of Folio versions (ADR-0052; Folio versions ticket 07): the text of one member of a Folio version
 * EXACTLY as the version saved it. The read-only view, Compare, Export and the Scratchpad's "send a copy" all read through
 * these functions, so they cannot disagree about what a version said.
 *
 * HOW A MEMBER IS FOUND. A member is named by the label (path) the version recorded, but the label is only looked up among
 * that version's own members; it is never joined to the Collection or read from disk. The bytes come from the member's
 * per-file version id (`members[].versionId`) → that version's snapshot → the history store's object, so a file that has
 * since changed, moved or been deleted still reads as it was saved. An id, a path or a heading that is not one of this
 * version's is answered with `null`; nothing is guessed. The co-author's converted section (`side: 'theirs'`) is read from
 * the Folio-owned object named by the version's own incoming record, checked against its hash by the object store.
 *
 * READS ONLY: nothing here appends a journal line, makes a folder, repairs a store or writes a file. Electron-free.
 */
import { indexNotePath } from './folio'
import { folioDeclaration } from './folio-declaration'
import type { FolioVersionStore, ListedFolioVersion } from './folio-versions'
import type { FolioContentMember, FolioMemberRole } from '../shared/folio-version-records'
import { readVersionContents, type FileVersionFacts } from './folio-versions-tab'
import type { FolioVersionReading } from '../shared/folio-versions-view'
import type { Workspace } from './workspace'

/** The seams, so a test can read a synthetic Collection's versions without a window. */
export type VersionReaderSources = {
  workspace: Workspace
  folioVersions: Pick<FolioVersionStore, 'list'>
  /** Every per-file version, by id, as `readMovedVersions` gives them (never written). */
  fileVersions: () => FileVersionFacts[] | Promise<FileVersionFacts[]>
  /** The exact bytes a per-file version's snapshot holds; null when there is none. */
  readSnapshotBytes: (snapshotId: string) => Promise<Buffer | null>
  /** The bytes of a Folio-owned object (an incoming revision's converted section); null when there is none. */
  readFolioObject?: (sha256: string) => Promise<Buffer | null>
}

/** A member's text as the version saved it. `bytes` are exact; `text` is their UTF-8 reading. */
export type VersionMemberText = {
  role: FolioMemberRole
  /** The label the version recorded. */
  path: string
  title?: string
  order?: number
  bytes: Buffer
  text: string
}

/** Her converted section of an incoming revision, as saved. */
export type IncomingSectionText = { heading: string; part?: string; match: string; bytes: Buffer; text: string }

const utf8 = (bytes: Buffer): string => bytes.toString('utf8')

/** The version `id` of the Folio at `dir`; null when `dir` is not a Folio or `id` is not one of its versions (another Folio's id is never answered). */
export async function findFolioVersion(sources: Pick<VersionReaderSources, 'workspace' | 'folioVersions'>, dir: string, id: string): Promise<ListedFolioVersion | null> {
  if (typeof id !== 'string') return null
  try {
    if (!folioDeclaration(sources.workspace, dir).isFolio) return null
    const versions = await sources.folioVersions.list(indexNotePath(sources.workspace, dir))
    return versions.find((candidate) => candidate.id === id) ?? null
  } catch {
    return null
  }
}

/** The bytes of the per-file version `versionId`, through its snapshot; null when the version or its text is not in the history. */
async function bytesOfFileVersion(sources: VersionReaderSources, fileVersions: Map<string, FileVersionFacts>, versionId: string): Promise<Buffer | null> {
  const snapshotId = fileVersions.get(versionId)?.snapshotId
  if (!snapshotId) return null
  try {
    return await sources.readSnapshotBytes(snapshotId)
  } catch {
    return null
  }
}

const contentMembers = (version: ListedFolioVersion): FolioContentMember[] => version.members.flatMap((member) => (member.role === 'reference' ? [] : [member]))

/** A Folio version opened for reading its members' bytes: its content members, its per-file versions, and the read of one member. */
export type OpenedVersionMembers = {
  version: ListedFolioVersion
  /** Every per-file version, by id. */
  facts: Map<string, FileVersionFacts>
  /** The version's own content members (the Index Note, parts, files not in the outline, inserted files), in the version's order. */
  members: FolioContentMember[]
  /** The exact bytes of one of `members`, through its per-file version id; null when the saved text cannot be read. */
  bytesOf: (member: FolioContentMember) => Promise<Buffer | null>
}

/** Open version `id` of the Folio at `dir` for reading its members once each (Compare reads many); null when the Folio or the version is not there. */
export async function openVersionMembers(sources: VersionReaderSources, dir: string, id: string): Promise<OpenedVersionMembers | null> {
  const version = await findFolioVersion(sources, dir, id)
  if (!version) return null
  const facts = new Map((await sources.fileVersions()).map((fileVersion) => [fileVersion.id, fileVersion]))
  return { version, facts, members: contentMembers(version), bytesOf: (member) => bytesOfFileVersion(sources, facts, member.versionId) }
}

/**
 * The text of the member of version `id` that carries label `path` (a part, the Index Note, a file not in the outline or an
 * inserted file), exactly as saved; null when the Folio, the version or the member is not there, or the saved text cannot be read.
 */
export async function readMemberAtVersion(sources: VersionReaderSources, dir: string, id: string, path: string): Promise<VersionMemberText | null> {
  const opened = typeof path === 'string' ? await openVersionMembers(sources, dir, id) : null
  const member = opened?.members.find((candidate) => candidate.path === path)
  if (!opened || !member) return null
  const bytes = await opened.bytesOf(member)
  if (bytes === null) return null
  return { role: member.role, path: member.path, ...(member.title !== undefined ? { title: member.title } : {}), ...(member.order !== undefined ? { order: member.order } : {}), bytes, text: utf8(bytes) }
}

/**
 * The text of every member of version `id` that is Markdown text (the Index Note, parts, files not in the outline), once each, in
 * the version's order. A member whose saved text cannot be read is listed with `bytes: null`. Null when the Folio or version is not there.
 */
export async function readTextMembersAtVersion(sources: VersionReaderSources, dir: string, id: string): Promise<Array<Omit<VersionMemberText, 'bytes' | 'text'> & { text: string | null }> | null> {
  const version = await findFolioVersion(sources, dir, id)
  if (!version) return null
  const versions = new Map((await sources.fileVersions()).map((fileVersion) => [fileVersion.id, fileVersion]))
  const members = contentMembers(version).filter((member) => member.role !== 'inserted')
  const out: Array<Omit<VersionMemberText, 'bytes' | 'text'> & { text: string | null }> = []
  for (const member of members) {
    const bytes = await bytesOfFileVersion(sources, versions, member.versionId)
    out.push({ role: member.role, path: member.path, ...(member.title !== undefined ? { title: member.title } : {}), ...(member.order !== undefined ? { order: member.order } : {}), text: bytes === null ? null : utf8(bytes) })
  }
  return out
}

/**
 * Her converted section of the incoming revision `id`, by the heading the version recorded for it; null when the version is
 * not an incoming revision, has no such section, kept no object for it, or the object is missing or does not check out.
 */
export async function readIncomingSection(sources: VersionReaderSources, dir: string, id: string, heading: string): Promise<IncomingSectionText | null> {
  const version = await findFolioVersion(sources, dir, id)
  const section = version?.incoming?.sections.find((candidate) => candidate.heading === heading)
  if (!section?.object || !sources.readFolioObject) return null
  try {
    const bytes = await sources.readFolioObject(section.object)
    if (bytes === null) return null
    return { heading: section.heading, ...(section.part !== undefined ? { part: section.part } : {}), match: section.match, bytes, text: utf8(bytes) }
  } catch {
    return null
  }
}

/**
 * A Folio version opened for reading: what it holds (the tab's own contents read) and the exact saved text of its Index Note,
 * every part and every file not in the outline. Null when the Folio or the version is not there.
 */
export async function readVersionForReading(sources: VersionReaderSources, dir: string, id: string): Promise<FolioVersionReading | null> {
  const members = await readTextMembersAtVersion(sources, dir, id)
  if (members === null) return null
  const contents = await readVersionContents({ ...sources, readSnapshot: async (snapshotId) => (await sources.readSnapshotBytes(snapshotId))?.toString('utf8') ?? null }, dir, id)
  if (contents === null) return null
  const texts: Record<string, string | null> = {}
  let index: string | null = null
  for (const member of members) {
    if (member.role === 'index') index = member.text
    else texts[member.path] = member.text
  }
  return { contents, index, texts }
}
