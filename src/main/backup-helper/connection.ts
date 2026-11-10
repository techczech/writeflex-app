/**
 * The one connection main keeps to the backup helper of a trusted trial configuration.
 *
 * Transport only: it connects through the reviewed `connectHelper` (which checks the helper's private
 * runtime folder, says hello and checks every reply envelope), sends one request at a time, and
 * never starts, stops, signals or inspects a helper process.
 *
 * - One connection at a time. Callers that need it while it is being made share that attempt.
 * - Requests run in order, at most MAX_WAITING waiting; more are refused as `busy` without being sent.
 *   A waiting request whose caller has gone (its signal aborted) is dropped before it is sent.
 * - A request that times out, a closed connection, an unreadable reply or a result that fails the
 *   caller's check ends that connection; the next request makes a new one. A failure on a connection
 *   that has since been replaced never ends the newer one.
 * - After a failed connect it waits (2 s, doubling to 30 s) before trying again; requests meanwhile
 *   are answered `backing-off` without touching the socket.
 * - `close()` ends the connection and withdraws every request made before it that has not been sent:
 *   they are answered `cancelled` and never open a new connection. Requests made after `close()` open
 *   a new one. A request already sent may still be answered by the helper; its caller is told the
 *   connection closed. `dispose()` ends it for good.
 */
import { connectHelper, HelperClientError } from '@app-patterns/vault-sync/helper'
import type { BackupHelperUnavailableReason } from '../../shared/backup-helper'
import { BACKUP_HELPER_PROTOCOL } from '../../shared/backup-helper'
import { ReplyCheckError } from './reply-check'

/** The part of the reviewed client the bridge uses. */
export type HelperClientPort = {
  readonly helperVersion: string
  request(method: 'status' | 'syncNow', params: { vault: string }, timeoutMs: number): Promise<HelperResponse>
  close(): void
}

export type HelperResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number | null; ok: false; error: { code: string; message: string } }

export type ConnectPort = (socketPath: string, options: { client: string; protocol: number; timeoutMs: number }) => Promise<HelperClientPort>

export const connectReviewedHelper: ConnectPort = (socketPath, options) => connectHelper(socketPath, options) as Promise<HelperClientPort>

/** helper server.ts MAX_QUEUED_REQUESTS: the helper closes a connection with more waiting than this. */
export const MAX_WAITING = 8
const BACKOFF_MIN_MS = 2_000
const BACKOFF_MAX_MS = 30_000

export type ConnectionAnswer<T> =
  | { ok: true; value: T; receivedAt: number }
  | { ok: false; reason: BackupHelperUnavailableReason | 'cancelled' | 'disposed'; message: string }

const MESSAGES: Record<BackupHelperUnavailableReason | 'cancelled' | 'disposed', string> = {
  'not-running': 'The backup helper is not running.',
  'connect-failed': 'The backup helper could not be reached.',
  'protocol-mismatch': 'The backup helper speaks another protocol version.',
  disconnected: 'The connection to the backup helper ended before it answered.',
  'bad-reply': 'The backup helper sent a reply WriteFlex could not check; the connection was closed.',
  'helper-error': 'The backup helper refused the request.',
  stopping: 'The backup helper is stopping.',
  'unknown-vault': 'The backup helper does not know this vault.',
  busy: 'Too many backup requests are waiting.',
  'backing-off': 'The backup helper could not be reached a moment ago.',
  cancelled: 'The request was withdrawn.',
  disposed: 'The backup bridge has shut down.',
}

const unavailable = (reason: keyof typeof MESSAGES, message = MESSAGES[reason]): { ok: false; reason: keyof typeof MESSAGES; message: string } => ({ ok: false, reason, message })

function connectFailure(error: unknown): BackupHelperUnavailableReason {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'not-a-socket') return 'not-running'
  if (code === 'protocol-mismatch') return 'protocol-mismatch'
  if (code === 'bad-reply') return 'bad-reply'
  return 'connect-failed'
}

export type HelperConnection = {
  request<T>(method: 'status' | 'syncNow', vault: string, timeoutMs: number, check: (result: unknown, receivedAt: number) => T, signal?: AbortSignal): Promise<ConnectionAnswer<T>>
  /** True while a connection is open or being made. */
  readonly connected: boolean
  close(): void
  dispose(): void
}

