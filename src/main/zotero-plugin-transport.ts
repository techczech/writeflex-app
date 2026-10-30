/**
 * Sending waiting highlights to the WriteFlex plugin in Zotero (ADR-0047).
 *
 * ```
 * drain ──▶ read <Zotero data directory>/writeflex/bridge.json ──▶ GET 127.0.0.1:<port>/writeflex/ping
 *              (token + port, written by the plugin)               ready (+ session id) ──▶ POST /writeflex/annotations
 *                                                                             one outbox row per request
 * read  ──▶ ping ──▶ POST /writeflex/annotations/read: the open document's annotations as Zotero holds them
 * ```
 *
 * The plugin saves each change through Zotero's own item code, inside one Zotero transaction, compare-
 * and-set against the baseline the reader held (see `zotero-plugin/src/writeflex-bridge.js`). This side
 * keeps everything the outbox already decided: claimed rows, revisions, reader-held baselines and the
 * key replacements. The key WriteFlex proposes for a create is the mark's identity: when Zotero already
 * uses it, the plugin refuses (`key-in-use`) and this side picks a fresh key, records it and sends again.
 *
 * Requests go from the main process with Node's `fetch`: no `Origin` header and no browser user agent,
 * which Zotero's server and the plugin both refuse. Nothing here opens `zotero.sqlite`.
 *
 * **The key never travels.** Each request carries a timestamp, a fresh nonce, the plugin's session id
 * and HMAC-SHA256(key, method | path | timestamp | nonce | session | sha256(body)); the plugin checks
 * it, refuses a nonce it has seen and a session from an earlier run, and signs its answer with
 * HMAC(key, status | nonce | sha256(answer)). An answer without a valid signature proves nothing,
 * whatever its status: a ping is then "not paired" (or "plugin missing" on a 404: a ping writes
 * nothing), a write is "unknown" (the row is resent next time) and never confirmed, and a read is not
 * authoritative. So whatever else may listen on Zotero's port learns nothing it can use and cannot fake
 * a confirmation; a request captured on the way dies with the plugin run it was signed for.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OutboxEntry } from '@readflex/sidecar'
import type { ZoteroAnnotation } from '@readflex/zotero-bridge'
import {
  COMMENT_TOO_LONG_REASON,
  drainOutbox,
  MAX_ANNOTATION_COMMENT_BYTES,
  readerSessionOf,
  resolveTarget,
  UNVERIFIABLE_CHANGE_REASON,
  validBaseline,
  type DrainReport,
  type DrainSkipReason,
  type OutboxStore,
  type ZoteroAnnotationPayload,
  type ZoteroState,
  type ZoteroWriteAttemptLog,
  type ZoteroWriteOutcome,
  type ZoteroWriteTransport,
} from './zotero-annotation-writes'

export const ZOTERO_PLUGIN_PROTOCOL = 3
export const PING_PATH = '/writeflex/ping'
export const ANNOTATIONS_PATH = '/writeflex/annotations'
export const READ_PATH = '/writeflex/annotations/read'
/** Zotero's default `extensions.zotero.httpServer.port`. */
export const DEFAULT_ZOTERO_PORT = 23119
export const PING_TIMEOUT_MS = 2_000
/** Zotero waits up to 30 s for another transaction before giving up; a longer answer is a resend. */
export const WRITE_TIMEOUT_MS = 10_000

export const ZOTERO_CLOSED_REASON =
  'Zotero is not open. Your highlights are saved here and are sent when Zotero is open.'
export const ZOTERO_BUSY_REASON =
  'Zotero did not answer in time. Your highlights are saved here and are sent shortly.'
export const PLUGIN_MISSING_REASON =
  'To send highlights to Zotero, install the WriteFlex plugin in Zotero: Tools, Plugins, then install from file.'
export const PLUGIN_NOT_PAIRED_REASON =
  'The WriteFlex plugin in Zotero did not recognise this copy of WriteFlex. Quit and reopen Zotero, then press Try again.'

const REASON_FOR: Record<Exclude<DrainSkipReason, 'no-credential'>, string> = {
  'plugin-missing': PLUGIN_MISSING_REASON,
  'plugin-not-paired': PLUGIN_NOT_PAIRED_REASON,
  'plugin-outdated': PLUGIN_MISSING_REASON,
  'zotero-busy': ZOTERO_BUSY_REASON,
  'zotero-closed': ZOTERO_CLOSED_REASON,
}

