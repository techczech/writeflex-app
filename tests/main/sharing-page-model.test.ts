// What the Sharing page says about a link (src/renderer/src/components/sharing/sharing-page-model.ts and
// src/shared/sharing-links.ts; sharing ticket 03, frames shared-several and problems).
import { expect, test } from 'bun:test'
import { linkState, notPublishedText } from '../../src/renderer/src/components/sharing/sharing-page-model.ts'
import { cleanLinkName, linkLabel, linkSettingsLabel, type ShareLinkView } from '../../src/shared/sharing-links.ts'

const LINK: ShareLinkView = {
  shareId: 'AbCdEfGhIjKlMnOpQrStUv', name: null, address: 'https://writeflex-sharing.x.workers.dev/s/AbCdEfGhIjKlMnOpQrStUv', comments: true, notes: 'private',
  on: true, madeAt: Date.UTC(2026, 9, 13, 8, 5), publishedAt: null, publishedSavedAt: null, problem: null, publishing: false,
}

test('a link without a name is listed by its settings and the date it was made', () => {
  expect(linkLabel(LINK)).toBe('Private comments · 13 Oct')
  expect(linkLabel({ ...LINK, comments: false })).toBe('No comments · 13 Oct')
  expect(linkLabel({ ...LINK, name: 'Marta' })).toBe('Marta')
  expect(linkSettingsLabel(LINK)).toBe('Comments on, private')
  expect(linkSettingsLabel({ ...LINK, notes: 'open' })).toBe('Comments on, open')
  expect(linkLabel({ ...LINK, notes: 'open' })).toBe('Open comments · 13 Oct')
  expect(linkSettingsLabel({ ...LINK, comments: false })).toBe('Comments off')
})

test('names are one line, trimmed, at most 60 characters; empty is none', () => {
  expect(cleanLinkName('  Workshop\n group ')).toBe('Workshop group')
  expect(cleanLinkName('   ')).toBeNull()
  expect(cleanLinkName(7)).toBeNull()
  expect(cleanLinkName('x'.repeat(80))).toHaveLength(60)
})

test('states: off, not published, publishing, published', () => {
  expect(linkState({ ...LINK, on: false }).kind).toBe('off')
  expect(linkState({ ...LINK, problem: { kind: 'offline', reason: 'x', at: 1 } }).kind).toBe('not-published')
  expect(linkState({ ...LINK, publishing: true }).kind).toBe('publishing')
  expect(linkState({ ...LINK, publishedAt: 5 }).kind).toBe('published')
})

