import { describe, expect, test } from 'bun:test'
import {
  OWN_WRITE_DEDUPE_MS,
  OwnWriteTracker,
  createWatchRouter,
  isIgnoredWorkspaceWatchPath,
} from '../../src/main/workspace-watcher'

// Pure-logic coverage only. Real recursive fs.watch delivery is NOT unit-tested here: bun's recursive
// `fs.watch` is unreliable in tests (events are dropped and the harness can hit EMFILE), and the app
// runs on Node's fs.watch (FSEvents) inside Electron, not bun. The end-to-end watch behaviour — an
// external write surfaces, a WriteFlex-owned save does not phantom-trigger — is verified against the
// real Electron app in tests/e2e/external-change-watcher.spec.ts.

describe('OwnWriteTracker', () => {
  // The disk as the tracker looks at it, held in a map: a path holds an identity, or is absent (ENOENT), or the
  // look fails another way.
  const ID = { dev: 1n, ino: 42n, size: 10n, mtimeNs: 1_000_000_123n }
  const disk = new Map<string, typeof ID | 'EACCES'>()
  const lookAt = (absolute: string): typeof ID => {
    const there = disk.get(absolute)
    if (there === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (there === 'EACCES') throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    return there
  }
  const tracker = (): OwnWriteTracker => { disk.clear(); return new OwnWriteTracker((path) => `/r/${path}`, lookAt) }

  test('recognises a WriteFlex-owned path inside the dedupe window while it holds what the write left', () => {
    const own = tracker()
    disk.set('/r/drafts/note.md', ID)
    own.record('drafts/note.md', ID, 1_000)
    expect(own.isRecent('drafts/note.md', 1_000 + OWN_WRITE_DEDUPE_MS - 1)).toBe(true)
  })

  test('does not suppress the same path once the dedupe window has elapsed', () => {
    const own = tracker()
    disk.set('/r/drafts/note.md', ID)
    own.record('drafts/note.md', ID, 1_000)
    expect(own.isRecent('drafts/note.md', 1_000 + OWN_WRITE_DEDUPE_MS + 1)).toBe(false)
  })

  test('does not suppress an external path that WriteFlex did not write', () => {
    const own = tracker()
    disk.set('/r/drafts/note.md', ID)
    disk.set('/r/drafts/other.md', ID)
    own.record('drafts/note.md', ID, 1_000)
    expect(own.isRecent('drafts/other.md', 1_100)).toBe(false)
  })

  test('within the window, any other state at the path is delivered: another inode, size, time or device', () => {
    const own = tracker()
    own.record('a.md', ID, 1_000)
    for (const other of [{ ...ID, ino: 43n }, { ...ID, size: 11n }, { ...ID, mtimeNs: ID.mtimeNs + 1n }, { ...ID, dev: 2n }]) {
      disk.set('/r/a.md', other)
      expect(own.isRecent('a.md', 2_000)).toBe(false)
    }
    disk.set('/r/a.md', ID)
    expect(own.isRecent('a.md', 2_000)).toBe(true)
  })

  test('a path that is gone where the write left a file is delivered; a look that fails is delivered', () => {
    const own = tracker()
    own.record('a.md', ID, 1_000)
    expect(own.isRecent('a.md', 1_500)).toBe(false) // nothing there (ENOENT)
    disk.set('/r/a.md', 'EACCES')
    expect(own.isRecent('a.md', 1_500)).toBe(false)
  })

  test("'absent' is suppressed only while nothing is there; a file there, or a look that fails, is delivered", () => {
    const own = tracker()
    own.record('gone.md', 'absent', 1_000)
    expect(own.isRecent('gone.md', 1_500)).toBe(true)
    disk.set('/r/gone.md', ID)
    expect(own.isRecent('gone.md', 1_500)).toBe(false)
    disk.set('/r/gone.md', 'EACCES')
    expect(own.isRecent('gone.md', 1_500)).toBe(false)
  })

  test('a write recorded with no state suppresses nothing, even at once: there is no rule by time alone', () => {
    const own = tracker()
    disk.set('/r/a.md', ID)
    own.record('a.md', ID, 1_000)
    own.record('a.md', undefined, 1_000) // a later route that could not stamp replaces the record
    expect(own.isRecent('a.md', 1_000)).toBe(false)
  })
})

describe('isIgnoredWorkspaceWatchPath', () => {
  test('ignores hidden paths, dependency and metadata directories, and atomic temp files', () => {
    expect(isIgnoredWorkspaceWatchPath('.env')).toBe(true)
    expect(isIgnoredWorkspaceWatchPath('drafts/.scratch.md')).toBe(true)
    expect(isIgnoredWorkspaceWatchPath('node_modules/pkg/index.md')).toBe(true)
    expect(isIgnoredWorkspaceWatchPath('.git/index')).toBe(true)
    expect(isIgnoredWorkspaceWatchPath('.writeflex/changes.jsonl')).toBe(true)
    expect(isIgnoredWorkspaceWatchPath('.note.md.123.456.tmp')).toBe(true)
  })

  test('allows visible files and folders inside the Workspace', () => {
    expect(isIgnoredWorkspaceWatchPath('note.md')).toBe(false)
    expect(isIgnoredWorkspaceWatchPath('drafts/chapter-one.md')).toBe(false)
    expect(isIgnoredWorkspaceWatchPath('assets/diagram.svg')).toBe(false)
  })

  test('fails closed for empty, absolute, and escaping paths', () => {
    expect(isIgnoredWorkspaceWatchPath('')).toBe(true)
    expect(isIgnoredWorkspaceWatchPath('/tmp/note.md')).toBe(true)
    expect(isIgnoredWorkspaceWatchPath('../note.md')).toBe(true)
  })
})

describe('the document router and the vault file', () => {
  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const workspace = () => ({ root: '/r', wasRecentlyWrittenByApp: () => false })

  test('.writeflex/vault.json is never a document path (it has its own watcher, vault-watcher.ts)', async () => {
    const changed: string[][] = []
    const router = createWatchRouter(workspace(), (paths) => changed.push(paths), 10)
    router.take('.writeflex/vault.json')
    router.take('.writeflex/.vault.json.abc.tmp')
    router.take('drafts/a.md')
    await settle(30)
    expect(changed).toEqual([['drafts/a.md']])
    router.dispose()
  })
})


test('a queued folder event is rechecked after the conversion records its final own-write identity', async () => {
  const changed: string[][] = []
  let own = false
  const router = createWatchRouter({ root: '/r', wasRecentlyWrittenByApp: () => own }, paths => changed.push(paths), 10)
  router.take('book')
  own = true
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(changed).toEqual([])
  own = false // A later external change no longer matches the recorded identity.
  router.take('book')
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(changed).toEqual([['book']])
  router.dispose()
})
