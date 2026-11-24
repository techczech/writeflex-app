import { expect, test } from 'bun:test'
import { createSharedFolderWatches, type FolderWatch, type FolderWatchListener } from '../../src/main/shared-folder-watch'

// Logic only, with a stand-in for fs.watch: bun's recursive fs.watch is not what the app runs on (see
// workspace-watcher.test.ts). Real delivery is covered by the Electron e2e specs for outside changes.

type Native = { path: string; listener: FolderWatchListener; errors: Array<(error: Error) => void>; closed: boolean }

function harness(options: { shares?: boolean; folders?: string[] } = {}) {
  const natives: Native[] = []
  const plain: string[] = []
  const folders = new Set(options.folders ?? ['/v', '/v/.writeflex', '/v/.writeflex/inbox', '/v/notes', '/w', '/v2', '/v/v', '/v/v/drafts'])
  const watches = createSharedFolderWatches({
    shares: options.shares ?? true,
    realpath: (path) => {
      if (!folders.has(path) && !path.endsWith('.md')) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return path
    },
    isDirectory: (path) => folders.has(path),
    watch: (path, listener) => {
      const native: Native = { path, listener, errors: [], closed: false }
      natives.push(native)
      return { close: () => { native.closed = true }, on: (_event, handler) => { native.errors.push(handler) } }
    },
    plain: (path) => {
      plain.push(path)
      const handle: FolderWatch = { close: () => {}, on: () => handle }
      return handle
    },
  })
  const open = () => natives.filter((native) => !native.closed)
  return { watches, natives, plain, open }
}

function recorder() {
  const heard: Array<string | null> = []
  return { heard, listener: (_event: string, name: string | null) => { heard.push(name) } }
}

test("a window's folder watches share one native watch of the root, whatever order they start in", () => {
  const { watches, open } = harness()
  const inbox = recorder(), vaultFolder = recorder(), vaultRoot = recorder(), documents = recorder()
  // The inbox (deepest) first: the anchor puts the native watch at the root, so the others join it.
  const a = watches.watch('/v/.writeflex/inbox', { anchor: '/v' }, inbox.listener)
  const b = watches.watch('/v/.writeflex', { anchor: '/v' }, vaultFolder.listener)
  const c = watches.watch('/v', { anchor: '/v' }, vaultRoot.listener)
  const d = watches.watch('/v', { recursive: true, anchor: '/v' }, documents.listener)
  expect(open().map((native) => native.path)).toEqual(['/v'])
  for (const handle of [a, b, c]) handle.close()
  expect(open()).toHaveLength(1) // still held by the documents watch
  d.close()
  expect(open()).toHaveLength(0) // closed with its last user
})

test('each user hears what its own native watch of that folder would have reported', () => {
  const { watches, natives } = harness()
  const inbox = recorder(), vaultFolder = recorder(), vaultRoot = recorder(), documents = recorder()
  watches.watch('/v', { recursive: true, anchor: '/v' }, documents.listener)
  watches.watch('/v', { anchor: '/v' }, vaultRoot.listener)
  watches.watch('/v/.writeflex', { anchor: '/v' }, vaultFolder.listener)
  watches.watch('/v/.writeflex/inbox', { anchor: '/v' }, inbox.listener)
  const emit = (name: string | null) => natives[0]!.listener('rename', name)
  emit('notes/chapter.md')
  emit('.writeflex/vault.json')
  emit('.writeflex/inbox/r1.json')
  emit('.writeflex')
  emit('top.md')
  emit(null)
  expect(documents.heard).toEqual(['notes/chapter.md', '.writeflex/vault.json', '.writeflex/inbox/r1.json', '.writeflex', 'top.md', null])
  // Non-recursive: direct entries only.
  expect(vaultRoot.heard).toEqual(['.writeflex', 'top.md', null])
  // Not the inbox's file (a level down), and the folder itself by its own name, as libuv names it.
  expect(vaultFolder.heard).toEqual(['vault.json', '.writeflex', null])
  expect(inbox.heard).toEqual(['r1.json', null])
})

test('a folder under a watched root joins it without an anchor; a sibling root gets its own', () => {
  const { watches, open } = harness()
  watches.watch('/v', { recursive: true, anchor: '/v' }, () => {})
  const widget = watches.watch('/v/notes', {}, () => {})
  watches.watch('/v2', { recursive: true, anchor: '/v2' }, () => {})
  expect(open().map((native) => native.path)).toEqual(['/v', '/v2'])
  widget.close()
  expect(open()).toHaveLength(2)
})

