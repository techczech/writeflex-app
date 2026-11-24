// Differential check of shared-folder-watch.ts against plain fs.watch (review of PR 299, Sol; kept as a
// regression test). Two modes:
//   --injected  libuv's event projection replayed through the shared pool (no FSEvents needed);
//   default     native: the same synthetic operations watched both ways at once (macOS, needs working
//               fseventsd). A missing positive control is inconclusive (exit 77), never a parity pass.
// Run with Node (or Electron 43's Node mode), no GUI. Native fixtures stay in the temp folder.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { createSharedFolderWatches, watchFolder } from '../../src/main/shared-folder-watch.ts'

const eventSet = rows => [...new Set(rows.map(row => JSON.stringify(row)))].sort()

async function native() {
  assert.equal(process.platform, 'darwin')
  const scratch = mkdtempSync(join(tmpdir(), 'wf-watch-differential-'))
  const root = join(scratch, 'Collection')
  const nested = join(root, 'Collection')
  const deeper = join(nested, 'drafts')
  const vault = join(root, '.writeflex')
  const outside = join(scratch, 'outside')
  const alias = join(root, 'alias')
  const externalAlias = join(root, 'external-alias')
  const handles = []
  const pairs = []
  const results = []
  mkdirSync(deeper, { recursive: true })
  mkdirSync(join(vault, 'inbox'), { recursive: true })
  mkdirSync(outside)
  chmodSync(root, 0o755)
  chmodSync(nested, 0o755)
  symlinkSync(nested, alias)
  symlinkSync(outside, externalAlias)
  writeFileSync(join(root, 'control.md'), 'start')
  writeFileSync(join(outside, 'incoming.md'), 'incoming')
  writeFileSync(join(vault, 'vault.json'), '{}')
  console.log(JSON.stringify({ runtime: process.versions, scratch }))

  const attach = (id, path, recursive) => {
    const old = []
    const shared = []
    const onEvent = events => (type, name) => events.push([type, name ?? null])
    const onError = events => error => events.push(['error', error.code ?? error.message])
    const raw = watch(path, { recursive, encoding: 'utf8' }, onEvent(old))
    handles.push(raw)
    raw.on('error', onError(old))
    const pooled = watchFolder(path, { recursive, anchor: root }, onEvent(shared))
    handles.push(pooled)
    pooled.on('error', onError(shared))
    pairs.push({ id, old, shared, raw, pooled })
  }

  const phase = async (label, run, settle = 1200) => {
    for (const pair of pairs) pair.old.length = pair.shared.length = 0
    run()
    await wait(settle)
    const observed = pairs.map(({ id, old, shared }) => ({
      id, old: [...old], shared: [...shared],
      exactSet: JSON.stringify(eventSet(old)) === JSON.stringify(eventSet(shared)),
      nameSet: JSON.stringify(eventSet(old.map(([, name]) => name))) === JSON.stringify(eventSet(shared.map(([, name]) => name))),
    }))
    results.push({ label, observed })
    console.log(JSON.stringify({ label, observed }))
    return observed
  }

  try {
    attach('root-documents', root, true)
    attach('root-vault-marker', root, false)
    attach('nested-documents', nested, true)
    attach('nested-direct', nested, false)
    attach('vault-file', vault, false)
    attach('inbox', join(vault, 'inbox'), false)
    attach('symlink-in-root', alias, true)
    attach('symlink-outside-root', externalAlias, false)
    await wait(500)
    await phase('positive control', () => appendFileSync(join(root, 'control.md'), 'control'), 12000)
    await phase('direct child', () => writeFileSync(join(nested, 'direct.md'), 'one'))
    await phase('deep descendant', () => writeFileSync(join(deeper, 'deep.md'), 'two'))
    await phase('rename outside to nested', () => renameSync(join(outside, 'incoming.md'), join(nested, 'incoming.md')))
    await phase('rename nested to outside', () => renameSync(join(nested, 'incoming.md'), join(outside, 'outgoing.md')))
    await phase('outside write via symlink', () => appendFileSync(join(externalAlias, 'outgoing.md'), 'outside'))
    await phase('inside write via symlink', () => appendFileSync(join(alias, 'direct.md'), 'inside'))
    await phase('case-only file rename', () => renameSync(join(nested, 'direct.md'), join(nested, 'Direct.md')))
    await phase('metadata on the parent root', () => chmodSync(root, 0o700))
    await phase('metadata on the same-named nested root', () => chmodSync(nested, 0o700))
    await phase('settle after root metadata', () => {}, 3500)
    await phase('case-only watched folder rename', () => renameSync(nested, join(root, 'collection')))
    await phase('write under case-renamed folder', () => writeFileSync(join(root, 'collection', 'after-case.md'), 'after'))
    await phase('vault atomic replace and inbox arrival', () => {
      writeFileSync(join(vault, '.incoming.tmp'), '{"external":true}')
      renameSync(join(vault, '.incoming.tmp'), join(vault, 'vault.json'))
      writeFileSync(join(vault, 'inbox', 'request.json'), '{}')
    })
    await phase('remove vault folder from watched path', () => renameSync(vault, join(scratch, 'old-vault')))
    await phase('recreate vault folder', () => {
      mkdirSync(vault)
      writeFileSync(join(vault, 'vault.json'), '{"replacement":true}')
    })
    attach('vault-file-reattached', vault, false)
    await wait(500)
    await phase('write under reattached vault folder', () => appendFileSync(join(vault, 'vault.json'), '\n'))
    for (const { raw, pooled } of pairs.filter(pair => pair.id.startsWith('root-'))) {
      raw.close()
      pooled.close()
    }
    await phase('nested write after parent window releases its own handles', () => writeFileSync(join(root, 'collection', 'after-release.md'), 'still watched'))
    await phase('rename root away', () => renameSync(root, join(scratch, 'moved-collection')))
    await phase('write at moved root', () => writeFileSync(join(scratch, 'moved-collection', 'post-move.md'), 'moved'))
    await phase('recreate root and nested folder', () => {
      mkdirSync(nested, { recursive: true })
      writeFileSync(join(nested, 'new-root.md'), 'new')
    }, 1800)

    const hasControl = kind => results.some(({ observed }) => observed.find(({ id }) => id === 'root-documents')[kind]
      .some(([type, name]) => type !== 'error' && name === 'control.md'))
    const totals = Object.fromEntries(['old', 'shared'].map(kind => [kind, results.reduce((total, { observed }) =>
      total + observed.reduce((count, row) => count + row[kind].filter(([type]) => type !== 'error').length, 0), 0)]))
    const rawDifferences = results.flatMap(({ label, observed }) => observed.filter(row => !row.exactSet).map(row => [label, row.id]))
    const nameDifferences = results.flatMap(({ label, observed }) => observed.filter(row => !row.nameSet).map(row => [label, row.id]))
    console.log(JSON.stringify({ totals, oldPositiveControl: hasControl('old'), sharedPositiveControl: hasControl('shared'), rawDifferences, nameDifferences }))
    if (!hasControl('old') || !hasControl('shared')) process.exitCode = 77
    else if (nameDifferences.length) process.exitCode = 1 // names are the contract; types of a folder's own events may differ
  } finally {
    for (const handle of handles.reverse()) handle.close()
  }
}

