/**
 * The vault switcher's main side (vaults ticket 06): the read-only look at each known root
 * (vault-presence.ts) and the two channels (vault-switcher-ipc.ts).
 *
 * Seams: `rootPresence` over real temporary folders (nothing may be created in them), and
 * `registerSwitcherIpcHandlers` with a fake registrar and a fake window manager.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedWorkCount, rootPresence, rootPresences } from '../../src/main/vault-presence'
import { vaultSnapshotPath } from '../../src/main/vault-index-service'
import { registerSwitcherIpcHandlers } from '../../src/main/vault-switcher-ipc'
import type { WindowSwitchOutcome } from '../../src/main/window-switch'

let base: string
let vault: string
let plain: string
let cacheDir: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'wf-switcher-'))
  vault = join(base, 'reports-and-proposals-draft')
  plain = join(base, 'guides')
  cacheDir = join(base, 'userData', 'vault-index')
  await mkdir(join(vault, '.writeflex'), { recursive: true })
  await writeFile(join(vault, '.writeflex', 'vault.json'), JSON.stringify({ version: 1, name: 'Reports and proposals' }))
  await mkdir(plain)
  await writeFile(join(plain, 'note.md'), '# Note\n')
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

test('a vault is named from its vault.json; its count comes from the userData snapshot, — without one', async () => {
  expect(await rootPresence(vault, { cacheDir })).toEqual({ kind: 'vault', name: 'Reports and proposals', works: null })
  await mkdir(cacheDir, { recursive: true })
  await writeFile(vaultSnapshotPath(cacheDir, vault), JSON.stringify({ root: vault, index: { works: [{}, {}, {}] } }))
  expect(await rootPresence(vault, { cacheDir })).toEqual({ kind: 'vault', name: 'Reports and proposals', works: 3 })
  // A snapshot written for another root (a hash collision, a moved file) is not believed.
  await writeFile(vaultSnapshotPath(cacheDir, plain), JSON.stringify({ root: vault, index: { works: [{}] } }))
  expect(await cachedWorkCount(cacheDir, plain)).toBeNull()
})

test('a plain folder is a folder, a gone one is missing, and looking creates nothing in any of them', async () => {
  const before = await readdir(plain)
  const presences = await rootPresences([plain, join(base, 'gone'), vault], { cacheDir: null })
  expect(presences.get(plain)).toEqual({ kind: 'folder' })
  expect(presences.get(join(base, 'gone'))).toEqual({ kind: 'missing' })
  expect(presences.get(vault)).toEqual({ kind: 'vault', name: 'Reports and proposals', works: null })
  expect(await readdir(plain)).toEqual(before)
  expect(await readdir(join(vault, '.writeflex'))).toEqual(['vault.json'])
})

test('an unreadable vault.json still makes a vault, named after its folder', async () => {
  await writeFile(join(vault, '.writeflex', 'vault.json'), 'not json')
  expect(await rootPresence(vault, { cacheDir: null })).toEqual({ kind: 'vault', name: 'reports-and-proposals-draft', works: null })
})

type State = { id: number; root: string | null }

function channels(over: { known?: string[]; picked?: { root: string; focusFile: string | null } | null; outcome?: WindowSwitchOutcome<State> } = {}) {
  const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  const state: State = { id: 1, root: vault }
  const calls: Array<{ root: string; focusFile: string | null }> = []
  registerSwitcherIpcHandlers<State>({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => state,
    rootOf: (s) => s.root,
    lists: () => ({ pinned: [plain], recents: [vault] }),
    presence: (roots) => rootPresences(roots, { cacheDir: null }),
    home: base,
    isKnownRoot: async (root) => (over.known ?? [plain, vault]).includes(root),
    pickRoot: async () => over.picked ?? null,
    switchWindow: async (_s, root, focusFile) => {
      calls.push({ root, focusFile })
      return over.outcome ?? { status: 'switched', root, window: { id: 2, root } }
    },
  })
  const call = (channel: string, input?: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input)
  return { call, calls, state }
}

test('workspace:switcher-list sorts the pins and recents into Vaults and Folders, the window\'s root ticked', async () => {
  const { call } = channels()
  expect(await call('workspace:switcher-list')).toEqual({
    vaults: [{ root: vault, name: 'Reports and proposals', works: null, current: true }],
    folders: [{ root: plain, name: 'guides', parent: '~', current: false }],
    currentIsVault: true,
  })
})

test('workspace:switch takes only a known root and reports what main did, never the window itself', async () => {
  const { call, calls } = channels()
  expect(await call('workspace:switch', { root: plain, checkpoint: ['a.md'] })).toEqual({ status: 'switched', root: plain })
  expect(calls).toEqual([{ root: plain, focusFile: null }])
  await expect(Promise.resolve(call('workspace:switch', { root: '/etc' }))).rejects.toThrow('Refusing to open a folder that is not in Recents or Pinned.')
  await expect(Promise.resolve(call('workspace:switch', {}))).rejects.toThrow('Name a folder to switch to.')
  expect(calls).toHaveLength(1)
  for (const outcome of [{ status: 'focused', root: plain }, { status: 'stayed' }, { status: 'switching' }, { status: 'busy' }, { status: 'unchanged' }] as const) {
    const other = channels({ outcome })
    expect(await other.call('workspace:switch', { root: plain })).toEqual(outcome)
  }
})

test('workspace:switch with the dialog: cancelled changes nothing; a picked file opens its root at that file', async () => {
  const cancelled = channels({ picked: null })
  expect(await cancelled.call('workspace:switch', { dialog: true })).toEqual({ status: 'cancelled' })
  expect(cancelled.calls).toEqual([])
  // The dialog is main's own consent gate: its pick is admitted without being a recent.
  const file = channels({ known: [], picked: { root: '/anywhere/picked', focusFile: 'chapter.md' } })
  expect(await file.call('workspace:switch', { dialog: true })).toEqual({ status: 'switched', root: '/anywhere/picked' })
  expect(file.calls).toEqual([{ root: '/anywhere/picked', focusFile: 'chapter.md' }])
})