const KEY_PATTERN = /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/
/** Zotero's object-key alphabet (`Zotero.DataObjectUtilities`). */
const KEY_CHARACTERS = ['23456789', 'ABCDEFGH', 'IJKLMNPQ', 'RSTUVWXY', 'Z'].join('')
const READ_KEY_PATTERN = /^[0-9A-Za-z]{1,32}$/
const TOKEN_PATTERN = /^[0-9a-f]{64}$/
const SESSION_PATTERN = /^[0-9a-f]{32}$/
/** How many fresh keys one create may try when Zotero already uses the one proposed. */
const MAX_KEY_ATTEMPTS = 4

/** A fresh Zotero-shaped key: 8 characters from Zotero's alphabet, from a cryptographic source. */
export function newZoteroKey(): string {
  const bytes = randomBytes(16)
  let key = ''
  // Rejection sampling keeps every character equally likely (33 does not divide 256).
  for (const byte of bytes) {
    if (byte >= 33 * 7) continue
    key += KEY_CHARACTERS[byte % 33]
    if (key.length === 8) return key
  }
  return newZoteroKey()
}

/** What the plugin writes when Zotero starts it. */
export type ZoteroBridgeFile = {
  token: string
  port: number
  pluginVersion: string
  protocol: number
}

export type ZoteroPluginConnection = {
  /** Zotero's data directory, read per drain (the e2e fixture when one is set). Null when unknown. */
  dataDirectory: () => string | null
  fetch?: typeof fetch
  /**
   * The port tried when there is no bridge file: Zotero's default when absent. Null means do not look
   * at all and treat Zotero as closed; a test library (the e2e override) sets it, so a run never
   * reaches a real Zotero on this machine.
   */
  defaultPort?: number | null
  pingTimeoutMs?: number
  writeTimeoutMs?: number
  /** The clock the signatures carry; tests set it. */
  now?: () => number
}

export type PluginReachability =
  | { kind: 'ready'; bridge: ZoteroBridgeFile; sessionId: string }
  | { kind: 'unavailable'; code: Exclude<DrainSkipReason, 'no-credential'>; reason: string }

export function bridgeFilePath(dataDirectory: string): string {
  return join(dataDirectory, 'writeflex', 'bridge.json')
}

