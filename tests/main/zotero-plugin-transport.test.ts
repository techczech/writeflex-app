/**
 * The WriteFlex side of the plugin route: bridge file, ping, one request per outbox row, and each
 * answer (or silence) mapped onto the outbox. Every request goes to a local fake server on a free port
 * (the real plugin logic over a fake Zotero, or a canned answer); no test can reach a real Zotero.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore } from '@readflex/sidecar'
import { createBunSqliteDriver } from '@readflex/sqlite-driver/bun'
import {
  annotationPayload,
  areaQuotationPayload,
  COMMENT_TOO_LONG_REASON,
  UNVERIFIABLE_CHANGE_REASON,
  validBaseline,
  type SavedAnnotation,
  type ZoteroWriteAttempt,
} from '../../src/main/zotero-annotation-writes'
import { highlightsResult, mergeWithOutbox } from '../../src/main/reading-room-highlights'
import { queueAnnotationChange } from '../../src/main/zotero-outbox-edits'
import { createHeldMarks } from '../../src/renderer/src/reading-room-held-marks'
import {
  drainOutboxToZoteroPlugin,
  pingZoteroPlugin,
  PLUGIN_MISSING_REASON,
  PLUGIN_NOT_PAIRED_REASON,
  readBridgeFile,
  currentPluginSession,
  outcomeFromAnswer,
  readAnnotationsThroughPlugin,
  signedHeaders,
  ZOTERO_BUSY_REASON,
  ZOTERO_CLOSED_REASON,
  type ZoteroPluginConnection,
} from '../../src/main/zotero-plugin-transport'
import {
  memoryZotero,
  plugin,
  pluginContext,
  signRequest,
  startFakeZoteroPlugin,
  TEST_TOKEN,
  writeBridgeFile,
  type FakeZoteroPlugin,
} from '../helpers/fake-zotero-plugin'

const PDF = 'PDFKEY22'
const MARK = 'MARKKEY2'
const POSITION = '{"pageIndex":3,"rects":[[1,2,3,4]]}'
const annotation: SavedAnnotation = {
  color: '#ffd400',
  comment: 'the crux',
  key: MARK,
  pageLabel: '4',
  position: POSITION,
  sortIndex: '00003|000100|00050',
  tags: ['models'],
  text: 'a passage',
  type: 'highlight',
}
const shown = {
  color: '#ffd400', comment: 'the crux', pageLabel: '4', position: POSITION, sortIndex: '00003|000100|00050', text: 'a passage',
}
/** A deletion's before-state as the reader sends it: with the tags it was shown (none here). */
const shownForDelete = { ...shown, zoteroState: { modified: null, tags: [] } }

/** An answer signed as the plugin signs it, for the request with this nonce. */
function signedResponse(nonce: string, status: number, body: string, token = TEST_TOKEN): Response {
  const message = ['WriteFlex-Response-3', String(status), nonce, createHash('sha256').update(body).digest('hex')].join('\n')
  const signature = createHmac('sha256', Buffer.from(token, 'hex')).update(message).digest('hex')
  return new Response(body, { headers: { 'Content-Type': 'application/json', 'X-WriteFlex-Signature': signature }, status })
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function temp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(directory, { force: true, recursive: true }))
  return directory
}

function store(): SidecarStore {
  const sidecar = new SidecarStore(createBunSqliteDriver(), join(temp('wf-plugin-outbox-'), 'sidecar.sqlite'))
  cleanups.push(() => sidecar.close())
  return sidecar
}

/** A Zotero with one PDF in the personal library. */
function zotero(keys: string[] = []) {
  const fake = memoryZotero({ keys })
  fake.put({ key: PDF, kind: 'pdf', libraryID: 1 })
  return fake
}

/** A port with nothing listening on it. */
function closedPort(): number {
  const server = Bun.serve({ fetch: () => new Response(''), hostname: '127.0.0.1', port: 0 })
  const port = server.port as number
  void server.stop(true)
  return port
}

function serve(options: Parameters<typeof startFakeZoteroPlugin>[0]): FakeZoteroPlugin {
  const server = startFakeZoteroPlugin(options)
  cleanups.push(() => server.stop())
  return server
}

function connection(dataDirectory: string, extra: Partial<ZoteroPluginConnection> = {}): ZoteroPluginConnection {
  return { dataDirectory: () => dataDirectory, defaultPort: closedPort(), pingTimeoutMs: 1_000, writeTimeoutMs: 1_000, ...extra }
}

const READER_ONE = '1'.repeat(32)
const READER_TWO = '2'.repeat(32)

function queueCreate(sidecar: SidecarStore, key = MARK, session: string | null = READER_ONE): number {
  return sidecar.enqueueOutbox({
    itemKey: key, libraryId: 1, operation: 'create', parentItemKey: PDF,
    payload: JSON.stringify({ ...annotationPayload({ ...annotation, key }, PDF), ...(session ? { readflexReaderSession: session } : {}) }),
  }).id
}

function queueChange(sidecar: SidecarStore, operation: 'update' | 'delete', changed: Partial<SavedAnnotation>, baseline: unknown = shown, key = MARK, session: string | null = READER_ONE): number {
  return sidecar.enqueueOutbox({
    itemKey: key, libraryId: 1, operation, parentItemKey: PDF,
    payload: JSON.stringify({
      ...annotationPayload({ ...annotation, ...changed, key }, PDF, undefined, { keepWholeComment: true }),
      ...(baseline ? { readflexBaseline: baseline } : {}),
      ...(session ? { readflexReaderSession: session } : {}),
    }),
  }).id
}

