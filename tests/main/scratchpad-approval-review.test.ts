import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scriptedSessionFactory } from '@bridle/core'
import { Workspace } from '../../src/main/workspace'
import { WorkspaceAgent, type ScriptedStep } from '../../src/main/agent'
import { ScrapStore } from '../../src/main/scraps'
import { ScratchpadStore } from '../../src/main/scratchpad-store'
import { registerScratchpadIpc } from '../../src/main/scratchpad-ipc'

let root: string | undefined
let agent: WorkspaceAgent | undefined
afterEach(async () => { await agent?.dispose(); agent = undefined; if (root) await rm(root, { recursive: true, force: true }); root = undefined })

async function fixture() {
  root = await mkdtemp(join(import.meta.dirname, '.scratchpad-approval-review-'))
  await writeFile(join(root, 'note.md'), '# Note\n')
  const workspace = new Workspace(root)
  const scraps = new ScrapStore(workspace)
  const store = new ScratchpadStore(workspace, scraps)
  const item = await store.addText({ origin: 'note.md', markdown: '**Only this rejected candidate.**\n', how: 'copy', by: 'writer' })
  await store.setStatus([item.id], 'rejected')
  return { root, workspace, scraps, store, item: await store.get(item.id) }
}

test('confirmed deletion IPC refuses a missing shown version and retains the candidate', async () => {
  const f = await fixture()
  const handlers = new Map<string, (event: { sender: { id: number } }, raw: unknown) => unknown>()
  registerScratchpadIpc({ handle: (name, handler) => handlers.set(name, handler) }, {
    stateForSender: () => ({ workspace: f.workspace, scratchpad: f.store }), announce: () => {},
  })
  const reply = await handlers.get('scratchpad:delete-forever')!({ sender: { id: 1 } }, { root: f.root, id: f.item.id }) as { ok: boolean }
  expect(reply.ok).toBe(false)
  expect((await f.store.get(f.item.id)).markdown).toBe(f.item.markdown)
})

test('real agent deletion waits for approval, then deletes once and journals the completed execution', async () => {
  const f = await fixture()
  const prompt = 'Delete the rejected candidate'
  const step: ScriptedStep = { cap: 'scratchpad.delete', input: { id: f.item.id, version: f.item.version } }
  let requested!: (id: string) => void
  const approval = new Promise<string>(resolve => { requested = resolve })
  const appData = join(f.root, 'profile')
  agent = await WorkspaceAgent.create({ mode: 'work', workspace: f.workspace, appDataDir: appData, services: { scraps: f.scraps },
    sessionFactory: scriptedSessionFactory([{ prompt, rounds: [
      { kind: 'tool-calls', calls: [{ name: 'tools.enable', arguments: { names: [step.cap] } }] },
      { kind: 'tool-calls', calls: [{ name: step.cap, arguments: step.input as Record<string, unknown> }] },
      { kind: 'message', text: 'Finished the request.' },
    ] }]), onTrace: () => {}, onSuggestionsChanged: () => {}, onApprovalRequest: request => requested(request.id),
  })
  const turn = agent.runScriptedTurn(prompt, [step])
  const request = await approval
  expect((await f.store.get(f.item.id)).markdown).toBe(f.item.markdown)
  expect(agent.resolveApproval(request, true)).toBe(true)
  await turn
  await expect(f.store.get(f.item.id)).rejects.toThrow()
  const records = (await readFile(join(appData, 'executions/execution-journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const registration = records.find(record => record.type === 'registered' && record.capability === 'scratchpad.delete')
  expect(registration).toBeDefined()
  const outcome = records.find(record => record.type === 'outcome' && record.attemptId === registration.attemptId)
  expect(outcome).toMatchObject({ disposition: 'returned', result: { details: { deleted: f.item.id } } })
})
