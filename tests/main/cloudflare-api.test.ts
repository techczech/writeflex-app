import {fakeBearer} from '../helpers/fake-auth'
// `send` (src/main/cloudflare-api.ts) when the transport fails: the failure is kept as one fixed
// word and a stage, never as its text, and a status that arrived still decides what the request came
// to. A fake fetch stands in for Cloudflare; no real call is made.
import { describe, expect, test } from 'bun:test'
import { CLOUDFLARE_API_BASE, answeredInNumbers, failureWord, send, type Answer, type RequestPort } from '../../src/main/cloudflare-api.ts'

const TOKEN = 'cfTOKEN-abcdefghijklmnop-0123456789'
const SECRET_LOOKING = fakeBearer('cfSECRET-qrstuvwxyz-9876543210')

const port = (fetcher: (input: unknown, init?: RequestInit) => Promise<Response>, timeoutMs = 1000): RequestPort =>
  ({ fetch: fetcher as typeof fetch, base: CLOUDFLARE_API_BASE, timeoutMs })

const lookup = (p: RequestPort): Promise<Answer<unknown>> =>
  send(p, TOKEN, { method: 'GET', path: '/accounts/abc/workers/services/writeflex-sharing' }, (result) => result ?? null)

/** undici's shape: TypeError('fetch failed') whose cause carries the code (and a message that may quote anything). */
const transportError = (code: string): Error =>
  new TypeError(`fetch failed ${SECRET_LOOKING}`, { cause: Object.assign(new Error(`${code} ${SECRET_LOOKING} ${TOKEN}`), { code }) })

/** A reply whose status and headers arrive, then whose body fails with `reason`. */
const failingBody = (status: number, reason: unknown): Response => {
  let sent = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('{"success":false,')); return }
      controller.error(reason)
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

const expectNothingLeaks = (answer: Answer<unknown>): void => {
  const everything = JSON.stringify(answer) + answeredInNumbers(answer)
  for (const secret of [TOKEN, 'cfSECRET', 'Bearer', 'fetch failed']) expect(everything).not.toContain(secret)
}

