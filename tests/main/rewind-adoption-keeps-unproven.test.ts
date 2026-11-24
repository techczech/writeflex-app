/**
 * Follow-up to PR 268 (restore keeps later writing): the rewind of a refused adoption removes a file the
 * adoption created outside the Workspace's write log (a widget file) only while it still holds the bytes
 * the adoption wrote. Anything else there is kept and named in the rollback message.
 *
 * Real path: the agent proposes a widget, the writer accepts, the widget file is written, then the
 * document save is refused by the document-only view (a NotADocumentPathError at the write), so the
 * adoption is refused and rewound. The seam is the Workspace's guarded save of the document.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { ChangeStore } from '../../src/main/changes'
import { widgetFileSha256 } from '../../src/main/widget-create'
import { NotADocumentPathError, Workspace } from '../../src/main/workspace'

const DOC = 'Intro.\n\nMore.\n'
const PAGE = '<!doctype html><html><head><title>Pace</title></head><body><b id="o">0</b></body></html>'
const INPUT = { path: 'essays/doc.md', fileName: 'Pace.html', html: PAGE, title: 'Pace' }
const FILE = 'essays/assets/pace.html'
const OUTSIDE = '<!doctype html><html><head><title>Pace</title></head><body>Written by another program.</body></html>'

/** The document save is refused as if the document had become hidden; first, optionally, another program writes into the new widget file. */
class RefusesDocumentSave extends Workspace {
  refuse = false
  outsideWrite: string | null = null
  override async saveFileOverRead(...args: Parameters<Workspace['saveFileOverRead']>): ReturnType<Workspace['saveFileOverRead']> {
    if (!this.refuse || args[0] !== 'essays/doc.md') return super.saveFileOverRead(...args)
    if (this.outsideWrite !== null) await writeFile(join(this.root, FILE), this.outsideWrite)
    throw new NotADocumentPathError(args[0], 'hidden')
  }
}

let root: string
let appData: string
let agent: WorkspaceAgent | null = null
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wf-rewind-unproven-')))
  appData = await mkdtemp(join(tmpdir(), 'wf-rewind-unproven-data-'))
  await mkdir(join(root, 'essays'), { recursive: true })
  await writeFile(join(root, 'essays/doc.md'), DOC)
})
afterEach(async () => {
  await agent?.dispose()
  agent = null
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false)

async function proposeWidget(ws: Workspace) {
  const changes = new ChangeStore(ws)
  const step: ScriptedStep = { cap: 'widgets.create', input: INPUT }
  agent = await WorkspaceAgent.create({ mode: 'work',
    workspace: ws, appDataDir: appData, changes,
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    sessionFactory: scriptedSessionFactory([{ prompt: 'Add a widget', rounds: [
      { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: [step.cap] } }] },
      { kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] },
      { kind: 'message', text: 'Proposed.' },
    ] }]),
  })
  await agent.runScriptedTurn('Add a widget', [step])
  for (let i = 0; i < 100 && (await changes.list()).length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  const [change] = await changes.list()
  return { agent, change }
}

test('writing another program put into the file a refused adoption created is kept by the rewind, and the message names it', async () => {
  const ws = new RefusesDocumentSave(root)
  const { agent: live, change } = await proposeWidget(ws)
  ws.refuse = true
  ws.outsideWrite = OUTSIDE

  const result = await live.resolveChange(change.id, 'accept')

  expect(result.applied).toBe(false)
  expect(await readFile(join(root, FILE), 'utf8')).toBe(OUTSIDE)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe(DOC)
  expect(result.message).not.toContain('Nothing was changed.')
  expect(result.message).toContain(`${FILE} changed on disk after WriteFlex wrote it, so it was left as it is.`)
})

test('a file a refused adoption created that still holds exactly what it wrote is removed, and nothing is reported as left', async () => {
  const ws = new RefusesDocumentSave(root)
  const { agent: live, change } = await proposeWidget(ws)
  ws.refuse = true

  const result = await live.resolveChange(change.id, 'accept')

  expect(result.applied).toBe(false)
  expect(await exists(join(root, FILE))).toBe(false)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe(DOC)
  expect(result.message).toContain('Nothing was changed.')
})

test('the reviewer\'s case: a path the adoption\'s restore point records as absent, filled by another program, is kept; one holding the recorded bytes is removed', async () => {
  const ws = new Workspace(root)
  agent = await WorkspaceAgent.create({ mode: 'work',
    workspace: ws, appDataDir: appData, changes: new ChangeStore(ws),
    onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
  })
  const store = (agent as unknown as { snapshots: { beginRestorePoint(label: string, session: undefined, meta: { proposalId: string }): Promise<unknown>; snapshotFile(file: string, meta: { sessionId: string; capability: string }): Promise<unknown> } }).snapshots
  await store.beginRestorePoint('an adoption', undefined, { proposalId: 'the-proposal' })
  const unrecorded = 'essays/outside.html'
  const recorded = 'essays/own.html'
  for (const path of [unrecorded, recorded]) await store.snapshotFile(join(root, path), { sessionId: 's', capability: 'widgets.create' })
  await writeFile(join(root, unrecorded), OUTSIDE)
  await writeFile(join(root, recorded), PAGE)
  const rewind = (agent as unknown as { rewindAdoption(id: string, written: unknown[], created: Map<string, string>): Promise<string | null> }).rewindAdoption.bind(agent)

  const message = await rewind('the-proposal', [], new Map([[recorded, widgetFileSha256(PAGE)]]))

  expect(await readFile(join(root, unrecorded), 'utf8')).toBe(OUTSIDE)
  expect(await exists(join(root, recorded))).toBe(false)
  expect(message).toContain(`${unrecorded} was made by the change, but WriteFlex has no record of what it wrote there, so it was left as it is.`)
})
