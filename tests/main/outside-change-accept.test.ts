/**
 * Command line and skill, ticket 06. Seam: the Workspace agent's resolve-change operation for a
 * Change that has no live in-app suggestion: one that came from outside, through the inbox. Every
 * Change here is added exactly as the app adds it (`addOutsideRequests`), never hand-built.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, buildE2EScriptedTurn, type ScriptedStep } from '../../src/main/agent'
import { ChangeStore, closedReasonOf, type Change } from '../../src/main/changes'
import { versionTextReader } from '../../src/main/cli/history-store'
import { newRequestId, type WriteRequest } from '../../src/main/cli/request-format'
import { addOutsideRequests, type IngestOutcome } from '../../src/main/outside-change-ingest'
import { saveVersionOfSavedText, snapshotVersionOfSavedText } from '../../src/main/saved-text-version'
import { VersionStore } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'

let root: string
let appData: string
let workspace: Workspace
let changes: ChangeStore
let agent: WorkspaceAgent
let notified: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-outside-root-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-outside-data-'))
  workspace = new Workspace(root)
  changes = new ChangeStore(workspace)
  notified = 0
  agent = await WorkspaceAgent.create({ mode: 'work',
    workspace, appDataDir: appData, changes,
    onChangesChanged: () => { notified += 1 }, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
  })
})
afterEach(async () => {
  agent.dispose()
  for (const dir of [root, appData]) await rm(dir, { recursive: true, force: true })
})

const DOC = '# Draft\n\nThe first sentence stays.\n\nThe second sentence is wordy and long.\n\nThe last sentence ends it.\n'
const write = async (rel: string, text: string): Promise<void> => {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), text)
}
const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')

/** File requests as the inbox would hold them and add them as the app does; returns each outcome. */
async function file(...requests: Array<[string, Record<string, unknown>]>): Promise<IngestOutcome[]> {
  return addOutsideRequests({
    requests: requests.map(([operation, args]) => {
      const id = newRequestId()
      return { id, request: { version: 1, id, operation, args } as WriteRequest }
    }),
    workspace, changes, now: () => new Date(),
  })
}
const changeOf = async (outcome: IngestOutcome): Promise<Change> => {
  if (outcome.kind !== 'filed') throw new Error(`expected a filed request, got ${outcome.kind}${outcome.kind === 'closed' ? `: ${outcome.reason}` : ''}`)
  return (await changes.get(outcome.changes[0].id))!
}
const snapshotsOf = async (rel: string): Promise<string[]> => {
  if (!existsSync(join(root, '.bridle/journal.jsonl'))) return []
  const lines = (await readFile(join(root, '.bridle/journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind?: string; id: string; file?: string; capability?: string })
  const out: string[] = []
  for (const line of lines) {
    if (line.kind === 'snapshot' && line.capability === 'change.accept' && String(line.file).endsWith(`/${rel}`)) out.push((await versionTextReader(root).readSnapshotContent(line.id)) ?? '<absent>')
  }
  return out
}

test('a proposed edit changes nothing until accepted; reject leaves the document as it was; accept snapshots first, then writes', async () => {
  await write('a.md', DOC)
  const [first, second] = await file(
    ['replace', { path: 'a.md', target: 'The second sentence is wordy and long.', with: 'The second sentence is short.', source: 'codex' }],
    ['insert', { path: 'a.md', text: 'An added paragraph.', after: 'The last sentence ends it.' }],
  )
  expect(await read('a.md')).toBe(DOC)
  const rejected = await changeOf(second)
  expect(await agent.resolveChange(rejected.id, 'reject')).toMatchObject({ applied: true })
  expect(await read('a.md')).toBe(DOC)
  expect((await changes.get(rejected.id))?.status).toBe('rejected')
  expect(await snapshotsOf('a.md')).toEqual([])

  const accepted = await changeOf(first)
  expect(await agent.resolveChange(accepted.id, 'accept')).toMatchObject({ applied: true })
  expect(await read('a.md')).toBe(DOC.replace('The second sentence is wordy and long.', 'The second sentence is short.'))
  expect((await changes.get(accepted.id))?.status).toBe('accepted')
  // The text before the accept is in the app's history store, which is what its own undo restores from.
  expect(await snapshotsOf('a.md')).toEqual([DOC])
  expect(notified).toBeGreaterThan(0)
})

test('two edits to one passage are both pending; accepting the first closes the second with a reason, and leaves an unrelated one pending', async () => {
  await write('a.md', DOC)
  const outcomes = await file(
    ['replace', { path: 'a.md', target: 'The second sentence is wordy and long.', with: 'The second sentence is short.' }],
    ['replace', { path: 'a.md', target: 'sentence is wordy and long', with: 'one rambles' }],
    ['replace', { path: 'a.md', target: 'The last sentence ends it.', with: 'The end.' }],
    ['insert', { path: 'a.md', text: 'After the wordy one.', after: 'wordy and long.' }],
  )
  const [first, second, unrelated, insert] = await Promise.all(outcomes.map(changeOf))
  expect([first, second, unrelated, insert].map((change) => change.status)).toEqual(['pending', 'pending', 'pending', 'pending'])
  await changes.setReviewStatus(insert.id, 'held')

  expect(await agent.resolveChange(first.id, 'accept')).toMatchObject({ applied: true })
  const closed = (await changes.get(second.id))!
  expect(closed.status).toBe('rejected')
  expect(closedReasonOf(closed)).toContain('Another change to a.md was accepted first')
  expect(closedReasonOf(closed)).toContain('no longer in a.md')
  // A held insert whose anchor went with the accepted edit is closed too; the unrelated edit is untouched.
  expect(closedReasonOf((await changes.get(insert.id))!)).toContain('accepted first')
  expect((await changes.get(unrelated.id))?.status).toBe('pending')
  // Closed is final: a later Accept reports the reason and writes nothing.
  const before = await read('a.md')
  expect(await agent.resolveChange(second.id, 'accept')).toMatchObject({ applied: false, closed: true })
  expect(await read('a.md')).toBe(before)
  expect(await agent.resolveChange(unrelated.id, 'accept')).toMatchObject({ applied: true })
  expect(await read('a.md')).toContain('The end.')
})

test('an edit filed for a file the app then renames follows the rename; one whose file moved without the app closes with a reason', async () => {
  await write('talks/a.md', DOC)
  await write('talks/b.md', DOC)
  const [followed, left] = await Promise.all((await file(
    ['replace', { path: 'talks/a.md', target: 'The last sentence ends it.', with: 'Renamed and changed.' }],
    ['replace', { path: 'talks/b.md', target: 'The last sentence ends it.', with: 'Never placed.' }],
  )).map(changeOf))
  // The app renames a.md (and tells the ledger); something else renames b.md behind its back.
  await workspace.renameFile('talks/a.md', 'talks/a-2026.md')
  expect(await changes.followRename('talks/a.md', 'talks/a-2026.md')).toBe(1)
  await rename(join(root, 'talks/b.md'), join(root, 'talks/b-moved.md'))
  expect((await changes.get(followed.id))?.path).toBe('talks/a-2026.md')
  expect(await agent.resolveChange(followed.id, 'accept')).toMatchObject({ applied: true })
  expect(await read('talks/a-2026.md')).toContain('Renamed and changed.')
  expect(existsSync(join(root, 'talks/a.md'))).toBe(false)

  expect(await agent.resolveChange(left.id, 'accept')).toMatchObject({ applied: false, closed: true })
  expect(closedReasonOf((await changes.get(left.id))!)).toContain('no longer exists')
  expect(await read('talks/b-moved.md')).toBe(DOC)

  // A folder rename carries every undecided outside Change under it; decided ones and other Changes stay.
  await write('old/c.md', DOC)
  const [inFolder] = await Promise.all((await file(['insert', { path: 'old/c.md', text: 'More.' }])).map(changeOf))
  const writers = await changes.add({ path: 'old/c.md', provenance: 'writer', editClass: 'content', summary: 'w', oldText: 'a', newText: 'b', isCorrection: false })
  await workspace.renameFolder('old', 'new')
  expect(await changes.followRename('old', 'new')).toBe(1)
  expect((await changes.get(inFolder.id))?.path).toBe('new/c.md')
  expect((await changes.get(writers.id))?.path).toBe('old/c.md')
  expect((await changes.get(followed.id))?.path).toBe('talks/a-2026.md')
})

test('a move is placed by its text when accepted, not by the positions found when it was added', async () => {
  await write('m.md', 'One.\n\nTwo.\n\nThree.\n')
  const [move, stale] = await Promise.all((await file(
    ['move-text', { path: 'm.md', text: 'One.', after: 'Three.' }],
    ['move-text', { path: 'm.md', text: 'Two.', after: 'Three.' }],
  )).map(changeOf))
  expect(move).toMatchObject({ editClass: 'move', moveFrom: { from: 0, to: 4 }, outsideMoveAfter: 'Three.' })
  // The writer adds a paragraph at the top: every recorded position is now wrong.
  await write('m.md', 'A new opening paragraph.\n\nOne.\n\nTwo.\n\nThree.\n')
  expect(await agent.resolveChange(move.id, 'accept')).toMatchObject({ applied: true })
  expect(await read('m.md')).toBe('A new opening paragraph.\n\nTwo.\n\nThree.\n\nOne.\n')
  // And a move whose passage has gone is never placed at a stale position: refused, it waits (ticket 14).
  await write('m.md', 'A new opening paragraph.\n\nThree.\n\nOne.\n')
  expect(await agent.resolveChange(stale.id, 'accept')).toEqual({ applied: false, message: expect.stringMatching(/not found/) })
  expect(await read('m.md')).toBe('A new opening paragraph.\n\nThree.\n\nOne.\n')
  expect((await changes.get(stale.id))?.status).toBe('pending')
  expect(closedReasonOf((await changes.get(stale.id))!)).toBeNull()
})

test('restoring a version arrives as one pending Change; accept restores the whole document; a document changed since closes it', async () => {
  const original = '# Talk\n\nThe text as it was sent.\n'
  await write('talk.md', original)
  const { SnapshotStore } = await import('@bridle/core')
  const history = await SnapshotStore.open({ dir: join(root, '.bridle') })
  const saved = await saveVersionOfSavedText({
    workspace, versions: new VersionStore(workspace), changes, confirmOwner: async () => {}, author: { name: 'Writer' },
    snapshot: (path) => snapshotVersionOfSavedText({ workspace, snapshots: history, sessionId: 'test', path }),
  }, { path: 'talk.md', name: 'As sent' })
  const rewritten = '# Talk\n\nA rewrite that went wrong.\n\nWith another paragraph.\n'
  await write('talk.md', rewritten)

  const outcomes = await file(
    ['restore-version', { path: 'talk.md', version: saved.record.id, source: 'claude-code' }],
    ['restore-version', { path: 'talk.md', version: saved.record.id }],
  )
  const [restore, second] = await Promise.all(outcomes.map(changeOf))
  expect(await changes.list({ path: 'talk.md', status: 'pending' })).toHaveLength(2)
  expect(restore).toMatchObject({ editClass: 'content', oldText: rewritten, newText: original, summary: 'Restore version “As sent” of talk.md', author: { name: 'Claude Code' } })
  expect(await read('talk.md')).toBe(rewritten)
  expect(await agent.resolveChange(restore.id, 'accept')).toMatchObject({ applied: true })
  expect(await read('talk.md')).toBe(original)
  expect(await snapshotsOf('talk.md')).toEqual([rewritten])
  // The second restore was over the rewritten text, which is gone: closed when the first was accepted.
  expect(closedReasonOf((await changes.get(second.id))!)).toContain('accepted first')

  // Refused at validation: no such version, a version of another document, nothing to restore.
  await write('other.md', '# Other\n')
  const refused = await file(
    ['restore-version', { path: 'talk.md', version: 'v_nope' }],
    ['restore-version', { path: 'other.md', version: saved.record.id }],
    ['restore-version', { path: 'talk.md', version: saved.record.id }],
  )
  expect(refused.map((outcome) => (outcome.kind === 'closed' ? outcome.reason : outcome.kind))).toEqual([
    expect.stringContaining('has no saved version'), expect.stringContaining('has no saved version'), expect.stringContaining('already reads that way'),
  ])
  expect(await read('talk.md')).toBe(original)
})

test('a Change whose file was put in the Trash, or became a dot-folder path, closes at accept with the reason and writes nothing', async () => {
  await write('gone.md', DOC)
  const [trashed] = await Promise.all((await file(['replace', { path: 'gone.md', target: 'The last sentence ends it.', with: 'x' }])).map(changeOf))
  await rm(join(root, 'gone.md'))
  expect(await agent.resolveChange(trashed.id, 'accept')).toMatchObject({ applied: false, closed: true })
  expect(closedReasonOf((await changes.get(trashed.id))!)).toContain('no longer exists')
  expect(existsSync(join(root, 'gone.md'))).toBe(false)
  expect(await snapshotsOf('gone.md')).toEqual([])
})

test('a rename made by the in-app agent\'s own rename capability carries an undecided outside Change with it', async () => {
  await write('talks/a.md', DOC)
  const [change] = await Promise.all((await file(['replace', { path: 'talks/a.md', target: 'The last sentence ends it.', with: 'Renamed by the agent, then changed.' }])).map(changeOf))
  agent.dispose()
  const step: ScriptedStep = { cap: 'housekeeping.rename_file', input: { path: 'talks/a.md', newPath: 'talks/a-2026.md' } }
  const before = notified
  const ownData = await mkdtemp(join(appData, 'rename-'))
  agent = await WorkspaceAgent.create({ mode: 'work',
    workspace, appDataDir: ownData, changes,
    onChangesChanged: () => { notified += 1 }, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([buildE2EScriptedTurn([step])]),
  })
  await agent.runScriptedTurn('Rename it', [step])
  expect(existsSync(join(root, 'talks/a-2026.md'))).toBe(true)
  expect((await changes.get(change.id))?.path).toBe('talks/a-2026.md')
  expect(notified).toBeGreaterThan(before)
  expect(await agent.resolveChange(change.id, 'accept')).toMatchObject({ applied: true })
  expect(await read('talks/a-2026.md')).toContain('Renamed by the agent, then changed.')
})