describe('the bridge file and the ping', () => {
  test('the bridge file is read field by field; a malformed one is no bridge', async () => {
    const directory = temp('wf-bridge-')
    expect(await readBridgeFile(directory)).toBeNull()
    writeBridgeFile(directory, { port: 4321, token: TEST_TOKEN })
    expect(await readBridgeFile(directory)).toEqual({ pluginVersion: '1.0.0', port: 4321, protocol: plugin.PROTOCOL, token: TEST_TOKEN })
    // A file from a plugin that wrote no protocol speaks none this side knows.
    writeFileSync(join(directory, 'writeflex', 'bridge.json'), JSON.stringify({ port: 4321, token: TEST_TOKEN }))
    expect(await readBridgeFile(directory)).toMatchObject({ protocol: 0 })
    writeBridgeFile(directory, { port: 4321, token: 'short' })
    expect(await readBridgeFile(directory)).toBeNull()
    expect(await readBridgeFile(null)).toBeNull()
  })

  test('nothing listening is Zotero closed', async () => {
    const directory = temp('wf-bridge-')
    writeBridgeFile(directory, { port: closedPort(), token: TEST_TOKEN })
    expect(await pingZoteroPlugin(connection(directory))).toEqual({ code: 'zotero-closed', kind: 'unavailable', reason: ZOTERO_CLOSED_REASON })
    // No bridge file: the default port is tried, and nothing listens there either.
    expect(await pingZoteroPlugin(connection(temp('wf-bridge-')))).toMatchObject({ code: 'zotero-closed' })
  })

  test('with the default port switched off (a test library), no bridge file means closed, and nothing is asked', async () => {
    const server = serve({ respond: () => new Response('No endpoint found\n', { status: 404 }) })
    const directory = temp('wf-bridge-')
    expect(await pingZoteroPlugin(connection(directory, { defaultPort: null }))).toMatchObject({ code: 'zotero-closed' })
    expect(server.requests).toEqual([])
    // A bridge file is still followed.
    writeBridgeFile(directory, { port: server.port, token: TEST_TOKEN })
    expect(await pingZoteroPlugin(connection(directory, { defaultPort: null }))).toMatchObject({ code: 'plugin-missing' })
  })

  test('Zotero without the plugin answers 404: plugin missing', async () => {
    const directory = temp('wf-bridge-')
    const server = serve({ respond: () => new Response('No endpoint found\n', { status: 404 }) })
    writeBridgeFile(directory, { port: server.port, token: TEST_TOKEN })
    expect(await pingZoteroPlugin(connection(directory))).toEqual({ code: 'plugin-missing', kind: 'unavailable', reason: PLUGIN_MISSING_REASON })
    // With no bridge file at all the ping still finds Zotero on the default port and tells the cases apart.
    expect(await pingZoteroPlugin(connection(temp('wf-bridge-'), { defaultPort: server.port }))).toMatchObject({ code: 'plugin-missing' })
  })

  test('a plugin that does not accept the key is not paired, and so is one found with no bridge file', async () => {
    const directory = temp('wf-bridge-')
    const server = serve({ bridgeToken: 'b'.repeat(64), dataDirectory: directory, zotero: zotero().Z })
    expect(await pingZoteroPlugin(connection(directory))).toEqual({ code: 'plugin-not-paired', kind: 'unavailable', reason: PLUGIN_NOT_PAIRED_REASON })
    expect(await pingZoteroPlugin(connection(temp('wf-bridge-'), { defaultPort: server.port }))).toMatchObject({ code: 'plugin-not-paired' })
  })

  test('a plugin speaking another protocol is outdated', async () => {
    // Its bridge file says so (the round-1 plugin wrote protocol 1)...
    const older = temp('wf-bridge-')
    const server = serve({ respond: () => Response.json({ pluginVersion: '0.9.0', protocol: 1, zoteroVersion: '11' }) })
    writeBridgeFile(older, { port: server.port, protocol: 1, token: TEST_TOKEN })
    expect(await pingZoteroPlugin(connection(older))).toMatchObject({ code: 'plugin-outdated', reason: PLUGIN_MISSING_REASON })
    // ...or it answers 409, or its signed answer names another protocol.
    const refusing = temp('wf-bridge-')
    serve({ dataDirectory: refusing, respond: () => Response.json({ protocol: 3 }, { status: 409 }) })
    expect(await pingZoteroPlugin(connection(refusing))).toMatchObject({ code: 'plugin-outdated' })
    const newer = temp('wf-bridge-')
    serve({ dataDirectory: newer, respond: (request) => signedResponse(request.headers['x-writeflex-nonce']!, 200, JSON.stringify({ protocol: 4, sessionId: 'a'.repeat(32) })) })
    expect(await pingZoteroPlugin(connection(newer))).toMatchObject({ code: 'plugin-outdated' })
  })

  test('a signed ping without a session id is an older plugin; with one, it is remembered', async () => {
    const missing = temp('wf-bridge-')
    serve({ dataDirectory: missing, respond: (request) => signedResponse(request.headers['x-writeflex-nonce']!, 200, JSON.stringify({ pluginVersion: '1.0.0', protocol: plugin.PROTOCOL, zoteroVersion: '11' })) })
    expect(await pingZoteroPlugin(connection(missing))).toMatchObject({ code: 'plugin-outdated' })
    const directory = temp('wf-bridge-')
    const server = serve({ dataDirectory: directory, sessionId: 'c0ffee'.repeat(5) + 'ab', zotero: zotero().Z })
    const link = connection(directory)
    expect(await pingZoteroPlugin(link)).toMatchObject({ kind: 'ready', sessionId: 'c0ffee'.repeat(5) + 'ab' })
    expect(currentPluginSession(link)).toBe('c0ffee'.repeat(5) + 'ab')
    server.restart('d00d'.repeat(8))
    await pingZoteroPlugin(link)
    expect(currentPluginSession(link)).toBe('d00d'.repeat(8))
  })

  test('a ping answer that is not signed with the key is not paired, whatever it says', async () => {
    const body = JSON.stringify({ pluginVersion: '1.0.0', protocol: plugin.PROTOCOL, zoteroVersion: '11' })
    for (const respond of [
      () => new Response(body, { headers: { 'Content-Type': 'application/json' } }),
      (request: { headers: Record<string, string> }) => signedResponse(request.headers['x-writeflex-nonce']!, 200, body, 'b'.repeat(64)),
      // Signed for another request.
      () => signedResponse('0'.repeat(32), 200, body),
      // Signed, but over another body.
      (request: { headers: Record<string, string> }) => {
        const signed = signedResponse(request.headers['x-writeflex-nonce']!, 200, body)
        return new Response(body.replace('11', '12'), { headers: signed.headers })
      },
    ]) {
      const directory = temp('wf-bridge-')
      serve({ dataDirectory: directory, respond })
      expect(await pingZoteroPlugin(connection(directory))).toMatchObject({ code: 'plugin-not-paired' })
    }
    // The real plugin, the same key: ready.
    const directory = temp('wf-bridge-')
    serve({ dataDirectory: directory, zotero: zotero().Z })
    expect(await pingZoteroPlugin(connection(directory))).toMatchObject({ kind: 'ready' })
  })

  test('WriteFlex signs exactly what the plugin checks', () => {
    const { headers, nonce } = signedHeaders(TEST_TOKEN, 'POST', '/writeflex/annotations', '{"a":1}', null, 1_000)
    const expected = signRequest(TEST_TOKEN, 'POST', '/writeflex/annotations', '{"a":1}', { nonce, now: 1_000, session: null })
    expect(headers['X-WriteFlex-Signature']).toBe(expected.headers['x-writeflex-signature'])
    // The session is under the signature too.
    const session = 'ab'.repeat(16)
    const withSession = signedHeaders(TEST_TOKEN, 'POST', '/writeflex/annotations', '{"a":1}', session, 1_000)
    const expectedWith = signRequest(TEST_TOKEN, 'POST', '/writeflex/annotations', '{"a":1}', { nonce: withSession.nonce, now: 1_000, session })
    expect(withSession.headers['X-WriteFlex-Signature']).toBe(expectedWith.headers['x-writeflex-signature'])
    expect(withSession.headers['X-WriteFlex-Session']).toBe(session)
    expect(headers['X-WriteFlex-Timestamp']).toBe('1000')
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(signedHeaders(TEST_TOKEN, 'GET', '/writeflex/ping', '').nonce).not.toBe(nonce)
  })

  test('the ping and every write carry the key and nothing a browser would send', async () => {
    const directory = temp('wf-bridge-')
    const server = serve({ dataDirectory: directory, zotero: zotero().Z })
    expect(await pingZoteroPlugin(connection(directory))).toMatchObject({ kind: 'ready' })
    const sidecar = store()
    queueCreate(sidecar)
    await drainOutboxToZoteroPlugin(sidecar, connection(directory))
    expect(server.requests.map((request) => `${request.method} ${request.path}`))
      .toEqual(['GET /writeflex/ping', 'GET /writeflex/ping', 'POST /writeflex/annotations'])
    for (const request of server.requests) {
      // Signed, and the key itself appears nowhere in what was sent.
      expect(request.headers['x-writeflex-signature']).toMatch(/^[0-9a-f]{64}$/)
      expect(request.headers['x-writeflex-nonce']).toMatch(/^[0-9a-f]{32}$/)
      expect(JSON.stringify(request)).not.toContain(TEST_TOKEN)
      expect(request.headers.origin).toBeUndefined()
      expect(request.headers['zotero-allowed-request']).toBeUndefined()
      expect(request.headers['x-zotero-connector-api-version']).toBeUndefined()
      expect(request.headers['user-agent'] ?? '').not.toStartWith('Mozilla/')
      expect(request.headers.host).toBe(`127.0.0.1:${server.port}`)
    }
  })
})

