/** A fork keeps the remote tracked journal; each Mac protects its own live reader locally. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { refuse, type GitSyncWarning } from './git-vault-sync-types'
import type { SyncGit, TreeEntry } from './git-vault-sync-git'
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const markerSuffix = '.sync-fork.json'
export const journalPack = (path: string) => path + '.sync-pack.json'
export const forkMarker = (path: string) => path + markerSuffix
export function forkArtifactSource(path: string): string | null {
  if (path.endsWith('.jsonl.sync-pack.json')) return path.slice(0,-'.sync-pack.json'.length)
  if (path.endsWith('.jsonl' + markerSuffix)) return path.slice(0, -markerSuffix.length)
  const match = /^(.*)\.from-[a-f0-9]{64}(?:-\d+)?\.(?:jsonl|json)$/.exec(path)
  return match ? match[1] + '.jsonl' : null
}
function supported(path: string) {
  // Match internalKind's FIRST app directory; a nested lookalike in private state stays private.
  const parts=path.split('/'), at=parts.findIndex(p=>['.bridle','.writeflex'].includes(p.toLowerCase()))
  if(at<0) return false
  const relative=parts.slice(at+1).join('/')
  return parts[at].toLowerCase()==='.bridle' ? /^journal(?:[- ][^/]*)?\.jsonl$/.test(relative)
    : /^(?:changes|versions|folio-versions|folio-decisions|folio-save-commits)(?:[- ][^/]*)?\.jsonl$/.test(relative)
}
export function forkedJournals(tree: Map<string, TreeEntry>): string[] {
  return [...tree.keys()].filter(p => p.endsWith(markerSuffix)).map(p => p.slice(0, -markerSuffix.length)).filter(supported)
}
function chunks(bytes: Buffer): Buffer[] {
  const result: Buffer[] = []; let start = 0
  while (start < bytes.length) { const end = bytes.indexOf(10, start); result.push(bytes.subarray(start, end < 0 ? bytes.length : end + 1)); start = end < 0 ? bytes.length : end + 1 }
  return result
}
function prefixes(bytes: Buffer): Map<string, number> {
  const digest = createHash('sha256'), result = new Map([[digest.copy().digest('hex'), 0]])
  let size = 0
  for (const row of chunks(bytes)) { digest.update(row); size += row.length; result.set(digest.copy().digest('hex'), size) }
  return result
}
const sourceCache=new Map<string,Set<string>>()
const publicationCache=new Map<string,boolean>()
async function sources(git: SyncGit, tree: Map<string, TreeEntry>, path: string, canonical: Buffer, common: number): Promise<Set<string>> {
  const cacheKey=path+'|'+hash(canonical)+'|'+common+'|'+[...tree].filter(([p])=>forkArtifactSource(p)===path).map(([p,e])=>p+':'+e.oid).sort().join('|')
  const cached=sourceCache.get(cacheKey);if(cached)return new Set(cached)
  const hashes = new Set<string>(), pending: Array<{ data: Buffer; meta: {prefixHash:string;prefixBytes:number;sourceHash:string} }> = []
  const states = new Map<string, { value: ReturnType<typeof createHash>; bytes:number }>()
  for (const bytes of [Buffer.alloc(0), Buffer.concat(chunks(canonical).slice(0, common)), canonical]) {
    const value=createHash('sha256').update(bytes); states.set(value.copy().digest('hex'),{value,bytes:bytes.length})
  }
  for (const p of tailPaths(tree, path)) {
    const e = tree.get(p.slice(0, -6) + '.json')
    if (e) try {
      const raw=await blob(git,e), value=JSON.parse(raw.toString())
      if (p.match(/\.from-([a-f0-9]{64})/)?.[1] !== hash(raw)) continue
      if (/^[a-f0-9]{64}$/.test(value.sourceHash) && /^[a-f0-9]{64}$/.test(value.prefixHash) && Number.isSafeInteger(value.prefixBytes)) pending.push({data:await blob(git,tree.get(p)),meta:value})
    } catch { /* opaque evidence is kept, but cannot claim unpublished bytes have travelled */ }
  }
  let progress=true
  while(progress) {
    progress=false
    for(let i=pending.length-1;i>=0;i--) {
      const {data,meta}=pending[i], prefix=states.get(meta.prefixHash)
      if(!prefix || prefix.bytes !== meta.prefixBytes) continue
      const value=prefix.value.copy().update(data)
      if(value.copy().digest('hex')===meta.sourceHash) {states.set(meta.sourceHash,{value,bytes:prefix.bytes+data.length});hashes.add(meta.sourceHash);progress=true}
      pending.splice(i,1)
    }
  }
  if(sourceCache.size>128)sourceCache.delete(sourceCache.keys().next().value!)
  sourceCache.set(cacheKey,new Set(hashes));return hashes
}

