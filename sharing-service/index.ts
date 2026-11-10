// The WriteFlex sharing service: the entry Worker. WriteFlex installs it on the user's own
// Cloudflare account from the bundle built at app build time (scripts/build-sharing-service.ts).
//
// Readers (no credential of any kind):
//   GET  /s/<id>                       the reader page, or the "turned off" page
//   GET  /s/<id>/images/<name>         an image the published text uses, or the "turned off" page
//   GET  /version                      {service, build}: lets the app offer Update
//   POST /s/<id>/notes                 a note or proposed edit (reader-notes.ts)
//   POST /s/<id>/notes/mine            the reader's own notes, found by the reader's secret
// The reader-note routes answer POST only, with a JSON body from this same site; anything else
// sent to them, GET included, gets the "turned off" page and changes nothing. The author's HTML is
// not sanitised and can make same-origin GET requests (an <img>), so no GET may act.
// The author's app:
//   POST /shares                       admin key → 201 {shareId, ownerToken, readerPath, imagePath}
//   POST /shares/list                  admin key → discover portable workspace link records
//   POST /shares/<id>/owner-token     admin key → mint this Mac's share-scoped owner token
//   GET/PUT /shares/<id>/record       owner token → read/backfill record; conditional rename
//   POST /shares/<id>/settings        owner token → comments on/off and private/open mode
//   POST /shares/<id>/notes/state     owner token → retained items, receipts and per-Mac claims
//   POST /shares/<id>/notes/claim     owner token → claim/release an edit, audited manual release
//   GET  /shares/<id>                  owner token → the share's state
//   PUT  /shares/<id>/images/<name>    owner token → store one image (raw bytes)
//   PUT  /shares/<id>/page             owner token → publish the text (JSON, share-protocol.ts)
//   DELETE /shares/<id>/images/staged  owner token → delete images sent but named by no publish
//   POST /shares/<id>/off              owner token → delete the published copy and its images
//   POST /shares/<id>/on               owner token → the same address works again on next publish
//   GET  /shares/<id>/notes            owner token → notes not collected yet, and what was refused
//   POST /shares/<id>/notes/collected  owner token → mark notes collected ({keys}); says so twice: no change
//   POST /shares/<id>/notes/outcomes   owner token → outcomes and replies on collected notes (note-outcomes.ts)
// Anything else, by any method, gets the "turned off" page: one answer for every address that
// does not lead to a published page (reader-page.ts, linkOffResponse).
//
// Owner and admin checks happen here, before a body is read and before any share object is asked,
// so a request without the right token cannot tell a share that exists from one that does not.
// A refused request's body is never held: it is read to its end and thrown away (drainBody), as
// the Workers runtime drops the connection when it answers before the body has been sent, and
// the client would then see no refusal at all.
import { bearer, matchAdminKey } from './admin-keys.ts'
import { createOwnerToken, verifyOwnerToken, hashSecret } from './auth.ts'
import { drainBody, errorResponse, jsonResponse, readBoundedBytes, registryStub, shareStub, type Env } from './http.ts'
import { NOTE_LIMITS, NoteProtocolError, networkOf, parseReaderRequest, readerKeyOf } from './reader-notes.ts'
import { OUTCOME_LIMITS } from './note-outcomes.ts'
import { READER_PATH_PREFIX, imageResponse, linkOffResponse, readerPageResponse } from './reader-page.ts'
import { SHARE_LIMITS, parseImageName } from './share-protocol.ts'
import { parseLinkRecord } from './share-record-protocol.ts'
import { SHARE_ID_SOURCE, generateShareId, isShareId } from './share-id.ts'
import { SigningKeyUnavailable, signingKey } from './signing-key.ts'
import { SHARING_SERVICE_BUILD, SHARING_SERVICE_NAME } from './version.ts'

export { SharedPiece } from './shared-piece.ts'
export { SharingRegistry } from './signing-key.ts'

