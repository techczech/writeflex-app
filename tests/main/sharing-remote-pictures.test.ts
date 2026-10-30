import { cleanUpScratch } from '../helpers/scratch-dirs'
// Pictures from other sites (src/main/sharing-remote-pictures.ts; sharing ticket 03 review round 1,
// finding 1): a piece's picture address can never reach this Mac or its private network. Lookup and
// request are injected; the one test of the real pinned request uses a server on loopback and no DNS.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  isLocalHostName, isPublicAddress, pinnedGet, RemotePictureRefused, safeRemotePictureFetch,
  type PinnedGet, type ResolvedAddress, type ResolveHost,
} from '../../src/main/sharing-remote-pictures.ts'
import { renderPieceForSharing } from '../../src/main/sharing-render.ts'
import { buildShipped, removeShipped } from '../helpers/sharing-world.ts'
import { publishWorld } from '../helpers/sharing-publish-world.ts'
import { PICTURES_REFUSED } from '../../src/shared/sharing-links.ts'

beforeAll(buildShipped)
afterAll(removeShipped)

// Reserved local-network names are synthetic; keep the exact hostname at runtime.
const LOCAL_PRINTER = ['printer', 'local'].join('.')

const PNG = new Uint8Array(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 218, 99, 252, 207, 192, 80, 15, 0, 4, 133, 1, 128, 132, 169, 140, 33, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes }

