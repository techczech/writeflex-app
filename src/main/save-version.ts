import type { WorkspaceAgent, VersionSnapshotResult } from './agent'
import type { ChangeStore, ChangeStatus } from './changes'
import type { VersionStore, AuthorIdentity, Version } from './versions'
import type { Workspace } from './workspace'

export type SaveNamedVersionInput = {
  path: string
  name: string
  note?: string
  changeIds: string[]
  changes: ChangeStore
  versions: VersionStore
  agent: WorkspaceAgent
  author: AuthorIdentity
}

export type SaveNamedVersionResult = VersionSnapshotResult & {
  record: Version
  accepted: number
  rejected: number
  pending: number
  corpusEntries: number
}

export type SaveInitialVersionOnCloseInput = {
  path: string
  workspace: Workspace
  agent: WorkspaceAgent
  versions: VersionStore
  author: AuthorIdentity
}

/**
 * ADR-0031's one automatic tier-3 record. The VersionStore serialises the no-existing-version check
 * with the append, while this callback checks the settled on-disk text and takes the same snapshot
 * shape as any manually named version. The record therefore appears in the spine and Compare without
 * a second representation.
 */
export async function saveInitialVersionOnClose(
  input: SaveInitialVersionOnCloseInput,
): Promise<Version | null> {
  return input.versions.appendFirstForPath(input.path, async () => {
    const { content } = await input.workspace.readFile(input.path)
    if (content.trim() === '') return null
    const snapshot = await input.agent.snapshotReviewVersion(input.path)
    return {
      name: 'Initial version',
      author: input.author,
      snapshotId: snapshot.snapshotId,
      versionId: snapshot.versionId,
    }
  })
}

export async function saveNamedVersion(input: SaveNamedVersionInput): Promise<SaveNamedVersionResult> {
  const name = input.name.trim()
  if (name === '') throw new Error('Version name is required.')
  const ids = Array.from(new Set(input.changeIds))
  const all = ids.length > 0 ? await input.changes.list({ path: input.path }) : []
  const run = ids
    .map((id) => {
      const change = all.find((c) => c.id === id)
      if (!change) throw new Error(`No change with id ${id}.`)
      return change
    })
    .filter((change) => !change.snapshotId)

  const accepted = run.filter((change) =>
    change.status === 'accepted' ||
    (change.status === 'pending' && (change.provenance === 'writer' || change.editClass === 'copy')),
  )
  const rejected = run.filter((change) => change.status === 'rejected')
  const pending = run.filter((change) =>
    change.status === 'held' ||
    (change.status === 'pending' && change.provenance !== 'writer' && change.editClass !== 'copy'),
  )
  await input.agent.applyAcceptedChangesForVersion(accepted.map((change) => change.id))
  const version = await input.agent.snapshotReviewVersion(input.path)
  const statusById: Record<string, ChangeStatus> = {}
  for (const change of accepted) statusById[change.id] = 'accepted'
  for (const change of rejected) statusById[change.id] = 'rejected'
  if (run.length > 0) await input.changes.saveVersion(run.map((change) => change.id), version.versionId, statusById)
  const record = await input.versions.append({
    path: input.path,
    name,
    author: input.author,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    snapshotId: version.snapshotId,
    versionId: version.versionId,
  })
  return {
    ...version,
    record,
    accepted: accepted.length,
    rejected: rejected.length,
    pending: pending.length,
    corpusEntries: accepted.filter((change) => change.provenance === 'writer' && change.isCorrection).length,
  }
}
