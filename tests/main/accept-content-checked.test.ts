/**
 * Review parcel P3 (R2.3 to R2.6): accept is a content-checked transaction. Seam: the Workspace
 * agent's resolve-change operation over Changes added exactly as the app adds them
 * (`addOutsideRequests`) or staged by a scripted agent turn. A document "changing under" an accept is
 * done through `documentSaveSeams.betweenCheckAndWrite`, which runs inside the save, after the read
 * the new text was worked out from. No test here waits on a clock.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { ChangeStore, closedCodeOf, closedReasonOf, isWholeDocumentChange, type Change } from '../../src/main/changes'
import { newRequestId, type WriteRequest } from '../../src/main/cli/request-format'
import { documentSaveSeams } from '../../src/main/guarded-document-write'
import { addOutsideRequests, type IngestOutcome } from '../../src/main/outside-change-ingest'
import { saveVersionOfSavedText, snapshotVersionOfSavedText } from '../../src/main/saved-text-version'
import { resolveOutsideInsert, resolveProseInsert } from '../../src/main/verbs/verb-support'
import { VersionStore } from '../../src/main/versions'
import { Workspace, documentChangedMessage } from '../../src/main/workspace'

let root: string
let appData: string
let workspace: Workspace
let changes: ChangeStore
let agent: WorkspaceAgent
/** Resolves each time the agent says the ledger changed: the handshake for "the staged Change is in the ledger". */
let ledgerChanged: () => void = () => {}

async function makeAgent(script?: { text: string; steps: ScriptedStep[] }): Promise<WorkspaceAgent> {
  return WorkspaceAgent.create({ mode: 'work',
    workspace, appDataDir: appData, changes,
    onChangesChanged: () => ledgerChanged(), onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    ...(script ? { sessionFactory: scriptedSessionFactory([{
      prompt: script.text,
      rounds: [
        { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: script.steps.map((step) => step.cap) } }] },
        { kind: 'tool-calls', calls: script.steps.map((step) => ({ name: step.cap, arguments: step.input as Record<string, unknown> })) },
        { kind: 'message', text: 'Scripted turn complete.' },
      ],
    }]) } : {}),
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-accept-root-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-accept-data-'))
  workspace = new Workspace(root)
  changes = new ChangeStore(workspace)
  ledgerChanged = () => {}
})
afterEach(async () => {
  delete documentSaveSeams.betweenCheckAndWrite
  agent?.dispose()
  for (const dir of [root, appData]) await rm(dir, { recursive: true, force: true })
})

const DOC = '# Draft\n\nThe first sentence stays.\n\nThe second sentence is wordy and long.\n\nThe last sentence ends it.\n'
const write = async (rel: string, text: string): Promise<void> => {
  await mkdir(dirname(join(root, rel)), { recursive: true })
  await writeFile(join(root, rel), text)
}
const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')

async function file(...requests: Array<[string, Record<string, unknown>]>): Promise<Change[]> {
  const outcomes: IngestOutcome[] = await addOutsideRequests({
    requests: requests.map(([operation, args]) => {
      const id = newRequestId()
      return { id, request: { version: 1, id, operation, args } as WriteRequest }
    }),
    workspace, changes, now: () => new Date(),
  })
  return Promise.all(outcomes.map(async (outcome) => {
    if (outcome.kind !== 'filed') throw new Error(`expected a filed request, got ${outcome.kind}${outcome.kind === 'closed' ? `: ${outcome.reason}` : ''}`)
    return (await changes.get(outcome.changes[0].id))!
  }))
}

/** Rewrite `rel` as another program would, once, at the moment the accept's save has judged its path. */
const rewriteDuringSave = (rel: string, text: string): { times: () => number } => {
  let times = 0
  documentSaveSeams.betweenCheckAndWrite = async (path) => {
    if (path !== rel) return
    times += 1
    delete documentSaveSeams.betweenCheckAndWrite
    await writeFile(join(root, rel), text)
  }
  return { times: () => times }
}

