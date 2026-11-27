import { test, expect } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReaderResources } from '../../src/main/reading-room-resources'
import { readerHostDevelopment } from '../../scripts/reader-host-development'
import { build } from 'vite'
import { waitForWatch } from '../helpers/watch-test-target.mjs'
const A = resolve(import.meta.dir, '../..')
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
// On the Studio at peak load 27.2, recovery was still building at the old 5 s
// deadline. Allow 12 s per real Rollup rebuild while keeping every phase bounded.
const waitForBuild = (check: () => boolean, phase: string) => waitForWatch(check, phase, 12000)
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
  const root = mkdtempSync(join(tmpdir(), 'wf-reader-watch-')), identity = statSync(root), project = root + '/p'
  const calls: string[] = [], errors: any[] = [], ends: any[] = []
  let watcher: any, closed = false, refuseOutput = false
  const invalidations = new Map<string, number>()
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
      // Keep the real Rollup watcher while avoiding the runner's unreliable FSEvents delivery.
      watcher = await build({ configFile: false, root: project, logLevel: 'warn',
        plugins: [readerHostDevelopment(project), { name: 'synthetic-output-refusal', writeBundle() { if (refuseOutput) throw Error('Synthetic completed-stage output hook refusal.') } }, installedObserver(project, calls)],
        build: { outDir: project + '/out/main', watch: {
          buildDelay: 100,
          chokidar: { usePolling: true },
          onInvalidate(path) { invalidations.set(path, (invalidations.get(path) ?? 0) + 1) },
        }, lib: { entry: main, formats: ['es'], fileName: () => 'watch-entry.mjs' }, rollupOptions: { external: ['node:path'] } } })
      watcher.on('event', (event: any) => { if (event.code === 'ERROR') errors.push(event.error); if (event.code === 'END') ends.push(event) })
    }
    const rebuild = async (path: string, text: string, phase: string) => {
      const before = invalidations.get(path) ?? 0
      const nextEnd = ends.length + 1
      writeFileSync(path, text)
      let stamp = statSync(path).mtimeMs
      // END can precede Chokidar's first stat of a newly added path after a build error.
      // Keep the edited bytes stable and advance the mtime until Rollup sees the edit.
      const touch = setInterval(() => {
        if ((invalidations.get(path) ?? 0) !== before) return
        stamp += 1000
        utimesSync(path, stamp / 1000, stamp / 1000)
      }, 150)
      try { await waitForBuild(() => ends.length >= nextEnd, phase) }
      finally { clearInterval(touch) }
      expect(invalidations.get(path)).toBeGreaterThan(before)
    }
    await body({ rebuild, project, main, dependency, original, mainOriginal, output, calls, errors, ends, start, setOutputFailure(value: boolean) { refuseOutput = value } })
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
    await f.start()
    await waitForBuild(() => f.ends.length >= 1, 'the initial invalid host build')
    expect(f.errors).toHaveLength(1)
    console.log(JSON.stringify({ phase: 'initial-failure', calls: f.calls, errors: f.errors.map(String), mainExists: existsSync(f.output), native: false }))
    expect(f.calls).toEqual([])
    expect(readFileSync(f.output, 'utf8')).toBe('last usable main')
  })
}, 20000)
test('finite real watcher preserves running output on host and main failure and recovers once each', async () => {
  await fixture(async (f: any) => {
    writeFileSync(f.dependency, f.original + '\nexport const broken = ;\n')
    await f.start()
    await waitForBuild(() => f.ends.length >= 1, 'the initial invalid host build')
    expect(f.errors).toHaveLength(1)
    expect(f.calls).toEqual([]); expect(readFileSync(f.output, 'utf8')).toBe('last usable main')
    await f.rebuild(f.dependency, f.original, 'the repaired host build')
    expect(f.errors).toHaveLength(1)
    expect(f.calls).toEqual(['initial-launch'])
    const directory = async (n: number) => (await import(f.output + '?generation=' + n)).readerHostDirectory(f.output)
    const vendor = dirname(dirname(realpathSync(A + '/node_modules/@readflex/reader-embed/vendor/reader/reader.html')))
    const first = await directory(0), before = createReaderResources(vendor, first)
    const key = [...before.assets.keys()].find(k => k.startsWith('assets/') && k.endsWith('.js'))!
    const bytes = before.read(key), mainBytes = readFileSync(f.output)
    await f.rebuild(f.dependency, f.original + '\nexport const brokenAgain = ;\n', 'the invalid running host build')
    expect(f.errors).toHaveLength(2)
    expect(f.calls).toEqual(['initial-launch']); expect(readFileSync(f.output)).toEqual(mainBytes); expect(before.read(key)).toEqual(bytes)
    const marker = 'Reader view state prototype refused.'
    expect(f.original).toContain(marker)
    await f.rebuild(f.dependency, f.original.replaceAll(marker, 'Reader view state refreshed prototype refused.'), 'the refreshed host build')
    expect(f.errors).toHaveLength(2)
    expect(f.calls.filter((x: string) => x === 'restart')).toHaveLength(1)
    const next = await directory(1), after = createReaderResources(vendor, next)
    expect(next).not.toBe(first); expect(after.mapHash).not.toBe(before.mapHash); expect(before.read(key)).toEqual(bytes)
    expect([...after.assets.keys()].filter(k => k.startsWith('reader/') || k.startsWith('lib/'))).toHaveLength(244)
    expect(after.assets.has('index.html')).toBe(false); expect(() => after.read('index.html')).toThrow()
    const served = [...after.assets.keys()].filter(k => k.startsWith('assets/') && k.endsWith('.js')).map(k => after.read(k).toString()).join('\n')
    expect(served).toContain('Reader view state refreshed prototype refused.')
    for (const [k, item] of after.assets) expect(hash(after.read(k))).toBe(item.sha256)
    const usable = readFileSync(f.output)
    f.setOutputFailure(true)
    await f.rebuild(f.main, f.mainOriginal.replace("ordinaryMain='before'", "ordinaryMain='refused'"), 'the refused main output')
    expect(f.errors).toHaveLength(3)
    expect(f.calls.filter((x: string) => x === 'restart')).toHaveLength(1); expect(readFileSync(f.output)).toEqual(usable)
    expect(before.read(key)).toEqual(bytes)
    f.setOutputFailure(false)
    await f.rebuild(f.main, f.mainOriginal.replace("ordinaryMain='before'", "ordinaryMain='after'"), 'the repaired main output')
    expect(f.errors).toHaveLength(3)
    expect((await import(f.output + '?generation=2')).ordinaryMain).toBe('after')
    expect(f.calls.filter((x: string) => x === 'initial-launch')).toHaveLength(1)
    expect(f.calls.filter((x: string) => x === 'restart')).toHaveLength(2)
    const config = readFileSync(A + '/electron.vite.config.ts', 'utf8')
    const entry = process.env.WRITEFLEX_GUARD_EVIDENCE ? readFileSync(process.env.WRITEFLEX_GUARD_EVIDENCE + '/source-entry/electron.vite.config.ts', 'utf8') : config
    expect(config.slice(config.indexOf('  preload:'))).toBe(entry.slice(entry.indexOf('  preload:')))
    console.log(JSON.stringify({ phase: 'finite-recovery', calls: f.calls, errors: f.errors.map(String), first, next, oldMap: before.mapHash, newMap: after.mapHash, oldMainPreserved: true, oldMapStable: true, native: false }))
  })
// Six real builds plus fixture I/O. The contended Studio completed all six in
// 7.2 s on 25 Nov. Keep the test deadline above two slow build phases and cleanup.
}, 35000)
