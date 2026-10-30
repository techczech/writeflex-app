import { afterAll, beforeAll, expect, test } from 'bun:test'
import { confirmRoomOrder, refreshRoom, subscribeRoom, type RoomAnswer } from '../../src/renderer/src/plan/folio-room-store'
import { roomPartRenderKey, type FolioRoomModel, type RoomPart } from '../../src/shared/folio-room'

const previousWindow = globalThis.window
let read: (dir: string, essential?: boolean) => Promise<FolioRoomModel | null>
let collectionChanged: () => void
beforeAll(() => {
  globalThis.window = { writeflex: {
    folioRoom: { read: (dir: string, essential?: boolean) => read(dir, essential) },
    onCollectionChanged: (callback: () => void) => { collectionChanged = callback; return () => {} },
    onFileChangedOnDisk: () => () => {},
  } } as unknown as Window & typeof globalThis
})
afterAll(() => { globalThis.window = previousWindow })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 200 && !condition(); attempts++) await Bun.sleep(2)
  expect(condition()).toBe(true)
}
const part = (title: string, index: number, synopsis = '') => ({ key: { title, path: null }, title, index, synopsis }) as RoomPart
const complete = (dir: string, parts = [part('One', 0)]): FolioRoomModel => ({
  dir, parts, binder: { research: [], notes: [], ideas: [], bin: [{ id: 'kept' }] },
  evidence: { parts: { one: { notes: 'Saved notes' } } }, map: { path: 'map.canvas' },
}) as unknown as FolioRoomModel

test('essential data is first-entry only; save refreshes and failures retain complete evidence, map and bin until replacement', async () => {
  const dir = 'store-refresh'
  const initial = complete(dir)
  const enrichment = deferred<FolioRoomModel | null>()
  const calls: Array<boolean | undefined> = []
  read = async (_dir, essential) => { calls.push(essential); return essential ? { ...initial, evidence: undefined, map: undefined, binder: { research: [], notes: [], ideas: [] }, enrichment: 'pending' } : enrichment.promise }
  const answers: RoomAnswer[] = []
  const off = subscribeRoom(dir, answer => answers.push(answer))
  try {
    await until(() => calls.length === 2)
    expect(answers).toHaveLength(1)
    enrichment.resolve(initial)
    await until(() => answers.length === 2)
    const refresh = deferred<FolioRoomModel | null>()
    read = async (_dir, essential) => { calls.push(essential); return refresh.promise }
    collectionChanged()
    await until(() => calls.length === 3)
    expect(calls).toEqual([true, undefined, undefined])
    expect(answers).toHaveLength(2)
    expect(answers.at(-1)).toEqual({ model: initial })
    refresh.reject(new Error('disk temporarily unavailable'))
    await Bun.sleep(5)
    expect(answers).toHaveLength(2)
    const fresh = { ...initial, evidence: { ...initial.evidence!, message: 'fresh' } }
    read = async (_dir, essential) => { calls.push(essential); return fresh }
    refreshRoom(dir, true)
    await until(() => answers.length === 3)
    expect(answers.at(-1)).toEqual({ model: fresh })
    expect(calls.at(-1)).toBeUndefined()
  } finally { off() }
})

test('confirmed order consumes duplicate unwritten identities once, and stale refreshes cannot replace it', async () => {
  const dir = 'store-order'
  const first = complete(dir, [part('Repeat', 0, 'first'), part('Repeat', 1, 'second'), part('Other', 2)])
  read = async () => first
  const answers: RoomAnswer[] = []
  const off = subscribeRoom(dir, answer => answers.push(answer))
  try {
    await until(() => answers.length === 1)
    const old = deferred<FolioRoomModel | null>()
    let started = false
    read = async () => { started = true; return old.promise }
    refreshRoom(dir, true)
    await until(() => started)
    confirmRoomOrder(dir, [first.parts[2].key, first.parts[0].key, first.parts[1].key])
    const confirmed = (answers.at(-1) as { model: FolioRoomModel }).model
    expect(confirmed.parts.map(part => part.synopsis)).toEqual(['', 'first', 'second'])
    expect(new Set(confirmed.parts.map(part => roomPartRenderKey(part, confirmed.parts))).size).toBe(3)
    // Written identities do not acquire an index key on an ordinary move.
    const written = { ...first.parts[0], key: { title: 'Written', path: 'one.md' } }
    expect(roomPartRenderKey(written, [written])).toBe(roomPartRenderKey({ ...written, index: 4 }, [written]))
    read = async () => confirmed
    old.resolve(first)
    await until(() => answers.length >= 3)
    expect(answers.slice(1).every(answer => 'model' in answer && answer.model?.parts[0].title === 'Other')).toBe(true)
  } finally { off() }
})
