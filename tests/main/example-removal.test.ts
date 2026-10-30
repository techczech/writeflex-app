import { afterAll, afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { cleanUpScratch, trackScratch } from '../helpers/scratch-dirs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { EXAMPLE_ASSET_FILES, EXAMPLE_BUNDLE_FILES, EXAMPLE_LESSON_FILES, EXAMPLE_ORIGINAL_FILES, ExampleCollection } from '../../src/main/example-collection'
import {
  EXAMPLE_BIN_OVERRIDE,
  EXAMPLE_REMOVAL_TEXT,
  EXAMPLE_CONFIRMATION_MS,
  EXAMPLE_CLOSE_MS,
  EXAMPLE_COUNT_LIMIT,
  ExampleRemoval,
  harnessBinInsideTemp,
  resolveExampleTrash,
  type ExampleRemoveResult,
  type ExampleRemovalDeps,
  type ExampleRemovalFs,
} from '../../src/main/example-removal'
import { GuideProgressStore } from '../../src/main/guide-progress-store'
import { acquireOwnerLock, releaseOwnerLock } from '../../src/main/owner-lock'
import { SettingsStore } from '../../src/main/settings'
import { startScreenModel } from '../../src/main/start-screen-model'

// Removing the Example collection and bringing it back (ticket 10), by the rules A–G at the top of
// src/main/example-removal.ts. Everything runs in a temporary home. The module reaches the disk
// only through its port (lstat, realpath, readdir, exclusive mkdir, exclusive create), fenced here
// so ANY call naming a path outside the temporary Documents directory fails the test. The trash
// function is the test's own: it moves the folder into a `.Trash` inside the temporary home, so the
// real Bin and the real home are never touched.

const REAL_BUNDLE = resolve(import.meta.dir, '../../resources/example-collection')

const outside: string[] = []
afterEach(() => {
  const seen = outside.splice(0)
  expect(seen).toEqual([])
})

type Method = keyof ExampleRemovalFs
type Hook = (method: Method, path: string) => void | Promise<void>

function fencedFs(documents: string, calls: string[], hook?: Hook): ExampleRemovalFs {
  const check = async (method: Method, path: string): Promise<void> => {
    const resolved = resolve(path)
    if (resolved !== documents && !resolved.startsWith(documents + sep)) {
      outside.push(`${method} ${path}`)
      throw new Error(`The removal module reached outside Documents: ${method} ${path}`)
    }
    calls.push(`${method} ${relative(documents, path)}`)
    await hook?.(method, path)
  }
  return {
    lstat: async (path) => { await check('lstat', path); return lstat(path) },
    realpath: async (path) => { await check('realpath', path); return realpath(path) },
    readdir: async (path) => { await check('readdir', path); return readdir(path, { withFileTypes: true }) },
    mkdir: async (path) => { await check('mkdir', path); await mkdir(path) },
    writeNewFile: async (path, data) => { await check('writeNewFile', path); await writeFile(path, data, { flag: 'wx', mode: 0o644 }) },
  }
}

/** Main's number for the window that asks, as `event.sender.id` would be. */
const WINDOW = 7
const OTHER_WINDOW = 8
const TOKEN = /^[0-9a-f]{64}$/

type Launch = {
  /** Look (preview), then confirm with the token that came back, as the confirmation does. `between`
   *  runs after the look and before the confirm: what changed while the confirmation was open. */
  confirmRemove: (between?: () => void | Promise<void>) => Promise<ExampleRemoveResult>
  /** A look that must succeed; its token. */
  look: (sender?: number) => Promise<string>
  store: SettingsStore
  collection: ExampleCollection
  removal: ExampleRemoval
  /** Every path the trash function was given. */
  trashed: string[]
  /** Every path the window port was asked to close the windows of. */
  closed: string[]
  /** Port calls, as `method relative-path`. */
  calls: string[]
  /** What happened, in order: `close` (with the state and whether the folder was there), `trash`. */
  order: string[]
}
type Sandbox = {
  home: string
  documents: string
  parent: string
  example: string
  bin: string
  settingsPath: string
  launch: (overrides?: Partial<ExampleRemovalDeps>, hook?: Hook) => Launch
}

async function sandbox(): Promise<Sandbox> {
  const base = trackScratch(await realpath(await mkdtemp(join(tmpdir(), 'wf-example-removal-'))))
  const home = join(base, 'home')
  const documents = join(home, 'Documents')
  const bin = join(home, '.Trash')
  await mkdir(documents, { recursive: true })
  await mkdir(bin)
  const settingsPath = join(base, 'userData', 'settings.json')
  return {
    home, documents, bin, settingsPath,
    parent: join(documents, 'WriteFlex'),
    example: join(documents, 'WriteFlex', 'Example collection'),
    launch: (overrides = {}, hook) => {
      const trashed: string[] = []
      const closed: string[] = []
      const calls: string[] = []
      const order: string[] = []
      let collection: ExampleCollection | null = null
      const store = new SettingsStore(settingsPath, { shownExampleRoot: () => collection?.shownRoot() ?? null })
      collection = new ExampleCollection({ documentsDir: () => documents, bundledDir: REAL_BUNDLE, store, home: () => home })
      const removal = new ExampleRemoval({
        documentsDir: () => documents,
        bundledDir: REAL_BUNDLE,
        store,
        home: () => home,
        trash: async (path) => {
          trashed.push(path)
          order.push('trash')
          await rename(path, join(bin, `Example collection ${trashed.length}`))
        },
        closeWindows: async (root) => { closed.push(root); order.push(`close:${store.exampleState()}:${existsSync(root) ? 'there' : 'gone'}`); return 'closed' },
        ownLocksReleased: async () => {},
        fs: fencedFs(documents, calls, hook),
        ...overrides,
      })
      const look = async (sender = WINDOW): Promise<string> => {
        const preview = await removal.preview(sender)
        if (!preview.ok) throw new Error(`The look was refused: ${preview.message}`)
        return preview.token
      }
      const confirmRemove: Launch['confirmRemove'] = async (between) => {
        const token = await look()
        await between?.()
        return removal.remove(token, WINDOW)
      }
      return { confirmRemove, look, store, collection, removal, trashed, closed, calls, order }
    },
  }
}

/** A sandbox in which the first run has written the example, with files of the person's own beside it. */
async function written(): Promise<Sandbox> {
  const box = await sandbox()
  expect(await box.launch().collection.ensure()).toBe('written')
  await writeFile(join(box.documents, 'letter.md'), 'Dear Ann\n')
  await mkdir(join(box.documents, 'walking-book'))
  await writeFile(join(box.documents, 'walking-book', 'Chapter 1.md'), 'Leaving the village\n')
  await writeFile(join(box.parent, 'notes of my own.md'), 'beside the example\n')
  await writeFile(join(box.home, 'outside Documents.txt'), 'home\n')
  return box
}

/** Every path under `dir` with its kind, inode, bytes (hashed) and modified time. Directories by inode only. */
async function snapshot(dir: string, skip: string[] = []): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name)
      if (skip.includes(path)) continue
      const info = await lstat(path)
      const key = relative(dir, path)
      if (info.isSymbolicLink()) out[key] = 'symlink'
      else if (info.isDirectory()) {
        out[key] = `dir ino:${info.ino}`
        await walk(path)
      } else out[key] = `file ino:${info.ino} ${createHash('sha256').update(await readFile(path)).digest('hex')} mtime:${info.mtimeMs}`
    }
  }
  await walk(dir)
  return out
}

