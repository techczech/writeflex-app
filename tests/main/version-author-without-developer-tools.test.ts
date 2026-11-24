/**
 * A version save asks Git for its author. On a Mac without Apple's Command Line Tools `/usr/bin/git` is a stub that opens
 * the system install dialog however it is run, so WriteFlex runs the concrete Git inside the active developer folder,
 * checked on disk before every lookup, and otherwise falls back to this computer's user name without starting Git.
 * The probe runs in its own Bun process because it mocks `node:child_process` to record every launch.
 */
import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitRefusal } from '../../src/backup-helper/git-refusal'

const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
const realGit = () => join(execFileSync('/usr/bin/xcode-select', ['-p']).toString().trim(), 'usr', 'bin', 'git')

const probe = String.raw`
  import { mock } from 'bun:test'
  import * as original from 'node:child_process'
  const real = { ...original }
  import { renameSync } from 'node:fs'
  const { root, xcodeSelect, wrapper, mode } = JSON.parse(process.env.WF_PROBE)
  const started = []
  const spy = (name) => (...args) => { started.push(String(args[0])); return real[name](...args) }
  const child = { ...real, spawn: spy('spawn'), spawnSync: spy('spawnSync'), execFile: spy('execFile'), execFileSync: spy('execFileSync') }
  mock.module('node:child_process', () => ({ ...child, default: child }))
  const tools = await import('./src/main/developer-tools.ts')
  tools.developerToolsSeams.command = xcodeSelect
  tools.developerToolsSeams.platform = 'darwin'
  const { humanAuthorForWorkspace } = await import('./src/main/versions.ts')
  const out = { started }
  out.first = (await humanAuthorForWorkspace(root)).name
  if (mode === 'vanish') { renameSync(wrapper, wrapper + '.gone'); out.mark = started.length; out.second = (await humanAuthorForWorkspace(root)).name }
  console.log(JSON.stringify(out))
  process.exit(0)
`

async function lookup(mode: 'missing' | 'present' | 'vanish') {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wf-author-no-clt-')))
  try {
    const root = join(scratch, 'collection'), developer = join(scratch, 'Developer'), wrapper = join(developer, 'usr', 'bin', 'git'), xcodeSelect = join(scratch, 'xcode-select')
    await mkdir(root); execFileSync('/usr/bin/git', ['init', '-q'], { cwd: root, env: gitEnv })
    execFileSync('/usr/bin/git', ['config', 'user.name', 'Test Mac'], { cwd: root, env: gitEnv })
    await mkdir(join(developer, 'usr', 'bin'), { recursive: true })
    await writeFile(wrapper, `#!/bin/sh\nexec "${realGit()}" "$@"\n`); await chmod(wrapper, 0o755)
    await writeFile(xcodeSelect, mode === 'missing'
      ? '#!/bin/sh\necho "xcode-select: error: unable to get active developer directory" >&2\nexit 2\n'
      : `#!/bin/sh\necho "${developer}"\n`)
    await chmod(xcodeSelect, 0o755)
    const child = Bun.spawn([process.execPath, '-e', probe], {
      cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
      env: { ...gitEnv, HOME: join(scratch, 'home'), TMPDIR: scratch, WF_PROBE: JSON.stringify({ root, xcodeSelect, wrapper, mode }) },
    })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`Probe failed (${code}): ${err}`)
    return { ...(JSON.parse(out.trim().split('\n').pop()!) as { started: string[]; first: string; second?: string; mark?: number }), xcodeSelect, wrapper }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
const runsGit = (command: string) => /(^|\/)(git|xcrun)$/.test(command)

test('without the Command Line Tools a version\'s author falls back to the user name and no Git starts', async () => {
  const r = await lookup('missing')
  expect(r.started.filter(runsGit)).toEqual([])
  expect(r.started).toContain(r.xcodeSelect)
  expect(r.first).not.toBe('Test Mac')
}, 60000)

test('with the tools the author comes from the concrete Git, never the /usr/bin stub', async () => {
  const r = await lookup('present')
  expect(r.first).toBe('Test Mac')
  expect(r.started).toContain(r.wrapper)
  expect(r.started.filter(c => c.startsWith('/usr/bin/'))).toEqual([])
}, 60000)

test('tools removed while the app runs: the next lookup starts no Git and falls back', async () => {
  const r = await lookup('vanish')
  expect(r.first).toBe('Test Mac')
  expect(r.started.slice(r.mark).filter(runsGit)).toEqual([])
  expect(r.second).not.toBe('Test Mac')
}, 60000)

test('Backup\'s helper never runs Apple\'s stub, also through a link, and never Git looked up on PATH', async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wf-backup-stub-')))
  try {
    const link = join(scratch, 'git'), config = async (tools?: object) => { const file = join(scratch, `config-${Math.random()}.json`); await writeFile(file, JSON.stringify({ configVersion: tools ? 2 : 1, ...(tools ? { tools } : {}) })); return file }
    await symlink('/usr/bin/git', link)
    expect(gitRefusal(['run', '--config', await config({ git: link, gitleaks: 'x' })])).toContain('stub')
    expect(gitRefusal(['preview', `--config=${await config({ git: '/usr/bin/git', gitleaks: 'x' })}`, '--vault', 'v'])).toContain('stub')
    expect(gitRefusal(['run', '--config', await config()])).toContain('names its Git program')
    expect(gitRefusal(['run', '--config', await config({ git: realGit(), gitleaks: 'x' })])).toBeNull()
    expect(gitRefusal(['status', '--runtime-dir', scratch])).toBeNull()
  } finally { await rm(scratch, { recursive: true, force: true }) }
})
