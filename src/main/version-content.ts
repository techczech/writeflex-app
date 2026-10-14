import type { VersionStore, Version } from './versions'
import type { FileReadResult } from './workspace'

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

export type VersionFileWriter = {
  saveFile(path: string, content: string): Promise<FileReadResult>
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

export async function restoreVersionContent(
  versions: VersionStore,
  restorer: VersionRestorer,
  writer: VersionFileWriter,
  input: VersionContentRequest & { currentContent?: string },
): Promise<FileReadResult | null> {
  const result = await readVersionContent(versions, restorer, input)
  if (!result?.path || result.content === null) return null
  if (typeof input.currentContent === 'string') await writer.saveFile(result.path, input.currentContent)
  await restorer.checkpointFile(result.path)
  const file = await writer.saveFile(result.path, result.content)
  await restorer.checkpointFile(result.path)
  return file
}