test('a document rewritten between the accept\'s read and its write is not overwritten: the Change stays pending and the writer is told', async () => {
  agent = await makeAgent()
  await write('a.md', DOC)
  const [replace] = await file(['replace', { path: 'a.md', target: 'The second sentence is wordy and long.', with: 'The second sentence is short.' }])
  // Another writer saves the document, with a paragraph of its own, while the accept is between read and write.
  const rewritten = `${DOC}\nA paragraph saved by something else in the meantime.\n`
  const during = rewriteDuringSave('a.md', rewritten)

  const refused = await agent.resolveChange(replace.id, 'accept')

  expect(during.times()).toBe(1)
  // The save fix (R6): the refusal also says, by type, which file changed and what is on disk now.
  expect(refused).toEqual({ applied: false, message: 'a.md changed while the change was being applied. Nothing was written. You can accept the change again.', changedOnDisk: { path: 'a.md', diskText: rewritten } })
  expect(refused.message).toBe(documentChangedMessage('a.md'))
  expect(await read('a.md')).toBe(rewritten)
  expect((await changes.get(replace.id))?.status).toBe('pending')
  expect(closedReasonOf((await changes.get(replace.id))!)).toBeNull()
  // Nothing of the refused write is left beside the document.
  expect((await readFile(join(root, 'a.md'), 'utf8'))).toBe(rewritten)

  // Accepting again works on the document as it now stands: the other writer's paragraph is kept.
  expect(await agent.resolveChange(replace.id, 'accept')).toMatchObject({ applied: true })
  expect(await read('a.md')).toBe(rewritten.replace('The second sentence is wordy and long.', 'The second sentence is short.'))
})

test('the same holds for an insert and for a move accepted from the ledger', async () => {
  agent = await makeAgent()
  await write('a.md', DOC)
  const [insert, move] = await file(
    ['insert', { path: 'a.md', text: 'An added paragraph.', after: 'The first sentence stays.' }],
    ['move-text', { path: 'a.md', text: 'The last sentence ends it.', after: 'The first sentence stays.' }],
  )
  for (const change of [insert, move]) {
    const rewritten = `${await read('a.md')}\nAnother line from elsewhere.\n`
    rewriteDuringSave('a.md', rewritten)
    expect(await agent.resolveChange(change.id, 'accept')).toEqual({ applied: false, message: documentChangedMessage('a.md'), changedOnDisk: { path: 'a.md', diskText: rewritten } })
    expect(await read('a.md')).toBe(rewritten)
    expect((await changes.get(change.id))?.status).toBe('pending')
  }
})

test('a live proposal from the in-app agent is content-checked too: its capability does not overwrite a document that changed under it', async () => {
  await write('a.md', DOC)
  const step: ScriptedStep = { cap: 'prose.edit', input: { path: 'a.md', oldText: 'The second sentence is wordy and long.', newText: 'The second sentence is short.', category: 'wording', summary: 'Tighten it.' } }
  agent = await makeAgent({ text: 'Tighten it', steps: [step] })
  const staged = new Promise<void>((resolve) => { ledgerChanged = resolve })
  await agent.runScriptedTurn('Tighten it', [step])
  await staged
  const [change] = await changes.list()
  expect(await agent.suggestions()).toHaveLength(1)
  const rewritten = `${DOC}\nA paragraph saved by something else in the meantime.\n`
  const during = rewriteDuringSave('a.md', rewritten)

  const refused = await agent.resolveChange(change.id, 'accept')

  expect(during.times()).toBe(1)
  expect(refused.applied).toBe(false)
  expect(refused.message).toContain(documentChangedMessage('a.md'))
  expect(await read('a.md')).toBe(rewritten)
  expect((await changes.get(change.id))?.status).toBe('pending')
  // And it can be accepted again, onto the document as it now stands.
  expect((await agent.resolveChange(change.id, 'accept')).applied).toBe(true)
  expect(await read('a.md')).toBe(rewritten.replace('The second sentence is wordy and long.', 'The second sentence is short.'))
})