const savedState = async (box: Sandbox): Promise<unknown> => (JSON.parse(await readFile(box.settingsPath, 'utf8')).example as { state?: unknown } | undefined)?.state
/** The settings file without the example record, as text: everything removal and restore must leave alone. */
const settingsBesidesExample = async (box: Sandbox): Promise<string> => {
  const data = JSON.parse(await readFile(box.settingsPath, 'utf8')) as Record<string, unknown>
  delete data.example
  return JSON.stringify(data)
}
const writeMode = (call: string): boolean => call.startsWith('mkdir ') || call.startsWith('writeNewFile ')

// ---- remove ---------------------------------------------------------------------------------

test('folder present: one trash call on the fixed path, the folder is in the Bin and absent at its path, and no other file changed', async () => {
  const box = await written()
  const before = await snapshot(box.home, [box.example, box.bin])
  const inFolder = await snapshot(box.example)
  const launch = box.launch()
  expect(await launch.collection.current()).toBe(box.example)

  expect(await launch.confirmRemove()).toEqual({ ok: true, outcome: 'moved-to-bin' })

  expect(launch.trashed).toEqual([box.example])
  expect(existsSync(box.example)).toBe(false)
  // The same files, same bytes, same modified times, now in the Bin: moved, not deleted or rewritten.
  const binned = await snapshot(join(box.bin, 'Example collection 1'))
  expect(binned).toEqual(inFolder)
  expect(await snapshot(box.home, [box.example, box.bin])).toEqual(before)
  expect(launch.calls.filter(writeMode)).toEqual([])
  // Off the start screen: the record is `removed`, and neither marked entry is in the model.
  expect(await savedState(box)).toBe('removed')
  expect(await launch.collection.current()).toBeNull()
  expect((await startScreenModel(launch.store, launch.collection)).example).toBeNull()
})

test('the example is never under Pinned or Recent, before or after removal', async () => {
  const box = await written()
  const launch = box.launch()
  await launch.collection.current()
  launch.store.touchRecent(box.example)
  launch.store.pin(box.example)
  expect((await startScreenModel(launch.store, launch.collection)).recents).toEqual([])
  await launch.confirmRemove()
  const model = await startScreenModel(launch.store, launch.collection)
  expect(model).toEqual({ example: null, pinned: [], recents: [] })
})

test('folder already gone: recorded as removed with no trash call and no error', async () => {
  const box = await written()
  await rename(box.example, join(box.home, 'moved away by the person'))
  const launch = box.launch()
  expect(await launch.confirmRemove()).toEqual({ ok: true, outcome: 'already-gone' })
  expect(launch.trashed).toEqual([])
  expect(await savedState(box)).toBe('removed')
  expect(await launch.collection.current()).toBeNull()
})

test('WriteFlex folder gone too: recorded as removed, nothing created', async () => {
  const box = await sandbox()
  expect(await box.launch().collection.ensure()).toBe('written')
  await rename(box.parent, join(box.home, 'WriteFlex moved'))
  const launch = box.launch()
  expect(await launch.confirmRemove()).toEqual({ ok: true, outcome: 'already-gone' })
  expect(launch.trashed).toEqual([])
  expect(existsSync(box.parent)).toBe(false)
})

test('folder open in a window: its windows are closed first, while the folder is there and the record written, and only then is it trashed', async () => {
  const box = await written()
  const launch = box.launch()
  expect(await launch.confirmRemove()).toEqual({ ok: true, outcome: 'moved-to-bin' })
  // Closed while the folder was still there and the record still `written`; then trash; then `removed`.
  expect(launch.order).toEqual(['close:written:there', 'trash'])
  expect(launch.closed).toEqual([box.example])
  expect(launch.store.exampleState()).toBe('removed')
})

test('dirty and saved: what the window writes as it closes is what goes to the Bin', async () => {
  const box = await written()
  const lesson = join(box.example, EXAMPLE_LESSON_FILES[1]!)
  const asked: string[] = []
  const launch = box.launch({
    // The window's close: the text typed a moment ago reaches the disk as it closes, not before.
    closeWindows: async (root) => {
      asked.push(root)
      expect(launch.trashed).toEqual([])
      await writeFile(lesson, 'typed just before removing\n')
      return 'closed'
    },
  })
  expect(await launch.confirmRemove()).toEqual({ ok: true, outcome: 'moved-to-bin' })
  expect(asked).toEqual([box.example])
  expect(launch.trashed).toEqual([box.example])
  expect(await readFile(join(box.bin, 'Example collection 1', EXAMPLE_LESSON_FILES[1]!), 'utf8')).toBe('typed just before removing\n')
  expect(launch.store.exampleState()).toBe('removed')
})

test('held by another program (the writeflex command): nothing is binned or recorded, one sentence says so; once it lets go, removal goes ahead', async () => {
  const box = await written()
  const launch = box.launch()
  await launch.collection.current()
  const settingsBefore = await readFile(box.settingsPath, 'utf8')
  const lock = await acquireOwnerLock(box.example, { kind: 'command-line' })
  try {
    expect(await launch.confirmRemove()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.inUse })
    expect(launch.trashed).toEqual([])
    expect(launch.store.exampleState()).toBe('written')
    expect(await readFile(box.settingsPath, 'utf8')).toBe(settingsBefore)
    expect(existsSync(join(box.example, '00 Start here.md'))).toBe(true)
  } finally {
    await releaseOwnerLock(lock)
  }
  expect(EXAMPLE_REMOVAL_TEXT.inUse.match(/[.!?]/g)).toHaveLength(1)
  const again = box.launch()
  expect(await again.confirmRemove()).toEqual({ ok: true, outcome: 'moved-to-bin' })
})

