/**
 * Ticket 06, follow-up 1. A document whose text is about to be copied into the review ledger is read
 * through one guarded read (guarded-document-read.ts). The fault it closes: a link swapped in between
 * the path check and the read made another file's content the `oldText` of a Change.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { ChangeStore } from '../../src/main/changes'
import { CommandLineWorkspace } from '../../src/main/cli/guarded-workspace'
import { DocumentReadRefused, guardedReadSeams, readDocumentGuarded } from '../../src/main/guarded-document-read'
import { proposeOutsideChange } from '../../src/main/outside-change'
import { Workspace } from '../../src/main/workspace'
import { YORK, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { openAsApp, plantRequest, replyTo } from '../helpers/request-app'

const SECRET = '---\ntitle: Private\n---\nOUTSIDE-TARGET and a PRIVATE-SENTENCE that is in no document of the Collection.\n'
let fx: WriteFixture
let outside: string
beforeEach(async () => {
  fx = await writeFixture()
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-guarded-outside-')))
  await writeFile(join(outside, 'secret.md'), SECRET)
  await mkdir(join(outside, 'talks'))
  await writeFile(join(outside, 'talks', 'york.md'), SECRET)
})
afterEach(async () => {
  guardedReadSeams.beforeOpen = undefined
  await fx.dispose()
  await rm(outside, { recursive: true, force: true })
})

/** After the path has been judged and before the file is opened, put a link to the outside file in the document's place. */
const swapDocumentForLink = (rel: string): void => {
  guardedReadSeams.beforeOpen = async (absolute) => {
    if (absolute !== join(fx.root, rel)) return
    guardedReadSeams.beforeOpen = undefined
    await rm(absolute)
    await symlink(join(outside, 'secret.md'), absolute)
  }
}
/** The same instant, one level up: the document's folder becomes a link to a folder outside the Collection. */
const swapFolderForLink = (rel: string): void => {
  guardedReadSeams.beforeOpen = async (absolute) => {
    if (absolute !== join(fx.root, rel)) return
    guardedReadSeams.beforeOpen = undefined
    await rename(join(fx.root, 'talks'), join(fx.root, 'talks-real'))
    await symlink(join(outside, 'talks'), join(fx.root, 'talks'))
  }
}
const ledgerText = async (): Promise<string> => readFile(join(fx.root, '.writeflex/changes.jsonl'), 'utf8')

test('a link swapped in between the path check and the read is refused, for a text edit and for a whole-document change; no byte of the outside file reaches the ledger', async () => {
  const app = await openAsApp(fx, { changes: new ChangeStore(new Workspace(fx.root)) })
  try {
    // A text edit whose target is in the OUTSIDE file: with a read by name it would be found and filed.
    swapDocumentForLink('talks/york.md')
    const edit = await plantRequest(fx, 'replace', { path: 'talks/york.md', target: 'OUTSIDE-TARGET', with: 'x' })
    await app.executor.drain()
    expect((await replyTo(fx, edit)).reason).toContain('is a link')
    // A whole-document change: its `oldText` would have been the outside file, whole.
    await rm(join(fx.root, 'talks/york.md'))
    await fx.write('talks/york.md', YORK)
    swapDocumentForLink('talks/york.md')
    const whole = await plantRequest(fx, 'set-frontmatter', { path: 'talks/york.md', key: 'audience', value: 'teachers' })
    await app.executor.drain()
    expect((await replyTo(fx, whole)).reason).toContain('is a link')
    // And with the folder above it swapped: the opened file is a real file, somewhere else.
    await rm(join(fx.root, 'talks/york.md'))
    await fx.write('talks/york.md', YORK)
    swapFolderForLink('talks/york.md')
    const viaFolder = await plantRequest(fx, 'set-status', { path: 'talks/york.md', status: 'editing' })
    await app.executor.drain()
    expect((await replyTo(fx, viaFolder)).reason).toContain('does not lie inside the Collection')

    const stored = await new ChangeStore(new Workspace(fx.root)).list()
    expect(stored.map((change) => change.status)).toEqual(['rejected', 'rejected', 'rejected'])
    const text = await ledgerText()
    // (The request's own target is kept on its closed record; nothing the outside FILE holds beyond it is.)
    expect(text).not.toContain('PRIVATE-SENTENCE')
    expect(text).not.toContain('title: Private')
  } finally {
    await app.close()
  }
})

