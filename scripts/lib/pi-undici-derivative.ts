// Deterministic derivative of the npm pi-coding-agent 0.83.0 archive whose only changes are its undici
// pin (8.5.0 -> 8.12.2, the floor that clears the seven undici 8.x advisories) and an added upstream MIT
// notice. Bun 1.3.10 ignores scoped overrides, so replacing pi's own manifest is the narrow repair that
// leaves the 6.x and 7.x undici copies of other packages alone. Recipe: vendor/earendil-works/README-pi-coding-agent-undici-derivative.md.
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

export const ORIGINAL = {
  name: '@earendil-works/pi-coding-agent',
  version: '0.83.0',
  tarball: 'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.83.0.tgz',
  integrity: 'sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw==',
  gitHead: '845d6ff1f6643aba440341cce877ce1c43ebbc39',
  license: 'MIT',
} as const

export const LICENSE_SOURCE = {
  url: 'https://raw.githubusercontent.com/earendil-works/pi/845d6ff1f6643aba440341cce877ce1c43ebbc39/LICENSE',
  sha256: '0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48',
  archivePath: 'package/LICENSE',
} as const

export const UNDICI_FROM = {
  version: '8.5.0',
  resolved: 'https://registry.npmjs.org/undici/-/undici-8.5.0.tgz',
  integrity: 'sha512-xamtWoB1EshgjpmlXd7GGm2VfdDtw1+rD8uhry8pSNW3If6S8E0m2T2+orSKeZXEn/aPJMviCpDBA65WJt8zhg==',
} as const

export const UNDICI_TO = {
  version: '8.12.2',
  resolved: 'https://registry.npmjs.org/undici/-/undici-8.12.2.tgz',
  integrity: 'sha512-XtuDWVdqTLr3NAxm2ly9/hU6kUsJOgGh1RASzMBbsw6aWCOaQzHdW+QQDfdERjfJ2V5vL5pRPa4RetO9UfivDg==',
  engines: { node: '>=22.19.0' },
  license: 'MIT',
} as const

export const DERIVATIVE_FILENAME = 'earendil-works-pi-coding-agent-0.83.0-undici-8.12.2.tgz'

// Every JSON path the derivative may change; anything else differing is a build failure.
export const METADATA_ALLOWLIST: Record<string, string[][]> = {
  'package/package.json': [['dependencies', 'undici']],
  'package/npm-shrinkwrap.json': [
    ['packages', '', 'dependencies', 'undici'],
    ['packages', 'node_modules/undici', 'version'],
    ['packages', 'node_modules/undici', 'resolved'],
    ['packages', 'node_modules/undici', 'integrity'],
  ],
}

// npm's fixed archive mtime (1985-10-26T08:15:00Z), kept so the derivative matches npm's convention.
const NPM_MTIME = 499162500

export interface TarFile {
  path: string
  mode: number
  data: Uint8Array
}

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
export const sri512 = (b: Uint8Array): string => `sha512-${createHash('sha512').update(b).digest('base64')}`

const text = (b: Uint8Array, start: number, len: number): string => {
  const slice = b.subarray(start, start + len)
  const end = slice.indexOf(0)
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end))
}
const octal = (b: Uint8Array, start: number, len: number): number => {
  const s = text(b, start, len).trim()
  if (!/^[0-7]+$/.test(s)) throw new Error(`invalid octal field ${JSON.stringify(s)}`)
  return parseInt(s, 8)
}

export function assertSafeArchivePath(path: string): void {
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.includes('\0')) {
    throw new Error(`refusing absolute or non-portable archive path ${JSON.stringify(path)}`)
  }
  const parts = path.split('/')
  if (parts[0] !== 'package' || parts.length < 2) throw new Error(`refusing path outside package/: ${JSON.stringify(path)}`)
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`refusing traversal path ${JSON.stringify(path)}`)
}

