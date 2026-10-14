import type { ChangeStore } from './changes'
import type { VersionStore } from './versions'
import type { SnapshotContentReader } from './version-content'
import type { Workspace } from './workspace'
import {
  WORKING_VERSION_ID,
  compareVersionContents,
  type AuthorIdentity,
  type Version,
  type VersionCompareEndpointId,
  type VersionCompareResult,
} from '../engine'

export type VersionCompareRequest = {
  path: string
  fromId: VersionCompareEndpointId
  toId: VersionCompareEndpointId
  currentContent?: string
}

function findVersion(versions: readonly Version[], id: VersionCompareEndpointId): Version | null {
  if (id === WORKING_VERSION_ID) return null
  return versions.find((version) => version.id === id || version.versionId === id) ?? null
}

async function endpointContent(input: {
  versions: readonly Version[]
  snapshots: SnapshotContentReader
  workspace: Workspace
  path: string
  id: VersionCompareEndpointId
  currentContent?: string
}): Promise<string> {
  if (input.id === WORKING_VERSION_ID) {
    if (typeof input.currentContent === 'string') return input.currentContent
    return (await input.workspace.readFile(input.path)).content
  }
  const version = findVersion(input.versions, input.id)
  if (!version) throw new Error(`No version with id ${input.id}.`)
  if (!version.snapshotId) throw new Error(`Version "${version.name}" has no document snapshot.`)
  const content = await input.snapshots.readSnapshotContent(version.snapshotId)
  if (content === null) throw new Error(`Could not read "${version.name}" from history.`)
  return content
}

export async function compareVersionRange(
  versions: VersionStore,
  changes: ChangeStore,
  snapshots: SnapshotContentReader,
  workspace: Workspace,
  input: VersionCompareRequest,
  workingAuthor?: AuthorIdentity,
): Promise<VersionCompareResult> {
  const [versionList, changeList] = await Promise.all([
    versions.list({ path: input.path }),
    changes.list({ path: input.path }),
  ])
  const [fromContent, toContent] = await Promise.all([
    endpointContent({ versions: versionList, snapshots, workspace, path: input.path, id: input.fromId, currentContent: input.currentContent }),
    endpointContent({ versions: versionList, snapshots, workspace, path: input.path, id: input.toId, currentContent: input.currentContent }),
  ])
  return compareVersionContents({
    versions: versionList,
    changes: changeList,
    path: input.path,
    fromId: input.fromId,
    toId: input.toId,
    fromContent,
    toContent,
    ...(workingAuthor ? { workingAuthor } : {}),
  })
}