export function createHelperConnection(options: {
  socketPath: string
  client: string
  connectTimeoutMs: number
  connect?: ConnectPort
  now?: () => number
}): HelperConnection {
  const connect = options.connect ?? connectReviewedHelper
  const now = options.now ?? Date.now
  let current: { client: HelperClientPort } | null = null
  let opening: Promise<{ client: HelperClientPort }> | null = null
  let openingToken: object | null = null
  let disposed = false
  let retryAt = 0
  let backoff = BACKOFF_MIN_MS
  let waiting = 0
  let chain: Promise<unknown> = Promise.resolve()
  /** Bumped by close() and dispose(): a request made under an older generation is never sent. */
  let generation = 0

  const drop = (conn: { client: HelperClientPort } | null): void => {
    if (!conn || current !== conn) return
    current = null
    try { conn.client.close() } catch { /* already closed */ }
  }

  async function open(): Promise<{ client: HelperClientPort }> {
    if (current) return current
    if (opening) return opening
    // `token` names this attempt; close() or dispose() replace `opening`, so a socket that connects
    // after them is closed at once instead of being left open with nobody holding it.
    const token = {}
    openingToken = token
    const attempt = (async () => {
      const client = await connect(options.socketPath, { client: options.client, protocol: BACKUP_HELPER_PROTOCOL, timeoutMs: options.connectTimeoutMs })
      if (disposed || openingToken !== token) {
        try { client.close() } catch { /* already closed */ }
        throw Object.assign(new Error('closed while connecting'), { code: disposed ? 'disposed' : 'cancelled' })
      }
      current = { client }
      return current
    })()
    opening = attempt
    try {
      const conn = await attempt
      backoff = BACKOFF_MIN_MS
      retryAt = 0
      return conn
    } catch (error) {
      if (openingToken === token) {
        retryAt = now() + backoff
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
      throw error
    } finally {
      if (openingToken === token) { opening = null; openingToken = null }
    }
  }

  async function send<T>(method: 'status' | 'syncNow', vault: string, timeoutMs: number, check: (result: unknown, receivedAt: number) => T, signal: AbortSignal | undefined, made: number): Promise<ConnectionAnswer<T>> {
    if (disposed) return unavailable('disposed')
    if (signal?.aborted || made !== generation) return unavailable('cancelled')
    if (!current && !opening && now() < retryAt) return unavailable('backing-off')
    let conn: { client: HelperClientPort }
    try {
      conn = await open()
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'disposed') return unavailable('disposed')
      if (code === 'cancelled') return unavailable('cancelled')
      return unavailable(connectFailure(error))
    }
    if (disposed) return unavailable('disposed')
    if (signal?.aborted || made !== generation) return unavailable('cancelled')
    let response: HelperResponse
    try {
      response = await conn.client.request(method, { vault }, timeoutMs)
    } catch (error) {
      // The client has already closed this connection (timeout, close, bad envelope, untied error).
      drop(conn)
      if (disposed) return unavailable('disposed')
      const code = error instanceof HelperClientError ? error.code : (error as { code?: unknown } | null)?.code
      if (code === 'bad-reply') return unavailable('bad-reply')
      if (code === 'timeout' || code === 'closed' || typeof code !== 'string' || code.startsWith('E')) return unavailable('disconnected')
      return unavailable('helper-error')
    }
    const receivedAt = now()
    if (!response.ok) {
      const code = response.error.code
      if (code === 'unknown-vault') return unavailable('unknown-vault')
      if (code === 'stopping') return unavailable('stopping')
      return unavailable('helper-error', `${MESSAGES['helper-error']} (${String(code).slice(0, 40)})`)
    }
    try {
      return { ok: true, value: check(response.result, receivedAt), receivedAt }
    } catch (error) {
      drop(conn)
      if (error instanceof ReplyCheckError) return unavailable('bad-reply')
      throw error
    }
  }

  return {
    get connected() { return current !== null || opening !== null },
    request(method, vault, timeoutMs, check, signal) {
      if (disposed) return Promise.resolve(unavailable('disposed'))
      if (waiting >= MAX_WAITING) return Promise.resolve(unavailable('busy'))
      waiting++
      const made = generation
      const run = chain.then(() => send(method, vault, timeoutMs, check, signal, made)).finally(() => { waiting-- })
      chain = run.catch(() => undefined)
      return run
    },
    close() {
      generation++
      opening = null
      openingToken = null
      drop(current)
    },
    dispose() {
      disposed = true
      generation++
      opening = null
      openingToken = null
      drop(current)
    },
  }
}
