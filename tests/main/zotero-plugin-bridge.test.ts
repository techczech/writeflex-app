/**
 * The WriteFlex plugin for Zotero, its decision logic run against a fake Zotero.
 *
 * The fake keeps Zotero's two layers apart on purpose: `rows` is the database, `cache` is Zotero's
 * in-memory items. The plugin must decide from the database and refuse to save a cached item that
 * holds someone else's unsaved change. Every request here is signed as WriteFlex signs it, and every
 * answer the plugin gives to a signed request is checked for its signature.
 */
import { describe, expect, test } from 'bun:test'
import { answerIsSigned, memoryZotero, plugin, pluginContext, signRequest, TEST_SESSION, type MemoryRow as Row } from '../helpers/fake-zotero-plugin'

type Outcome = { kind: string; reason?: string; itemKey?: string; note?: string }

const TOKEN = 'a'.repeat(64)
const USER = 1
const GROUP = 2
const PDF = 'PDFKEY22'
const OTHER_PDF = 'PDFKEY33'
const EPUB = 'EPUBKEY2'
const MARK = 'MARKKEY2'

/** A Zotero with two PDFs and an EPUB in the personal library, and a PDF in a group library. */
function fakeZotero(options: Parameters<typeof memoryZotero>[0] = {}) {
  const zotero = memoryZotero(options)
  zotero.put({ key: PDF, kind: 'pdf', libraryID: USER })
  zotero.put({ key: OTHER_PDF, kind: 'pdf', libraryID: USER })
  zotero.put({ key: EPUB, kind: 'epub', libraryID: USER })
  zotero.put({ key: PDF, kind: 'pdf', libraryID: GROUP })
  return zotero
}

const POSITION = JSON.stringify({ pageIndex: 2, rects: [[1, 2, 3, 4]] })
const FIELDS = {
  color: '#ffd400',
  comment: 'first thought',
  pageLabel: '3',
  position: POSITION,
  sortIndex: '00002|000100|00050',
  text: 'a passage',
}

function markRow(overrides: Partial<Row> = {}): Omit<Row, 'itemID'> {
  return { ...FIELDS, isExternal: 0, key: MARK, kind: 'annotation', libraryID: USER, parentKey: PDF, type: 1, ...overrides }
}

const ANNOTATIONS = '/writeflex/annotations'

function request(data: Record<string, unknown>, headers: Record<string, string> = {}, token = TOKEN) {
  const body = JSON.stringify({ libraryId: USER, parentItemKey: PDF, protocol: plugin.PROTOCOL, ...data })
  const signed = signRequest(token, 'POST', ANNOTATIONS, body)
  return { nonce: signed.nonce, request: { data: body, headers: { ...signed.headers, ...headers }, method: 'POST' } }
}

async function send(Z: unknown, data: Record<string, unknown>, headers: Record<string, string> = {}) {
  const { nonce, request: sent } = request(data, headers)
  const answer = await plugin.handleAnnotation(Z, sent, pluginContext())
  const [status, , body] = answer
  // Every answer to a request that passed the checks is signed; refusals are not.
  expect(answerIsSigned(TOKEN, nonce, answer)).toBe(status !== 403)
  return { body: JSON.parse(body) as Outcome & { error?: string; protocol?: number }, status }
}

const create = (extra: Record<string, unknown> = {}) => ({
  itemKey: MARK,
  operation: 'create',
  payload: { ...FIELDS, type: 'highlight' },
  ...extra,
})
const edit = (payload: Partial<typeof FIELDS> & { type?: string }, extra: Record<string, unknown> = {}) => ({
  baseline: { ...FIELDS, type: payload.type ?? 'highlight' },
  itemKey: MARK,
  operation: 'update',
  payload: { ...FIELDS, type: 'highlight', ...payload },
  ...extra,
})
// A deletion as WriteFlex sends it: with the tags the reader was shown (none) and no known stamp.
const remove = (extra: Record<string, unknown> = {}) => ({ baseline: { ...FIELDS, type: 'highlight', zoteroState: { modified: null, tags: [] } }, itemKey: MARK, operation: 'delete', ...extra })

