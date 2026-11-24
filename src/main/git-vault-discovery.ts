/** Read-only discovery. Never fetches, stages, writes configuration or returns remote credentials. */
import { syncGit } from './git-vault-sync-git'
import { developerToolsPresent, MISSING_TOOLS_MESSAGE } from './developer-tools'
import { fileURLToPath } from 'node:url'
import { access, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

export type GitVaultDiscovery =
  | { state: 'ready'; root: string; vault: string; prefix: string; branch: string; remote: string; host: string; repository: string; localPath?: string }
  /** No Git process was run: this Mac has no Command Line Tools, so `/usr/bin/git` would open Apple's install dialog. */
  | { state: 'tools-missing'; reason: string }
  | { state: 'unavailable' | 'unsupported' | 'detached' | 'operation-in-progress' | 'no-remote' | 'ambiguous-remote'; reason: string }

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

function remoteLabel(value: string, root: string): { host: string; repository: string; localPath?: string } | null {
  try {
    if (/^https:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
      const url = new URL(value)
      if ((url.protocol === 'https:' && url.username) || url.password || url.search || url.hash) return null
      const repository = url.pathname.replace(/^\//, '').replace(/\.git$/, '')
      return url.hostname && repository ? { host: url.hostname, repository } : null
    }
    const ssh = /^(?:[a-zA-Z0-9._-]+@)?([a-zA-Z0-9.-]+):([a-zA-Z0-9._/-]+)$/.exec(value)
    if (ssh) return { host: ssh[1], repository: ssh[2].replace(/\.git$/, '') }
    if (value.startsWith('file://') || !value.includes(':')) {
      const path = value.startsWith('file://') ? fileURLToPath(value) : resolve(root, value)
      return { host: 'this Mac or mounted disk', repository: basename(path).replace(/\.git$/, ''), localPath: path }
    }
    return null
  } catch { return null }
}

export async function inspectGitVault(folder: string, options: { gitEnv?: Record<string, string>; timeoutMs?: number } = {}): Promise<GitVaultDiscovery> {
  if (!(await developerToolsPresent())) return { state: 'tools-missing', reason: MISSING_TOOLS_MESSAGE }
  const readGit = (cwd: string, args: string[]) => syncGit(cwd, options.gitEnv, options.timeoutMs ?? 5000).text(args)
  try {
    const vault = await realpath(folder)
    if (await readGit(vault, ['rev-parse', '--is-inside-work-tree']) !== 'true'
      || await readGit(vault, ['rev-parse', '--is-bare-repository']) !== 'false') {
      return { state: 'unsupported', reason: 'This folder is not an ordinary Git working tree.' }
    }
    const root = await realpath(await readGit(vault, ['rev-parse', '--show-toplevel']))
    const inside = relative(root, vault)
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { state: 'unsupported', reason: 'The repository location changed.' }
    for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer']) {
      const path = await readGit(vault, ['rev-parse', '--path-format=absolute', '--git-path', marker])
      if (await exists(path)) return { state: 'operation-in-progress', reason: 'Finish the Git operation already in progress before turning on sync.' }
    }
    let branch: string
    try {
      const ref = await readGit(vault, ['symbolic-ref', '--quiet', 'HEAD'])
      if (!ref.startsWith('refs/heads/')) return { state: 'detached', reason: 'Choose a branch in Git before turning on sync.' }
      branch = ref.slice('refs/heads/'.length)
    }
    catch { return { state: 'detached', reason: 'Choose a branch in Git before turning on sync.' } }
    try { await readGit(vault, ['rev-parse', '--verify', 'HEAD^{commit}']) }
    catch { return { state: 'unsupported', reason: 'Make the first repository commit before turning on sync.' } }
    const remotes = (await readGit(vault, ['remote'])).split('\n').filter(Boolean)
    if (!remotes.length) return { state: 'no-remote', reason: 'This repository has no remote to sync with.' }
    let tracking = ''
    try { tracking = await readGit(vault, ['config', '--get', `branch.${branch}.remote`]) } catch { /* A single existing remote can be used without changing configuration. */ }
    const remote = remotes.includes(tracking) ? tracking : remotes.length === 1 ? remotes[0] : null
    if (!remote) return { state: 'ambiguous-remote', reason: 'Choose a tracking remote for this branch in Git before turning on sync.' }
    const urls = (await readGit(vault, ['remote', 'get-url', '--all', remote])).split('\n')
    const pushUrls = (await readGit(vault, ['remote', 'get-url', '--push', '--all', remote])).split('\n')
    if (urls.length !== 1 || pushUrls.length !== 1 || urls[0] !== pushUrls[0]) return { state: 'unsupported', reason: 'Sync needs one matching fetch and send location.' }
    const label = remoteLabel(urls[0], root)
    if (!label) return { state: 'unsupported', reason: 'Use an HTTPS, SSH or local-file remote without a password or key in its address.' }
    return { state: 'ready', root, vault, prefix: inside ? inside.split(sep).join('/') + '/' : '', branch, remote, ...label }
  } catch { return { state: 'unavailable', reason: 'Git or this vault is unavailable. Check its location and Git installation.' } }
}