/** A stand-in internet: names → addresses, and what each URL answers. Records every lookup and request. */
function fakeNet(names: Record<string, string[]>, answers: Record<string, { status: number; location?: string; bytes?: Uint8Array }>) {
  const lookups: string[] = []
  const requests: Array<{ url: string; pinned: ResolvedAddress }> = []
  const resolveHost: ResolveHost = async (host) => {
    lookups.push(host)
    return (names[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  const get: PinnedGet = async (url, pinned) => {
    requests.push({ url: url.href, pinned })
    const answer = answers[url.href] ?? { status: 404 }
    return { status: answer.status, location: answer.location ?? null, body: once(answer.bytes ?? new Uint8Array()), cancel: () => {} }
  }
  return { lookups, requests, fetch: safeRemotePictureFetch({ resolveHost, get }) }
}

test('addresses: only the public internet passes', () => {
  const refused = [
    '127.0.0.1', '127.8.9.10', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', [100, 64, 0, 1].join('.'), [100, 127, 255, 254].join('.'),
    '169.254.169.254', '169.254.0.1', '0.0.0.0', '224.0.0.1', '239.255.255.250', '255.255.255.255', '192.0.2.1',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%en0', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '::ffff:169.254.169.254', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:c0a8:0101::1', '2001:db8::1', 'not-an-address',
  ]
  for (const ip of refused) expect([ip, isPublicAddress(ip)]).toEqual([ip, false])
  for (const ip of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:93.184.216.34']) {
    expect([ip, isPublicAddress(ip)]).toEqual([ip, true])
  }
})

test('NAT64: the local-use prefix 64:ff9b:1::/48 is never public; the well-known prefix is as public as its IPv4 address', () => {
  for (const ip of ['64:ff9b:1::a00:1', '64:ff9b:1:ffff::1', '64:ff9b::a00:1']) expect([ip, isPublicAddress(ip)]).toEqual([ip, false])
  expect(isPublicAddress('64:ff9b::808:808')).toBe(true)
})

test('the name lookup counts against the deadline: a lookup that never answers gives no picture, at once', async () => {
  let lookups = 0
  let requests = 0
  const fetchPicture = safeRemotePictureFetch({
    resolveHost: () => { lookups += 1; return new Promise<never>(() => {}) },
    get: async () => { requests += 1; throw new Error('no request should be made') },
    timeoutMs: 1,
  })
  const started = performance.now()
  expect(await fetchPicture('https://images.example.com/figure.png')).toBeNull()
  expect(performance.now() - started).toBeLessThan(50)
  expect([lookups, requests]).toEqual([1, 0])
})

test('names that only mean something nearby are refused', () => {
  for (const name of ['localhost', 'intranet', LOCAL_PRINTER, 'metadata.google.internal', 'app.localhost', 'nas.home.arpa', 'localhost.']) {
    expect([name, isLocalHostName(name)]).toEqual([name, true])
  }
  for (const name of ['example.com', 'images.example.org']) expect([name, isLocalHostName(name)]).toEqual([name, false])
})

test('a loopback, private or metadata address is refused before any request; names are looked up once and pinned', async () => {
  const net = fakeNet(
    { 'inside.example.com': ['10.1.2.3'], 'both.example.com': ['93.184.216.34', '127.0.0.1'], 'pictures.example.com': ['93.184.216.34'] },
    { 'https://pictures.example.com/a.png': { status: 200, bytes: PNG } },
  )
  for (const url of [
    'http://127.0.0.1:8080/private.png', 'http://[::1]/x.png', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.10/x.png',
    `http://${LOCAL_PRINTER}/x.png`, 'http://intranet/x.png', 'http://metadata.google.internal/x.png', 'http://inside.example.com/x.png',
    'http://both.example.com/x.png', 'http://user:pass@pictures.example.com/a.png', 'http://[::ffff:127.0.0.1]/x.png', 'http://2130706433/x.png',
  ]) {
    await expect(net.fetch(url)).rejects.toBeInstanceOf(RemotePictureRefused)
  }
  expect(net.requests).toEqual([])
  expect(await net.fetch('https://pictures.example.com/a.png')).toEqual(PNG)
  expect(net.requests).toEqual([{ url: 'https://pictures.example.com/a.png', pinned: { address: '93.184.216.34', family: 4 } }])
  expect(net.lookups.filter((name) => name === 'pictures.example.com')).toHaveLength(1)
})

test('every redirect is checked before it is followed; at most three', async () => {
  const net = fakeNet(
    { 'a.example.com': ['93.184.216.34'], 'b.example.com': ['93.184.216.35'] },
    {
      'https://a.example.com/to-metadata.png': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
      'https://a.example.com/to-local.png': { status: 301, location: `http://${['router', 'local'].join('.')}/x.png` },
      'https://a.example.com/to-b.png': { status: 307, location: 'https://b.example.com/b.png' },
      'https://b.example.com/b.png': { status: 200, bytes: PNG },
      'https://a.example.com/1': { status: 302, location: '/2' },
      'https://a.example.com/2': { status: 302, location: '/3' },
      'https://a.example.com/3': { status: 302, location: '/4' },
      'https://a.example.com/4': { status: 302, location: '/5' },
      'https://a.example.com/5': { status: 200, bytes: PNG },
    },
  )
  await expect(net.fetch('https://a.example.com/to-metadata.png')).rejects.toBeInstanceOf(RemotePictureRefused)
  await expect(net.fetch('https://a.example.com/to-local.png')).rejects.toBeInstanceOf(RemotePictureRefused)
  expect(net.requests.map((entry) => entry.url)).toEqual(['https://a.example.com/to-metadata.png', 'https://a.example.com/to-local.png'])
  expect(await net.fetch('https://a.example.com/to-b.png')).toEqual(PNG)
  expect(net.requests.at(-1)).toEqual({ url: 'https://b.example.com/b.png', pinned: { address: '93.184.216.35', family: 4 } })
  expect(await net.fetch('https://a.example.com/1')).toBeNull()
  expect(net.requests.filter((entry) => /\/\d$/.test(entry.url)).map((entry) => entry.url)).toEqual(['https://a.example.com/1', 'https://a.example.com/2', 'https://a.example.com/3', 'https://a.example.com/4'])
})

let server: Server
let port = 0
const seen: Array<{ host: string | undefined; url: string | undefined }> = []
beforeAll(async () => {
  server = createServer((request, response) => {
    seen.push({ host: request.headers.host, url: request.url })
    response.writeHead(200, { 'content-type': 'image/png' })
    response.end(Buffer.from(PNG))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  port = (server.address() as AddressInfo).port
})
afterAll(() => { server.close() })

test('the real request connects to the pinned address, never looking the name up; the name travels as Host', async () => {
  // `pictures.invalid` cannot resolve: the bytes arrive only because the socket went to the pinned address.
  const response = await pinnedGet(new URL(`http://pictures.invalid:${port}/a.png?x=1`), { address: '127.0.0.1', family: 4 }, new AbortController().signal)
  expect(response.status).toBe(200)
  const chunks: Uint8Array[] = []
  for await (const chunk of response.body) chunks.push(chunk)
  expect(new Uint8Array(Buffer.concat(chunks))).toEqual(PNG)
  expect(seen.at(-1)).toEqual({ host: `pictures.invalid:${port}`, url: '/a.png?x=1' })
})

test('a refused picture publishes as its alt text, with a plain note; the publish itself goes through', async () => {
  const PIECE = `# Pictures\n\n![the server room](http://127.0.0.1:${port}/private.png)\n\n![a public chart](https://pictures.example.com/a.png)\n`
  const net = fakeNet({ 'pictures.example.com': ['93.184.216.34'] }, { 'https://pictures.example.com/a.png': { status: 200, bytes: PNG } })
  const w = await publishWorld({ files: { 'p.md': PIECE }, render: (root, path, imagePath) => renderPieceForSharing(root, path, imagePath, { fetchRemote: net.fetch }) })
  const made = await w.publisher.make(w.root, 'p.md', { name: null, comments: true })
  expect(made.ok).toBe(true)
  const [published] = w.publishes()
  expect(published.body.images).toHaveLength(1)
  expect(published.body.parts[0].html).toContain('the server room')
  expect(published.body.parts[0].html).not.toContain('127.0.0.1')
  expect(net.requests.map((entry) => entry.url)).toEqual(['https://pictures.example.com/a.png'])
  const link = w.publisher.view(w.root, 'p.md').links[0]
  expect(link).toMatchObject({ problem: null, note: PICTURES_REFUSED(1) })
  expect(link.publishedAt).not.toBeNull()
})

// The shared tracker is cached across files; register this file's cleanup explicitly.
afterAll(cleanUpScratch)