test('the command line\'s own check before filing reads the same way: nothing is filed for a swapped document', async () => {
  swapDocumentForLink('talks/york.md')
  const run = await fx.cli(['replace', 'talks/york.md', '--target', 'OUTSIDE-TARGET', '--with', 'x'])
  expect(run.code).toBe(1)
  expect(run.json.error!.message).toContain('is a link')
  expect(await fx.read('.writeflex/changes.jsonl')).toBe('{"change":"fixture"}\n')
  await rm(join(fx.root, 'talks/york.md'))
  await fx.write('talks/york.md', YORK)
  swapFolderForLink('talks/york.md')
  const proposal = await proposeOutsideChange(new CommandLineWorkspace(fx.root), 'normalise-frontmatter', { path: 'talks/york.md' })
  expect(proposal.ok ? '' : proposal.reason).toContain('does not lie inside the Collection')
})

test('a document that is itself a link is refused even when it points at another document of the Collection; a plain document is read from its handle', async () => {
  const ws = new Workspace(fx.root)
  await symlink(join(fx.root, 'notes.md'), join(fx.root, 'alias.md'))
  await expect(readDocumentGuarded(ws, 'alias.md')).rejects.toMatchObject({ code: 'is-a-link' })
  await expect(readDocumentGuarded(ws, 'missing.md')).rejects.toMatchObject({ code: 'missing' })
  await expect(readDocumentGuarded(ws, 'talks')).rejects.toMatchObject({ code: 'is-a-folder' })
  await expect(readDocumentGuarded(ws, '.writeflex/changes.jsonl')).rejects.toMatchObject({ code: 'not-a-document' })
  await expect(readDocumentGuarded(ws, '../x.md')).rejects.toBeInstanceOf(DocumentReadRefused)
  expect(await readDocumentGuarded(ws, './talks/york.md')).toEqual({ path: 'talks/york.md', content: YORK })
  // A folder that is a link to another folder INSIDE the Collection is still a document's real place.
  await symlink(join(fx.root, 'talks'), join(fx.root, 'events'))
  expect((await readDocumentGuarded(ws, 'events/york.md')).content).toBe(YORK)
})

test('the in-app agent\'s staging reads the same way: a frontmatter proposal over a swapped document stages no Change', async () => {
  const appData = await mkdtemp(join(tmpdir(), 'wf-guarded-data-'))
  const workspace = new Workspace(fx.root)
  const changes = new ChangeStore(workspace)
  const step: ScriptedStep = { cap: 'frontmatter.set', input: { path: 'talks/york.md', set: { audience: 'teachers' }, summary: 'Add audience' } }
  const agent = await WorkspaceAgent.create({
    workspace, appDataDir: appData, changes, onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([{ prompt: 'Set it', rounds: [{ kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] }, { kind: 'message', text: 'Done.' }] }]),
  })
  try {
    // The swap happens inside the staging read, after the document-only view has judged the path.
    let staged = false
    guardedReadSeams.beforeOpen = async (absolute) => {
      if (absolute !== join(fx.root, 'talks/york.md') || staged) return
      staged = true
      await rm(absolute)
      await symlink(join(outside, 'secret.md'), absolute)
    }
    await agent.runScriptedTurn('Set it', [step])
    for (let i = 0; i < 50 && !staged; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(staged).toBe(true)
    expect(await changes.list()).toEqual([])
    expect(await ledgerText()).not.toContain('PRIVATE-SENTENCE')
  } finally {
    agent.dispose()
    await rm(appData, { recursive: true, force: true })
  }
})