const IMAGE_NAME_SOURCE = '[0-9a-f]{64}\\.[a-z]{3,4}'
const READER_ROUTE = new RegExp(`^/s/(${SHARE_ID_SOURCE})(?:/|/images/(${IMAGE_NAME_SOURCE}))?$`)
const READER_CONTENT_ROUTE = new RegExp(`^/s/(${SHARE_ID_SOURCE})/content$`)
const READER_NOTES_ROUTE = new RegExp(`^/s/(${SHARE_ID_SOURCE})/notes(/mine|/visible)?$`)
const OWNER_ROUTE = new RegExp(`^/shares/(${SHARE_ID_SOURCE})(?:/(page|record|settings|people|off|on|notes|notes/state|notes/claim|notes/collected|notes/clear|notes/raise|notes/outcomes|images/staged)|/images/(${IMAGE_NAME_SOURCE}))?$`)
/** The author's "notes collected" list, in bytes. */
const COLLECT_BODY_BYTES = 64 * 1024

type OwnerAction = 'status' | 'publish' | 'image' | 'off' | 'on' | 'notes' | 'collected' | 'clear' | 'raise' | 'outcomes' | 'staged' | 'settings' | 'record' | 'note-state' | 'claim' | 'people'

function ownerAction(method: string, action: string | undefined, imageName: string | undefined): OwnerAction | null {
  if (imageName !== undefined) return method === 'PUT' ? 'image' : null
  if (action === undefined) return method === 'GET' ? 'status' : null
  if (action === 'people') return method === 'GET' || method === 'POST' ? 'people' : null
  if (action === 'record') return method === 'PUT' || method === 'GET' ? 'record' : null
  if (action === 'notes/state') return method === 'POST' ? 'note-state' : null
  if (action === 'notes/claim') return method === 'POST' ? 'claim' : null
  if (action === 'settings') return method === 'POST' ? 'settings' : null
  if (action === 'page') return method === 'PUT' ? 'publish' : null
  if (action === 'notes') return method === 'GET' ? 'notes' : null
  if (action === 'notes/collected') return method === 'POST' ? 'collected' : null
  if (action === 'notes/clear') return method === 'POST' ? 'clear' : null
  if (action === 'notes/raise') return method === 'POST' ? 'raise' : null
  if (action === 'notes/outcomes') return method === 'POST' ? 'outcomes' : null
  if (action === 'images/staged') return method === 'DELETE' ? 'staged' : null
  return method === 'POST' ? action as 'off' | 'on' : null
}

/**
 * A request the reader page's own script could have made: JSON, and, when the browser says where it
 * came from, from this same site. A form or a page on another site cannot send that without asking
 * first (CORS), and the service never says yes.
 */
function fromReaderPage(request: Request, url: URL): boolean {
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') return false
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== url.origin) return false
  const site = request.headers.get('sec-fetch-site')
  return site === null || site === 'same-origin'
}

/** `POST /s/<id>/notes` and `/notes/mine`: checked here; the share object sees only the secret's digest. */
async function readerNotesRoute(request: Request, env: Env, url: URL, shareId: string, read: string | undefined): Promise<Response> {
  if (!fromReaderPage(request, url)) {
    await drainBody(request)
    return linkOffResponse(request.method)
  }
  const bytes = await readBoundedBytes(request, NOTE_LIMITS.requestBytes)
  if (!bytes) return errorResponse('body_too_large', `A comment may be at most ${NOTE_LIMITS.requestBytes} bytes.`, 413, { limit: NOTE_LIMITS.requestBytes })
  const mine = read !== undefined
  let parsed: ReturnType<typeof parseReaderRequest>
  try {
    parsed = parseReaderRequest(bytes, !mine)
  } catch (error) {
    if (error instanceof NoteProtocolError) return errorResponse(error.code, error.message, 400)
    throw error
  }
  const readerKey = Object.hasOwn(parsed, 'person') ? undefined : await readerKeyOf(shareId, parsed.secret)
  const identity = { readerKey, ...(Object.hasOwn(parsed, 'person') ? { person: parsed.person } : {}), loadId: parsed.loadId }
  const answer = await shareStub(env, shareId).fetch(internal(read === '/visible' ? 'notes/visible' : mine ? 'notes/mine' : 'notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The reader's network, for the share's per-network limits; the share keeps only an HMAC of it.
    body: JSON.stringify(mine ? identity : { ...identity, network: networkOf(request.headers.get('cf-connecting-ip')), note: parsed.note }),
  }))
  if (answer.status === 404) {
    await answer.body?.cancel().catch(() => {})
    return linkOffResponse(request.method)
  }
  return answer
}

