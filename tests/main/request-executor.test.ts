import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pauseCollectionWrites, resumeCollectionWrites } from '../../src/main/collection-write-gate'
import { INBOX_DIR, MAX_REQUEST_BYTES, OUTBOX_DIR, REQUEST_OPERATIONS, newRequestId } from '../../src/main/cli/request-format'
import { HANDLED_KEEP_MS, REQUEST_MAX_AGE_MS, STALE_FILE_MS } from '../../src/main/request-executor'
import { watchRequestInbox } from '../../src/main/request-inbox-watch'
import { readReplyKey, replyIsSigned } from '../../src/main/reply-key'
import { showText } from '../../src/main/cli/terminal-text'
import { MANIFEST_NAME } from '../../src/main/folio'
import { scrapsPathFor } from '../../src/main/scraps'
import { NOTES, YORK, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { content, inboxNames, openAsApp, outboxNames, plantRequest, replyTo, type AppSide } from '../helpers/request-app'

// Ticket 05, the app's side: the request executor, run without a window.
let fx: WriteFixture
let app: AppSide
let outside: string
beforeEach(async () => {
  fx = await writeFixture()
  app = await openAsApp(fx)
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-request-outside-')))
})
afterEach(async () => {
  resumeCollectionWrites(fx.root)
  await app.close()
  await fx.dispose()
  await rm(outside, { recursive: true, force: true })
})

const MOVE = { path: 'talks/york.md', to: 'talks/york-2026.md' }

test('a valid request is carried out, answered with what the operation prints directly, and removed', async () => {
  const id = await plantRequest(fx, 'move', MOVE)
  const drained = await app.executor.drain()
  expect(drained.handled).toEqual([{ id, outcome: 'applied', operation: 'move', repeat: false }])
  expect(await inboxNames(fx)).toEqual([])
  expect(await fx.read('notes.md')).toBe(NOTES.replaceAll('[[york', '[[york-2026'))
  const reply = await replyTo(fx, id)
  expect(Object.keys(reply).sort()).toEqual(['at', 'id', 'mac', 'operation', 'outcome', 'result', 'text', 'version'])
  expect(replyIsSigned([(await readReplyKey(fx.keys, fx.root))!], reply as unknown as Record<string, unknown>)).toBe(true)
  expect(reply.operation).toBe('move')

  // The same operation run directly on a twin Collection prints the same result: the reply carries no more.
  const twin = await writeFixture()
  try {
    const direct = await twin.cli(['move', MOVE.path, MOVE.to])
    const strip = (result: unknown): unknown => ({ ...(result as Record<string, unknown>), undo: 'id' })
    expect(strip(reply.result)).toEqual(strip(direct.json.result))
  } finally {
    await twin.dispose()
  }
  // The app's own-write record covers what it wrote, and the window is told every path.
  expect(app.changed).toHaveLength(1)
  expect(app.changed[0]).toEqual(expect.arrayContaining(['talks/york.md', 'talks/york-2026.md', 'notes.md', 'talks/intro.md', `talks/${MANIFEST_NAME}`]))
  expect(app.workspace.wasRecentlyWrittenByApp('notes.md')).toBe(true)
})

test('every requestable operation can be carried out on request', async () => {
  await fx.write('history-map.tsv', 'drafts/new.md\tdrafts/outside.md\n')
  let historyUndo: string | undefined
  const requests: Array<[string, Record<string, unknown>]> = [
    ['create', { path: 'drafts/new', content: '# New\n' }], ['create-folder', { path: 'empty' }], ['duplicate', { path: 'notes.md' }],
    ['note', { document: 'talks/york.md', body: 'Tighten the intro.', kind: 'review' }], ['scrap', { document: 'talks/york.md', text: 'A cut line.' }],
    ['create-manifest', { folder: 'drafts' }], ['capture', { project: 'talks', title: 'A line', kind: 'snippet', body: 'A line.' }], ['move', MOVE], ['move-folder', { path: 'talks', to: 'events' }], ['trash', { path: 'notes (copy).md' }],
    ['undo', {}], ['save-version', { path: 'talks/york-2026.md', name: 'As sent', note: 'Before the rewrite.' }],
    ['follow-history', { map: 'history-map.tsv' }], ['undo-history', {}],
  ]
  expect(requests.map(([operation]) => operation).sort()).toEqual([...REQUEST_OPERATIONS].sort())
  // `capture` runs scout, which writes the file itself: a fake one stands in, so no real engine runs.
  const scoutDir = await mkdtemp(join(tmpdir(), 'wf-exec-scout-'))
  const scout = join(scoutDir, 'scout')
  await writeFile(scout, `#!/bin/sh\ncat > /dev/null\nmkdir -p "${fx.root}/talks/research"\nprintf 'A line.\\n' > "${fx.root}/talks/research/2026-10-20-a-line.md"\nprintf '{}\\n' > "${fx.root}/talks/research/_manifest.jsonl"\nprintf '{"file":"${fx.root}/talks/research/2026-10-20-a-line.md","manifest":true,"corpus":null,"indexed":false}\\nIndex complete\\n'\n`, { mode: 0o755 })
  const savedScout = process.env.WRITEFLEX_SCOUT_BIN
  process.env.WRITEFLEX_SCOUT_BIN = scout
  try {
    for (const [operation, args] of requests) {
      if (operation === 'follow-history') await rename(join(fx.root, 'drafts/new.md'), join(fx.root, 'drafts/outside.md'))
      if (operation === 'undo-history') args.id = historyUndo
      const id = await plantRequest(fx, operation, args)
      await app.executor.drain()
      const reply = await replyTo(fx, id)
      expect(reply.reason ?? '', operation).toBe('')
      expect(reply.outcome, operation).toBe('applied')
      if (operation === 'undo-history') await rename(join(fx.root, 'drafts/outside.md'), join(fx.root, 'drafts/new.md'))
      if (operation === 'follow-history') historyUndo = (reply.result as { undo: string }).undo
      if (operation === 'capture') {
        expect(reply.result).toMatchObject({ path: 'talks/research/2026-10-20-a-line.md', project: 'talks', indexed: false })
        // Scout made the file; the window is told it, and the manifest, as for any change the app carries out.
        expect(existsSync(join(fx.root, 'talks/research/2026-10-20-a-line.md'))).toBe(true)
        expect(app.changed.flat()).toEqual(expect.arrayContaining(['talks/research/2026-10-20-a-line.md', 'talks/research/_manifest.jsonl']))
      }
    }
  } finally {
    if (savedScout === undefined) delete process.env.WRITEFLEX_SCOUT_BIN
    else process.env.WRITEFLEX_SCOUT_BIN = savedScout
    await rm(scoutDir, { recursive: true, force: true })
  }
  expect(await fx.read('drafts/new.md')).toBe('---\ncreated-by: Outside agent\n---\n\n# New\n')
  expect(existsSync(join(fx.root, 'empty'))).toBe(true)
  expect(existsSync(join(fx.trashed, 'notes (copy).md'))).toBe(true)
  // The last undo put the folder back (the most recent journalled change was the folder move).
  expect(existsSync(join(fx.root, 'talks/york-2026.md'))).toBe(true)
  // The app's stores were touched by the two version saves alone (the one a create makes to record
  // itself, then the one asked for): for each, one restore point and one snapshot in the history
  // journal and one record in the version journal; and nothing in the review ledger.
  expect(await fx.read('.writeflex/changes.jsonl')).toBe('{"change":"fixture"}\n')
  const history = (await fx.read('.bridle/journal.jsonl')).split('\n').filter(Boolean)
  expect(history[0]).toBe('{"bridle":"fixture"}')
  expect(history.slice(1).map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual(['restore-point', 'snapshot', 'restore-point', 'snapshot'])
  const versions = (await fx.read('.writeflex/versions.jsonl')).split('\n').filter(Boolean)
  expect(versions[0]).toBe('{"version":"fixture"}')
  expect(versions.slice(1).map((line) => JSON.parse(line) as { path?: string }).filter(record => record.path)).toMatchObject([
    { path: 'drafts/new.md', name: 'Created by Outside agent', author: { name: 'Outside agent' } },
    { path: 'talks/york-2026.md', name: 'As sent', note: 'Before the rewrite.', author: { name: 'App Writer' } },
  ])
})

test('a request that fails a check is answered as refused with the reason, removed, and nothing is applied', async () => {
  await symlink(outside, join(fx.root, 'way-out'))
  await symlink(join(fx.root, '.bridle'), join(fx.root, 'looks-fine'))
  const id = newRequestId()
  const whole = (extra: Record<string, unknown>): { body: unknown } => ({ body: { version: 1, id, operation: 'create', args: { path: 'x.md' }, ...extra } })
  const cases: Array<[string, Parameters<typeof plantRequest>[3], Record<string, unknown> | null, string]> = [
    // [what, how the file is written, args for a plain `create`/`move` request, a phrase of the reason]
    ['a path under a dot-folder', {}, { path: '.writeflex/changes.jsonl.md' }, 'dot-folder'],
    ['a path under .bridle', {}, { path: '.bridle/x.md' }, 'dot-folder'],
    ['a path outside the Collection', {}, { path: '../escape.md' }, 'outside the Collection'],
    ['an absolute path outside', {}, { path: join(outside, 'x.md') }, 'outside the Collection'],
    ['a path through a link out of the Collection', {}, { path: 'way-out/x.md' }, 'outside the Collection'],
    ['a path through a link into a dot-folder', {}, { path: 'looks-fine/x.md' }, 'dot-folder'],
    ['a wrong type', {}, { path: 7 }, 'path must be text'],
    ['an unknown argument', {}, { path: 'x.md', author: 'Dominik' }, 'takes no argument "author"'],
    ['a missing argument', {}, {}, 'needs path'],
    ['an unknown field', whole({ author: 'Dominik' }), null, 'a field this format does not have: "author"'],
    ['a status field', whole({ status: 'accepted' }), null, 'a field this format does not have: "status"'],
    ['an unknown version', whole({ version: 2 }), null, 'format version (2)'],
    ['a version that is not a number', whole({ version: 'MARKER\u001b[2J' }), null, 'format version (not a number)'],
    ['a path carrying escape sequences', {}, { path: '../MARK\u001b[2J\u009b31mER.md' }, '"../MARK\\u{1b}[2J\\u{9b}31mER.md" is outside the Collection'],
    ['an unknown field carrying escape sequences', whole({ ['MARK\u001b[2JER']: 1 }), null, 'does not have: "MARK\\u{1b}[2JER"'],
    ['an operation that is not on the list', whole({ operation: 'read' }), null, 'cannot be requested'],
    ['an operation that does not exist', whole({ operation: 'delete-everything' }), null, 'cannot be requested'],
    ['another id inside than in the name', { body: { version: 1, id: newRequestId(), operation: 'create', args: { path: 'x.md' } } }, null, 'identifier'],
    ['text that is not JSON', { text: '{"version":1,' }, null, 'not JSON'],
    ['JSON that is not an object', { text: '[1]' }, null, 'not an object'],
    ['a file over the size limit', { text: Buffer.alloc(MAX_REQUEST_BYTES + 1, 0x20) }, null, `the limit is ${MAX_REQUEST_BYTES}`],
  ]
  const before = await content(fx)
  for (const [what, how, args, phrase] of cases) {
    await plantRequest(fx, 'create', args ?? {}, { id, ...how })
    const drained = await app.executor.drain()
    expect(drained.handled, what).toMatchObject([{ id, outcome: 'refused' }])
    const reply = await replyTo(fx, id)
    expect(reply.outcome, what).toBe('refused')
    // As the command line prints it: what came from the request file is quoted, on one line, with every hidden character shown.
    expect(showText(reply.reason!), what).toContain(phrase)
    expect(showText(reply.reason!), what).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
    expect(reply, what).not.toHaveProperty('result')
    expect(await inboxNames(fx), what).toEqual([])
    expect(await content(fx), what).toEqual(before)
    await rm(fx.handledDir, { recursive: true }) // so the same id can be used for the next case
  }
  expect(await readdir(outside)).toEqual([])

  // Export is never a request, with or without the confirmation: an unknown operation, and nothing is written anywhere.
  for (const args of [
    { path: 'notes.md', to: join(outside, 'n.html'), confirm: true },
    { path: 'notes.md', to: join(outside, 'n.html') },
    { path: 'notes.md', to: join(fx.root, 'inside.html'), format: 'html', confirm: true },
  ]) {
    const exportId = await plantRequest(fx, 'export', args)
    const drained = await app.executor.drain()
    expect(drained.handled).toMatchObject([{ id: exportId, outcome: 'refused' }])
    expect(showText((await replyTo(fx, exportId)).reason!)).toContain('an operation that cannot be requested: "export"')
  }
  expect(await readdir(outside)).toEqual([])
  expect(await content(fx)).toEqual(before)
})

test('a move that fails partway is answered as refused and nothing is left changed', async () => {
  const before = await content(fx)
  let writes = 0
  const executor = app.restarted({ seams: { write: { beforeWrite: async () => { if (++writes === 4) throw new Error('disk fault') } } } })
  const id = await plantRequest(fx, 'move', MOVE)
  await executor.drain()
  const reply = await replyTo(fx, id)
  expect(reply).toMatchObject({ outcome: 'refused' })
  expect(reply.reason).toContain('disk fault')
  expect(reply.reason).toContain('Nothing was left changed')
  expect(await content(fx)).toEqual(before)
})

test('the request folders are not used when one is a link, and a request that is a link is never followed', async () => {
  const real = await plantRequest(fx, 'create', { path: 'planted.md', content: 'x' })
  await rename(join(fx.root, INBOX_DIR), join(outside, 'inbox'))
  await symlink(join(outside, 'inbox'), join(fx.root, INBOX_DIR))
  await expect(app.executor.drain()).rejects.toThrow('not an ordinary folder')
  expect(existsSync(join(fx.root, 'planted.md'))).toBe(false)
  expect(existsSync(join(outside, 'inbox', `${real}.json`))).toBe(true)
  await rm(join(fx.root, INBOX_DIR))

  await mkdir(join(fx.root, INBOX_DIR))
  await symlink(outside, join(fx.root, OUTBOX_DIR))
  await plantRequest(fx, 'create', { path: 'planted.md', content: 'x' })
  await expect(app.executor.drain()).rejects.toThrow('not an ordinary folder')
  expect(existsSync(join(fx.root, 'planted.md'))).toBe(false)
  await rm(join(fx.root, OUTBOX_DIR))
  await rm(join(fx.root, INBOX_DIR), { recursive: true })

  // A link named like a request, pointing at a valid request kept elsewhere.
  const id = newRequestId()
  await writeFile(join(outside, 'request.json'), JSON.stringify({ version: 1, id, operation: 'create', args: { path: 'planted.md', content: 'x' } }))
  await mkdir(join(fx.root, INBOX_DIR))
  await symlink(join(outside, 'request.json'), join(fx.root, INBOX_DIR, `${id}.json`))
  await app.executor.drain()
  expect((await replyTo(fx, id)).reason).toContain('not an ordinary file')
  expect(existsSync(join(fx.root, 'planted.md'))).toBe(false)
  expect(existsSync(join(outside, 'request.json'))).toBe(true) // the link was removed, not what it pointed at
  expect(await inboxNames(fx)).toEqual([])
})

test('sync conflict copies of request files are ignored and reported, never acted on', async () => {
  const id = newRequestId()
  const body = JSON.stringify({ version: 1, id, operation: 'create', args: { path: 'planted.md', content: 'x' } })
  const copies = [`${id} (conflicted copy 2026-10-07).json`, `${id}-Dominiks-MacBook.json`, `${id} 2.json`]
  for (const name of copies) await plantRequest(fx, 'create', {}, { name, text: body })
  await plantRequest(fx, 'create', {}, { name: 'README.txt', text: 'hello' })
  const drained = await app.executor.drain()
  expect(drained.handled).toEqual([])
  expect(drained.ignored).toEqual([...copies.map((name) => ({ name, why: 'conflict-copy' as const })), { name: 'README.txt', why: 'not-a-request' as const }].sort((a, b) => a.name.localeCompare(b.name)))
  expect(existsSync(join(fx.root, 'planted.md'))).toBe(false)
  expect(await inboxNames(fx)).toEqual([...copies, 'README.txt'].sort())
  expect(await outboxNames(fx)).toEqual([])

  // The running app's watch reports each ignored file once, however often it looks.
  const reports: Array<[string, Record<string, unknown>]> = []
  const watching = watchRequestInbox(app.executor, { pollMs: 5, report: (event, details) => { reports.push([event, details]) } })
  const realId = await plantRequest(fx, 'create', { path: 'asked.md', content: 'x' })
  for (let i = 0; i < 200 && !reports.some(([event]) => event === 'handled'); i++) await new Promise((done) => { setTimeout(done, 10) })
  await new Promise((done) => { setTimeout(done, 40) })
  watching.dispose()
  expect(reports.filter(([event]) => event === 'handled')).toMatchObject([['handled', { id: realId, outcome: 'applied' }]])
  expect(reports.filter(([event]) => event === 'ignored').map(([, details]) => details.name).sort()).toEqual([...copies, 'README.txt'].sort())
  expect(await fx.read('asked.md')).toBe('---\ncreated-by: Outside agent\n---\n\nx')
})

test('a request read twice is acted on once: the stored reply is given again, also after a restart', async () => {
  const body = { document: 'talks/york.md', text: 'A cut line.' }
  const id = await plantRequest(fx, 'scrap', body)
  await app.executor.drain()
  const first = await replyTo(fx, id)
  expect(first.outcome).toBe('applied')
  const scraps = await fx.read(scrapsPathFor('talks/york.md'))

  // The app crashed after acting and before clearing the request: on restart the file is still there.
  await rm(join(fx.root, OUTBOX_DIR, `${id}.json`))
  await plantRequest(fx, 'scrap', body, { id })
  const again = await app.restarted().drain()
  expect(again.handled).toEqual([{ id, outcome: 'applied', repeat: true }])
  expect(await fx.read(scrapsPathFor('talks/york.md'))).toBe(scraps)
  expect(await replyTo(fx, id)).toEqual(first)
  expect(await inboxNames(fx)).toEqual([])
})

test('a request the app stopped in the middle of is not carried out again: it is refused, pointing at undo', async () => {
  const crash = app.restarted({ seams: { afterActing: async () => { throw new Error('the app stopped here') } } })
  const id = await plantRequest(fx, 'scrap', { document: 'talks/york.md', text: 'A cut line.' })
  await expect(crash.drain()).rejects.toThrow('the app stopped here')
  const scraps = await fx.read(scrapsPathFor('talks/york.md'))
  expect(await inboxNames(fx)).toEqual([`${id}.json`])
  expect(await outboxNames(fx)).toEqual([])

  const drained = await app.restarted().drain()
  expect(drained.handled).toMatchObject([{ id, outcome: 'refused', repeat: true }])
  expect((await replyTo(fx, id)).reason).toContain('undo --list')
  expect(await fx.read(scrapsPathFor('talks/york.md'))).toBe(scraps)
  expect(await inboxNames(fx)).toEqual([])
})

test('the autosave case: a document the app saved two seconds ago has a link repaired on request, and the repair survives the next autosave', async () => {
  // The app has notes.md open in a tab with nothing unsaved, and has just autosaved it.
  let tab = `${NOTES}\nTyped in WriteFlex.\n`
  const savedAt = Date.now()
  // Each save says which version the tab was based on (save fix): here, the file as opened.
  await app.workspace.saveEditorText('notes.md', tab, { kind: 'disk', text: await fx.read('notes.md') })
  // Two seconds later the folder watcher still disregards a change to that path (the app wrote it
  // within five seconds), so a change made from outside would go unseen and the next autosave would undo it.
  expect(app.workspace.wasRecentlyWrittenByApp('notes.md', savedAt + 2000)).toBe(true)

  // The window, told a path changed on disk, reloads a tab that has nothing unsaved.
  const executor = app.restarted({
    onChanged: (paths) => {
      app.changed.push(paths)
      if (paths.includes('notes.md')) void fx.read('notes.md').then((text) => { tab = text })
    },
  })
  const id = await plantRequest(fx, 'move', MOVE)
  await executor.drain()
  expect((await replyTo(fx, id)).outcome).toBe('applied')
  // The app made the change itself, so the window is told of it whatever the watcher disregards.
  expect(app.changed.flat()).toContain('notes.md')
  await new Promise((done) => { setTimeout(done, 20) })

  await app.workspace.saveEditorText('notes.md', tab, { kind: 'disk', text: tab }) // the app's next autosave, based on what the reload read
  const onDisk = await fx.read('notes.md')
  expect(onDisk).toContain('[[york-2026]]')
  expect(onDisk).not.toContain('[[york]]')
  expect(onDisk).toContain('Typed in WriteFlex.')
})

test('a request arriving while the lock is lost is answered as refused, not queued', async () => {
  const before = await content(fx)
  app.owns.value = false
  const id = await plantRequest(fx, 'move', MOVE)
  const drained = await app.executor.drain()
  expect(drained.handled).toMatchObject([{ id, outcome: 'refused', operation: 'move' }])
  expect((await replyTo(fx, id)).reason).toContain('does not hold this Collection')
  expect(await inboxNames(fx)).toEqual([])
  expect(await content(fx)).toEqual(before)
  // It is not carried out later, when the lock is back.
  app.owns.value = true
  await app.executor.drain()
  expect(await content(fx)).toEqual(before)
})

test('every write made for a request asks the shared Collection write gate', async () => {
  // Two scraps: the second changes an existing file, so there is a journalled change for undo to act on.
  for (const text of ['First.', 'Again.']) {
    await plantRequest(fx, 'scrap', { document: 'talks/york.md', text })
    await app.executor.drain()
  }
  // A folder that is not inside, above or equal to the Folio `talks`, so the Folio guard is not what refuses create-manifest.
  await fx.write('essays/a.md', '# A\n')
  const before = await content(fx)
  // The executor is told it owns the Collection; only the gate says no. Each write must have asked it.
  pauseCollectionWrites(fx.root, 'Saving is paused: another program has taken over the folder.')
  const requests: Array<[string, Record<string, unknown>]> = [
    ['create', { path: 'x.md', content: 'x' }], ['create-folder', { path: 'empty' }], ['duplicate', { path: 'notes.md' }], ['note', { document: 'talks/york.md', body: 'n' }],
    ['scrap', { document: 'talks/york.md', text: 'Second.' }], ['create-manifest', { folder: 'essays' }], ['move', MOVE], ['move-folder', { path: 'talks', to: 'events' }],
    ['trash', { path: 'notes.md' }], ['undo', {}],
  ]
  for (const [operation, args] of requests) {
    const id = await plantRequest(fx, operation, args)
    await app.executor.drain()
    const reply = await replyTo(fx, id)
    expect(reply.outcome, operation).toBe('refused')
    expect(reply.reason, operation).toContain('Saving is paused')
    expect(reply.reason, operation).not.toMatch(/Folio/i)
    expect(await content(fx), operation).toEqual(before)
  }
  expect(await readdir(fx.trashed)).toEqual([])
})

test('a path swapped for a link between the check and the write is not followed, for every kind of write a request makes', async () => {
  // Before the write of `path`, its folder is replaced by a link to a folder outside the Collection.
  const swapAt = (folder: string) => ({
    seams: { write: { betweenCheckAndWrite: async () => {
      if (!existsSync(join(outside, 'kept'))) {
        await rename(join(fx.root, folder), join(outside, 'kept'))
        await symlink(outside, join(fx.root, folder))
      }
    } } },
  })
  const requests: Array<[string, Record<string, unknown>]> = [
    ['create', { path: 'talks/new.md', content: 'x' }], ['duplicate', { path: 'talks/york.md' }], ['scrap', { document: 'talks/york.md', text: 'A cut.' }],
    ['note', { document: 'talks/york.md', body: 'n' }], ['create-manifest', { folder: 'essays' }], ['move', { path: 'talks/york.md', to: 'talks/y.md' }], ['trash', { path: 'talks/york.md' }],
  ]
  await fx.write('talks/sub/part.md', '# Part\n')
  await fx.write('essays/york.md', YORK) // a folder outside the Folio, so create-manifest is not refused by the Folio guard
  await mkdir(join(fx.root, 'talks/scraps'))
  await fx.write(scrapsPathFor('talks/york.md'), '## a1b2\nEarlier.\n')
  for (const [operation, args] of requests) {
    const id = await plantRequest(fx, operation, args)
    const swapped = operation === 'create-manifest' ? 'essays' : 'talks'
    await app.restarted(swapAt(swapped)).drain()
    const reply = await replyTo(fx, id)
    expect(reply.outcome, `${operation}: ${reply.text ?? ''}`).toBe('refused')
    // Refusal copy may contain absolute paths; checkout names are not Folio-guard messages.
    const message = `${reply.reason ?? ''} ${reply.text ?? ''}`.replaceAll(fx.root, '<collection>').replaceAll(outside, '<outside>')
    expect(message, operation).not.toMatch(/Folio/i)
    // Nothing was written or moved at the far end of the link, and nothing went to the Trash.
    expect(await readdir(outside), operation).toEqual(['kept'])
    expect(await readFile(join(outside, 'kept', 'york.md'), 'utf8'), operation).toBe(YORK)
    expect(await readdir(fx.trashed), operation).toEqual([])
    await rm(join(fx.root, swapped))
    await rename(join(outside, 'kept'), join(fx.root, swapped))
  }
})

test('old replies, unrenamed temporary files and old handled-request records are pruned; an old request is refused', async () => {
  const id = await plantRequest(fx, 'create-folder', { path: 'made' })
  await app.executor.drain()
  const old = new Date(Date.now() - STALE_FILE_MS - 60_000)
  const reply = join(fx.root, OUTBOX_DIR, `${id}.json`)
  const fresh = join(fx.root, OUTBOX_DIR, `${newRequestId()}.json`)
  const staged = join(fx.root, INBOX_DIR, `.${newRequestId()}.json.abcd1234.tmp`)
  const foreign = join(fx.root, OUTBOX_DIR, 'keep-me.txt')
  for (const path of [fresh, staged, foreign]) await writeFile(path, '{}')
  for (const path of [reply, staged, foreign]) await utimes(path, old, old)
  await app.executor.drain()
  expect(existsSync(reply)).toBe(false)
  expect(existsSync(staged)).toBe(false)
  expect(existsSync(fresh)).toBe(true)
  expect(existsSync(foreign)).toBe(true) // not a reply's name: never touched
  // The record of the handled request outlives its reply, and goes after seven days.
  const record = join(fx.handledDir, `${id}.json`)
  expect(existsSync(record)).toBe(true)
  const older = new Date(Date.now() - HANDLED_KEEP_MS - 60_000)
  await utimes(record, older, older)
  await app.executor.drain()
  expect(existsSync(record)).toBe(false)

  // A request made longer ago than the limit is refused, so a pruned record can never let it through again.
  const stale = newRequestId(new Date(Date.now() - REQUEST_MAX_AGE_MS - 60_000))
  await plantRequest(fx, 'create-folder', { path: 'late' }, { id: stale })
  await app.executor.drain()
  expect((await replyTo(fx, stale)).reason).toContain('too long ago')
  expect(existsSync(join(fx.root, 'late'))).toBe(false)
  expect(await fx.journalNames()).toEqual([])
})

test('a request folder swapped for a link after it was opened is not read from and not written into', async () => {
  // Between opening the inbox and reading a request: the inbox becomes a link to a folder holding a valid request of that name.
  const id = await plantRequest(fx, 'create', { path: 'planted.md', content: 'x' })
  const swapInbox = app.restarted({ seams: { beforeRead: async () => {
    await rename(join(fx.root, INBOX_DIR), join(outside, 'inbox'))
    await symlink(join(outside, 'inbox'), join(fx.root, INBOX_DIR))
  } } })
  await expect(swapInbox.drain()).rejects.toThrow('changed while it was in use')
  expect(existsSync(join(fx.root, 'planted.md'))).toBe(false)
  expect(existsSync(join(outside, 'inbox', `${id}.json`))).toBe(true)
  await rm(join(fx.root, INBOX_DIR))
  await rename(join(outside, 'inbox'), join(fx.root, INBOX_DIR))
  await rm(join(fx.root, INBOX_DIR, `${id}.json`))

  // Between acting and replying: the outbox becomes a link. The reply is not written at its far end.
  await mkdir(join(outside, 'elsewhere'))
  const second = await plantRequest(fx, 'create-folder', { path: 'made' })
  const swapOutbox = app.restarted({ seams: { afterActing: async () => {
    await rename(join(fx.root, OUTBOX_DIR), join(outside, 'outbox'))
    await symlink(join(outside, 'elsewhere'), join(fx.root, OUTBOX_DIR))
  } } })
  await expect(swapOutbox.drain()).rejects.toThrow('changed while it was in use')
  expect(await readdir(join(outside, 'elsewhere'))).toEqual([])
  await rm(join(fx.root, OUTBOX_DIR))
  await rename(join(outside, 'outbox'), join(fx.root, OUTBOX_DIR))
  // The request was carried out once; met again, it gets its stored reply and is not carried out again.
  expect((await app.restarted().drain()).handled).toMatchObject([{ id: second, outcome: 'applied', repeat: true }])

  // Between writing the reply under its temporary name and renaming it: the reply is not put in place at the far end.
  const third = await plantRequest(fx, 'create-folder', { path: 'made-too' })
  const swapAtRename = app.restarted({ seams: { reply: { beforeRename: async () => {
    await rename(join(fx.root, OUTBOX_DIR), join(outside, 'outbox'))
    await symlink(join(outside, 'elsewhere'), join(fx.root, OUTBOX_DIR))
  } } } })
  await expect(swapAtRename.drain()).rejects.toThrow('changed while it was in use')
  expect(await readdir(join(outside, 'elsewhere'))).toEqual([])
  expect((await readdir(join(outside, 'outbox'))).filter((name) => name === `${third}.json`)).toEqual([])
})

test('without a reply key nothing is carried out, and a stored reply given again is signed with the key of the day', async () => {
  const before = await content(fx)
  const id = await plantRequest(fx, 'create', { path: 'x.md', content: 'x' })
  await app.restarted({ replyKey: async () => null }).drain()
  const unsigned = await replyTo(fx, id)
  expect(unsigned).toMatchObject({ outcome: 'refused' })
  expect(unsigned.reason).toContain('no reply key')
  expect(unsigned).not.toHaveProperty('mac')
  expect(await content(fx)).toEqual(before)

  // Carried out under one key; met again after the app was started anew, with a new key.
  const second = await plantRequest(fx, 'create-folder', { path: 'made' })
  await app.executor.drain()
  const first = await replyTo(fx, second)
  const oldKey = (await readReplyKey(fx.keys, fx.root))!
  await app.close()
  app = await openAsApp(fx)
  const newKey = (await readReplyKey(fx.keys, fx.root))!
  expect(newKey.equals(oldKey)).toBe(false)
  await plantRequest(fx, 'create-folder', { path: 'made' }, { id: second })
  await app.executor.drain()
  const again = await replyTo(fx, second) as unknown as Record<string, unknown>
  expect(again).toMatchObject({ outcome: 'applied' })
  expect(replyIsSigned([newKey], again)).toBe(true)
  expect(replyIsSigned([oldKey], again)).toBe(false)
  expect(replyIsSigned([newKey], first as unknown as Record<string, unknown>)).toBe(false)
})

// A Piece named with a leading dot is a visible file, not a hidden folder: the app-open route judges the path by what it is,
// as the closed-app route does.
test('capture accepts a dot-named Piece as a file when the app is open, and still refuses a hidden folder', async () => {
  await writeFile(join(fx.root, 'talks/.draft.md'), '# Draft\n')
  await mkdir(join(fx.root, '.hidden-stuff'))
  const scoutDir = await mkdtemp(join(tmpdir(), 'wf-exec-scout-'))
  const scout = join(scoutDir, 'scout')
  await writeFile(scout, `#!/bin/sh\ncat > /dev/null\nprintf '{"file":"${fx.root}/talks/research/x.md","corpus":null,"indexed":false}'\n`, { mode: 0o755 })
  const saved = process.env.WRITEFLEX_SCOUT_BIN
  process.env.WRITEFLEX_SCOUT_BIN = scout
  try {
    const ok = await plantRequest(fx, 'capture', { project: 'talks/.draft.md', title: 'T', kind: 'snippet', body: 'b' })
    const hidden = await plantRequest(fx, 'capture', { project: '.hidden-stuff', title: 'T', kind: 'snippet', body: 'b' })
    await app.executor.drain()
    expect((await replyTo(fx, ok)).reason ?? '').toBe('')
    expect((await replyTo(fx, ok)).outcome).toBe('applied')
    expect((await replyTo(fx, hidden)).outcome).toBe('refused')
  } finally {
    if (saved === undefined) delete process.env.WRITEFLEX_SCOUT_BIN
    else process.env.WRITEFLEX_SCOUT_BIN = saved
    await rm(scoutDir, { recursive: true, force: true })
  }
})

// The gate is asked last of all before scout is spawned: writes paused after the project was judged stop the capture.
test('capture on request: writes paused after the project was validated, and scout is not spawned', async () => {
  const scoutDir = await mkdtemp(join(tmpdir(), 'wf-exec-scout-'))
  const scout = join(scoutDir, 'scout')
  const spawned = join(scoutDir, 'spawned')
  await writeFile(scout, `#!/bin/sh\ncat > /dev/null\ntouch "${spawned}"\nprintf '{"file":"${fx.root}/talks/research/x.md","corpus":null,"indexed":false}'\n`, { mode: 0o755 })
  const saved = process.env.WRITEFLEX_SCOUT_BIN
  process.env.WRITEFLEX_SCOUT_BIN = scout
  const original = app.workspace.classifyPath.bind(app.workspace)
  let seenProject = false
  app.workspace.classifyPath = ((...args: Parameters<typeof original>) => {
    // The executor judges the path first; the capture's own project look is the one that follows.
    if (args[0] === 'talks' && seenProject) pauseCollectionWrites(fx.root, 'Saving is paused: another program has taken over the folder.')
    if (args[0] === 'talks') seenProject = true
    return original(...args)
  }) as typeof original
  try {
    const id = await plantRequest(fx, 'capture', { project: 'talks', title: 'T', kind: 'snippet', body: 'b' })
    await app.executor.drain()
    const reply = await replyTo(fx, id)
    expect(reply.outcome).toBe('refused')
    expect(reply.reason).toContain('Saving is paused')
    expect(existsSync(spawned)).toBe(false)
  } finally {
    resumeCollectionWrites(fx.root)
    if (saved === undefined) delete process.env.WRITEFLEX_SCOUT_BIN
    else process.env.WRITEFLEX_SCOUT_BIN = saved
    await rm(scoutDir, { recursive: true, force: true })
  }
})

test('scratchpad read requests return typed inventory without a document write or undo journal', async () => {
  const before = await fx.read('notes.md')
  const id = await plantRequest(fx, 'scratchpad', { path: 'notes.md' })
  const drained = await app.executor.drain()
  expect(drained.handled).toEqual([{ id, outcome: 'applied', operation: 'scratchpad', repeat: false }])
  const reply = await replyTo(fx, id)
  expect(reply.result).toMatchObject({ items: [], inventory: { items: [], notices: [] } })
  expect(await fx.read('notes.md')).toBe(before)
})
