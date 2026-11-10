// Build boundary only: never repairs an install or executes helper code.
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { readTarGz, sha256, sri512, type TarFile } from './pi-undici-derivative'

export const HELPER_INPUT = Object.freeze({
  name: '@app-patterns/vault-sync',
  spec: 'file:./vendor/app-patterns/app-patterns-vault-sync-0.5.1.tgz',
  sha256: '6084d38d35f09f2241852cd9bf9090188071a836f967c309c4006868504d72ef',
  integrity: 'sha512-/BuGiNSK0JQVFPE8xZxhG2Azvfo4Y76kA9Y+ADMdpYwI1T+vkwtzh4rmQgnPJxmObUTgldSMc980/S3WKrCxng==',
  host: 'dist/helper/host.js',
})
function fail(message: string): never { throw new Error(`backup helper input refused: ${message}`) }

// The existing canonical Pi reader handles paths/checksums/duplicates/regular-file types.
// Validate framing, bounds and full modes first without changing that historical recipe.
export function readHelperArchive(archive: Uint8Array): TarFile[] {
  if (archive.length > 4 * 1024 * 1024) fail('archive size')
  const tar = gunzipSync(archive, { maxOutputLength: 32 * 1024 * 1024 })
  if (tar.length % 512 !== 0) fail('truncated tar block')
  let off = 0
  for (; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512)
    if (h.every(b => b === 0)) break
    const octal = (at: number, len: number) => {
      const raw = h.subarray(at, at + len).toString('ascii')
      if (!/^[0-7]+[\x00 ]+$/.test(raw)) fail('malformed tar numeric field')
      const n = parseInt(raw, 8)
      if (!Number.isSafeInteger(n)) fail('tar numeric overflow')
      return n
    }
    const size = octal(124, 12), mode = octal(100, 8)
    if (mode !== 0o644 && mode !== 0o755) fail('unsupported archive mode')
    if (h.subarray(157, 257).some(b => b !== 0)) fail('archive link target')
    if (h.subarray(257, 263).toString('ascii') !== 'ustar\0') fail('unsupported tar format')
    // Fatal UTF-8 decoding avoids aliases created by replacement characters.
    for (const [at, len] of [[0, 100], [345, 155]]) {
      const field = h.subarray(at, at + len), end = field.indexOf(0)
      if (end !== -1 && field.subarray(end).some(b => b !== 0)) fail('malformed tar path field')
      new TextDecoder('utf-8', { fatal: true }).decode(end === -1 ? field : field.subarray(0, end))
    }
    const next = off + 512 + Math.ceil(size / 512) * 512
    if (next > tar.length || tar.subarray(off + 512 + size, next).some(b => b !== 0)) fail('truncated data or nonzero padding')
    off = next
  }
  if (tar.length - off < 1024 || tar.subarray(off).some(b => b !== 0)) fail('missing tar terminator or trailing data')
  const files = readTarGz(archive)
  if (!files.length) fail('empty archive')
  // Case-fold collisions would alias on the target macOS filesystem.
  if (new Set(files.map(f => f.path.toLowerCase())).size !== files.length) fail('case-folded path collision')
  return files
}

function plainPath(root: string, path: string, leaf: 'file' | 'directory'): void {
  const rel = relative(root, path)
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || resolve(root, rel) !== path) fail('path boundary')
  const parts = rel.split(sep)
  let current = root
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!)
    const st = lstatSync(current)
    const file = i === parts.length - 1 && leaf === 'file'
    if (st.isSymbolicLink() || (file ? !st.isFile() : !st.isDirectory())) fail(`non-${file ? 'regular file' : 'directory'}: ${current}`)
  }
}