test('a missing folder throws as fs.watch does; a file and other platforms get a plain watch', () => {
  const { watches, plain, open } = harness()
  expect(() => watches.watch('/v/missing', { anchor: '/v' }, () => {})).toThrow('ENOENT')
  watches.watch('/v/file.md', { anchor: '/v' }, () => {})
  expect(plain).toEqual(['/v/file.md'])
  expect(open()).toHaveLength(0)
  const elsewhere = harness({ shares: false })
  elsewhere.watches.watch('/v', { recursive: true, anchor: '/v' }, () => {})
  expect(elsewhere.plain).toEqual(['/v'])
  expect(elsewhere.open()).toHaveLength(0)
})

test('a native error reaches every user once, and the next watch of the root makes a new native watch', () => {
  const { watches, natives, open } = harness()
  const errors: string[] = []
  const heard = recorder()
  const a = watches.watch('/v', { recursive: true, anchor: '/v' }, heard.listener).on('error', () => errors.push('documents'))
  watches.watch('/v/.writeflex', { anchor: '/v' }, () => {}).on('error', () => errors.push('vault'))
  for (const handler of natives[0]!.errors) handler(new Error('stream failed'))
  expect(errors.sort()).toEqual(['documents', 'vault'])
  expect(open()).toHaveLength(0)
  natives[0]!.listener('rename', 'late.md') // nothing reaches a user after the error
  expect(heard.heard).toEqual([])
  a.close() // closing after the error is harmless
  watches.watch('/v', { recursive: true, anchor: '/v' }, () => {})
  expect(open()).toHaveLength(1)
  expect(natives).toHaveLength(2)
})

test("a closed user hears nothing more, and one user's fault does not stop the others", async () => {
  const { watches, natives } = harness()
  const later = recorder()
  const first = watches.watch('/v', { recursive: true, anchor: '/v' }, () => { throw new Error('listener fault') })
  watches.watch('/v', { recursive: true, anchor: '/v' }, later.listener)
  const faults: unknown[] = []
  const original = globalThis.queueMicrotask
  globalThis.queueMicrotask = (run) => { try { run() } catch (error) { faults.push(error) } }
  try { natives[0]!.listener('change', 'a.md') } finally { globalThis.queueMicrotask = original }
  expect(later.heard).toEqual(['a.md'])
  expect(faults).toHaveLength(1)
  first.close()
  natives[0]!.listener('change', 'b.md')
  expect(later.heard).toEqual(['a.md', 'b.md'])
})

test("a nested folder named like its root keeps a watch of its own: the root's own events carry the same name", () => {
  const { watches, natives, open } = harness()
  const parent = recorder(), nested = recorder(), drafts = recorder()
  watches.watch('/v', { recursive: true, anchor: '/v' }, parent.listener)
  watches.watch('/v/v', { recursive: true, anchor: '/v' }, nested.listener)
  // Deeper down there is no clash ('v' is not 'v/drafts'), so this one is served by the root's watch.
  watches.watch('/v/v/drafts', { anchor: '/v' }, drafts.listener)
  expect(open().map((native) => native.path)).toEqual(['/v', '/v/v'])
  // libuv names an event on /v itself 'v': only users of the root's own folder hear it.
  natives[0]!.listener('change', 'v')
  expect(parent.heard).toEqual(['v'])
  expect(nested.heard).toEqual([])
  expect(drafts.heard).toEqual([])
  // A file in the nested folder reaches each through its own native watch, once.
  natives[0]!.listener('change', 'v/drafts/a.md')
  natives[1]!.listener('change', 'drafts/a.md')
  expect(parent.heard).toEqual(['v', 'v/drafts/a.md'])
  expect(nested.heard).toEqual(['drafts/a.md'])
  expect(drafts.heard).toEqual(['a.md'])
})

test('an error reaches a user with no error listener as an FSWatcher would give it: thrown', () => {
  const { watches, natives } = harness()
  const heard: string[] = []
  watches.watch('/v', { recursive: true, anchor: '/v' }, () => {}).on('error', (error) => heard.push(error.message))
  watches.watch('/v/notes', {}, () => {})
  const thrown: unknown[] = []
  const original = globalThis.queueMicrotask
  globalThis.queueMicrotask = (run) => { try { run() } catch (error) { thrown.push(error) } }
  try { for (const handler of natives[0]!.errors) handler(new Error('stream failed')) } finally { globalThis.queueMicrotask = original }
  expect(heard).toEqual(['stream failed'])
  expect(thrown.map((error) => (error as Error).message)).toEqual(['stream failed'])
})
