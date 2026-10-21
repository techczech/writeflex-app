// Requests to Cloudflare's API (sharing ticket 02). Ported from TalkWeaver's
// src/main/cloudflare-connection.ts (the request half: `send`, `ask`, the account list).
//
// The token reaches Cloudflare in ONE place: the `Authorization` header that `send` sets. Every
// request that carries it goes through `send`, which keeps only the HTTP status, Cloudflare's error
// NUMBERS and the few named fields each call picks from the reply's `result`. A request that fails to
// send becomes a fixed kind (`unreachable`); the transport's own error, which can quote the header it
// refused, is dropped and never read, logged or attached. So nothing this module returns holds the
// token or text from a Cloudflare reply, with one exception by design: an account's name, cut to
// plain printable characters, for the account picker.
//
// - A token is checked where it comes in (printable ASCII, no space, 16 to 512 characters) and again
//   before it is sent, so it cannot break out of the header. It is refused in any address.
// - Requests go to https://api.cloudflare.com/client/v4 and nowhere else. The one exception is for
//   tests: an unpackaged app started with WRITEFLEX_E2E=1 may be pointed at a stand-in API on this
//   computer's loopback address (`cloudflareApiBase`); a packaged build ignores it. A redirect is
//   never followed.
// - Every request has a time limit that does not rely on the transport honouring it.
//
// No Electron import.

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
/** How long one small request may take. The upload has its own, longer limit. */
export const REQUEST_TIMEOUT_MS = 30_000
export const UPLOAD_TIMEOUT_MS = 120_000
const MAX_REPLY_BYTES = 1024 * 1024

// ── Where requests go ───────────────────────────────────────────────────────────────────────────

/** `http://127.0.0.1:<port>/client/v4` exactly, or null. */
export function loopbackApiBase(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null
  try {
    const url = new URL(value)
    const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && url.pathname === '/client/v4'
      && !url.search && !url.hash && !url.username && !url.password
    return loopback ? `${url.origin}/client/v4` : null
  } catch {
    return null
  }
}

/** `http://127.0.0.1:<port>` exactly (no path), or null: the stand-in sharing service of an e2e run. */
export function loopbackOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null
  try {
    const url = new URL(value)
    const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '' && (url.pathname === '/' || url.pathname === '')
      && !url.search && !url.hash && !url.username && !url.password
    return loopback ? url.origin : null
  } catch {
    return null
  }
}

export type TestContext = { packaged: boolean; e2e: boolean; override: unknown }

/** The API this app's calls go to: Cloudflare's, or a loopback stand-in in an unpackaged e2e run. */
export function cloudflareApiBase(context: TestContext): string {
  if (context.packaged || !context.e2e) return CLOUDFLARE_API_BASE
  return loopbackApiBase(context.override) ?? CLOUDFLARE_API_BASE
}

// ── What may be sent ────────────────────────────────────────────────────────────────────────────