type Manifest = { version: 1; canonicalOid: string; canonicalHash: string; prefixLines: number; prefixHash: string }
type Input = {
  git: SyncGit; root: string; prefix: string; ours: Map<string, TreeEntry>; theirs: Map<string, TreeEntry>
  set: (path: string, entry?: TreeEntry) => Promise<void>; warnings: GitSyncWarning[]
  ownName: string; otherName: string; live?: Map<string, Buffer>
}
const cache = new Map<string,Buffer>();let cacheBytes=0, loads=0
export const journalReadStats=()=>({loads})
function remember(oid:string,bytes:Buffer) {
 if(cache.has(oid))return
 while(cacheBytes+bytes.length>32*1024*1024 && cache.size) {const key=cache.keys().next().value!;cacheBytes-=cache.get(key)!.length;cache.delete(key)}
 if(bytes.length<=32*1024*1024){cache.set(oid,bytes);cacheBytes+=bytes.length}
}
async function prefetch(git:SyncGit, tree:Map<string,TreeEntry>, path:string) {
 const ids=[...new Set([...tree].filter(([p])=>p===path||forkArtifactSource(p)===path).map(([,e])=>e.oid))].filter(id=>!cache.has(id))
 if(!ids.length)return
 const raw=await git.ok(['cat-file','--batch'],{},Buffer.from(ids.join('\n')+'\n'));loads++
 let at=0
 for(const oid of ids){const end=raw.indexOf(10,at),header=raw.subarray(at,end).toString().split(' '),size=Number(header[2]);if(header[0]!==oid||header[1]!=='blob'||!Number.isSafeInteger(size)||size<0||end+size+2>raw.length)refuse('unsupported','A preserved history object could not be read.');remember(oid,raw.subarray(end+1,end+1+size));at=end+size+2}
}
const blob = async (git:SyncGit,e?:TreeEntry):Promise<Buffer> => {
 if(!e)return Buffer.alloc(0)
 if(!['100644','100755'].includes(e.mode))refuse('unsupported','A history file is not an ordinary file.')
 const found=cache.get(e.oid);if(found)return found
 loads++;const bytes=await git.ok(['cat-file','blob',e.oid]);remember(e.oid,bytes);return bytes
}
/** Packs keep exact raw bytes; decoding is also used by the mandatory secret scan. */
export function packedHistoryBlobs(path:string,bytes:Buffer): Array<{path:string;bytes:Buffer}> {
 if(!path.endsWith('.jsonl.sync-pack.json'))return []
 let value:any;try{value=JSON.parse(bytes.toString())}catch{return refuse('unsupported','A preserved history pack cannot be read.')}
 if(value.version!==1||!Array.isArray(value.files)||value.files.length>100000)refuse('unsupported','A preserved history pack is invalid.')
 const source=path.slice(0,-'.sync-pack.json'.length)
 return value.files.map((f:any)=>{if(typeof f.path!=='string'||forkArtifactSource(f.path)!==source||typeof f.data!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data))refuse('unsupported','A preserved history pack entry is invalid.');return {path:f.path,bytes:Buffer.from(f.data,'base64')}})
}
async function expand(git:SyncGit,original:Map<string,TreeEntry>,path:string):Promise<Map<string,TreeEntry>> {
 const tree=new Map(original);await prefetch(git,tree,path)
 const e=tree.get(journalPack(path));if(!e)return tree
 for(const f of packedHistoryBlobs(journalPack(path),await blob(git,e))) {
  const oid=createHash(e.oid.length===64?'sha256':'sha1').update(Buffer.from('blob '+f.bytes.length+'\0')).update(f.bytes).digest('hex');remember(oid,f.bytes)
  const existing=tree.get(f.path)
  if(existing && existing.oid!==oid)refuse('unsupported','A preserved history pack conflicts with an unpacked entry.')
  tree.set(f.path,{mode:'100644',oid})
 }
 return tree
}
async function manifest(git: SyncGit, entry: TreeEntry): Promise<Manifest> {
  let m: Manifest
  try { m = JSON.parse((await blob(git, entry)).toString()) } catch { return refuse('unsupported', 'The preserved-history record cannot be read. Keep it and check it with Git.') }
  if (m.version !== 1 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(m.canonicalOid) || !/^[a-f0-9]{64}$/.test(m.canonicalHash)
    || !Number.isSafeInteger(m.prefixLines) || m.prefixLines < 0 || !/^[a-f0-9]{64}$/.test(m.prefixHash)) refuse('unsupported', 'The preserved-history record is not valid. Keep it and check it with Git.')
  const bytes = await blob(git, { mode: '100644', oid: m.canonicalOid })
  if (hash(bytes) !== m.canonicalHash || hash(Buffer.concat(chunks(bytes).slice(0, m.prefixLines))) !== m.prefixHash) refuse('unsupported', 'The preserved-history record does not match its journal. Keep both and check them with Git.')
  return m
}
function tailPaths(tree: Map<string, TreeEntry>, path: string) {
  const stem = path.slice(0, -6) + '.from-'
  return [...tree.keys()].filter(p => p.startsWith(stem) && /^.+\.from-[a-f0-9]{64}(?:-\d+)?\.jsonl$/.test(p))
}
async function diskBytes(path: string): Promise<Buffer | null> {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const st = await file.stat()
    if (!st.isFile() || st.size > 32 * 1024 * 1024) refuse('unsupported', 'A local file blocks a preserved history tail.')
    return await file.readFile()
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  finally { await file?.close() }
}
export async function preserveJournalFork(input: Input, path: string, _fresh = false): Promise<void> {
  const { git } = input
  const ours=await expand(git,input.ours,path), theirs=await expand(git,input.theirs,path)
  const own = await blob(git, ours.get(path)), other = await blob(git, theirs.get(path))
  // Keep the already published journal at its tracked path. A plain pull on a Mac that
  // has not run WriteFlex must see no deletion, rename or gratuitous replacement.
  const entry=theirs.get(path)??ours.get(path)
  if(!entry)return refuse('unsupported','A journal fork has no saved journal to preserve.')
  const canonicalBytes=await blob(git,entry)
  const markers=[theirs.get(forkMarker(path)),ours.get(forkMarker(path))].filter((e):e is TreeEntry=>!!e)
  const all=await Promise.all(markers.map(e=>manifest(git,e)))
  let common=0
  const a=chunks(own),b=chunks(other)
  while(common<a.length && common<b.length && a[common].equals(b[common]))common++
  const previous=all.find(m=>hash(Buffer.concat(chunks(canonicalBytes).slice(0,m.prefixLines)))===m.prefixHash)
  const m:Manifest={version:1,canonicalOid:entry.oid,canonicalHash:hash(canonicalBytes),prefixLines:previous?.prefixLines??common,prefixHash:previous?.prefixHash??hash(Buffer.concat(a.slice(0,common)))}
  const canonical = await blob(git, { mode: '100644', oid: m.canonicalOid })
  const tree = new Map([...theirs, ...ours])
  for(const [p,e] of theirs) if(forkArtifactSource(p)===path && ours.has(p) && ours.get(p)!.oid!==e.oid && ![journalPack(path),forkMarker(path)].includes(p)) {
    const copy=p+'.git-incoming-'+hash(await blob(git,e));await input.set(copy,e)
    input.warnings.push({code:'internal-content-mismatch',path:p.slice(input.prefix.length),copy:copy.slice(input.prefix.length),message:'Different preserved history bytes were kept in a separate recovery file.'})
  }

  const write = async (p: string, data: Buffer) => {
    const oid = (await git.ok(['hash-object', '-w', '--stdin'], {}, data)).toString().trim()
    remember(oid,data); const e = { mode: '100644', oid }; tree.set(p, e); await input.set(p, e)
  }
  const published = await sources(git, tree, path, canonical, m.prefixLines)
  const archive = async (data: Buffer, from: string) => {
    const sourceHash = hash(data)
    if (published.has(sourceHash)) return
    const known = new Set([...published, m.prefixHash, hash(Buffer.alloc(0))])
    let start = 0, prefixHash = hash(Buffer.alloc(0))
    for (const [digest, size] of prefixes(data)) if (known.has(digest)) { start = size; prefixHash = digest }
    const tail = data.subarray(start), rows = chunks(tail)
    if (!tail.length) return
    const dates = rows.flatMap(row => { try { const ts = JSON.parse(row.toString()).ts; return typeof ts === 'number' && Number.isFinite(ts) && Math.abs(ts) <= 8640000000000000 ? [new Date(ts).toISOString().slice(0, 10)] : [] } catch { return [] } }).sort()
    const range = dates.length ? dates[0] === dates.at(-1) ? dates[0] : `${dates[0]}–${dates.at(-1)}` : 'an undated period'
    const dataMeta = Buffer.from(JSON.stringify({ version:1, from:from.slice(0,100), range, prefixHash, prefixBytes:start, sourceHash })+'\n')
    const stem = path.slice(0, -6) + '.from-' + hash(dataMeta)
    let copy = stem + '.jsonl', meta = stem + '.json', n = 1
    for (;;) {
      const existing = tree.has(copy) ? await blob(git, tree.get(copy)) : await diskBytes(join(input.root, copy))
      const existingMeta = tree.has(meta) ? await blob(git, tree.get(meta)) : await diskBytes(join(input.root, meta))
      if ((existing === null || existing.equals(tail)) && (existingMeta === null || existingMeta.equals(dataMeta))) break
      const suffix = '-' + (++n); copy = stem + suffix + '.jsonl'; meta = stem + suffix + '.json'
    }
    await write(copy, tail); await write(meta, dataMeta)
    published.add(sourceHash)
  }

  const live = input.live?.get(path) ?? await diskBytes(join(input.root,path)) ?? own
  await archive(live, input.ownName); await archive(other, input.otherName)
  await write(forkMarker(path), Buffer.from(JSON.stringify(m) + '\n'))
  await input.set(path, { mode: '100644', oid: m.canonicalOid })
  const liveRows = new Set(chunks(live).map(hash)), livePrefixes = prefixes(live)
  const notices = new Map<string, { copy: string; dates: string[] }>()
  for (const p of tailPaths(tree, path).sort()) {
    let represented = chunks(await blob(git, tree.get(p))).every(row => liveRows.has(hash(row)))
    let from = input.otherName, range = 'an undated period'
    const e = tree.get(p.slice(0, -6) + '.json')
    if (e) { try { const meta = JSON.parse((await blob(git, e)).toString()); if (typeof meta.from === 'string') from = meta.from; if (typeof meta.range === 'string') range = meta.range; if (typeof meta.sourceHash === 'string') represented = livePrefixes.has(meta.sourceHash) } catch { /* bytes still recoverable */ } }
    if (represented) continue
    const notice = notices.get(from) ?? { copy: p.slice(input.prefix.length), dates: [] }
    notice.dates.push(...range.match(/\d{4}-\d{2}-\d{2}/g) ?? [])
    notices.set(from, notice)
  }
  for (const [from, notice] of notices) {
    notice.dates.sort()
    const range = !notice.dates.length ? 'an undated period' : notice.dates[0] === notice.dates.at(-1) ? notice.dates[0] : `${notice.dates[0]}–${notice.dates.at(-1)}`
    const warning: GitSyncWarning = { code: 'history-kept', path: path.slice(input.prefix.length), copy: notice.copy, message: `Version history from ${from} for ${range} is kept but not shown in the list on this Mac.` }
    if (!input.warnings.some(w => w.code === warning.code && w.path === warning.path && w.message === warning.message)) input.warnings.push(warning)
  }
  const artifacts=[...tree.keys()].filter(p=>forkArtifactSource(p)===path && p!==forkMarker(path)&&p!==journalPack(path)).sort()
  if(tailPaths(tree,path).length>32 || ours.has(journalPack(path)) || theirs.has(journalPack(path))) {
    const files=await Promise.all(artifacts.map(async p=>({path:p,data:(await blob(git,tree.get(p))).toString('base64')})))
    await write(journalPack(path),Buffer.from(JSON.stringify({version:1,files})+'\n'))
    for(const p of artifacts)await input.set(p,undefined)
  } else for(const p of artifacts)await input.set(p,tree.get(p))

}
export async function projectJournalForks(input: Input): Promise<Set<string>> {
  const paths = new Set([...forkedJournals(input.ours), ...forkedJournals(input.theirs)])
  for (const path of paths) if (path.startsWith(input.prefix)) await preserveJournalFork(input, path)
  return paths
}
/** A deliberately private live journal is pending only when it has unpublished bytes. */
export async function journalPublished(git: SyncGit, tree: Map<string, TreeEntry>, path: string, data: Buffer): Promise<boolean> {
  const e = tree.get(forkMarker(path)); if (!e) return false
  const cacheKey=path+'|'+hash(data)+'|'+[...tree].filter(([p])=>forkArtifactSource(p)===path).map(([p,e])=>p+':'+e.oid).sort().join('|')
  if(publicationCache.has(cacheKey))return publicationCache.get(cacheKey)!
  tree=await expand(git,tree,path)
  const m = await manifest(git, e), digest = hash(data)
  const canonical=await blob(git,{mode:'100644',oid:m.canonicalOid})
  const published=data.length === 0 || digest === m.canonicalHash || digest === m.prefixHash || (await sources(git, tree, path, canonical, m.prefixLines)).has(digest)
  if(publicationCache.size>256)publicationCache.delete(publicationCache.keys().next().value!)
  publicationCache.set(cacheKey,published);return published
}
