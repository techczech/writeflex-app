/**
 * Issue 257: does this checkout hold writing newer than the backup tool's verified upload?
 *
 * The backup tool's proof names a commit (`head`) observed clean at `verifiedAt`. Writing here is newer when HEAD has
 * commits past it, when a file in this folder is untracked, missing or differs from the verified commit, or when
 * WriteFlex saved here after `verifiedAt`. Any of these takes coverage away; only a newer proof gives it back.
 *
 * Nothing here can write or run repository code. Git is asked only to list (`rev-parse`, `log`, `ls-tree`,
 * `ls-files`), with optional locks and the untracked cache off: no `status` or `diff`, so no clean filter, textconv
 * or index refresh ever runs. Contents are compared here, by hashing the bytes on disk as Git blobs against the
 * verified commit's tree, so index flags (assume-unchanged, skip-worktree) cannot hide an edit. A file whose
 * change time is before the verified observation was part of the backup tool's clean check and is not re-read.
 *
 * Nothing here can reach the network either: every call runs with `protocol.allow=never` (and the caller adds
 * OFFLINE_GIT_ENV), and a partial clone, whose missing objects Git would otherwise fetch on demand, is "unchecked".
 *
 * The record alone never makes a folder green. This checkout's own Git must bear it out: its root and branch are the
 * ones the record describes, and its tracking ref for the backup's destination and branch
 * (`refs/remotes/origin/<branch>` unless the record names another remote; written by Git when the backup tool
 * fetched or pushed) holds the verified commit. Otherwise the result is "unconfirmed".
 *
 * One deadline covers the whole comparison: each Git call gets only the time left (the transport kills the
 * process group when it runs out), and no step starts after it. A comparison that cannot finish safely returns
 * "unchecked", which is never shown as backed up.
 */
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitOutput } from './git-vault-sync-git'
import type { Coverage } from '../shared/remote-protection'

/** One read-only Git call with at most `timeoutMs`; the caller's transport stops the process on timeout. */
export type GitCall = (args: readonly string[], timeoutMs: number) => Promise<GitOutput>
const READ_ONLY = ['--no-optional-locks', '-c', 'core.untrackedCache=false', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never']
/** For the caller's Git transport: no protocol is allowed and lazy fetching of missing objects is off. */
export const OFFLINE_GIT_ENV: Record<string, string> = { GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }
/** What the record says this checkout is: its Git root and branch, and the remote the backup tool uploads to. */
export type ProofPlace = { root: string; branch: string; remote?: string }
/** Files changed this close before the observation are re-read, for coarse timestamps. */
const SLACK_MS = 2000
const MAX_FILE_BYTES = 64 * 1024 * 1024

const blobId = (bytes: Buffer, oidLength: number) =>
  createHash(oidLength === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')

export async function localCoverage(root: string, head: string, verifiedAt: number, git: GitCall, savedAt?: number, budgetMs = 8000, place?: ProofPlace): Promise<Coverage> {
  const deadline = Date.now() + budgetMs
  const left = () => deadline - Date.now()
  const call = async (args: readonly string[]): Promise<GitOutput | null> => {
    if (left() <= 0) return null
    try { const out = await git([...READ_ONLY, ...args], left()); return left() > 0 && out.code === 0 ? out : null } catch { return null }
  }
  const times: number[] = []
  let newer = false
  if (savedAt !== undefined && savedAt > verifiedAt) { newer = true; times.push(savedAt) }
  const done = (): Coverage => newer ? { kind: 'waiting', since: times.length ? Math.round(Math.min(...times)) : null } : { kind: 'current' }

  // A partial clone would fetch missing objects on demand: never compare one.
  if (left() <= 0) return { kind: 'unchecked' }
  try {
    const promisor = await git([...READ_ONLY, 'config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], left())
    if (left() <= 0 || promisor.code !== 1 || promisor.out.length) return { kind: 'unchecked' }
  } catch { return { kind: 'unchecked' } }

  const top = await call(['rev-parse', '--show-toplevel', 'HEAD'])
  if (!top) return { kind: 'unchecked' }
  const [toplevel, current] = top.out.toString('utf8').trim().split('\n')
  if (!toplevel || !current) return { kind: 'unchecked' }
  const branch = (await call(['symbolic-ref', '-q', '--short', 'HEAD']))?.out.toString('utf8').trim()
  if (!branch) return { kind: 'unconfirmed' }
  if (place) {
    const same = await Promise.all([realpath(toplevel), realpath(place.root)]).then(([a, b]) => a === b, () => false)
    if (!same || branch !== place.branch) return { kind: 'unconfirmed' }
  }
  // Git's own record that the verified commit reached the backup's destination: exactly that remote's tracking ref
  // for this branch contains it. Any other ref (another remote, another branch) confirms nothing.
  const destination = `refs/remotes/${place?.remote ?? 'origin'}/${branch}`
  const tracked = await call(['for-each-ref', '--contains', head, '--format=%(refname)', destination])
  if (!tracked) return { kind: 'unchecked' }
  if (!tracked.out.toString('utf8').split('\n').includes(destination)) return { kind: 'unconfirmed' }
  if (current !== head) {
    const log = await call(['log', '--format=%ct', `${head}..HEAD`])
    for (const line of log?.out.toString('utf8').split('\n') ?? []) { const t = Number(line) * 1000; if (t > 0) times.push(t) }
    newer = true
    return done()
  }

  const untracked = await call(['ls-files', '-z', '--full-name', '--others', '--exclude-standard', '--', '.'])
  if (!untracked) return { kind: 'unchecked' }
  for (const path of untracked.out.toString('utf8').split('\0').filter(Boolean)) {
    newer = true
    if (left() <= 0) return { kind: 'unchecked' }
    try { times.push((await lstat(join(toplevel, path))).mtimeMs) } catch { /* gone again */ }
  }

  const tree = await call(['ls-tree', '-r', '-z', '--full-name', head, '--', '.'])
  if (!tree) return { kind: 'unchecked' }
  for (const entry of tree.out.toString('utf8').split('\0').filter(Boolean)) {
    if (left() <= 0) return { kind: 'unchecked' }
    const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry)
    if (!m || m[2] !== 'blob') continue // submodules are their own repositories
    const [, mode, , oid, path] = m, file = join(toplevel, path)
    let info
    try { info = await lstat(file) } catch { newer = true; continue } // deleted here: its time is unknown
    if (info.ctimeMs < verifiedAt - SLACK_MS && info.mtimeMs < verifiedAt - SLACK_MS) continue
    let bytes: Buffer
    try {
      if (mode === '120000') bytes = Buffer.from(await readlink(file))
      else if (!info.isFile() || info.size > MAX_FILE_BYTES) { newer = true; times.push(info.mtimeMs); continue }
      else bytes = await readFile(file)
    } catch { newer = true; continue }
    if (blobId(bytes, oid.length) !== oid) { newer = true; times.push(info.mtimeMs) }
  }
  return left() > 0 ? done() : { kind: 'unchecked' }
}