export function compareHelperPackage(directory: string, files: TarFile[]): Map<string, Uint8Array> {
  if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) fail(`package path alias: ${directory}`)
  const expected = new Map(files.map(f => [f.path.slice('package/'.length), f]))
  const seen = new Set<string>()
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), rel = relative(directory, path), st = lstatSync(path)
      if (st.isSymbolicLink()) fail(`installed link: ${path}`)
      if (st.isDirectory()) {
        if (![...expected.keys()].some(k => k.startsWith(`${rel}/`))) fail(`unexpected directory: ${path}`)
        walk(path)
      } else {
        const f = expected.get(rel)
        if (!st.isFile() || !f) fail(`unexpected installed member: ${path}`)
        // Bun 1.3.10 local tar materialisation adds group/other write bits (0644 -> 0666).
        // Preserve the restored 0644 files too; execute/special bits must still match exactly.
        const mode = st.mode & 0o7777
        if (mode !== f.mode && mode !== (f.mode | 0o022)) fail(`installed mode mismatch: ${path}`)
        if (!Buffer.from(f.data).equals(readFileSync(path))) fail(`installed content mismatch: ${path}`)
        seen.add(rel)
      }
    }
  }
  walk(directory)
  for (const name of expected.keys()) if (!seen.has(name)) fail(`missing installed member: ${join(directory, name)}`)
  return new Map([...expected].map(([name, f]) => [join(directory, name), f.data]))
}

export function verifyBackupHelperInputs(root: string) {
  root = realpathSync(root)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lock = Bun.JSONC.parse(readFileSync(join(root, 'bun.lock'), 'utf8')) as any
  const tuple = lock.packages?.[HELPER_INPUT.name]
  if (manifest.devDependencies?.[HELPER_INPUT.name] !== HELPER_INPUT.spec ||
      manifest.dependencies?.[HELPER_INPUT.name] !== undefined || manifest.overrides?.[HELPER_INPUT.name] !== undefined ||
      lock.workspaces?.['']?.devDependencies?.[HELPER_INPUT.name] !== HELPER_INPUT.spec ||
      !Array.isArray(tuple) || tuple.length !== 3 ||
      tuple[0] !== `${HELPER_INPUT.name}@${HELPER_INPUT.spec.slice('file:'.length)}` || tuple[2] !== HELPER_INPUT.integrity) fail('manifest/lock binding mismatch')
  const archivePath = resolve(root, HELPER_INPUT.spec.slice('file:'.length))
  plainPath(root, archivePath, 'file')
  const archive = readFileSync(archivePath)
  if (sha256(archive) !== HELPER_INPUT.sha256 || sri512(archive) !== HELPER_INPUT.integrity) fail('vendor digest/SRI mismatch')
  const files = readHelperArchive(archive)
  if (files.length !== 53) fail('archive member count')
  const directory = join(root, 'node_modules', '@app-patterns', 'vault-sync')
  plainPath(root, directory, 'directory')
  const contents = compareHelperPackage(directory, files)
  const host = join(directory, HELPER_INPUT.host)
  const selected = Bun.resolveSync(`${HELPER_INPUT.name}/helper/host`, join(root, 'src/backup-helper'))
  if (selected !== host || !contents.has(selected)) fail('selected helper export mismatch')
  return { directory, host, contents, archiveSha256: HELPER_INPUT.sha256, members: files.length, consumed: new Set<string>() }
}

// Serve authenticated bytes to Bun, closing the verification-to-read gap. Default resolver still
// follows the authenticated package's internal relative imports; unverified members are refused.
export function backupHelperInputPlugin(input: ReturnType<typeof verifyBackupHelperInputs>): Bun.BunPlugin {
  return { name: 'authenticated-backup-helper', setup(build) {
    build.onResolve({ filter: /^@app-patterns\/vault-sync(?:\/|$)/ }, args => {
      if (args.path !== `${HELPER_INPUT.name}/helper/host`) fail('unrecognised helper import')
      return { path: input.host }
    })
    build.onLoad({ filter: /.*/ }, args => {
      if (!args.path.startsWith(`${input.directory}${sep}`)) return
      const contents = input.contents.get(args.path)
      if (!contents || !args.path.endsWith('.js')) fail(`unverified bundle member: ${args.path}`)
      input.consumed.add(args.path)
      return { contents, loader: 'js' }
    })
  } }
}
