// The sharing service as the app ships it: the bundle built at app build time, checked against its
// manifest. Copied from TalkWeaver's src/main/live-service-upload.ts (the manifest half; the upload
// itself is ticket 02).
//
// Nothing is compiled on the person's computer. The service is compiled ONCE, when the app is built
// (scripts/build-sharing-service.ts), into `sharing-service-dist/`, which ships in the app's
// resources:
//   index.js            the bundle
//   upload-config.json  what the upload needs from sharing-service/wrangler.jsonc (name,
//                       compatibility date and flags, Durable Object bindings and migrations,
//                       observability)
//   manifest.json       the compiler and its version, the service's build number
//                       (SHARING_SERVICE_BUILD), a digest of the sources, and the SHA-256 and size
//                       of both files above
//
// verifySharingServiceBundle is the seam: ok, or "This WriteFlex installation is incomplete" with
// details. The app runs it before ANY request to Cloudflare is sent (ticket 02, sharing-setup.ts),
// and the build runs it before the folder is accepted.
//
// What it protects against: a damaged or partial folder (a file missing, empty, cut short or changed
// on disk) and a folder from the wrong build (pieces of two WriteFlex versions). It does NOT protect
// against deliberate tampering: the manifest sits beside the bundle, so whoever can rewrite one can
// rewrite both. That is the job of the app's code signature, which covers everything in the app's
// resources. Decision (ticket 02, from the ticket 01 review): the expected hash is not compiled into
// the app. Inside a signed app it would add nothing the signature does not give, and it would tie
// every app build and dev run to a fresh sharing-service-dist.
//
// No Electron import.
import { createHash } from 'node:crypto'
import { SHARING_SERVICE_BUILD } from '../../sharing-service/version.ts'

export const INSTALLATION_INCOMPLETE = 'This WriteFlex installation is incomplete.'
export const SHARING_SERVICE_DIST_DIR = 'sharing-service-dist'
export const MANIFEST_FILE = 'manifest.json'
export const MANIFEST_FORMAT = 1

export type SharingServiceManifest = {
  format: typeof MANIFEST_FORMAT
  /** What compiled the bundle, and its version. */
  compiler: string
  compilerVersion: string
  /** SHARING_SERVICE_BUILD of the sources it was compiled from. */
  build: number
  mainModule: string
  configFile: string
  /** file name → its SHA-256 (hex) and size in bytes. */
  files: Record<string, { sha256: string; bytes: number }>
  /** A digest of the service's sources (scripts/lib/sharing-service-dist.ts): how the build tells a stale folder. */
  sources: string
}

export type DurableObjectBinding = { name: string; class_name: string }
export type Migration = { tag: string } & Record<string, unknown>
export type SharingServiceConfig = {
  name: string
  compatibility_date: string
  compatibility_flags: string[]
  durable_objects: { bindings: DurableObjectBinding[] }
  migrations: Migration[]
  observability?: { enabled: boolean }
}

export type ShippedFiles = { manifest: string | null; bundle: Uint8Array | null; config: Uint8Array | null }
export type Verified = { ok: true; manifest: SharingServiceManifest; config: SharingServiceConfig; bundle: Uint8Array }
export type Incomplete = { ok: false; error: typeof INSTALLATION_INCOMPLETE; details: string }

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const isText = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)
const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/
const TAG = /^[A-Za-z0-9._-]{1,64}$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HEX64 = /^[0-9a-f]{64}$/
const where = `${SHARING_SERVICE_DIST_DIR}/${MANIFEST_FILE}`

function readManifest(text: string | null): SharingServiceManifest | string {
  if (text === null) return `${where} is missing.`
  let value: unknown
  try { value = JSON.parse(text) } catch { return `${where} is not readable.` }
  const m = value as Partial<SharingServiceManifest> | null
  if (!m || typeof m !== 'object' || m.format !== MANIFEST_FORMAT) return `${where} is not one this version of WriteFlex reads.`
  if (!isText(m.compiler, /^[a-z0-9-]{1,32}$/) || !isText(m.compilerVersion, /^\d+\.\d+\.\d+$/) || !Number.isSafeInteger(m.build) || (m.build as number) < 1
    || !isText(m.mainModule, FILE) || !isText(m.configFile, FILE) || !isText(m.sources, HEX64) || !m.files || typeof m.files !== 'object') return `${where} is incomplete.`
  for (const name of [m.mainModule, m.configFile]) {
    const entry = (m.files as Record<string, unknown>)[name] as { sha256?: unknown; bytes?: unknown } | undefined
    if (!entry || !isText(entry.sha256, HEX64) || !Number.isInteger(entry.bytes) || (entry.bytes as number) <= 0) return `${where} does not describe ${name}.`
  }
  return m as SharingServiceManifest
}