test('Not published says the last time publishing worked, or that nothing went out yet', () => {
  const now = Date.UTC(2026, 9, 15, 14, 0)
  const problem = { kind: 'offline' as const, reason: 'WriteFlex cannot reach your sharing service.', at: now }
  const at = new Date(Date.UTC(2026, 9, 15, 13, 41)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  expect(notPublishedText({ ...LINK, problem, publishedAt: Date.UTC(2026, 9, 15, 13, 41) }, now)).toBe(`WriteFlex cannot reach your sharing service. The last copy went out at ${at}. Readers see that version, labelled with its time. Saves since then are published when it works again.`)
  expect(notPublishedText({ ...LINK, problem }, now)).toContain('Nothing has been published on this link yet')
})


test('partial Folio publication uses its code and says what was published', () => {
  const reason = 'Published, except 2 parts another Mac has newer text for.'
  const partial = { ...LINK, publishedAt: 1000, problem: { kind: 'partial-publish' as const, reason, at: 1000 } }
  expect(linkState(partial)).toMatchObject({ kind: 'published', label: reason, tone: 'warn' })
  expect(notPublishedText(partial)).toBe(reason)
  expect(linkState({ ...partial, problem: { ...partial.problem, reason: 'Changed wording' } })).toMatchObject({ kind: 'published' })
})


test('a successful Folio merge reports the number of parts retained by the service', async () => {
  const { createPublishOnce } = await import('../../src/main/sharing-publish-once')
  const { createServiceClient } = await import('../../src/main/sharing-client')
  const { readRecords } = await import('../../src/main/sharing-share-record')
  const client = createServiceClient({ fetch: (async () => Response.json({ revision: 2, publishedAt: 3000, skippedParts: ['aaaaaa'] })) as typeof fetch })
  const record = readRecords([{ shareId: 'abcdefghijklmnopqrstuv', root: '/fixture', kind: 'folio', path: '', madeAt: 1, on: true, revision: 1 }])[0]
  const run = createPublishOnce({ access: () => ({ address: 'https://fixture.test', base: 'https://fixture.test', key: 'fixture' }), client, tokenFor: () => 'fixture', now: () => 3000, timeZone: () => null,
    render: async () => { throw new Error('not a piece') }, renderFolio: async () => ({ keys: { 'a.md': 'aaaaaa' }, folio: { title: 'Folio', chips: [], savedAt: 3000, structureSavedAt: 3000, parts: [{ path: 'a.md', key: 'aaaaaa', title: 'A', missing: false, html: '<p>A</p>', headings: [] }], pictures: [], refusedPictures: 0 } }) })
  expect((await run.publishOnce(record))?.problem).toMatchObject({ kind: 'partial-publish', reason: 'Published, except 1 part another Mac has newer text for.' })
})

test('a published moved link on an old service says where links will follow, not Not published', () => {
  const reason = 'Moved here; links follow once the sharing service is updated (Settings › Sharing › Update)'
  const link = { ...LINK, publishedAt: 1000, problem: { kind: 'service-update' as const, reason, at: 2000 } }
  expect(linkState(link)).toMatchObject({ kind: 'published', label: reason })
  expect(notPublishedText(link)).toBe(reason)
})

test('a partial publication with one retained part uses the singular', async () => {
  const { createPublishOnce } = await import('../../src/main/sharing-publish-once')
  const { createServiceClient } = await import('../../src/main/sharing-client')
  const { readRecords } = await import('../../src/main/sharing-share-record')
  const client = createServiceClient({ fetch: (async () => Response.json({ revision: 2, publishedAt: 3000, skippedParts: ['aaaaaa'] })) as typeof fetch })
  const record = readRecords([{ shareId: 'abcdefghijklmnopqrstuv', root: '/fixture', kind: 'folio', path: '', madeAt: 1, on: true, revision: 1 }])[0]
  const run = createPublishOnce({ access: () => ({ address: 'https://fixture.test', base: 'https://fixture.test', key: 'fixture' }), client, tokenFor: () => 'fixture', now: () => 3000, timeZone: () => null,
    render: async () => { throw new Error('not a piece') }, renderFolio: async () => ({ keys: { 'a.md': 'aaaaaa' }, folio: { title: 'Folio', chips: [], savedAt: 3000, structureSavedAt: 3000, parts: [{ path: 'a.md', key: 'aaaaaa', title: 'A', missing: false, html: '<p>A</p>', headings: [] }], pictures: [], refusedPictures: 0 } }) })
  expect((await run.publishOnce(record))?.problem?.reason).toBe('Published, except 1 part another Mac has newer text for.')
})

test('the title-bar mark stays Shared for a published link waiting for the service update', async () => {
  const { createSharingPublisher } = await import('../../src/main/sharing-publisher')
  const { createServiceClient } = await import('../../src/main/sharing-client')
  const { memorySecrets } = await import('../helpers/memory-secrets')
  const publisher = createSharingPublisher({ records: { read: () => [{ ...LINK, root: '/synthetic-sharing-move', path: 'paper.md', publishedAt: 1000,
      problem: { kind: 'service-update', reason: 'Moved here; links follow once the sharing service is updated (Settings › Sharing › Update)', at: 1000 } }], write: () => true },
    secrets: memorySecrets().store, client: createServiceClient({ fetch: (async () => { throw new Error('no network in this view test') }) as typeof fetch }), access: () => null, render: async () => { throw new Error('not publishing') } })
  expect(publisher.mark('/synthetic-sharing-move', 'paper.md')).toEqual({ kind: 'shared' })
})


test('Moved here draws a notice with a folder icon and no not-published problem styling', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { SharingPublicationPanel } = await import('../../src/renderer/src/components/sharing/SharingPage')
  const link = { ...LINK, publishedAt: 1000, problem: { kind: 'service-update' as const, reason: 'Moved here; update the sharing service.', at: 2000 } }
  const html = renderToStaticMarkup(createElement(SharingPublicationPanel, { link, busy: null, onRetry() {} }))
  expect(html).toContain('data-notice="moved-here"')
  expect(html).toContain('lucide-folder-open')
  expect(html).toContain('Moved here')
  expect(html).not.toContain('data-problem=')
  expect(html).not.toContain('shr-panel problem')
  expect(html).not.toContain('lucide-cloud-off')
  expect(html).not.toContain('Retry')
  expect(html).not.toContain('<button')
})