test('this app\'s own owner lock on the example is released, and waited for, before the trash runs', async () => {
  const box = await written()
  // The example open in a window of this app: its owner lock, as the window's claim takes it.
  let own: Awaited<ReturnType<typeof acquireOwnerLock>> | null = null
  const lockFile = join(box.example, '.writeflex', 'owner.lock')
  const launch = box.launch({
    closeWindows: async () => {
      launch.order.push('close')
      return 'closed'
    },
    // The window's release runs after its close and takes a moment (its agent and requests settle first).
    ownLocksReleased: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      await releaseOwnerLock(own!)
      launch.order.push('released')
    },
    trash: async (path) => {
      launch.order.push(`trash:${existsSync(lockFile) ? 'locked' : 'free'}`)
      launch.trashed.push(path)
      await rename(path, join(box.bin, 'Example collection 1'))
    },
  })
  own = await acquireOwnerLock(box.example, { kind: 'app' })
  expect(existsSync(lockFile)).toBe(true)
  const token = await launch.look()
  expect(await launch.removal.remove(token, WINDOW)).toEqual({ ok: true, outcome: 'moved-to-bin' })
  expect(launch.order).toEqual(['close', 'released', 'trash:free'])
})

test('this app\'s own owner lock still on the example after its release failed: refused with its own sentence, not blamed on another program, nothing binned', async () => {
  const box = await written()
  const launch = box.launch()
  await launch.collection.current()
  // The window's lock was never let go: it is on disk, and it names this process.
  const own = await acquireOwnerLock(box.example, { kind: 'app' })
  try {
    expect(await launch.confirmRemove()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.ownLockHeld })
    expect(launch.trashed).toEqual([])
    expect(launch.store.exampleState()).toBe('written')
    expect(existsSync(join(box.example, '00 Start here.md'))).toBe(true)
  } finally {
    await releaseOwnerLock(own)
  }
})

test('a release of this app\'s own lock that does not finish in time stops the removal, with nothing binned', async () => {
  const box = await written()
  const launch = box.launch({ ownLocksReleased: () => new Promise(() => {}), closeMs: 20 })
  expect(await launch.confirmRemove()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.inUse })
  expect(launch.trashed).toEqual([])
  expect(launch.store.exampleState()).toBe('written')
})

/** A removal whose windows do not all close: nothing may be binned or recorded. */
async function expectNothingRemoved(closeWindows: ExampleRemovalDeps['closeWindows'], extra: Partial<ExampleRemovalDeps> = {}): Promise<void> {
  const box = await written()
  const launch = box.launch({ closeWindows, ...extra })
  await launch.collection.current()
  const before = await snapshot(box.home)
  const settingsBefore = await readFile(box.settingsPath, 'utf8')

  expect(await launch.confirmRemove()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.unsaved })

  expect(launch.trashed).toEqual([])
  expect(launch.order).toEqual([])
  expect(launch.store.exampleState()).toBe('written')
  expect(await readFile(box.settingsPath, 'utf8')).toBe(settingsBefore)
  expect(await snapshot(box.home)).toEqual(before)
  expect((await startScreenModel(launch.store, launch.collection)).example?.root).toBe(box.example)
  // The person can try again once the window has saved: a fresh look, a fresh token.
  const again = box.launch()
  expect(await again.confirmRemove()).toEqual({ ok: true, outcome: 'moved-to-bin' })
}

test('close refused: a window that could not write, so stayed open, stops the removal with nothing binned or recorded', async () => {
  await expectNothingRemoved(async () => 'open')
  await expectNothingRemoved(async () => { throw new Error('the window went away') })
  await expectNothingRemoved((async () => 'yes') as unknown as ExampleRemovalDeps['closeWindows']) // only the word `closed` is closed
  expect(EXAMPLE_REMOVAL_TEXT.unsaved.match(/[.!?]/g)).toHaveLength(1)
})

test('no close in time: windows that never close stop the removal when the time is up, with nothing binned', async () => {
  const started = Date.now()
  await expectNothingRemoved(() => new Promise(() => {}), { closeMs: 40 })
  expect(Date.now() - started).toBeLessThan(2000)
  expect(EXAMPLE_CLOSE_MS).toBeGreaterThanOrEqual(2000)
  expect(EXAMPLE_CLOSE_MS).toBeLessThanOrEqual(10_000)
})

test('a close that comes after the time is up removes nothing', async () => {
  let answer: (closed: 'closed') => void = () => {}
  const box = await written()
  const launch = box.launch({ closeWindows: () => new Promise((resolve) => { answer = resolve }), closeMs: 20 })
  expect(await launch.confirmRemove()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.unsaved })
  answer('closed')
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(launch.trashed).toEqual([])
  expect(launch.store.exampleState()).toBe('written')
  expect(existsSync(box.example)).toBe(true)
})

test('what is at the path is checked again after the windows have closed', async () => {
  const box = await written()
  const launch = box.launch({
    closeWindows: async () => {
      // While the windows were closing, the folder was swapped for a link to the person's own book.
      await rename(box.example, join(box.documents, 'the real one'))
      await symlink(join(box.documents, 'walking-book'), box.example)
      return 'closed'
    },
  })
  expect(await launch.confirmRemove()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.notPlain })
  expect(launch.trashed).toEqual([])
  expect(launch.store.exampleState()).toBe('written')
})

test('the files are counted again after the windows have closed: one added meanwhile means nothing is removed', async () => {
  const box = await written()
  const added = join(box.example, 'written while closing.md')
  const launch = box.launch({
    closeWindows: async () => { await writeFile(added, 'new\n'); return 'closed' },
  })
  expect(await launch.confirmRemove()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.lookAgain })
  expect(launch.trashed).toEqual([])
  expect(launch.store.exampleState()).toBe('written')
  expect(await readFile(added, 'utf8')).toBe('new\n')
})