/** Read the stored publication without page/read's opening counter. */
async function readerContentRoute(request: Request, env: Env, url: URL, shareId: string): Promise<Response> {
  if (!fromReaderPage(request, url)) { await drainBody(request); return linkOffResponse(request.method) }
  const bytes = await readBoundedBytes(request, NOTE_LIMITS.requestBytes)
  if (!bytes) return errorResponse('body_too_large', 'The request is too large.', 413)
  let parsed: ReturnType<typeof parseReaderRequest>
  try { parsed = parseReaderRequest(bytes, false) } catch (error) {
    if (error instanceof NoteProtocolError) return errorResponse(error.code, error.message, 400)
    throw error
  }
  const stored = await shareStub(env, shareId).fetch(internal('content', { method: 'POST', body: JSON.stringify({ ...(Object.hasOwn(parsed, 'person') ? { person: parsed.person } : {}), loadId: parsed.loadId }) }))
  if (!stored.ok) { await stored.body?.cancel().catch(() => {}); return linkOffResponse(request.method) }
  return stored
}

function internal(path: string, init: RequestInit = {}): Request {
  return new Request(`https://internal/${path}`, init)
}

/** The reader's side: a page or an image, or the one "turned off" answer. */
async function readerRoute(request: Request, env: Env, shareId: string, imageName: string | undefined): Promise<Response> {
  const method = request.method
  if (imageName !== undefined) {
    const parsed = parseImageName(imageName)
    if (!parsed) return linkOffResponse(method)
    const stored = await shareStub(env, shareId).fetch(internal(`image/${imageName}`))
    if (stored.status !== 200) {
      await stored.body?.cancel().catch(() => {})
      return linkOffResponse(method)
    }
    return imageResponse(new Uint8Array(await stored.arrayBuffer()), parsed.contentType, method)
  }
  // A reader's GET counts one opening; a HEAD reads the page without counting.
  const stored = await shareStub(env, shareId).fetch(internal(method === 'GET' ? 'page/read' : 'page'))
  if (stored.status !== 200) {
    await stored.body?.cancel().catch(() => {})
    return linkOffResponse(method)
  }
  return readerPageResponse(await stored.text(), method)
}

/** `POST /shares` (admin key): make a share and hand out its owner token, once. */
async function createShare(request: Request, env: Env): Promise<Response> {
  await drainBody(request)
  if (!await matchAdminKey(bearer(request), env)) return errorResponse('admin_auth_required', 'Admin authentication is required.', 401)
  // Before anything is made: a share whose token could not be signed is never left behind.
  const key = await signingKey(env)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const shareId = generateShareId()
    const made = await shareStub(env, shareId).fetch(internal('init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareId, createdAt: Date.now() }),
    }))
    if (made.status === 409) continue
    if (!made.ok) return errorResponse('share_not_made', 'The share could not be made. Try again.', 503)
    const ownerToken = await createOwnerToken({ role: 'share-owner', shareId, iat: Date.now() }, key)
    return jsonResponse({ shareId, ownerToken, readerPath: `${READER_PATH_PREFIX}${shareId}`, imagePath: `${READER_PATH_PREFIX}${shareId}/images/` }, 201)
  }
  return errorResponse('share_id_exhausted', 'Could not find a free share id. Try again.', 503)
}

