import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

// The caller's temporary directory can be an OS alias (/var on macOS). Fixtures handed
// to app services must use physical paths, just as the real workspace entry boundary does.
test('unit scratch root canonicalises a temporary-directory alias before exporting it', () => {
  const base = mkdtempSync(join(tmpdir(), 'wf-temp-portability-'))
  try {
    const alias = join(base, 'alias')
    symlinkSync(base, alias)
    const helper = resolve(import.meta.dir, '../helpers/test-temp-root.ts')
    const child = Bun.spawnSync([process.execPath, '-e', `
import { realpathSync, existsSync } from 'node:fs';
import { startTestTempRoot, finishTestTempRoot } from ${JSON.stringify(helper)};
const run = startTestTempRoot();
try {
  if (run.root !== realpathSync(run.root)) throw Error('scratch root is an alias');
  if (process.env.TMPDIR !== run.root || process.env.TEMP !== run.root || process.env.TMP !== run.root) throw Error('scratch env differs');
} finally { finishTestTempRoot(run); }
if (existsSync(run.root)) throw Error('scratch root retained');
`], { env: { ...process.env, TMPDIR: alias, TEMP: alias, TMP: alias }, stdout: 'pipe', stderr: 'pipe' })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// Execute the real cleanup function with fake filesystem ports: Windows paths must never
// cause an actual deletion on this host. Also assert the malformed-root refusal survives.
test('unit cleanup accepts Windows separators and refuses a non-root suffix', () => {
  const removals: string[] = []
  const source = readFileSync(resolve(import.meta.dir, '../helpers/test-temp-root.ts'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports: any = {}
  vm.runInNewContext(compiled, { exports, performance, console: { info() {} }, require: (name: string) => {
    if (name === 'node:fs') return { rmSync: (path: string) => removals.push(path), readdirSync: () => [] }
    if (name === './test-run-claims') return {}
    if (name === 'node:os') return { tmpdir }
    if (name === 'node:path') return { join }
    throw Error(`unexpected import ${name}`)
  } })
  const root = String.raw`C:\Temp\wf-run-XfpkVk`
  const run = { root, realTmp: String.raw`C:\Temp`, before: new Set(), startedAt: 0 }
  exports.finishTestTempRoot(run)
  expect(removals).toEqual([root])
  for (const invalid of [root + '\\child', root + '/child', root.replace('wf-run-', 'other-')]) {
    expect(() => exports.finishTestTempRoot({ ...run, root: invalid })).toThrow('missing run identity')
  }
  expect(removals).toEqual([root])
})
