/**
 * Issue 257: Git ignore rules that silently leave a writer's material out of every commit, and so out of every
 * remote copy, whichever tool (WriteFlex sync, a backup tool or plain Git) makes the commits.
 *
 * The incident: a per-draft note rule and nested Folio rules ignored the WriteFlex backup companions and the
 * Collection history, and nothing told the writer. This reads Git's own answer (`ls-files --others --ignored
 * --exclude-standard`) for the folder and sorts what is left out into three kinds the writer cares about. It never
 * reads file contents and never changes the repository or its ignore files.
 */
import { BACKUP_SUFFIX } from '../shared/backup-files'
import { internalKind } from './git-vault-sync-internals'
import type { GitOutput } from './git-vault-sync-git'
import type { IgnoredWriting } from '../shared/remote-protection'

type Run = (args: readonly string[]) => Promise<GitOutput>

/** Writing a writer reads and writes: Markdown, plain text and canvases outside dot-folders. */
const NOTE = /\.(?:md|markdown|mdx|txt|canvas)$/i
/** Tooling output nobody writes in, as the sidebar already treats it (document-path.ts). */
const TOOLING = /(?:^|\/)(?:node_modules|out|release|\.git)(?:\/|$)/
const EXAMPLES = 5
/** Paths whose matching rule is looked up, to name where the rules are. */
const SOURCE_PATHS = 40

/**
 * Where the rules leaving out `paths` are written, from `git check-ignore -v`: ".gitignore line 1",
 * "folio/.gitignore line 2", ".git/info/exclude line 3" or "your global Git excludes line 4". Best effort: an empty
 * list when Git cannot say.
 */
export async function ruleSources(run: Run, paths: string[]): Promise<string[]> {
  let out: GitOutput
  try { out = await run(['check-ignore', '-v', '--no-index', '--', ...paths]) } catch { return [] }
  if (out.code !== 0 && out.code !== 1) return []
  const sources = new Set<string>()
  // "<source>:<line>:<pattern>\t<path>": only the part before the tab is read, so the path's quoting never matters.
  for (const row of out.out.toString('utf8').split('\n')) {
    const m = /^(.*):(\d+):[^\t]*\t/.exec(row)
    if (!m || !m[1]) continue
    const where = /(^|\/)info\/exclude$/.test(m[1]) ? '.git/info/exclude' : m[1].startsWith('/') ? 'your global Git excludes' : m[1]
    sources.add(`${where} line ${m[2]}`)
  }
  return [...sources].slice(0, 8)
}

export type IgnoredKind = 'notes' | 'recovery' | 'history'

/** What one ignored path means to the writer; null when ignoring it loses nothing of theirs. */
export function ignoredKind(path: string): IgnoredKind | null {
  const rel = path.replace(/\/+$/, '')
  if (TOOLING.test(rel)) return null
  const name = rel.split('/').at(-1) ?? rel
  // The Folio bin holds parts the writer removed; its index says where they came from. Recovery material.
  if (rel.split('/').some(p => p === '.folio-bin')) return 'recovery'
  if (name.endsWith(BACKUP_SUFFIX) || name.endsWith(`${BACKUP_SUFFIX}.json`)) return 'recovery'
  const parts = rel.split('/'), at = parts.findIndex(p => ['.writeflex', '.bridle'].includes(p.toLowerCase()))
  if (at >= 0) {
    const inside = parts.slice(at + 1).join('/')
    if (/^(?:sync-copies|rescue)(?:\/|$)/.test(inside)) return 'recovery'
    // A whole internal folder (or its object store) left out takes every shared ledger with it.
    if (!inside || /^(?:objects|folio-objects|replica-versions|inbox|outbox)$/.test(inside)) return 'history'
    const kind = internalKind(rel)
    return kind && kind !== 'local' ? 'history' : null
  }
  if (parts.slice(0, -1).some(p => p.startsWith('.'))) return null
  return NOTE.test(name) ? 'notes' : null
}

/**
 * Ask Git which untracked paths in `root` its ignore rules leave out, and sort them. `root` is the vault folder;
 * Git prints paths relative to it. Every file is listed (no `--directory`): collapsing would hide ignored files
 * inside a folder that has never been committed. History files are named by their `.writeflex/` or `.bridle/`
 * folder. Returns null when Git cannot answer (not a repository, no tools): absence of evidence is never
 * "nothing ignored".
 */
export async function ignoredWriting(root: string, run: Run, checkedAt = Date.now()): Promise<IgnoredWriting | null> {
  let result: GitOutput
  try { result = await run(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '.']) } catch { return null }
  if (result.code !== 0) return null
  const counts: Record<IgnoredKind, number> = { notes: 0, recovery: 0, history: 0 }
  const named: Record<IgnoredKind, Set<string>> = { notes: new Set(), recovery: new Set(), history: new Set() }
  const losing = new Set<string>()
  for (const path of result.out.toString('utf8').split('\0').filter(Boolean)) {
    const kind = ignoredKind(path)
    if (!kind) continue
    counts[kind]++
    losing.add(path)
    const store = /^(.*?(?:^|\/)\.(?:writeflex|bridle)\/)/i.exec(path)
    named[kind].add(kind === 'history' && store ? store[1] : path)
  }
  const pick = (kind: IgnoredKind) => ({ count: counts[kind], examples: [...named[kind]].slice(0, EXAMPLES) })
  const found = [...losing].slice(0, SOURCE_PATHS)
  return { checkedAt, notes: pick('notes'), recovery: pick('recovery'), history: pick('history'), sources: found.length ? await ruleSources(run, found) : [] }
}
