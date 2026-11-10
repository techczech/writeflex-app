import { test, expect } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReaderResources } from '../../src/main/reading-room-resources'
import { readerHostDevelopment } from '../../scripts/reader-host-development'
import { build } from 'vite'
const A = resolve(import.meta.dir, '../..')
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
async function wait(check: () => boolean) {
  const start = performance.now()
  while (!check() && performance.now() - start < 5000) await new Promise(r => setTimeout(r, 10))
  expect(check()).toBe(true)
}
// Use the installed callback bodies verbatim. Only their process boundary is passive.
function installedObserver(project: string, calls: string[]) {
  const installed = readFileSync(A + '/node_modules/electron-vite/dist/chunks/lib-7y7CgM8M.js', 'utf8')
  const hs = installed.indexOf('            const watchHook = () => {')
  const he = installed.indexOf('            await doBuild(', hs)
  const cs = installed.indexOf('            const closeBundle = () => {')
  const ce = installed.indexOf('            config = mergeConfig', cs)
  expect(hs).toBeGreaterThan(0); expect(cs).toBeGreaterThan(0)
  const passive = { removeAllListeners() { calls.push('removeListeners') }, kill() { calls.push('restart') } }
  const callback = new Function('colors', 'logger', 'startElectron', 'inlineConfig', 'ps', 'resolve',
    installed.slice(hs, he) + 'let firstBundle=true;' + installed.slice(cs, ce) + 'return closeBundle')(
      { green: (x: string) => x }, { info() { calls.push('success') } },
      () => { calls.push('start'); return passive }, { root: project }, passive, () => calls.push('initial-launch'))
  return { name: 'vite:electron-watcher', closeBundle: callback }
}
async function fixture(body: (f: any) => Promise<void>) {
  const root = mkdtempSync('/private/tmp/'), identity = statSync(root), project = root + '/p'
  const calls: string[] = [], errors: any[] = [], ends: any[] = []
  let watcher: any, closed = false, refuseOutput = false
  try {
    mkdirSync(project); cpSync(A + '/src', project + '/src', { recursive: true }); mkdirSync(project + '/node_modules')
    for (const name of readdirSync(A + '/node_modules')) if (!['.vite', '.vite-temp', '.cache'].includes(name)) symlinkSync(A + '/node_modules/' + name, project + '/node_modules/' + name)
    writeFileSync(project + '/package.json', '{"type":"module"}')
    const main = project + '/src/main/watch-entry.ts', dependency = project + '/src/shared/reading-room-schema.ts'
    writeFileSync(main, "export {readerHostDirectory} from './reading-room-host-directory';export const ordinaryMain='before'")
    const original = readFileSync(dependency, 'utf8'), mainOriginal = readFileSync(main, 'utf8')
    const output = project + '/out/main/watch-entry.mjs'
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, 'last usable main')
    writeFileSync(project + '/out/main/user-owned.txt', 'retain user output')
    const start = async () => {
      watcher = await build({ configFile: false, root: project, logLevel: 'warn',
        plugins: [readerHostDevelopment(project), { name: 'synthetic-output-refusal', writeBundle() { if (refuseOutput) throw Error('Synthetic completed-stage output hook refusal.') } }, installedObserver(project, calls)],
        build: { outDir: project + '/out/main', watch: {}, lib: { entry: main, formats: ['es'], fileName: () => 'watch-entry.mjs' }, rollupOptions: { external: ['node:path'] } } })
      watcher.on('event', (event: any) => { if (event.code === 'ERROR') errors.push(event.error); if (event.code === 'END') ends.push(event) })
    }
    await body({ project, main, dependency, original, mainOriginal, output, calls, errors, ends, start, setOutputFailure(value: boolean) { refuseOutput = value } })
    expect(readFileSync(project + '/out/main/user-owned.txt', 'utf8')).toBe('retain user output')
  } finally {
    if (watcher) { await watcher.close(); closed = true }
    const evidence = process.env.WRITEFLEX_GUARD_EVIDENCE
    if (evidence) {
      const archive = evidence + '/archive-guard-' + process.env.WRITEFLEX_GUARD_LABEL + '.tar'
      const check = spawnSync('python3', ['-c', "import tarfile,pathlib,sys\nr=pathlib.Path(sys.argv[1]);n=0\nwith tarfile.open(sys.argv[2],'x',dereference=False) as t:t.add(r,arcname='fixture')\nwith tarfile.open(sys.argv[2]) as t:\n for m in t.getmembers():\n  if m.isfile():\n   assert t.extractfile(m).read()==(r/pathlib.Path(*pathlib.PurePosixPath(m.name).parts[1:])).read_bytes();n+=1\nprint(n)", root, archive], { encoding: 'utf8' })
      writeFileSync(archive + '.readback.json', JSON.stringify({ exit: check.status, files: check.stdout, error: check.stderr, root, closed, sha256: hash(readFileSync(archive)) }), { flag: 'wx' })
      if (check.status !== 0) throw Error('Independent readback failed; retain ' + root)
    }
    if (watcher && !closed) throw Error('Watcher close failed; retain ' + root)
    const current = statSync(root)
    if (current.ino !== identity.ino || current.dev !== identity.dev) throw Error('Root identity changed')
    rmSync(root, { recursive: true })
  }
}
test('initial reader failure cannot launch or clear usable main output', async () => {
  await fixture(async (f: any) => {
    writeFileSync(f.dependency, f.original + '\nexport const broken = ;\n')
    await f.start(); await wait(() => f.errors.length === 1)
    console.log(JSON.stringify({ phase: 'initial-failure', calls: f.calls, errors: f.errors.map(String), mainExists: existsSync(f.output), native: false }))
    expect(f.calls).toEqual([])
    expect(readFileSync(f.output, 'utf8')).toBe('last usable main')
  })
}, 20000)
test('finite real watcher preserves running output on host and main failure and recovers once each', async () => {
  await fixture(async (f: any) => {
    writeFileSync(f.dependency, f.original + '\nexport const broken = ;\n')
    await f.start(); await wait(() => f.errors.length === 1)
    expect(f.calls).toEqual([]); expect(readFileSync(f.output, 'utf8')).toBe('last usable main')
    writeFileSync(f.dependency, f.original)
    await wait(() => f.calls.includes('initial-launch'))
    expect(f.calls).toEqual(['initial-launch'])
    const directory = async (n: number) => (await import(f.output + '?generation=' + n)).readerHostDirectory(f.output)
    const vendor = dirname(dirname(realpathSync(A + '/node_modules/@readflex/reader-embed/vendor/reader/reader.html')))
    const first = await directory(0), before = createReaderResources(vendor, first)
    const key = [...before.assets.keys()].find(k => k.startsWith('assets/') && k.endsWith('.js'))!
    const bytes = before.read(key), mainBytes = readFileSync(f.output)
    writeFileSync(f.dependency, f.original + '\nexport const brokenAgain = ;\n')
    await wait(() => f.errors.length === 2)
    expect(f.calls).toEqual(['initial-launch']); expect(readFileSync(f.output)).toEqual(mainBytes); expect(before.read(key)).toEqual(bytes)
    const marker = 'Reader view state prototype refused.'
    expect(f.original).toContain(marker)
    writeFileSync(f.dependency, f.original.replaceAll(marker, 'Reader view state refreshed prototype refused.'))
    await wait(() => f.calls.filter((x: string) => x === 'restart').length === 1)
    const next = await directory(1), after = createReaderResources(vendor, next)
    expect(next).not.toBe(first); expect(after.mapHash).not.toBe(before.mapHash); expect(before.read(key)).toEqual(bytes)
    expect([...after.assets.keys()].filter(k => k.startsWith('reader/') || k.startsWith('lib/'))).toHaveLength(244)
    expect(after.assets.has('index.html')).toBe(false); expect(() => after.read('index.html')).toThrow()
    const served = [...after.assets.keys()].filter(k => k.startsWith('assets/') && k.endsWith('.js')).map(k => after.read(k).toString()).join('\n')
    expect(served).toContain('Reader view state refreshed prototype refused.')
    for (const [k, item] of after.assets) expect(hash(after.read(k))).toBe(item.sha256)
    const usable = readFileSync(f.output)
    f.setOutputFailure(true)
    writeFileSync(f.main, f.mainOriginal.replace("ordinaryMain='before'", "ordinaryMain='refused'"))
    await wait(() => f.errors.length === 3)
    expect(f.calls.filter((x: string) => x === 'restart')).toHaveLength(1); expect(readFileSync(f.output)).toEqual(usable)
    expect(before.read(key)).toEqual(bytes)
    f.setOutputFailure(false)
    writeFileSync(f.main, f.mainOriginal.replace("ordinaryMain='before'", "ordinaryMain='after'"))
    await wait(() => f.calls.filter((x: string) => x === 'restart').length === 2)
    expect((await import(f.output + '?generation=2')).ordinaryMain).toBe('after')
    await wait(() => f.ends.length >= 6)
    expect(f.calls.filter((x: string) => x === 'initial-launch')).toHaveLength(1)
    expect(f.calls.filter((x: string) => x === 'restart')).toHaveLength(2)
    const config = readFileSync(A + '/electron.vite.config.ts', 'utf8')
    const entry = process.env.WRITEFLEX_GUARD_EVIDENCE ? readFileSync(process.env.WRITEFLEX_GUARD_EVIDENCE + '/source-entry/electron.vite.config.ts', 'utf8') : config
    expect(config.slice(config.indexOf('  preload:'))).toBe(entry.slice(entry.indexOf('  preload:')))
    console.log(JSON.stringify({ phase: 'finite-recovery', calls: f.calls, errors: f.errors.map(String), first, next, oldMap: before.mapHash, newMap: after.mapHash, oldMainPreserved: true, oldMapStable: true, native: false }))
  })
}, 20000)
