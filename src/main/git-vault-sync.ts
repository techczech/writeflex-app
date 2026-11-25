/** Main-process two-way Git sync. No timers, renderer, commands or quit hook live here. */
import { selectSyncFiles, selectedWorktreeDiff, largeTreePaths, type SyncSelection } from './git-vault-sync-selection'
import { checkLargeFileContents } from './git-vault-sync-large-check'
import { renameStopMessage, syncGitRenameVerdict, type RenameProbe } from './git-vault-sync-rename-probe'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { readFile, writeFile, lstat, mkdtemp, rm, realpath } from 'node:fs/promises'
import { createGitleaksScanner, type ScanBlob } from '@app-patterns/vault-sync'
import { releaseLiveJournals, protectLiveJournals, skipPrivateJournals } from './git-vault-sync-private-history'
import { forkedJournals, projectJournalForks, journalPublished, packedHistoryBlobs } from './git-vault-sync-journals'
import { friendlyComputerName } from './git-vault-sync-computer'
import { incomingComputer } from './git-vault-sync-label'
import { inspectGitVault } from './git-vault-discovery'
import { internalKind, sharedInternal, reconcileInternals, warn } from './git-vault-sync-internals'
import { acquireIndex, recoverTransaction, prepareTransaction, clearTransaction } from './git-vault-sync-transaction'
import { syncGit, entries, nul, safePath, machineState, excludedSyncPath, checkConversions, type SyncGit, type TreeEntry } from './git-vault-sync-git'
import { cleanSyncTemps, applyFiles, planFiles, observeFiles, checkObserved, image, type FileImage, type FileChange } from './git-vault-sync-files'
import { refuse, siblingBlocked, GitSyncFailure, type GitSyncDocument, type GitSyncRecord, type GitVaultSyncOptions,
  type GitSyncCall, type GitVaultSyncResult, type GitSyncPair, type GitSyncWarning, type GitSyncReason } from './git-vault-sync-types'
export type { GitVaultSyncOptions, GitVaultSyncResult, GitSyncCall, GitSyncPair, GitSyncDocument, GitSyncReasonCode } from './git-vault-sync-types'

/** The app's scanner lookup also determines whether integration tests can run a real send. */
export function createGitSyncScanner() {
  return createGitleaksScanner({ searchDirs: ['/opt/homebrew/bin', '/usr/local/bin'], timeoutMs: 20_000 })
}

type Context = { vault: string; root: string; prefix: string; branch: string; remote: string; host: string; repository: string; localPath?: string; gitDir: string; index: string; git: SyncGit; machineId: string; selection?: SyncSelection }
const queues = new Map<string, Promise<unknown>>()
const containsRoot = (a: string, b: string) => a === b || b.startsWith(a.endsWith(sep) ? a : a + sep)
const relatedRoots = (a: string, b: string) => containsRoot(a,b) || containsRoot(b,a)
/** Retention declines busy sync; reserving this queue also protects nested Collections from a new sync. */
export async function tryWithGitVaultIdle<T>(root: string, work: () => Promise<T>): Promise<T | undefined> {
  if ([...queues.keys()].some(key => relatedRoots(root,key))) return undefined
  return serial(root,work)
}
async function serial<T>(root: string, work: () => Promise<T>): Promise<T> {
  const previous = [...queues].filter(([key]) => relatedRoots(root,key)).map(([,work]) => work.catch(() => undefined))
  const next = Promise.all(previous).then(work)
  queues.set(root, next)
  try { return await next } finally { if (queues.get(root) === next) queues.delete(root) }
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const inVault = (c: Context, path: string) => path.startsWith(c.prefix) && !excludedSyncPath(path) && internalKind(path) !== 'local'
const isDocument = (c: Context, path: string) => path.startsWith(c.prefix) && !excludedSyncPath(path) && internalKind(path) === null
const localPath = (c: Context, path: string) => path.slice(c.prefix.length)
const key = (vault: string, kind: string) => `git-vault-sync.${kind}.${digest(vault)}`
const objectId = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)

