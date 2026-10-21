import type { VersionStore, Version } from './versions'
import type { EditorSaveResult } from './workspace'
import type { SaveBasis } from '../shared/save-basis'

export type VersionContentRequest = {
  id?: string
  versionId?: string
  snapshotId?: string
  path?: string
}

export type SnapshotContentReader = {
  readSnapshotContent(entryId: string): Promise<string | null>
}

export type VersionRestorer = SnapshotContentReader & {
  checkpointFile(path: string): Promise<void>
}

/** Writes that commit only over the version the open buffer was based on (shared/save-basis.ts). */
export type VersionFileWriter = {
  assertOnDisk(path: string, basis: SaveBasis): Promise<void>
  saveFileOver(path: string, content: string, basis: SaveBasis): Promise<EditorSaveResult>
}

export type VersionContentResult = {
  version: Version | null
  path: string | null
  snapshotId: string | null
  content: string | null
}

function matchesRequest(version: Version, input: VersionContentRequest): boolean {
  if (input.id && version.id === input.id) return true
  if (input.versionId && version.versionId === input.versionId) return true
  if (input.snapshotId && version.snapshotId === input.snapshotId) return true
  return false
}

async function resolveVersion(
  versions: VersionStore,
  input: VersionContentRequest,
): Promise<Version | null> {
  const scoped = await versions.list(input.path ? { path: input.path } : undefined)
  return scoped.find((version) => matchesRequest(version, input)) ?? null
}

export async function readVersionContent(
  versions: VersionStore,
  snapshots: SnapshotContentReader,
  input: VersionContentRequest,
): Promise<VersionContentResult | null> {
  const version = await resolveVersion(versions, input)
  const snapshotId = version?.snapshotId ?? input.snapshotId ?? null
  if (!snapshotId) return null
  const content = await snapshots.readSnapshotContent(snapshotId)
  return {
    version,
    path: version?.path ?? input.path ?? null,
    snapshotId,
    content,
  }
}

/**
 * Put a version back as the document. `basis` is the version of the file the open buffer was based on,
 * after the renderer flushed the buffer through its own guarded save (review round 1, Muse M2): the
 * document as the writer has it is on disk then, and the pre-restore checkpoint records it. The restore
 * replaces only that version: another version on disk (an outside change, before or during the
 * checkpoint) stops it with DiskChangedUnderBuffer before anything is written.
 */
export async function restoreVersionContent(
  versions: VersionStore,
  restorer: VersionRestorer,
  writer: VersionFileWriter,
  input: VersionContentRequest & { basis: SaveBasis },
): Promise<EditorSaveResult | null> {
  const result = await readVersionContent(versions, restorer, input)
  if (!result?.path || result.content === null) return null
  await writer.assertOnDisk(result.path, input.basis)
  await restorer.checkpointFile(result.path)
  const file = await writer.saveFileOver(result.path, result.content, input.basis)
  await restorer.checkpointFile(result.path)
  return file
}