/** The bridge file, checked field by field; null when absent or not in the plugin's shape. */
export async function readBridgeFile(dataDirectory: string | null): Promise<ZoteroBridgeFile | null> {
  if (!dataDirectory) return null
  let value: unknown
  try {
    value = JSON.parse(await readFile(bridgeFilePath(dataDirectory), 'utf8'))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const file = value as Record<string, unknown>
  if (typeof file.token !== 'string' || !TOKEN_PATTERN.test(file.token)) return null
  const port = Number.isInteger(file.port) && (file.port as number) > 0 && (file.port as number) < 65536
    ? file.port as number
    : DEFAULT_ZOTERO_PORT
  return {
    pluginVersion: typeof file.pluginVersion === 'string' ? file.pluginVersion : '',
    port,
    // A file without a protocol was written by no plugin that speaks this one.
    protocol: typeof file.protocol === 'number' ? file.protocol : 0,
    token: file.token,
  }
}

function unavailable(code: Exclude<DrainSkipReason, 'no-credential'>): PluginReachability {
  return { code, kind: 'unavailable', reason: REASON_FOR[code] }
}

/** True when the request never reached anything: nothing listens on the port. Node's fetch says
 *  `ECONNREFUSED` on the cause; Bun's (the unit tests) says `ConnectionRefused` on the error. */
function refused(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause
  const code = cause?.code ?? (error as { code?: unknown } | null)?.code
  return code === 'ECONNREFUSED' || code === 'ConnectionRefused'
}

function url(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function hmacHex(token: string, message: string): string {
  return createHmac('sha256', Buffer.from(token, 'hex')).update(message, 'utf8').digest('hex')
}

/** What a request's signature covers; the plugin builds the same string. `session` is '' when absent. */
export function requestMessage(method: string, path: string, timestamp: string, nonce: string, session: string, bodyHash: string): string {
  return ['WriteFlex-Request-3', method, path, timestamp, nonce, session, bodyHash].join('\n')
}

/** What an answer's signature covers. */
export function responseMessage(status: number, nonce: string, bodyHash: string): string {
  return ['WriteFlex-Response-3', String(status), nonce, bodyHash].join('\n')
}

/** The signing headers for one request; the session id goes along (and under the signature) when known. */
export function signedHeaders(token: string, method: string, path: string, body: string, session: string | null = null, now = Date.now()): {
  headers: Record<string, string>
  nonce: string
} {
  const timestamp = String(now)
  const nonce = randomBytes(16).toString('hex')
  const signature = hmacHex(token, requestMessage(method, path, timestamp, nonce, session ?? '', sha256Hex(body)))
  return {
    headers: {
      'X-WriteFlex-Nonce': nonce,
      'X-WriteFlex-Signature': signature,
      'X-WriteFlex-Timestamp': timestamp,
      ...(session ? { 'X-WriteFlex-Session': session } : {}),
    },
    nonce,
  }
}

/**
 * The plugin run each connection last heard from (its session id, from a signed ping or a signed
 * stale-session answer). Every request but the ping carries it; Zotero's restart makes it stale.
 */
const sessions = new WeakMap<ZoteroPluginConnection, string>()

/** The session id WriteFlex currently holds for this connection, if any (for tests). */
export function currentPluginSession(connection: ZoteroPluginConnection): string | null {
  return sessions.get(connection) ?? null
}

type Exchange =
  | { kind: 'refused' }
  | { kind: 'failed' }
  | { kind: 'answer'; status: number; signed: boolean; text: string }

/**
 * One request, signed when there is a key, and its answer with the signature checked against the
 * exact bytes received. `refused`: nothing listens. `failed`: anything else that left no answer (a
 * timeout, a dropped connection) — the request may have reached Zotero.
 */
async function exchange(
  connection: ZoteroPluginConnection,
  port: number,
  method: 'GET' | 'POST',
  path: string,
  body: string,
  token: string | null,
  timeoutMs: number,
  session: string | null = null,
): Promise<Exchange> {
  const send = connection.fetch ?? fetch
  const signing = token ? signedHeaders(token, method, path, body, session, connection.now?.()) : null
  let response: Response
  let bytes: Buffer
  try {
    response = await send(url(port, path), {
      ...(method === 'POST' ? { body } : {}),
      headers: {
        ...(method === 'POST' ? { 'Content-Type': 'text/plain; charset=utf-8' } : {}),
        ...(signing?.headers ?? {}),
      },
      method,
      signal: AbortSignal.timeout(timeoutMs),
    })
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    return refused(error) ? { kind: 'refused' } : { kind: 'failed' }
  }
  let signed = false
  const signature = response.headers.get('x-writeflex-signature') ?? ''
  if (token && signing && /^[0-9a-f]{64}$/.test(signature)) {
    const expected = Buffer.from(hmacHex(token, responseMessage(response.status, signing.nonce, sha256Hex(bytes))), 'hex')
    signed = timingSafeEqual(expected, Buffer.from(signature, 'hex'))
  }
  return { kind: 'answer', signed, status: response.status, text: bytes.toString('utf8') }
}

/**
 * Is the plugin there, and does it hold our key? Cheap enough to run every few seconds: one local GET.
 * Ready only on a signed answer: the plugin proves itself with the key without the key being sent.
 *
 * With no bridge file the ping goes to Zotero's default port unsigned, which still tells the cases
 * apart: nothing listening (closed), no such endpoint (plugin missing), anything else (not paired).
 */
export async function pingZoteroPlugin(connection: ZoteroPluginConnection): Promise<PluginReachability> {
  const bridge = await readBridgeFile(connection.dataDirectory())
  const port = bridge?.port ?? (connection.defaultPort === undefined ? DEFAULT_ZOTERO_PORT : connection.defaultPort)
  if (port === null) return unavailable('zotero-closed')
  const answer = await exchange(connection, port, 'GET', PING_PATH, '', bridge?.token ?? null, connection.pingTimeoutMs ?? PING_TIMEOUT_MS)
  if (answer.kind === 'refused') return unavailable('zotero-closed')
  if (answer.kind === 'failed') return unavailable('zotero-busy')
  if (answer.status === 404) return unavailable('plugin-missing')
  if (!bridge) return unavailable('plugin-not-paired')
  // An older plugin wrote a bridge file for another protocol: it cannot check these signatures.
  if (bridge.protocol !== ZOTERO_PLUGIN_PROTOCOL || answer.status === 409) return unavailable('plugin-outdated')
  if (answer.status !== 200 || !answer.signed) return unavailable('plugin-not-paired')
  let body: unknown
  try {
    body = JSON.parse(answer.text)
  } catch {
    return unavailable('plugin-not-paired')
  }
  const pong = body as { protocol?: unknown; sessionId?: unknown } | null
  if (pong?.protocol !== ZOTERO_PLUGIN_PROTOCOL) return unavailable('plugin-outdated')
  if (typeof pong.sessionId !== 'string' || !SESSION_PATTERN.test(pong.sessionId)) return unavailable('plugin-outdated')
  sessions.set(connection, pong.sessionId)
  return { bridge, kind: 'ready', sessionId: pong.sessionId }
}

/**
 * The session id in a signed stale-session answer (the plugin restarted since the last ping), or null
 * when the answer is anything else.
 */
function staleSessionOf(answer: Exchange): string | null {
  if (answer.kind !== 'answer' || !answer.signed || answer.status !== 401) return null
  try {
    const body = JSON.parse(answer.text) as { error?: unknown; sessionId?: unknown }
    return body.error === 'stale-session' && typeof body.sessionId === 'string' && SESSION_PATTERN.test(body.sessionId)
      ? body.sessionId
      : null
  } catch {
    return null
  }
}

/**
 * A signed request carrying the current session; if the plugin answers (signed) that the session is
 * stale, the new one is taken and the request sent once more with a fresh nonce. That answer is
 * signed and comes before anything is read or written, so resending is safe.
 */
async function sessionExchange(
  connection: ZoteroPluginConnection,
  bridge: ZoteroBridgeFile,
  path: string,
  body: string,
  timeoutMs: number,
): Promise<Exchange> {
  let answer = await exchange(connection, bridge.port, 'POST', path, body, bridge.token, timeoutMs, sessions.get(connection) ?? null)
  const fresh = staleSessionOf(answer)
  if (fresh) {
    sessions.set(connection, fresh)
    answer = await exchange(connection, bridge.port, 'POST', path, body, bridge.token, timeoutMs, fresh)
  }
  return answer
}

/** The annotation fields as the plugin takes them, from the stored payload. */
export function pluginFields(payload: ZoteroAnnotationPayload): {
  type: string
  text: string | null
  comment: string | null
  color: string | null
  pageLabel: string | null
  sortIndex: string
  position: string
} | null {
  if (typeof payload.annotationType !== 'string' || typeof payload.annotationSortIndex !== 'string' || !payload.annotationSortIndex) {
    return null
  }
  return {
    color: payload.annotationColor || null,
    comment: payload.annotationComment || null,
    pageLabel: payload.annotationPageLabel || null,
    position: JSON.stringify(payload.annotationPosition ?? { pageIndex: 0, rects: [] }),
    sortIndex: payload.annotationSortIndex,
    text: payload.annotationText || null,
    type: payload.annotationType,
  }
}

function halt(code: Exclude<DrainSkipReason, 'no-credential'>, uncertain = false): ZoteroWriteOutcome {
  return { code, halt: true, kind: 'retry', reason: REASON_FOR[code], ...(uncertain ? { uncertain: true } : {}) }
}

const MAX_REASON_LENGTH = 2_000

/**
 * A signed answer read as an outcome, or null when it is not one this side asked for: an unknown
 * kind, a confirmation without a valid key (or, for an edit or deletion, for another key than the
 * one sent), a refusal without its reason, or anything else.
 */
export function outcomeFromAnswer(text: string, operation: 'create' | 'update' | 'delete', sentKey: string | null): ZoteroWriteOutcome | null {
  let answer: unknown
  try {
    answer = JSON.parse(text)
  } catch {
    return null
  }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null
  const { code, itemKey, kind, note, reason } = answer as Record<string, unknown>
  if (kind === 'confirmed') {
    if (typeof itemKey !== 'string' || !KEY_PATTERN.test(itemKey)) return null
    if (operation !== 'create' && itemKey !== sentKey) return null
    if (note !== undefined && (typeof note !== 'string' || note.length > MAX_REASON_LENGTH)) return null
    return { itemKey, kind: 'confirmed', ...(note ? { note } : {}) }
  }
  if (typeof reason !== 'string' || !reason.trim() || reason.length > MAX_REASON_LENGTH) return null
  if (kind === 'conflict') {
    if (code === undefined) return { kind: 'conflict', reason }
    return code === 'key-in-use' && operation === 'create' ? { code: 'key-in-use', kind: 'conflict', reason } : null
  }
  if (kind === 'rejected') return { kind: 'rejected', reason }
  if (kind === 'retry') return { kind: 'retry', reason }
  return null
}

/**
 * One request to the plugin, its answer mapped onto the outbox's outcomes. The signature is checked
 * before anything else: an answer that is not signed for this request means nothing, whatever its
 * status (403, 404, 409, 5xx), so the write may have happened or not. That, and anything else that is
 * not a well-formed signed outcome, marks the row as interrupted: it is resent next time, and the
 * plugin recognises a change it already holds.
 */
async function post(
  bridge: ZoteroBridgeFile,
  connection: ZoteroPluginConnection,
  body: Record<string, unknown> & { operation: 'create' | 'update' | 'delete' },
  requestedKey: string | null,
): Promise<ZoteroWriteOutcome> {
  const text = JSON.stringify({ protocol: ZOTERO_PLUGIN_PROTOCOL, ...body })
  const answer = await sessionExchange(connection, bridge, ANNOTATIONS_PATH, text, connection.writeTimeoutMs ?? WRITE_TIMEOUT_MS)
  // Refused: nothing was sent.
  if (answer.kind === 'refused') return halt('zotero-closed')
  if (answer.kind === 'failed' || !answer.signed) return halt('zotero-busy', true)
  // Signed, so the plugin said it: another protocol, or a session it still calls stale. Neither wrote.
  if (answer.status === 409) return halt('plugin-outdated')
  if (answer.status === 401 && staleSessionOf(answer)) return halt('zotero-busy')
  if (answer.status !== 200) return halt('zotero-busy', true)
  return outcomeFromAnswer(answer.text, body.operation, requestedKey) ?? halt('zotero-busy', true)
}

/**
 * The Area quotation records which annotation the reader quoted. Its key is the one the create was
 * confirmed under, found among this app's own confirmed rows.
 */
function confirmedAreaKey(
  store: Pick<OutboxStore, 'outboxByStatus'> | undefined,
  libraryId: number,
  attachmentKey: string,
  sourceKey: string,
): string | null {
  for (const entry of store?.outboxByStatus?.('confirmed') ?? []) {
    if (entry.operation !== 'create' || entry.libraryId !== libraryId || entry.parentItemKey !== attachmentKey || !entry.itemKey) continue
    try {
      const retained = JSON.parse(entry.payload) as ZoteroAnnotationPayload
      if (
        retained.annotationType === 'image'
        && (retained.readflexSourceKey === sourceKey || (!retained.readflexSourceKey && entry.itemKey === sourceKey))
      ) {
        return entry.itemKey
      }
    } catch {
      // An unreadable retained row cannot establish the annotation's identity.
    }
  }
  return null
}

/**
 * The transport: one outbox row, one request. The checks that need only the outbox run here, before
 * anything is sent; everything that needs Zotero's own data runs in the plugin, in one transaction.
 */
export function zoteroPluginTransport(
  bridge: ZoteroBridgeFile,
  connection: ZoteroPluginConnection,
  store?: Pick<OutboxStore, 'outboxByStatus' | 'outboxKeyReplacement' | 'recordOutboxKeyReplacement'>,
): ZoteroWriteTransport {
  return async ({ itemKey, libraryId, operation, parentItemKey, payload, resend }) => {
    const attachmentKey = parentItemKey ?? payload.parentItem
    const common = { libraryId, parentItemKey: attachmentKey, ...(resend ? { resend: true } : {}) }
    const areaQuotation = payload.readflexAreaQuotation
    if (operation === 'update' && areaQuotation) {
      if (
        payload.annotationType !== 'image'
        || typeof areaQuotation.sourceKey !== 'string'
        || !areaQuotation.sourceKey
        || typeof areaQuotation.comment !== 'string'
        || !areaQuotation.comment
      ) {
        return { kind: 'rejected', reason: 'This Area quotation record was not valid.' }
      }
      const key = confirmedAreaKey(store, libraryId, attachmentKey, areaQuotation.sourceKey)
      if (!key) {
        return { kind: 'retry', reason: 'The Area annotation is still waiting to be written before its quotation can be recorded.' }
      }
      return post(bridge, connection, { ...common, areaQuotation: areaQuotation.comment, itemKey: key, operation: 'update' }, key)
    }
    if (operation === 'delete' || operation === 'update') {
      if (!itemKey) {
        return { kind: 'rejected', reason: operation === 'delete' ? 'This deletion names no highlight.' : 'This edit names no highlight.' }
      }
      const baseline = validBaseline(payload.readflexBaseline)
      if (!baseline) return { kind: 'conflict', reason: UNVERIFIABLE_CHANGE_REASON }
      // A deletion is checked against the tags Zotero held when the reader showed the mark; one that
      // does not record them is never sent, whatever plugin version is installed (ADR-0047).
      if (operation === 'delete' && !baseline.zoteroState) return { kind: 'conflict', reason: UNVERIFIABLE_CHANGE_REASON }
      const target = resolveTarget(store, libraryId, attachmentKey, itemKey, readerSessionOf(payload))
      // The compare covers the type: the reader's, or for rows queued before it was recorded, the
      // mark's own type (WriteFlex never changes a type).
      const typedBaseline = { ...baseline, type: baseline.type ?? payload.annotationType }
      const targetFields = { baseline: typedBaseline, itemKey: target.key, ...(target.supersededKey ? { supersededKey: target.supersededKey } : {}) }
      if (operation === 'delete') {
        return post(bridge, connection, { ...common, ...targetFields, operation: 'delete' }, target.key)
      }
      const fields = pluginFields(payload)
      if (!fields) return { kind: 'rejected', reason: 'This highlight could not be read back for writing.' }
      // A comment is never cut short on its way into Zotero: the cut would be written over the real one.
      if (
        (fields.comment ?? '') !== (baseline.comment ?? '')
        && Buffer.byteLength(fields.comment ?? '', 'utf8') > MAX_ANNOTATION_COMMENT_BYTES
      ) {
        return { kind: 'rejected', reason: COMMENT_TOO_LONG_REASON }
      }
      return post(bridge, connection, { ...common, ...targetFields, operation: 'update', payload: fields }, target.key)
    }
    const fields = pluginFields(payload)
    if (!fields) return { kind: 'rejected', reason: 'This highlight could not be read back for writing.' }
    if (!itemKey) return { kind: 'rejected', reason: 'This highlight has no key to be written under.' }
    // The key the mark is written under: the reader's own, or the fresh one chosen when Zotero already
    // used it. Only this side ever chooses it, so a resend always names the key the first send used.
    const session = readerSessionOf(payload)
    let key = store?.outboxKeyReplacement?.(libraryId, attachmentKey, itemKey, session) ?? itemKey
    let sendAsResend = !!resend
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await post(
        bridge, connection,
        { libraryId, parentItemKey: attachmentKey, ...(sendAsResend ? { resend: true } : {}), itemKey: key, operation: 'create', payload: fields },
        key,
      )
      if (outcome.kind !== 'conflict' || outcome.code !== 'key-in-use') return outcome
      // Zotero holds something else under that key. Choose another, record it so the reader's later
      // edits and deletions of this mark resolve to it, and send the create again under it. The new
      // key has never been sent, so this is not a resend.
      if (!store?.recordOutboxKeyReplacement || attempt + 1 >= MAX_KEY_ATTEMPTS) {
        return { kind: 'conflict', reason: outcome.reason }
      }
      key = newZoteroKey()
      store.recordOutboxKeyReplacement(libraryId, attachmentKey, itemKey, key, session)
      sendAsResend = false
    }
  }
}

// ---------------------------------------------------------------------------
// Reading what Zotero holds
// ---------------------------------------------------------------------------

const ANNOTATION_TYPES = new Set(['highlight', 'note', 'image', 'ink', 'underline', 'text', 'unknown'])

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** One annotation from the plugin's read, checked field by field; null when not in that shape. */
function annotationFromRead(value: unknown, attachmentKey: string): (ZoteroAnnotation & { zoteroState: ZoteroState }) | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  // Any key Zotero holds, as the file read takes it: a stricter shape would turn a whole read
  // non-authoritative over one odd key.
  if (typeof row.key !== 'string' || !READ_KEY_PATTERN.test(row.key)) return null
  if (typeof row.type !== 'string' || !ANNOTATION_TYPES.has(row.type)) return null
  if (row.parentItemKey !== attachmentKey) return null
  if (!Array.isArray(row.tags) || !row.tags.every((tag) => typeof tag === 'string')) return null
  if (![row.authorName, row.text, row.comment, row.color, row.pageLabel].every(nullableString)) return null
  if (typeof row.sortIndex !== 'string' || typeof row.position !== 'string' || typeof row.isExternal !== 'boolean') return null
  if (row.modified !== undefined && row.modified !== null && typeof row.modified !== 'string') return null
  return {
    zoteroState: { modified: (row.modified as string | null | undefined) ?? null, tags: [...row.tags as string[]] },
    authorName: row.authorName as string | null,
    color: row.color as string | null,
    comment: row.comment as string | null,
    isExternal: row.isExternal,
    key: row.key,
    pageLabel: row.pageLabel as string | null,
    parentItemKey: attachmentKey,
    position: row.position,
    sortIndex: row.sortIndex,
    tags: row.tags as string[],
    text: row.text as string | null,
    type: row.type as ZoteroAnnotation['type'],
  }
}