describe('who may call', () => {
  const ping = (headers: Record<string, string>, context = pluginContext()) => plugin.handlePing({ headers, method: 'GET' }, context)

  test('ping answers only a request signed with the key, and signs its answer', async () => {
    expect((await ping({}))[0]).toBe(403)
    expect((await ping(signRequest('b'.repeat(64), 'GET', '/writeflex/ping', '').headers))[0]).toBe(403)
    // Signed for another path or method: refused.
    expect((await ping(signRequest(TOKEN, 'GET', ANNOTATIONS, '').headers))[0]).toBe(403)
    expect((await ping(signRequest(TOKEN, 'POST', '/writeflex/ping', '').headers))[0]).toBe(403)
    const { headers, nonce } = signRequest(TOKEN, 'GET', '/writeflex/ping', '')
    const answer = await ping(headers)
    expect(answer[0]).toBe(200)
    expect(answerIsSigned(TOKEN, nonce, answer)).toBe(true)
    expect(answerIsSigned(TOKEN, 'f'.repeat(32), answer)).toBe(false)
    expect(JSON.parse(answer[2])).toEqual({ pluginVersion: '1.0.0', protocol: plugin.PROTOCOL, sessionId: TEST_SESSION, zoteroVersion: '11.0-beta.1' })
  })

  test('the key never travels: no request or answer carries it', async () => {
    const { headers } = signRequest(TOKEN, 'GET', '/writeflex/ping', '')
    const answer = await ping(headers)
    expect(JSON.stringify([headers, answer])).not.toContain(TOKEN)
    const { request: sent } = request(create())
    expect(JSON.stringify(sent)).not.toContain(TOKEN)
  })

  test('a request is accepted once, and only inside the time window', async () => {
    const context = pluginContext()
    const signed = signRequest(TOKEN, 'GET', '/writeflex/ping', '')
    expect((await ping(signed.headers, context))[0]).toBe(200)
    // Replayed: refused, and the refusal is not signed.
    const replay = await ping(signed.headers, context)
    expect(replay[0]).toBe(403)
    expect(typeof replay[1]).toBe('string')
    const now = Date.now()
    const stale = signRequest(TOKEN, 'GET', '/writeflex/ping', '', { now: now - plugin.SIGNATURE_WINDOW_MS - 1000 })
    expect((await ping(stale.headers, context))[0]).toBe(403)
    const early = signRequest(TOKEN, 'GET', '/writeflex/ping', '', { now: now + plugin.SIGNATURE_WINDOW_MS + 1000 })
    expect((await ping(early.headers, context))[0]).toBe(403)
    // A nonce is forgotten only after the window has passed, when its timestamp would fail anyway.
    const laterNow = now + 3 * plugin.SIGNATURE_WINDOW_MS
    const later = pluginContext(TOKEN, { now: () => laterNow, nonces: context.nonces })
    expect((await ping(signed.headers, later))[0]).toBe(403)
    expect((await ping(signRequest(TOKEN, 'GET', '/writeflex/ping', '', { now: laterNow }).headers, later))[0]).toBe(200)
    expect(context.nonces.has(signed.nonce)).toBe(false)
  })

  test('the body is covered: a changed body with the old signature writes nothing', async () => {
    const zotero = fakeZotero()
    const { request: sent } = request(create())
    const tampered = { ...sent, data: sent.data.replace('first thought', 'other thought') }
    expect((await plugin.handleAnnotation(zotero.Z, tampered, pluginContext()))[0]).toBe(403)
    // Not a string (Zotero parsed it as JSON): refused before anything is read.
    expect((await plugin.handleAnnotation(zotero.Z, { ...sent, data: JSON.parse(sent.data) }, pluginContext()))[0]).toBe(403)
    expect(zotero.row(MARK)).toBeUndefined()
  })

  test('anything a web page could send is refused, signed or not', async () => {
    const browserHeaders: Array<Record<string, string>> = [
      { origin: 'https://example.com' },
      { origin: 'null' },
      { 'zotero-allowed-request': '1' },
      { 'x-zotero-connector-api-version': '3' },
      { 'user-agent': 'Mozilla/5.0 (Macintosh)' },
    ]
    for (const extra of browserHeaders) {
      expect((await ping({ ...signRequest(TOKEN, 'GET', '/writeflex/ping', '').headers, ...extra }))[0]).toBe(403)
    }
  })

  test('a plugin without a valid key of its own accepts nothing', async () => {
    expect((await ping(signRequest(TOKEN, 'GET', '/writeflex/ping', '').headers, pluginContext('')))[0]).toBe(403)
  })

  test('annotations need a signature too, and nothing is written without it', async () => {
    const zotero = fakeZotero()
    const body = JSON.stringify({ libraryId: USER, parentItemKey: PDF, protocol: plugin.PROTOCOL, ...create() })
    const missing = await plugin.handleAnnotation(zotero.Z, { data: body, headers: {}, method: 'POST' }, pluginContext())
    expect(missing[0]).toBe(403)
    const browser = await send(zotero.Z, create(), { origin: 'https://www.zotero.org' })
    expect(browser.status).toBe(403)
    expect(zotero.row(MARK)).toBeUndefined()
  })

  test('the key comparison is exact', () => {
    expect(plugin.constantTimeEqual(TOKEN, TOKEN)).toBe(true)
    expect(plugin.constantTimeEqual(TOKEN, `${TOKEN}0`)).toBe(false)
    expect(plugin.constantTimeEqual(TOKEN, undefined)).toBe(false)
    const token = plugin.newToken((bytes) => bytes.fill(171))
    expect(token).toBe('ab'.repeat(32))
    expect(plugin.isValidToken(token)).toBe(true)
    expect(plugin.isValidToken('AB'.repeat(32))).toBe(false)
  })

  test('another protocol is answered 409 with the protocol this plugin speaks', async () => {
    const result = await send(fakeZotero().Z, { ...create(), protocol: 1 })
    expect(result.status).toBe(409)
    expect(result.body).toMatchObject({ kind: 'rejected', protocol: plugin.PROTOCOL })
  })

  test('a malformed change is refused before anything is read', async () => {
    const zotero = fakeZotero()
    for (const data of [
      { ...create(), operation: 'move' },
      { ...create(), libraryId: 0 },
      { ...create(), parentItemKey: 'nope' },
      { ...create(), payload: { ...FIELDS, type: 'squiggle' } },
      { ...create(), payload: { ...FIELDS, position: '{"rects":[]}', type: 'highlight' } },
      { ...create(), payload: { ...FIELDS, color: 'red', type: 'highlight' } },
      { ...create(), payload: { ...FIELDS, sortIndex: '7', type: 'highlight' } },
      { ...edit({ comment: 'x' }), baseline: undefined },
      { ...remove(), itemKey: 'lowercase' },
      { ...create(), resend: 'yes' },
      // A baseline must say what kind of mark it was.
      { ...edit({ comment: 'x' }), baseline: FIELDS },
      { ...remove(), baseline: FIELDS },
    ]) {
      const result = await send(zotero.Z, data)
      expect(result.status).toBe(200)
      expect(result.body.kind).toBe('rejected')
    }
    expect(zotero.saves).toEqual([])
  })
})

