/**
 * The vault file's own watcher (vault-watcher.ts): only `vault.json` in `.writeflex` counts, a
 * `.writeflex` that appears later is picked up, a stream of touches still notifies within the maximum
 * wait, and dispose stops everything.
 *
 * Seams: `boundedDebounce` with real timers at small values, `watchVaultFile` with a fake native watch
 * over a real temporary folder, and one smoke test over the real native watch.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundedDebounce, watchVaultFile, type WatchFunction } from '../../src/main/vault-watcher'

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-vault-watch-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A fake native watch: `emit(path, filename)` delivers an event to the live watcher on `path`. */
function fakeWatch(): { watch: WatchFunction; emit: (path: string, filename: string | null) => void; open: () => string[] } {
  const live = new Map<string, (filename: string | null) => void>()
  return {
    watch: (path, listener) => {
      live.set(path, listener)
      return { close: () => { if (live.get(path) === listener) live.delete(path) }, on: () => ({}) as never }
    },
    emit: (path, filename) => live.get(path)?.(filename),
    open: () => [...live.keys()].sort(),
  }
}

test('a steady stream of touches still notifies within the maximum wait, and again after it', async () => {
  let calls = 0
  const debounce = boundedDebounce(() => { calls += 1 }, 40, 100)
  const started = Date.now()
  let firstAt = 0
  while (Date.now() - started < 330) {
    debounce.touch()
    if (calls > 0 && firstAt === 0) firstAt = Date.now() - started
    await settle(10)
  }
  debounce.dispose()
  expect(firstAt).toBeGreaterThan(0)
  expect(firstAt).toBeLessThan(200)
  expect(calls).toBeGreaterThanOrEqual(2)
})

test('a burst followed by quiet is one call after the wait; dispose drops a pending call', async () => {
  let calls = 0
  const debounce = boundedDebounce(() => { calls += 1 }, 20, 1_000)
  debounce.touch()
  debounce.touch()
  await settle(60)
  expect(calls).toBe(1)
  debounce.touch()
  debounce.dispose()
  await settle(60)
  expect(calls).toBe(1)
})

test('only vault.json in .writeflex counts; a .writeflex made later is attached; dispose closes every watch', async () => {
  const fake = fakeWatch()
  let touched = 0
  const watch = watchVaultFile(root, () => { touched += 1 }, { debounceMs: 10, maxWaitMs: 100, watch: fake.watch })
  const folder = join(root, '.writeflex')
  // No .writeflex yet: only the root is watched; an unrelated root entry tells nothing.
  expect(fake.open()).toEqual([root])
  fake.emit(root, 'notes.md')
  await settle(30)
  expect(touched).toBe(0)
  // File sync brings the folder: it is attached and its arrival is told.
  await mkdir(folder)
  fake.emit(root, '.writeflex')
  await settle(30)
  expect(fake.open()).toEqual([root, folder].sort())
  expect(touched).toBe(1)
  // Inside the folder only vault.json counts, never temporary files or other store files.
  fake.emit(folder, '.vault.json.a1b2c3.tmp')
  fake.emit(folder, 'versions.jsonl')
  await settle(30)
  expect(touched).toBe(1)
  fake.emit(folder, 'vault.json')
  await settle(30)
  expect(touched).toBe(2)
  watch.dispose()
  expect(fake.open()).toEqual([])
  fake.emit(folder, 'vault.json')
  await settle(30)
  expect(touched).toBe(2)
})

test('over the real native watch: a vault.json renamed into place, and then rewritten, is noticed each time', async () => {
  let touched = 0
  const watch = watchVaultFile(root, () => { touched += 1 }, { debounceMs: 20 })
  try {
    await mkdir(join(root, '.writeflex'))
    await settle(300)
    const afterFolder = touched
    await writeFile(join(root, '.writeflex', '.incoming.tmp'), '{"name":"A"}')
    await rename(join(root, '.writeflex', '.incoming.tmp'), join(root, '.writeflex', 'vault.json'))
    await settle(300)
    expect(touched).toBeGreaterThan(afterFolder)
    const afterRename = touched
    await writeFile(join(root, '.writeflex', 'vault.json'), '{"name":"B"}')
    await settle(300)
    expect(touched).toBeGreaterThan(afterRename)
  } finally {
    watch.dispose()
  }
})

