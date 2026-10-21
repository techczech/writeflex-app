// The sharing service's shipped bundle, `sharing-service-dist/`: built once when the app is built,
// checked before it is accepted. Copied from TalkWeaver's scripts/lib/worker-dist.mjs.
//
//   buildSharingServiceDist({ repo, outDir })   compiles sharing-service/ with esbuild into one ES
//                                               module and writes index.js, upload-config.json and
//                                               manifest.json into outDir (replacing what was there);
//   checkSharingServiceDist({ repo, distDir })  the problems that stop a build: the folder or a file
//                                               missing, a file empty, a file that does not match
//                                               the manifest, or a folder older than the sources.
//
// TalkWeaver compiles with a dry-run `wrangler deploy`, which bundles with esbuild. WriteFlex has no
// wrangler dependency, so it calls the esbuild the app already builds with, with the settings wrangler
// uses for a module Worker (ES module, ES2022, `workerd`/`worker`/`browser` conditions). The service
// imports nothing outside its folder, so the bundle is its own sources and nothing else.
//
// "Older than the sources" is decided by content: the manifest records a digest of the sources and
// the esbuild version, and the folder is stale when either has changed since. The digest reads every
// file the compile reads (sharing-service/*.ts except type declarations, wrangler.jsonc) with line
// endings made LF and names sorted, so the same sources give the same digest on every platform.
import { randomBytes } from 'node:crypto'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as esbuild from 'esbuild'
import { MANIFEST_FILE, MANIFEST_FORMAT, readSharingServiceConfig, readSharingServiceFiles, sha256, verifySharingServiceBundle, type SharingServiceManifest } from '../../src/main/sharing-service-bundle.ts'
import { SHARING_SERVICE_BUILD } from '../../sharing-service/version.ts'

export const MAIN_MODULE = 'index.js'
export const CONFIG_FILE = 'upload-config.json'
const UPLOAD_FIELDS = ['name', 'compatibility_date', 'compatibility_flags', 'durable_objects', 'migrations', 'observability']
const SOURCE_EXTRA = ['wrangler.jsonc']

export function serviceDir(repo: string): string {
  return join(repo, 'sharing-service')
}

/** The files the compile reads, by name, sorted. */
export function serviceSourceFiles(dir: string): string[] {
  const ts = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts') && statSync(join(dir, name)).isFile())
  return [...ts, ...SOURCE_EXTRA.filter((name) => existsSync(join(dir, name)))].sort()
}

/** A digest of the service's sources: the same on every platform for the same text. */
export function serviceSourceDigest(dir: string): string {
  const hash = createHash('sha256')
  for (const name of serviceSourceFiles(dir)) {
    const text = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n')
    hash.update(`${name}\0${Buffer.byteLength(text)}\0`).update(text).update('\0')
  }
  return hash.digest('hex')
}

/** JSON with // and /* *\/ comments taken out (outside strings), as wrangler.jsonc is written. */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      out += char
      if (char === '\\') { out += text[i + 1] ?? ''; i += 1 } else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; out += char; continue }
    if (char === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue }
    if (char === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; continue }
    out += char
  }
  return out
}

