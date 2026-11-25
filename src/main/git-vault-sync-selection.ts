/** Metadata authority for automatic work. Never refresh an uncertain large entry by reading its bytes. */
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { entries, nul, safePath, type SyncGit } from './git-vault-sync-git'
import { readLargeEvidence, writeLargeEvidence, evidenceMatches, type LargeFileEvidence } from './git-vault-sync-large-evidence'
import { refuse } from './git-vault-sync-types'
export const LARGE_SYNC_BYTES = 100_000_000
export type LargeCandidate = { path: string; cause: 'lfs' | 'size'; state: 'metadata-equal' | 'needs-checking'; evidence: string; indexMtime?: number }
export type SyncSelection = { large: Map<string, LargeCandidate>; candidates: LargeCandidate[]; exclude: string[] }

/** Index debug output is NUL-delimited at the path; its following stat block has a fixed grammar.
 * Parsing a missing/unknown stat block never grants equality. Git's object sizes do not unpack blobs. */
export async function selectSyncFiles(git: SyncGit, root: string, revisions: string[] = ['HEAD']): Promise<SyncSelection> {
  const indexPath = await git.text(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
  const indexTime = (await lstat(indexPath, { bigint: true })).mtimeNs
  const debug = (await git.ok(['ls-files', '--stage', '--debug', '-z'])).toString()
  const staged = new Map<string, { mode: string; oid: string; stat: string }>()
  let offset = 0
  while (offset < debug.length) {
    const end = debug.indexOf('\0', offset)
    if (end < 0) refuse('unsupported', 'Git returned unreadable file metadata.')
    const line = debug.slice(offset, end), match = /^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(line)
    const stats = /^  ctime: \d+:\d+\n  mtime: \d+:\d+\n  dev: \d+\tino: \d+\n  uid: \d+\tgid: \d+\n  size: \d+\tflags: [0-9a-f]+\n/.exec(debug.slice(end + 1))
    if (!match || !stats || !safePath(match[3])) refuse('unsupported', 'Git returned unreadable file metadata.')
    staged.set(match[3], { mode: match[1], oid: match[2], stat: stats[0] })
    offset = end + 1 + stats[0].length
  }
  const trees = await Promise.all(revisions.map(r => entries(git, r)))
  const untracked = nul(await git.ok(['ls-files', '--others', '--exclude-standard', '--full-name', '-z']))
  const paths = [...new Set([...staged.keys(), ...trees.flatMap(t => [...t.keys()]), ...untracked])]
  for (const p of paths) if (!safePath(p)) refuse('unsupported', 'A repository path cannot safely be synced.')
  const attrs = async (env: Record<string, string> = {}, cached = false) => {
    if (!paths.length) return new Map<string, string>()
    const fields = nul(await git.ok(['check-attr', ...(cached ? ['--cached'] : []), '-z', '--stdin', 'filter'], env, Buffer.from(paths.join('\0') + '\0')))
    const values = new Map<string, string>()
    for (let i = 0; i < fields.length; i += 3) values.set(fields[i], fields[i + 2])
    return values
  }
  const workAttrs = await attrs(), indexAttrs = await attrs({}, true), treeAttrs: Map<string, string>[] = []
  // Reuse cached attribute answers only when every attribute blob has the same identity.
  // A changed/deleted attribute file gets a fresh temporary tree view instead.
  const attributes = (tree: Map<string, { oid: string }>) => [...tree].filter(([p]) => p.split('/').at(-1) === '.gitattributes').map(([p,e]) => `${p}\0${e.oid}`).sort().join('\n')
  let scratch: string | undefined
  try {
    for (let i = 0; i < revisions.length; i++) {
      if (attributes(trees[i]) === attributes(staged)) { treeAttrs.push(indexAttrs); continue }
      scratch ??= await mkdtemp(join(tmpdir(), 'writeflex-selection-'))
      const env = { GIT_INDEX_FILE: join(scratch, 'attributes') }
      await git.ok(['read-tree', revisions[i]], env); treeAttrs.push(await attrs(env, true))
    }
  } finally { if (scratch) await rm(scratch, { recursive: true, force: true }) }
  const oids = [...new Set([...staged.values(), ...trees.flatMap(t => [...t.values()])].map(e => e.oid))]
  const sizes = new Map<string, number>()
  if (oids.length) {
    const lines = (await git.ok(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {}, Buffer.from(oids.join('\n') + '\n'))).toString().trimEnd().split('\n')
    for (const line of lines) { const m = /^([a-f0-9]+) blob (\d+)$/.exec(line); if (!m) refuse('unsupported', 'Git returned unreadable object metadata.'); sizes.set(m[1], Number(m[2])) }
  }
  const proofs=await readLargeEvidence(git),validProofs=new Map<string,LargeFileEvidence>()
  const large = new Map<string, LargeCandidate>()
  const parents = new Set<string>()
  for (const path of paths) {
    // Do not follow an ancestor link while inspecting identity or size.
    const folders: string[] = []
    for (let p = dirname(path); p !== '.'; p = dirname(p)) folders.unshift(p)
    for (const p of folders) if (!parents.has(p)) {
      const st = await lstat(join(root, p)).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (st && (!st.isDirectory() || st.isSymbolicLink())) refuse('unsupported', 'A symbolic link or file blocks a document folder.')
      parents.add(p)
    }
    const st = await lstat(join(root, path), { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    const index = staged.get(path), head = trees[0].get(path)
    const lfs = [workAttrs, indexAttrs, ...treeAttrs].some(a => a.get(path) === 'lfs')
    const big = (st?.size ?? 0n) > BigInt(LARGE_SYNC_BYTES) || [index, ...trees.map(t => t.get(path))].some(e => e && (sizes.get(e.oid) ?? Infinity) > LARGE_SYNC_BYTES)
    const proof=proofs.get(path),checked=!!proof&&evidenceMatches(proof,st,index,head)
    if(checked&&(lfs||big))validProofs.set(path,proof!)
    if (!lfs && !big) continue
    const ns = (s: string, n: string) => BigInt(s) * 1_000_000_000n + BigInt(n)
    const m = index && /ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: (\d+)\tino: (\d+)\n  uid: (\d+)\tgid: (\d+)\n  size: (\d+)\tflags: ([0-9a-f]+)/.exec(index.stat)
    const equal = !!(st?.isFile() && index && head && m && index.oid === head.oid && index.mode === head.mode
      && [indexAttrs, ...treeAttrs].every(a => a.get(path) === workAttrs.get(path))
      && st.ctimeNs === ns(m[1], m[2]) && st.mtimeNs === ns(m[3], m[4]) && st.mtimeNs < indexTime
      && (st.dev & 0xffffffffn) === BigInt(m[5]) && (st.ino & 0xffffffffn) === BigInt(m[6])
      && st.uid === BigInt(m[7]) && st.gid === BigInt(m[8]) && (st.size & 0xffffffffn) === BigInt(m[9]) && m[10] === '0'
      && ((st.mode & 0o111n) !== 0n) === (index.mode === '100755'))
    // Evidence is ephemeral. Recompute on every operation, including after a restart or changed attributes/index.
    const evidence = [path, index?.oid, head?.oid, index?.stat, ...[workAttrs, indexAttrs, ...treeAttrs].map(a => a.get(path)), st && `${st.dev}:${st.ino}:${st.size}:${st.mode}:${st.ctimeNs}:${st.mtimeNs}`].join('\0')
    large.set(path, { path, cause: lfs ? 'lfs' : 'size', state: (equal||checked) ? 'metadata-equal' : 'needs-checking', evidence, ...(m?{indexMtime:Number(m[3])}:{}) })
  }
  if(validProofs.size!==proofs.size)await writeLargeEvidence(git,validProofs)
  return { large, candidates: [...large.values()].filter(p => p.state === 'needs-checking'), exclude: [...large.keys()].map(p => `:(top,exclude,literal)${p}`) }
}
export function requireCheckedSelection(selection: SyncSelection, prefix = ''): void {
  const candidate = selection.candidates[0]
  if (candidate) refuse('large-file-needs-checking', 'A large or Git LFS file needs checking outside automatic sync. Its saved bytes were left untouched.', candidate.path.startsWith(prefix) ? candidate.path.slice(prefix.length) : candidate.path)
}
/** Only a worktree diff uses these exclusions; tree and index comparisons retain every object identity. */
export async function selectedWorktreeDiff(git: SyncGit, root: string, args: string[], evidence?: SyncSelection): Promise<Buffer> {
  const selection = evidence ?? await selectSyncFiles(git, root)
  return git.ok([...args, '--', '.', ...selection.exclude])
}

/** Outgoing history needs tree metadata only, never a fresh worktree walk for each commit. */
export async function largeTreePaths(git:SyncGit,revisions:string[],paths:string[]):Promise<Map<string,'lfs'|'size'>> {
 const result=new Map<string,'lfs'|'size'>(),trees=await Promise.all(revisions.map(r=>entries(git,r)))
 const oids=[...new Set(trees.flatMap(t=>paths.flatMap(p=>t.get(p)?[t.get(p)!.oid]:[])))]
 if(oids.length){
  const lines=(await git.ok(['cat-file','--batch-check=%(objectname) %(objecttype) %(objectsize)'],{},Buffer.from(oids.join('\n')+'\n'))).toString().trimEnd().split('\n'),big=new Set<string>()
  for(const line of lines){const m=/^([a-f0-9]+) blob (\d+)$/.exec(line);if(!m)refuse('unsupported','Git returned unreadable object metadata.');if(Number(m[2])>LARGE_SYNC_BYTES)big.add(m[1])}
  for(const p of paths)if(trees.some(t=>big.has(t.get(p)?.oid??'')))result.set(p,'size')
 }
 if(!paths.length)return result
 const scratch=await mkdtemp(join(tmpdir(),'writeflex-history-attributes-')),env={GIT_INDEX_FILE:join(scratch,'index')}
 try {
  for(const rev of revisions){
   await git.ok(['read-tree',rev],env)
   const fields=nul(await git.ok(['check-attr','--cached','-z','--stdin','filter'],env,Buffer.from(paths.join('\0')+'\0')))
   for(let i=0;i<fields.length;i+=3)if(fields[i+2]==='lfs')result.set(fields[i],'lfs')
  }
 }finally{await rm(scratch,{recursive:true,force:true})}
 return result
}