describe('draining through the plugin', () => {
  test('nothing waiting: no ping at all', async () => {
    const directory = temp('wf-bridge-')
    const server = serve({ dataDirectory: directory, zotero: zotero().Z })
    const report = await drainOutboxToZoteroPlugin(store(), connection(directory))
    expect(report).toMatchObject({ attempted: 0, skipped: null })
    expect(server.requests).toEqual([])
  })

  test('Zotero closed: nothing sent, every row waits with the reason, each refusal logged', async () => {
    const directory = temp('wf-bridge-')
    writeBridgeFile(directory, { port: closedPort(), token: TEST_TOKEN })
    const sidecar = store()
    queueCreate(sidecar, 'AAAAAAA2')
    queueCreate(sidecar, 'BBBBBBB2')
    const lines: ZoteroWriteAttempt[] = []
    const report = await drainOutboxToZoteroPlugin(sidecar, connection(directory), 25, (line) => lines.push(line))
    expect(report).toMatchObject({ attempted: 0, skipped: 'zotero-closed', skippedReason: ZOTERO_CLOSED_REASON })
    expect(sidecar.outboxDue().map((row) => [row.status, row.lastError])).toEqual([
      ['retrying', ZOTERO_CLOSED_REASON], ['retrying', ZOTERO_CLOSED_REASON],
    ])
    expect(lines.map((line) => line.outcome)).toEqual(['refused:zotero-closed', 'refused:zotero-closed'])
  })

  test('a create is confirmed under its own key; a key Zotero already holds is replaced by a fresh one WriteFlex picks and records', async () => {
    const directory = temp('wf-bridge-')
    const fake = zotero()
    fake.put({ comment: 'someone else', isExternal: 0, key: 'TAKENKY2', kind: 'annotation', libraryID: 1, parentKey: PDF, position: POSITION, sortIndex: '00001|000001|00001', type: 1 })
    const server = serve({ dataDirectory: directory, zotero: fake.Z })
    const sidecar = store()
    queueCreate(sidecar)
    queueCreate(sidecar, 'TAKENKY2')
    const report = await drainOutboxToZoteroPlugin(sidecar, connection(directory))
    expect(report).toMatchObject({ attempted: 2, confirmed: 2, skipped: null })
    const fresh = sidecar.outboxKeyReplacement(1, PDF, 'TAKENKY2')!
    expect(fresh).toMatch(/^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/)
    expect(fresh).not.toBe('TAKENKY2')
    expect(sidecar.outboxByStatus('confirmed').map((row) => row.itemKey)).toEqual([MARK, fresh])
    expect(fake.row(MARK)).toMatchObject({ comment: 'the crux', parentKey: PDF, text: 'a passage', type: 1 })
    expect(fake.row(fresh)).toMatchObject({ comment: 'the crux', parentKey: PDF })
    expect(fake.row('TAKENKY2')).toMatchObject({ comment: 'someone else' })
    // The second create under the fresh key is a first send, not a resend.
    const creates = server.requests.filter((request) => request.method === 'POST').map((request) => request.body as Record<string, unknown>)
    expect(creates.map((body) => [body.itemKey, body.resend ?? false])).toEqual([[MARK, false], ['TAKENKY2', false], [fresh, false]])
  })

  test('a key that stays in use after four tries is a conflict, and nothing is written', async () => {
    const directory = temp('wf-bridge-')
    let posts = 0
    serve({
      dataDirectory: directory,
      respond: (request) => {
        if (request.method !== 'POST') return undefined
        posts += 1
        return signedResponse(request.headers['x-writeflex-nonce']!, 200, JSON.stringify({ code: 'key-in-use', kind: 'conflict', reason: plugin.REASONS.keyInUse }))
      },
      zotero: zotero().Z,
    })
    const sidecar = store()
    queueCreate(sidecar)
    const report = await drainOutboxToZoteroPlugin(sidecar, connection(directory))
    expect(report).toMatchObject({ conflicted: 1 })
    expect(posts).toBe(4)
    expect(sidecar.outboxByStatus('conflict')[0]!.lastError).toBe(plugin.REASONS.keyInUse)
  })

  test('key-in-use is only taken from a create; on an edit it is not an outcome', async () => {
    expect(outcomeFromAnswer(JSON.stringify({ code: 'key-in-use', kind: 'conflict', reason: 'x' }), 'create', MARK)).toMatchObject({ code: 'key-in-use' })
    expect(outcomeFromAnswer(JSON.stringify({ code: 'key-in-use', kind: 'conflict', reason: 'x' }), 'update', MARK)).toBeNull()
    expect(outcomeFromAnswer(JSON.stringify({ code: 'other', kind: 'conflict', reason: 'x' }), 'create', MARK)).toBeNull()
  })

  test('SOL 4: after a re-key, the same reader\'s edit and deletion go to the new key and are written, though Zotero still holds the old one', async () => {
    const directory = temp('wf-bridge-')
    const fake = zotero()
    fake.put({ comment: 'not ours', isExternal: 0, key: MARK, kind: 'annotation', libraryID: 1, parentKey: 'THERPD22', position: POSITION, sortIndex: '00001|000001|00001', type: 1 })
    const server = serve({ dataDirectory: directory, zotero: fake.Z })
    const sidecar = store()
    queueCreate(sidecar)
    queueChange(sidecar, 'update', { color: '#5fb236' })
    const report = await drainOutboxToZoteroPlugin(sidecar, connection(directory))
    const fresh = sidecar.outboxKeyReplacement(1, PDF, MARK, READER_ONE)!
    const edit = server.requests.find((request) => (request.body as { operation?: string } | null)?.operation === 'update')!.body as Record<string, unknown>
    expect(edit).toMatchObject({ baseline: { ...shown, type: 'highlight' }, itemKey: fresh })
    expect(report).toMatchObject({ confirmed: 2, conflicted: 0 })
    expect(fake.row(fresh)).toMatchObject({ color: '#5fb236', comment: 'the crux' })
    expect(fake.row(MARK)).toMatchObject({ comment: 'not ours' })
    // A later deletion from the same reader removes ours, never the other one.
    queueChange(sidecar, 'delete', {}, { ...shownForDelete, color: '#5fb236' })
    expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory))).toMatchObject({ confirmed: 1 })
    expect(fake.row(fresh)).toBeUndefined()
    expect(fake.row(MARK)).toMatchObject({ comment: 'not ours' })
  })

  test('after a re-key, a fresh reader editing the annotation Zotero holds under the old key writes that one, not ours', async () => {
    const directory = temp('wf-bridge-')
    const fake = zotero()
    const theirs = { color: '#ff6666', comment: 'theirs', pageLabel: '1', position: POSITION, sortIndex: '00001|000001|00001', text: 'their words' }
    fake.put({ ...theirs, isExternal: 0, key: MARK, kind: 'annotation', libraryID: 1, parentKey: PDF, type: 1 })
    serve({ dataDirectory: directory, zotero: fake.Z })
    const sidecar = store()
    queueCreate(sidecar)
    expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory))).toMatchObject({ confirmed: 1 })
    const fresh = sidecar.outboxKeyReplacement(1, PDF, MARK, READER_ONE)!
    expect(fake.row(fresh)).toMatchObject({ comment: 'the crux' })
    // Another reader opened afterwards: it read both from Zotero and edits theirs, under the old key.
    queueChange(sidecar, 'update', { ...theirs, comment: 'theirs, edited here' }, { ...theirs, type: 'highlight' }, MARK, READER_TWO)
    expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory))).toMatchObject({ confirmed: 1, conflicted: 0 })
    expect(fake.row(MARK)).toMatchObject({ comment: 'theirs, edited here' })
    expect(fake.row(fresh)).toMatchObject({ comment: 'the crux' })
    // A change with no reader session never resolves through a re-key either.
    queueChange(sidecar, 'update', { ...theirs, comment: 'once more' }, { ...theirs, comment: 'theirs, edited here', type: 'highlight' }, MARK, null)
    expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory))).toMatchObject({ confirmed: 1 })
    expect(fake.row(MARK)).toMatchObject({ comment: 'once more' })
  })

  test('edits and deletions are written compare-and-set; a conflict and a refusal come back with their reasons', async () => {
    const directory = temp('wf-bridge-')
    const fake = zotero()
    const mark = { ...shown, isExternal: 0, key: MARK, kind: 'annotation' as const, libraryID: 1, parentKey: PDF, type: 1 }
    fake.put(mark)
    fake.put({ ...mark, comment: 'changed in Zotero', key: 'THERMK22' })
    serve({ dataDirectory: directory, zotero: fake.Z })
    const sidecar = store()
    queueChange(sidecar, 'update', { comment: 'second thought' })
    queueChange(sidecar, 'delete', {}, shownForDelete, 'THERMK22')
    queueChange(sidecar, 'delete', {}, shownForDelete, 'MISSKEY2')
    const report = await drainOutboxToZoteroPlugin(sidecar, connection(directory))
    expect(report).toMatchObject({ confirmed: 1, conflicted: 1, rejected: 1 })
    expect(fake.row(MARK)!.comment).toBe('second thought')
    expect(fake.row('THERMK22')).toBeDefined()
    expect(sidecar.outboxByStatus('conflict')[0]!.lastError).toBe(plugin.REASONS.changedSinceDelete)
    expect(sidecar.outboxByStatus('failed')[0]!.lastError).toBe(plugin.REASONS.gone)
  })

  test('with no baseline, or a comment past the limit, nothing is sent', async () => {
    const directory = temp('wf-bridge-')
    const server = serve({ dataDirectory: directory, zotero: zotero().Z })
    const sidecar = store()
    queueChange(sidecar, 'update', { color: '#5fb236' }, null)
    queueChange(sidecar, 'update', { comment: 'x'.repeat(3_000) })
    // A deletion that does not record the tags it was shown: an older plugin would erase it unchecked.
    queueChange(sidecar, 'delete', {}, shown, 'NOSTATE2')
    const report = await drainOutboxToZoteroPlugin(sidecar, connection(directory))
    expect(report).toMatchObject({ conflicted: 2, rejected: 1 })
    expect(sidecar.outboxByStatus('conflict')[1]!.lastError).toBe(UNVERIFIABLE_CHANGE_REASON)
    expect(sidecar.outboxByStatus('conflict')[0]!.lastError).toBe(UNVERIFIABLE_CHANGE_REASON)
    expect(sidecar.outboxByStatus('failed')[0]!.lastError).toBe(COMMENT_TOO_LONG_REASON)
    expect(server.requests.filter((request) => request.method === 'POST')).toEqual([])
  })

  test('the Area quotation goes to the key its create was confirmed under, as a comment record only', async () => {
    const directory = temp('wf-bridge-')
    const fake = zotero()
    fake.put({ comment: null, isExternal: 0, key: 'ZTRAREA7', kind: 'annotation', libraryID: 1, parentKey: PDF, position: POSITION, sortIndex: '00003|000100|00050', type: 3 })
    const server = serve({ dataDirectory: directory, zotero: fake.Z })
    const sidecar = store()
    const createPayload = { ...annotationPayload({ ...annotation, comment: null, type: 'image' }, PDF), readflexSourceKey: 'READERA7' }
    const create = sidecar.enqueueOutbox({ itemKey: 'READERA7', libraryId: 1, operation: 'create', parentItemKey: PDF, payload: JSON.stringify(createPayload) })
    sidecar.markOutboxConfirmed(create.id, 'ZTRAREA7')
    sidecar.enqueueOutbox({
      itemKey: 'READERA7', libraryId: 1, operation: 'update', parentItemKey: PDF,
      payload: JSON.stringify(areaQuotationPayload(createPayload, 'READERA7', 'Quoted in "Draft one" — 1 August 2026')),
    })
    const report = await drainOutboxToZoteroPlugin(sidecar, connection(directory))
    expect(report).toMatchObject({ attempted: 1, confirmed: 1 })
    const sent = server.requests.find((request) => request.method === 'POST')!.body as Record<string, unknown>
    expect(sent).toMatchObject({ areaQuotation: 'Quoted in "Draft one" — 1 August 2026', itemKey: 'ZTRAREA7', operation: 'update' })
    expect(sent.payload).toBeUndefined()
    expect(fake.row('ZTRAREA7')!.comment).toBe('Quoted in "Draft one" — 1 August 2026')
  })

  test('an unsigned 404 mid-drain is uncertain: the drain halts and the row is resent as interrupted', async () => {
    const directory = temp('wf-bridge-')
    let posts = 0
    const server = serve({
      dataDirectory: directory,
      respond: (request) => {
        if (request.method !== 'POST') return undefined
        posts += 1
        return posts === 1 ? undefined : new Response('No endpoint found\n', { status: 404 })
      },
      zotero: zotero().Z,
    })
    const sidecar = store()
    for (const key of ['AAAAAAA2', 'BBBBBBB2', 'CCCCCCC2']) queueCreate(sidecar, key)
    const report = await drainOutboxToZoteroPlugin(sidecar, connection(directory))
    expect(report).toMatchObject({ confirmed: 1, retrying: 1, skipped: 'zotero-busy', skippedReason: ZOTERO_BUSY_REASON })
    expect(sidecar.outboxDue().map((row) => [row.lastError, row.sendInterrupted])).toEqual([[ZOTERO_BUSY_REASON, 1], [ZOTERO_BUSY_REASON, 0]])
    expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(2)
  })

  test('SOL C: an unsigned 403, 404, 409 or 503 is uncertain, never a plugin verdict: the row is marked interrupted', async () => {
    for (const status of [403, 404, 409, 503]) {
      const directory = temp('wf-bridge-')
      serve({ dataDirectory: directory, respond: (request) => request.method === 'POST' ? new Response('{}', { status }) : undefined, zotero: zotero().Z })
      const sidecar = store()
      queueCreate(sidecar)
      expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory))).toMatchObject({ skipped: 'zotero-busy' })
      expect(sidecar.outboxDue()[0]).toMatchObject({ lastError: ZOTERO_BUSY_REASON, sendInterrupted: 1 })
    }
  })

  test('a signed 409 is an outdated plugin, and nothing was written', async () => {
    const directory = temp('wf-bridge-')
    serve({
      dataDirectory: directory,
      respond: (request) => request.method === 'POST' ? signedResponse(request.headers['x-writeflex-nonce']!, 409, JSON.stringify({ protocol: 4 })) : undefined,
      zotero: zotero().Z,
    })
    const sidecar = store()
    queueCreate(sidecar)
    expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory))).toMatchObject({ skipped: 'plugin-outdated' })
    expect(sidecar.outboxDue()[0]).toMatchObject({ sendInterrupted: 0 })
  })

  test('SOL E: Zotero restarted since the ping: the stale session is refused, signed, and the write is sent once more under the new one', async () => {
    const directory = temp('wf-bridge-')
    const fake = zotero()
    const server = serve({ dataDirectory: directory, zotero: fake.Z })
    const link = connection(directory)
    expect(await pingZoteroPlugin(link)).toMatchObject({ kind: 'ready' })
    // The drain pings first; restart between that ping and the write.
    let restarted = false
    const linkWithRestart: ZoteroPluginConnection = {
      ...link,
      fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (!restarted && init?.method === 'POST') {
          restarted = true
          server.restart('beef'.repeat(8))
        }
        return fetch(input, init)
      }) as typeof fetch,
    }
    const sidecar = store()
    queueCreate(sidecar)
    const report = await drainOutboxToZoteroPlugin(sidecar, linkWithRestart)
    expect(report).toMatchObject({ confirmed: 1 })
    const posts = server.requests.filter((request) => request.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1]!.headers['x-writeflex-session']).toBe('beef'.repeat(8))
    expect(currentPluginSession(linkWithRestart)).toBe('beef'.repeat(8))
    expect(fake.row(MARK)).toMatchObject({ comment: 'the crux' })
  })

  test('a stale-session refusal that is not signed is not believed: the row is interrupted, no resend', async () => {
    const directory = temp('wf-bridge-')
    serve({
      dataDirectory: directory,
      respond: (request) => request.method === 'POST' ? Response.json({ error: 'stale-session', sessionId: 'f'.repeat(32) }, { status: 401 }) : undefined,
      zotero: zotero().Z,
    })
    const link = connection(directory)
    const sidecar = store()
    queueCreate(sidecar)
    expect(await drainOutboxToZoteroPlugin(sidecar, link)).toMatchObject({ skipped: 'zotero-busy' })
    expect(currentPluginSession(link)).not.toBe('f'.repeat(32))
    expect(sidecar.outboxDue()[0]).toMatchObject({ sendInterrupted: 1 })
  })

  test('no answer in time: the row waits marked as interrupted, and the next send is a resend that does not duplicate', async () => {
    const directory = temp('wf-bridge-')
    const fake = zotero()
    let slow = true
    const server = serve({
      dataDirectory: directory,
      respond: async (request) => {
        if (request.method !== 'POST' || !slow) return undefined
        // Zotero takes the write, but the answer comes too late.
        const [status, headers, body] = await plugin.handleAnnotation(fake.Z, { data: request.text, headers: request.headers, method: 'POST' }, pluginContext())
        await new Promise((resolve) => setTimeout(resolve, 400))
        return new Response(body, { headers: headers as Record<string, string>, status })
      },
      zotero: fake.Z,
    })
    const sidecar = store()
    const id = queueCreate(sidecar)
    const quick = connection(directory, { writeTimeoutMs: 100 })
    const first = await drainOutboxToZoteroPlugin(sidecar, quick)
    expect(first).toMatchObject({ retrying: 1, skipped: 'zotero-busy', skippedReason: ZOTERO_BUSY_REASON })
    expect(sidecar.outboxEntry(id)).toMatchObject({ sendInterrupted: 1, status: 'retrying' })
    expect(fake.row(MARK)).toBeDefined()

    slow = false
    const second = await drainOutboxToZoteroPlugin(sidecar, quick)
    expect(second).toMatchObject({ confirmed: 1 })
    const posts = server.requests.filter((request) => request.method === 'POST').map((request) => request.body as { resend?: boolean })
    expect(posts.map((body) => body.resend ?? false)).toEqual([false, true])
    expect(sidecar.outboxEntry(id)).toMatchObject({ itemKey: MARK, sendInterrupted: 0, status: 'confirmed' })
    expect([...fake.rows.values()].filter((row) => row.kind === 'annotation')).toHaveLength(1)
  })

  test('a 500 from Zotero is treated as unknown: the row is resent next time', async () => {
    const directory = temp('wf-bridge-')
    serve({ dataDirectory: directory, respond: (request) => request.method === 'POST' ? new Response('', { status: 500 }) : undefined, zotero: zotero().Z })
    const sidecar = store()
    const id = queueCreate(sidecar)
    expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory))).toMatchObject({ skipped: 'zotero-busy' })
    expect(sidecar.outboxEntry(id)!.sendInterrupted).toBe(1)
  })

  test('a plugin retry (someone else is saving the mark) keeps the row waiting without halting the drain', async () => {
    const directory = temp('wf-bridge-')
    const fake = zotero()
    fake.put({ ...shown, isExternal: 0, key: MARK, kind: 'annotation', libraryID: 1, parentKey: PDF, type: 1 })
    ;(fake.cached(1, MARK) as unknown as { annotationComment: string }).annotationComment = 'typing in Zotero'
    serve({ dataDirectory: directory, zotero: fake.Z })
    const sidecar = store()
    const id = queueChange(sidecar, 'update', { comment: 'second thought' })
    queueCreate(sidecar, 'AAAAAAA2')
    const report = await drainOutboxToZoteroPlugin(sidecar, connection(directory))
    expect(report).toMatchObject({ confirmed: 1, retrying: 1, skipped: null })
    expect(sidecar.outboxEntry(id)).toMatchObject({ lastError: plugin.REASONS.saving, sendInterrupted: 0, status: 'retrying' })
  })

  test('SOL REPRO: an unsigned or wrongly signed "confirmed" is never taken as confirmed; the row is resent', async () => {
    const answer = JSON.stringify({ itemKey: MARK, kind: 'confirmed' })
    for (const forge of [
      () => new Response(answer, { headers: { 'Content-Type': 'application/json' } }),
      (nonce: string) => signedResponse(nonce, 200, answer, 'b'.repeat(64)),
      () => signedResponse('0'.repeat(32), 200, answer),
    ]) {
      const directory = temp('wf-bridge-')
      const fake = zotero()
      serve({
        dataDirectory: directory,
        respond: (request) => request.method === 'POST' ? forge(request.headers['x-writeflex-nonce']!) : undefined,
        zotero: fake.Z,
      })
      const sidecar = store()
      const id = queueCreate(sidecar)
      expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory))).toMatchObject({ confirmed: 0, skipped: 'zotero-busy' })
      expect(sidecar.outboxEntry(id)).toMatchObject({ sendInterrupted: 1, status: 'retrying' })
    }
  })

  test('a signed answer that is not a well-formed outcome is unknown: the row is resent', async () => {
    const malformed = [
      'not json',
      '[]',
      JSON.stringify({ kind: 'confirmed' }),
      JSON.stringify({ itemKey: 'lowercase', kind: 'confirmed' }),
      JSON.stringify({ itemKey: MARK, kind: 'confirmed', note: 7 }),
      JSON.stringify({ kind: 'conflict' }),
      JSON.stringify({ kind: 'rejected', reason: '  ' }),
      JSON.stringify({ kind: 'done', reason: 'x' }),
    ]
    for (const body of malformed) {
      const directory = temp('wf-bridge-')
      serve({
        dataDirectory: directory,
        respond: (request) => request.method === 'POST' ? signedResponse(request.headers['x-writeflex-nonce']!, 200, body) : undefined,
        zotero: zotero().Z,
      })
      const sidecar = store()
      const id = queueCreate(sidecar)
      expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory))).toMatchObject({ confirmed: 0, skipped: 'zotero-busy' })
      expect(sidecar.outboxEntry(id)).toMatchObject({ sendInterrupted: 1, status: 'retrying' })
    }
    // An edit confirmed under another key than the one sent is not a confirmation of that edit.
    const directory = temp('wf-bridge-')
    serve({
      dataDirectory: directory,
      respond: (request) => request.method === 'POST'
        ? signedResponse(request.headers['x-writeflex-nonce']!, 200, JSON.stringify({ itemKey: 'OTHERKY2', kind: 'confirmed' }))
        : undefined,
      zotero: zotero().Z,
    })
    const sidecar = store()
    const id = queueChange(sidecar, 'update', { comment: 'second thought' })
    expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory))).toMatchObject({ confirmed: 0, skipped: 'zotero-busy' })
    expect(sidecar.outboxEntry(id)!.sendInterrupted).toBe(1)
  })

  test('a confirmation with a note is confirmed, and the note is logged', async () => {
    const directory = temp('wf-bridge-')
    serve({
      dataDirectory: directory,
      respond: (request) => request.method === 'POST'
        ? signedResponse(request.headers['x-writeflex-nonce']!, 200, JSON.stringify({ itemKey: MARK, kind: 'confirmed', note: 'kept theirs' }))
        : undefined,
      zotero: zotero().Z,
    })
    const sidecar = store()
    queueChange(sidecar, 'update', { comment: 'second thought' })
    const lines: ZoteroWriteAttempt[] = []
    expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory), 25, (line) => lines.push(line))).toMatchObject({ confirmed: 1 })
    expect(lines.at(-1)).toMatchObject({ outcome: 'confirmed', reason: 'kept theirs' })
  })

  test('a signed 400 or 500 is unknown too; a plain-text body is what the plugin reads', async () => {
    for (const status of [400, 500]) {
      const directory = temp('wf-bridge-')
      serve({
        dataDirectory: directory,
        respond: (request) => request.method === 'POST' ? signedResponse(request.headers['x-writeflex-nonce']!, status, JSON.stringify({ itemKey: MARK, kind: 'confirmed' })) : undefined,
        zotero: zotero().Z,
      })
      const sidecar = store()
      const id = queueCreate(sidecar)
      expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory))).toMatchObject({ skipped: 'zotero-busy' })
      expect(sidecar.outboxEntry(id)!.sendInterrupted).toBe(1)
    }
    const directory = temp('wf-bridge-')
    const server = serve({ dataDirectory: directory, zotero: zotero().Z })
    queueCreate(store())
    const sidecar = store()
    queueCreate(sidecar)
    await drainOutboxToZoteroPlugin(sidecar, connection(directory))
    const post = server.requests.find((request) => request.method === 'POST')!
    expect(post.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(JSON.parse(post.text)).toMatchObject({ operation: 'create', protocol: plugin.PROTOCOL })
  })
})