describe('create', () => {
  test('a free key is used as given, without tags or an author name', async () => {
    const zotero = fakeZotero()
    const result = await send(zotero.Z, create({ payload: { ...FIELDS, tags: ['x'], type: 'highlight' } }))
    expect(result.body).toEqual({ itemKey: MARK, kind: 'confirmed' })
    expect(zotero.row(MARK)).toMatchObject({ ...FIELDS, parentKey: PDF, type: 1 })
    expect(zotero.saves[0]!.fields).toEqual(['color', 'comment', 'pageLabel', 'position', 'sortIndex', 'text', 'type'])
  })

  const KEY_IN_USE = { code: 'key-in-use', kind: 'conflict', reason: plugin.REASONS.keyInUse }

  test('a key Zotero already uses, for anything, is never swapped for a fresh one here: key-in-use', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ comment: 'someone else', parentKey: OTHER_PDF }))
    expect((await send(zotero.Z, create())).body).toEqual(KEY_IN_USE)
    // An item that is not an annotation, and the same key on this very document (not a resend).
    const other = fakeZotero()
    expect((await send(other.Z, create({ itemKey: OTHER_PDF }))).body).toEqual(KEY_IN_USE)
    other.put(markRow())
    expect((await send(other.Z, create())).body).toEqual(KEY_IN_USE)
    expect(zotero.row(MARK)).toMatchObject({ comment: 'someone else', parentKey: OTHER_PDF })
    expect([...zotero.saves, ...other.saves]).toEqual([])
  })

  test('a key that is not a Zotero key is key-in-use too: WriteFlex chooses a proper one', async () => {
    const zotero = fakeZotero()
    expect((await send(zotero.Z, create({ itemKey: 'not-a-key' }))).body).toEqual(KEY_IN_USE)
    expect((await send(zotero.Z, create({ itemKey: '' }))).body).toEqual(KEY_IN_USE)
    expect(zotero.saves).toEqual([])
  })

  test('a resend that finds exactly this mark at its key adopts it and writes nothing', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ position: JSON.stringify({ rects: [[1, 2, 3, 4]], pageIndex: 2 }) }))
    const result = await send(zotero.Z, create({ resend: true }))
    expect(result.body).toEqual({ itemKey: MARK, kind: 'confirmed' })
    expect(zotero.saves).toEqual([])
  })

  test('SOL REPRO (USERKEY2): a resend never adopts an identical mark under another key', async () => {
    // The person made the same highlight in Zotero themselves. Content equality does not make it ours:
    // the resend creates WriteFlex's own mark at its own key, and the person's stays theirs.
    const zotero = fakeZotero()
    zotero.put(markRow({ key: 'USERKEY2' }))
    const result = await send(zotero.Z, create({ resend: true }))
    expect(result.body).toEqual({ itemKey: MARK, kind: 'confirmed' })
    expect(zotero.row('USERKEY2')).toMatchObject({ ...FIELDS, parentKey: PDF })
    expect(zotero.row(MARK)).toMatchObject({ ...FIELDS, parentKey: PDF })
    // And a later deletion of WriteFlex's mark reaches only its own key.
    expect((await send(zotero.Z, remove())).body).toEqual({ itemKey: MARK, kind: 'confirmed' })
    expect(zotero.row('USERKEY2')).toBeDefined()
  })

  test('a resend whose key holds a changed version of the mark on this document is a conflict; elsewhere it is key-in-use', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ comment: 'changed in Zotero since' }))
    expect((await send(zotero.Z, create({ resend: true }))).body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedSinceSend })
    const elsewhere = fakeZotero()
    elsewhere.put(markRow({ parentKey: OTHER_PDF }))
    expect((await send(elsewhere.Z, create({ resend: true }))).body).toEqual(KEY_IN_USE)
    const stored = fakeZotero()
    stored.put(markRow({ isExternal: 1 }))
    expect((await send(stored.Z, create({ resend: true }))).body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedSinceSend })
    expect([...zotero.saves, ...elsewhere.saves, ...stored.saves]).toEqual([])
  })

  test('a resend whose key is free creates the mark there', async () => {
    const zotero = fakeZotero()
    expect((await send(zotero.Z, create({ resend: true }))).body).toEqual({ itemKey: MARK, kind: 'confirmed' })
    expect(zotero.row(MARK)).toMatchObject({ ...FIELDS, parentKey: PDF, type: 1 })
  })

  test('only the personal library, only a PDF that exists', async () => {
    const zotero = fakeZotero()
    expect((await send(zotero.Z, create({ libraryId: GROUP }))).body).toEqual({ kind: 'rejected', reason: plugin.REASONS.group })
    expect((await send(zotero.Z, create({ libraryId: 9 }))).body).toEqual({ kind: 'rejected', reason: plugin.REASONS.library })
    expect((await send(zotero.Z, create({ parentItemKey: 'MISSKEY2' }))).body).toEqual({ kind: 'rejected', reason: plugin.REASONS.parentMissing })
    expect((await send(zotero.Z, create({ parentItemKey: EPUB }))).body).toEqual({ kind: 'rejected', reason: plugin.REASONS.parentNotPdf })
    expect(zotero.saves).toEqual([])
  })

  test('a save that throws rolls back and is reported, never half-written', async () => {
    const zotero = fakeZotero()
    const result = await send(zotero.Z, create({ payload: { ...FIELDS, type: 'image' } }))
    expect(result.body.kind).toBe('confirmed')
    // The fake throws for a non-string position on the setter; the plugin never sends one, so force it:
    const broken = fakeZotero()
    const original = broken.Z.Item.prototype.save
    broken.Z.Item.prototype.save = async function () { throw new Error('disk full') }
    const failed = await send(broken.Z, create())
    expect(failed.body).toEqual({ kind: 'rejected', reason: 'Zotero could not save this change: disk full' })
    expect(broken.row(MARK)).toBeUndefined()
    broken.Z.Item.prototype.save = original
  })

  test('a Zotero still busy after its wait is a retry', async () => {
    expect((await send(fakeZotero({ timeout: true }).Z, create())).body).toEqual({ kind: 'retry', reason: plugin.REASONS.busy })
  })
})

