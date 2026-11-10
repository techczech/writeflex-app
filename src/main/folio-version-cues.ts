/**
 * What the change cues and the cursor panel read (Folio versions ticket 06): which parts and inserted files of a Folio changed
 * since its last Folio version, and the facts about the part or inserted file under the cursor. READ ONLY: nothing here appends
 * a line, makes a folder or writes a file, so a Collection with no Folio journal is never given one.
 *
 * "Changed" is the save's own test: the SHA-256 of the file as it stands against the SHA-256 of the saved copy the version points
 * at (`snapshotHashesOf`, one read of the history journal). A file is matched to the version's member by where it is now: a member's
 * per-file version carries the path its history followed to (`readMovedVersions`), so a part moved or renamed since the save is
 * still the same member.
 *
 * Electron-free.
 */
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import {
  cellsDiffering, changedSinceVersion, countChanges, cuesFrom, insertedKind, partHistory,
  type CursorInsertedFacts, type CursorInsertedUse, type CursorPartFacts, type FolioCues, type FolioCursorFacts, type SavedMember, type WorkingMember,
} from '../shared/folio-version-changes'
import type { FolioMember } from '../shared/folio-version-records'
import { indexNotePath } from './folio'
import { folioDeclaration } from './folio-declaration'
import { FolioGatherRefused, gatherFolio } from './folio-version-members'
import { FOLIO_INSERTED_FILE_CAP_BYTES } from './folio-version-preview'
import type { FileVersionFacts } from './folio-versions-tab'
import type { FolioVersionStore, ListedFolioVersion } from './folio-versions'
import { localTarget } from './folio-version-members'
import type { Workspace } from './workspace'

export type CueSources = {
  workspace: Workspace
  folioVersions: Pick<FolioVersionStore, 'list'>
  /** Every per-file version with the path its history is at now; never written. */
  fileVersions: () => FileVersionFacts[] | Promise<FileVersionFacts[]>
  /** The SHA-256 each snapshot holds, from one read of the journal. */
  snapshotHashes: (snapshotIds: readonly string[]) => Promise<Map<string, string>>
  /** The saved text of a per-file version's snapshot; null when it is not there. */
  readSnapshot: (snapshotId: string) => Promise<string | null>
  /** The file's bytes as the app reads a document (no final link followed). */
  readBytes: (path: string) => Promise<Buffer>
}

type ContentMember = Exclude<FolioMember, { role: 'reference' }>
type ResolvedMember = { role: ContentMember['role']; path: string; fileVersionId: string; title?: string }

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** The newest version that is the writer's own: not withdrawn, not a co-author's revision. Null when there is none. */
export function cueVersion(versions: readonly ListedFolioVersion[]): ListedFolioVersion | null {
  return versions.find((version) => !version.withdrawn && !version.incoming) ?? null
}

/** A version's members at the paths their files are at now. */
function resolve(version: ListedFolioVersion, fileVersions: ReadonlyMap<string, FileVersionFacts>): ResolvedMember[] {
  return version.members.flatMap((member) => {
    if (member.role === 'reference') return []
    const moved = fileVersions.get(member.versionId)?.path
    return [{ role: member.role, path: moved ?? member.path, fileVersionId: member.versionId, ...(member.title !== undefined ? { title: member.title } : {}) }]
  })
}

async function workingHash(sources: CueSources, path: string, role: ContentMember['role']): Promise<string | null> {
  try {
    if (role === 'inserted') {
      const info = await lstat(sources.workspace.absolute(path))
      if (!info.isFile() || info.size > FOLIO_INSERTED_FILE_CAP_BYTES) return null
    }
    return sha256(await sources.readBytes(path))
  } catch {
    return null
  }
}

type Situation = {
  versions: ListedFolioVersion[]
  since: ListedFolioVersion
  fileVersions: Map<string, FileVersionFacts>
  gathered: Awaited<ReturnType<typeof gatherFolio>>
}

/** The Folio's versions and files, or null when there is nothing to cue: not a Folio, no version of the writer's own, or a Folio that cannot be gathered as it stands. */
async function situation(sources: CueSources, dir: string): Promise<Situation | null> {
  try {
    if (!folioDeclaration(sources.workspace, dir).isFolio) return null
    const versions = await sources.folioVersions.list(indexNotePath(sources.workspace, dir))
    const since = cueVersion(versions)
    if (since === null) return null
    const gathered = await gatherFolio(sources.workspace, dir)
    const fileVersions = new Map((await sources.fileVersions()).map((fileVersion) => [fileVersion.id, fileVersion]))
    return { versions, since, fileVersions, gathered }
  } catch (error) {
    if (error instanceof FolioGatherRefused) return null
    return null
  }
}

/** The change cues of the Folio at `dir`: `none` when there is no Folio version to compare with. */
export async function readFolioCues(sources: CueSources, dir: string): Promise<FolioCues> {
  const held = await situation(sources, dir)
  if (held === null) return { state: 'none' }
  const { since, fileVersions, gathered } = held
  const savedMembers = resolve(since, fileVersions)
  const snapshotIds = savedMembers.flatMap((member) => { const id = fileVersions.get(member.fileVersionId)?.snapshotId; return id ? [id] : [] })
  const hashes = await sources.snapshotHashes(snapshotIds).catch(() => new Map<string, string>())
  const saved: SavedMember[] = savedMembers.map((member) => {
    const snapshotId = fileVersions.get(member.fileVersionId)?.snapshotId
    return { role: member.role, path: member.path, hash: snapshotId ? hashes.get(snapshotId) ?? null : null }
  })
  const working: WorkingMember[] = []
  for (const file of gathered.files) {
    if (file.role === 'linked') continue
    working.push({ role: file.role, path: file.path, hash: await workingHash(sources, file.path, file.role), ...(file.role === 'inserted' ? { insertedBy: gathered.insertedBy[file.path] ?? [] } : {}) })
  }
  return cuesFrom(dir, { id: since.id, name: since.name, ts: since.ts }, changedSinceVersion(saved, working))
}