/** Admin authority is per account; the response never passes through a reader route. */
async function adminShares(request: Request, env: Env, shareId?: string): Promise<Response> {
  const computerId = await matchAdminKey(bearer(request), env)
  if (!computerId) { await drainBody(request); return errorResponse('admin_auth_required', 'Admin authentication is required.', 401) }
  if (shareId) {
    await drainBody(request)
    const key = await signingKey(env)
    const audit = await shareStub(env, shareId).fetch(internal('owner-token', { method: 'POST', body: JSON.stringify({ computerId }) }))
    if (!audit.ok) return audit
    const ownerToken = await createOwnerToken({ role: 'share-owner', shareId, iat: Date.now(), computerId, nonce: crypto.randomUUID() }, key)
    return jsonResponse({ shareId, ownerToken })
  }
  const bytes = await readBoundedBytes(request, 16 * 1024)
  if (!bytes) return errorResponse('body_too_large', 'The workspace list is too large.', 413)
  const answer = await registryStub(env).fetch(new Request('https://internal/internal/share-directory/list', { method: 'POST', body: bytes as Uint8Array<ArrayBuffer> }))
  if (!answer.ok) return answer
  const { workspace, ids } = await answer.json() as { workspace: unknown; ids: string[] }
  const records: unknown[] = []
  // Bounded concurrency, with records always read from their authoritative share object.
  for (let at = 0; at < ids.length; at += 8) {
    const batch = await Promise.all(ids.slice(at, at + 8).map(async (id) => {
      const r = await shareStub(env, id).fetch(internal('record'))
      return r.ok ? { ...await r.json() as object, workspace } : null
    }))
    records.push(...batch.filter((r) => r !== null))
  }
  return jsonResponse({ workspace, records })
}

