import { join, extname } from 'node:path'
import { image, applyFiles, type FileChange } from './git-vault-sync-files'
import { safePath } from './git-vault-sync-git'
import { internalKind } from './git-vault-sync-internals'
import { incomingComputer } from './git-vault-sync-label'
import type { GitSyncPair, GitVaultSyncOptions } from './git-vault-sync-types'
/** Short index ownership and durable index-before-branch recovery; never reclaim an unknown lock. */
import { randomUUID, createHash } from 'node:crypto'
import { open, readFile, lstat, unlink, rename } from 'node:fs/promises'
import { refuse } from './git-vault-sync-types'
import type { SyncGit } from './git-vault-sync-git'
type Repository = { root: string; index: string; branch: string; git: SyncGit; machineId: string }
type Owner = { app: 'WriteFlex'; machineId: string; pid: number; nonce: string; ino: number; dev: number; birthtimeMs: number }
type Transaction = { prefix?:string; from?:string; at?:number; app: 'WriteFlex'; machineId: string; branch: string; before: string; after: string; oldIndex: string; nextHash: string; nextIndex?: string; files?: {path:string;beforeHash:string|null;afterHash:string|null;oid?:string;mode?:number}[] }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const ownerPath = (c: Repository) => `${c.index}.writeflex-owner.json`
const transactionPath = (c: Repository) => `${c.index}.writeflex-transaction.json`
async function json(path: string): Promise<unknown> {
  try { const st = await lstat(path); if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024 * 1024) return null; return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}