/** The 1-based number of a per-file version among its file's versions that hold a copy, oldest first (the sheet's "v2"). */
function fileVersionNumber(fileVersions: ReadonlyMap<string, FileVersionFacts>, id: string): number {
  const own = fileVersions.get(id)
  if (!own) return 0
  const same = [...fileVersions.values()].filter((entry) => entry.path === own.path && entry.snapshotId !== undefined).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  return same.findIndex((entry) => entry.id === id) + 1
}

/**
 * The facts for the right rail's Versions tab: the part the writer is in (`path`) and the file the cursor's line inserts
 * (`embed`, as written in the text, resolved from `path`). Null when the Folio has no Folio version of the writer's own.
 */
export async function readCursorFacts(sources: CueSources, dir: string, path: string | null, embed: string | null): Promise<FolioCursorFacts | null> {
  const held = await situation(sources, dir)
  if (held === null) return null
  const { versions, since, fileVersions, gathered } = held
  const stamp = { id: since.id, name: since.name, ts: since.ts }
  const resolved = versions.filter((version) => !version.withdrawn).map((version) => ({ version, members: resolve(version, fileVersions) }))

  let part: CursorPartFacts | null = null
  const here = path === null ? undefined : gathered.files.find((file) => file.path === path && (file.role === 'part' || file.role === 'unlisted'))
  if (path !== null && here) {
    const entries = resolved.flatMap(({ version, members }) => {
      const member = members.find((candidate) => candidate.path === path && candidate.role !== 'inserted')
      return member ? [{ id: version.id, name: version.name, ts: version.ts, fileVersionId: member.fileVersionId }] : []
    })
    const history = partHistory(entries)
    let changesSince: number | null = null
    const savedMember = resolve(since, fileVersions).find((candidate) => candidate.path === path && candidate.role !== 'inserted')
    const snapshotId = savedMember ? fileVersions.get(savedMember.fileVersionId)?.snapshotId : undefined
    if (snapshotId) {
      try {
        const before = await sources.readSnapshot(snapshotId)
        if (before !== null) changesSince = countChanges(before, (await sources.readBytes(path)).toString('utf8'))
      } catch { changesSince = null }
    }
    const own = [...fileVersions.values()].filter((entry) => entry.path === path && entry.snapshotId !== undefined).sort((a, b) => b.ts - a.ts)[0]
    part = {
      path, title: here.title ?? path.split('/').pop() ?? path,
      versionCount: history.count, lastChanged: history.lastChanged ? { name: history.lastChanged.name, ts: history.lastChanged.ts } : null,
      changesSince, latestFileVersion: own ? { id: own.id, name: own.name, ts: own.ts } : null,
    }
  }

  let inserted: CursorInsertedFacts | null = null
  const target = path !== null && embed !== null ? localTarget(path, embed) : null
  if (target !== null && gathered.files.some((file) => file.role === 'inserted' && file.path === target)) {
    inserted = await insertedFacts(sources, target, resolved, since, fileVersions)
  }
  return { since: stamp, part, inserted }
}

async function insertedFacts(sources: CueSources, path: string, resolved: Array<{ version: ListedFolioVersion; members: ResolvedMember[] }>, since: ListedFolioVersion, fileVersions: ReadonlyMap<string, FileVersionFacts>): Promise<CursorInsertedFacts> {
  const kind = insertedKind(path)
  // Each per-file version the Folio versions used, newest Folio version first, with the Folio versions that used it.
  const used = new Map<string, CursorInsertedUse>()
  for (const { version, members } of resolved) {
    const member = members.find((candidate) => candidate.path === path && candidate.role === 'inserted')
    if (!member) continue
    const own = fileVersions.get(member.fileVersionId)
    const entry = used.get(member.fileVersionId) ?? { number: fileVersionNumber(fileVersions, member.fileVersionId), name: own?.name ?? 'Version', ts: own?.ts ?? version.ts, usedBy: [] }
    entry.usedBy.push({ id: version.id, name: version.name })
    used.set(member.fileVersionId, entry)
  }
  const uses = [...used.values()]
  const latestMember = resolve(since, fileVersions).find((candidate) => candidate.path === path && candidate.role === 'inserted')
  const latestFile = latestMember ? fileVersions.get(latestMember.fileVersionId) : undefined
  const latest = latestMember && latestFile ? { number: fileVersionNumber(fileVersions, latestMember.fileVersionId), name: latestFile.name, id: latestFile.id } : null
  const base: Omit<CursorInsertedFacts, 'state' | 'cellsChanged'> = { path, kind, latest, uses }
  if (!latestMember) return { ...base, state: 'new', cellsChanged: null }
  const working = await workingHash(sources, path, 'inserted')
  const snapshotId = latestFile?.snapshotId
  const savedHash = snapshotId ? (await sources.snapshotHashes([snapshotId]).catch(() => new Map<string, string>())).get(snapshotId) ?? null : null
  if (working === null || savedHash === null) return { ...base, state: 'unknown', cellsChanged: null }
  if (working === savedHash) return { ...base, state: 'unchanged', cellsChanged: 0 }
  let cellsChanged: number | null = null
  if (kind === 'table' && snapshotId) {
    try {
      const before = await sources.readSnapshot(snapshotId)
      if (before !== null) cellsChanged = cellsDiffering(before, (await sources.readBytes(path)).toString('utf8'), path)
    } catch { cellsChanged = null }
  }
  return { ...base, state: 'changed', cellsChanged }
}
