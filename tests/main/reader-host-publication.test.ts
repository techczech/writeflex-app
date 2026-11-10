import { test, expect } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
test('publication copy refusal is observed, retains a usable complete bundle and recovers exactly once', async () => {
  await fixture(async (f: any) => {
    const chunks = f.project + '/src/main/z-chunks'
    mkdirSync(chunks)
    writeFileSync(chunks + '/old.ts', 'export const value="old chunk"')
    writeFileSync(chunks + '/next.ts', 'export const value="new chunk"')
    const source = (name: string) => `export {readerHostDirectory} from './reading-room-host-directory';export const load=()=>import('./z-chunks/${name}')`
    writeFileSync(f.main, source('old'))
    await f.start(); await wait(() => f.calls.includes('initial-launch'))
    const oldModule = await import(f.output + '?publication=old')
    expect((await oldModule.load()).value).toBe('old chunk')
    const oldDirectory = oldModule.readerHostDirectory()
    const vendor = dirname(dirname(realpathSync(A + '/node_modules/@readflex/reader-embed/vendor/reader/reader.html')))
    const oldMap = createReaderResources(vendor, oldDirectory)
    const oldEntry = readFileSync(f.output)
    const oldChunkName = readdirSync(dirname(f.output)).find((n: string) => n.startsWith('old-'))!
    expect(oldChunkName).toBeDefined()
    const oldChunk = readFileSync(dirname(f.output) + '/' + oldChunkName)
    // The retained failure was a later member's EACCES after entry overwrite.
    // Refuse publication copying in our owned directory; require the usable bundle,
    // irrespective of whether the publisher copies individual files or directories.
    const outputDirectory = dirname(f.output)
    chmodSync(dirname(outputDirectory), 0o500)
    try {
      writeFileSync(f.main, source('next'))
      writeFileSync(f.dependency, f.original.replaceAll('Reader view state prototype refused.', 'Reader view state publication recovered.'))
      await wait(() => f.errors.length === 1)
      expect(String(f.errors[0])).toContain('EACCES')
      expect(f.calls).toEqual(['initial-launch'])
      expect(readFileSync(f.output)).toEqual(oldEntry)
      expect(readFileSync(outputDirectory + '/' + oldChunkName)).toEqual(oldChunk)
      expect((await oldModule.load()).value).toBe('old chunk')
    } finally { chmodSync(dirname(outputDirectory), 0o700) }
    writeFileSync(f.main, source('next') + ';export const corrected=true')
    await wait(() => f.calls.filter((x: string) => x === 'restart').length === 1)
    const nextModule = await import(f.output + '?publication=next')
    expect((await nextModule.load()).value).toBe('new chunk')
    expect(readFileSync(f.output)).not.toEqual(oldEntry)
    expect(nextModule.readerHostDirectory()).not.toBe(oldDirectory)
    const nextMap = createReaderResources(vendor, nextModule.readerHostDirectory())
    expect(nextMap.assets.size).toBe(oldMap.assets.size)
    expect(nextMap.mapHash).not.toBe(oldMap.mapHash)
    for (const [key, item] of nextMap.assets) expect(hash(nextMap.read(key))).toBe(item.sha256)
    expect(f.calls.filter((x: string) => x === 'restart')).toHaveLength(1)
    expect(f.errors).toHaveLength(1)
    console.log(JSON.stringify({phase:'publication-recovery',calls:f.calls,errors:f.errors.map(String),oldEntryHash:hash(oldEntry),oldChunkHash:hash(oldChunk),oldDirectory,nextDirectory:nextModule.readerHostDirectory(),oldMap:oldMap.mapHash,newMap:nextMap.mapHash,native:false}))
  })
}, 20000)

import { renameSync } from 'node:fs'
import { publishReaderMain, ReaderPublicationRecoveryError } from '../../scripts/reader-main-publication'

