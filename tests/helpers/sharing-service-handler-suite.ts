// The sharing service's request handlers, end to end through the entry Worker with in-memory
// Durable Objects (sharing-service-runtime.ts).
// Run against the sources (tests/main/sharing-service-handlers.test.ts) and against the built
// bundle (tests/main/sharing-service-bundle.test.ts), so what ships is what was tested.
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { SHARE_ID_LENGTH, generateShareId } from '../../sharing-service/share-id.ts'
import { SHARING_SERVICE_BUILD } from '../../sharing-service/version.ts'
import { runSharingServiceNotesSuite } from './sharing-service-notes-suite.ts'
import { runSharingServiceOutcomesSuite } from './sharing-service-outcomes-suite.ts'
import { ADMIN_KEY, fakeService, tablesOf, type ServiceModule } from './sharing-service-runtime.ts'

const SAVED_AT = Date.UTC(2026, 9, 14, 8, 12) // 09:12 in London (BST)

function pieceBody(revision: number, extra: Record<string, unknown> = {}) {
  return {
    revision,
    savedAt: SAVED_AT,
    timeZone: 'Europe/London',
    sharedBy: 'Ada',
    kind: 'piece',
    title: 'What a reading list is for',
    chips: [{ label: 'Date', value: '12 October 2026' }, { label: 'Status', value: 'draft' }],
    parts: [{ html: `<p class="wf-paragraph">Revision ${revision}: most reading lists are written as if the reader will finish them.</p>` }],
    images: [],
    ...extra,
  }
}

function imageOf(text: string, ext = 'png') {
  const bytes = new TextEncoder().encode(text)
  return { bytes, name: `${createHash('sha256').update(bytes).digest('hex')}.${ext}` }
}

