import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { setTimeout as wait } from 'node:timers/promises'
import { createSharedFolderWatches, type FolderWatchListener } from '../../src/main/shared-folder-watch'
import { createWidgetWatches } from '../../src/main/widget-watch'

// From the review of PR 299 (Sol's widget-error-probe): a widget file's folder watch is served from the
// Collection root's shared native watch. When that native watch fails, the widget already showing must
// go on being refreshed, not stay silently unwatched while registration still says it is watched.

function harness() {
  const streams: Array<EventEmitter & { listener: FolderWatchListener; closed: boolean }> = []
  const pool = createSharedFolderWatches({
    shares: true,
    realpath: (path) => path,
    isDirectory: () => true,
    plain() { throw new Error('Unexpected plain watch') },
    watch(_folder, listener) {
      const stream = Object.assign(new EventEmitter(), { listener, closed: false, close() { stream.closed = true } })
      streams.push(stream)
      return stream
    },
  })
  const root = '/synthetic/collection'
  const file = '.widgets/demo.html'
  const target = { folder: `${root}/.widgets`, name: 'demo.html', relativePath: file }
  const notices: string[][] = []
  const widgets = createWidgetWatches({
    // As ipc.ts wires it.
    watchFolder: (folder, listener, failed) => pool.watch(folder, {}, (_type, name) => { if (name) listener(name) }).on('error', failed),
    notify: (_id, paths) => notices.push(paths),
    debounceMs: 0,
    retryDelaysMs: [0, 0],
  })
  // The document watcher, which makes a new watch when its own fails (workspace-watcher.ts).
  const start = () => { pool.watch(root, { recursive: true, anchor: root }, () => {}).on('error', () => { start() }) }
  start()
  return { streams, pool, widgets, notices, file, target }
}

test('after the shared native watch fails, a widget already showing is refreshed again', async () => {
  const { streams, widgets, notices, file, target } = harness()
  expect(widgets.watch(1, file, target)).toBe(true)
  streams[0]!.listener('change', file)
  await wait(10)
  expect(notices).toEqual([[file]])

  streams[0]!.emit('error', new Error('injected native stream failure'))
  await wait(20)
  // The document watcher made the replacement; the widget's watch joined it and reported once, for any
  // edit made while nothing was watching.
  expect(streams).toHaveLength(2)
  expect(notices).toEqual([[file], [file]])
  expect(widgets.watch(1, file, target)).toBe(true)
  streams[1]!.listener('change', file)
  await wait(10)
  expect(notices).toEqual([[file], [file], [file]])
  expect(widgets.size).toBe(1)
})

test('a widget watch that cannot be made again is given up, and the next block showing it starts afresh', async () => {
  const streams: Array<EventEmitter & { listener: FolderWatchListener }> = []
  let folderThere = true
  const pool = createSharedFolderWatches({
    shares: true,
    realpath: (path) => { if (!folderThere) throw new Error(`ENOENT: ${path}`); return path },
    isDirectory: () => true,
    plain() { throw new Error('Unexpected plain watch') },
    watch(_folder, listener) {
      const stream = Object.assign(new EventEmitter(), { listener, close() {} })
      streams.push(stream)
      return stream
    },
  })
  const file = '.widgets/demo.html'
  const target = { folder: '/c/.widgets', name: 'demo.html', relativePath: file }
  const widgets = createWidgetWatches({
    watchFolder: (folder, listener, failed) => pool.watch(folder, {}, (_type, name) => { if (name) listener(name) }).on('error', failed),
    notify: () => {},
    debounceMs: 0,
    retryDelaysMs: [0],
  })
  expect(widgets.watch(1, file, target)).toBe(true)
  folderThere = false
  streams[0]!.emit('error', new Error('gone'))
  await wait(20)
  expect(widgets.size).toBe(0)
  folderThere = true
  expect(widgets.watch(1, file, target)).toBe(true)
  expect(widgets.size).toBe(1)
})
