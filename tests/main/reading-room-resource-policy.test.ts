import { expect, test } from 'bun:test'
import { canonicalReaderResource, consumeReaderBootstrap, installReaderRequestPolicy, readerRegistry, ReaderRegistry } from '../../src/main/reading-room-policy'

const origin = 'wf-reader://' + 'a'.repeat(32)
test('canonical resources have one spelling, exact origin and GET only', () => {
  expect(canonicalReaderResource(origin + '/reader/pdf/build/pdf.worker.mjs', 'GET')).toEqual({ origin, key: 'reader/pdf/build/pdf.worker.mjs' })
  for (const path of ['/reader/%00x', '/reader/%2fx', '/reader/%5cx', '/reader/%252fx', '/reader/xx?x=1', '/reader/\\x']) {
    expect(canonicalReaderResource(origin + path, 'GET')).toBeNull()
  }
  expect(canonicalReaderResource(origin + '/reader/x', 'POST')).toBeNull()
  expect(canonicalReaderResource(origin.replace('wf-reader:', 'WF-READER:') + '/reader/x', 'GET')).toBeNull()
  expect(canonicalReaderResource(origin.replace('://', '://user@') + '/reader/x', 'GET')).toBeNull()
  expect(canonicalReaderResource(origin + ':80/reader/x', 'GET')).toBeNull()
})
test('leases are owner and selection bound, revoked origins remain reader principals', () => {
  const registry = new ReaderRegistry()
  const owner = { id: 1, top: '1:2', epoch: 4, origin: 'file://' }
  const a = registry.create(owner, 0)
  const b = registry.create({ ...owner, id: 2 }, 0)
  expect(registry.owned(a.id, owner)).toBe(a)
  expect(() => registry.owned(a.id, { ...owner, id: 2 })).toThrow()
  expect(() => registry.owned(a.id, { ...owner, epoch: 5 })).toThrow()
  expect(registry.classify(a.origin, b.origin + '/reader/x')).toBe('deny')
  expect(registry.classify(a.origin, 'https://example.invalid/')).toBe('deny')
  expect(registry.classify('file://', 'https://example.invalid/')).toBe('other')
  registry.revoke(a.id)
  expect(registry.classify(a.origin, a.origin + '/reader/x')).toBe('deny')
  expect(() => registry.owned(a.id, owner)).toThrow()
  expect(registry.owned(b.id, { ...owner, id: 2 })).toBe(b)
})


test('fragments carry bootstrap information separately from fixed resource identity', () => {
  for (const fragment of ['#bootstrap', '#https://other.invalid/?key=elsewhere', '#reader/%2f../x', '#\\ignored']) {
    expect(canonicalReaderResource(origin + '/reader-host.html' + fragment, 'GET')).toEqual({ origin, key: 'reader-host.html' })
    expect(canonicalReaderResource(origin + '/reader-host.html?key=x' + fragment, 'GET')).toBeNull()
    expect(canonicalReaderResource(origin + '/reader/%2fx' + fragment, 'GET')).toBeNull()
    expect(canonicalReaderResource(origin + '/reader-host.html' + fragment, 'POST')).toBeNull()
    expect(canonicalReaderResource(origin + ':80/reader-host.html' + fragment, 'GET')).toBeNull()
  }
})

function policyFixture() {
  const owner = { id: 42, top: '10:20', epoch: 7, origin: 'file://' }
  const grant = readerRegistry.create(owner, 0)
  let listener!: (details: Electron.OnBeforeRequestListenerDetails, callback: (result: Electron.CallbackResponse) => void) => void
  installReaderRequestPolicy({ webRequest: { onBeforeRequest: (fn: typeof listener) => { listener = fn } } } as unknown as Electron.Session,
    new Set(['reader-host.html', 'assets/host.js']))
  const parent = { processId: 10, routingId: 20, parent: null, origin: 'file://' }
  const frame = { processId: 10, routingId: 21, parent, origin: '' }
  const details = { id: 1, url: grant.url, method: 'GET', resourceType: 'subFrame', webContentsId: owner.id,
    initiatorOrigin: owner.origin, frame } as unknown as Electron.OnBeforeRequestListenerDetails
  return { owner, grant, details, request: (changes: Partial<Electron.OnBeforeRequestListenerDetails> = {}) => {
    let allowed = false
    listener({ ...details, ...changes }, result => { allowed = !result.cancel })
    return allowed
  }, close: () => { readerRegistry.revoke(grant.id) } }
}