export function createGitVaultSync(options: GitVaultSyncOptions) {
  const started=new Set<string>()
  // Checked before anything touches the vault, on every operation: a Git that detects renames despite
  // merge.renames=false loses writing in a rename/edit clash, so with it sync recovers, cleans and merges nothing.
  async function gitRenameStop(): Promise<GitSyncReason | undefined> {
    let verdict: RenameProbe
    try { verdict = await (options.renameProbe ?? syncGitRenameVerdict)() }
    catch { return { code: 'git-renames', message: "WriteFlex could not check this Mac's Git. Nothing was changed. Try again." } }
    return verdict.honoured ? undefined : { code: 'git-renames', message: renameStopMessage(verdict.version) }
  }
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)))
  const computerName = (options.computerName ?? friendlyComputerName()).replace(/[\r\n\0]/g, ' ').slice(0, 100)
  const scanner = options.scanner ?? createGitSyncScanner()
  const canonical = async (vault: string) => realpath(vault).catch(() => resolve(vault))
  const enabled = (vault: string) => options.settings.get(key(vault, 'enabled')) === true
  function machineIdentity(): string {
    const name = 'git-vault-sync.machine-id', existing = options.settings.get(name)
    if (typeof existing === 'string' && /^[a-f0-9-]{36}$/.test(existing)) return existing
    const id = randomUUID()
    options.settings.set(name, id, 'Git sync installation identity', { log: false })
    return id
  }
  function record(vault: string): GitSyncRecord {
    const empty: GitSyncRecord = { pairs: [], incoming: [] }
    try {
      const value = options.settings.get(key(vault, 'record'))
      if (typeof value !== 'string') return empty
      const r = JSON.parse(value) as GitSyncRecord
      if (!r || !Array.isArray(r.pairs) || !Array.isArray(r.incoming)) return empty
      delete (r as GitSyncRecord & {heldPolicy?:unknown}).heldPolicy
      r.pairs = r.pairs.filter(p => p && typeof p.id === 'string' && safePath(p.local) && safePath(p.other) && Number.isFinite(p.at))
      r.incoming = r.incoming.filter(d => d && safePath(d.path) && ['new', 'changed', 'removed'].includes(d.kind))
      if (!Array.isArray(r.warnings)) r.warnings = []
      else r.warnings = r.warnings.filter(w => w && typeof w.code === 'string' && typeof w.message === 'string' && safePath(w.path) && (!w.copy || safePath(w.copy)))
      if ((r.reason?.code as string) === 'internal-ledger-unsafe') delete r.reason
      if (!objectId(r.remoteTip)) delete r.remoteTip
      return r
    } catch { return empty }
  }
  const save = (vault: string, r: GitSyncRecord) => options.settings.set(key(vault, 'record'), JSON.stringify(r), 'Git vault sync state', { log: false })
  function result(vault: string, r = record(vault), pending: GitSyncDocument[] = [], c?: Context, internalPending: string[] = []): GitVaultSyncResult {
    const on = enabled(vault)
    return { state: !on ? 'off' : r.reason ? 'stopped' : r.pairs.length ? 'needs-you' : (pending.length || internalPending.length) ? 'waiting-to-send' : c?.selection?.candidates.some(p => inVault(c,p.path)) ? 'held' : r.incoming.length ? 'incoming' : 'up-to-date',
      enabled: on, computerName, held: c ? c.selection?.candidates.filter(p => inVault(c,p.path)).map(p => ({path:localPath(c,p.path),cause:p.cause,state:'needs-checking' as const})) ?? [] : [], pending, incoming: r.incoming, pairs: r.pairs, warnings: r.warnings ?? [], internalPending,
      ...(on && r.reason ? { reason: r.reason, ...(['held-file-in-history','large-file-changed-elsewhere'].includes(r.reason.code)&&r.retryBlock?{retryBlock:r.retryBlock}:{}) } : {}), ...(r.lastSentAt !== undefined ? { lastSentAt: r.lastSentAt } : {}),
      ...(r.lastReceived ? { lastReceived: r.lastReceived } : {}), ...(r.checkedAt !== undefined ? { checkedAt: r.checkedAt } : {}),
      ...(c ? { location: { host: c.host, repository: c.repository, branch: c.branch, localPath: c.localPath } } : {}) }
  }
  async function context(vault: string, pin = true): Promise<Context> {
    const d = await inspectGitVault(vault, { gitEnv: options.gitEnv, timeoutMs: options.gitTimeoutMs })
    const git = syncGit(vault, options.gitEnv, options.gitTimeoutMs, options.networkTimeoutMs)
    if (d.state !== 'ready') {
      if (d.state === 'operation-in-progress') {
        const prefix = await git.text(['rev-parse', '--show-prefix'])
        const repositoryGit = syncGit(await git.text(['rev-parse', '--show-toplevel']), options.gitEnv, options.gitTimeoutMs, options.networkTimeoutMs)
        const conflicts = nul(await repositoryGit.ok(['ls-files', '--unmerged', '--full-name', '-z'])).map(line => line.slice(line.indexOf('\t') + 1))
        if (conflicts.some(path => !path.startsWith(prefix))) siblingBlocked()
      }
      refuse('repository-state', d.reason)
    }
    const rootGit = syncGit(d.root, options.gitEnv, options.gitTimeoutMs, options.networkTimeoutMs)
    const gitDir = await realpath(await rootGit.text(['rev-parse', '--absolute-git-dir']))
    const index = await rootGit.text(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    const c: Context = { ...d, gitDir, index, git: rootGit, machineId: machineIdentity() }
    const identity = record(vault).identity
    if (pin && (!identity || identity.root !== c.root || identity.gitDir !== gitDir || identity.branch !== c.branch)) refuse('repository-changed', 'The repository or branch has changed. Turn sync off and on after checking its location.')
    const conflicts = nul(await c.git.ok(['ls-files', '--unmerged', '--full-name', '-z']))
    if (conflicts.length) {
      if (conflicts.some(line => !line.slice(line.indexOf('\t') + 1).startsWith(c.prefix))) siblingBlocked()
      refuse('repository-state', 'Finish the Git conflict already in progress before syncing.')
    }
    const sparse = await c.git.run(['config', '--bool', '--get', 'core.sparseCheckout'])
    const drivers = await c.git.run(['config', '--name-only', '--get-regexp', '^merge\\..*\\.driver$'])
    if (sparse.out.toString().trim() === 'true' || drivers.out.length) refuse('unsupported', 'Sparse checkouts and custom merge drivers need syncing outside WriteFlex.')
    return c
  }
  // One selection per preparation phase. Network waits and installation boundaries refresh it;
  // Explicit proofs are revalidated against current file, index and HEAD identities.
  async function selection(c: Context, revisions?: string[]): Promise<SyncSelection> {
    if (revisions || !c.selection) {
      c.selection = await selectSyncFiles(c.git,c.root,revisions)
    }
    return c.selection
  }
  async function changes(c: Context, from: string, to?: string): Promise<GitSyncDocument[]> {
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', from, ...(to ? [to, '--'] : [])]
    const fields = nul(to ? await c.git.ok(args) : await selectedWorktreeDiff(c.git, c.root, args, await selection(c))), docs: GitSyncDocument[] = []
    for (let i = 0; i < fields.length; i += 2) if (isDocument(c, fields[i + 1])) docs.push({ path: localPath(c, fields[i + 1]), kind: fields[i] === 'A' ? 'new' : fields[i] === 'D' ? 'removed' : 'changed' })
    return docs
  }
  async function dirty(c: Context): Promise<Set<string>> {
    const paths = [...nul(await selectedWorktreeDiff(c.git, c.root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', 'HEAD'], await selection(c))), ...nul(await c.git.ok(['ls-files', '--others', '--exclude-standard', '--full-name', '-z']))]
    for (const path of paths) if (!safePath(path)) refuse('unsupported', 'A repository path cannot safely be synced.')
    return new Set(paths.filter(p => !c.selection?.large.has(p)))
  }
  async function pending(c: Context, r: GitSyncRecord): Promise<GitSyncDocument[]> {
    const map = new Map<string, GitSyncDocument>()
    const selected = await selection(c)
    let remoteTip = r.remoteTip
    if (!remoteTip) {
      const tracking = await c.git.run(['rev-parse', '--verify', `refs/remotes/${c.remote}/${c.branch}`])
      const tip = tracking.out.toString().trim()
      if (tracking.code === 0 && objectId(tip)) remoteTip = tip
    }
    if (remoteTip) for (const d of await changes(c, remoteTip, 'HEAD')) map.set(d.path, d)
    for (const d of await changes(c, 'HEAD')) map.set(d.path, d)
    for (const path of nul(await c.git.ok(['ls-files', '--others', '--exclude-standard', '--full-name', '-z']))) if (isDocument(c, path)) map.set(localPath(c, path), { path: localPath(c, path), kind: 'new' })
    for (const doc of map.values()) { const large=selected.large.get(c.prefix+doc.path); if(large&&!selected.candidates.some(p=>p.path===large.path))selected.candidates.push({...large,state:'needs-checking'}) }
    return [...map.values()].filter(d => !selected.large.has(c.prefix+d.path))
  }
  async function internalPending(c: Context, r: GitSyncRecord): Promise<string[]> {
    const selected = await selection(c)
    const paths = await dirty(c)
    if (r.remoteTip) for (const path of nul(await c.git.ok(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', r.remoteTip, 'HEAD']))) paths.add(path)
    const tree = await entries(c.git, 'HEAD'), forked = new Set(forkedJournals(tree)), pending: string[] = []
    for(const path of forked) paths.add(path)
    for (const path of paths) if (path.startsWith(c.prefix) && sharedInternal(path)) {
      if (selected.large.has(path)) continue
      if (forked.has(path)) {
        const views = new Map<string, FileImage>(); await observeFiles(c.root, [path], views)
        const bytes = views.get(path)?.bytes
        if (!bytes || await journalPublished(c.git, tree, path, bytes)) continue
      }
      pending.push(localPath(c, path))
    }
    return pending
  }
  async function scan(c: Context, parent: string, tree: string) {
    const docs = await changes(c, parent, tree), paths = docs.filter(d => d.kind !== 'removed').map(d => c.prefix + d.path)
    // Compare merges against their remote parent: received bytes are not newly sent bytes.
    const all = nul(await c.git.ok(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '--diff-filter=ACMRT', '-z', parent, tree, '--']))
    const map = await entries(c.git, tree), blobs: ScanBlob[] = []; let total = 0
    for (const path of new Set([...paths, ...all])) {
      const e = map.get(path)
      if (!e || !['100644', '100755'].includes(e.mode)) refuse('unsupported', 'An unsupported file type needs syncing outside WriteFlex.')
      const size = Number(await c.git.text(['cat-file', '-s', e.oid]))
      if (size > 10 * 1024 * 1024 || (total += size) > 64 * 1024 * 1024) refuse('scanner-unavailable', 'The document is too large for the secret check. Nothing was committed.', inVault(c, path) ? localPath(c, path) : path)
      const bytes = await c.git.ok(['cat-file', 'blob', e.oid])
      blobs.push({path,oid:e.oid,bytes})
      for(const packed of packedHistoryBlobs(path,bytes)) { if((total+=packed.bytes.length)>64*1024*1024)refuse('scanner-unavailable','The preserved history is too large for the secret check.',path); blobs.push({path:packed.path,oid:e.oid,bytes:packed.bytes}) }
    }
    let checked
    try { checked = await scanner(blobs) } catch { refuse('scanner-unavailable', 'The secret check could not finish. Nothing was committed.', docs[0]?.path ?? all[0]) }
    if ('unavailable' in checked) refuse('scanner-unavailable', 'The secret check is unavailable. Install or repair gitleaks, then try again.', docs[0]?.path ?? all[0])
    if (checked.findings.length) {
      const path = checked.findings[0].path
      refuse('secret-found', 'A possible password or key was found. Remove it from the document, then try again.', inVault(c, path) ? localPath(c, path) : path)
    }
  }
  async function commit(c: Context, tree: string, parents: string[]): Promise<string> {
    await scan(c, parents[parents.length - 1], tree)
    const count = (await changes(c, parents[0], tree)).length
    return (await c.git.ok(['-c', `user.name=WriteFlex on ${computerName}`, '-c', 'user.email=writeflex@localhost', 'commit-tree', tree,
      ...parents.flatMap(p => ['-p', p])], {}, Buffer.from(`WriteFlex: ${count} documents from ${computerName}\n\nWriteFlex-Sync: vault-v1\nWriteFlex-Computer: ${computerName}\n`))).toString().trim()
  }
  const timing = { now, sleep, wait: options.lockWaitMs ?? 180_000, poll: options.lockPollMs ?? 1000 }
  async function localTip(c: Context, scratch: string, head: string, paths: Set<string>): Promise<string> {
    const env = { GIT_INDEX_FILE: join(scratch, 'vault-index') }
    await c.git.ok(['read-tree', head], env)
    const staged = new Set(nul(await c.git.ok(['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-only', '--no-renames', '-z', head, '--'])))
    for (const path of nul(await selectedWorktreeDiff(c.git, c.root, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z'], await selection(c)))) {
      if (isDocument(c, path) && staged.has(path)) refuse('local-changes', 'This document has separate staged and unstaged versions. Finish that Git change before syncing.', localPath(c, path))
    }
    const headTree=await entries(c.git,head), privatePaths=new Set(forkedJournals(headTree))
    const selected = [...paths].filter(path => inVault(c, path) && !privatePaths.has(path) && !c.selection?.large.has(path))
    if (selected.length) {
      await checkConversions(c.git, selected)
      await c.git.ok(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], env,
        Buffer.from(selected.map(path => `:(top,literal)${path}`).join('\0') + '\0'))
    }
    let tree = await c.git.text(['write-tree'], env)
    const candidate = await entries(c.git, tree)
    if (forkedJournals(candidate).length) {
      await projectJournalForks({git:c.git, root:c.root, prefix:c.prefix, ours:new Map([...candidate].filter(([p])=>!c.selection?.large.has(p))), theirs:new Map([...headTree].filter(([p])=>!c.selection?.large.has(p))),
        ownName:computerName, otherName:'another computer', warnings:[],
        set:async (path,entry) => { if(entry) await c.git.ok(['update-index','--add','--cacheinfo',entry.mode,entry.oid,path],env); else await c.git.ok(['update-index','--force-remove','--',path],env) }})
      tree = await c.git.text(['write-tree'], env)
    }
    const old = await c.git.text(['rev-parse', `${head}^{tree}`])
    return tree === old ? head : commit(c, tree, [head])
  }
  async function integrate(c: Context, scratch: string, head: string, ours: string, remote: string, unsaved: readonly string[], warnings: GitSyncWarning[], from: string, live: Map<string, Buffer>) {
    const oursTree = await entries(c.git, ours), theirsTree = await entries(c.git, remote)
    const base = await c.git.text(['merge-base', head, remote])
    const selected = (await selection(c)).large
    const localChanged = new Set(nul(await c.git.ok(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, ours])))
    const remoteChanged = new Set(nul(await c.git.ok(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, remote, '--', '.', ...[...selected.keys()].map(p=>`:(top,exclude,literal)${p}`)])))
    for (const path of selected.keys()) {localChanged.delete(path);remoteChanged.delete(path)}
    const selfPaths=new Set<string>(), sent=record(c.vault)
    if(sent.sentTip && objectId(sent.sentTip) && sent.sentBase && objectId(sent.sentBase) && (await c.git.run(['merge-base','--is-ancestor',sent.sentTip,remote])).code===0) {
      const previouslySent=await entries(c.git,sent.sentTip)
      for(const path of nul(await c.git.ok(['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',sent.sentBase,sent.sentTip]))) {
        if(previouslySent.get(path)?.oid===theirsTree.get(path)?.oid) {selfPaths.add(path);remoteChanged.delete(path)}
      }
    }
    const forced = unsaved.map(path => { if (!safePath(path) || machineState(path)) refuse('unsupported', 'An unsaved document path is invalid.'); return c.prefix + path }).filter(path => remoteChanged.has(path))
    let tree: string, conflicts: string[] = []
    if (ours === remote) tree = await c.git.text(['rev-parse', `${ours}^{tree}`])
    else {
      // Strip held entries from disposable merge inputs: merge-tree must never unpack their blobs,
      // even when incoming and local histories disagree about them. Original ancestry remains intact.
      let mergeOurs=ours, mergeRemote=remote
      if (selected.size) {
        const mask = async (revision:string) => {
          const env={GIT_INDEX_FILE:join(scratch,'held-merge-index')}
          await c.git.ok(['read-tree',revision],env)
          for(const path of selected.keys()) await c.git.ok(['update-index','--force-remove','--',path],env)
          return c.git.text(['write-tree'],env)
        }
        const parent=(await c.git.ok(['commit-tree',await mask(base)],{},Buffer.from('WriteFlex temporary merge base\n'))).toString().trim()
        const maskedCommit=async(revision:string)=>(await c.git.ok(['commit-tree',await mask(revision),'-p',parent],{},Buffer.from('WriteFlex temporary merge view\n'))).toString().trim()
        mergeOurs=await maskedCommit(ours);mergeRemote=await maskedCommit(remote)
      }
      const merged = await c.git.run(['-c', 'merge.renames=false', 'merge-tree', '--write-tree', '--name-only', '-z', mergeOurs, mergeRemote])
      if (merged.code !== 0 && merged.code !== 1) refuse('operation-failed', 'Git could not prepare the update. No documents were changed.')
      const parts = merged.out.toString().split('\0')
      tree = parts.shift()!
      if (!objectId(tree)) refuse('operation-failed', 'Git returned an unreadable merge result. No documents were changed.')
      if (merged.code === 1) { const end = parts.indexOf(''); if (end < 0) refuse('operation-failed', 'Git returned an unreadable conflict list.'); conflicts = parts.slice(0, end); if (!conflicts.length) refuse('unsupported', 'Git reported a structural conflict that needs an update outside WriteFlex.') }
    }
    const env = { GIT_INDEX_FILE: join(scratch, `merge-${randomUUID()}`) }
    await c.git.ok(['read-tree', tree], env)
    const resolved = await entries(c.git, tree), pairs: GitSyncPair[] = []
    const set = async (path: string, e?: TreeEntry) => {
      if (!safePath(path)) refuse('unsupported', 'Git returned an invalid document path.')
      if (e) { await c.git.ok(['update-index', '--add', '--cacheinfo', e.mode, e.oid, path], env); resolved.set(path, e) }
      else { await c.git.ok(['update-index', '--force-remove', '--', path], env); resolved.delete(path) }
    }
    for (const path of selected.keys()) await set(path,oursTree.get(path))
    const eligibleTree=(tree:Map<string,TreeEntry>)=>new Map([...tree].filter(([p])=>!selected.has(p)))
    await reconcileInternals({ git: c.git, root: c.root, prefix: c.prefix, ours: eligibleTree(oursTree), theirs: eligibleTree(theirsTree),
      base: eligibleTree(await entries(c.git, base)), ownName: computerName, otherName: from, live, oursFirst: ours < remote, conflicts: new Set(conflicts), set, warnings })
    // Rename detection is advisory for pair labels only. Tree merging and all change sets use no-renames.
    const renames = new Map<string, string>(), renameFields = nul(await c.git.ok(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', '-z', base, remote, '--', '.', ...[...selected.keys()].map(p=>`:(top,exclude,literal)${p}`)]))
    for (let i = 0; i < renameFields.length;) {
      const kind = renameFields[i++]
      if (kind.startsWith('R')) { const from = renameFields[i++], to = renameFields[i++]; if (isDocument(c, from) && isDocument(c, to)) renames.set(from, to) }
      else i++
    }
    const protectedPaths = [...localChanged].filter(path => isDocument(c, path) && oursTree.has(path) && (remoteChanged.has(path) || resolved.get(path)?.oid !== oursTree.get(path)?.oid))
    // Delete/edit keeps the edit even when Git paired the local delete with a local add as a rename: Git 2.39.5's
    // merge-tree ignores merge.renames=false and merges the edit into the renamed file, where the local bytes win.
    const editedRemotely = [...localChanged].filter(path => isDocument(c, path) && !oursTree.has(path) && remoteChanged.has(path) && theirsTree.has(path))
    // Restored before any clash copy is named, so a copy never takes (and is then overwritten at) one of these paths.
    for (const path of editedRemotely) if (inVault(c, path)) await set(path, theirsTree.get(path))
    for (const path of new Set([...conflicts, ...forced, ...protectedPaths, ...editedRemotely])) {
      if (path.startsWith(c.prefix) && internalKind(path)) continue
      if (!inVault(c, path)) siblingBlocked()
      if(selfPaths.has(path)) {await set(path,oursTree.get(path));continue}
      const local = oursTree.get(path), renamed = renames.get(path), other = theirsTree.get(path) ?? (renamed ? theirsTree.get(renamed) : undefined)
      if ((local && !['100644', '100755'].includes(local.mode)) || (other && !['100644', '100755'].includes(other.mode))) refuse('unsupported', 'A conflicted file type needs syncing outside WriteFlex.', localPath(c, path))
      if (!local && !other) refuse('unsupported', 'Git reported a structural conflict that needs an update outside WriteFlex.', localPath(c, path))
      if (!local || !other) { await set(path, local ?? other); continue }
      await set(path, local)
      if (renamed && !theirsTree.has(path)) {
        // The remote version already has its intended new name. Keep local at the original name.
        await set(renamed, other)
        pairs.push({ id: randomUUID(), local: localPath(c, path), other: localPath(c, renamed), from, at: now() })
        continue
      }
      if (local.oid === other.oid && !forced.includes(path)) continue
      const ext = extname(path), stem = path.slice(0, ext ? -ext.length : undefined), date = new Date(now()).toISOString().slice(0, 10)
      let copy = '', n = 1
      do { copy = `${stem} (from ${from} ${date}${n === 1 ? '' : ` ${n}`})${ext || '.md'}`; n++ }
      while (resolved.has(copy) || await lstat(join(c.root, copy)).then(() => true, () => false))
      await set(copy, other)
      pairs.push({ id: randomUUID(), local: localPath(c, path), other: localPath(c, copy), from, at: now() })
    }
    for (const path of localChanged) if (isDocument(c, path) && oursTree.has(path) && resolved.get(path)?.oid !== oursTree.get(path)!.oid) refuse('operation-failed', 'The prepared update did not preserve this Mac’s document. No writing was changed.', localPath(c, path))
    tree = await c.git.text(['write-tree'], env)
    const oursTreeId = await c.git.text(['rev-parse', `${ours}^{tree}`]), remoteTreeId = await c.git.text(['rev-parse', `${remote}^{tree}`])
    let tip: string
    if (tree === remoteTreeId && (await c.git.run(['merge-base', '--is-ancestor', ours, remote])).code === 0) tip = remote
    else if (tree === oursTreeId && (await c.git.run(['merge-base', '--is-ancestor', remote, ours])).code === 0) tip = ours
    else tip = await commit(c, tree, ours === remote ? [ours] : [ours, remote])
    return { tip, tree, pairs, incoming: (await changes(c, ours, tree)).filter(d=>!selected.has(c.prefix+d.path)) }
  }
  async function preparedIndex(c: Context, scratch: string, original: Buffer, head: string, tip: string, deferred = new Set<string>()) {
    const path = join(scratch, 'final-index'), env = { GIT_INDEX_FILE: path }
    await writeFile(path, original)
    const newestHeld=[...(await selection(c)).large.values()].filter(p=>p.indexMtime).sort((a,b)=>b.indexMtime!-a.indexMtime!)[0]
    if(newestHeld){
      // Git's index writer hashes racily clean entries, even outside --index-info's paths.
      // Let the disposable copy genuinely become newer than the held entry's cached second.
      // No entry fields or flags are changed, and no real index lock is held while waiting.
      const delay=(newestHeld.indexMtime!+1)*1000-(await lstat(path)).mtimeMs+20
      if(delay>0){
        const document=newestHeld.path.startsWith(c.prefix)?localPath(c,newestHeld.path):newestHeld.path
        if(delay>3000)refuse('local-changes','Git recorded a large file ahead of this Mac’s clock. Check the clock and try again.',document)
        await new Promise(resolve=>setTimeout(resolve,Math.ceil(delay)))
        await writeFile(path,original)
        if(Math.floor((await lstat(path)).mtimeMs/1000)<=newestHeld.indexMtime!)refuse('local-changes','The clock changed while Git was preparing a large file. Try again.',document)
      }
    }
    const old = await entries(c.git, head), next = await entries(c.git, tip), lines: string[] = []
    for (const p of new Set([...old.keys(), ...next.keys()])) {
      if (deferred.has(p) || (p.startsWith(c.prefix) && (internalKind(p) === 'local' || excludedSyncPath(p)))) continue
      const a = old.get(p), b = next.get(p)
      if (a?.oid === b?.oid && a?.mode === b?.mode) continue
      lines.push(b ? `${b.mode} ${b.oid}\t${p}\0` : `0 ${'0'.repeat(head.length)}\t${p}\0`)
    }
    for(const p of forkedJournals(old).filter(p=>p.startsWith(c.prefix))) await c.git.ok(['update-index','--no-skip-worktree','--',p],env)
    if (lines.length) await c.git.ok(['update-index', '-z', '--index-info'], env, Buffer.from(lines.join('')))
    await skipPrivateJournals(c.git,forkedJournals(next).filter(p=>p.startsWith(c.prefix)),env)
    return readFile(path)
  }
  async function checkOwnOutsideCommits(c: Context, tip: string, remote: string) {
    const outgoing = new Set(nul(await c.git.ok(['diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z',remote,tip])))
    for (const revision of (await c.git.text(['rev-list', tip, '--not', remote])).split('\n').filter(Boolean)) {
      const marker = await c.git.text(['show', '-s', '--format=%cn%n%ce', revision])
      if (/^WriteFlex on [^\n]+\nwriteflex@localhost$/.test(marker)) continue
      const touched = nul(await c.git.ok(['diff-tree', '--root', '-r', '-m', '--no-renames', '--name-only', '--no-commit-id', '-z', revision]))
      if (touched.some(path => !path.startsWith(c.prefix) && outgoing.has(path))) refuse('outside-vault-commits', 'This repository has commits of your own outside this vault that have not been pushed. Push them with Git, then sync can continue.')
    }
  }
  async function ensureSelection(c: Context, previous: SyncSelection) {
    const next = await selection(c, ['HEAD'])
    // New large work discovered after preparation must wait for a fresh attempt, before staging or applying it.
    const path=[...next.large.keys()].find(p=>!previous.large.has(p))
    if (path) refuse('local-changes', 'A large file changed while sync was preparing. Its bytes were kept; try again.', path.startsWith(c.prefix)?localPath(c,path):path)
  }
  async function checkHeldHistory(c: Context, tip: string, remote: string) {
    for (const revision of (await c.git.text(['rev-list', tip, '--not', remote])).split('\n').filter(Boolean)) {
      const parents = (await c.git.text(['rev-list','--parents','-n','1',revision])).split(' ').slice(1)
      const touched = nul(await c.git.ok(['diff-tree','--root','-r','-m','--no-renames','--name-only','--no-commit-id','-z',revision]))
      const large=await largeTreePaths(c.git,[revision,...parents],touched),tree=await entries(c.git,revision),parentTrees=await Promise.all(parents.map(p=>entries(c.git,p)))
      const same=(a?:TreeEntry,b?:TreeEntry)=>a?.oid===b?.oid&&a?.mode===b?.mode
      const path=touched.find(p=>large.has(p)&&parentTrees.every(parent=>!same(tree.get(p),parent.get(p))))
      if(path)refuse('held-file-in-history',`${localPath(c,path)} is in an unsent commit. Nothing is being sent. Send that commit with Git${large.get(path)==='lfs'?' and Git LFS':''}, then try again.`,localPath(c,path))
    }
  }
  async function attempt(c: Context, send: boolean, call: GitSyncCall): Promise<GitSyncRecord & { received?: GitSyncDocument[] }> {
    let held: Awaited<ReturnType<typeof acquireIndex>> | undefined
    let scratch: string | undefined
    const warnings: GitSyncWarning[] = []
    try {
      // Pin the preparation snapshot; revalidate again after the short installation lock.
      const current = await context(c.vault)
      await selection(c)
      if (current.gitDir !== c.gitDir || current.branch !== c.branch || current.remote !== c.remote || current.host !== c.host || current.repository !== c.repository) refuse('repository-changed', 'The repository changed while sync was waiting.')
      const st = await lstat(c.index)
      if (!st.isFile() || st.isSymbolicLink()) refuse('unsupported', 'The repository index is not an ordinary file.')
      const originalIndex = await readFile(c.index), head = await c.git.text(['rev-parse', 'HEAD'])
      let paths = await dirty(c)
      const oldTree = await entries(c.git, head), observed = new Map<string, FileImage>()
      scratch = await mkdtemp(join(tmpdir(), 'writeflex-git-sync-'))
      let ours: string | undefined
      const tries = Math.max(1, Math.min(options.pushAttempts ?? 3, 5))
      for (let retry = 0; retry < tries; retry++) {
        warnings.length = 0
        await c.git.network(['fetch', '--no-tags', '--no-recurse-submodules', c.remote, `refs/heads/${c.branch}`])
        const remote = await c.git.text(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
        if (!objectId(remote)) refuse('operation-failed', 'Git returned an unreadable remote revision.')
        const selected = await selection(c, ['HEAD', remote])
        const incomingPaths = nul(await c.git.ok(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', head, remote, '--']))
        const remoteTree=await entries(c.git,remote)
        const changedLarge=[...selected.large.keys()].find(path=>oldTree.get(path)?.oid!==remoteTree.get(path)?.oid||oldTree.get(path)?.mode!==remoteTree.get(path)?.mode)
        try {
          if(changedLarge){const path=changedLarge.startsWith(c.prefix)?localPath(c,changedLarge):changedLarge;refuse('large-file-changed-elsewhere',`${path} is a large file that was changed in the other copy. WriteFlex does not move large files. Update this folder with Git and Git LFS, then sync carries on by itself.`,path)}
          if(send)await checkHeldHistory(c,head,remote)
        }catch(error){
          if(error instanceof GitSyncFailure&&['held-file-in-history','large-file-changed-elsewhere'].includes(error.reason.code))await save(c.vault,{...record(c.vault),retryBlock:{head,index:digest(originalIndex),remote}})
          throw error
        }
        const receivedFrom = await incomingComputer(c.git, head, remote)
        const from = call.clashFrom ?? receivedFrom ?? 'another computer'
        if(send)await checkOwnOutsideCommits(c,head,remote)
        await checkObserved(c.root, observed, c.prefix)
        paths = await dirty(c)
        const affected = [...forkedJournals(oldTree), ...paths, ...nul(await c.git.ok(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', head, remote]))].filter(path => inVault(c, path) && !selected.large.has(path))
        if (ours && affected.some(path => isDocument(c, path) && paths.has(path) && !observed.has(path))) refuse('local-changes', 'New writing was saved while sync was retrying. Its latest version was kept; try again.')
        await observeFiles(c.root, affected, observed)
        let blocked: GitSyncReason | undefined
        const receiveDeferred = new Set<string>(selected.large.keys())
        try { ours = await localTip(c, scratch, head, paths) }
        catch (error) {
          if (send || !(error instanceof GitSyncFailure) || !['secret-found', 'scanner-unavailable'].includes(error.reason.code)) throw error
          // Receiving never commits flagged local bytes. Keep every dirty vault path uncommitted,
          // including the original staged version; only integrate the already committed head.
          blocked = error.reason
          for (const path of paths) if (inVault(c, path)) receiveDeferred.add(path)
          for (const path of call.unsavedPaths ?? []) {
            if (!safePath(path) || machineState(path) || excludedSyncPath(path)) refuse('unsupported', 'An unsaved document path is invalid.')
            receiveDeferred.add(c.prefix + path)
          }
          ours = head
        }
        await checkObserved(c.root, observed, c.prefix)
        const merged = await integrate(c, scratch, head, ours, remote, blocked ? [] : call.unsavedPaths ?? [], warnings, from, new Map([...observed].flatMap(([p,image]) => image ? [[p,image.bytes] as const] : [])))
        const newTree = await entries(c.git, merged.tip)
        const planned = await planFiles(c.git, c.root, c.prefix, new Map([...oldTree].filter(([p])=>!selected.large.has(p))), new Map([...newTree].filter(([p])=>!selected.large.has(p))), paths, observed)
        const privateJournals = new Set(forkedJournals(newTree).filter(path => path.startsWith(c.prefix) && (observed.get(path) ?? planned.find(p=>p.path===path)?.before)))
        for (const path of privateJournals) receiveDeferred.delete(path)
        const plan: FileChange[] = planned.filter(change => !receiveDeferred.has(change.path) && !privateJournals.has(change.path))
        for(const [packedPath,e] of newTree) if(!selected.large.has(packedPath)&&packedPath.startsWith(c.prefix)&&packedPath.endsWith('.jsonl.sync-pack.json')) {
          for(const packed of packedHistoryBlobs(packedPath,await c.git.ok(['cat-file','blob',e.oid]))) if(!oldTree.has(packed.path)&&!newTree.has(packed.path)&&!plan.some(p=>p.path===packed.path)) {
            const before=await image(join(c.root,packed.path))
            if(before?.bytes.equals(packed.bytes))plan.push({path:packed.path,before,after:null})
          }
        }
        if (blocked) for (const path of receiveDeferred) {
          if (selected.large.has(path)) continue
          const incoming = newTree.get(path), previous = oldTree.get(path)
          if (!isDocument(c, path) || !incoming || incoming.oid === previous?.oid) continue
          const ext = extname(path), stem = path.slice(0, ext ? -ext.length : undefined), date = new Date(now()).toISOString().slice(0, 10)
          let copy: string, n = 1
          do { copy = `${stem} (from ${from} ${date}${n === 1 ? '' : ` ${n}`})${ext || '.md'}`; n++ }
          while (newTree.has(copy) || plan.some(change => change.path === copy) || await lstat(join(c.root, copy)).then(() => true, () => false))
          plan.push({ path: copy, before: null, after: { bytes: await c.git.ok(['cat-file', 'blob', incoming.oid]), mode: 0o644 } })
          merged.pairs.push({ id: randomUUID(), local: localPath(c, path), other: localPath(c, copy), from, at: now() })
        }
        // A dirty sibling which staged exactly the incoming bytes must still not have its index changed.
        for (const path of paths) if (!path.startsWith(c.prefix) && (oldTree.get(path)?.oid !== newTree.get(path)?.oid || oldTree.get(path)?.mode !== newTree.get(path)?.mode)) siblingBlocked()
        const index = await preparedIndex(c, scratch, originalIndex, head, merged.tip, receiveDeferred)
        const writePaths = plan.filter(change => change.after).map(change => change.path)
        await checkConversions(c.git, writePaths)
        const attrsEnv = { GIT_INDEX_FILE: join(scratch, 'incoming-attributes') }
        await c.git.ok(['read-tree', merged.tip], attrsEnv)
        await checkConversions(c.git, writePaths, attrsEnv, true)
        if (!enabled(c.vault)) return record(c.vault)
        if (send) {
          // Other tools may have committed since the last send. Scan their outgoing history too,
          // including an intermediate secret which disappeared from the final tree.
          for (const revision of (await c.git.text(['rev-list', merged.tip, '--not', remote])).split('\n').filter(Boolean)) {
            const parents = (await c.git.text(['rev-list', '--parents', '-n', '1', revision])).split(' ').slice(1)
            if (!parents.length) refuse('unsupported', 'An unrelated root commit needs syncing outside WriteFlex.')
            await scan(c, parents[parents.length - 1], revision)
          }
          await options.checkpoint?.('before-push')
          await ensureSelection(c, selected)
          await checkObserved(c.root, observed, c.prefix)
          const pushed = await c.git.network(['push', '--no-recurse-submodules', c.remote, `${merged.tip}:refs/heads/${c.branch}`])
          if (pushed.rejected) { if (retry + 1 === tries) refuse('push-rejected', 'The other copy kept changing. Your writing is safe here; try again shortly.'); continue }
          // These facts remain true even if subsequent local application has to roll back.
          // Preserve attention for a conflict copy already committed on the remote.
          const sent = record(c.vault)
          save(c.vault, { ...sent, warnings: [...warnings], sentTip:merged.tip,sentBase:remote, lastSentAt: now(), checkedAt: now(), remoteTip: merged.tip,
            pairs: [...new Map([...sent.pairs, ...merged.pairs].map(pair => [pair.id, pair])).values()] })
        }
        await options.checkpoint?.('before-apply')
        await ensureSelection(c, selected)
        if (!enabled(c.vault)) return record(c.vault)
        await checkObserved(c.root, new Map([...observed].filter(([path]) => plan.some(change => change.path === path))), c.prefix)
        held = await acquireIndex(c, timing)
        const latest = await context(c.vault)
        if (latest.gitDir !== c.gitDir || latest.branch !== c.branch || latest.remote !== c.remote || latest.host !== c.host || latest.repository !== c.repository) refuse('repository-changed', 'The repository changed while sync was preparing.')
        if (await c.git.text(['rev-parse', 'HEAD']) !== head || !(await readFile(c.index)).equals(originalIndex)) refuse('repository-changed', 'Another tool changed the repository while sync was preparing. Try again.')
        await prepareTransaction(c, head, merged.tip, originalIndex, index, plan, {prefix:c.prefix,from,at:now()})
        let application: Awaited<ReturnType<typeof applyFiles>>
        try { application = await applyFiles(c.root, plan, options.checkpoint, c.prefix, path => warn(warnings, { code: 'local-write-preserved', path, message: 'A newer local save was kept during rollback.' }), options.ownWrite, options.withFileLock) }
        catch(error) { await clearTransaction(c); if(error instanceof GitSyncFailure && error.reason.code==='local-changes' && error.reason.document && isDocument(c,c.prefix+error.reason.document))error.clash={document:error.reason.document,from}; throw error }
        let advanced = false, installed = false
        try {
          await held.install(index); installed = true
          await protectLiveJournals(c,privateJournals,options)
          await options.checkpoint?.('after-index-install')
          if (!(await readFile(c.index)).equals(index)) refuse('repository-changed', 'Another tool changed the index during sync installation.')
          if (merged.tip !== head) { await c.git.ok(['update-ref', `refs/heads/${c.branch}`, merged.tip, head]); advanced = true }
          await clearTransaction(c)
        } catch (error) {
          try {
            if (advanced) await c.git.ok(['update-ref', `refs/heads/${c.branch}`, head, merged.tip])
            else if (await c.git.text(['rev-parse', 'HEAD']) !== head) refuse('repository-changed', 'Another tool moved the branch during installation. Its current work was kept.')
            if (installed) {
              await held.close(); held = await acquireIndex(c, timing)
              if (!(await readFile(c.index)).equals(index)) refuse('repository-changed', 'Another tool changed the index after sync installation.')
              await held.install(originalIndex)
            }
            await application.rollback(); await clearTransaction(c)
          } catch { refuse('rollback-failed', 'Sync stopped while restoring the repository. Keep the folder here and try again.') }
          throw error
        }
        for (const path of application.deferred) warn(warnings, { code: 'internal-write-deferred', path: localPath(c, path), message: 'An internal file changed during sync. Its latest local bytes were kept for the next round.' })
        const r = record(c.vault)
        // Arrivals stay listed until the next send: a receive that brings nothing new (a follow-up queued behind
        // 'Sync now', or a periodic check) must not replace an arrival the writer has not seen with 'Up to date'.
        // The kept list keeps its own source and time; `received` is what this operation itself brought in.
        const kept = !send && !merged.incoming.length && r.incoming.length > 0
        return { ...r, warnings, reason: blocked, retryBlock:undefined, remoteTip: send ? merged.tip : remote, checkedAt: now(), incoming: send ? [] : kept ? r.incoming : merged.incoming, received: merged.incoming,
          pairs: [...new Map([...r.pairs, ...merged.pairs].map(pair => [pair.id, pair])).values()], ...(send ? { lastSentAt: now() } : {}),
          ...(plan.length && receivedFrom && !kept ? { lastReceived: { at: now(), from } } : {}) }
      }
      return refuse('push-rejected', 'The other copy kept changing. Try again shortly.')
    } catch (error) { save(c.vault, { ...record(c.vault), warnings }); throw error }
    finally { try { await held?.close() } finally { if (scratch) await rm(scratch, { recursive: true, force: true }) } }
  }
  async function perform(vaultPath: string, operation: 'status' | 'send' | 'fetch' | 'check-large-files', call: GitSyncCall = {}): Promise<GitVaultSyncResult> {
    const vault = await canonical(vaultPath)
    if (!enabled(vault)) return result(vault)
    let c: Context | undefined
    try {
      c = await context(vault)
      let received: GitSyncDocument[] = []
      return await serial(c.root, async () => {
        if (!enabled(vault)) return result(vault)
        try {
          const gitStop = await gitRenameStop()
          if (gitStop) { const r = record(vault); r.reason = gitStop; save(vault, r); return result(vault, r, await pending(c!, r).catch(() => []), c) }
          const initialSelection = await selection(c!, ['HEAD'])
          if (record(vault).reason?.code === 'git-renames') { const r = record(vault); delete r.reason; save(vault, r) }
          if(!started.has(vault)||await lstat(c!.index+'.writeflex-transaction.json').catch(()=>null)){await cleanSyncTemps(vault);started.add(vault)}
          const provenanceNotices=(record(vault).warnings??[]).filter(w=>w.message.includes('computer could not be confirmed'))
          const uncertain=await protectLiveJournals(c!,forkedJournals(await entries(c!.git,'HEAD')).filter(p=>p.startsWith(c!.prefix)&&!initialSelection.large.has(p)),options)
          if(uncertain.length){const r=record(vault);for(const path of uncertain)warn(provenanceNotices,{code:'history-kept',path:localPath(c!,path),message:'Version history is kept but not shown in the list on this Mac because its computer could not be confirmed.'});for(const notice of provenanceNotices)warn(r.warnings??=[],notice);await save(vault,r)}
          await recoverTransaction(c!, timing, options, async pairs=>{if(pairs.length){const r=record(vault);await save(vault,{...r,pairs:[...new Map([...r.pairs,...pairs].map(p=>[p.id,p])).values()]})}})
          const selected = await selection(c!, ['HEAD'])
          if (record(vault).reason?.code === 'large-file-needs-checking') { const r = record(vault); delete r.reason; save(vault, r) }
          let largeChecks: import('./git-vault-sync-types').GitSyncLargeCheck[] | undefined
          if (operation === 'check-large-files') {
            largeChecks = await checkLargeFileContents(c!, selected)
            delete c!.selection; await selection(c!, ['HEAD'])
          } else if (operation !== 'status') {
            // What this operation itself integrated, for editor refresh. Never stored: an operation that stops before
            // integrating reports nothing, so no earlier arrival is replayed.
            const keep = (run: GitSyncRecord & { received?: GitSyncDocument[] }) => { received = run.received ?? []; delete run.received; return run }
            try {save(vault,keep(await attempt(c!,operation==='send',call)))}
            catch(error) {
              if(!(error instanceof GitSyncFailure)||!error.clash)throw error
              const preserved=(record(vault).warnings??[]).filter(w=>w.code==='local-write-preserved')
              const next=await attempt(c!,operation==='send',{...call,unsavedPaths:[...new Set([...(call.unsavedPaths??[]),error.clash.document])],clashFrom:error.clash.from})
              for(const warning of preserved)warn(next.warnings??=[],warning)
              save(vault,keep(next))
            }
          }
          if(provenanceNotices.length){const r=record(vault);for(const notice of provenanceNotices)warn(r.warnings??=[],notice);await save(vault,r)}
          delete c!.selection
          return { ...result(vault, record(vault), await pending(c!, record(vault)), c, await internalPending(c!, record(vault))), received, ...(largeChecks ? {largeChecks,held:c!.selection!.candidates.filter(p=>inVault(c!,p.path)).map(p=>({path:localPath(c!,p.path),cause:p.cause,state:largeChecks!.find(check=>check.path===localPath(c!,p.path))?.state==='changed'?'changed' as const:'needs-checking' as const}))} : {}) }
        } catch (error) {
          delete c!.selection
          const r = record(vault)
          r.reason = error instanceof GitSyncFailure ? error.reason : { code: 'operation-failed', message: 'Sync could not finish. Your local writing was kept.' }
          save(vault, r)
          return result(vault, r, await pending(c!, r).catch(() => []), c, await internalPending(c!, r).catch(() => []))
        }
      })
    } catch (error) {
      const r = record(vault)
      r.reason = error instanceof GitSyncFailure ? error.reason : { code: 'operation-failed', message: 'Sync could not inspect this repository. Your writing is safe on this Mac.' }
      save(vault, r); return result(vault, r, [], c)
    }
  }
  /** Turning sync off: forked private journals rejoin Git's normal live file, their exact history kept. Needs Git. */
  async function releaseHistory(vault: string): Promise<void> {
    const c=await context(vault);await serial(c.root,async()=>{const paths=forkedJournals(await entries(c.git,'HEAD')).filter(p=>p.startsWith(c.prefix));await releaseLiveJournals(c,paths,options);if(paths.length){const r=record(vault);r.warnings=[...(r.warnings??[]).filter(w=>!(w.code==='history-kept'&&w.path===localPath(c,paths[0])&&w.message.includes('while sync is off'))),{code:'history-kept',path:localPath(c,paths[0]),message:'Restore points made on this Mac during the fork are kept but not listed while sync is off.'}];await save(vault,r)}})
  }
  return {
    checkLargeFiles: (vault: string) => perform(vault, 'check-large-files'),
    status: (vault: string) => perform(vault, 'status'),
    send: (vault: string, call: GitSyncCall = {}) => perform(vault, 'send', call),
    fetchAndIntegrate: (vault: string, call: GitSyncCall = {}) => perform(vault, 'fetch', call),
    /** The off switch's history release, for an off that was recorded while Git could not run (no Command Line Tools). */
    // Sync that never ran here (no recorded repository) left no private history to release.
    releaseHistory: async (vaultPath: string) => { const vault = await canonical(vaultPath); if (record(vault).identity) await releaseHistory(vault) },
    async setEnabled(vaultPath: string, on: boolean): Promise<GitVaultSyncResult> {
      const vault = await canonical(vaultPath)
      if (on) {
        try { const c = await context(vault, false); const r = record(vault); r.identity = { root: c.root, gitDir: c.gitDir, branch: c.branch }; delete r.reason; r.warnings=(r.warnings??[]).filter(w=>!w.message.includes('while sync is off')); save(vault, r) }
        catch (error) { const r = record(vault); r.reason = error instanceof GitSyncFailure ? error.reason : { code: 'repository-state', message: 'This repository cannot be enabled.' }; return { ...result(vault, r), state: 'stopped', reason: r.reason } }
      }
      if(!on && enabled(vault)) await releaseHistory(vault)
      await options.settings.set(key(vault, 'enabled'), on, 'Sync for this vault', { log: false })
      return perform(vault, 'status')
    },
    async dismissPair(vaultPath: string, id: string) {
      const vault = await canonical(vaultPath)
      await serial(record(vault).identity?.root ?? vault, async () => {
        const r = record(vault)
        r.pairs = r.pairs.filter(p => p.id !== id); save(vault, r)
      })
      return perform(vault, 'status')
    },
  }
}