describe('reading through the plugin', () => {
  test('the plugin read returns what Zotero holds for the attachment, signed', async () => {
    const directory = temp('wf-bridge-')
    const fake = zotero()
    fake.put({ ...shown, isExternal: 0, key: MARK, kind: 'annotation', libraryID: 1, parentKey: PDF, type: 1 })
    const server = serve({ dataDirectory: directory, zotero: fake.Z })
    const read = await readAnnotationsThroughPlugin(connection(directory), 1, PDF)
    expect(read.kind).toBe('read')
    if (read.kind !== 'read') return
    expect(read.annotations).toHaveLength(1)
    expect(read.annotations[0]).toMatchObject({ comment: 'the crux', key: MARK, parentItemKey: PDF, text: 'a passage', type: 'highlight' })
    const post = server.requests.find((request) => request.method === 'POST')!
    expect(post.path).toBe('/writeflex/annotations/read')
    expect(post.headers['x-writeflex-session']).toMatch(/^[0-9a-f]{32}$/)
  })

  test('Zotero closed, an unsigned answer, or one not in the expected shape is no read', async () => {
    const closed = temp('wf-bridge-')
    writeBridgeFile(closed, { port: closedPort(), token: TEST_TOKEN })
    expect(await readAnnotationsThroughPlugin(connection(closed), 1, PDF)).toEqual({ code: 'zotero-closed', kind: 'unavailable' })
    const good = JSON.stringify({ annotations: [], kind: 'annotations' })
    for (const respond of [
      () => new Response(good, { headers: { 'Content-Type': 'application/json' } }),
      (request: { headers: Record<string, string> }) => signedResponse(request.headers['x-writeflex-nonce']!, 200, JSON.stringify({ annotations: [{ key: 'bad' }], kind: 'annotations' })),
      (request: { headers: Record<string, string> }) => signedResponse(request.headers['x-writeflex-nonce']!, 200, JSON.stringify({ kind: 'confirmed' })),
      (request: { headers: Record<string, string> }) => signedResponse(request.headers['x-writeflex-nonce']!, 500, good),
    ]) {
      const directory = temp('wf-bridge-')
      serve({ dataDirectory: directory, respond: (request) => request.method === 'POST' ? respond(request) : undefined, zotero: zotero().Z })
      expect(await readAnnotationsThroughPlugin(connection(directory), 1, PDF)).toEqual({ code: 'not-read', kind: 'unavailable' })
    }
    // A signed empty list is a read: the attachment has no annotations.
    const empty = temp('wf-bridge-')
    serve({ dataDirectory: empty, zotero: zotero().Z })
    expect(await readAnnotationsThroughPlugin(connection(empty), 1, PDF)).toEqual({ annotations: [], kind: 'read' })
  })
})