/** A fake native watch that can also fail: `fail(path)` emits `error` on the live watcher on `path`. */
function failingWatch(): { watch: WatchFunction; emit: (path: string, filename: string | null) => void; fail: (path: string) => void; opened: string[] } {
  const live = new Map<string, { listener: (filename: string | null) => void; onError: Array<() => void> }>()
  const opened: string[] = []
  return {
    watch: (path, listener) => {
      opened.push(path)
      const entry = { listener, onError: [] as Array<() => void> }
      live.set(path, entry)
      const watcher = {
        close: () => { if (live.get(path) === entry) live.delete(path) },
        on: (event: string, handler: () => void) => {
          if (event === 'error') entry.onError.push(handler)
          return watcher as never
        },
      }
      return watcher as never
    },
    emit: (path, filename) => live.get(path)?.listener(filename),
    fail: (path) => { for (const handler of live.get(path)?.onError ?? []) handler() },
    opened,
  }
}

test('on a volume that ignores case, VAULT.JSON and .WRITEFLEX events count; on one that does not, only exact names', async () => {
  const folder = join(root, '.writeflex')
  await mkdir(folder)
  for (const ignoresCase of [true, false]) {
    const fake = fakeWatch()
    let touched = 0
    const watch = watchVaultFile(root, () => { touched += 1 }, { debounceMs: 10, maxWaitMs: 100, watch: fake.watch, ignoresCase: Promise.resolve(ignoresCase) })
    await settle(5)
    fake.emit(folder, 'VAULT.JSON')
    await settle(30)
    expect(touched).toBe(ignoresCase ? 1 : 0)
    fake.emit(root, '.WRITEFLEX')
    await settle(30)
    expect(touched).toBe(ignoresCase ? 2 : 0)
    fake.emit(folder, 'vault.json')
    await settle(30)
    expect(touched).toBe(ignoresCase ? 3 : 1)
    watch.dispose()
  }
})

test('a folder or root watch that errors is closed and attached again with backoff while held; each re-attach looks once', async () => {
  const folder = join(root, '.writeflex')
  await mkdir(folder)
  const fake = failingWatch()
  let touched = 0
  const watch = watchVaultFile(root, () => { touched += 1 }, { debounceMs: 5, maxWaitMs: 50, watch: fake.watch, retryDelaysMs: [20, 100] })
  expect(fake.opened).toEqual([root, folder])
  // The folder watch fails: nothing is watched there until the first delay has passed.
  fake.fail(folder)
  fake.emit(folder, 'vault.json')
  await settle(10)
  expect(touched).toBe(0)
  await settle(40)
  expect(fake.opened).toEqual([root, folder, folder])
  expect(touched).toBe(1)
  fake.emit(folder, 'vault.json')
  await settle(20)
  expect(touched).toBe(2)
  // It fails again at once: the second delay is longer.
  fake.fail(folder)
  await settle(50)
  expect(fake.opened.length).toBe(3)
  await settle(80)
  expect(fake.opened.length).toBe(4)
  // A root-watch error re-attaches the root watch too (it had lived past the longest delay: the count restarts).
  fake.fail(root)
  await settle(60)
  expect(fake.opened.filter((path) => path === root).length).toBe(2)
  fake.emit(root, '.writeflex')
  // Disposed: a pending retry never re-attaches.
  fake.fail(folder)
  watch.dispose()
  const count = fake.opened.length
  await settle(150)
  expect(fake.opened.length).toBe(count)
})

test('a re-attached watch that lived past the longest delay resets the backoff once; repeated synchronous failures then advance it', async () => {
  const folder = join(root, '.writeflex')
  await mkdir(folder)
  const fake = failingWatch()
  let broken = false
  const times: number[] = []
  const watch = watchVaultFile(root, () => {}, {
    debounceMs: 5,
    maxWaitMs: 50,
    retryDelaysMs: [20, 60, 200],
    watch: (path, listener) => {
      if (path === folder) {
        times.push(Date.now())
        if (broken) throw new Error('watch refused')
      }
      return fake.watch(path, listener)
    },
  })
  // The first attach lives longer than the longest delay (200 ms), so the next failure resets the count once.
  await settle(220)
  broken = true
  fake.fail(folder)
  await settle(400)
  watch.dispose()
  // Retries after the reset: 20 ms (the first delay), then 60 ms and 200 ms. Without the reset being consumed, every gap is 20 ms.
  expect(times.length).toBeGreaterThanOrEqual(4)
  const gap1 = times[2]! - times[1]!
  const gap2 = times[3]! - times[2]!
  expect(gap1).toBeGreaterThanOrEqual(50)
  expect(gap2).toBeGreaterThanOrEqual(150)
})