test('the close writes WriteFlex’s own records into the folder: still removed, and the records go to the Bin with it', async () => {
  const box = await written()
  const launch = box.launch({
    // What a real close writes: the snapshot store and the change and version journals.
    closeWindows: async (root) => {
      await mkdir(join(root, '.bridle', 'objects'), { recursive: true })
      await writeFile(join(root, '.bridle', 'journal.jsonl'), '{}\n')
      await writeFile(join(root, '.bridle', 'objects', 'abc'), 'x')
      await mkdir(join(root, '.writeflex'))
      await writeFile(join(root, '.writeflex', 'versions.jsonl'), '{}\n')
      return 'closed'
    },
  })
  expect(await launch.confirmRemove()).toEqual({ ok: true, outcome: 'moved-to-bin' })
  expect(launch.trashed).toEqual([box.example])
  expect(existsSync(join(box.bin, 'Example collection 1', '.bridle', 'objects', 'abc'))).toBe(true)
  expect(existsSync(join(box.bin, 'Example collection 1', '.writeflex', 'versions.jsonl'))).toBe(true)
})

test('only the records directly inside the folder are left out of the count after the close, and only after it', async () => {
  // A folder of the person's own that happens to be called `.bridle`, one level down, still counts.
  const box = await written()
  const deeper = box.launch({
    closeWindows: async (root) => { await mkdir(join(root, 'drafts', '.bridle'), { recursive: true }); await writeFile(join(root, 'drafts', '.bridle', 'x'), 'x'); return 'closed' },
  })
  expect(await deeper.confirmRemove()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.lookAgain })
  expect(deeper.trashed).toEqual([])
  // Before the close every file counts, records included: one written while the confirmation was open stops it.
  const before = box.launch()
  expect(await before.confirmRemove(async () => { await mkdir(join(box.example, '.writeflex')); await writeFile(join(box.example, '.writeflex', 'changes.jsonl'), '{}\n') })).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.lookAgain })
  expect(before.closed).toEqual([])
  expect(before.trashed).toEqual([])
  expect(before.store.exampleState()).toBe('written')
})

test('trash failing after the windows closed: nothing is unpinned, the state is unchanged, and one sentence says so', async () => {
  const box = await written()
  const before = await snapshot(box.home)
  const settingsBefore = await readFile(box.settingsPath, 'utf8')
  const attempts: string[] = []
  const launch = box.launch({ trash: async (path) => { attempts.push(path); launch.order.push('trash'); throw Object.assign(new Error('The Bin is not available.'), { code: 'EPERM' }) } })
  await launch.collection.current()

  const result = await launch.confirmRemove()

  expect(result).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.trashFailed })
  expect(EXAMPLE_REMOVAL_TEXT.trashFailed.match(/[.!?]/g)).toHaveLength(1)
  expect(attempts).toEqual([box.example])
  // The windows were closed before the trash was tried, and stay closed; nothing else changed.
  expect(launch.order).toEqual(['close:written:there', 'trash'])
  expect(await readFile(box.settingsPath, 'utf8')).toBe(settingsBefore)
  expect(launch.store.exampleState()).toBe('written')
  expect(await snapshot(box.home)).toEqual(before)
  expect((await startScreenModel(launch.store, launch.collection)).example?.root).toBe(box.example)
})

test('a trash function that returns with the folder still there counts as failing', async () => {
  const box = await written()
  const launch = box.launch({ trash: async () => {} })
  expect(await launch.confirmRemove()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.trashFailed })
  expect(launch.store.exampleState()).toBe('written')
  expect(existsSync(box.example)).toBe(true)
})

test('path is a symlink: nothing is trashed, nothing changes, one sentence', async () => {
  const box = await written()
  const elsewhere = join(box.documents, 'walking-book')
  const launch = box.launch()
  let before: Record<string, string> = {}

  // Swapped while the confirmation is open: the check is made again when the person confirms.
  expect(await launch.confirmRemove(async () => {
    await rename(box.example, join(box.documents, 'the real one'))
    await symlink(elsewhere, box.example)
    before = await snapshot(box.home)
  })).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.notPlain })
  expect(await launch.removal.preview(WINDOW)).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.notPlain })

  expect(EXAMPLE_REMOVAL_TEXT.notPlain.match(/[.!?]/g)).toHaveLength(1)
  expect(launch.trashed).toEqual([])
  expect(launch.closed).toEqual([])
  expect(launch.store.exampleState()).toBe('written')
  expect(await snapshot(box.home)).toEqual(before)
})

test('WriteFlex is a symlink, or leads outside Documents: nothing is trashed', async () => {
  const box = await written()
  // The folder that holds the example now lives outside Documents; `WriteFlex` only points at it.
  const away = join(box.home, 'away')
  const launch = box.launch()
  let before: Record<string, string> = {}
  expect(await launch.confirmRemove(async () => {
    await rename(box.parent, away)
    await symlink(away, box.parent)
    before = await snapshot(box.home)
    launch.calls.length = 0
  })).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.notPlain })
  expect(launch.trashed).toEqual([])
  expect(launch.store.exampleState()).toBe('written')
  expect(await snapshot(box.home)).toEqual(before)
  // Nothing under the link was looked at: the port never went past `WriteFlex`.
  expect(launch.calls.some((call) => call.includes('Example collection'))).toBe(false)
})

test('a file where the folder should be is not trashed', async () => {
  const box = await written()
  const launch = box.launch()
  expect(await launch.confirmRemove(async () => {
    await rename(box.example, join(box.documents, 'the real one'))
    await writeFile(box.example, 'a file of that name\n')
  })).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.notPlain })
  expect(launch.trashed).toEqual([])
  expect(await readFile(box.example, 'utf8')).toBe('a file of that name\n')
})

test('only the shown example is removed: under any other record a folder at the path is the person’s and is left alone', async () => {
  for (const state of ['incomplete', 'removed', 'writing'] as const) {
    const box = await written()
    const launch = box.launch()
    let before: Record<string, string> = {}
    // The record changes while the confirmation is open; the token is good, the state is not.
    expect(await launch.confirmRemove(async () => {
      launch.store.setExampleState(state)
      before = await snapshot(box.home)
      launch.calls.length = 0
    })).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.notShown })
    expect(launch.trashed).toEqual([])
    expect(launch.closed).toEqual([])
    expect(launch.calls).toEqual([]) // the disk was not even looked at
    expect(launch.store.exampleState()).toBe(state === 'writing' ? 'writing' : state)
    expect(await snapshot(box.home)).toEqual(before)
  }
})

test('two confirmations at once reach the trash function once', async () => {
  const box = await written()
  const launch = box.launch()
  const token = await launch.look()
  const results = await Promise.all([launch.removal.remove(token, WINDOW), launch.removal.remove(token, WINDOW)])
  expect(launch.trashed).toEqual([box.example])
  expect(results).toEqual([{ ok: true, outcome: 'moved-to-bin' }, { ok: false, message: EXAMPLE_REMOVAL_TEXT.lookAgain }])
})