test('restoring a version is applied only to exactly the document it was proposed over: a preface added since closes it', async () => {
  agent = await makeAgent()
  const original = '# Talk\n\nThe text as it was sent.\n'
  await write('talk.md', original)
  const { SnapshotStore } = await import('@bridle/core')
  const history = await SnapshotStore.open({ dir: join(root, '.bridle') })
  const saved = await saveVersionOfSavedText({
    workspace, versions: new VersionStore(workspace), changes, confirmOwner: async () => {}, author: { name: 'Writer' },
    snapshot: (path) => snapshotVersionOfSavedText({ workspace, snapshots: history, sessionId: 'test', path }),
  }, { path: 'talk.md', name: 'As sent' })
  const rewritten = '# Talk\n\nA rewrite that went wrong.\n'
  await write('talk.md', rewritten)
  const [restore, again] = await file(
    ['restore-version', { path: 'talk.md', version: saved.record.id }],
    ['restore-version', { path: 'talk.md', version: saved.record.id }],
  )
  expect(isWholeDocumentChange(restore)).toBe(true)
  expect(restore).toMatchObject({ whole: true, oldText: rewritten, newText: original })
  // The ledger carries the flag as a field of its own, and reads it back.
  expect(JSON.parse((await readFile(join(root, '.writeflex/changes.jsonl'), 'utf8')).split('\n').filter(Boolean).at(-1)!)).toMatchObject({ whole: true })

  // The writer adds a preface. The rewritten text still occurs once, INSIDE the document.
  const withPreface = `A preface written after the restore was proposed.\n\n${rewritten}`
  await write('talk.md', withPreface)

  const result = await agent.resolveChange(restore.id, 'accept')

  const reason = 'talk.md has changed since this change was proposed, so it was not applied.'
  expect(result).toEqual({ applied: false, closed: true, message: reason })
  expect(await read('talk.md')).toBe(withPreface)
  const closed = (await changes.get(restore.id))!
  expect(closedReasonOf(closed)).toBe(reason)
  expect(closedCodeOf(closed)).toBe('document-changed')

  // Over exactly the text it was proposed over, the other restore replaces the whole document.
  await write('talk.md', rewritten)
  expect(await agent.resolveChange(again.id, 'accept')).toMatchObject({ applied: true })
  expect(await read('talk.md')).toBe(original)
})

test('a metadata request is a change to the frontmatter block, not the whole document; a passage edit leaves it placeable; a second one to the same block waits', async () => {
  // Was (until 2026-10-27): metadata requests were whole-document Changes, closed as superseded by any accept in the same
  // document. Now they are the whole old and new frontmatter blocks (frontmatter-change.ts): placed only while the block
  // is exactly as proposed, never touching the body, and never closed when it is not: they wait.
  agent = await makeAgent()
  await write('a.md', `---\ntitle: Draft\n---\n\n${DOC}`)
  const [frontmatter, audience, replace] = await file(
    ['set-frontmatter', { path: 'a.md', key: 'status', value: 'draft' }],
    ['set-frontmatter', { path: 'a.md', key: 'audience', value: 'editors' }],
    ['replace', { path: 'a.md', target: 'The second sentence is wordy and long.', with: 'The second sentence is short.' }],
  )
  expect([frontmatter, audience, replace].map(isWholeDocumentChange)).toEqual([false, false, false])
  expect([frontmatter, audience, replace].map((change) => (change as { frontmatter?: true }).frontmatter === true)).toEqual([true, true, false])

  expect(await agent.resolveChange(replace.id, 'accept')).toMatchObject({ applied: true })
  for (const change of [frontmatter, audience]) expect((await changes.get(change.id))!.status).toBe('pending')
  expect(await agent.resolveChange(frontmatter.id, 'accept')).toMatchObject({ applied: true })
  expect((await changes.get(audience.id))!.status).toBe('pending')
  expect(await agent.resolveChange(audience.id, 'accept')).toMatchObject({ applied: false })
  expect((await changes.get(audience.id))!.status).toBe('pending')
  expect(await read('a.md')).toBe(`---\ntitle: Draft\nstatus: draft\n---\n\n${DOC.replace('The second sentence is wordy and long.', 'The second sentence is short.')}`)
})

