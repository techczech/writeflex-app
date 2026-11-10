import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import payloads from './reading-room-assets.json'
import { canonicalReaderResource, consumeReaderBootstrap, installReaderRequestPolicy, readerRegistry } from './reading-room-policy'

export const READER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
export const READER_NOTICE_KEYS = [
  'reader/COPYING', 'reader/pdf/LICENSE', 'reader/pdf/web/cmaps/LICENSE', 'reader/pdf/web/iccs/LICENSE',
  'reader/pdf/web/standard_fonts/LICENSE_FOXIT', 'reader/pdf/web/standard_fonts/LICENSE_LIBERATION',
  'reader/pdf/web/wasm/LICENSE_JBIG2', 'reader/pdf/web/wasm/LICENSE_OPENJPEG',
  'reader/pdf/web/wasm/LICENSE_PDFJS_JBIG2', 'reader/pdf/web/wasm/LICENSE_PDFJS_OPENJPEG',
  'reader/pdf/web/wasm/LICENSE_PDFJS_QCMS', 'reader/pdf/web/wasm/LICENSE_QCMS',
] as const
export type ReaderNotice = { key: string; text: string; sha256: string }
type Asset = { file: string; physical: string; sha256: string; bytes: number; mime: string }
export type ReaderDeliveryReceipt = {
  request: number; origin: string; generation: number; initiator?: string; key: string; method: string
  mime: string; status: number; bytes: number; sha256: string; mapHash: string
}
export const readerDeliveryReceipts: ReaderDeliveryReceipt[] = []
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function physicalAsset(root: string, key: string, expected?: { sha256: string; bytes: number; mime: string }): Asset {
  if (key.includes('\\') || key.startsWith('/') || key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid packaged reader key.')
  const file = join(root, key)
  const physical = realpathSync(file)
  const within = relative(root, physical)
  if (!within || within.startsWith(`..${sep}`) || within === '..' || within.startsWith(sep) || physical !== file) throw new Error('Reader physical input is not its exact packaged target.')
  const bytes = readFileSync(file)
  const hash = sha256(bytes)
  if (expected && (expected.sha256 !== hash || expected.bytes !== bytes.length)) throw new Error(`Reader input does not match its reviewed pin: ${key}`)
  return { file, physical, sha256: hash, bytes: bytes.length, mime: expected?.mime ?? (key.endsWith('.html') ? 'text/html' : key.endsWith('.css') ? 'text/css' : 'text/javascript') }
}

/** The map is fixed from reviewed vendor pins plus the build's host dependency closure. Requests
 * never enumerate directories, choose physical paths, redirect or forward to another transport. */
export function createReaderResources(vendorRoot: string, rendererRoot: string): {
  assets: ReadonlyMap<string, Asset>; mapHash: string; notices(): ReaderNotice[]; read(key: string): Buffer
} {
  const vendor = realpathSync(vendorRoot), renderer = realpathSync(rendererRoot)
  const assets = new Map<string, Asset>()
  for (const row of payloads) assets.set(row.key, physicalAsset(vendor, row.key, row))
  const manifest = JSON.parse(readFileSync(join(renderer, '.vite/manifest.json'), 'utf8')) as Record<string, { file: string; imports?: string[]; dynamicImports?: string[]; css?: string[]; assets?: string[]; src?: string }>
  const entry = Object.entries(manifest).find(([, value]) => value.src === 'reader-host.html')?.[0]
  if (!entry) throw new Error('The built reader host entry is missing.')
  const seen = new Set<string>()
  const add = (key: string): void => {
    if (!/^(?:reader-host\.html|assets\/[A-Za-z0-9_.-]+)$/.test(key)) throw new Error('Unexpected reader host build asset.')
    if (!assets.has(key)) assets.set(key, physicalAsset(renderer, key))
  }
  const visit = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    const row = manifest[id]
    if (!row || (row.src && row.src !== 'reader-host.html' && row.src.endsWith('.html'))) throw new Error('Reader host dependency crosses an app entry.')
    add(row.file)
    for (const file of [...row.css ?? [], ...row.assets ?? []]) add(file)
    for (const dependency of [...row.imports ?? [], ...row.dynamicImports ?? []]) visit(dependency)
  }
  visit(entry)
  add('reader-host.html')
  const mapHash = sha256(Buffer.from(JSON.stringify([...assets].map(([key, value]) => [key, value.sha256, value.mime]))))
  const read = (key: string): Buffer => {
    const item = assets.get(key)
    if (!item || realpathSync(item.file) !== item.physical || !statSync(item.file).isFile()) throw new Error('Reader resource target changed.')
    const buffer = readFileSync(item.file)
    if (buffer.length !== item.bytes || sha256(buffer) !== item.sha256) throw new Error('Reader response bytes do not match the map.')
    return buffer
  }
  return { assets, mapHash, read, notices: () => READER_NOTICE_KEYS.map(key => ({ key, text: read(key).toString('utf8'), sha256: assets.get(key)!.sha256 })) }
}

export function installReaderResources(session: Electron.Session, resources: ReturnType<typeof createReaderResources>): void {
  installReaderRequestPolicy(session, new Set(resources.assets.keys()))
  let request = 0
  session.protocol.handle('wf-reader', requestInput => {
    const input = requestInput as Request & { readonly initiatorOrigin?: string }
    const parsed = canonicalReaderResource(input.url, input.method)
    const grant = parsed ? readerRegistry.grants.get(parsed.origin.slice('wf-reader://'.length)) : undefined
    const bootstrap = consumeReaderBootstrap(input.url)
    const asset = parsed && resources.assets.get(parsed.key)
    let status = 403, mime = 'text/plain'
    let bytes: Buffer = Buffer.from('Reader resource refused.')
    if (grant?.live && asset && (input.initiatorOrigin === grant.origin || (bootstrap && parsed.key === 'reader-host.html'))) {
      try {
        bytes = resources.read(parsed.key)
        status = 200; mime = asset.mime
        readerDeliveryReceipts.push({ request: ++request, origin: grant.origin, generation: grant.generation,
          initiator: input.initiatorOrigin, key: parsed.key, method: input.method, mime, status, bytes: bytes.length,
          sha256: sha256(bytes), mapHash: resources.mapHash })
        if (readerDeliveryReceipts.length > 512) readerDeliveryReceipts.shift()
      } catch { status = 409; bytes = Buffer.from('Reader resource pin mismatch.') }
    }
    return new Response(new Uint8Array(bytes), { status, headers: { 'Content-Type': mime,
      'Content-Security-Policy': READER_CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' } })
  })
}
