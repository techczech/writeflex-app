// Builds the WriteFlex backup helper (src/backup-helper/writeflex-helper.ts) to
// out/backup-helper/writeflex-backup-helper.js: one self-contained file for Node with every package
// bundled in. Main starts it as a separate process (Electron in Node mode); electron-builder stages it
// outside app.asar as Resources/vault-sync-helper/. Fails when the bundle imports anything but Node's own
// modules or names a path of this checkout.
import { backupHelperInputPlugin, verifyBackupHelperInputs } from './lib/backup-helper-inputs'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const input = verifyBackupHelperInputs(root)
console.log(`verified backup helper input ${input.archiveSha256} (${input.members} members)`)
const outdir = join(root, 'out', 'backup-helper')
const result = await Bun.build({
  plugins: [backupHelperInputPlugin(input)],
  entrypoints: [join(root, 'src', 'backup-helper', 'writeflex-helper.ts')],
  outdir,
  naming: 'writeflex-backup-helper.js',
  target: 'node',
  format: 'esm',
  minify: false,
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
if (!input.consumed.has(input.host)) throw new Error('authenticated helper host was not consumed by Bun')
console.log(JSON.stringify({ archiveSha256: input.archiveSha256, bundledHelperInputs: [...input.consumed].sort().map(path => ({ path: path.slice(input.directory.length + 1), sha256: createHash('sha256').update(input.contents.get(path)!).digest('hex') })) }))
const file = join(outdir, 'writeflex-backup-helper.js')
const text = readFileSync(file, 'utf8')
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))
const imports = [...text.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?from\s+)?["']([^"']+)["']/g), ...text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g), ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!)
const foreign = [...new Set(imports.filter((s) => !builtins.has(s)))]
if (foreign.length > 0) {
  console.error(`the backup helper bundle imports more than Node's own modules: ${foreign.join(', ')}`)
  process.exit(1)
}
if (text.includes(root)) {
  console.error('the backup helper bundle names a path of this checkout')
  process.exit(1)
}
console.log(`built ${file} (${text.length} bytes; imports: ${[...new Set(imports)].sort().join(', ')})`)