/** 16 to 512 printable ASCII characters with no space: safe to send in an authentication header. */
export function validCloudflareToken(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{16,512}$/.test(value)
}
/** An account id that is safe as one path segment. */
export function validAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}
/** Plain printable text of at most `max` characters, or '' when nothing usable is left. */
export function plainText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // Control characters, line and paragraph separators and the characters that reorder text.
  const unprintable = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'g')
  return value.replace(unprintable, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

// ── One request ─────────────────────────────────────────────────────────────────────────────────

/**
 * What a request came to. `denied`: Cloudflare refused the token for this (401, 403). `missing`:
 * 404. `conflict`: 409. `refused`: any other 4xx, or a success flag that is false. `unreachable`: no
 * usable answer (not sent, timed out, 5xx, not JSON).
 */
export type AnswerKind = 'ok' | 'denied' | 'missing' | 'refused' | 'conflict' | 'unreachable'
/**
 * Why a request that was sent got no usable answer, as one fixed word. Derived only from fixed
 * signals (our own timeout, the size cap, an allow-listed transport code); never from a message.
 */
export type FailureWord = 'timeout' | 'too-large' | 'redirect' | 'dns' | 'refused-connection' | 'reset' | 'tls' | 'aborted' | 'other' | 'base' | 'path'
/** `connect`: before the reply's status arrived. `body`: the status arrived, reading the reply failed. */
export type FailureStage = 'connect' | 'body'
export type Answer<Result = null> = {
  kind: AnswerKind; http: number | null; codes: number[]; result: Result | null
  failure?: FailureWord; stage?: FailureStage
}

const noAnswer = <Result>(kind: AnswerKind): Answer<Result> => ({ kind, http: null, codes: [], result: null })

export interface RequestPort {
  fetch: typeof fetch
  base: string
  timeoutMs: number
}

/** The size cap's own error (readCapped). */
class ReplyTooLarge extends Error { constructor() { super('too large') } }

/** A failure as `within` passes it on: a fixed message and one fixed word, nothing of the cause. */
export class SafeFailure extends Error {
  constructor(readonly failure: FailureWord) { super('failed') }
}

/** Transport codes (undici / Node) that are kept, each as its fixed word. Any other code is 'other'. */
const FAILURE_CODES: Record<string, FailureWord> = {
  ENOTFOUND: 'dns', EAI_AGAIN: 'dns',
  ECONNREFUSED: 'refused-connection',
  ECONNRESET: 'reset', UND_ERR_SOCKET: 'reset',
  UND_ERR_CONNECT_TIMEOUT: 'timeout', UND_ERR_HEADERS_TIMEOUT: 'timeout', UND_ERR_BODY_TIMEOUT: 'timeout',
  // Node's certificate-check codes that carry neither prefix below.
  UNABLE_TO_GET_ISSUER_CERT: 'tls', UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'tls', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls', SELF_SIGNED_CERT_IN_CHAIN: 'tls',
}

const fieldOf = (value: unknown, name: string): unknown =>
  value !== null && (typeof value === 'object' || typeof value === 'function') ? (value as Record<string, unknown>)[name] : undefined

/**
 * One fixed word for a thrown failure. Reads only `name`, `code` and (for the redirect case) whether
 * the cause's message mentions a redirect; nothing read is kept or passed on.
 */
export function failureWord(reason: unknown): FailureWord {
  if (reason instanceof SafeFailure) return reason.failure
  if (reason instanceof ReplyTooLarge) return 'too-large'
  const chain: unknown[] = []
  for (let link: unknown = reason, depth = 0; link !== undefined && link !== null && depth < 4; link = fieldOf(link, 'cause'), depth += 1) chain.push(link)
  for (const link of chain) {
    const code = fieldOf(link, 'code')
    if (typeof code !== 'string') continue
    if (Object.hasOwn(FAILURE_CODES, code)) return FAILURE_CODES[code]!
    if (code.startsWith('CERT_') || code.startsWith('ERR_TLS_')) return 'tls'
  }
  if (chain.some((link) => fieldOf(link, 'name') === 'AbortError')) return 'aborted'
  if (reason instanceof TypeError && chain.slice(1).some((link) => {
    const message = fieldOf(link, 'message')
    return typeof message === 'string' && /redirect/i.test(message)
  })) return 'redirect'
  return 'other'
}

/** Settle with `work`, or reject when `ms` pass, whatever `work` itself does. Rejects only with a SafeFailure. */
export function within<Result>(work: (signal: AbortSignal) => Promise<Result>, ms: number): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const stop = new AbortController()
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle()
    }
    const timer = setTimeout(() => { stop.abort(); finish(() => reject(new SafeFailure('timeout'))) }, ms)
    let started: Promise<Result>
    try { started = work(stop.signal) } catch (reason) { const word = failureWord(reason); return finish(() => reject(new SafeFailure(word))) }
    // The reason for a failure is never passed on: it can quote the request, header included. Only
    // its fixed word is.
    started.then((value) => finish(() => resolve(value)), (reason) => { const word = failureWord(reason); finish(() => reject(new SafeFailure(word))) })
  })
}

export async function readCapped(response: Response, max = MAX_REPLY_BYTES): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) { try { await reader.cancel() } catch { /* already closed */ } throw new ReplyTooLarge() }
    parts.push(value)
  }
  return Buffer.concat(parts).toString('utf8')
}