/** upload-config.json's shape, or a sentence saying what is wrong with it. */
export function readSharingServiceConfig(value: unknown): SharingServiceConfig | string {
  const c = value as Partial<SharingServiceConfig> | null
  const what = 'the sharing service\'s upload settings'
  if (!c || typeof c !== 'object') return `${what} are not readable.`
  if (!isText(c.name, SCRIPT_NAME)) return `${what} name no valid Worker.`
  if (!isText(c.compatibility_date, /^\d{4}-\d{2}-\d{2}$/)) return `${what} have no compatibility date.`
  if (!Array.isArray(c.compatibility_flags) || !c.compatibility_flags.every((flag) => isText(flag, /^[a-z0-9_]{1,64}$/))) return `${what} have unreadable compatibility flags.`
  const bindings = c.durable_objects?.bindings
  if (!Array.isArray(bindings) || bindings.length === 0 || !bindings.every((binding) => isText(binding?.name, IDENTIFIER) && isText(binding?.class_name, IDENTIFIER))) return `${what} have unreadable Durable Object bindings.`
  if (!Array.isArray(c.migrations) || !c.migrations.every((migration) => migration && typeof migration === 'object' && isText(migration.tag, TAG))) return `${what} have unreadable migrations.`
  if (new Set(c.migrations.map((migration) => migration.tag)).size !== c.migrations.length) return `${what} name a migration twice.`
  if (c.observability !== undefined && typeof c.observability?.enabled !== 'boolean') return `${what} have unreadable observability settings.`
  return c as SharingServiceConfig
}

/**
 * The shipped bundle and its settings, checked against the manifest beside them. `expectedBuild`:
 * the service build this app was made with; a manifest for another build is an installation put
 * together from two versions. Pure: the file bytes are passed in.
 */
export function verifySharingServiceBundle(manifestText: string | null, files: Omit<ShippedFiles, 'manifest'>, expectedBuild: number = SHARING_SERVICE_BUILD): Verified | Incomplete {
  const incomplete = (details: string): Incomplete => ({ ok: false, error: INSTALLATION_INCOMPLETE, details })
  const manifest = readManifest(manifestText)
  if (typeof manifest === 'string') return incomplete(manifest)
  if (manifest.build !== expectedBuild) {
    return incomplete(`${SHARING_SERVICE_DIST_DIR} holds sharing service build ${manifest.build}; this WriteFlex was made with build ${expectedBuild}.`)
  }
  for (const [name, bytes] of [[manifest.mainModule, files.bundle], [manifest.configFile, files.config]] as const) {
    const expected = manifest.files[name]
    if (bytes === null) return incomplete(`${SHARING_SERVICE_DIST_DIR}/${name} is missing.`)
    if (bytes.byteLength === 0) return incomplete(`${SHARING_SERVICE_DIST_DIR}/${name} is empty.`)
    const found = sha256(bytes)
    if (found !== expected.sha256 || bytes.byteLength !== expected.bytes) {
      return incomplete(`${SHARING_SERVICE_DIST_DIR}/${name} does not match its manifest (SHA-256 ${found}, ${bytes.byteLength} bytes; the manifest says ${expected.sha256}, ${expected.bytes} bytes).`)
    }
  }
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(files.config as Uint8Array).toString('utf8')) } catch { parsed = null }
  const config = readSharingServiceConfig(parsed)
  if (typeof config === 'string') return incomplete(`${SHARING_SERVICE_DIST_DIR}/${manifest.configFile}: ${config}`)
  return { ok: true, manifest, config, bundle: files.bundle as Uint8Array }
}

/**
 * The shipped files, given a reader for one file of the shipped folder (null when it cannot be
 * read). The manifest names the other two. Never throws.
 */
export function readSharingServiceFiles(read: (name: string) => Uint8Array | null): ShippedFiles {
  const manifestBytes = read(MANIFEST_FILE)
  const manifest = manifestBytes ? new TextDecoder().decode(manifestBytes) : null
  let named: Record<string, unknown> = {}
  try {
    const parsed: unknown = manifest ? JSON.parse(manifest) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) named = parsed as Record<string, unknown>
  } catch { /* verifySharingServiceBundle says so */ }
  const file = (name: unknown): Uint8Array | null => (isText(name, FILE) ? read(name) : null)
  return { manifest, bundle: file(named.mainModule), config: file(named.configFile) }
}