async function durable(path: string, data: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(data)); await file.sync() } finally { await file.close() }
    await rename(temp, path)
  } finally { await unlink(temp).catch(() => undefined) }
}
async function reclaim(c: Repository) {
  const owner = await json(ownerPath(c)) as Owner | null
  if (!owner || owner.app !== 'WriteFlex' || owner.machineId !== c.machineId || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^[a-f0-9-]{36}$/.test(owner.nonce)) return
  try { process.kill(owner.pid, 0); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return }
  const lock = await lstat(`${c.index}.lock`).catch(() => null)
  if (lock && !lock.isSymbolicLink() && lock.ino === owner.ino && lock.dev === owner.dev && lock.birthtimeMs === owner.birthtimeMs) await unlink(`${c.index}.lock`)
  // An unmatched lock belongs to someone else. Never delete it or adopt its identity.
  if (!lock || (lock.ino === owner.ino && lock.dev === owner.dev && lock.birthtimeMs === owner.birthtimeMs)) await unlink(ownerPath(c)).catch(() => undefined)
}
export async function acquireIndex(c: Repository, timing: { now: () => number; sleep: (ms: number) => Promise<void>; wait: number; poll: number }) {
  await reclaim(c)
  const path = `${c.index}.lock`, deadline = timing.now() + timing.wait
  while (true) {
    let handle: Awaited<ReturnType<typeof open>>
    try { handle = await open(path, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (timing.now() >= deadline) refuse('index-busy', 'Another Git operation is using this repository. Try again after it finishes.')
      await timing.sleep(Math.min(timing.poll, deadline - timing.now())); continue
    }
    const identity = await handle.stat(), nonce = randomUUID()
    let installed = false
    try { await durable(ownerPath(c), { app: 'WriteFlex', machineId: c.machineId, pid: process.pid, nonce, ino: identity.ino, dev: identity.dev, birthtimeMs: identity.birthtimeMs } satisfies Owner) }
    catch (error) {
      await handle.close()
      const live = await lstat(path).catch(() => null)
      if (live?.ino === identity.ino && live.dev === identity.dev && live.birthtimeMs === identity.birthtimeMs) await unlink(path)
      throw error
    }
    return {
      async install(bytes: Buffer) {
        const live = await lstat(path)
        if (live.ino !== identity.ino || live.dev !== identity.dev) refuse('repository-changed', 'The index lock changed while sync was applying.')
        await handle.truncate(0); await handle.writeFile(bytes); await handle.sync(); await handle.close()
        await rename(path, c.index); installed = true
      },
      async close() {
        await handle.close().catch(() => undefined)
        if (!installed) {
          const live = await lstat(path).catch(() => null)
          if (live?.ino === identity.ino && live.dev === identity.dev) await unlink(path)
        }
        const owner = await json(ownerPath(c)) as Owner | null
        if (owner?.nonce === nonce) await unlink(ownerPath(c)).catch(() => undefined)
      },
    }
  }
}
export async function prepareTransaction(c: Repository, before: string, after: string, oldIndex: Buffer, next: Buffer, plan: FileChange[] = [], metadata: {prefix:string;from:string;at:number} = {prefix:'',from:'another computer',at:Date.now()}) {
  const files = await Promise.all(plan.map(async f => ({path:f.path,beforeHash:f.before ? hash(f.before.bytes) : null,afterHash:f.after ? hash(f.after.bytes) : null,...(f.after ? {oid:(await c.git.ok(['hash-object','-w','--stdin'],{},f.after.bytes)).toString().trim(),mode:f.after.mode}: {})})))
  await durable(transactionPath(c), { ...metadata, files, nextIndex:next.toString('base64'), app: 'WriteFlex', machineId: c.machineId, branch: c.branch, before, after, oldIndex: oldIndex.toString('base64'), nextHash: hash(next) } satisfies Transaction)
}
export async function clearTransaction(c: Repository) { await unlink(transactionPath(c)).catch(error => { if (error.code !== 'ENOENT') throw error }) }
export async function recoverTransaction(c: Repository, timing: Parameters<typeof acquireIndex>[1], options: Pick<GitVaultSyncOptions,'ownWrite'|'withFileLock'> = {}, keepPairs: (pairs:GitSyncPair[])=>Promise<void> = async()=>{}) {
  await reclaim(c)
  const transaction = await json(transactionPath(c)) as Transaction | null
  if (!transaction) {
    if (await lstat(transactionPath(c)).then(() => true, () => false)) refuse('repository-changed', 'The interrupted sync record could not be read. Its current work was kept; check it with Git.')
    return
  }
  if (transaction.machineId !== c.machineId) { const held=await acquireIndex(c,timing);try{refuse('repository-changed','An unfinished sync from another installation needs checking.')}finally{await held.close()} }
  if (transaction.app !== 'WriteFlex' || transaction.machineId !== c.machineId || transaction.branch !== c.branch || !/^[a-f0-9]{40,64}$/.test(transaction.before) || !/^[a-f0-9]{40,64}$/.test(transaction.after) || typeof transaction.oldIndex !== 'string') refuse('repository-changed', 'An unfinished sync transaction needs checking before continuing.')
  const held = await acquireIndex(c, timing)
  try {
    const head = await c.git.text(['rev-parse', 'HEAD']), index = await readFile(c.index)
    const next = hash(index) === transaction.nextHash, old = index.equals(Buffer.from(transaction.oldIndex, 'base64'))
    if (transaction.files && transaction.nextIndex && (head===transaction.before || head===transaction.after) && (old||next)) {
      const plan: FileChange[]=[], pairs:GitSyncPair[]=[]
      for(const f of transaction.files) {
        if(!safePath(f.path))refuse('repository-changed','An interrupted sync path is invalid.')
        const current=await image(join(c.root,f.path)), digest=current?hash(current.bytes):null
        if(digest===f.afterHash) continue
        const after=f.oid ? {bytes:await c.git.ok(['cat-file','blob',f.oid]),mode:f.mode??0o644}:null
        if((after?hash(after.bytes):null)!==f.afterHash)refuse('repository-changed','An interrupted sync object does not match its plan.')
        if(digest!==f.beforeHash) {
          // A save after the crash wins, and the interrupted incoming bytes remain a document.
          if(after && !internalKind(f.path) && f.path.startsWith(transaction.prefix??'')) {
            const from=transaction.from??await incomingComputer(c.git,transaction.before,transaction.after)??'another computer'
            const at=transaction.at??Date.now(),ext=extname(f.path),stem=f.path.slice(0,ext?-ext.length:undefined)
            let copy='',existing:Awaited<ReturnType<typeof image>>=null,n=1
            do {copy=`${stem} (from ${from} ${new Date(at).toISOString().slice(0,10)}${n===1?'':` ${n}`})${ext||'.md'}`;n++;existing=await image(join(c.root,copy))} while(existing && !existing.bytes.equals(after.bytes))
            if(!existing)plan.push({path:copy,before:null,after})
            pairs.push({id:hash(Buffer.from(transaction.after+'|'+f.path+'|'+copy)),local:f.path.slice((transaction.prefix??'').length),other:copy.slice((transaction.prefix??'').length),from,at})
          }
          continue
        }
        plan.push({path:f.path,before:current,after})
      }
      await applyFiles(c.root,plan,undefined,'',undefined,options.ownWrite,options.withFileLock)
      await keepPairs(pairs)
      const prepared=Buffer.from(transaction.nextIndex,'base64')
      if(hash(prepared)!==transaction.nextHash)refuse('repository-changed','An interrupted sync index does not match its plan.')
      await held.install(prepared)
      if(head===transaction.before && transaction.after!==transaction.before)await c.git.ok(['update-ref',`refs/heads/${c.branch}`,transaction.after,transaction.before])
      await clearTransaction(c);return
    }
    if (next && head === transaction.before) await c.git.ok(['update-ref', `refs/heads/${c.branch}`, transaction.after, transaction.before])
    else if (!(next && head === transaction.after) && !(old && head === transaction.before)) refuse('repository-changed', 'The repository changed after an interrupted sync. Its current work was kept; check it with Git.')
    await clearTransaction(c)
  } finally { await held.close() }
}