test('accepting an already accepted Change writes nothing: an insertion accepted twice is in the document once', async () => {
  agent = await makeAgent()
  await write('a.md', DOC)
  const [insert] = await file(['insert', { path: 'a.md', text: 'An added paragraph.', after: 'The first sentence stays.' }])
  expect(await agent.resolveChange(insert.id, 'accept')).toMatchObject({ applied: true })
  const once = await read('a.md')
  expect(once.split('An added paragraph.').length - 1).toBe(1)
  const before = await stat(join(root, 'a.md'))
  const journal = await readFile(join(root, '.bridle/journal.jsonl'), 'utf8')
  // The anchor is still there, so a second placement would succeed: nothing may attempt it.
  let saves = 0
  documentSaveSeams.betweenCheckAndWrite = async () => { saves += 1 }

  expect(await agent.resolveChange(insert.id, 'accept')).toMatchObject({ applied: true })
  expect(await agent.resolveChange(insert.id, 'accept')).toMatchObject({ applied: true })

  expect(saves).toBe(0)
  expect(await read('a.md')).toBe(once)
  const after = await stat(join(root, 'a.md'))
  expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
  expect(await readFile(join(root, '.bridle/journal.jsonl'), 'utf8')).toBe(journal)
  expect((await changes.get(insert.id))?.status).toBe('accepted')
})

test('an outside insert with no anchor lands at the end of the document, after frontmatter and after all the prose', async () => {
  agent = await makeAgent()
  const withFrontmatter = `---\ntitle: Draft\n---\n\n${DOC}`
  await write('a.md', withFrontmatter)
  await write('only.md', '---\ntitle: Empty\n---\n')
  await write('plain.md', DOC)
  const [a, only, plain] = await file(
    ['insert', { path: 'a.md', text: 'The closing paragraph.' }],
    ['insert', { path: 'only.md', text: 'The first paragraph.' }],
    ['insert-object', { path: 'plain.md', kind: 'table', content: '| A | B |\n| --- | --- |\n| 1 | 2 |' }],
  )
  expect(a).toMatchObject({ editClass: 'insert', insertAfter: '', summary: 'Add text at the end of a.md' })

  for (const change of [a, only, plain]) expect(await agent.resolveChange(change.id, 'accept')).toMatchObject({ applied: true })

  expect(await read('a.md')).toBe(`${withFrontmatter.trimEnd()}\n\nThe closing paragraph.`)
  expect(await read('only.md')).toBe('---\ntitle: Empty\n---\n\nThe first paragraph.')
  expect((await read('plain.md')).startsWith(DOC.trimEnd())).toBe(true)
  expect((await read('plain.md')).indexOf('| A | B |')).toBeGreaterThan(DOC.indexOf('The last sentence ends it.'))
  // One function decides it, for the validator, the after-accept check and accept.
  expect(resolveOutsideInsert(withFrontmatter, { path: 'a.md', insertAfter: '', text: 'X' }).nextContent.endsWith('The last sentence ends it.\n\nX')).toBe(true)
})

test('the in-app agent\'s insert with no anchor behaves as before: an empty document is filled, and with frontmatter it goes just after it', async () => {
  agent = await makeAgent()
  const input = { path: 'a.md', insertAfter: '', text: 'New prose.', category: 'other', summary: '' } as const
  expect(resolveProseInsert('', input).nextContent).toBe('New prose.')
  expect(resolveProseInsert('---\ntitle: T\n---\n', input).nextContent).toBe('---\ntitle: T\n---\n\nNew prose.')
  expect(resolveProseInsert('---\ntitle: T\n---\n\nBody.\n', input).nextContent).toBe('---\ntitle: T\n---\n\nNew prose.\n\nBody.\n')
  expect(resolveProseInsert('Body.\n', input).nextContent).toBe('Body.\n\nNew prose.')

  // And replayed from the ledger with no live proposal, an in-app agent's anchorless insert keeps that place.
  await write('a.md', '---\ntitle: T\n---\n\nBody.\n')
  const own = await changes.add({ path: 'a.md', provenance: 'agent', editClass: 'insert', category: 'other', summary: 'Add an opening.', oldText: '', newText: 'New prose.', insertAfter: '', isCorrection: false })
  expect(await agent.resolveChange(own.id, 'accept')).toMatchObject({ applied: true })
  expect(await read('a.md')).toBe('---\ntitle: T\n---\n\nNew prose.\n\nBody.\n')
})