describe('update', () => {
  test('equal to the baseline: only the changed field is written', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const result = await send(zotero.Z, edit({ comment: 'second thought' }))
    expect(result.body).toEqual({ itemKey: MARK, kind: 'confirmed' })
    expect(zotero.saves).toEqual([{ fields: ['comment'], key: MARK }])
    expect(zotero.row(MARK)).toMatchObject({ ...FIELDS, comment: 'second thought' })
  })

  test('position is compared as JSON, not as text', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ position: '{ "rects": [[1,2,3,4]], "pageIndex": 2 }' }))
    expect((await send(zotero.Z, edit({ color: '#FF6666' }))).body.kind).toBe('confirmed')
    expect(zotero.saves).toEqual([{ fields: ['color'], key: MARK }])
    expect(zotero.row(MARK)!.color).toBe('#ff6666')
  })

  test('changed in Zotero since: a conflict, and nothing is written', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ comment: 'written in Zotero' }))
    const result = await send(zotero.Z, edit({ color: '#ff6666' }))
    expect(result.body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedSinceEdit })
    expect(zotero.saves).toEqual([])
  })

  test('a key on another document is refused and never re-parented', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ parentKey: OTHER_PDF }))
    const result = await send(zotero.Z, edit({ comment: 'x' }))
    expect(result.body).toEqual({ kind: 'rejected', reason: plugin.REASONS.otherDocument })
    expect(zotero.row(MARK)!.parentKey).toBe(OTHER_PDF)
    expect(zotero.saves).toEqual([])
  })

  test('a key that is not an annotation, is gone, is external or is another type is refused', async () => {
    const zotero = fakeZotero()
    expect((await send(zotero.Z, edit({ comment: 'x' }))).body.reason).toBe(plugin.REASONS.gone)
    expect((await send(zotero.Z, edit({ comment: 'x' }, { itemKey: OTHER_PDF }))).body.reason).toBe(plugin.REASONS.notAnnotation)
    zotero.put(markRow({ isExternal: 1 }))
    expect((await send(zotero.Z, edit({ comment: 'x' }))).body.reason).toBe(plugin.REASONS.external)
    // The reader showed a note, and Zotero holds a note: WriteFlex may not turn it into a highlight.
    const typed = fakeZotero()
    typed.put(markRow({ type: 2 }))
    expect((await send(typed.Z, edit({ comment: 'x' }, { baseline: { ...FIELDS, type: 'note' } }))).body.reason).toBe(plugin.REASONS.otherType)
    expect([...zotero.saves, ...typed.saves]).toEqual([])
  })

  test('the type is part of the compare: a highlight turned into an underline in Zotero is a conflict', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ type: 5 }))
    expect((await send(zotero.Z, edit({ comment: 'x' }))).body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedSinceEdit })
    expect((await send(zotero.Z, remove())).body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedSinceDelete })
    expect(zotero.saves).toEqual([])
    expect(zotero.erased).toEqual([])
    // A resend whose type differs is not taken as already written either.
    expect((await send(zotero.Z, edit({}, { resend: true }))).body.kind).toBe('conflict')
  })

  test('marked regions and drawings: comment yes, moving or recolouring a drawing no', async () => {
    const image = fakeZotero()
    image.put(markRow({ text: null, type: 3 }))
    expect((await send(image.Z, edit({ comment: 'about the figure', type: 'image' }))).body.kind).toBe('confirmed')
    expect(image.saves).toEqual([{ fields: ['comment'], key: MARK }])
    const moved = fakeZotero()
    moved.put(markRow({ text: null, type: 3 }))
    const move = await send(moved.Z, edit({ position: JSON.stringify({ pageIndex: 2, rects: [[5, 6, 7, 8]] }), type: 'image' }))
    expect(move.body).toEqual({ kind: 'rejected', reason: plugin.REASONS.imagePosition })
    const ink = fakeZotero()
    ink.put(markRow({ text: null, type: 4 }))
    expect((await send(ink.Z, edit({ color: '#ff6666', type: 'ink' }))).body).toEqual({ kind: 'rejected', reason: plugin.REASONS.inkColour })
    expect([...moved.saves, ...ink.saves]).toEqual([])
  })

  test('an item someone else is saving is a retry, and their change is not saved by us', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as { annotationComment: string }
    item.annotationComment = 'typed in the Zotero reader'
    const result = await send(zotero.Z, edit({ comment: 'second thought' }))
    expect(result.body).toEqual({ kind: 'retry', reason: plugin.REASONS.saving })
    expect(zotero.saves).toEqual([])
    expect(zotero.row(MARK)!.comment).toBe('first thought')
  })

  /**
   * Sol's probe, against item.js's save sequence: the reader sets a field on the same cached item
   * while our save awaits its database write. Zotero would then clear that change record and reload
   * our row, and the reader's own save (queued behind our transaction) would find nothing to write.
   */
  async function readerSaves(zotero: ReturnType<typeof fakeZotero>) {
    const item = zotero.cached(USER, MARK) as unknown as { hasChanged(): boolean; save(): Promise<boolean> }
    // The reader's `saveTx()`: it runs after our transaction, and writes only if something changed.
    if (item.hasChanged()) await zotero.Z.DB.executeTransaction(() => item.save())
  }

  test('SOL REPRO: a reader edit to another field during our save is kept, and ours is confirmed with a note', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as { annotationColor: unknown; duringWrite?: () => void }
    item.duringWrite = () => {
      item.duringWrite = undefined
      item.annotationColor = '#2ea8e5'
    }
    const result = await send(zotero.Z, edit({ comment: 'second thought' }))
    expect(result.body.kind).toBe('confirmed')
    expect(result.body.itemKey).toBe(MARK)
    expect(result.body.note).toBeString()
    await readerSaves(zotero)
    expect(zotero.row(MARK)).toMatchObject({ color: '#2ea8e5', comment: 'second thought' })
  })

  test('SOL REPRO: a reader edit to the same field during our save wins, and ours is a conflict', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as { annotationComment: unknown; duringWrite?: () => void }
    item.duringWrite = () => {
      item.duringWrite = undefined
      item.annotationComment = 'typed in the Zotero reader'
    }
    const result = await send(zotero.Z, edit({ comment: 'second thought' }))
    expect(result.body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedWhileSaving })
    await readerSaves(zotero)
    expect(zotero.row(MARK)!.comment).toBe('typed in the Zotero reader')
  })

  test('the probe fails without the guard: Zotero itself would lose the reader edit', async () => {
    // The same sequence with the fake alone, no plugin: proves the fake reproduces the loss.
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as {
      annotationColor: unknown; annotationComment: unknown; duringWrite?: () => void; save(): Promise<boolean>
    }
    item.duringWrite = () => {
      item.duringWrite = undefined
      item.annotationColor = '#2ea8e5'
    }
    item.annotationComment = 'second thought'
    await zotero.Z.DB.executeTransaction(() => item.save())
    await readerSaves(zotero)
    expect(zotero.row(MARK)!.color).toBe('#ffd400')
    expect(item.annotationColor).toBe('#ffd400')
  })

  test('a reader edit during the save of a new mark is kept too', async () => {
    const zotero = fakeZotero()
    const Base = zotero.Z.Item
    // The plugin's new item: the reader edits the mark it just saw appear, while it is being saved.
    zotero.Z.Item = class extends Base {
      constructor(itemType: string) {
        super(itemType)
        this.duringWrite = () => {
          this.duringWrite = undefined
          this.annotationComment = 'typed at once'
        }
      }
    }
    const result = await send(zotero.Z, create())
    expect(result.body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedWhileSaving })
    await readerSaves(zotero)
    expect(zotero.row(MARK)!.comment).toBe('typed at once')
  })

  test('a resend that finds the change already in Zotero is confirmed without writing', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ comment: 'second thought' }))
    expect((await send(zotero.Z, edit({ comment: 'second thought' }, { resend: true }))).body.kind).toBe('confirmed')
    expect(zotero.saves).toEqual([])
    // Without the resend flag the same state is a conflict: Zotero no longer holds the baseline.
    expect((await send(zotero.Z, edit({ comment: 'second thought' }))).body.kind).toBe('conflict')
  })

  test('an edit that changes nothing is confirmed without writing', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    expect((await send(zotero.Z, edit({ comment: ' first thought ' }))).body.kind).toBe('confirmed')
    expect(zotero.saves).toEqual([])
  })

  test('SOL 4: an edit sent to the re-keyed mark is written though another annotation holds the reader key; the plugin does not second-guess WriteFlex\'s resolution', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ key: 'NEWKEY22' }))
    zotero.put(markRow({ comment: 'not ours', parentKey: OTHER_PDF }))
    const result = await send(zotero.Z, edit({ comment: 'x' }, { itemKey: 'NEWKEY22', supersededKey: MARK }))
    expect(result.body).toEqual({ itemKey: 'NEWKEY22', kind: 'confirmed' })
    expect(zotero.row('NEWKEY22')).toMatchObject({ comment: 'x' })
    expect(zotero.row(MARK)).toMatchObject({ comment: 'not ours' })
  })
})