test('no Documents directory for this run: nothing is trashed', async () => {
  const box = await written()
  let documents: string | null = box.documents
  const launch = box.launch({ documentsDir: () => documents })
  expect(await launch.confirmRemove(() => { documents = null })).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.noDocuments })
  expect(await launch.removal.preview(WINDOW)).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.noDocuments })
  expect(await launch.removal.restore()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.notRemoved })
  expect(launch.trashed).toEqual([])
})

test('nothing path-like is an argument: remove takes only the token and the window’s number, and no path is accepted', async () => {
  const box = await written()
  const launch = box.launch()
  const { removal } = launch
  // preview(sender), remove(token, sender); restore and the two questions take nothing.
  expect([removal.preview.length, removal.remove.length, removal.restore.length, removal.canRestore.length, removal.wasRemoved.length]).toEqual([1, 2, 0, 0, 0])
  const before = await snapshot(box.home)
  const elsewhere = join(box.documents, 'walking-book')
  for (const pathLike of [box.example, elsewhere, '/', '.', '..', '~/Documents', 'Example collection', `../${'a'.repeat(61)}`, `/${'a'.repeat(63)}`]) {
    const token = await launch.look()
    // A path alone, a path of the token's length, and the real token with a path on either side.
    for (const given of [pathLike, `${token}/${pathLike}`, `${pathLike}/${token}`, { token, path: pathLike }, [token, pathLike]]) {
      await launch.look()
      expect(await removal.remove(given, WINDOW)).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.lookAgain })
    }
  }
  expect(launch.trashed).toEqual([])
  expect(launch.closed).toEqual([])
  expect(launch.store.exampleState()).toBe('written')
  expect(await snapshot(box.home)).toEqual(before)
  // The token itself has nothing of a path in it.
  expect(await launch.look()).toMatch(TOKEN)
})

// ---- main holds the confirmation (rule H) -----------------------------------------------------

/** A written sandbox, a launch with a clock the test moves, and a check that nothing at all changed. */
async function confirmationBox(): Promise<{ box: Sandbox; launch: Launch; clock: { now: number }; unchanged: () => Promise<void> }> {
  const box = await written()
  const clock = { now: 1_000_000 }
  const launch = box.launch({ now: () => clock.now })
  await launch.collection.current()
  const before = await snapshot(box.home)
  const settingsBefore = await readFile(box.settingsPath, 'utf8')
  return {
    box, launch, clock,
    unchanged: async () => {
      expect(launch.trashed).toEqual([])
      expect(launch.closed).toEqual([])
      expect(launch.store.exampleState()).toBe('written')
      expect(await readFile(box.settingsPath, 'utf8')).toBe(settingsBefore)
      expect(await snapshot(box.home)).toEqual(before)
    },
  }
}
const LOOK_AGAIN = { ok: false, message: EXAMPLE_REMOVAL_TEXT.lookAgain } as const

test('no token: nothing changes, with or without a look before it', async () => {
  const { launch, unchanged } = await confirmationBox()
  expect(await launch.removal.remove(undefined, WINDOW)).toEqual(LOOK_AGAIN) // never looked
  for (const nothing of [undefined, null, '', 0, true, {}]) {
    await launch.look()
    expect(await launch.removal.remove(nothing, WINDOW)).toEqual(LOOK_AGAIN)
  }
  await unchanged()
})

test('wrong token: nothing changes, and the real one is used up by the attempt', async () => {
  const { launch, unchanged } = await confirmationBox()
  const token = await launch.look()
  const wrong = token.replace(/.$/, (last) => (last === '0' ? '1' : '0'))
  expect(wrong).toMatch(TOKEN)
  expect(await launch.removal.remove(wrong, WINDOW)).toEqual(LOOK_AGAIN)
  expect(await launch.removal.remove(token, WINDOW)).toEqual(LOOK_AGAIN)
  expect(await launch.removal.remove(token.toUpperCase(), WINDOW)).toEqual(LOOK_AGAIN)
  await unchanged()
})

test('reused token: it removes once, and after a restore it removes nothing', async () => {
  const box = await written()
  const launch = box.launch()
  const token = await launch.look()
  expect(await launch.removal.remove(token, WINDOW)).toEqual({ ok: true, outcome: 'moved-to-bin' })
  expect((await launch.removal.restore()).ok).toBe(true)
  expect(await launch.collection.current()).toBe(box.example)
  expect(await launch.removal.remove(token, WINDOW)).toEqual(LOOK_AGAIN)
  expect(launch.trashed).toEqual([box.example]) // the one from the first time
  expect(existsSync(box.example)).toBe(true)
  expect(launch.store.exampleState()).toBe('written')
})

test('a token from an older look is dead once the person looks again', async () => {
  const { launch, unchanged } = await confirmationBox()
  const first = await launch.look()
  const second = await launch.look()
  expect(second).not.toBe(first)
  expect(await launch.removal.remove(first, WINDOW)).toEqual(LOOK_AGAIN)
  await unchanged()
})

test('other sender: a token shown in one window removes nothing from another', async () => {
  const { launch, unchanged } = await confirmationBox()
  const token = await launch.look(WINDOW)
  expect(await launch.removal.remove(token, OTHER_WINDOW)).toEqual(LOOK_AGAIN)
  expect(await launch.removal.remove(token, WINDOW)).toEqual(LOOK_AGAIN) // used up by the other window's attempt
  await unchanged()
})

test('expired: a confirmation five minutes old removes nothing; one just under does', async () => {
  const { box, launch, clock, unchanged } = await confirmationBox()
  let token = await launch.look()
  clock.now += EXAMPLE_CONFIRMATION_MS
  expect(await launch.removal.remove(token, WINDOW)).toEqual(LOOK_AGAIN)
  token = await launch.look()
  clock.now -= 1 // a clock that went backwards proves nothing about age
  expect(await launch.removal.remove(token, WINDOW)).toEqual(LOOK_AGAIN)
  await unchanged()

  token = await launch.look()
  clock.now += EXAMPLE_CONFIRMATION_MS - 1
  expect(await launch.removal.remove(token, WINDOW)).toEqual({ ok: true, outcome: 'moved-to-bin' })
  expect(launch.trashed).toEqual([box.example])
})

