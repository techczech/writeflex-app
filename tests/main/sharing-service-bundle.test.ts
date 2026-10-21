// The sharing service's shipped bundle: the build writes the bundle, its upload settings and a
// manifest with each file's SHA-256 and size; the manifest check refuses a damaged, incomplete,
// stale or mismatched folder; the app's packaging ships the folder. Then the request-handler suite
// runs against the built bundle itself, so what ships is what was tested.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CONFIG_FILE, MAIN_MODULE, buildSharingServiceDist, checkSharingServiceDist, serviceDir, sharingServiceDistFiles, writeSharingServiceDist,
} from '../../scripts/lib/sharing-service-dist.ts'
import {
  INSTALLATION_INCOMPLETE, MANIFEST_FILE, SHARING_SERVICE_DIST_DIR, readSharingServiceFiles, sha256, verifySharingServiceBundle,
} from '../../src/main/sharing-service-bundle.ts'
import { SHARING_SERVICE_BUILD } from '../../sharing-service/version.ts'
import { runSharingServiceHandlerSuite } from '../helpers/sharing-service-handler-suite.ts'
import type { ServiceModule } from '../helpers/sharing-service-runtime.ts'

const repo = resolve(import.meta.dir, '..', '..')
let scratch = ''
let built = ''

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'writeflex-sharing-dist-'))
  built = join(scratch, SHARING_SERVICE_DIST_DIR)
  buildSharingServiceDist({ repo, outDir: built })
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function shipped(dir: string) {
  return readSharingServiceFiles((name) => { try { return readFileSync(join(dir, name)) } catch { return null } })
}

/** A copy of the built folder, with one file changed by `change`. */
function tampered(name: string, change: (bytes: Buffer) => Buffer): string {
  const dir = mkdtempSync(join(scratch, 'tampered-'))
  for (const file of [MAIN_MODULE, CONFIG_FILE, MANIFEST_FILE]) writeFileSync(join(dir, file), readFileSync(join(built, file)))
  writeFileSync(join(dir, name), change(readFileSync(join(dir, name))))
  return dir
}