/** The upload settings (upload-config.json) as bytes, from sharing-service/wrangler.jsonc. */
export function uploadConfigBytes(dir: string): Buffer {
  const parsed = JSON.parse(stripJsonComments(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8'))) as Record<string, unknown>
  if ('vars' in parsed) throw new Error('sharing-service/wrangler.jsonc declares vars: any string bound as ADMIN_SECRET_<id> would be an admin key.')
  const upload = Object.fromEntries(UPLOAD_FIELDS.filter((field) => field in parsed).map((field) => [field, parsed[field]]))
  const checked = readSharingServiceConfig(upload)
  if (typeof checked === 'string') throw new Error(`sharing-service/wrangler.jsonc: ${checked}`)
  return Buffer.from(`${JSON.stringify(upload, null, 2)}\n`)
}

/** Compile the service to one ES module, in memory. */
export function compileSharingService(dir: string, repo: string): Uint8Array {
  const result = esbuild.buildSync({
    entryPoints: [join(dir, 'index.ts')],
    absWorkingDir: repo,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    minify: false,
    sourcemap: false,
    legalComments: 'inline',
    logLevel: 'silent',
  })
  if (result.errors.length > 0) throw new Error(result.errors.map((error) => error.text).join('\n'))
  const file = result.outputFiles[0]
  if (!file || file.contents.byteLength === 0) throw new Error(`compiling the sharing service wrote an empty ${MAIN_MODULE}`)
  return file.contents
}

/** The manifest and file bytes for a bundle. Tests use it to make a shipped folder from any bytes. */
export function sharingServiceDistFiles({ dir, bundle, sources = serviceSourceDigest(dir), compilerVersion = esbuild.version }: { dir: string; bundle: Uint8Array; sources?: string; compilerVersion?: string }) {
  const configBytes = uploadConfigBytes(dir)
  const manifest: SharingServiceManifest = {
    format: MANIFEST_FORMAT,
    compiler: 'esbuild',
    compilerVersion,
    build: SHARING_SERVICE_BUILD,
    mainModule: MAIN_MODULE,
    configFile: CONFIG_FILE,
    files: {
      [MAIN_MODULE]: { sha256: sha256(bundle), bytes: bundle.byteLength },
      [CONFIG_FILE]: { sha256: sha256(configBytes), bytes: configBytes.byteLength },
    },
    sources,
  }
  return { manifest, manifestText: `${JSON.stringify(manifest, null, 2)}\n`, configBytes, bundle }
}

export function writeSharingServiceDist(outDir: string, files: { manifestText: string; configBytes: Uint8Array; bundle: Uint8Array }): void {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, MAIN_MODULE), files.bundle)
  writeFileSync(join(outDir, CONFIG_FILE), files.configBytes)
  writeFileSync(join(outDir, MANIFEST_FILE), files.manifestText)
}

/** Compile and write the folder. Returns the manifest. */
export function buildSharingServiceDist({ repo, outDir }: { repo: string; outDir: string }): SharingServiceManifest {
  const dir = serviceDir(repo)
  const sources = serviceSourceDigest(dir)
  const bundle = compileSharingService(dir, repo)
  const files = sharingServiceDistFiles({ dir, bundle, sources })
  // Written beside, then put in place: a half-written folder is never left where the app looks.
  const staged = `${outDir}.staged-${randomBytes(4).toString('hex')}`
  try {
    writeSharingServiceDist(staged, files)
    mkdirSync(dirname(outDir), { recursive: true })
    rmSync(outDir, { recursive: true, force: true, maxRetries: 5 })
    renameSync(staged, outDir)
  } finally {
    rmSync(staged, { recursive: true, force: true, maxRetries: 5 })
  }
  return files.manifest
}

/** What stops a build, as sentences; empty when the folder is ready to ship. */
export function checkSharingServiceDist({ repo, distDir }: { repo: string; distDir: string }): string[] {
  const how = 'run bun run build:sharing-service'
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) return [`${distDir} is missing: ${how}`]
  if (readdirSync(distDir).length === 0) return [`${distDir} is empty: ${how}`]
  const files = readSharingServiceFiles((name) => (existsSync(join(distDir, name)) ? readFileSync(join(distDir, name)) : null))
  const verified = verifySharingServiceBundle(files.manifest, { bundle: files.bundle, config: files.config })
  if (!verified.ok) return [`${verified.error} ${verified.details}`]
  const problems: string[] = []
  if (verified.manifest.sources !== serviceSourceDigest(serviceDir(repo))) problems.push(`${distDir} is older than the sharing service's sources: ${how}`)
  if (verified.manifest.compilerVersion !== esbuild.version) problems.push(`${distDir} was compiled with esbuild ${verified.manifest.compilerVersion}, and the repository now has ${esbuild.version}: ${how}`)
  return problems
}