for (const count of [1, 2]) test(`a published receipt for ${count} unsynced parts does not mark their keys seen and explains their absence`, async () => {
  const { createPublishOnce } = await import('../../src/main/sharing-publish-once')
  const { createServiceClient } = await import('../../src/main/sharing-client')
  const { readRecords } = await import('../../src/main/sharing-share-record')
  const skippedParts = ['bbbbbb', 'cccccc'].slice(0, count)
  const client = createServiceClient({ fetch: (async () => Response.json({ revision: 2, publishedAt: 3000, skippedParts })) as typeof fetch })
  const record = readRecords([{ shareId: 'abcdefghijklmnopqrstuv', root: '/fixture', kind: 'folio', path: '', madeAt: 1, on: true, revision: 1 }])[0]
  const run = createPublishOnce({ access: () => ({ address: 'https://fixture.test', base: 'https://fixture.test', key: 'fixture' }), client, tokenFor: () => 'fixture', now: () => 3000, timeZone: () => null,
    render: async () => { throw new Error('not a piece') }, renderFolio: async () => ({ keys: { 'a.md': 'aaaaaa' }, folio: { title: 'Folio', chips: [], savedAt: 3000, structureSavedAt: 3000, parts: [{ path: 'a.md', key: 'aaaaaa', title: 'A', missing: false, html: '<p>A</p>', headings: [] }], pictures: [], refusedPictures: 0 } }) })
  const outcome = await run.publishOnce(record)
  expect(outcome?.problem).toMatchObject({ kind: 'partial-publish', reason: `Published, except ${count} ${count === 1 ? 'part' : 'parts'} not yet on this Mac.` })
  expect(outcome).toMatchObject({ seenPartKeys: ['aaaaaa'] })
  expect(readRecords([{ ...record, ...outcome }])[0]).toMatchObject({ seenPartKeys: ['aaaaaa'] })
})

test('only local renders remember keys when unchanged and before a subsequent publish fails', async () => {
  const { createPublishOnce } = await import('../../src/main/sharing-publish-once')
  const { createServiceClient } = await import('../../src/main/sharing-client')
  const { readRecords } = await import('../../src/main/sharing-share-record')
  let sourceHash = ''
  let failPage = false
  const received: string[] = []
  const client = createServiceClient({ fetch: (async (_input, init) => {
    if (init?.method === 'GET') return Response.json({ revision: 1, publishedAt: 3000, savedAt: 3000, sourceHash: failPage ? 'd'.repeat(64) : sourceHash, folioState: { partKeys: { 'a.md': 'aaaaaa', 'removed.md': 'bbbbbb' }, parts: [{ path: 'a.md', title: 'A', missing: false }] } })
    if (failPage) throw new Error('synthetic network failure after receiving owner state')
    sourceHash = JSON.parse(String(init?.body)).sourceHash
    return Response.json({ revision: 1, publishedAt: 3000, sourceHash })
  }) as typeof fetch })
  const record = readRecords([{ shareId: 'abcdefghijklmnopqrstuv', root: '/fixture', kind: 'folio', path: '', madeAt: 1, on: true }])[0]
  const run = createPublishOnce({ access: () => ({ address: 'https://fixture.test', base: 'https://fixture.test', key: 'fixture' }), client, tokenFor: () => 'fixture', now: () => 3000, timeZone: () => null,
    rememberRenderedParts: (_shareId, keys) => { received.push(...keys) },
    render: async () => { throw new Error('not a piece') }, renderFolio: async () => ({ keys: { 'a.md': 'aaaaaa' }, folio: { title: 'Folio', chips: [], savedAt: 3000, structureSavedAt: 3000, parts: [{ path: 'a.md', key: 'aaaaaa', title: 'A', missing: false, html: '<p>A</p>', headings: [] }], pictures: [], refusedPictures: 0 } }) })
  const outcome = await run.publishOnce(record)
  const unchanged = await run.publishOnce({ ...record, ...outcome, workspaceId: 'workspaceaaaaaaaa', queuedAt: null, problem: null })
  const newlySeen = await run.publishOnce({ ...record, ...outcome, workspaceId: 'workspaceaaaaaaaa', queuedAt: null, problem: null, seenPartKeys: [] })
  expect(newlySeen?.seenPartKeys).toEqual(['aaaaaa'])
  expect(unchanged).toBeNull()
  received.length = 0
  failPage = true
  await expect(run.publishOnce({ ...record, ...outcome, workspaceId: 'workspaceaaaaaaaa' })).rejects.toThrow()
  expect(received).toContain('aaaaaa')
  expect(received).not.toContain('bbbbbb')
})