describe('a failure before the status arrives', () => {
  const cases: Array<[string, string]> = [
    ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'],
    ['ECONNREFUSED', 'refused-connection'],
    ['ECONNRESET', 'reset'], ['UND_ERR_SOCKET', 'reset'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'], ['UND_ERR_HEADERS_TIMEOUT', 'timeout'], ['UND_ERR_BODY_TIMEOUT', 'timeout'],
    ['CERT_HAS_EXPIRED', 'tls'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'], ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'tls'],
  ]
  for (const [code, word] of cases) {
    test(`${code} is kept as "${word}"`, async () => {
      const answer = await lookup(port(async () => { throw transportError(code) }))
      expect(answer).toMatchObject({ kind: 'unreachable', http: null, codes: [], result: null, failure: word, stage: 'connect' })
      expect(answeredInNumbers(answer)).toBe(`Cloudflare could not be reached or did not answer in time (${word})`)
      expectNothingLeaks(answer)
    })
  }

  test('an unknown code is "other", and the code itself is not kept', async () => {
    const answer = await lookup(port(async () => { throw transportError('EWEIRD_SECRET_CODE') }))
    expect(answer).toMatchObject({ kind: 'unreachable', http: null, failure: 'other', stage: 'connect' })
    expect(JSON.stringify(answer) + answeredInNumbers(answer)).not.toContain('EWEIRD')
    expectNothingLeaks(answer)
  })

  test('a failure with no cause at all is "other"', async () => {
    const answer = await lookup(port(async () => { throw new Error(`${SECRET_LOOKING} ${TOKEN}`) }))
    expect(answer).toMatchObject({ failure: 'other', stage: 'connect' })
    expectNothingLeaks(answer)
  })

  test('a redirect refused by fetch is "redirect"', async () => {
    const answer = await lookup(port(async () => { throw new TypeError('fetch failed', { cause: new Error(`unexpected redirect ${TOKEN}`) }) }))
    expect(answer).toMatchObject({ failure: 'redirect', stage: 'connect' })
    expectNothingLeaks(answer)
  })

  test('an abort that is not our timeout is "aborted"', async () => {
    const answer = await lookup(port(async () => { throw new DOMException(`aborted ${TOKEN}`, 'AbortError') }))
    expect(answer).toMatchObject({ failure: 'aborted', stage: 'connect' })
    expectNothingLeaks(answer)
  })

  test('our own time limit is "timeout"', async () => {
    const answer = await lookup(port(() => new Promise<Response>(() => {}), 20))
    expect(answer).toMatchObject({ kind: 'unreachable', http: null, failure: 'timeout', stage: 'connect' })
    expect(answeredInNumbers(answer)).toBe('Cloudflare could not be reached or did not answer in time (timeout)')
  })

  test('fetch throwing synchronously is still a fixed word', async () => {
    const answer = await lookup(port((() => { throw transportError('ECONNRESET') }) as never))
    expect(answer).toMatchObject({ failure: 'reset', stage: 'connect' })
    expectNothingLeaks(answer)
  })

  test('failureWord reads a code from the error itself too', () => {
    expect(failureWord(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe('dns')
    expect(failureWord('a plain string')).toBe('other')
    expect(failureWord(null)).toBe('other')
  })
})

describe('a failure after the status arrives', () => {
  test('404 with a body that fails to read is still missing, with the status kept', async () => {
    const answer = await lookup(port(async () => failingBody(404, transportError('ECONNRESET'))))
    expect(answer).toMatchObject({ kind: 'missing', http: 404, codes: [], result: null, failure: 'reset', stage: 'body' })
    expect(answeredInNumbers(answer)).toBe('Cloudflare answered 404 but the reply could not be read (reset)')
    expectNothingLeaks(answer)
  })

  test('401, 403, 409 and other 4xx sort by status without the body', async () => {
    const expected: Array<[number, string]> = [[401, 'denied'], [403, 'denied'], [409, 'conflict'], [400, 'refused']]
    for (const [status, kind] of expected) {
      const answer = await lookup(port(async () => failingBody(status, transportError('UND_ERR_SOCKET'))))
      expect(answer).toMatchObject({ kind, http: status, codes: [], failure: 'reset', stage: 'body' })
    }
  })

  test('200 with a body that fails to read is unreachable, stage body', async () => {
    const answer = await lookup(port(async () => failingBody(200, transportError('ECONNRESET'))))
    expect(answer).toMatchObject({ kind: 'unreachable', http: 200, codes: [], result: null, failure: 'reset', stage: 'body' })
    expect(answeredInNumbers(answer)).toBe('Cloudflare answered 200 but the reply could not be read (reset)')
    expectNothingLeaks(answer)
  })

  test('200 with a reply over the size cap is "too-large"', async () => {
    const big = new Uint8Array(1024 * 1024 + 10).fill(32)
    const answer = await lookup(port(async () => new Response(big, { status: 200 })))
    expect(answer).toMatchObject({ kind: 'unreachable', http: 200, failure: 'too-large', stage: 'body' })
  })

  test('a body that stalls past the time limit is "timeout", stage body', async () => {
    const stalled = new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), { status: 200 })
    const answer = await lookup(port(async () => stalled, 20))
    expect(answer).toMatchObject({ kind: 'unreachable', http: 200, failure: 'timeout', stage: 'body' })
  })
})

describe('a reply that reads cleanly', () => {
  test('carries no failure word', async () => {
    const reply = JSON.stringify({ success: false, errors: [{ code: 10090, message: 'This Worker does not exist on this account' }], result: null })
    const answer = await lookup(port(async () => new Response(reply, { status: 404 })))
    expect(answer).toEqual({ kind: 'missing', http: 404, codes: [10090], result: null })
    expect(answeredInNumbers(answer)).toBe('Cloudflare answered 404 (error 10090)')
  })
})

describe('a request not sent: the address or path is refused before any call', () => {
  test('a base that is neither Cloudflare nor loopback gives failure "base", and nothing is fetched', async () => {
    let calls = 0
    const answer = await send(
      { fetch: (async () => { calls += 1; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch, base: 'https://evil.example.test/client/v4', timeoutMs: 1000 },
      TOKEN, { method: 'GET', path: '/accounts/abc/workers/services/writeflex-sharing' }, (result) => result ?? null,
    )
    expect(calls).toBe(0)
    expect(answer).toMatchObject({ kind: 'unreachable', http: null, codes: [], result: null, failure: 'base', stage: 'connect' })
    expect(answeredInNumbers(answer)).toBe('Cloudflare could not be reached or did not answer in time (base)')
    expectNothingLeaks(answer)
  })

  test('a path containing ".." gives failure "path", and nothing is fetched', async () => {
    let calls = 0
    const answer = await send(
      port(async () => { calls += 1; return new Response('{}', { status: 200 }) }),
      TOKEN, { method: 'GET', path: '/accounts/abc/../workers' }, (result) => result ?? null,
    )
    expect(calls).toBe(0)
    expect(answer).toMatchObject({ kind: 'unreachable', http: null, codes: [], result: null, failure: 'path', stage: 'connect' })
    expect(answeredInNumbers(answer)).toBe('Cloudflare could not be reached or did not answer in time (path)')
    expectNothingLeaks(answer)
  })
})