// Accepts only regular files under package/; symlinks, hard links, directories, devices and pax/GNU
// extension headers are refused before any byte is materialised.
export function readTarGz(gz: Uint8Array): TarFile[] {
  const tar = gunzipSync(gz)
  const files: TarFile[] = []
  const seen = new Set<string>()
  let off = 0
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512)
    if (h.every((x) => x === 0)) break
    const sum = h.reduce((acc, x, i) => acc + (i >= 148 && i < 156 ? 32 : x), 0)
    if (sum !== octal(h, 148, 8)) throw new Error(`bad tar header checksum at offset ${off}`)
    const type = String.fromCharCode(h[156] || 48)
    const prefix = text(h, 345, 155)
    const name = prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100)
    if (type !== '0') throw new Error(`refusing non-regular tar entry type ${JSON.stringify(type)} for ${JSON.stringify(name)}`)
    assertSafeArchivePath(name)
    if (seen.has(name)) throw new Error(`refusing duplicate archive path ${name}`)
    seen.add(name)
    const size = octal(h, 124, 12)
    const mode = octal(h, 100, 8) & 0o777
    files.push({ path: name, mode, data: tar.slice(off + 512, off + 512 + size) })
    off += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

function writeField(h: Uint8Array, start: number, len: number, value: string): void {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length > len) throw new Error(`tar field overflow: ${value}`)
  h.set(bytes, start)
}
const octalField = (n: number, len: number): string => `${n.toString(8).padStart(len - 1, '0')}\0`