for (const [requested, consumed] of [['#bootstrap', ''], ['', '#bootstrap'], ['#first', '#second'], ['', '']]) {
  test(`one-use bootstrap binds the same resource across fragments ${requested}/${consumed}`, () => {
    const f = policyFixture()
    try {
      expect(f.request({ url: f.grant.url + requested })).toBe(true)
      expect(consumeReaderBootstrap(f.grant.url + consumed)).toBe(true)
      expect(consumeReaderBootstrap(f.grant.url + requested)).toBe(false)
      expect(f.request({ url: f.grant.url + '#duplicate' })).toBe(false)
    } finally { f.close() }
  })
}

for (const kind of ['owner', 'top', 'nested', 'origin', 'method', 'authority', 'key', 'query', 'resource', 'stale'] as const) {
  test(`bootstrap fragment cannot override ${kind} authority`, () => {
    const f = policyFixture()
    try {
      const fragment = '#'+encodeURIComponent(JSON.stringify({ owner: f.owner, generation: f.grant.generation, key: 'reader-host.html' }))
      const changes: Partial<Electron.OnBeforeRequestListenerDetails> = { url: f.grant.url + fragment }
      if (kind === 'owner') changes.webContentsId = 99
      if (kind === 'top') changes.frame = { parent: { processId: 10, routingId: 99, parent: null } } as Electron.WebFrameMain
      if (kind === 'nested') changes.frame = { parent: { processId: 10, routingId: 20, parent: {} } } as Electron.WebFrameMain
      if (kind === 'origin') changes.initiatorOrigin = 'https://other.invalid'
      if (kind === 'method') changes.method = 'POST'
      if (kind === 'authority') changes.url = origin + '/reader-host.html' + fragment
      if (kind === 'key') changes.url = f.grant.origin + '/assets/host.js' + fragment
      if (kind === 'query') changes.url = f.grant.url + '?entry=1' + fragment
      if (kind === 'resource') changes.resourceType = 'script'
      if (kind === 'stale') f.close()
      expect(f.request(changes)).toBe(false)
      expect(consumeReaderBootstrap(f.grant.url)).toBe(false)
    } finally { f.close() }
  })
}

test('pending bootstrap cannot be spent on unrelated resources or revoked generations', () => {
  const f = policyFixture()
  try {
    expect(f.request()).toBe(true)
    expect(consumeReaderBootstrap(f.grant.origin + '/assets/host.js#reader-host.html')).toBe(false)
    expect(consumeReaderBootstrap(origin + '/reader-host.html#' + f.grant.id)).toBe(false)
    f.close()
    expect(consumeReaderBootstrap(f.grant.url)).toBe(false)
  } finally { f.close() }
})


for (const field of ['generation', 'epoch', 'top', 'id', 'origin'] as const) {
  test(`pending handoff retains its validated ${field} binding`, () => {
    const f = policyFixture()
    try {
      expect(f.request({ url: f.grant.url + '#bootstrap' })).toBe(true)
      if (field === 'generation') f.grant.generation++
      else if (field === 'epoch') f.grant.owner.epoch++
      else if (field === 'top') f.grant.owner.top = '10:99'
      else if (field === 'id') f.grant.owner.id++
      else f.grant.owner.origin = 'https://other.invalid'
      expect(consumeReaderBootstrap(f.grant.url)).toBe(false)
      expect(consumeReaderBootstrap(f.grant.url)).toBe(false)
    } finally { f.close() }
  })
}
