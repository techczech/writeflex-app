/**
 * The backup-helper trial's trusted configuration: off unless a privileged main-process caller
 * supplies one. Nothing the renderer sends, no setting and no environment variable reaches it.
 *
 * An enabled configuration names the helper's socket (in the helper's private runtime folder,
 * which connectHelper checks), the client name to say hello with, and which opened folders are
 * which registered helper vaults. Each folder is resolved to its real path once, here; a window
 * whose own folder resolves to one of them may ask about that vault and no other. The helper's
 * own configuration stays the authority for what each id means; this only says which window may
 * name which id.
 *
 * Each folder must be a Git worktree root. The helper reports paths relative to its worktree, and
 * the bridge has no prefix mapping, so a vault registered at a subfolder of a worktree would put
 * every reported path in the wrong place; it is refused here, before any trial is enabled. The
 * check only reads the folder's `.git` entry (a directory holding HEAD, or a linked worktree's
 * `gitdir:` file naming one); it runs no Git command. A folder it cannot establish is refused.
 */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { VAULT_ID } from './reply-check'

export type BackupHelperTrialInput = {
  enabled: true
  /** Absolute path of the helper's socket (`<runtime folder>/helper.sock`). */
  socketPath: string
  /** Printable name the bridge gives the helper in its hello. */
  client: string
  vaults: ReadonlyArray<{ root: string; vaultId: string }>
  /** How long a status request may take before the connection is dropped. Default 5 s. */
  statusTimeoutMs?: number
  /** How long a Sync now may take (one whole backup cycle). Default 6 minutes. */
  syncTimeoutMs?: number
  /** How long a connection and its hello may take. Default 5 s. */
  connectTimeoutMs?: number
}

export type BackupHelperTrial =
  | { readonly enabled: false }
  | {
    readonly enabled: true
    readonly socketPath: string
    readonly client: string
    /** Real folder path → registered vault id. */
    readonly vaults: ReadonlyMap<string, string>
    readonly statusTimeoutMs: number
    readonly syncTimeoutMs: number
    readonly connectTimeoutMs: number
  }

/** The default: no helper is asked anything. */
export const BACKUP_HELPER_TRIAL_DISABLED: BackupHelperTrial = Object.freeze({ enabled: false as const })

const CLIENT = /^[\x20-\x7e]{1,100}$/

function plainAbsolute(path: unknown, what: string): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error(`${what} must be a plain absolute path`)
  }
  return path
}

function bounded(value: number | undefined, fallback: number, min: number, max: number, what: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${what} must be between ${min} and ${max} ms`)
  return value
}

/** A Git directory as the worktree's `.git` names it: a real directory with a HEAD file. */
async function isGitDir(dir: string): Promise<boolean> {
  try {
    const [folder, head] = await Promise.all([lstat(dir), lstat(join(dir, 'HEAD'))])
    return folder.isDirectory() && head.isFile()
  } catch {
    return false
  }
}

const MAX_GITDIR_FILE = 4_096

/**
 * True when `root` (a real path) is the root of a Git worktree: its own `.git` is a directory with a
 * HEAD file, or a plain file `gitdir: <path>` (a linked worktree or submodule; a relative path is read
 * from `root`, as Git does) naming such a directory. A symlinked `.git`, any other content or anything
 * that cannot be read is false. Reads only; runs no Git command.
 */
export async function isGitWorktreeRoot(root: string): Promise<boolean> {
  const marker = join(root, '.git')
  let info
  try { info = await lstat(marker) } catch { return false }
  if (info.isDirectory()) return isGitDir(marker)
  if (!info.isFile() || info.size > MAX_GITDIR_FILE) return false
  let content: string
  try { content = await readFile(marker, 'utf8') } catch { return false }
  const named = /^gitdir: ([^\n\r\0]+)\r?\n?$/.exec(content)
  return named ? isGitDir(resolve(root, named[1]!)) : false
}

/** Checks an enabled trial configuration and resolves its folders. Throws on anything doubtful. */
export async function resolveBackupHelperTrial(
  input: BackupHelperTrialInput,
  resolveReal: (path: string) => Promise<string> = realpath,
  isWorktreeRoot: (realRoot: string) => Promise<boolean> = isGitWorktreeRoot,
): Promise<BackupHelperTrial> {
  if (input.enabled !== true) throw new Error('an enabled trial configuration says enabled: true')
  const socketPath = plainAbsolute(input.socketPath, 'socket path')
  if (typeof input.client !== 'string' || !CLIENT.test(input.client)) throw new Error('client must be a printable name')
  if (!Array.isArray(input.vaults) || input.vaults.length === 0 || input.vaults.length > 64) throw new Error('name between 1 and 64 vaults')
  const vaults = new Map<string, string>()
  const ids = new Set<string>()
  for (const entry of input.vaults) {
    if (typeof entry.vaultId !== 'string' || !VAULT_ID.test(entry.vaultId)) throw new Error('vault id is not a registered-vault id')
    const real = await resolveReal(plainAbsolute(entry.root, 'vault folder'))
    if (vaults.has(real)) throw new Error('two vault ids name the same folder')
    if (ids.has(entry.vaultId)) throw new Error('one vault id names two folders')
    // Subfolders are unsupported until a prefix mapping exists (review-writeflex-helper-bridge.md).
    if (!(await isWorktreeRoot(real))) throw new Error('vault folder is not a Git worktree root; subfolders of a worktree are not supported')
    vaults.set(real, entry.vaultId)
    ids.add(entry.vaultId)
  }
  return Object.freeze({
    enabled: true as const,
    socketPath,
    client: input.client,
    vaults,
    statusTimeoutMs: bounded(input.statusTimeoutMs, 5_000, 100, 60_000, 'status timeout'),
    syncTimeoutMs: bounded(input.syncTimeoutMs, 6 * 60_000, 100, 30 * 60_000, 'sync timeout'),
    connectTimeoutMs: bounded(input.connectTimeoutMs, 5_000, 100, 60_000, 'connect timeout'),
  })
}
