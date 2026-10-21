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
  test('recognises a WriteFlex-owned path inside the dedupe window', () => {
    const tracker = new OwnWriteTracker()
    tracker.record('drafts/note.md', 1_000)

    expect(tracker.isRecent('drafts/note.md', 1_000 + OWN_WRITE_DEDUPE_MS - 1)).toBe(true)
  })

  test('does not suppress the same path once the dedupe window has elapsed', () => {
    const tracker = new OwnWriteTracker()
    tracker.record('drafts/note.md', 1_000)

    expect(tracker.isRecent('drafts/note.md', 1_000 + OWN_WRITE_DEDUPE_MS + 1)).toBe(false)
  })

  test('does not suppress an external path that WriteFlex did not write', () => {
    const tracker = new OwnWriteTracker()
    tracker.record('drafts/note.md', 1_000)

    expect(tracker.isRecent('drafts/other.md', 1_100)).toBe(false)
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
