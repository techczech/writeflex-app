import { test, expect } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BETA_BUNDLE_ID, STABLE_BUNDLE_ID, SHIM_MARKER, WHICH_APP_FLAG, bundleIdentifierFor, generateShim, installShim } from '../../src/main/cli/shim'

/** `/bin/sh -n` is given this long; a shim written by a test is never timed (`runWritten`). */
const RUN_MS = 20_000
const TEST_MS = 60_000
/** `sh -n`: the script is parsed and nothing in it runs. */
const parses = (script: string): boolean => spawnSync('/bin/sh', ['-n', '/dev/stdin'], { input: script, encoding: 'utf8', timeout: RUN_MS }).status === 0

/**
 * Run a program this test has just written and wait until it ends. No clock: the first start of a new
 * executable can stall on this machine while the system looks at it, so the only limit is the test's own.
 */
async function runWritten(path: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const status = await new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('close', done) })
  return { status, stdout, stderr }
}

test('the shim finds the app by bundle identifier, never a fixed path, and passes arguments through', () => {
  const shim = generateShim(STABLE_BUNDLE_ID)
  expect(shim).toContain(`BUNDLE_ID='${STABLE_BUNDLE_ID}'`)
  expect(shim).toContain('/usr/bin/mdfind "kMDItemCFBundleIdentifier ==')
  expect(shim).toContain('exec "$app/Contents/MacOS/$exe"')
  expect(shim).toContain('ELECTRON_RUN_AS_NODE=1')
  expect(shim).toContain('"$@"')
  expect(shim).not.toMatch(/'\/Applications\/WriteFlex\.app/)
  expect(parses(shim)).toBe(true)
})

test('nothing the shim runs is looked up on PATH: a program of the same name planted ahead of /usr/bin is never run', async () => {
  const shim = generateShim('net.example.not-installed-anywhere')
  expect(shim.split('\n')[0]).toBe('#!/bin/sh')
  expect(shim).not.toMatch(/(^|[\s(;])(mdfind|PlistBuddy|osascript)\b/m)
  expect(shim).toContain('/usr/libexec/PlistBuddy -c')
  expect(shim).not.toMatch(/\bPATH\b/)
  const dir = await mkdtemp(join(tmpdir(), 'wf-shim-path-'))
  try {
    // Every name the script uses, planted as a program that leaves a mark when run.
    const planted = join(dir, 'planted')
    await mkdir(planted)
    for (const name of ['mdfind', 'PlistBuddy', 'echo', 'printf', '[', 'test', 'sh', 'cat']) {
      await writeFile(join(planted, name), `#!/bin/sh\n/usr/bin/touch '${join(dir, `ran-${name === '[' ? 'bracket' : name}`)}'\n`)
      await chmod(join(planted, name), 0o755)
    }
    const path = join(dir, 'writeflex')
    await writeFile(path, shim)
    await chmod(path, 0o755)
    const result = await runWritten(path, ['help'], { PATH: `${planted}:/usr/bin:/bin`, HOME: dir })
    // The real search ran (Spotlight by its own path) and found nothing by that made-up identifier.
    expect(result.status).toBe(127)
    expect(result.stderr).toContain('cannot find WriteFlex')
    expect((await readdir(dir)).filter((name) => name.startsWith('ran-'))).toEqual([])
  } finally { await rm(dir, { recursive: true, force: true }) }
}, TEST_MS)

test('a shim run with no app installed says so and exits 127', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-shim-'))
  try {
    const path = join(dir, 'writeflex')
    await writeFile(path, generateShim('net.example.not-installed-anywhere'))
    await chmod(path, 0o755)
    const result = await runWritten(path, ['help'])
    expect(result.status).toBe(127)
    expect(result.stderr).toContain('cannot find WriteFlex (net.example.not-installed-anywhere)')
  } finally { await rm(dir, { recursive: true, force: true }) }
}, TEST_MS)

test('the beta build installs a shim for the beta identifier', () => {
  expect(bundleIdentifierFor({ writeflexVariant: 'beta' })).toBe(BETA_BUNDLE_ID)
  expect(bundleIdentifierFor({})).toBe(STABLE_BUNDLE_ID)
})

test('installing twice is harmless, reports the reason when it cannot, and never overwrites a foreign file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-shim-'))
  try {
    const bin = join(dir, 'bin')
    const first = await installShim({ bundleId: STABLE_BUNDLE_ID, dir: bin, pathEnv: bin })
    expect(first).toMatchObject({ ok: true, changed: true, onPath: true })
    expect((await stat(join(bin, 'writeflex'))).mode & 0o111).not.toBe(0)
    const second = await installShim({ bundleId: STABLE_BUNDLE_ID, dir: bin, pathEnv: '' })
    expect(second).toMatchObject({ ok: true, changed: false, onPath: false })
    expect(second.ok && second.message).toContain('not on your PATH')
    expect((await readFile(join(bin, 'writeflex'), 'utf8'))).toContain(SHIM_MARKER)

    await writeFile(join(dir, 'foreign'), 'x')
    const blocked = await installShim({ bundleId: STABLE_BUNDLE_ID, dir: join(dir, 'foreign') })
    expect(blocked.ok).toBe(false)
    await writeFile(join(bin, 'writeflex'), '#!/bin/sh\necho mine\n')
    const refused = await installShim({ bundleId: STABLE_BUNDLE_ID, dir: bin })
    expect(refused).toMatchObject({ ok: false })
    expect(await readFile(join(bin, 'writeflex'), 'utf8')).toContain('echo mine')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// --- Which copy of the app the shim runs -------------------------------------------------------------
// The shim's two steps are separate: FIND the app, then RUN it. `writeflex --which-app` does the first
// and prints its choice, so the choice is tested here without the second ever happening. No `.app`
// bundle is made, copied or started (the estate's rule for synthetic app tests): a candidate here is
// a folder with another suffix, which the system does not take for an app, holding only an
// Info.plist. The shim reads it with the real PlistBuddy, exactly as it reads a real bundle's.
// A made-up identifier, so nothing installed on this machine can ever match it.
const FAKE_ID = 'net.example.writeflex-shim-test'
const SUFFIX = '.wfcandidate'

/** A stand-in for one copy of the app: a folder, not a bundle, with the Info.plist the shim reads. Nothing in it can run. */
async function candidate(parent: string, name: string, identifier = FAKE_ID): Promise<string> {
  const folder = join(parent, `${name}${SUFFIX}`)
  await mkdir(join(folder, 'Contents'), { recursive: true })
  await writeFile(join(folder, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>Fake</string>
</dict></plist>
`)
  return folder
}

/** Ask a shim whose two Applications folders and Spotlight answer are the given ones which copy it WOULD run. */
async function whichApp(tree: string, spotlight: string[], args: string[] = [WHICH_APP_FLAG]): Promise<{ status: number; out: string; err: string }> {
  await writeFile(join(tree, 'spotlight.txt'), spotlight.map((line) => `${line}\n`).join(''))
  const path = join(tree, 'writeflex')
  await writeFile(path, generateShim(FAKE_ID, { preferredDirs: [join(tree, 'Applications'), join(tree, 'Home Applications')], finder: `/bin/cat '${join(tree, 'spotlight.txt')}'`, bundleSuffix: SUFFIX }))
  await chmod(path, 0o755)
  // An empty PATH: whatever the script runs, it does not find through it.
  const result = await runWritten(path, args, { PATH: '', HOME: tree })
  return { status: result.status ?? -1, out: result.stdout, err: result.stderr }
}

async function shimTree(): Promise<string> {
  const tree = await mkdtemp(join(tmpdir(), 'wf shim tree-'))
  for (const dir of ['Applications', 'Home Applications', 'Documents/previews', 'Downloads', '.Trash']) await mkdir(join(tree, dir), { recursive: true })
  return tree
}

test('the shim prefers /Applications, then ~/Applications, over every other copy with the same identifier', async () => {
  const tree = await shimTree()
  try {
    const preview = await candidate(join(tree, 'Documents/previews'), 'WriteFlex')
    const download = await candidate(join(tree, 'Downloads'), 'WriteFlex')
    const user = await candidate(join(tree, 'Home Applications'), 'WriteFlex')
    // Spotlight lists the stray copies first, as it may; the copy in ~/Applications still wins.
    expect(await whichApp(tree, [preview, download, user])).toEqual({ status: 0, out: `${user}\n`, err: '' })
    const system = await candidate(join(tree, 'Applications'), 'WriteFlex')
    expect(await whichApp(tree, [preview, download, user, system])).toEqual({ status: 0, out: `${system}\n`, err: '' })
    // Found in the folder itself even when Spotlight knows nothing (indexing off, or not yet indexed).
    expect(await whichApp(tree, [])).toEqual({ status: 0, out: `${system}\n`, err: '' })
    // Two copies in the preferred folder itself: no guess is made.
    const twin = await candidate(join(tree, 'Applications'), 'WriteFlex copy')
    const twins = await whichApp(tree, [system])
    expect(twins).toMatchObject({ status: 126, out: '' })
    expect(twins.err).toContain(`${system}\n`)
    expect(twins.err).toContain(`${twin}\n`)
    expect(twins.err).not.toContain(user)
  } finally { await rm(tree, { recursive: true, force: true }) }
}, TEST_MS)

test('a single copy elsewhere is used and named on standard error; several are refused and listed', async () => {
  const tree = await shimTree()
  try {
    const preview = await candidate(join(tree, 'Documents/previews'), 'WriteFlex')
    // Not copies of this app: another identifier in an Applications folder, a stale Spotlight entry
    // whose bundle now carries another identifier, a path that is gone, and a copy in the Trash.
    await candidate(join(tree, 'Applications'), 'Other', 'net.example.other')
    const renamed = await candidate(join(tree, 'Downloads'), 'Renamed', 'net.example.other')
    const trashed = await candidate(join(tree, '.Trash'), 'WriteFlex')
    const one = await whichApp(tree, [renamed, join(tree, `gone${SUFFIX}`), trashed, preview])
    expect(one).toMatchObject({ status: 0, out: `${preview}\n` })
    expect(one.err.trim().split('\n')).toHaveLength(1)
    expect(one.err).toContain(`using the copy of WriteFlex at ${preview}`)

    const download = await candidate(join(tree, 'Downloads'), 'WriteFlex')
    const several = await whichApp(tree, [preview, download, trashed])
    expect(several.status).toBe(126)
    expect(several.out).toBe('')
    expect(several.err).toContain(preview)
    expect(several.err).toContain(download)
    expect(several.err).not.toContain(trashed)
    expect(several.err).toMatch(/several copies/i)

    // Only the trashed copy and the other app are left: that is "not installed".
    await rm(preview, { recursive: true })
    await rm(download, { recursive: true })
    expect(await whichApp(tree, [preview, download, renamed, trashed])).toMatchObject({ status: 127, out: '' })
  } finally { await rm(tree, { recursive: true, force: true }) }
}, TEST_MS)

test('--which-app is the shim\'s own only as its one argument; anything else goes on to the app, which a stand-in cannot be', async () => {
  const tree = await shimTree()
  try {
    const system = await candidate(join(tree, 'Applications'), 'WriteFlex')
    expect(await whichApp(tree, [])).toEqual({ status: 0, out: `${system}\n`, err: '' })
    // With any other argument beside it the shim goes on to run the app's executable. The stand-in has
    // none (it holds an Info.plist and nothing else), so the shell reports that it cannot be run:
    // nothing was started, and nothing was printed as if it had been.
    const passedOn = await whichApp(tree, [], ['read', WHICH_APP_FLAG])
    expect(passedOn.out).toBe('')
    expect([126, 127]).toContain(passedOn.status)
    expect(passedOn.err).toContain(`${system}/Contents/MacOS/Fake`)
  } finally { await rm(tree, { recursive: true, force: true }) }
}, TEST_MS)

test('the installed shim keeps the production search: the two Applications folders and Spotlight by identifier', () => {
  const shim = generateShim(STABLE_BUNDLE_ID)
  expect(shim).toContain(`PREFERRED_FIRST='/Applications'`)
  expect(shim).toContain('PREFERRED_SECOND="$HOME/Applications"')
  expect(shim).toContain(`/usr/bin/mdfind "kMDItemCFBundleIdentifier == '$BUNDLE_ID'"`)
  expect(shim).toContain('"$PREFERRED_FIRST"/*.app "$PREFERRED_SECOND"/*.app')
  expect(shim).toContain(`[ "$#" -eq 1 ] && [ "$1" = '${WHICH_APP_FLAG}' ]`)
  expect(() => generateShim(STABLE_BUNDLE_ID, { bundleSuffix: '.app; rm -rf x' })).toThrow()
  expect(parses(shim)).toBe(true)
})