for (const refusal of ['copy', 'retire', 'commit', 'rollback'] as const) {
  test(`directory publication preserves old bundle on ${refusal} refusal`, () => {
    const root = mkdtempSync('/private/tmp/'), identity = statSync(root)
    const stage = root + '/stage', output = root + '/main'
    try {
      for (const path of [stage, output]) { mkdirSync(path); mkdirSync(path + '/z-chunks') }
      const old = "export {value} from './z-chunks/old.mjs'", next = "export {value} from './z-chunks/new.mjs'"
      writeFileSync(output + '/entry.mjs', old); writeFileSync(output + '/z-chunks/old.mjs', 'export const value="old"')
      writeFileSync(output + '/unrelated.txt', 'retain')
      writeFileSync(stage + '/entry.mjs', next); writeFileSync(stage + '/z-chunks/new.mjs', 'export const value="new"')
      let renames = 0, failure: any
      const io = {
        copy: ((source: string, target: string, options: any) => {
          if (refusal === 'copy' && source === stage) {
            // A real earlier member copy succeeds before the finite EACCES.
            cpSync(stage + '/entry.mjs', target + '/entry.mjs')
            throw Object.assign(new Error('finite staging chunk copy refusal'), { code: 'EACCES' })
          }
          cpSync(source, target, options)
        }) as typeof cpSync,
        rename: ((source: string, target: string) => {
          renames++
          if ((refusal === 'retire' && renames === 1) || (['commit', 'rollback'].includes(refusal) && renames === 2) || (refusal === 'rollback' && renames === 3)) throw Error('finite ' + refusal + ' rename refusal')
          renameSync(source, target)
        }) as typeof renameSync,
      }
      try { publishReaderMain(stage, output, io) } catch (error) { failure = error }
      expect(failure).toBeDefined()
      const authority = refusal === 'rollback' ? failure.authority : output
      if (refusal === 'rollback') {
        expect(failure).toBeInstanceOf(ReaderPublicationRecoveryError)
        expect(existsSync(output)).toBe(false)
        expect(String(failure)).toContain(authority)
      }
      expect(readFileSync(authority + '/entry.mjs', 'utf8')).toBe(old)
      expect(readFileSync(authority + '/z-chunks/old.mjs', 'utf8')).toBe('export const value="old"')
      expect(readFileSync(authority + '/unrelated.txt', 'utf8')).toBe('retain')
      expect(existsSync(authority + '/z-chunks/new.mjs')).toBe(false)
      if (refusal === 'rollback') renameSync(authority, output) // Explicit test-owned recovery, not automatic publication.
      publishReaderMain(stage, output)
      expect(readFileSync(output + '/entry.mjs', 'utf8')).toBe(next)
      expect(readFileSync(output + '/z-chunks/new.mjs', 'utf8')).toBe('export const value="new"')
      expect(readFileSync(output + '/unrelated.txt', 'utf8')).toBe('retain')
      console.log(JSON.stringify({phase:refusal,error:String(failure),authority,oldBundleComplete:true,correctedBundleComplete:true}))
    } finally {
      const evidence = process.env.WRITEFLEX_GUARD_EVIDENCE
      if (evidence) {
        const archive = evidence + '/archive-publication-' + process.env.WRITEFLEX_GUARD_LABEL + '-' + refusal + '.tar'
        const check = spawnSync('python3', ['-B', '-c', "import tarfile,pathlib,sys\nr=pathlib.Path(sys.argv[1]);n=0\nwith tarfile.open(sys.argv[2],'x',dereference=False) as t:t.add(r,arcname='fixture')\nwith tarfile.open(sys.argv[2]) as t:\n for m in t.getmembers():\n  if m.isfile():\n   assert t.extractfile(m).read()==(r/pathlib.Path(*pathlib.PurePosixPath(m.name).parts[1:])).read_bytes();n+=1\nprint(n)", root, archive], {encoding:'utf8'})
        writeFileSync(archive + '.readback.json', JSON.stringify({exit:check.status,files:check.stdout,error:check.stderr,root,sha256:hash(readFileSync(archive))}), {flag:'wx'})
        if (check.status !== 0) throw Error('Independent archive readback failed; retain ' + root)
      }
      const current = statSync(root)
      if (current.ino !== identity.ino || current.dev !== identity.dev) throw Error('Root identity changed')
      rmSync(root, { recursive: true })
    }
  })
}