test('count changed: a file added, or one taken away, since the look means nothing is removed', async () => {
  const { box, launch } = await confirmationBox()
  const added = join(box.example, 'written since.md')
  expect(await launch.confirmRemove(() => writeFile(added, 'new\n'))).toEqual(LOOK_AGAIN)
  expect(launch.trashed).toEqual([])
  expect(launch.closed).toEqual([])
  expect(launch.store.exampleState()).toBe('written')
  expect(await readFile(added, 'utf8')).toBe('new\n')

  // Twelve were shown; the folder then went altogether. Nothing is recorded: the person looks again.
  expect(await launch.confirmRemove(() => rename(box.example, join(box.home, 'moved away')))).toEqual(LOOK_AGAIN)
  expect(launch.trashed).toEqual([])
  expect(launch.store.exampleState()).toBe('written')

  // Looking again shows it as it is, and confirming that works.
  expect(await launch.removal.preview(WINDOW)).toMatchObject({ ok: true, files: 0 })
  expect(await launch.confirmRemove()).toEqual({ ok: true, outcome: 'already-gone' })
})

// ---- the confirmation's facts ---------------------------------------------------------------

test('the confirmation reads the real folder and the real count of files in it at that moment, and changes nothing', async () => {
  const box = await written()
  const launch = box.launch()
  expect(await launch.removal.preview(WINDOW)).toEqual({ ok: true, folder: '~/Documents/WriteFlex/Example collection', files: EXAMPLE_BUNDLE_FILES.length, token: expect.stringMatching(TOKEN) })

  // The person adds a file, a hidden one and a folder with two more: all of it goes to the Bin, so all of it is counted.
  await writeFile(join(box.example, 'my own page.md'), 'mine\n')
  await writeFile(join(box.example, '.hidden'), 'x')
  await mkdir(join(box.example, 'drafts', 'old'), { recursive: true })
  await writeFile(join(box.example, 'drafts', 'a.md'), 'a')
  await writeFile(join(box.example, 'drafts', 'old', 'b.md'), 'b')
  await symlink(join(box.documents, 'walking-book'), join(box.example, 'link to my book')) // counted as one, never followed
  const before = await snapshot(box.home)
  const settingsBefore = await readFile(box.settingsPath, 'utf8')

  expect(await launch.removal.preview(WINDOW)).toEqual({ ok: true, folder: '~/Documents/WriteFlex/Example collection', files: EXAMPLE_BUNDLE_FILES.length + 5, token: expect.stringMatching(TOKEN) })

  expect(launch.trashed).toEqual([])
  expect(launch.calls.filter(writeMode)).toEqual([])
  expect(launch.calls.some((call) => call.includes('walking-book'))).toBe(false)
  expect(await snapshot(box.home)).toEqual(before)
  expect(await readFile(box.settingsPath, 'utf8')).toBe(settingsBefore)
})

test('after a top-up the confirmation counts the files added, and removal takes the whole folder', async () => {
  const box = await sandbox()
  await mkdir(join(box.example, 'assets'), { recursive: true })
  for (const name of EXAMPLE_ORIGINAL_FILES) await writeFile(join(box.example, name), `from an earlier build: ${name}\n`)
  await mkdir(join(box.settingsPath, '..'), { recursive: true })
  await writeFile(box.settingsPath, JSON.stringify({ example: { state: 'written', at: 1 } }))
  const launch = box.launch()
  expect(await launch.collection.ensure()).toBe('present') // the top-up runs here
  expect(await launch.removal.preview(WINDOW)).toEqual({ ok: true, folder: '~/Documents/WriteFlex/Example collection', files: EXAMPLE_BUNDLE_FILES.length, token: expect.stringMatching(TOKEN) })
  expect(await launch.confirmRemove()).toEqual({ ok: true, outcome: 'moved-to-bin' })
  expect(launch.trashed).toEqual([box.example])
  expect(existsSync(box.example)).toBe(false)
  expect(await savedState(box)).toBe('removed')
  // And a removed collection is not topped up on the next launch.
  const next = box.launch()
  expect(await next.collection.ensure()).toBe('removed')
  expect(existsSync(box.parent)).toBe(true)
  expect(existsSync(box.example)).toBe(false)
})

test('more than the count limit: not the example, so the confirmation is refused and no token is issued', async () => {
  const box = await written()
  const launch = box.launch()
  const token = await launch.look() // a live confirmation, which the refused look must replace
  const many = join(box.example, 'many')
  await mkdir(many)
  // Eleven lesson files and the widget page are there already; this takes the folder just past the limit.
  for (let index = 0; index <= EXAMPLE_COUNT_LIMIT - EXAMPLE_BUNDLE_FILES.length; index += 1) await writeFile(join(many, `${index}`), '')

  const preview = await launch.removal.preview(WINDOW)
  expect(preview).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.tooMany })
  expect(preview).not.toHaveProperty('token')
  expect(EXAMPLE_REMOVAL_TEXT.tooMany.match(/[.!?]/g)).toHaveLength(1)
  // Nothing can be confirmed: the earlier token went with the new look, and no new one was given.
  expect(await launch.removal.remove(token, WINDOW)).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.lookAgain })
  expect(launch.trashed).toEqual([])
  expect(launch.closed).toEqual([])
  expect(launch.store.exampleState()).toBe('written')
  expect(existsSync(box.example)).toBe(true)
}, 30_000)

test('the confirmation is refused when the example is not shown', async () => {
  const box = await written()
  box.launch().store.setExampleState('incomplete')
  expect(await box.launch().removal.preview(WINDOW)).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.notShown })
})

// ---- restore --------------------------------------------------------------------------------