describe('delete', () => {
  test('equal to the baseline: erased', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    expect((await send(zotero.Z, remove())).body).toEqual({ itemKey: MARK, kind: 'confirmed' })
    expect(zotero.erased).toEqual([MARK])
    expect(zotero.row(MARK)).toBeUndefined()
  })

  test('changed in Zotero since: a conflict, and it stays', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ comment: 'written in Zotero' }))
    expect((await send(zotero.Z, remove())).body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedSinceDelete })
    expect(zotero.erased).toEqual([])
  })

  test('a marked region or a drawing is not deleted from here', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ text: null, type: 3 }))
    expect((await send(zotero.Z, remove())).body).toEqual({ kind: 'rejected', reason: plugin.REASONS.imageDelete })
    expect(zotero.erased).toEqual([])
  })

  test('another document, a pending change, a missing key', async () => {
    const zotero = fakeZotero()
    expect((await send(zotero.Z, remove())).body.reason).toBe(plugin.REASONS.gone)
    expect((await send(zotero.Z, remove({ resend: true }))).body).toEqual({ itemKey: MARK, kind: 'confirmed' })
    zotero.put(markRow({ parentKey: OTHER_PDF }))
    expect((await send(zotero.Z, remove())).body.reason).toBe(plugin.REASONS.otherDocument)
    const busy = fakeZotero()
    busy.put(markRow())
    ;(busy.cached(USER, MARK) as unknown as { annotationColor: string }).annotationColor = '#000000'
    expect((await send(busy.Z, remove())).body.kind).toBe('retry')
    expect([...zotero.erased, ...busy.erased]).toEqual([])
  })
})

describe('a deletion and changes the field compare cannot see (Sol round 4)', () => {
  const shownState = (zotero: ReturnType<typeof fakeZotero>) => ({ modified: zotero.row(MARK)!.modified!, tags: [...(zotero.row(MARK)!.tags ?? [])] })
  const removeAsShown = (state: { modified: string | null; tags: string[] }) => remove({ baseline: { ...FIELDS, type: 'highlight', zoteroState: state } })

  test('SOL P1: a tag added in Zotero after the reader showed the mark stops the deletion', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const shown = shownState(zotero)
    zotero.tagInZotero(MARK, ['keep me'])
    expect((await send(zotero.Z, removeAsShown(shown))).body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedSinceDelete })
    expect(zotero.row(MARK)).toBeDefined()
    expect(zotero.erased).toEqual([])
  })

  test('a tag changed before the reader was shown the mark: the deletion goes ahead', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ tags: ['old'] }))
    zotero.tagInZotero(MARK, ['old', 'new'])
    expect((await send(zotero.Z, removeAsShown(shownState(zotero)))).body).toEqual({ itemKey: MARK, kind: 'confirmed' })
    expect(zotero.row(MARK)).toBeUndefined()
  })

  test('clock edge: a tag change saved within the same second leaves Zotero\'s stamp as it was, and the tag compare still stops the deletion', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const shown = shownState(zotero)
    zotero.tagInZotero(MARK, ['same second'], { sameSecond: true })
    expect(zotero.row(MARK)!.modified).toBe(shown.modified)
    expect((await send(zotero.Z, removeAsShown(shown))).body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedSinceDelete })
  })

  test('any other saved change moves the stamp: the deletion is refused though fields and tags match', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const shown = shownState(zotero)
    zotero.row(MARK)!.modified = '2026-06-01 12:00:00'
    expect((await send(zotero.Z, removeAsShown(shown))).body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedSinceDelete })
    // A stamp the reader did not know (a mark it made or edited itself) leaves only the tag compare.
    expect((await send(zotero.Z, removeAsShown({ modified: null, tags: [] }))).body).toEqual({ itemKey: MARK, kind: 'confirmed' })
  })

  test('a deletion that does not say what Zotero held beyond the fields is refused, and the mark and its tag stay', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    zotero.tagInZotero(MARK, ['added in Zotero'])
    expect((await send(zotero.Z, remove({ baseline: { ...FIELDS, type: 'highlight' } }))).body).toEqual({ kind: 'conflict', reason: plugin.REASONS.unverifiedDelete })
    expect(zotero.row(MARK)!.tags).toEqual(['added in Zotero'])
    expect(zotero.erased).toEqual([])
  })

  test('a malformed Zotero state is rejected', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    expect((await send(zotero.Z, removeAsShown({ modified: null, tags: [3] as unknown as string[] }))).body.kind).toBe('rejected')
  })
})

