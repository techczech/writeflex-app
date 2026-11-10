/** Read-only, isolated trusted Git inspection. No transport, credential helper or repository mutation. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { GIT_CANDIDATES } from './enrolment'
import { isGitWorktreeRoot } from './trial-config'
export type OriginIdentity = { realRoot: string; exactRemote: string; destination: string; marker: string }
async function trustedGit(): Promise<string> {
  for (const candidate of GIT_CANDIDATES) {
    try {
      const path = await realpath(candidate), st = await lstat(path)
      if (!st.isFile() || !(st.mode & 0o111)) continue
      for (let p = path; p !== '/'; p = dirname(p)) {
        const s = await lstat(p)
        if (s.isSymbolicLink() || (s.mode & 0o022) || (s.uid !== 0 && s.uid !== process.getuid?.())) throw Error('untrusted')
      }
      return path
    } catch { /* next fixed location */ }
  }
  throw Error('GitHub origin unavailable')
}
export async function inspectOrigin(root: string): Promise<OriginIdentity> {
  const realRoot = await realpath(root)
  if (!(await isGitWorktreeRoot(realRoot))) throw Error('GitHub origin unavailable')
  const git = await trustedGit()
  const run = (args: string[]) => new Promise<string>((resolve, reject) => execFile(git, ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args], { cwd: realRoot, timeout: 10_000, maxBuffer: 256 * 1024, env: { PATH: '/usr/bin:/bin', HOME: '/var/empty', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } }, (e, out) => e ? reject(Error('GitHub origin unavailable')) : resolve(out)))
  const top = (await run(['rev-parse', '--show-toplevel'])).trim()
  if (await realpath(top) !== realRoot) throw Error('GitHub origin unavailable')
  const section = await run(['config', '-z', '--includes', '--get-regexp', '^remote\\.origin\\.'])
  const settings = section.split('\0').filter(Boolean).map(s => s.split('\n')[0]!.toLowerCase())
  if (settings.filter(s => s === 'remote.origin.url').length !== 1 || settings.filter(s => s === 'remote.origin.pushurl').length > 1 || settings.some(s => /^remote\.origin\.(receivepack|uploadpack|vcs|mirror)$/.test(s))) throw Error('GitHub origin unavailable')
  const fetch = await run(['remote', 'get-url', '--all', 'origin']), push = await run(['remote', 'get-url', '--push', '--all', 'origin'])
  if (fetch !== push || !/^[^\r\n\0]+\n$/.test(fetch)) throw Error('GitHub origin unavailable')
  const st = await lstat(join(realRoot, '.git')), exactRemote = fetch.slice(0, -1)
  return { realRoot, exactRemote, destination: createHash('sha256').update(exactRemote).digest('hex'), marker: `${st.dev}:${st.ino}:${st.isDirectory() ? 'directory' : 'file'}` }
}
