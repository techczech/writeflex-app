import { beforeEach, afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { WorkspaceAgent } from '../../src/main/agent'
import { ChangeStore } from '../../src/main/changes'
import { VersionStore } from '../../src/main/versions'
import { saveInitialVersionOnClose, saveNamedVersion } from '../../src/main/save-version'

let root: string
let appData: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-save-version-root-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-save-version-data-'))
  await writeFile(join(root, 'draft.md'), '# Draft\n\nCurrent text.\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

async function harness(): Promise<{
  workspace: Workspace
  agent: WorkspaceAgent
  changes: ChangeStore
  versions: VersionStore
}> {
  const workspace = new Workspace(root)
  const changes = new ChangeStore(workspace)
  const versions = new VersionStore(workspace)
  const agent = await WorkspaceAgent.create({ mode: 'work',
    workspace,
    appDataDir: appData,
    changes,
    onChangesChanged: () => {},
    onTrace: () => {},
    onApprovalRequest: () => {},
    onSuggestionsChanged: () => {},
  })
  return { workspace, agent, changes, versions }
}

test('first close of a non-empty document with no versions creates one comparable Initial version', async () => {
  const { workspace, agent, versions } = await harness()

  const record = await saveInitialVersionOnClose({
    path: 'draft.md',
    workspace,
    agent,
    versions,
    author: { name: 'Dominik' },
  })

  expect(record?.name).toBe('Initial version')
  expect(record?.snapshotId).toBeTruthy()
  expect(record?.versionId).toBeTruthy()
  expect(await agent.readSnapshotContent(record!.snapshotId!)).toBe('# Draft\n\nCurrent text.\n')
  expect(await versions.list({ path: 'draft.md' })).toEqual([record!])
  agent.dispose()
})

test('second close creates no additional automatic version', async () => {
  const { workspace, agent, versions } = await harness()
  const input = {
    path: 'draft.md',
    workspace,
    agent,
    versions,
    author: { name: 'Dominik' },
  }

  expect(await saveInitialVersionOnClose(input)).not.toBeNull()
  expect(await saveInitialVersionOnClose(input)).toBeNull()
  expect((await versions.list({ path: 'draft.md' })).map((version) => version.name)).toEqual(['Initial version'])
  agent.dispose()
})

test('a document that already has a named version gets no automatic Initial version', async () => {
  const { workspace, agent, changes, versions } = await harness()
  await saveNamedVersion({
    path: 'draft.md',
    name: 'Writer named this',
    changeIds: [],
    changes,
    versions,
    agent,
    author: { name: 'Dominik' },
  })
  expect(await saveInitialVersionOnClose({
    path: 'draft.md',
    workspace,
    agent,
    versions,
    author: { name: 'Dominik' },
  })).toBeNull()
  expect((await versions.list({ path: 'draft.md' })).map((version) => version.name)).toEqual(['Writer named this'])
  agent.dispose()
})

test('closing an empty document creates no automatic version', async () => {
  await writeFile(join(root, 'draft.md'), ' \n\t')
  const { workspace, agent, versions } = await harness()

  expect(await saveInitialVersionOnClose({
    path: 'draft.md',
    workspace,
    agent,
    versions,
    author: { name: 'Dominik' },
  })).toBeNull()
  expect(await versions.list({ path: 'draft.md' })).toEqual([])
  agent.dispose()
})

test('naming a version with no changes still writes a snapshot and Version record', async () => {
  const { workspace, agent, changes, versions } = await harness()

  const result = await saveNamedVersion({
    path: 'draft.md',
    name: 'Manual checkpoint',
    changeIds: [],
    changes,
    versions,
    agent,
    author: { name: 'Dominik' },
  })

  expect(result.record.name).toBe('Manual checkpoint')
  expect(result.snapshotId).toBeTruthy()
  expect(result.accepted).toBe(0)
  expect(result.pending).toBe(0)
  expect(await agent.readSnapshotContent(result.snapshotId)).toBe('# Draft\n\nCurrent text.\n')
  expect((await versions.list({ path: 'draft.md' })).map((v) => v.id)).toEqual([result.record.id])
  expect((await changes.list({ path: 'draft.md' }))).toEqual([])
  expect((await workspace.readFile('draft.md')).content).toBe('# Draft\n\nCurrent text.\n')
  agent.dispose()
})

test('naming a version stamps decided accepted changes but leaves undecided changes pending', async () => {
  const { agent, changes, versions } = await harness()
  const accepted = await changes.add({
    path: 'draft.md',
    provenance: 'agent',
    editClass: 'copy',
    category: 'wording',
    summary: 'Tighten',
    oldText: 'Current',
    newText: 'Saved',
    status: 'accepted',
    isCorrection: false,
  })
  const undecided = await changes.add({
    path: 'draft.md',
    provenance: 'agent',
    editClass: 'content',
    category: 'clarity',
    summary: 'Pending',
    oldText: 'text',
    newText: 'document',
    isCorrection: false,
  })

  const result = await saveNamedVersion({
    path: 'draft.md',
    name: 'Accepted only',
    changeIds: [accepted.id, undecided.id],
    changes,
    versions,
    agent,
    author: { name: 'Dominik' },
  })

  expect(result.accepted).toBe(1)
  expect(result.pending).toBe(1)
  expect((await changes.get(accepted.id))?.versionId).toBe(result.versionId)
  expect((await changes.get(undecided.id))?.status).toBe('pending')
  expect((await changes.get(undecided.id))?.versionId).toBeUndefined()
  agent.dispose()
})

test('naming a version folds pending writer changes into the version', async () => {
  const { agent, changes, versions } = await harness()
  const writer = await changes.add({
    path: 'draft.md',
    provenance: 'writer',
    author: { name: 'Dominik' },
    editClass: 'content',
    category: 'wording',
    summary: 'Your edit',
    oldText: 'Current',
    newText: 'Reworked',
    isCorrection: false,
  })

  const result = await saveNamedVersion({
    path: 'draft.md',
    name: 'Writer edits',
    changeIds: [writer.id],
    changes,
    versions,
    agent,
    author: { name: 'Dominik' },
  })

  const folded = await changes.get(writer.id)
  expect(result.accepted).toBe(1)
  expect(result.pending).toBe(0)
  expect(folded?.status).toBe('accepted')
  expect(folded?.versionId).toBe(result.versionId)
  agent.dispose()
})

test('naming a version folds quiet copy edits but carries held changes forward', async () => {
  const { agent, changes, versions } = await harness()
  const quiet = await changes.add({
    path: 'draft.md',
    provenance: 'agent',
    editClass: 'copy',
    category: 'typo',
    summary: 'Typo',
    oldText: 'Current text.',
    newText: 'Current text.',
    isCorrection: false,
  })
  const held = await changes.add({
    path: 'draft.md',
    provenance: 'agent',
    editClass: 'content',
    category: 'wording',
    summary: 'Workshop wording',
    oldText: 'plain',
    newText: 'careful',
    status: 'held',
    isCorrection: false,
  })

  const result = await saveNamedVersion({
    path: 'draft.md',
    name: 'Quiet plus held',
    changeIds: [quiet.id, held.id],
    changes,
    versions,
    agent,
    author: { name: 'Dominik' },
  })

  const settledQuiet = await changes.get(quiet.id)
  const carriedHeld = await changes.get(held.id)
  expect(result.accepted).toBe(1)
  expect(result.pending).toBe(1)
  expect(settledQuiet?.status).toBe('accepted')
  expect(settledQuiet?.versionId).toBe(result.versionId)
  expect(carriedHeld?.status).toBe('held')
  expect(carriedHeld?.versionId).toBeUndefined()
  agent.dispose()
})

test('an editor declaration set aside by the Folio rule still saves a comparable version', async () => {
  const { mkdir } = await import('node:fs/promises')
  const { folioDeclaration } = await import('../../src/main/folio-declaration')
  const { workspace, agent, versions } = await harness()
  try {
    await mkdir(join(root, 'book/ch'), { recursive: true })
    await writeFile(join(root, 'book/_book_INDEX.md'), '## Running order\n')
    const path = 'book/ch/_ch_INDEX.md'
    await writeFile(join(root, path), '# Cover\n')
    const text = '# Chapter\n\n## Running order\n'
    await workspace.saveEditorText(path, text, { kind: 'disk', text: '# Cover\n' })
    expect(folioDeclaration(workspace, 'book/ch').isFolio).toBe(false)
    const record = await saveInitialVersionOnClose({ path, workspace, agent, versions, author: { name: 'Writer' } })
    expect(record?.snapshotId).toBeTruthy()
    expect(await agent.readSnapshotContent(record!.snapshotId!)).toBe(text)
    expect((await versions.list({ path }))[0].id).toBe(record!.id)
  } finally { agent.dispose() }
})