async function setUp(module: ServiceModule) {
  const svc = fakeService(module)
  const made = await svc.call('/shares', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_KEY}` } })
  expect(made.status).toBe(201)
  const { shareId, ownerToken, readerPath, imagePath } = await made.json() as { shareId: string; ownerToken: string; readerPath: string; imagePath: string }
  const owner = (path: string, init: RequestInit = {}) => svc.call(`/shares/${shareId}${path}`, { ...init, headers: { authorization: `Bearer ${ownerToken}`, ...(init.headers ?? {}) } })
  const publish = (body: unknown, token = ownerToken) => svc.call(`/shares/${shareId}/page`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { ...svc, shareId, ownerToken, readerPath, imagePath, owner, publish }
}

/** DELETE /shares/<id>/images/staged with the given bearer. */
function svcDelete(s: Awaited<ReturnType<typeof setUp>>, token: string) {
  return s.call(`/shares/${s.shareId}/images/staged`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
}

/** Everything a reader's browser gets: status, every header, the body's bytes. */
async function snapshot(response: Response) {
  const headers = [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b))
  return { status: response.status, statusText: response.statusText, headers, body: [...new Uint8Array(await response.arrayBuffer())] }
}

export function runSharingServiceHandlerSuite(label: string, module: () => Promise<ServiceModule>) {
  runSharingServiceNotesSuite(label, module)
  runSharingServiceOutcomesSuite(label, module)
  describe(`${label}: making a share`, () => {
    test('needs an admin key; any other bearer is refused the same way', async () => {
      const svc = fakeService(await module(), { ADMIN_SECRET: 'legacy-name-is-not-a-key', ADMIN_SECRET_bad_name: 'not-a-key-either' })
      const refusals = await Promise.all([
        svc.call('/shares', { method: 'POST' }),
        svc.call('/shares', { method: 'POST', headers: { authorization: 'Bearer wrong' } }),
        svc.call('/shares', { method: 'POST', headers: { authorization: 'Bearer legacy-name-is-not-a-key' } }),
        svc.call('/shares', { method: 'POST', headers: { authorization: 'Bearer not-a-key-either' } }),
        svc.call('/shares', { method: 'POST', headers: { authorization: ADMIN_KEY } }),
      ])
      for (const response of refusals) {
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: { code: 'admin_auth_required', message: 'Admin authentication is required.' } })
      }
      expect(svc.shares.received).toEqual([])
    })

    test('hands out a long address and an owner token, once', async () => {
      const { shareId, ownerToken, readerPath, imagePath } = await setUp(await module())
      expect(shareId).toMatch(new RegExp(`^[A-Za-z0-9]{${SHARE_ID_LENGTH}}$`))
      expect(readerPath).toBe(`/s/${shareId}`)
      expect(imagePath).toBe(`/s/${shareId}/images/`)
      expect(ownerToken.split('.')).toHaveLength(2)
    })

    test('reports its build so the app can offer Update', async () => {
      const svc = fakeService(await module())
      const response = await svc.call('/version')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ service: 'writeflex-sharing', build: SHARING_SERVICE_BUILD })
    })
  })

  describe(`${label}: publishing needs the share's owner token`, () => {
    test('every unsigned or wrongly signed publish is refused before the share is asked, and the page is unchanged', async () => {
      const s = await setUp(await module())
      expect((await s.publish(pieceBody(1))).status).toBe(200)
      const before = await snapshot(await s.call(s.readerPath))
      const other = await s.call('/shares', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_KEY}` } }).then((r) => r.json()) as { ownerToken: string }
      const [payload, signature] = s.ownerToken.split('.')
      const decoded = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')))
      const reEncode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
      const forged = [
        null,                                                        // no Authorization header
        '',                                                          // empty bearer
        'garbage',
        ADMIN_KEY,                                                   // the admin key is not an owner token
        other.ownerToken,                                            // another share's token
        `${reEncode({ ...decoded, shareId: 'A'.repeat(22) })}.${signature}`,   // payload changed, old signature
        `${payload}.${signature.slice(0, -2)}AA`,                    // signature changed
        `${payload}.${signature}.extra`,
        `${reEncode({ ...decoded, role: 'owner' })}.${signature}`,
        s.shareId,                                                   // what the reader's address holds
      ]
      const requestsBefore = s.shares.received.length
      for (const token of forged) {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (token !== null) headers.authorization = `Bearer ${token}`
        const response = await s.call(`/shares/${s.shareId}/page`, { method: 'PUT', headers, body: JSON.stringify(pieceBody(2)) })
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: { code: 'owner_auth_required', message: 'Owner authentication is required.' } })
      }
      // Turning off, turning on, sending an image and reading the share's state are refused the same way.
      const image = imageOf('x')
      for (const [path, method] of [['/off', 'POST'], ['/on', 'POST'], [`/images/${image.name}`, 'PUT'], ['', 'GET']] as const) {
        const response = await s.call(`/shares/${s.shareId}${path}`, { method, headers: { authorization: `Bearer ${other.ownerToken}` }, body: method === 'PUT' ? image.bytes : undefined })
        expect(response.status).toBe(401)
        expect((await response.json()).error.code).toBe('owner_auth_required')
      }
      expect(s.shares.received.length).toBe(requestsBefore) // no refused request reached the share
      expect(await snapshot(await s.call(s.readerPath))).toEqual(before)
    })

    test('a refused or oversize request is answered after its body has been read to the end and thrown away', async () => {
      // The Workers runtime drops the connection when it answers before the body has arrived, and
      // the app would see no 401 or 413 (found with wrangler dev; scripts/smoke-sharing-service-workerd.ts).
      const mod = await module()
      const s = await setUp(mod)
      const requests = [
        new Request(`https://x/shares/${s.shareId}/page`, { method: 'PUT', body: JSON.stringify(pieceBody(1)) }),
        new Request(`https://x/shares/${s.shareId}/page`, { method: 'PUT', headers: { authorization: `Bearer ${s.ownerToken}` }, body: new Uint8Array(16 * 1024 * 1024 + 1) }),
        new Request('https://x/shares', { method: 'POST', body: 'x'.repeat(1000) }),
        new Request(`https://x/s/${s.shareId}`, { method: 'POST', body: 'x'.repeat(1000) }),
      ]
      const statuses = []
      for (const request of requests) {
        statuses.push((await mod.default.fetch(request, s.env)).status)
        expect(request.bodyUsed).toBe(true)
      }
      expect(statuses).toEqual([401, 413, 401, 404])
    })

    test('an owner request for an address that was never made is refused exactly like a wrong token', async () => {
      const s = await setUp(await module())
      const unknown = generateShareId()
      const a = await s.call(`/shares/${unknown}/page`, { method: 'PUT', headers: { authorization: `Bearer ${s.ownerToken}` }, body: JSON.stringify(pieceBody(1)) })
      const b = await s.call(`/shares/${s.shareId}/page`, { method: 'PUT', headers: { authorization: 'Bearer wrong' }, body: JSON.stringify(pieceBody(1)) })
      expect(await snapshot(a)).toEqual(await snapshot(b))
    })

    test('the reader page holds no credential, and no script but its own, which the policy pins by hash', async () => {
      const s = await setUp(await module())
      for (const comments of [false, true]) {
        await s.publish(pieceBody(comments ? 2 : 1, { comments, parts: [{ html: '<p>Text.</p><script>alert(1)</script>' }] }))
        const response = await s.call(s.readerPath)
        const html = await response.text()
        const [payload, signature] = s.ownerToken.split('.')
        for (const secret of [s.ownerToken, payload, signature, ADMIN_KEY]) expect(html).not.toContain(secret)
        const registryState = s.registry.states.values().next().value!
        const signingKey = (registryState.db.query('SELECT key FROM signing_key').get() as { key: string }).key
        expect(html).not.toContain(signingKey)
        // The page's own script is the last thing in the body; the author's <script> is in the text,
        // and the policy lets only a script with the page script's hash run.
        const own = /<script>((?:(?!<script>)[\s\S])*)<\/script><\/body><\/html>$/.exec(html)
        expect(own).not.toBeNull()
        const digest = createHash('sha256').update(own![1]).digest('base64')
        const csp = response.headers.get('content-security-policy')!
        expect(csp).toContain(`script-src 'sha256-${digest}';`)
        expect(csp).toContain("connect-src 'self'")
        expect(own![1]).not.toMatch(/<\/script|token|authorization|innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/i)
        const rest = html.replace(own![0], '')
        expect(rest).not.toMatch(/<form|<iframe|token|authorization/i)
      }
    })
  })

  describe(`${label}: reading`, () => {
    test('a published piece is served at its address with the reader headers', async () => {
      const s = await setUp(await module())
      expect((await s.publish(pieceBody(1))).status).toBe(200)
      for (const path of [s.readerPath, `${s.readerPath}/`]) {
        const response = await s.call(path)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
        expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
        expect(response.headers.get('content-security-policy')).toMatch(/script-src 'sha256-[A-Za-z0-9+/]{43}=';/)
        const html = await response.text()
        expect(html).toContain('Revision 1: most reading lists')
        expect(html).toContain('Updated <time datetime="2026-10-14T08:12:00.000Z">14 October 2026, 09:12</time>')
      }
      const head = await s.call(s.readerPath, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
    })

    test('a later publish replaces the page; a stale or skipped revision is refused with the current one', async () => {
      const s = await setUp(await module())
      await s.publish(pieceBody(1))
      expect((await s.publish(pieceBody(2))).status).toBe(200)
      for (const revision of [2, 4]) {
        const conflict = await s.publish(pieceBody(revision))
        expect(conflict.status).toBe(409)
        expect(await conflict.json()).toMatchObject({ error: { code: 'revision_conflict' }, revision: 2 })
      }
      expect(await (await s.call(s.readerPath)).text()).toContain('Revision 2:')
    })

    test('a page larger than one stored chunk comes back exactly, surrogate pairs included', async () => {
      const s = await setUp(await module())
      const text = '😀 Ünïcode '.repeat(120_000)
      expect((await s.publish(pieceBody(1, { parts: [{ html: `<p>${text}</p>` }] }))).status).toBe(200)
      expect(await (await s.call(s.readerPath)).text()).toContain(`<p>${text}</p>`)
    })

    test('a publish that is not a valid share is refused and changes nothing', async () => {
      const s = await setUp(await module())
      await s.publish(pieceBody(1))
      for (const bad of [{ ...pieceBody(2), kind: 'pamphlet' }, { ...pieceBody(2), parts: [{ html: 'a' }, { html: 'b' }] }, { ...pieceBody(2), title: 'one\ntwo' }, { ...pieceBody(2), timeZone: 'Mars/Olympus' }]) {
        const response = await s.publish(bad)
        expect(response.status).toBe(400)
        expect((await response.json()).error.code).toBe('invalid_publish')
      }
      const notJson = await s.call(`/shares/${s.shareId}/page`, { method: 'PUT', headers: { authorization: `Bearer ${s.ownerToken}` }, body: '{' })
      expect(notJson.status).toBe(400)
      expect(await (await s.call(s.readerPath)).text()).toContain('Revision 1:')
    })

    test('an oversize publish is refused unread', async () => {
      const s = await setUp(await module())
      const response = await s.publish(pieceBody(1, { parts: [{ html: 'x'.repeat(16 * 1024 * 1024) }] }))
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({ error: { code: 'body_too_large' }, limit: 16 * 1024 * 1024 })
      expect(s.shares.received.filter((r) => r.path === '/page' && r.method === 'PUT')).toEqual([])
    })
  })

  describe(`${label}: images`, () => {
    test('are sent first, checked against their name, and served only once the text that uses them is published', async () => {
      const s = await setUp(await module())
      const image = imageOf('PNG bytes of a figure')
      const big = { bytes: new Uint8Array(2_500_000).map((_, i) => i % 251), name: '' }
      big.name = `${createHash('sha256').update(big.bytes).digest('hex')}.jpg`

      const wrongName = await s.owner(`/images/${'0'.repeat(64)}.png`, { method: 'PUT', body: image.bytes })
      expect(wrongName.status).toBe(400)
      expect((await wrongName.json()).error.code).toBe('image_digest_mismatch')

      const missing = await s.publish(pieceBody(1, { images: [image.name] }))
      expect(missing.status).toBe(409)
      expect(await missing.json()).toMatchObject({ error: { code: 'missing_images' }, missing: [image.name] })

      for (const each of [image, big]) expect((await s.owner(`/images/${each.name}`, { method: 'PUT', body: each.bytes })).status).toBe(200)
      expect(await (await s.owner(`/images/${image.name}`, { method: 'PUT', body: image.bytes })).json()).toEqual({ stored: image.name, already: true })
      // Sent but not yet published: not served.
      expect((await s.call(`${s.imagePath}${image.name}`)).status).toBe(404)

      const html = `<p><img class="wf-image" src="${s.imagePath}${image.name}" alt=""><img src="${s.imagePath}${big.name}" alt=""></p>`
      expect((await s.publish(pieceBody(1, { parts: [{ html }], images: [image.name, big.name] }))).status).toBe(200)
      const served = await s.call(`${s.imagePath}${image.name}`)
      expect(served.status).toBe(200)
      expect(served.headers.get('content-type')).toBe('image/png')
      expect(served.headers.get('content-security-policy')).toContain('sandbox')
      expect(served.headers.get('cache-control')).toBe('no-store')
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(image.bytes)
      const bigServed = await s.call(`${s.imagePath}${big.name}`)
      expect(bigServed.headers.get('content-type')).toBe('image/jpeg')
      expect(new Uint8Array(await bigServed.arrayBuffer())).toEqual(big.bytes)

      // The next text drops the big image: it is deleted with that publish.
      expect((await s.publish(pieceBody(2, { images: [image.name] }))).status).toBe(200)
      expect((await s.call(`${s.imagePath}${big.name}`)).status).toBe(404)
      const state = s.shares.states.get(s.shareId)!
      expect(state.db.query('SELECT name FROM images').all()).toEqual([{ name: image.name }])
    })

    test('an image over the size limit is refused unread', async () => {
      const s = await setUp(await module())
      const bytes = new Uint8Array(10 * 1024 * 1024 + 1)
      const response = await s.owner(`/images/${createHash('sha256').update(bytes).digest('hex')}.png`, { method: 'PUT', body: bytes })
      expect(response.status).toBe(413)
      expect((await response.json()).error.code).toBe('body_too_large')
    })
  })

  describe(`${label}: the image cap counts staged and published images apart`, () => {
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => imageOf(`${prefix} ${i}`))
    const send = (s: Awaited<ReturnType<typeof setUp>>, image: { name: string; bytes: Uint8Array }) => s.owner(`/images/${image.name}`, { method: 'PUT', body: image.bytes })
    const big = (seed: number) => {
      const bytes = new Uint8Array(9.5 * 1024 * 1024).map((_, i) => (i * 7 + seed) % 253)
      return { bytes, name: `${createHash('sha256').update(bytes).digest('hex')}.png` }
    }

    test('500 published and 500 staged are held together; the 501st staged is refused', async () => {
      const s = await setUp(await module())
      const published = many('published', 500)
      for (const image of published) expect((await send(s, image)).status).toBe(200)
      expect((await s.publish(pieceBody(1, { images: published.map((image) => image.name) }))).status).toBe(200)
      const staged = many('staged', 500)
      for (const image of staged) expect((await send(s, image)).status).toBe(200)
      expect(await (await s.owner('')).json()).toMatchObject({ images: 1000, staged: 500 })
      const over = await send(s, imageOf('one too many'))
      expect(over.status).toBe(413)
      expect(await over.json()).toMatchObject({ error: { code: 'share_images_full' }, limit: 500, count: 500 })
      // A picture already held answers "already", full or not.
      expect(await (await send(s, staged[0])).json()).toEqual({ stored: staged[0].name, already: true })
      // The new copy replaces the old one in one page PUT.
      expect((await s.publish(pieceBody(2, { images: staged.map((image) => image.name) }))).status).toBe(200)
      expect(await (await s.owner('')).json()).toMatchObject({ revision: 2, images: 500, staged: 0, stagedBytes: 0 })
      expect((await s.call(`${s.imagePath}${staged[499].name}`)).status).toBe(200)
      expect((await s.call(`${s.imagePath}${published[0].name}`)).status).toBe(404)
    })

    test('a page naming more than 64 MiB of images is refused and nothing changes', async () => {
      const s = await setUp(await module())
      const first = [0, 1, 2, 3].map(big)
      for (const image of first) expect((await send(s, image)).status).toBe(200)
      expect((await s.publish(pieceBody(1, { images: first.map((image) => image.name) }))).status).toBe(200)
      const more = [4, 5, 6].map(big)
      for (const image of more) expect((await send(s, image)).status).toBe(200)
      // The page first: a reader's GET counts an opening, which is not what this test compares.
      const page = await (await s.call(s.readerPath)).text()
      const before = await (await s.owner('')).json()
      const state = s.shares.states.get(s.shareId)!
      const rows = state.db.query('SELECT name, published FROM images ORDER BY name').all()

      const all = [...first, ...more].map((image) => image.name)
      const refused = await s.publish(pieceBody(2, { images: all }))
      expect(refused.status).toBe(413)
      expect(await refused.json()).toMatchObject({ error: { code: 'share_images_full' }, limit: 64 * 1024 * 1024, size: 7 * 9.5 * 1024 * 1024 })
      expect(await (await s.owner('')).json()).toEqual(before)
      expect(before).toMatchObject({ revision: 1, staged: 3, stagedBytes: 3 * 9.5 * 1024 * 1024 })
      expect(await (await s.call(s.readerPath)).text()).toBe(page)
      expect(state.db.query('SELECT name, published FROM images ORDER BY name').all()).toEqual(rows)
      // Exactly 64 MiB or under is published.
      expect((await s.publish(pieceBody(2, { images: all.slice(0, 6) }))).status).toBe(200)
    })

    test('deleting the staged images leaves the published copy and its images', async () => {
      const s = await setUp(await module())
      const published = many('published', 3)
      for (const image of published) await send(s, image)
      expect((await s.publish(pieceBody(1, { images: published.map((image) => image.name) }))).status).toBe(200)
      const page = await (await s.call(s.readerPath)).text()
      const staged = many('staged', 4)
      for (const image of staged) await send(s, image)

      expect((await svcDelete(s, 'not-the-owner-token')).status).toBe(401)
      expect(await (await s.owner('')).json()).toMatchObject({ images: 7, staged: 4 })

      const deleted = await svcDelete(s, s.ownerToken)
      expect(deleted.status).toBe(200)
      expect(await deleted.json()).toEqual({ deleted: 4 })
      expect(await (await s.owner('')).json()).toMatchObject({ revision: 1, images: 3, staged: 0, stagedBytes: 0 })
      expect(await (await s.call(s.readerPath)).text()).toBe(page)
      for (const image of published) expect((await s.call(`${s.imagePath}${image.name}`)).status).toBe(200)
      const state = s.shares.states.get(s.shareId)!
      expect(state.db.query('SELECT COUNT(DISTINCT name) AS n FROM image_chunks').get()).toEqual({ n: 3 })
      // Nothing staged: deletes nothing.
      expect(await (await svcDelete(s, s.ownerToken)).json()).toEqual({ deleted: 0 })
      // Only DELETE acts there.
      expect((await s.owner('/images/staged')).status).toBe(404)
      expect(await (await s.owner('')).json()).toMatchObject({ images: 3 })
    })

    test('turning the link off deletes the published and the staged images', async () => {
      const s = await setUp(await module())
      const published = imageOf('published')
      const staged = imageOf('staged')
      await send(s, published)
      await s.publish(pieceBody(1, { images: [published.name] }))
      await send(s, staged)
      expect(await (await s.owner('')).json()).toMatchObject({ images: 2, staged: 1 })
      expect((await s.owner('/off', { method: 'POST' })).status).toBe(200)
      const state = s.shares.states.get(s.shareId)!
      for (const table of ['images', 'image_chunks']) expect(state.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
      expect(await (await s.owner('')).json()).toMatchObject({ images: 0, staged: 0 })
    })
  })

  describe(`${label}: turning a link off and on`, () => {
    test('off deletes the published copy and its images; on keeps the address, which works again on the next publish', async () => {
      const s = await setUp(await module())
      const image = imageOf('figure')
      await s.owner(`/images/${image.name}`, { method: 'PUT', body: image.bytes })
      await s.publish(pieceBody(1, { images: [image.name] }))
      expect((await s.call(s.readerPath)).status).toBe(200)

      const off = await s.owner('/off', { method: 'POST' })
      expect(await off.json()).toEqual({ status: 'off', revision: 1 })
      const state = s.shares.states.get(s.shareId)!
      for (const table of ['page_chunks', 'images', 'image_chunks']) {
        expect(state.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
      }
      expect((await s.call(s.readerPath)).status).toBe(404)
      expect((await s.call(`${s.imagePath}${image.name}`)).status).toBe(404)
      expect(await (await s.owner('')).json()).toMatchObject({ status: 'off', revision: 1, publishedAt: null, images: 0 })

      // While off, nothing can be published to it.
      const refused = await s.publish(pieceBody(2))
      expect(refused.status).toBe(409)
      expect((await refused.json()).error.code).toBe('share_off')
      expect((await s.owner(`/images/${image.name}`, { method: 'PUT', body: image.bytes })).status).toBe(409)

      expect(await (await s.owner('/on', { method: 'POST' })).json()).toEqual({ status: 'on', revision: 1 })
      // The copy was deleted, so the image has to be sent again.
      expect((await s.publish(pieceBody(2, { images: [image.name] }))).status).toBe(409)
      await s.owner(`/images/${image.name}`, { method: 'PUT', body: image.bytes })
      expect((await s.publish(pieceBody(2, { images: [image.name] }))).status).toBe(200)
      const back = await s.call(s.readerPath)
      expect(back.status).toBe(200)
      expect(await back.text()).toContain('Revision 2:')
      expect((await s.call(`${s.imagePath}${image.name}`)).status).toBe(200)
    })
  })

  // How many times the page was opened: the Shares list's Opened column.
  describe(`${label}: openings`, () => {
    test('each reader GET of the page counts one; HEAD, images, the link-off page and the owner\'s reads count nothing; kept across off and on', async () => {
      const s = await setUp(await module())
      const opened = async (): Promise<unknown> => ((await (await s.owner('')).json()) as { opened?: unknown }).opened
      // Nothing published yet: the link-off page, not counted.
      expect((await s.call(s.readerPath)).status).toBe(404)
      expect(await opened()).toBe(0)
      const image = imageOf('figure')
      await s.owner(`/images/${image.name}`, { method: 'PUT', body: image.bytes })
      expect((await s.publish(pieceBody(1, { images: [image.name] }))).status).toBe(200)
      expect(await opened()).toBe(0)

      expect((await s.call(s.readerPath)).status).toBe(200)
      expect((await s.call(`${s.readerPath}/`)).status).toBe(200)
      expect(await opened()).toBe(2)
      // A HEAD and an image are not an opening; nor is the owner's own status read (asked three times above).
      expect((await s.call(s.readerPath, { method: 'HEAD' })).status).toBe(200)
      expect((await s.call(`${s.imagePath}${image.name}`)).status).toBe(200)
      expect(await opened()).toBe(2)

      // Off: readers get the link-off page, which counts nothing; the count is kept and goes on after on.
      await s.owner('/off', { method: 'POST' })
      expect((await s.call(s.readerPath)).status).toBe(404)
      expect(await opened()).toBe(2)
      await s.owner('/on', { method: 'POST' })
      expect((await s.publish(pieceBody(2))).status).toBe(200)
      expect((await s.call(s.readerPath)).status).toBe(200)
      expect(await opened()).toBe(3)
    })

    test('the count needs the share\'s owner token, and keeps nothing about the reader', async () => {
      const s = await setUp(await module())
      await s.publish(pieceBody(1))
      await s.call(s.readerPath, { headers: { 'user-agent': 'READER_AGENT_CANARY', 'cf-connecting-ip': '203.0.113.77' } })
      expect((await s.call(`/shares/${s.shareId}`)).status).toBe(401)
      expect((await s.call(`/shares/${s.shareId}`, { headers: { authorization: `Bearer ${ADMIN_KEY}` } })).status).toBe(401)
      const state = s.shares.states.get(s.shareId)!
      expect(state.db.query('SELECT opened FROM share WHERE id = 1').get()).toEqual({ opened: 1 })
      for (const table of tablesOf(state)) {
        const rows = JSON.stringify(state.db.query(`SELECT * FROM ${table}`).all())
        expect(rows).not.toContain('READER_AGENT_CANARY')
        expect(rows).not.toContain('203.0.113.77')
      }
    })
  })

  describe(`${label}: an unknown address and a turned-off address answer identically`, () => {
    test('byte for byte: status, every header and the body, for GET and for HEAD', async () => {
      const s = await setUp(await module())
      const image = imageOf('figure')
      await s.owner(`/images/${image.name}`, { method: 'PUT', body: image.bytes })
      await s.publish(pieceBody(1, { images: [image.name] }))
      const neverPublished = await s.call('/shares', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_KEY}` } }).then((r) => r.json()) as { shareId: string }
      await s.owner('/off', { method: 'POST' })
      const unknown = generateShareId()

      const paths = [
        s.readerPath,                                  // turned off
        `${s.readerPath}/`,
        `${s.imagePath}${image.name}`,                 // an image of a turned-off link
        `/s/${unknown}`,                               // never existed
        `/s/${unknown}/images/${image.name}`,
        `/s/${s.shareId.slice(0, -1)}`,                // mistyped: one character short
        `/s/${s.shareId}x`,                            // mistyped: one character too many
        `/s/${neverPublished.shareId}`,                // made, nothing published yet
        '/',
        '/s/',
        '/anything/else',
        `/shares/${s.shareId}/nothing`,                // not a route at all
      ]
      for (const method of ['GET', 'HEAD']) {
        const answers = await Promise.all(paths.map(async (path) => snapshot(await s.call(path, { method }))))
        for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0])
        expect(answers[0].status).toBe(404)
        if (method === 'GET') expect(new TextDecoder().decode(new Uint8Array(answers[0].body))).toContain('This link has been turned off')
        else expect(answers[0].body).toEqual([])
      }
    })

    test('asking for an address that was never made writes nothing', async () => {
      const s = await setUp(await module())
      const unknown = generateShareId()
      await s.call(`/s/${unknown}`)
      await s.call(`/s/${unknown}/images/${imageOf('x').name}`)
      expect(tablesOf(s.shares.states.get(unknown)!)).toEqual([])
    })
  })
}

