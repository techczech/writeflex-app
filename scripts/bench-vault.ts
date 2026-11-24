/**
 * Times the real IPC handlers against a generated vault. Electron's native window and IPC
 * transport are stood in; Quick Open's name ranking runs through its real renderer function.
 */
import { mock } from 'bun:test'
import { deepStrictEqual, ok } from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, hostname, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { electronMainStandIn } from '../tests/helpers/electron-main-stand-in'
import { generateSyntheticVault, VAULT_SEED } from '../tests/fixtures/synthetic-vault'
import type { MarkdownFile, SearchResult } from '../src/main/workspace'
import type { VaultIndex } from '../src/shared/vault-index'
import type { WindowState } from '../src/main/state'

const { values } = parseArgs({ options: {
  files: { type: 'string', default: '5000' },
  runs: { type: 'string', default: '7' },
  json: { type: 'string' },
  previews: { type: 'boolean' },
} })
const files = Number(values.files)
const runs = Number(values.runs)
if (!Number.isSafeInteger(files) || files < 5 || !Number.isSafeInteger(runs) || runs < 1) {
  throw new Error('Give --files an integer of at least 5 and --runs a positive integer.')
}

const budgets = {
  'open vault': 1500,
  'first search after open': 500,
  'repeat search': 250,
  'quick-open name search': 50,
  'save document': 200,
  'rename document': 1000,
  'rename preview 1': undefined,
  'rename preview 2': undefined,
  'rename with previews': undefined,
  'move preview 1': undefined,
  'move preview 2': undefined,
  'move with previews': undefined,
  'move document': 1000,
  'rename folder': 1000,
}
type Journey = keyof typeof budgets
type Sample = { ms: number; walks: number; searchReads: number; loadBefore: number; loadAfter: number }
type Listing = { files: MarkdownFile[]; folders: string[] }
type Repair = { writtenPaths: string[]; unrepairedReferences: unknown[] }
type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const scratch = await mkdtemp(join(tmpdir(), 'wf-bench-vault-'))
try {
  const app = new EventEmitter()
  let appData = scratch
  const handlers = new Map<string, Handler>()
  mock.module('electron', () => ({
    ...electronMainStandIn,
    app: Object.assign(app, { getPath: () => appData, getVersion: () => '0.0.0-bench', isPackaged: false }),
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    },
    clipboard: {}, dialog: {}, shell: {},
  }))

  const { registerIpc, bindWorkspace } = await import('../src/main/ipc')
  const { registerWindow, waitForAgentDisposals } = await import('../src/main/state')
  const { waitForRequestDisposals } = await import('../src/main/request-inbox-watch')
  const { SettingsStore } = await import('../src/main/settings')
  const { Workspace } = await import('../src/main/workspace')
  const { buildCommandPaletteSections } = await import('../src/renderer/src/components/CommandPalette')

  let walks = 0
  // Count each whole-tree entry point once, including the vault index's separate folder walk.
  for (const name of ['listFiles', 'listFilesAndFolders', 'listFolders'] as const) {
    const list = Workspace.prototype[name]
    Object.defineProperty(Workspace.prototype, name, { value: function (this: InstanceType<typeof Workspace>, ...args: Parameters<typeof list>) {
      walks += 1
      return Reflect.apply(list, this, args)
    } })
  }

  const samples = new Map<Journey, Sample[]>()
  let windowId = 0
  const launch = () => {
    handlers.clear()
    const settings = new SettingsStore(join(appData, 'settings.json'))
    const window = Object.assign(new EventEmitter(), {
      webContents: { id: ++windowId, send: () => {} },
      isDestroyed: () => false,
      setTitle: () => {},
    })
    const state = registerWindow(window as unknown as Parameters<typeof registerWindow>[0])
    const ipc = registerIpc({
      openFolder: (target: WindowState, root: string) => bindWorkspace(target, root, settings, () => false),
      openFile: async () => { throw new Error('Expected a folder') },
      openRecent: async () => { throw new Error('Expected a folder') },
      recents: () => [],
    }, settings, {} as Parameters<typeof registerIpc>[2])
    const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`IPC handler missing for ${channel}`)
      return (await handler({ sender: window.webContents }, ...args)) as T
    }
    return {
      state,
      call,
      close: async () => {
        window.emit('closed')
        state.workspace = null
        await Promise.all([waitForAgentDisposals(), waitForRequestDisposals()])
        await ipc.dispose()
      },
    }
  }

  const measure = async <T>(session: ReturnType<typeof launch>, journey: Journey, run: () => Promise<T> | T): Promise<T> => {
    const beforeWalks = walks
    const beforeReads = session.state.workspace?.searchIndex.reads ?? 0
    const [loadBefore] = loadavg()
    const start = performance.now()
    const value = await run()
    const ms = performance.now() - start
    const sample = { ms, loadBefore, loadAfter: loadavg()[0], walks: walks - beforeWalks, searchReads: (session.state.workspace?.searchIndex.reads ?? 0) - beforeReads }
    const prior = samples.get(journey)
    if (prior) prior.push(sample)
    else samples.set(journey, [sample])
    return value
  }

  for (let run = 0; run < runs; run += 1) {
    const root = join(scratch, `vault-${run}`)
    appData = join(scratch, `app-data-${run}`)
    await mkdir(appData)
    await writeFile(join(appData, 'settings.json'), JSON.stringify({ values: { 'workspace.watchExternalChanges': false } }))
    await generateSyntheticVault(root, files)

    // Returning to a vault: the previous session indexes it, then closes. Fresh Workspace
    // instances share only the on-disk app data, just as they would across launches.
    const previous = launch()
    try {
      const listing = await previous.call<Listing>('workspace:open-dialog', root)
      deepStrictEqual(listing.files.length, files)
      ok(await previous.call<VaultIndex | null>('vault:index'))
    } finally {
      await previous.close()
    }

    const opened = launch()
    let index: VaultIndex | null
    try {
      index = await measure(opened, 'open vault', async () => {
        const listing = await opened.call<Listing>('workspace:open-dialog', root)
        deepStrictEqual(listing.files.length, files)
        return opened.call<VaultIndex | null>('vault:index')
      })
      ok(index)
    } finally {
      await opened.close()
    }

    const session = launch()
    try {
      // Search immediately after the first listing, before asynchronous sidebar facts have
      // warmed the content cache. The full listing + index path is measured separately above.
      const listing = await session.call<Listing>('workspace:open-dialog', root)
      const first = await measure(session, 'first search after open', () => session.call<SearchResult>('workspace:search', 'benchneedle'))
      ok(first.matches.some((match) => match.path === 'references.md'))
      const repeat = await measure(session, 'repeat search', () => session.call<SearchResult>('workspace:search', 'benchneedle'))
      deepStrictEqual(repeat, first)
      const quick = await measure(session, 'quick-open name search', () => buildCommandPaletteSections({
        mode: 'files', query: 'rename-me', ...listing, commands: [], skills: [],
        activeFile: null, recentIds: [], titles: index.labels, hiddenPaths: index.hidden.paths,
      }))
      ok(quick.flatMap(({ items }) => items).some((item) => item.kind === 'file' && item.file.path === 'rename-me.md'))

      // The synthetic profile has no configured model. The same IPC handlers repair links when
      // the window has no agent, without adding an unrelated agent startup wait to that timing.
      try { await session.state.agentReady } catch { session.state.agentReady = null }
      const basis = await session.call<{ content: string }>('file:read', 'edit.md')
      const content = basis.content + '\nA saved synthetic paragraph.\n'
      const saved = await measure(session, 'save document', () =>
        session.call<{ written?: string }>('file:save', { path: 'edit.md', content, basis: { kind: 'disk', text: basis.content } }))
      deepStrictEqual(saved.written, content)

      const preview = async (
        label: 'rename' | 'move', input: { path: string; newName: string; directory?: string },
        expectedPath: string,
      ) => {
        for (const attempt of [1, 2] as const) {
          const plan = await measure(session, `${label} preview ${attempt}`, () =>
            session.call<{ newPath: string; repairPaths: string[] }>('file:rename-repair-paths', input))
          deepStrictEqual(plan.newPath, expectedPath)
          ok(plan.repairPaths.includes('references.md'))
        }
      }
      const rename = () => measure(session, 'rename document', () =>
        session.call<{ file: MarkdownFile; repair: Repair }>('file:rename', { path: 'rename-me.md', newPath: 'renamed.md' }))
      const renamed = values.previews ? await measure(session, 'rename with previews', async () => {
        await preview('rename', { path: 'rename-me.md', newName: 'renamed.md' }, 'renamed.md')
        return rename()
      }) : await rename()
      deepStrictEqual(renamed.file.path, 'renamed.md')
      ok(renamed.repair.writtenPaths.includes('references.md'), JSON.stringify(renamed.repair))

      const move = () => measure(session, 'move document', () =>
        session.call<{ file: MarkdownFile; repair: Repair }>('file:move', { path: 'move-me.md', newPath: 'destination/move-me.md' }))
      const moved = values.previews ? await measure(session, 'move with previews', async () => {
        await preview('move', { path: 'move-me.md', newName: 'move-me.md', directory: 'destination' }, 'destination/move-me.md')
        return move()
      }) : await move()
      deepStrictEqual(moved.file.path, 'destination/move-me.md')
      ok(moved.repair.writtenPaths.includes('references.md'), JSON.stringify(moved.repair))

      const folder = await measure(session, 'rename folder', () =>
        session.call<{ path: string; repair: Repair }>('folder:rename', { path: 'rename-folder', newName: 'renamed-folder' }))
      deepStrictEqual(folder.path, 'renamed-folder')
      ok(folder.repair.writtenPaths.includes('references.md'), JSON.stringify(folder.repair))
      const references = await readFile(join(root, 'references.md'), 'utf8')
      for (const link of ['[[renamed]]', '[[./destination/move-me]]', '[[./renamed-folder/inside]]']) ok(references.includes(link), references)
    } finally {
      await session.close()
    }
  }

  const sorted = (values: number[]): number[] => values.sort((a, b) => a - b)
  const median = (values: number[]): number => {
    const order = sorted(values)
    return (order[Math.floor((order.length - 1) / 2)] + order[Math.floor(order.length / 2)]) / 2
  }
  const rounded = (value: number): number => Math.round(value * 100) / 100
  const rows = [...samples].map(([journey, attempts]) => {
    const times = attempts.map((sample) => sample.ms)
    const medianMs = rounded(median(times))
    const budgetMs = budgets[journey]
    return {
      journey, medianMs, p90Ms: rounded(sorted(times)[Math.ceil(0.9 * times.length) - 1]),
      medianWalks: median(attempts.map((sample) => sample.walks)),
      medianSearchReads: median(attempts.map((sample) => sample.searchReads)),
      budgetMs, overBudget: budgetMs === undefined ? undefined : medianMs > budgetMs,
      samples: attempts.map((sample) => ({ ...sample, ms: rounded(sample.ms) })),
    }
  })
  const result = {
    machine: hostname(), cpu: cpus()[0]?.model ?? 'unknown', files, runs, seed: VAULT_SEED,
    gitSha: process.env.WF_BENCH_REVISION ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), rows,
  }
  console.log(`WriteFlex vault benchmark, ${files} files × ${runs} runs, ${result.machine} (${result.cpu})`)
  console.table(rows.map(({ samples: _samples, ...row }) => row))
  if (values.json !== undefined) await writeFile(values.json, JSON.stringify(result, null, 2) + '\n')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