/** One request of any kind. `headers` may not name the authorisation; only plain names and values are sent. */
export type OutgoingRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: string | FormData
  /** For a string body. A FormData body sets its own (with the boundary). */
  contentType?: string
  headers?: Record<string, string>
  /** Values that must never be in an address (this Mac's sharing key); the token never is either. */
  forbidden?: string[]
}

/**
 * Send one request with the token and sort the answer. Every request that carries the token goes
 * through here. `pick` takes the reply's `result` and returns only the fields the caller needs
 * (null when it is not the expected shape); nothing else of the reply is kept.
 */
export async function send<Result>(
  port: RequestPort, token: string, request: OutgoingRequest, pick: (result: unknown) => Result | null,
): Promise<Answer<Result>> {
  const { method, path, body } = request
  if (!validCloudflareToken(token)) return noAnswer('refused')
  if (port.base !== CLOUDFLARE_API_BASE && loopbackApiBase(port.base) !== port.base) return { ...noAnswer<Result>('unreachable'), failure: 'base', stage: 'connect' }
  if (!path.startsWith('/') || path.includes('..') || /[\s\\#]/.test(path)) return { ...noAnswer<Result>('unreachable'), failure: 'path', stage: 'connect' }
  // No secret is ever put in an address: refused, unsent.
  let decoded = path
  try { decoded = decodeURIComponent(path) } catch { /* not encoded text: compared as it is */ }
  const secrets = [token, ...(request.forbidden ?? [])].filter((value) => typeof value === 'string' && value.length > 0)
  if (secrets.some((value) => path.includes(value) || decoded.includes(value) || path.includes(encodeURIComponent(value)))) return noAnswer('refused')
  const extra = Object.entries(request.headers ?? {})
  if (extra.some(([name, value]) => !/^[A-Za-z0-9-]{1,64}$/.test(name) || /^authorization$/i.test(name) || !/^[\x20-\x7e]{0,256}$/.test(value))) return noAnswer('refused')
  let http = 0
  let text = ''
  // The status, once the reply's headers are in: a failure after that is a failure reading the body.
  let status: number | null = null
  let failed: Pick<Answer, 'failure' | 'stage'> | null = null
  try {
    const sent = await within(async (signal) => {
      const response = await port.fetch(`${port.base}${path}`, {
        method, signal, redirect: 'error',
        headers: {
          ...Object.fromEntries(extra),
          authorization: `Bearer ${token}`, accept: 'application/json',
          ...(typeof body === 'string' && request.contentType ? { 'content-type': request.contentType } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      })
      status = response.status
      // A reply the status alone decides (anything but 2xx) is still read for its error numbers,
      // but failing to read it does not change what it came to.
      return { http: response.status, text: await readCapped(response) }
    }, port.timeoutMs)
    http = sent.http
    text = sent.text
  } catch (reason) {
    // Only the fixed word is kept (within passes on nothing else), and whether the status was in.
    const failure = reason instanceof SafeFailure ? reason.failure : 'other'
    if (status === null) return { ...noAnswer<Result>('unreachable'), failure, stage: 'connect' }
    http = status
    failed = { failure, stage: 'body' }
  }
  type Reply = { success?: unknown; errors?: unknown; result?: unknown }
  let reply = null as Reply | null
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) reply = parsed as Reply
  } catch { /* not JSON: sorted by the HTTP status alone; the parser's message could quote the reply */ }
  const codes = Array.isArray(reply?.errors)
    ? (reply.errors as unknown[]).map((error) => (error as { code?: unknown } | null)?.code).filter((code): code is number => Number.isInteger(code)).slice(0, 8)
    : []
  const sorted = (kind: AnswerKind, result: Result | null = null): Answer<Result> => ({ kind, http, codes, result, ...(failed ?? {}) })
  if (http === 401 || http === 403) return sorted('denied')
  if (http === 404) return sorted('missing')
  if (http === 409) return sorted('conflict')
  if (http >= 400 && http < 500 && http !== 408 && http !== 429) return sorted('refused')
  if (http < 200 || http >= 300 || !reply) return sorted('unreachable')
  if (reply.success !== true) return sorted('refused')
  const result = pick(reply.result)
  return result === null ? sorted('unreachable') : sorted('ok', result)
}

/** `send` with an optional JSON body. */
export function ask<Result>(
  port: RequestPort, token: string, method: 'GET' | 'POST' | 'DELETE', path: string,
  pick: (result: unknown) => Result | null, body?: Record<string, unknown>,
): Promise<Answer<Result>> {
  return send(port, token, { method, path, ...(body ? { body: JSON.stringify(body), contentType: 'application/json' } : {}) }, pick)
}

const FAILURE_WORDS: readonly FailureWord[] = ['timeout', 'too-large', 'redirect', 'dns', 'refused-connection', 'reset', 'tls', 'aborted', 'other', 'base', 'path']

/** "Cloudflare answered 403 (error 10000)." Numbers and fixed words only: nothing of a reply's text. */
export function answeredInNumbers(answer: Answer<unknown>): string {
  const word = answer.failure && FAILURE_WORDS.includes(answer.failure) ? answer.failure : null
  if (answer.http === null) return `Cloudflare could not be reached or did not answer in time${word ? ` (${word})` : ''}`
  if (answer.stage === 'body' && word) return `Cloudflare answered ${answer.http} but the reply could not be read (${word})`
  const codes = answer.codes.length ? ` (error ${answer.codes.join(', ')})` : ''
  const empty = answer.kind === 'unreachable' && answer.http >= 200 && answer.http < 300 ? ' without what was asked for' : ''
  return `Cloudflare answered ${answer.http}${codes}${empty}`
}

/** Cloudflare's "authentication error" number: a token that does not reach this. */
export const AUTH_ERROR_CODE = 10000
/** The token is denied for this request (status, or Cloudflare's authentication error number). */
export const deniedFor = (answer: Answer<unknown>): boolean => answer.kind === 'denied' || answer.codes.includes(AUTH_ERROR_CODE)

// ── What is asked, and what is kept of each answer ──────────────────────────────────────────────

export const TOKEN_STATUSES = ['active', 'disabled', 'expired'] as const
export type TokenStatus = typeof TOKEN_STATUSES[number]

export function pickVerify(result: unknown): { status: TokenStatus } | null {
  const status = (result as { status?: unknown } | null)?.status
  return TOKEN_STATUSES.includes(status as TokenStatus) ? { status: status as TokenStatus } : null
}

export type CloudflareAccount = { id: string; name: string }

/** How many accounts are asked for at a time, and how many are listed at most. */
export const ACCOUNTS_PER_PAGE = 50
export const ACCOUNTS_CAP = 200
type AccountsPage = { accounts: CloudflareAccount[]; entries: number }
function pickAccountsPage(result: unknown): AccountsPage | null {
  if (!Array.isArray(result)) return null
  const accounts: CloudflareAccount[] = []
  for (const entry of result.slice(0, ACCOUNTS_PER_PAGE)) {
    const id = (entry as { id?: unknown } | null)?.id
    if (!validAccountId(id)) continue
    accounts.push({ id, name: plainText((entry as { name?: unknown }).name, 80) || id })
  }
  return { accounts, entries: result.length }
}

/**
 * Every account the token lists, a page at a time, up to ACCOUNTS_CAP. A page that does not answer
 * makes the whole list unanswered (a partial list could hide the right account).
 */
export async function listAccounts(port: RequestPort, token: string): Promise<Answer<CloudflareAccount[]>> {
  const accounts: CloudflareAccount[] = []
  const seen = new Set<string>()
  for (let page = 1; ; page += 1) {
    const answer = await ask(port, token, 'GET', `/accounts?page=${page}&per_page=${ACCOUNTS_PER_PAGE}`, pickAccountsPage)
    if (answer.kind !== 'ok' || !answer.result) return { ...answer, result: null }
    for (const account of answer.result.accounts) if (!seen.has(account.id)) { seen.add(account.id); accounts.push(account) }
    const more = answer.result.entries >= ACCOUNTS_PER_PAGE
    if (!more || page * ACCOUNTS_PER_PAGE >= ACCOUNTS_CAP) return { ...answer, result: accounts }
  }
}