describe('Area quotation', () => {
  const quotation = 'Quoted in "Draft" — 22 October 2026'
  const area = (extra: Record<string, unknown> = {}) => ({ areaQuotation: quotation, itemKey: MARK, operation: 'update', ...extra })

  test('appended once to the region comment, and a second send changes nothing', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ comment: 'the figure', text: null, type: 3 }))
    expect((await send(zotero.Z, area())).body.kind).toBe('confirmed')
    expect(zotero.row(MARK)!.comment).toBe(`the figure\n\n${quotation}`)
    expect((await send(zotero.Z, area())).body.kind).toBe('confirmed')
    expect(zotero.saves).toHaveLength(1)
  })

  test('only on an image annotation, in the accepted form, with room left', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    expect((await send(zotero.Z, area())).body.reason).toBe(plugin.REASONS.areaMissing)
    expect((await send(zotero.Z, area({ areaQuotation: 'anything else' }))).body.reason).toBe(plugin.REASONS.areaForm)
    const full = fakeZotero()
    full.put(markRow({ comment: 'x'.repeat(2040), text: null, type: 3 }))
    expect((await send(full.Z, area())).body.reason).toBe(plugin.REASONS.areaNoRoom)
    expect([...zotero.saves, ...full.saves]).toEqual([])
  })
})

type Cached = {
  annotationColor: unknown
  annotationComment: unknown
  duringWrite?: () => void | Promise<void>
  afterClear?: () => void | Promise<void>
  duringErase?: () => void | Promise<void>
  failWrite?: Error
  hasChanged(): boolean
  save(): Promise<boolean>
  _changed: Record<string, boolean>
}

/** The reader's queued `saveTx()`: after our transaction, and only if the item says it changed. */
async function readerSaves(zotero: ReturnType<typeof fakeZotero>) {
  const item = zotero.cached(USER, MARK) as unknown as Cached
  if (item.hasChanged()) await zotero.Z.DB.executeTransaction(() => item.save())
}

describe('not while someone works on the PDF in Zotero', () => {
  test('a PDF open in a Zotero reader tab: every write waits, nothing is written', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const pdfId = zotero.row(PDF)!.itemID
    zotero.Z.Reader._readers.push({ itemID: pdfId })
    for (const data of [create({ itemKey: 'NEWMARK2' }), edit({ comment: 'x' }), remove()]) {
      expect((await send(zotero.Z, data)).body).toEqual({ kind: 'retry', reason: plugin.REASONS.openInZotero })
    }
    expect(zotero.saves).toEqual([])
    expect(zotero.erased).toEqual([])
    // Another PDF open does not hold this one back.
    zotero.Z.Reader._readers.splice(0, 1, { itemID: zotero.row(OTHER_PDF)!.itemID })
    expect((await send(zotero.Z, edit({ comment: 'x' }))).body.kind).toBe('confirmed')
  })

  test('while Zotero syncs, every write waits', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    zotero.Z.Sync.Runner.syncInProgress = true
    expect((await send(zotero.Z, edit({ comment: 'x' }))).body).toEqual({ kind: 'retry', reason: plugin.REASONS.syncing })
    expect(zotero.saves).toEqual([])
    zotero.Z.Sync.Runner.syncInProgress = false
    expect((await send(zotero.Z, edit({ comment: 'x' }))).body.kind).toBe('confirmed')
  })
})

describe('edits made in Zotero while the plugin saves or erases (Sol round 2)', () => {
  test('control: Zotero alone loses an edit made after the change records are cleared and before the reload', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as Cached
    item.afterClear = () => {
      item.afterClear = undefined
      item.annotationColor = '#2ea8e5'
    }
    item.annotationComment = 'second thought'
    await zotero.Z.DB.executeTransaction(() => item.save())
    // The value is still pending in memory, but its flag was cleared by the reload: the reader's save
    // finds the item changed yet writes no annotation row.
    expect(item.hasChanged()).toBe(true)
    await readerSaves(zotero)
    expect(zotero.row(MARK)!.color).toBe('#ffd400')
  })

  test('SOL REPRO 2: that edit is marked again, flag and all, and the reader save writes it', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as Cached
    item.afterClear = () => {
      item.afterClear = undefined
      item.annotationColor = '#2ea8e5'
    }
    const result = await send(zotero.Z, edit({ comment: 'second thought' }))
    expect(result.body.kind).toBe('confirmed')
    expect(result.body.note).toBeString()
    expect(item._changed.annotation).toBe(true)
    await readerSaves(zotero)
    expect(zotero.row(MARK)).toMatchObject({ color: '#2ea8e5', comment: 'second thought' })
  })

  test('SOL REPRO 2, same field: the reader value wins and ours is a conflict', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as Cached
    item.afterClear = () => {
      item.afterClear = undefined
      item.annotationComment = 'typed in the Zotero reader'
    }
    expect((await send(zotero.Z, edit({ comment: 'second thought' }))).body)
      .toEqual({ kind: 'conflict', reason: plugin.REASONS.changedWhileSaving })
    await readerSaves(zotero)
    expect(zotero.row(MARK)!.comment).toBe('typed in the Zotero reader')
  })

  test('control: Zotero alone loses an edit made during a save that then fails', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as Cached
    item.duringWrite = () => {
      item.duringWrite = undefined
      item.annotationColor = '#2ea8e5'
    }
    item.failWrite = new Error('disk full')
    item.annotationComment = 'second thought'
    await expect(zotero.Z.DB.executeTransaction(() => item.save())).rejects.toThrow('disk full')
    expect(item.hasChanged()).toBe(false)
  })

  test('SOL REPRO 3: an edit made during a save that fails is marked again before the error goes on', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as Cached
    item.duringWrite = () => {
      item.duringWrite = undefined
      item.annotationColor = '#2ea8e5'
    }
    item.failWrite = new Error('disk full')
    expect((await send(zotero.Z, edit({ comment: 'second thought' }))).body)
      .toEqual({ kind: 'rejected', reason: 'Zotero could not save this change: disk full' })
    item.failWrite = undefined
    expect(item._changed.annotation).toBe(true)
    await readerSaves(zotero)
    // The reader's colour is saved; WriteFlex's comment is not (its row stays refused here).
    expect(zotero.row(MARK)).toMatchObject({ color: '#2ea8e5', comment: 'first thought' })
  })

  test('SOL REPRO 4: an edit made while the plugin erases stops the erase; the mark and the edit stay', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as Cached
    item.duringErase = () => {
      item.duringErase = undefined
      item.annotationComment = 'typed while it was being deleted'
    }
    expect((await send(zotero.Z, remove())).body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedWhileDeleting })
    // Rolled back: the row is there, the cached item was never unloaded, and the edit is still owed.
    expect(zotero.row(MARK)).toBeDefined()
    expect(zotero.erased).toEqual([])
    expect(zotero.cached(USER, MARK)).toBe(item as never)
    await readerSaves(zotero)
    expect(zotero.row(MARK)!.comment).toBe('typed while it was being deleted')
  })

  test('an erase with no edit during it commits and unloads the item', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as Cached
    item.duringErase = () => { item.duringErase = undefined }
    expect((await send(zotero.Z, remove())).body).toEqual({ itemKey: MARK, kind: 'confirmed' })
    expect(zotero.erased).toEqual([MARK])
    expect(zotero.cached(USER, MARK)).toBe(false)
  })
})