export type PluginRead =
  | { kind: 'read'; annotations: Array<ZoteroAnnotation & { zoteroState: ZoteroState }> }
  | { kind: 'unavailable'; code: Exclude<DrainSkipReason, 'no-credential'> | 'not-read' }

/**
 * The attachment's annotations as Zotero holds them now, through the plugin: authoritative, because
 * the plugin reads inside a Zotero transaction (after any write in progress) and signs the answer. Any
 * other result, including an answer that is not signed or not in the expected shape, is `unavailable`
 * and must not be taken as what Zotero holds.
 */
export async function readAnnotationsThroughPlugin(
  connection: ZoteroPluginConnection,
  libraryId: number,
  attachmentKey: string,
): Promise<PluginRead> {
  const reachability = await pingZoteroPlugin(connection)
  if (reachability.kind === 'unavailable') return { code: reachability.code, kind: 'unavailable' }
  const text = JSON.stringify({ libraryId, parentItemKey: attachmentKey, protocol: ZOTERO_PLUGIN_PROTOCOL })
  const answer = await sessionExchange(connection, reachability.bridge, READ_PATH, text, connection.writeTimeoutMs ?? WRITE_TIMEOUT_MS)
  if (answer.kind !== 'answer' || !answer.signed || answer.status !== 200) return { code: 'not-read', kind: 'unavailable' }
  try {
    const body = JSON.parse(answer.text) as { kind?: unknown; annotations?: unknown }
    if (body.kind !== 'annotations' || !Array.isArray(body.annotations)) return { code: 'not-read', kind: 'unavailable' }
    const annotations = body.annotations.map((row) => annotationFromRead(row, attachmentKey))
    if (annotations.some((row) => row === null)) return { code: 'not-read', kind: 'unavailable' }
    return { annotations: annotations as Array<ZoteroAnnotation & { zoteroState: ZoteroState }>, kind: 'read' }
  } catch {
    return { code: 'not-read', kind: 'unavailable' }
  }
}

