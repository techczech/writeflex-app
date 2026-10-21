/**
 * The vault channels (vault-ipc.ts): the root is always the asking window's own binding, no channel
 * takes a root or file, and the change push reaches every window on that root and no other.
 *
 * Seam: `registerVaultIpcHandlers` with a fake registrar and window states over a real temporary folder.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerVaultIpcHandlers, VAULT_CHANGED_CHANNEL } from '../../src/main/vault-ipc'
import { vaultStoreFor } from '../../src/main/vault-store'

type State = { id: number; root: string | null }
let rootA: string
let rootB: string
let handlers: Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>
let sent: Array<{ id: number; channel: string; payload: unknown }>
let unsubscribe: () => void
let states: State[]

beforeEach(async () => {
  rootA = await mkdtemp(join(tmpdir(), 'wf-vault-ipc-a-'))
  rootB = await mkdtemp(join(tmpdir(), 'wf-vault-ipc-b-'))
  await mkdir(join(rootA, 'reports'))
  states = [{ id: 1, root: rootA }, { id: 2, root: rootA }, { id: 3, root: rootB }, { id: 4, root: null }]
  handlers = new Map()
  sent = []
  unsubscribe = registerVaultIpcHandlers<State>({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: (id) => states.find((state) => state.id === id)!,
    rootOf: (state) => state.root,
    allStates: () => states,
    send: (state, channel, payload) => sent.push({ id: state.id, channel, payload }),
  })
})
afterEach(async () => {
  unsubscribe()
  await rm(rootA, { recursive: true, force: true })
  await rm(rootB, { recursive: true, force: true })
})

const call = (channel: string, id: number, input?: unknown): Promise<any> => Promise.resolve(handlers.get(channel)!({ sender: { id } }, input))

test('only vault operations are registered', () => {
  expect([...handlers.keys()].sort()).toEqual(['vault:add-pin', 'vault:create', 'vault:get', 'vault:remove-pin', 'vault:reorder-pins', 'vault:save'])
})

test('create and pin act on the sender window\'s root, whatever root the input names', async () => {
  expect(await call('vault:get', 1)).toBeNull()
  expect((await call('vault:create', 1, { name: 'A', root: rootB })).ok).toBe(true)
  expect(existsSync(join(rootB, '.writeflex'))).toBe(false)
  expect((await call('vault:add-pin', 1, { path: 'reports', root: rootB })).ok).toBe(true)
  expect(JSON.parse(await readFile(join(rootA, '.writeflex', 'vault.json'), 'utf8')).pins).toEqual(['reports'])
  expect(await call('vault:get', 3)).toBeNull()
})

test('a window with no root gets a refusal and null', async () => {
  expect(await call('vault:get', 4)).toBeNull()
  expect(await call('vault:create', 4)).toMatchObject({ ok: false, reason: 'not-a-vault' })
})

test('a change is pushed to every window on that root and to no other', async () => {
  await call('vault:create', 1, { name: 'A' })
  expect(sent.map((entry) => entry.id).sort()).toEqual([1, 2])
  expect(sent.every((entry) => entry.channel === VAULT_CHANGED_CHANNEL)).toBe(true)
  expect(sent[0]?.payload).toMatchObject({ outside: false, vault: { settings: { name: 'A' } } })
  // An outside change, noticed by the watcher of either window, is pushed once to both.
  sent = []
  await Bun.write(join(rootA, '.writeflex', 'vault.json'), '{"name":"Elsewhere"}')
  await vaultStoreFor(rootA).noticeDiskChange()
  await vaultStoreFor(rootA).noticeDiskChange()
  expect(sent.map((entry) => entry.id).sort()).toEqual([1, 2])
  expect(sent[0]?.payload).toMatchObject({ outside: true, vault: { settings: { name: 'Elsewhere' } } })
})

test('the first read of a root starts its own vault watcher (no setting involved); it notices, is pruned and disposed', async () => {
  const started: string[] = []
  const stopped: string[] = []
  const touches = new Map<string, () => void>()
  const own = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  const ownSent: number[] = []
  const stop = registerVaultIpcHandlers<State>({ handle: (channel, handler) => own.set(channel, handler) }, {
    stateForSender: (id) => states.find((state) => state.id === id)!,
    rootOf: (state) => state.root,
    allStates: () => states,
    send: (state) => ownSent.push(state.id),
    watchVault: (root, onTouched) => {
      started.push(root)
      touches.set(root, onTouched)
      return { dispose: () => stopped.push(root) }
    },
  })
  const get = (id: number): Promise<unknown> => Promise.resolve(own.get('vault:get')!({ sender: { id } }))
  try {
    await get(1)
    await get(2)
    await get(3)
    expect(started).toEqual([rootA, rootB])
    // Another Mac writes the file: the watcher's touch makes the store look, and both windows on A hear of it.
    await mkdir(join(rootA, '.writeflex'))
    await Bun.write(join(rootA, '.writeflex', 'vault.json'), '{"name":"From the other Mac"}')
    touches.get(rootA)!()
    for (let i = 0; i < 50 && ownSent.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(ownSent.sort()).toEqual([1, 2])
    // Window 3 leaves root B: its watcher stops at the next read.
    states = states.map((state) => (state.id === 3 ? { ...state, root: null } : state))
    await get(1)
    expect(stopped).toEqual([rootB])
  } finally {
    stop()
  }
  expect(stopped.sort()).toEqual([rootA, rootB].sort())
})

test('a window closing or leaving its root stops that root\'s watcher at once (no further read); a touch prunes too', async () => {
  const stopped: string[] = []
  const touches = new Map<string, () => void>()
  const released = new Set<() => void>()
  const own = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  const stop = registerVaultIpcHandlers<State>({ handle: (channel, handler) => own.set(channel, handler) }, {
    stateForSender: (id) => states.find((state) => state.id === id)!,
    rootOf: (state) => state.root,
    allStates: () => states,
    send: () => {},
    onWindowReleased: (listener) => {
      released.add(listener)
      return () => released.delete(listener)
    },
    watchVault: (root, onTouched) => {
      touches.set(root, onTouched)
      return { dispose: () => stopped.push(root) }
    },
  })
  const get = (id: number): Promise<unknown> => Promise.resolve(own.get('vault:get')!({ sender: { id } }))
  try {
    await get(1)
    await get(3)
    // The last window on root B closes: its state is gone, and the release is told. Nothing is read.
    states = states.filter((state) => state.id !== 3)
    for (const listener of released) listener()
    expect(stopped).toEqual([rootB])
    // Window 1 switches away while window 2 still holds A: A's watcher stays.
    states = states.map((state) => (state.id === 1 ? { ...state, root: rootB } : state))
    for (const listener of released) listener()
    expect(stopped).toEqual([rootB])
    // Window 2 leaves A without any release being told; A's next touch (an unchanged file) stops it.
    states = states.map((state) => (state.id === 2 ? { ...state, root: null } : state))
    touches.get(rootA)!()
    expect(stopped).toEqual([rootB, rootA])
  } finally {
    stop()
  }
  expect(released.size).toBe(0)
})