describe('a reader reopened over an edit still waiting (reviewer\'s five steps)', () => {
  /** Open the document as main and the renderer do: Zotero's read plus what is owed, held by a new reader. */
  async function openReader(sidecar: SidecarStore, directory: string) {
    const read = await readAnnotationsThroughPlugin(connection(directory), 1, PDF)
    if (read.kind !== 'read') throw new Error('no read')
    const owed = [...sidecar.outboxConfirmedUnreadFor(1, PDF), ...sidecar.outboxUnconfirmedFor(1, PDF)].sort((left, right) => left.id - right.id)
    const painted = highlightsResult(mergeWithOutbox(read.annotations, owed)).forReader
    const held = createHeldMarks()
    held.load(painted)
    return { held, painted }
  }

  function queue(sidecar: SidecarStore, operation: 'update' | 'delete', mark: SavedAnnotation, before: unknown, session: string) {
    return queueAnnotationChange(sidecar, {
      itemKey: mark.key, libraryId: 1, operation, parentItemKey: PDF,
      payload: JSON.stringify({ ...annotationPayload(mark, PDF, undefined, { keepWholeComment: true }), readflexReaderSession: session }),
    }, validBaseline(before))
  }

  async function reopenedOverAWaitingEdit(tagInZoteroMeanwhile: boolean) {
    const directory = temp('wf-bridge-')
    const fake = zotero()
    fake.put({ ...shown, isExternal: 0, key: MARK, kind: 'annotation', libraryID: 1, parentKey: PDF, tags: ['models'], type: 1 })
    serve({ dataDirectory: directory, zotero: fake.Z })
    const sidecar = store()
    // 1. An edit in the first reader, queued and not yet sent.
    const first = await openReader(sidecar, directory)
    const edited = { ...first.painted[0]!, comment: 'second thought' } as unknown as SavedAnnotation
    queue(sidecar, 'update', edited, first.held.edit(edited), first.held.session)
    // 2. The reader is reopened before the edit is confirmed: the mark is painted from the outbox.
    const second = await openReader(sidecar, directory)
    expect(second.painted[0]).toMatchObject({ comment: 'second thought', zoteroState: { modified: null, tags: ['models'] } })
    // 3. The edit is confirmed.
    expect(await drainOutboxToZoteroPlugin(sidecar, connection(directory))).toMatchObject({ confirmed: 1 })
    expect(fake.row(MARK)).toMatchObject({ comment: 'second thought' })
    // 4. A tag is added in Zotero.
    if (tagInZoteroMeanwhile) fake.tagInZotero(MARK, ['models', 'added in Zotero'])
    // 5. The mark is deleted in the reopened reader.
    const mark = second.painted[0] as unknown as SavedAnnotation
    queue(sidecar, 'delete', mark, second.held.remove(mark), second.held.session)
    const report = await drainOutboxToZoteroPlugin(sidecar, connection(directory))
    return { fake, report, sidecar }
  }

  test('a tag added in Zotero after the edit stops the deletion; the mark and its tag stay', async () => {
    const { fake, report, sidecar } = await reopenedOverAWaitingEdit(true)
    expect(report).toMatchObject({ confirmed: 0, conflicted: 1 })
    expect(sidecar.outboxByStatus('conflict')[0]!.lastError).toBe(plugin.REASONS.changedSinceDelete)
    expect(fake.row(MARK)).toMatchObject({ comment: 'second thought', tags: ['models', 'added in Zotero'] })
    expect(fake.erased).toEqual([])
  })

  test('with no change in Zotero since, the deletion goes through', async () => {
    const { fake, report } = await reopenedOverAWaitingEdit(false)
    expect(report).toMatchObject({ confirmed: 1, conflicted: 0 })
    expect(fake.row(MARK)).toBeUndefined()
  })
})