test('progress is identical before removal and after restore, and the fresh folder is the twelve bundled lessons and their assets', async () => {
  const box = await written()
  const first = box.launch()
  const guide = new GuideProgressStore(first.store)
  guide.stepDone('example')
  guide.chapterOpened('Write')
  guide.commandRan('app.settings')
  guide.chapterFinished('Listen')
  guide.topicRead('how.1')
  const progressBefore = JSON.stringify(first.store.get('guide.progress'))
  const besidesBefore = await settingsBesidesExample(box)
  expect(progressBefore.length).toBeGreaterThan(20)

  expect((await first.confirmRemove()).ok).toBe(true)
  expect(await settingsBesidesExample(box)).toBe(besidesBefore)

  // A later launch: the first run creates nothing under `removed`; only restore does.
  const later = box.launch()
  expect(await later.collection.ensure()).toBe('removed')
  expect(existsSync(box.example)).toBe(false)
  expect(later.removal.canRestore()).toBe(true)

  expect(await later.removal.restore()).toEqual({ ok: true, outcome: 'written' })

  expect(later.calls.filter(writeMode)).toEqual(['mkdir WriteFlex/Example collection', ...EXAMPLE_LESSON_FILES.map((name) => `writeNewFile WriteFlex/Example collection/${name}`), 'mkdir WriteFlex/Example collection/assets', ...EXAMPLE_ASSET_FILES.map((name) => `writeNewFile WriteFlex/Example collection/${name}`)])
  for (const name of EXAMPLE_BUNDLE_FILES) expect(await readFile(join(box.example, name))).toEqual(await readFile(join(REAL_BUNDLE, name)))
  expect((await readdir(box.example)).sort()).toEqual([...EXAMPLE_LESSON_FILES, 'assets'].sort())
  expect(await savedState(box)).toBe('written')
  expect(await later.collection.current()).toBe(box.example)
  expect((await startScreenModel(later.store, later.collection)).example).toEqual({ root: box.example, location: '~/Documents/WriteFlex', lessonFiles: 12 })
  expect(JSON.stringify(later.store.get('guide.progress'))).toBe(progressBefore)
  expect(await settingsBesidesExample(box)).toBe(besidesBefore)
  expect(later.trashed).toEqual([])
  // What went to the Bin is still there: restore writes a fresh folder and takes nothing back out.
  expect((await readdir(join(box.bin, 'Example collection 1'))).length).toBe(13)
})

test('restore with the path occupied by a folder holding 00 Start here.md: pinned as it is, nothing written', async () => {
  const box = await written()
  const first = box.launch()
  await first.confirmRemove()
  await mkdir(box.example)
  await writeFile(join(box.example, '00 Start here.md'), 'my own start\n')
  await writeFile(join(box.example, 'another.md'), 'mine\n')
  const before = await snapshot(box.home)

  const launch = box.launch()
  await launch.collection.ensure()
  expect(await launch.removal.restore()).toEqual({ ok: true, outcome: 'pinned-as-it-is' })

  expect(launch.calls.filter(writeMode)).toEqual([])
  expect(await snapshot(box.home)).toEqual(before)
  expect(await savedState(box)).toBe('written')
  expect((await startScreenModel(launch.store, launch.collection)).example).toEqual({ root: box.example, location: '~/Documents/WriteFlex', lessonFiles: 1 })
})

test('restore with the path occupied by a folder without 00 Start here.md: one sentence, nothing changes', async () => {
  const box = await written()
  await box.launch().confirmRemove()
  await mkdir(box.example)
  await writeFile(join(box.example, '01 Write.md'), 'mine\n')
  const before = await snapshot(box.home)
  const settingsBefore = await readFile(box.settingsPath, 'utf8')

  const launch = box.launch()
  expect(await launch.removal.restore()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.inTheWay })

  expect(EXAMPLE_REMOVAL_TEXT.inTheWay.match(/[.!?]/g)).toHaveLength(1)
  expect(launch.calls.filter(writeMode)).toEqual([])
  expect(await snapshot(box.home)).toEqual(before)
  expect(await readFile(box.settingsPath, 'utf8')).toBe(settingsBefore)
  expect(await launch.collection.current()).toBeNull()
})

test('restore with a symlink or a file at the path: in the way, nothing changes', async () => {
  for (const kind of ['symlink', 'file'] as const) {
    const box = await written()
    await box.launch().confirmRemove()
    if (kind === 'symlink') await symlink(join(box.documents, 'walking-book'), box.example)
    else await writeFile(box.example, 'a file\n')
    const before = await snapshot(box.home)
    const launch = box.launch()
    expect(await launch.removal.restore()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.inTheWay })
    expect(launch.calls.filter(writeMode)).toEqual([])
    expect(await snapshot(box.home)).toEqual(before)
    expect(launch.store.exampleState()).toBe('removed')
  }
})

test('restore starts only from removed or incomplete', async () => {
  const box = await written()
  const shown = box.launch()
  expect(shown.removal.canRestore()).toBe(false)
  expect(await shown.removal.restore()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.notRemoved })
  expect(shown.calls).toEqual([])

  const fresh = await sandbox() // no settings record at all: the first run's business, not restore's
  const absent = fresh.launch()
  expect(await absent.removal.restore()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.notRemoved })
  expect(existsSync(fresh.parent)).toBe(false)

  absent.store.setExampleState('writing')
  expect(await absent.removal.restore()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.notRemoved })
  expect(existsSync(fresh.parent)).toBe(false)
})

test('restore from incomplete with nothing at the path writes the folder, WriteFlex included', async () => {
  const box = await sandbox()
  const launch = box.launch()
  launch.store.setExampleState('incomplete')
  await launch.collection.ensure()
  expect(await launch.removal.restore()).toEqual({ ok: true, outcome: 'written' })
  expect(launch.calls.filter(writeMode).slice(0, 2)).toEqual(['mkdir WriteFlex', 'mkdir WriteFlex/Example collection'])
  expect((await readdir(box.example)).length).toBe(13) // twelve lessons and assets/
  expect(await launch.collection.current()).toBe(box.example)
})

test('a folder that appears at the path during restore is not written into', async () => {
  const box = await written()
  await box.launch().confirmRemove()
  const launch = box.launch({}, async (method, path) => {
    if (method === 'mkdir' && path === box.example) { await mkdir(box.example); await writeFile(join(box.example, 'theirs.md'), 'theirs\n') }
  })
  expect(await launch.removal.restore()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.inTheWay })
  expect(await readdir(box.example)).toEqual(['theirs.md'])
  expect(launch.store.exampleState()).toBe('removed')
})

test('a restore that cannot finish leaves what it made, overwrites nothing and records incomplete', async () => {
  const box = await written()
  await box.launch().confirmRemove()
  const launch = box.launch({}, async (method, path) => {
    // Another program creates the fourth lesson's name just before WriteFlex would.
    if (method === 'writeNewFile' && path.endsWith('03 Stay focused.md')) await writeFile(path, 'theirs\n')
  })
  expect(await launch.removal.restore()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.writeFailed })
  expect(await readFile(join(box.example, '03 Stay focused.md'), 'utf8')).toBe('theirs\n')
  expect((await readdir(box.example)).length).toBe(4)
  expect(launch.store.exampleState()).toBe('incomplete')
  expect(await launch.collection.current()).toBeNull()
})

test('every sentence the person can be shown is one sentence', () => {
  for (const sentence of Object.values(EXAMPLE_REMOVAL_TEXT)) {
    expect(sentence.endsWith('.')).toBe(true)
    expect(sentence.slice(0, -1)).not.toMatch(/[.!?]\s/)
  }
})