function header(file: TarFile): Uint8Array {
  const h = new Uint8Array(512)
  let name = file.path
  let prefix = ''
  if (new TextEncoder().encode(name).length > 100) {
    const cut = name.lastIndexOf('/', 155)
    prefix = name.slice(0, cut)
    name = name.slice(cut + 1)
    if (cut <= 0 || new TextEncoder().encode(name).length > 100) throw new Error(`path too long for ustar: ${file.path}`)
  }
  writeField(h, 0, 100, name)
  writeField(h, 100, 8, octalField(file.mode, 8))
  writeField(h, 108, 8, octalField(0, 8))
  writeField(h, 116, 8, octalField(0, 8))
  writeField(h, 124, 12, octalField(file.data.length, 12))
  writeField(h, 136, 12, octalField(NPM_MTIME, 12))
  h.fill(32, 148, 156)
  h[156] = 48
  writeField(h, 257, 6, 'ustar\0')
  writeField(h, 263, 2, '00')
  writeField(h, 345, 155, prefix)
  const sum = h.reduce((a, x) => a + x, 0)
  writeField(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return h
}

// Byte-sorted paths, fixed mtime, uid/gid 0 with empty owner names, and a gzip header with zero mtime
// and OS "unknown" so the output depends only on the file contents and modes.
export function writeTarGz(files: TarFile[]): { tar: Uint8Array; gz: Uint8Array } {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  const chunks: Uint8Array[] = []
  for (const f of sorted) {
    chunks.push(header(f), f.data)
    const pad = (512 - (f.data.length % 512)) % 512
    if (pad) chunks.push(new Uint8Array(pad))
  }
  chunks.push(new Uint8Array(1024))
  const tar = new Uint8Array(Buffer.concat(chunks))
  const gz = new Uint8Array(gzipSync(tar, { level: 9 }))
  gz.fill(0, 4, 8)
  gz[8] = 2
  gz[9] = 255
  return { tar, gz }
}

function replaceOnce(source: string, from: string, to: string, where: string): string {
  const first = source.indexOf(from)
  if (first === -1 || source.indexOf(from, first + 1) !== -1) throw new Error(`expected exactly one ${JSON.stringify(from)} in ${where}`)
  return source.slice(0, first) + to + source.slice(first + from.length)
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export function jsonDiffPaths(a: Json, b: Json, at: string[] = []): string[][] {
  const isObj = (v: Json): v is { [k: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].flatMap((k) => (k in a && k in b ? jsonDiffPaths(a[k], b[k], [...at, k]) : [[...at, k]]))
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [at]
}

// Text-level edits keep upstream formatting; the structural diff then proves nothing outside the allowlist moved.
export function amendMetadata(path: string, original: string): string {
  if (path === 'package/package.json') {
    return replaceOnce(original, `"undici": "${UNDICI_FROM.version}"`, `"undici": "${UNDICI_TO.version}"`, path)
  }
  if (path === 'package/npm-shrinkwrap.json') {
    const lock = JSON.parse(original)
    const record = lock.packages?.['node_modules/undici']
    if (lock.packages?.['']?.dependencies?.undici !== UNDICI_FROM.version || record?.version !== UNDICI_FROM.version) {
      throw new Error('shrinkwrap undici record is not the expected 8.5.0 shape')
    }
    if (JSON.stringify(record.engines) !== JSON.stringify(UNDICI_TO.engines) || record.license !== UNDICI_TO.license) {
      throw new Error('undici 8.12.2 engines/licence differ from the shrinkwrap record; extend the allowlist deliberately')
    }
    let out = replaceOnce(original, `"undici": "${UNDICI_FROM.version}"`, `"undici": "${UNDICI_TO.version}"`, path)
    out = replaceOnce(out, `"resolved": "${UNDICI_FROM.resolved}"`, `"resolved": "${UNDICI_TO.resolved}"`, path)
    out = replaceOnce(out, `"integrity": "${UNDICI_FROM.integrity}"`, `"integrity": "${UNDICI_TO.integrity}"`, path)
    return replaceOnce(
      out,
      `"node_modules/undici": {\n\t\t\t"version": "${UNDICI_FROM.version}"`,
      `"node_modules/undici": {\n\t\t\t"version": "${UNDICI_TO.version}"`,
      path,
    )
  }
  throw new Error(`no amendment defined for ${path}`)
}

export interface DerivativeResult {
  gz: Uint8Array
  tar: Uint8Array
  provenance: Record<string, unknown>
}

export function buildDerivative(originalGz: Uint8Array, licenseText: Uint8Array): DerivativeResult {
  if (sri512(originalGz) !== ORIGINAL.integrity) throw new Error('original archive does not match the npm registry integrity')
  if (sha256(licenseText) !== LICENSE_SOURCE.sha256) throw new Error('licence text does not match the pinned upstream LICENSE')
  const files = readTarGz(originalGz)
  if (files.some((f) => f.path === LICENSE_SOURCE.archivePath)) throw new Error('original already ships a LICENSE; revisit the recipe')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const amended = files.map((f) => {
    if (!(f.path in METADATA_ALLOWLIST)) return f
    const before = decoder.decode(f.data)
    const after = amendMetadata(f.path, before)
    const changed = jsonDiffPaths(JSON.parse(before), JSON.parse(after)).map((p) => JSON.stringify(p)).sort()
    const allowed = METADATA_ALLOWLIST[f.path].map((p) => JSON.stringify(p)).sort()
    if (JSON.stringify(changed) !== JSON.stringify(allowed)) throw new Error(`${f.path} changed ${changed.join(', ')}; allowed ${allowed.join(', ')}`)
    return { ...f, data: new TextEncoder().encode(after) }
  })
  amended.push({ path: LICENSE_SOURCE.archivePath, mode: 0o644, data: licenseText })
  const { tar, gz } = writeTarGz(amended)
  const upstreamFiles = Object.fromEntries(
    [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map((f) => [f.path, { sha256: sha256(f.data), mode: f.mode.toString(8) }]),
  )
  const provenance = {
    kind: 'local-derivative-of-npm-package',
    notUpstreamAttested: 'The npm integrity and provenance attestation identify the original archive only, never these bytes.',
    original: { ...ORIGINAL, sha256: sha256(originalGz), fileCount: files.length },
    licenseSource: LICENSE_SOURCE,
    undici: { from: UNDICI_FROM, to: UNDICI_TO },
    metadataAllowlist: METADATA_ALLOWLIST,
    addedFiles: [LICENSE_SOURCE.archivePath],
    derivative: { filename: DERIVATIVE_FILENAME, integrity: sri512(gz), sha256: sha256(gz), tarSha256: sha256(tar), fileCount: amended.length },
    upstreamFiles,
  }
  return { gz, tar, provenance }
}