function injected() {
  const streams = []
  const folders = new Map([
    ['/s/Collection', '/s/Collection'],
    ['/s/Collection/Collection', '/s/Collection/Collection'],
    ['/s/Collection/.writeflex', '/s/Collection/.writeflex'],
    ['/s/Collection/.writeflex/inbox', '/s/Collection/.writeflex/inbox'],
    ['/s/Collection/alias', '/s/Collection/Collection'],
    ['/s/Collection/external-alias', '/s/outside'],
  ])
  const pool = createSharedFolderWatches({
    shares: true,
    realpath(path) {
      if (!folders.has(path)) throw new Error('ENOENT: ' + path)
      return folders.get(path)
    },
    isDirectory: () => true,
    watch(root, listener) {
      const stream = Object.assign(new EventEmitter(), {
        root, listener, closeCount: 0,
        close() { this.closeCount += 1; this.emit('close') },
      })
      streams.push(stream)
      return stream
    },
    plain() { throw new Error('Unexpected plain watch') },
  })
  const parent = '/s/Collection'
  const subscriptions = []
  const attach = (suffix, recursive, handlesErrors = true) => {
    const events = []
    const errors = []
    const path = parent + suffix
    const handle = pool.watch(path, { recursive, anchor: parent }, (type, name) => events.push([type, name]))
    if (handlesErrors) handle.on('error', error => errors.push(error.message))
    const subscription = { events, errors, path: folders.get(path), recursive, handle }
    subscriptions.push(subscription)
    return subscription
  }
  const root = attach('', true)
  const rootDirect = attach('', false)
  const nested = attach('/Collection', true)
  const vault = attach('/.writeflex', false)
  const inbox = attach('/.writeflex/inbox', false)
  const alias = attach('/alias', true)
  const outside = attach('/external-alias', false)
  const widget = attach('/Collection', false, false)
  // The parent's own events are named 'Collection', like its entry 'Collection': the same-named nested
  // folder keeps a native watch of its own (with its alias and the widget), so three in all.
  assert.deepEqual(streams.map(stream => stream.root), ['/s/Collection', '/s/Collection/Collection', '/s/outside'])

  // The native projection follows Node's vendored libuv fsevents.c: exact
  // canonical prefix, basename for a self-event, then per-handle recursion.
  // A self-event drops rename flags, so a renamed and modified directory is
  // 'change' on its own handle but 'rename' on the ancestor.
  const asNative = (watchPath, recursive, target, type, modified = false) => {
    if (target === watchPath) return [type === 'rename' && modified ? 'change' : type, basename(target)]
    if (!target.startsWith(watchPath + '/')) return undefined
    const tail = target.slice(watchPath.length + 1)
    return recursive || !tail.includes('/') ? [type, tail] : undefined
  }
  const samples = [
    ['direct', parent + '/top.md', 'change'],
    ['nested', parent + '/Collection/drafts/deep.md', 'change'],
    ['rename from', parent + '/Collection/old.md', 'rename'],
    ['rename to outside', '/s/outside/new.md', 'rename'],
    ['rename from outside', '/s/outside/incoming.md', 'rename'],
    ['rename to nested', parent + '/Collection/incoming.md', 'rename'],
    ['case-only old', parent + '/Collection/drafts/Old.md', 'rename'],
    ['case-only new', parent + '/Collection/drafts/old.md', 'rename'],
    ['case-only folder new spelling', parent + '/collection/next.md', 'change'],
    ['vault file', parent + '/.writeflex/vault.json', 'change'],
    ['inbox item', parent + '/.writeflex/inbox/r1.json', 'rename'],
    ['vault folder replaced', parent + '/.writeflex', 'rename', true],
    ['root renamed or modified', parent, 'change'],
    ['root renamed and modified', parent, 'rename', true],
    ['nested root modified', parent + '/Collection', 'change'],
    ['nested root renamed and modified', parent + '/Collection', 'rename', true],
    ['sibling prefix', parent + '2/top.md', 'rename'],
  ]
  const rawDifferences = []
  const nameDifferences = []
  for (const [scenario, target, type, modified] of samples) {
    for (const sub of subscriptions) sub.events.length = 0
    for (const stream of streams) {
      const packet = asNative(stream.root, true, target, type, modified)
      if (packet) stream.listener(...packet)
    }
    for (const sub of subscriptions) {
      const event = asNative(sub.path, sub.recursive, target, type, modified)
      const expected = event ? [event] : []
      const difference = { scenario, subscription: sub.path, recursive: sub.recursive, expected, actual: sub.events.slice() }
      if (JSON.stringify(expected) !== JSON.stringify(sub.events)) rawDifferences.push(difference)
      if (JSON.stringify(expected.map(row => row[1])) !== JSON.stringify(sub.events.map(row => row[1]))) nameDifferences.push(difference)
    }
  }
  // Names match everywhere. Types differ only where documented: a folder's own renamed-and-modified
  // event, which its own watch calls 'change' and the root's watch 'rename'.
  assert.deepEqual(nameDifferences, [])
  for (const row of rawDifferences) {
    assert.deepEqual(row.expected.map(([type]) => type), ['change'])
    assert.deepEqual(row.actual.map(([type]) => type), ['rename'])
  }
  assert(rawDifferences.some(row => row.scenario === 'vault folder replaced'))
  console.log(JSON.stringify({ injectedComparisons: samples.length * subscriptions.length, typeOnlyDifferences: rawDifferences.length }))

  // Closing the parent window's own watches leaves the rest of the root's users live.
  root.handle.close()
  root.handle.close()
  rootDirect.handle.close()
  assert.equal(streams[0].closeCount, 0)
  vault.events.length = 0
  streams[0].listener('change', '.writeflex/vault.json')
  assert.deepEqual(vault.events, [['change', 'vault.json']])

  // An error ends the shared watch for each of its users: each listener hears it once.
  streams[0].emit('error', new Error('native failure'))
  assert.equal(streams[0].closeCount, 1)
  assert.deepEqual(vault.errors, ['native failure'])
  assert.deepEqual(inbox.errors, ['native failure'])
  assert.deepEqual(nested.errors, [])
  assert.equal(pool.nativeCount, 2)
  // A user with no error listener gets the error thrown, as an FSWatcher with none would.
  const thrown = []
  const original = globalThis.queueMicrotask
  globalThis.queueMicrotask = run => { try { run() } catch (error) { thrown.push(error.message) } }
  try { streams[1].emit('error', new Error('nested failure')) } finally { globalThis.queueMicrotask = original }
  assert.deepEqual(thrown, ['nested failure'])
  assert.deepEqual(nested.errors, ['nested failure'])
  assert.deepEqual(alias.errors, ['nested failure'])
  assert.equal(pool.nativeCount, 1)
  // A later watch makes a new native watch, which reports again.
  const fresh = attach('/Collection', true)
  assert.equal(streams.length, 4)
  streams[3].listener('change', 'replacement-stream.md')
  assert.deepEqual(fresh.events, [['change', 'replacement-stream.md']])
  fresh.handle.close()
  outside.handle.close()
  assert.equal(pool.nativeCount, 0)
  // A nested Collection that opens before the parent keeps its own native watch, and a later watch of
  // it joins that one, not the parent's.
  const child = pool.watch(parent + '/Collection', { recursive: true, anchor: parent + '/Collection' }, () => {})
  const openedParent = attach('', true)
  const laterChild = attach('/Collection', true)
  assert.equal(pool.nativeCount, 2)
  openedParent.handle.close()
  assert.equal(pool.nativeCount, 1)
  laterChild.handle.close()
  child.close()
  assert.equal(pool.nativeCount, 0)
  console.log(JSON.stringify({ lifecycle: 'closes, errors and replacements behave as plain watches' }))
}

if (process.argv.includes('--injected')) injected()
else await native()