describe('Zotero\'s caches after a rollback, and the last checks before the commit (Sol round 3)', () => {
  const childKeys = (zotero: ReturnType<typeof fakeZotero>) =>
    (zotero.cached(USER, PDF) as unknown as { childAnnotationKeys: string[] }).childAnnotationKeys

  test('control: Zotero alone leaves the attachment\'s annotation list without an annotation whose erase was rolled back', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    expect(childKeys(zotero)).toEqual([MARK])
    const item = zotero.cached(USER, MARK) as unknown as { erase(): Promise<void> }
    await expect(zotero.Z.DB.executeTransaction(async () => {
      await item.erase()
      throw new Error('rolled back')
    })).rejects.toThrow('rolled back')
    expect(zotero.row(MARK)).toBeDefined()
    expect(childKeys(zotero)).toEqual([])
  })

  test('SOL 3: after an erase is rolled back, the attachment\'s annotation list holds the mark again', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as Cached
    item.duringErase = () => {
      item.duringErase = undefined
      item.annotationComment = 'typed while it was being deleted'
    }
    expect((await send(zotero.Z, remove())).body).toEqual({ kind: 'conflict', reason: plugin.REASONS.changedWhileDeleting })
    expect(childKeys(zotero)).toEqual([MARK])
    expect(item._changed.annotation).toBe(true)
  })

  test('the PDF opened in Zotero during an edit\'s save: rolled back, the item reloaded from its row, nothing left marked', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as Cached
    item.duringWrite = () => {
      item.duringWrite = undefined
      zotero.Z.Reader._readers.push({ itemID: zotero.row(PDF)!.itemID })
    }
    expect((await send(zotero.Z, edit({ comment: 'second thought' }))).body).toEqual({ kind: 'retry', reason: plugin.REASONS.openInZotero })
    expect(zotero.row(MARK)!.comment).toBe('first thought')
    expect(item.annotationComment).toBe('first thought')
    expect(item.hasChanged()).toBe(false)
  })

  test('the PDF opened in Zotero during an edit\'s save, and edited there: the row is rolled back and the reader\'s edit is still owed', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as Cached
    item.afterClear = () => {
      item.afterClear = undefined
      zotero.Z.Reader._readers.push({ itemID: zotero.row(PDF)!.itemID })
      item.annotationColor = '#2ea8e5'
    }
    expect((await send(zotero.Z, edit({ comment: 'second thought' }))).body).toEqual({ kind: 'retry', reason: plugin.REASONS.openInZotero })
    expect(zotero.row(MARK)).toMatchObject({ color: '#ffd400', comment: 'first thought' })
    expect(item.annotationComment).toBe('first thought')
    await readerSaves(zotero)
    expect(zotero.row(MARK)).toMatchObject({ color: '#2ea8e5', comment: 'first thought' })
  })

  test('a sync started during an erase: rolled back, the mark and its place in the list stay', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow())
    const item = zotero.cached(USER, MARK) as unknown as Cached
    item.duringErase = () => {
      item.duringErase = undefined
      zotero.Z.Sync.Runner.syncInProgress = true
    }
    expect((await send(zotero.Z, remove())).body).toEqual({ kind: 'retry', reason: plugin.REASONS.syncing })
    expect(zotero.row(MARK)).toBeDefined()
    expect(zotero.erased).toEqual([])
    expect(childKeys(zotero)).toEqual([MARK])
  })

  test('the PDF opened in Zotero during a create: rolled back, the new item unloaded and gone from the list', async () => {
    const zotero = fakeZotero()
    const pdfId = zotero.row(PDF)!.itemID
    expect(childKeys(zotero)).toEqual([])
    // Every new item opens the PDF in Zotero while its row is being written.
    const Base = zotero.Z.Item
    ;(zotero.Z as { Item: unknown }).Item = class extends Base {
      constructor(itemType: string) {
        super(itemType)
        this.duringWrite = () => { zotero.Z.Reader._readers.push({ itemID: pdfId }) }
      }
    }
    expect((await send(zotero.Z, create({ itemKey: 'NEWMARK2' }))).body).toEqual({ kind: 'retry', reason: plugin.REASONS.openInZotero })
    expect(zotero.row('NEWMARK2')).toBeUndefined()
    expect(zotero.cached(USER, 'NEWMARK2')).toBe(false)
    expect(childKeys(zotero)).toEqual([])
  })

  test('an edit made after the save, while Zotero commits, is still marked afterwards for the reader\'s save', async () => {
    let item: Cached | null = null
    const zotero = fakeZotero({
      beforeCommit: () => {
        if (item && !item.hasChanged()) item.annotationColor = '#2ea8e5'
      },
    })
    zotero.put(markRow())
    item = zotero.cached(USER, MARK) as unknown as Cached
    expect((await send(zotero.Z, edit({ comment: 'second thought' }))).body.kind).toBe('confirmed')
    expect(item._changed.annotation).toBe(true)
    const watched = zotero.cached(USER, MARK) as unknown as object
    expect(Object.prototype.hasOwnProperty.call(watched, '_markFieldChange')).toBe(false)
    await readerSaves(zotero)
    expect(zotero.row(MARK)).toMatchObject({ color: '#2ea8e5', comment: 'second thought' })
  })

  test('accepted residual: an edit made while Zotero commits an erase cannot stop it', async () => {
    let item: Cached | null = null
    const zotero = fakeZotero({
      beforeCommit: () => {
        if (item) item.annotationComment = 'typed during the commit'
      },
    })
    zotero.put(markRow())
    item = zotero.cached(USER, MARK) as unknown as Cached
    expect((await send(zotero.Z, remove())).body).toEqual({ itemKey: MARK, kind: 'confirmed' })
    expect(zotero.row(MARK)).toBeUndefined()
  })
})

