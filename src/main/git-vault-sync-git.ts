/** Argument-array Git transport, bounded in time/output. Raw stderr never leaves this module. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refuse, GitSyncFailure } from './git-vault-sync-types'
import { systemGit, MISSING_TOOLS_MESSAGE } from './developer-tools'
export type GitOutput = { code: number; out: Buffer; rejected: boolean; auth: boolean }
export type SyncGit = ReturnType<typeof syncGit>
export function syncGit(cwd: string, trustedEnv: Record<string, string> = {}, timeoutMs = 20_000, networkTimeoutMs = 180_000) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  const env = { ...inherited, ...trustedEnv, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false',
    GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: '/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -o ConnectionAttempts=1 -o StrictHostKeyChecking=yes',
    GIT_ALLOW_PROTOCOL: 'file:https:ssh', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' }
  async function run(args: readonly string[], extra: Record<string, string> = {}, input?: Buffer, limitMs = timeoutMs): Promise<GitOutput> {
    // Never `/usr/bin/git`: without the Command Line Tools that stub opens Apple's install dialog however it is run.
    const git = await systemGit()
    if (!git) refuse('tools-missing', MISSING_TOOLS_MESSAGE)
    // Git diff refreshes stat entries even with optional locks disabled. Let it verify
    // content against a disposable index, so reads neither mutate the real index nor
    // mistake an inode replacement for unsent writing.
    if (args[0] === 'diff' && !extra.GIT_INDEX_FILE) {
      const folder = await mkdtemp(join(tmpdir(), 'writeflex-diff-'))
      try {
        const index = await text(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
        const copy = join(folder, 'index')
        await writeFile(copy, await readFile(index))
        return await run(['-c', 'diff.autoRefreshIndex=true', ...args], { ...extra, GIT_INDEX_FILE: copy }, input, limitMs)
      } finally { await rm(folder, { recursive: true, force: true }) }
    }
    return new Promise((resolve, reject) => {
      const child = spawn(git, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false',
        '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.quotePath=false', '-c', 'diff.autoRefreshIndex=false', ...args],
      { cwd, env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true })
      let bytes = 0, stderr = '', done = false
      const output: Buffer[] = []
      const kill = () => { try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') } }
      const finish = (failure?: string) => {
        if (done) return
        done = true; clearTimeout(timer)
        if (failure) { kill(); reject(new Error(failure)) }
        else resolve({ code: child.exitCode ?? -1, out: Buffer.concat(output),
          rejected: /non-fast-forward|fetch first|stale info/i.test(stderr),
          auth: /authentication failed|permission denied|could not read username|could not read password|terminal prompts disabled|HTTP[^\n]*40[13]/i.test(stderr) })
      }
      const timer = setTimeout(() => finish('Git did not finish in time.'), limitMs)
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1024 * 1024) finish('Git output exceeded the safe limit.'); else output.push(chunk) })
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 65536) stderr += chunk.toString().slice(0, 65536 - stderr.length) })
      child.on('error', () => finish('Git could not start.'))
      child.on('close', () => finish())
      child.stdin.on('error', () => { /* exit status reports a rejected input */ })
      child.stdin.end(input)
    })
  }
  async function ok(args: readonly string[], extra?: Record<string, string>, input?: Buffer): Promise<Buffer> {
    const result = await run(args, extra, input)
    if (result.code !== 0) refuse('operation-failed', `Git could not finish ${args[0] === '-c' ? 'commit-tree' : args[0]} (exit ${result.code}). Your writing is safe on this Mac.`)
    return result.out
  }
  const text = async (args: readonly string[], extra?: Record<string, string>) => (await ok(args, extra)).toString().trimEnd()
  async function network(args: readonly string[]): Promise<GitOutput> {
    let result: GitOutput
    try { result = await run(args, {}, undefined, networkTimeoutMs) } catch (error) { if (error instanceof GitSyncFailure) throw error; return refuse('network-unavailable', 'The repository could not be reached. Try again when the connection is available.') }
    if (result.auth) refuse('auth-refused', 'Git sign-in was refused. Check the existing Git credentials or SSH key, then try again.')
    if (result.code !== 0 && !result.rejected) refuse('network-unavailable', 'The repository could not be reached. Check its location and connection, then try again.')
    return result
  }
  return { run, ok, text, network }
}
export function nul(buffer: Buffer): string[] { return buffer.toString().split('\0').filter(Boolean) }
export function safePath(path: string): boolean {
  return !!path && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every(p => p !== '..' && p !== '.' && p !== '' && p.toLowerCase() !== '.git')
}
export function machineState(path: string): boolean { return path.split('/').some(p => p.toLowerCase() === '.writeflex' || p.toLowerCase() === '.bridle') }
export type TreeEntry = { mode: string; oid: string }
export async function entries(git: SyncGit, tree: string): Promise<Map<string, TreeEntry>> {
  const map = new Map<string, TreeEntry>()
  for (const record of nul(await git.ok(['ls-tree', '-rz', tree]))) {
    const tab = record.indexOf('\t'), match = /^(\d+) blob ([a-f0-9]+)$/.exec(record.slice(0, tab))
    const path = record.slice(tab + 1)
    if (!match || !safePath(path)) refuse('unsupported', 'This repository has a path or file type that automatic sync cannot safely update.')
    map.set(path, { mode: match[1], oid: match[2] })
  }
  return map
}

/** Raw blob application cannot emulate checkout filters or platform newline conversion. */
export async function checkConversions(git: SyncGit, paths: string[], indexEnv: Record<string, string> = {}, cached = false): Promise<void> {
  if (!paths.length) return
  const attrs = nul(await git.ok(['check-attr', ...(cached ? ['--cached'] : []), '-z', '--stdin', 'filter', 'eol', 'text'], indexEnv, Buffer.from(paths.join('\0') + '\0')))
  for (let i = 0; i < attrs.length; i += 3) if (!['unspecified', 'unset'].includes(attrs[i + 2])) refuse('content-conversion', 'A Git content filter or line-ending conversion applies here. Update this repository with Git before syncing.', attrs[i])
  const autocrlf = await git.run(['config', '--get', 'core.autocrlf'])
  const eol = await git.run(['config', '--get', 'core.eol'])
  if (['true', 'input'].includes(autocrlf.out.toString().trim()) || eol.out.toString().trim() === 'crlf') refuse('content-conversion', 'This repository uses Git line-ending conversion. Update it with Git before syncing.', paths[0])
}
export const excludedSyncPath = (path: string): boolean => path.split('/').some(part => part === '.DS_Store' || /^\.writeflex-sync-.*\.tmp$/.test(part))