// ---- the trash function for a run --------------------------------------------------------------

/** A fake system temp directory with a Bin inside it, and a folder outside it, all under one real temp base. */
async function harnessDirs(): Promise<{ temp: string; inside: string; outsideTemp: string }> {
  const base = trackScratch(await realpath(await mkdtemp(join(tmpdir(), 'wf-example-bin-'))))
  const temp = join(base, 'tmp')
  const inside = join(temp, 'run', '.Trash')
  const outsideTemp = join(base, 'elsewhere')
  await mkdir(inside, { recursive: true })
  await mkdir(outsideTemp)
  return { temp, inside, outsideTemp }
}

test('a harness run never gets the real Bin; a normal launch gets the system’s', async () => {
  const { temp, inside } = await harnessDirs()
  const system = async (): Promise<void> => {}
  const moved: string[] = []
  const harnessTrash = async (path: string, bin: string): Promise<void> => { moved.push(`${path} -> ${bin}`) }
  const pick = (isPackaged: boolean, env: Record<string, string | undefined>) =>
    resolveExampleTrash({ isPackaged, env, systemTrash: system, harnessTrash, tempDir: () => temp })

  expect(pick(false, {})).toBe(system)
  expect(pick(true, { [EXAMPLE_BIN_OVERRIDE]: inside })).toBe(system) // the override alone means nothing

  const stub = pick(false, { WRITEFLEX_E2E: '1', [EXAMPLE_BIN_OVERRIDE]: inside })
  expect(stub).not.toBe(system)
  await stub('/x/Example collection')
  expect(moved).toEqual([`/x/Example collection -> ${inside}`])

  for (const refused of [pick(false, { WRITEFLEX_E2E: '1' }), pick(true, { WRITEFLEX_E2E: '1', [EXAMPLE_BIN_OVERRIDE]: inside })]) {
    expect(refused).not.toBe(system)
    await expect(refused('/x/Example collection')).rejects.toThrow()
  }
  expect(moved).toHaveLength(1)
})

test('harness Bin inside temp: the stand-in is given its real path', async () => {
  const { temp, inside } = await harnessDirs()
  expect(await harnessBinInsideTemp(inside, temp)).toBe(inside)
  // Reached through a symlinked temp directory, the real paths still agree.
  const linkedTemp = `${temp}-link`
  await symlink(temp, linkedTemp)
  expect(await harnessBinInsideTemp(join(linkedTemp, 'run', '.Trash'), linkedTemp)).toBe(inside)
})

test('harness Bin outside temp, or the temp directory itself: refused, and the stand-in is never called', async () => {
  const { temp, outsideTemp } = await harnessDirs()
  const moved: string[] = []
  const system = async (): Promise<void> => { moved.push('system') }
  for (const bin of [outsideTemp, temp, join(temp, '..', 'elsewhere'), 'relative/.Trash', join(temp, 'missing')]) {
    expect(await harnessBinInsideTemp(bin, temp)).toBeNull()
    const trash = resolveExampleTrash({ isPackaged: false, env: { WRITEFLEX_E2E: '1', [EXAMPLE_BIN_OVERRIDE]: bin }, systemTrash: system, harnessTrash: async () => { moved.push(bin) }, tempDir: () => temp })
    await expect(trash('/x/Example collection')).rejects.toThrow()
  }
  expect(moved).toEqual([])
})

test('harness Bin that is a symlink, or reached through one that leads outside temp: refused', async () => {
  const { temp, inside, outsideTemp } = await harnessDirs()
  const moved: string[] = []
  const pick = (bin: string) => resolveExampleTrash({ isPackaged: false, env: { WRITEFLEX_E2E: '1', [EXAMPLE_BIN_OVERRIDE]: bin }, systemTrash: async () => { moved.push('system') }, harnessTrash: async () => { moved.push(bin) }, tempDir: () => temp })
  // The Bin itself a symlink: to a folder outside temp, and even to the good Bin inside temp.
  const toOutside = join(temp, 'bin-out')
  const toInside = join(temp, 'bin-in')
  await symlink(outsideTemp, toOutside)
  await symlink(inside, toInside)
  // An intermediate folder inside temp that is a symlink leading outside it.
  await mkdir(join(outsideTemp, '.Trash'))
  await symlink(outsideTemp, join(temp, 'hop'))
  for (const bin of [toOutside, toInside, join(temp, 'hop', '.Trash')]) {
    expect(await harnessBinInsideTemp(bin, temp)).toBeNull()
    await expect(pick(bin)('/x/Example collection')).rejects.toThrow()
  }
  expect(moved).toEqual([])
})

test('restore: the list of written files is saved before the folder is made; if it cannot be, nothing is created', async () => {
  const box = await written()
  expect((await box.launch().confirmRemove()).ok).toBe(true)
  // An earlier build's record: no list at all.
  await writeFile(box.settingsPath, JSON.stringify({ example: { state: 'removed', at: 1 } }))
  const real = new SettingsStore(box.settingsPath)
  const refused = box.launch({
    store: {
      exampleState: () => real.exampleState(),
      setExampleState: (state) => real.setExampleState(state),
      exampleFiles: () => real.exampleFiles(),
      setExampleFiles: () => false,
    },
  })
  expect(await refused.removal.restore()).toEqual({ ok: false, message: EXAMPLE_REMOVAL_TEXT.restoreNotRecorded })
  expect(refused.calls.filter((call) => call.startsWith('mkdir') || call.startsWith('writeNewFile'))).toEqual([])
  expect(existsSync(box.example)).toBe(false)
  expect(real.exampleState()).toBe('removed')

  // A restore that can save has the whole list on disk before its first mkdir.
  const seen: unknown[] = []
  const launch = box.launch({}, (method) => {
    if (method === 'mkdir' && seen.length === 0) seen.push(JSON.parse(readFileSync(box.settingsPath, 'utf8')).exampleFiles)
  })
  expect(await launch.removal.restore()).toEqual({ ok: true, outcome: 'written' })
  expect(seen).toEqual([[...EXAMPLE_BUNDLE_FILES]])
  // So a lesson deleted from the restored folder stays deleted on the next launch.
  await rm(join(box.example, '11 Objects.md'))
  const next = box.launch()
  expect(await next.collection.ensure()).toBe('present')
  expect(existsSync(join(box.example, '11 Objects.md'))).toBe(false)
})

// The shared tracker is cached across files; register this file's cleanup explicitly.
afterAll(cleanUpScratch)