test('reading reader counts does not mark remote part keys seen', async () => {
  const { createSharingPublisher } = await import('../../src/main/sharing-publisher')
  const { createServiceClient } = await import('../../src/main/sharing-client')
  const { memorySecrets } = await import('../helpers/memory-secrets')
  const { readRecords } = await import('../../src/main/sharing-share-record')
  const secrets = memorySecrets()
  const shareId = 'abcdefghijklmnopqrstuv'
  secrets.store.write('sharing-links', JSON.stringify({ format: 1, tokens: { [shareId]: 'fixture-owner-token' } }))
  let cache: unknown = [{ shareId, root: '/fixture', kind: 'folio', path: '', madeAt: 1, on: true, revision: 1, publishedAt: 1000, seenPartKeys: ['aaaaaa'] }]
  const client = createServiceClient({ fetch: (async () => Response.json({ revision: 2, publishedAt: 3000, opened: 4, folioState: { partKeys: { 'b.md': 'bbbbbb' }, parts: [{ path: 'b.md', title: 'B', missing: false }] } })) as typeof fetch })
  const publisher = createSharingPublisher({ access: () => ({ base: 'https://fixture.test', address: 'https://fixture.test', key: 'fixture' }), secrets: secrets.store, client,
    records: { read: () => cache, write: next => { cache = next; return true } }, render: async () => { throw new Error('not publishing') } })
  expect(await publisher.opened([shareId])).toEqual({ [shareId]: 4 })
  expect(readRecords(cache)[0].seenPartKeys).toEqual(['aaaaaa'])
})


test('a merged part-count refusal uses the existing Folio count message', async () => {
  const { createPublishOnce } = await import('../../src/main/sharing-publish-once')
  const { createServiceClient } = await import('../../src/main/sharing-client')
  const { readRecords } = await import('../../src/main/sharing-share-record')
  const { FOLIO_TOO_MANY_PARTS } = await import('../../src/shared/sharing-links')
  const client = createServiceClient({ fetch: (async () => Response.json({ error: { code: 'folio_too_many_parts' }, count: 201, limit: 200 }, { status: 413 })) as typeof fetch })
  const record = readRecords([{ shareId: 'abcdefghijklmnopqrstuv', root: '/fixture', kind: 'folio', path: '', on: true }])[0]
  const run = createPublishOnce({ access: () => ({ address: 'https://fixture.test', base: 'https://fixture.test', key: 'fixture' }), client, tokenFor: () => 'fixture', now: () => 3000, timeZone: () => null,
    render: async () => { throw new Error('not a piece') }, renderFolio: async () => ({ keys: { 'a.md': 'aaaaaa' }, folio: { title: 'Folio', chips: [], savedAt: 3000, parts: [{ path: 'a.md', key: 'aaaaaa', title: 'A', missing: false, html: '<p>A</p>', headings: [] }], pictures: [], refusedPictures: 0 } }) })
  await expect(run.publishOnce(record)).rejects.toMatchObject({ problem: { kind: 'too-big', reason: FOLIO_TOO_MANY_PARTS(201, 200) } })
})
