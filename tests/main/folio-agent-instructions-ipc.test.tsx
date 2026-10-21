import { test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { Workspace } from '../../src/main/workspace'
import { MANIFEST_NAME } from '../../src/main/folio'
import { registerFolioAgentInstructionsIpc } from '../../src/main/folio-agent-instructions-ipc'
import { writeFolioAgentInstructions } from '../../src/main/folio-agent-instructions'
import { agentInstructionsLines, FolioAgentInstructionsRow } from '../../src/renderer/src/components/FolioAgentInstructions'
import type { FolioAgentInstructionsStatus } from '../../src/shared/folio-agent-files'

let root: string
let ws: Workspace
let handlers: Map<string, (event: { sender: { id: number } }, input: any) => unknown>
let published: { collection: string[][]; disk: string[][]; checkpoints: string[] }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-agents-ipc-'))
  ws = new Workspace(root)
  handlers = new Map()
  published = { collection: [], disk: [], checkpoints: [] }
  registerFolioAgentInstructionsIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => 'state',
    requireWorkspace: () => ws,
    checkpointFile: async (_state, path) => { published.checkpoints.push(path) },
    notifyCollectionChanged: (_state, paths) => { published.collection.push(paths) },
    notifyChangedOnDisk: (_state, paths) => { published.disk.push(paths) },
  })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const invoke = (channel: string, input: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input)

test('a folder that is not a Folio has no row and refuses the requests, writing nothing', async () => {
  await write('plain/a.md', '# A\n')
  expect(await invoke('folio:agent-instructions', { dir: 'plain' })).toBeNull()
  await expect(Promise.resolve(invoke('folio:agent-instructions-act', { dir: 'plain', action: 'restore' }))).rejects.toThrow('not a Folio')
  expect(existsSync(join(root, 'plain/AGENTS.md'))).toBe(false)
  await expect(Promise.resolve(invoke('folio:agent-instructions-act', { dir: '../outside', action: 'restore' }))).rejects.toThrow()
  await write(`f/${MANIFEST_NAME}`, '{"files":[]}')
  await expect(Promise.resolve(invoke('folio:agent-instructions-act', { dir: 'f', action: 'delete-everything' }))).rejects.toThrow('Invalid agent instructions request.')
})

test('Restore from the row checkpoints the existing file, writes it and tells the window', async () => {
  await write('r/01-a.md', '# A\n')
  await write(`r/${MANIFEST_NAME}`, '{"files":[{"path":"01-a.md"}]}')
  await writeFolioAgentInstructions(ws, 'r')
  await write('r/AGENTS.md', readFileSync(join(root, 'r/AGENTS.md'), 'utf8').replace('This folder is a Folio', 'Edited'))
  const before = await invoke('folio:agent-instructions', { dir: 'r' }) as FolioAgentInstructionsStatus
  expect(before.agents).toBe('edited')
  expect(published.collection).toEqual([])
  const after = await invoke('folio:agent-instructions-act', { dir: 'r', action: 'restore' }) as FolioAgentInstructionsStatus
  expect(after.agents).toBe('current')
  expect(after.written).toEqual(['r/AGENTS.md'])
  expect(published.checkpoints).toEqual(['r/AGENTS.md'])
  expect(published.collection).toEqual([['r/AGENTS.md']])
  expect(published.disk).toEqual([['r/AGENTS.md']])
})

const status = (over: Partial<FolioAgentInstructionsStatus> = {}): FolioAgentInstructionsStatus => ({
  dir: 'r', agentsPath: 'r/AGENTS.md', claudePath: 'r/CLAUDE.md', agents: 'current', claude: 'imports', written: [], ...over,
})
const noop = (): void => {}

test('the row: up to date, edited with Restore, missing with Write it again, and the CLAUDE.md line', () => {
  const current = renderToStaticMarkup(<FolioAgentInstructionsRow status={status()} onOpen={noop} onAct={noop} />)
  expect(current).toContain('Agent instructions')
  expect(current).toContain('WriteFlex keeps its part up to date')
  expect(current).toContain('aria-label="Open the agent instructions, r/AGENTS.md"')
  expect(current).not.toContain('Restore')
  expect(current).not.toContain('CLAUDE.md')

  const edited = renderToStaticMarkup(<FolioAgentInstructionsRow status={status({ agents: 'edited' })} onOpen={noop} onAct={noop} />)
  expect(edited).toContain('so WriteFlex no longer updates it')
  expect(edited).toContain('>Restore</button>')

  const missing = agentInstructionsLines(status({ agents: 'missing', claude: 'missing' }))
  expect(missing.canOpen).toBe(false)
  expect(missing.agents.action).toEqual({ label: 'Write it again', request: 'restore' })
  expect(missing.claude?.action).toEqual({ label: 'Write CLAUDE.md', request: 'write-claude' })

  const own = renderToStaticMarkup(<FolioAgentInstructionsRow status={status({ claude: 'own' })} onOpen={noop} onAct={noop} />)
  expect(own).toContain('Claude Code reads your own CLAUDE.md')
  expect(own).toContain('>Add the import line</button>')

  expect(agentInstructionsLines(status({ agents: 'damaged' })).agents.action).toBeUndefined()
  expect(agentInstructionsLines(status({ agents: 'no-maintained-part' })).agents.action?.label).toBe('Add WriteFlex’s part')
})