describe('sessions: a request dies with the plugin run it was signed for', () => {
  test('a request carrying another session is refused with a signed answer naming the current one, and nothing is written', async () => {
    const zotero = fakeZotero()
    const body = JSON.stringify({ libraryId: USER, parentItemKey: PDF, protocol: plugin.PROTOCOL, ...create() })
    for (const session of ['0'.repeat(32), null]) {
      const signed = signRequest(TOKEN, 'POST', ANNOTATIONS, body, { session })
      const answer = await plugin.handleAnnotation(zotero.Z, { data: body, headers: signed.headers, method: 'POST' }, pluginContext())
      expect(answer[0]).toBe(401)
      expect(answerIsSigned(TOKEN, signed.nonce, answer)).toBe(true)
      expect(JSON.parse(answer[2])).toEqual({ error: 'stale-session', sessionId: TEST_SESSION })
    }
    expect(zotero.row(MARK)).toBeUndefined()
  })

  test('a captured request replayed after a restart is refused even though the nonce memory is new', async () => {
    const zotero = fakeZotero()
    const body = JSON.stringify({ libraryId: USER, parentItemKey: PDF, protocol: plugin.PROTOCOL, ...create() })
    const signed = signRequest(TOKEN, 'POST', ANNOTATIONS, body)
    const restarted = pluginContext(TOKEN, { sessionId: 'f'.repeat(32) })
    const answer = await plugin.handleAnnotation(zotero.Z, { data: body, headers: signed.headers, method: 'POST' }, restarted)
    expect(answer[0]).toBe(401)
    expect(zotero.row(MARK)).toBeUndefined()
  })

  test('a session id under the signature cannot be swapped', async () => {
    const zotero = fakeZotero()
    const body = JSON.stringify({ libraryId: USER, parentItemKey: PDF, protocol: plugin.PROTOCOL, ...create() })
    const signed = signRequest(TOKEN, 'POST', ANNOTATIONS, body, { session: '0'.repeat(32) })
    const swapped = { ...signed.headers, 'x-writeflex-session': TEST_SESSION }
    expect((await plugin.handleAnnotation(zotero.Z, { data: body, headers: swapped, method: 'POST' }, pluginContext()))[0]).toBe(403)
  })

  test('each run makes its own session id', () => {
    const first = plugin.newSessionId((bytes) => crypto.getRandomValues(bytes))
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(plugin.newSessionId((bytes) => crypto.getRandomValues(bytes))).not.toBe(first)
  })
})

describe('reading what Zotero holds', () => {
  const READ = '/writeflex/annotations/read'
  async function read(Z: unknown, data: Record<string, unknown>, options: { session?: string | null } = {}) {
    const body = JSON.stringify(data)
    const signed = signRequest(TOKEN, 'POST', READ, body, options)
    const answer = await plugin.handleRead(Z, { data: body, headers: signed.headers, method: 'POST' }, pluginContext())
    return { answer, body: JSON.parse(answer[2]) as Record<string, unknown>, signed: answerIsSigned(TOKEN, signed.nonce, answer) }
  }

  test('one document\'s annotations, signed, in the shape the Reading Room reads', async () => {
    const zotero = fakeZotero()
    zotero.put(markRow({ tags: ['models'] }))
    zotero.put(markRow({ key: 'ELSEKEY2', parentKey: OTHER_PDF }))
    const result = await read(zotero.Z, { libraryId: USER, parentItemKey: PDF, protocol: plugin.PROTOCOL })
    expect(result.signed).toBe(true)
    expect(result.body).toEqual({
      annotations: [{
        ...FIELDS, authorName: null, isExternal: false, key: MARK, modified: '2026-01-01 00:00:00', parentItemKey: PDF,
        tags: ['models'], type: 'highlight',
      }],
      kind: 'annotations',
    })
  })

  test('unsigned, stale, malformed or another protocol: no annotations', async () => {
    const zotero = fakeZotero()
    const body = JSON.stringify({ libraryId: USER, parentItemKey: PDF, protocol: plugin.PROTOCOL })
    expect((await plugin.handleRead(zotero.Z, { data: body, headers: {}, method: 'POST' }, pluginContext()))[0]).toBe(403)
    expect((await read(zotero.Z, { libraryId: USER, parentItemKey: PDF, protocol: plugin.PROTOCOL }, { session: null })).answer[0]).toBe(401)
    expect((await read(zotero.Z, { libraryId: USER, parentItemKey: 'nope', protocol: plugin.PROTOCOL })).body.kind).toBe('rejected')
    expect((await read(zotero.Z, { libraryId: 9, parentItemKey: PDF, protocol: plugin.PROTOCOL })).body.kind).toBe('rejected')
    expect((await read(zotero.Z, { libraryId: USER, parentItemKey: PDF, protocol: 2 })).answer[0]).toBe(409)
  })
})