/** The author's routes on one share: the owner token first, then the body (bounded), then the object. */
async function ownerRoute(request: Request, env: Env, shareId: string, action: OwnerAction, imageName: string | undefined): Promise<Response> {
  const token = bearer(request)
  const owner = await verifyOwnerToken(token, await signingKey(env), shareId)
  if (!owner) {
    await drainBody(request)
    return errorResponse('owner_auth_required', 'Owner authentication is required.', 401)
  }
  // This identity comes only from a verified token, never the request body or an incoming header.
  const computer = owner.computerId ?? `legacy-${await hashSecret(token!)}`
  const ownerHeaders = { 'content-type': 'application/json', 'x-sharing-computer': computer }
  const stub = shareStub(env, shareId)
  if (action === 'record') {
    if (request.method === 'GET') return stub.fetch(internal('record'))
    const bytes = await readBoundedBytes(request, 256 * 1024)
    if (!bytes) return errorResponse('body_too_large', 'The link record is too large.', 413)
    let value: unknown
    try { value = JSON.parse(new TextDecoder().decode(bytes)) } catch { return errorResponse('invalid_record', 'The link record is not JSON.', 400) }
    const envelope = value as { record?: unknown; baseRecord?: unknown } | null
    const conditional = envelope && Object.hasOwn(envelope, 'baseRecord')
    const record = parseLinkRecord(conditional ? envelope.record : value)
    const baseRecord = conditional ? parseLinkRecord(envelope.baseRecord) : null
    if (!record) return errorResponse('invalid_record', 'The link record is invalid.', 400)
    if (conditional && !baseRecord) return errorResponse('invalid_record', 'The base record is invalid.', 400)
    const kept = await stub.fetch(internal('record', { method: 'PUT', body: JSON.stringify(conditional ? { record, baseRecord } : record) }))
    if (!kept.ok) return kept
    const registered = await registryStub(env).fetch(new Request('https://internal/internal/share-directory/register', { method: 'POST', body: JSON.stringify({ shareId, workspace: record.workspace }) }))
    if (!registered.ok) return registered
    return kept
  }
  if (action === 'note-state' || action === 'claim') {
    const bytes = await readBoundedBytes(request, 1024)
    if (!bytes) return errorResponse('body_too_large', 'The item request is too large.', 413)
    return stub.fetch(internal(action === 'claim' ? 'notes/claim' : 'notes/state', { method: 'POST', headers: ownerHeaders, body: bytes as Uint8Array<ArrayBuffer> }))
  }
  if (action === 'people') {
    const body = request.method === 'GET' ? undefined : await readBoundedBytes(request, 2048)
    if (body === null) return errorResponse('body_too_large', 'The person request is too large.', 413)
    return stub.fetch(internal('people', { method: request.method, body: body as Uint8Array<ArrayBuffer> | undefined }))
  }
  if (action === 'settings') {
    const body = await readBoundedBytes(request, 1024)
    if (!body) return errorResponse('body_too_large', 'Settings are too large.', 413)
    return stub.fetch(internal('settings', { method: 'POST', body: body as Uint8Array<ArrayBuffer> }))
  }
  if (action === 'status') return stub.fetch(internal('status'))
  if (action === 'notes') return stub.fetch(internal('notes/waiting'))
  if (action === 'collected' || action === 'clear') {
    const body = await readBoundedBytes(request, COLLECT_BODY_BYTES)
    if (!body) return errorResponse('body_too_large', `The list may be at most ${COLLECT_BODY_BYTES} bytes.`, 413, { limit: COLLECT_BODY_BYTES })
    return stub.fetch(internal(action === 'clear' ? 'notes/clear' : 'notes/collected', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body as Uint8Array<ArrayBuffer> }))
  }
  if (action === 'outcomes') {
    const body = await readBoundedBytes(request, OUTCOME_LIMITS.requestBytes)
    if (!body) return errorResponse('body_too_large', `The outcomes may be at most ${OUTCOME_LIMITS.requestBytes} bytes.`, 413, { limit: OUTCOME_LIMITS.requestBytes })
    return stub.fetch(internal('notes/outcomes', { method: 'POST', headers: ownerHeaders, body: body as Uint8Array<ArrayBuffer> }))
  }
  if (action === 'raise') {
    await drainBody(request)
    return stub.fetch(internal('notes/raise', { method: 'POST' }))
  }
  if (action === 'off' || action === 'on') {
    await drainBody(request)
    return stub.fetch(internal(action, { method: 'POST' }))
  }
  if (action === 'staged') {
    await drainBody(request)
    return stub.fetch(internal('images/staged', { method: 'DELETE' }))
  }
  const limit = action === 'publish' ? SHARE_LIMITS.publishBodyBytes : SHARE_LIMITS.imageBytes
  const bytes = await readBoundedBytes(request, limit)
  if (!bytes) {
    const what = action === 'publish' ? 'The text' : 'An image'
    return errorResponse('body_too_large', `${what} may be at most ${limit} bytes.`, 413, { limit })
  }
  const path = action === 'publish' ? 'page' : `image/${imageName}`
  return stub.fetch(internal(path, { method: 'PUT', body: bytes as Uint8Array<ArrayBuffer> }))
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const method = request.method
  const reading = method === 'GET' || method === 'HEAD'

  if (reading) {
    const reader = READER_ROUTE.exec(url.pathname)
    if (reader) return readerRoute(request, env, reader[1], reader[2])
    if (url.pathname === '/version') return jsonResponse({ service: SHARING_SERVICE_NAME, build: SHARING_SERVICE_BUILD })
  }
  if (method === 'POST') {
    const content = READER_CONTENT_ROUTE.exec(url.pathname)
    if (content) return readerContentRoute(request, env, url, content[1])
    const notes = READER_NOTES_ROUTE.exec(url.pathname)
    if (notes) return readerNotesRoute(request, env, url, notes[1], notes[2])
  }
  if (url.pathname === '/shares/list' && method === 'POST') return adminShares(request, env)
  const mint = new RegExp(`^/shares/(${SHARE_ID_SOURCE})/owner-token$`).exec(url.pathname)
  if (mint && method === 'POST') return adminShares(request, env, mint[1])
  if (url.pathname === '/shares' && method === 'POST') return createShare(request, env)
  const owner = OWNER_ROUTE.exec(url.pathname)
  if (owner && isShareId(owner[1])) {
    const action = ownerAction(method, owner[2], owner[3])
    if (action) return ownerRoute(request, env, owner[1], action, owner[3])
  }
  await drainBody(request)
  return linkOffResponse(method)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env)
    } catch (error) {
      // The error's name only: storage errors are not trusted to leave stored values out of their text.
      console.error('[sharing] request failed:', error instanceof Error ? error.name : 'error')
      if (error instanceof SigningKeyUnavailable) return errorResponse('signing_key_unavailable', error.message, 503)
      return errorResponse('service_error', 'The sharing service could not answer. Try again in a moment.', 503)
    }
  },
}