describe('the build', () => {
  test('writes the bundle, its upload settings and a manifest with SHA-256 and size of each', () => {
    const manifest = JSON.parse(readFileSync(join(built, MANIFEST_FILE), 'utf8'))
    const bundle = readFileSync(join(built, MAIN_MODULE))
    const config = readFileSync(join(built, CONFIG_FILE))
    expect(manifest).toMatchObject({ format: 1, compiler: 'esbuild', build: SHARING_SERVICE_BUILD, mainModule: MAIN_MODULE, configFile: CONFIG_FILE })
    expect(manifest.files[MAIN_MODULE]).toEqual({ sha256: sha256(bundle), bytes: bundle.byteLength })
    expect(manifest.files[CONFIG_FILE]).toEqual({ sha256: sha256(config), bytes: config.byteLength })
    expect(JSON.parse(config.toString('utf8'))).toMatchObject({
      name: 'writeflex-sharing',
      durable_objects: { bindings: [{ name: 'SHARES', class_name: 'SharedPiece' }, { name: 'SHARING_REGISTRY', class_name: 'SharingRegistry' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['SharedPiece', 'SharingRegistry'] }],
    })
    expect(JSON.parse(config.toString('utf8'))).not.toHaveProperty('vars')
    expect(checkSharingServiceDist({ repo, distDir: built })).toEqual([])
    expect(verifySharingServiceBundle(shipped(built).manifest, shipped(built)).ok).toBe(true)
  })

  test('gives the same bytes from the same sources', () => {
    const again = join(scratch, 'again')
    buildSharingServiceDist({ repo, outDir: again })
    for (const file of [MAIN_MODULE, CONFIG_FILE, MANIFEST_FILE]) expect(readFileSync(join(again, file))).toEqual(readFileSync(join(built, file)))
  })

  test('the bundle imports nothing: the service is its own sources', () => {
    const text = readFileSync(join(built, MAIN_MODULE), 'utf8')
    expect(text).not.toMatch(/^\s*import\s/m)
    expect(text).not.toMatch(/\brequire\(/)
  })
})

describe('the manifest check', () => {
  const refused = (dir: string) => {
    const files = shipped(dir)
    const result = verifySharingServiceBundle(files.manifest, files)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('accepted')
    expect(result.error).toBe(INSTALLATION_INCOMPLETE)
    return result.details
  }

  test('refuses a bundle with one byte changed, one byte added, or the bytes of another build', () => {
    expect(refused(tampered(MAIN_MODULE, (b) => { const c = Buffer.from(b); c[100] = c[100] ^ 1; return c }))).toContain(`${SHARING_SERVICE_DIST_DIR}/${MAIN_MODULE} does not match its manifest`)
    expect(refused(tampered(MAIN_MODULE, (b) => Buffer.concat([b, Buffer.from('\n')])))).toContain('does not match its manifest')
    expect(refused(tampered(MAIN_MODULE, (b) => Buffer.from(b.toString('utf8').replace('Made with WriteFlex', 'Made with WriteFlux'))))).toContain('does not match its manifest')
    expect(checkSharingServiceDist({ repo, distDir: tampered(MAIN_MODULE, (b) => Buffer.concat([b, Buffer.from('//')])) })[0]).toContain(INSTALLATION_INCOMPLETE)
  })

  test('refuses changed upload settings, a missing or empty file, and a manifest that is not one', () => {
    expect(refused(tampered(CONFIG_FILE, (b) => Buffer.from(b.toString('utf8').replace('writeflex-sharing', 'writeflex-sharinh'))))).toContain(`${CONFIG_FILE} does not match its manifest`)
    expect(refused(tampered(MAIN_MODULE, () => Buffer.alloc(0)))).toContain(`${MAIN_MODULE} is empty`)
    expect(refused(tampered(MANIFEST_FILE, () => Buffer.from('{')))).toContain('is not readable')
    expect(refused(tampered(MANIFEST_FILE, (b) => Buffer.from(b.toString('utf8').replace('"format": 1', '"format": 2'))))).toContain('is not one this version of WriteFlex reads')
    const files = shipped(built)
    expect(verifySharingServiceBundle(files.manifest, { ...files, bundle: null }).ok).toBe(false)
    expect(verifySharingServiceBundle(null, files).ok).toBe(false)
  })

  test('refuses a manifest whose hashes were rewritten to fit a changed bundle when it is for another build', () => {
    const files = shipped(built)
    const manifest = JSON.parse(files.manifest as string)
    const result = verifySharingServiceBundle(JSON.stringify({ ...manifest, build: SHARING_SERVICE_BUILD + 1 }), files)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.details).toContain(`holds sharing service build ${SHARING_SERVICE_BUILD + 1}`)
  })

  test('the build refuses a folder older than the sources', () => {
    const dir = join(scratch, 'stale')
    const bundle = readFileSync(join(built, MAIN_MODULE))
    writeSharingServiceDist(dir, sharingServiceDistFiles({ dir: serviceDir(repo), bundle, sources: '0'.repeat(64) }))
    expect(verifySharingServiceBundle(shipped(dir).manifest, shipped(dir)).ok).toBe(true)
    expect(checkSharingServiceDist({ repo, distDir: dir })).toEqual([`${dir} is older than the sharing service's sources: run bun run build:sharing-service`])
    expect(checkSharingServiceDist({ repo, distDir: join(scratch, 'nowhere') })[0]).toContain('is missing')
  })
})

describe('packaging', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

  test('ships the folder as an extra resource', () => {
    expect(pkg.build.extraResources).toContainEqual({ from: SHARING_SERVICE_DIST_DIR, to: SHARING_SERVICE_DIST_DIR })
  })

  test('every app build builds and checks the bundle before the app is made', () => {
    // `build` and every script that runs electron-builder; one that starts with `bun run build` gets the bundle from it.
    const builds = Object.entries(pkg.scripts as Record<string, string>).filter(([name, command]) => name === 'build' || command.includes('electron-builder'))
    expect(builds.map(([name]) => name)).toContain('build')
    for (const [name, command] of builds) {
      if (name !== 'build' && command.startsWith('bun run build && ')) continue
      expect(command).toContain('bun run build:sharing-service')
      expect(command.indexOf('bun run build:sharing-service')).toBeLessThan(command.indexOf('electron-vite build'))
    }
    expect(pkg.scripts['build:sharing-service']).toBe('bun scripts/build-sharing-service.ts')
  })

  test('the built folder is not committed', () => {
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toMatch(/^sharing-service-dist\/$/m)
  })
})

runSharingServiceHandlerSuite('built bundle', async () => await import(pathToFileURL(join(built, MAIN_MODULE)).href) as ServiceModule)
