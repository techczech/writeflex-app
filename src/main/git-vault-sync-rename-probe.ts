/**
 * Does this Mac's Git merge without detecting renames when asked to? ADR-0055's keep-both rules assume it does: the
 * engine merges with `-c merge.renames=false`. Git 2.39.5 (Apple Git-154) ignores that setting in `merge-tree
 * --write-tree`, carries an edit into a file the other Mac renamed and so loses writing; Git 2.54 honours it.
 * The answer is measured in a throwaway repository with no user or system configuration, never in the vault, and
 * cached per Git binary and version; the version is read again before every sync operation.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncGit, nul, type SyncGit } from './git-vault-sync-git'
import { systemGit } from './developer-tools'

export type RenameProbe = { honoured: boolean; version: string }
export type ProbeGit = Pick<SyncGit, 'run' | 'ok' | 'text'>

/** The stub that names Git on macOS. The transport runs the concrete Git it stands for (`developer-tools.ts`); PATH is never consulted. */
export const SYNC_GIT_PATH = '/usr/bin/git'
const IDENTITY = {
  GIT_AUTHOR_NAME: 'WriteFlex', GIT_AUTHOR_EMAIL: 'writeflex@localhost', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'WriteFlex', GIT_COMMITTER_EMAIL: 'writeflex@localhost', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
}
const WORDS = 'A paragraph that stays the same on both computers, long enough for Git to pair it as a rename.\n'.repeat(4)

/** No system, global or XDG configuration, no templates, a home inside the throwaway folder. */
export function isolatedProbeEnv(folder: string, template: string): Record<string, string> {
  return { HOME: folder, XDG_CONFIG_HOME: folder, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TEMPLATE_DIR: template }
}

/**
 * One rename on one side, one edit on the other, merged as the engine merges. `git` runs in an empty folder.
 * Only a recognised result decides: the modify/delete conflict with both blobs kept (honoured), or a clean merge that
 * carried the edit to the renamed file (not honoured). Anything else throws, so the caller retries rather than caches.
 */
export async function probeRenameMerging(git: ProbeGit, template: string): Promise<RenameProbe> {
  const version = (await git.text(['--version'])).replace(/^git version\s*/, '')
  await git.ok(['init', '-q', `--template=${template}`])
  const blob = async (text: string) => (await git.ok(['hash-object', '-w', '--stdin'], undefined, Buffer.from(text))).toString().trim()
  const tree = async (path: string, oid: string) => (await git.ok(['mktree'], undefined, Buffer.from(`100644 blob ${oid}\t${path}\n`))).toString().trim()
  const commit = async (treeId: string, parent?: string) =>
    (await git.ok(['commit-tree', treeId, ...(parent ? ['-p', parent] : []), '-m', 'probe'], IDENTITY)).toString().trim()
  const original = await blob(WORDS), edited = await blob(`${WORDS}One more line on the other computer.\n`)
  const base = await commit(await tree('before.md', original))
  const renamed = await commit(await tree('after.md', original), base)
  const edit = await commit(await tree('before.md', edited), base)
  const merged = await git.run(['-c', 'merge.renames=false', 'merge-tree', '--write-tree', '--name-only', '-z', renamed, edit])
  const fields = merged.out.toString().split('\0'), result = fields[0] ?? ''
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(result)) throw new Error(`Git's merge check returned no tree (exit ${merged.code}).`)
  const listing = await git.run(['ls-tree', '-rz', result])
  if (listing.code !== 0) throw new Error('Git could not list the merge check result.')
  const files = new Map(nul(listing.out).map((line) => { const tab = line.indexOf('\t'); return [line.slice(tab + 1), line.slice(0, tab).split(' ')[2]] as const }))
  const conflicted = fields.slice(1, fields.indexOf('', 1) < 0 ? undefined : fields.indexOf('', 1))
  if (merged.code === 1 && conflicted.includes('before.md') && files.get('before.md') === edited && files.get('after.md') === original && files.size === 2) {
    return { honoured: true, version }
  }
  if (merged.code === 0 && files.get('after.md') === edited && !files.has('before.md') && files.size === 1) return { honoured: false, version }
  throw new Error(`Git's merge check gave an unrecognised result (exit ${merged.code}).`)
}

export async function readSyncGitVersion(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'writeflex-git-version-'))
  try { return await syncGit(folder, isolatedProbeEnv(folder, folder)).text(['--version']) } finally { await rm(folder, { recursive: true, force: true }) }
}

/** The production measurement: a fresh folder, an empty template, nothing from the user's Git configuration. */
export async function measureSyncGitRenames(): Promise<RenameProbe> {
  const folder = await mkdtemp(join(tmpdir(), 'writeflex-rename-probe-'))
  try {
    const repo = join(folder, 'repo'), template = join(folder, 'empty-template'), home = join(folder, 'home')
    await mkdir(repo); await mkdir(template); await mkdir(home)
    return await probeRenameMerging(syncGit(repo, isolatedProbeEnv(home, template)), template)
  } finally { await rm(folder, { recursive: true, force: true }) }
}

const verdicts = new Map<string, Promise<RenameProbe>>()

/**
 * Before every operation: read the version again (the active developer tools can change while the app runs), then
 * reuse the verdict for that binary and version or measure it once. The measurement reports the version of the Git
 * that actually ran it; a verdict is accepted, and cached, only for the version it was keyed on. A measurement that
 * throws, or that ran a different Git (the tools changed in between), is not cached and counts as not checked.
 */
export async function syncGitRenameVerdict(
  using: { version: () => Promise<string>; measure: () => Promise<RenameProbe> } = { version: readSyncGitVersion, measure: measureSyncGitRenames },
): Promise<RenameProbe> {
  const version = (await using.version()).replace(/^git version\s*/, '')
  const key = `${(await systemGit()) ?? SYNC_GIT_PATH}\0${version}`
  let verdict = verdicts.get(key)
  if (!verdict) {
    verdict = using.measure().then((measured) => {
      if (measured.version !== version) throw new Error(`Git changed while it was checked (${version}, then ${measured.version}).`)
      return measured
    })
    verdicts.set(key, verdict)
    verdict.catch(() => verdicts.delete(key))
  }
  return verdict
}

export function renameStopMessage(version: string): string {
  return `This Mac's Git (version ${version}) handles renames in a way WriteFlex cannot sync safely. Update Xcode or its Command Line Tools in Software Update, then try again.`
}