/** How many rows one refused drain marks. Far above any real queue; a bound, not a window. */
const REFUSAL_MARK_LIMIT = 10_000

function skippedReport(code: DrainSkipReason, reason: string): DrainReport {
  return { attempted: 0, confirmed: 0, conflicted: 0, keptLocal: 0, rejected: 0, retrying: 0, skipped: code, skippedReason: reason }
}

/**
 * Drain the outbox into Zotero through the plugin, or say why not. When the plugin cannot be reached
 * nothing is sent, and the reason is recorded on every row held back so it is never silent.
 */
export async function drainOutboxToZoteroPlugin(
  store: OutboxStore,
  connection: ZoteroPluginConnection,
  limit = 25,
  log: ZoteroWriteAttemptLog = () => {},
): Promise<DrainReport> {
  if (store.outboxDue(1).length === 0) {
    return { attempted: 0, confirmed: 0, conflicted: 0, keptLocal: 0, rejected: 0, retrying: 0, skipped: null }
  }
  const reachability = await pingZoteroPlugin(connection)
  if (reachability.kind === 'unavailable') {
    for (const entry of store.outboxDue(REFUSAL_MARK_LIMIT) as OutboxEntry[]) {
      store.markOutboxFailed(entry.id, reachability.reason, true)
      log({ key: entry.itemKey, operation: entry.operation, outbox: entry.id, outcome: `refused:${reachability.code}`, reason: reachability.reason })
    }
    return skippedReport(reachability.code, reachability.reason)
  }
  return drainOutbox(store, zoteroPluginTransport(reachability.bridge, connection, store), limit, log)
}
