import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { SendProgress, pendingFingerprint } from './git-sync-progress'
/** Window-bound orchestration. The engine owns Git safety; the renderer supplies fresh buffer paths. */
import { e2eWriteHooksAllowed } from '../shared/e2e-write-hooks'
import { app, ipcMain } from 'electron'
import { relative, isAbsolute } from 'node:path'
import { EXPERIMENTAL_GIT_SYNC_KEY, EXPERIMENTAL_GIT_SYNC_OFF, SYNC_VAULTS_KEY, experimentalGitSyncOn, syncVaultPreferences } from '../shared/git-sync-settings'
import { randomUUID, createHash } from 'node:crypto'
import { createGitVaultSync } from './git-vault-sync'
import { setSyncAppendProtection } from './git-vault-sync-private-history'
import { syncGit } from './git-vault-sync-git'
import { inspectGitVault } from './git-vault-discovery'
import { stopSentences } from '../shared/git-sync-view'
import { developerToolsPresent, installDeveloperTools, recheckDeveloperTools, MISSING_TOOLS_MESSAGE } from './developer-tools'
import { allStates, stateForSender } from './state'
import type { SettingsStore } from './settings'
import type { GitVaultSyncResult } from './git-vault-sync-types'
import type { RemoteProtection } from '../shared/remote-protection'
import { createRemoteCopy, type ProtectionHolder } from './remote-copy'
export const canonicalSyncRoot=(root:string)=>{try{return realpathSync(root)}catch{return resolve(root)}}
export const relatedSyncRoots=(a:string,b:string)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/')
const translatedPaths=(from:string,to:string,paths:readonly string[])=>paths.map(p=>relative(to,join(from,p))).filter(p=>p!== '..'&&!p.startsWith('../')&&!isAbsolute(p))
let settingsPreferenceHook: (id:string,value:{enabled?:boolean;wait?:number})=>Promise<void> = async()=>{throw new Error('Sync is not ready.')}
export const changeGitSyncPreference=(id:string,value:{enabled?:boolean;wait?:number})=>settingsPreferenceHook(id,value)
let recheckHook: () => Promise<boolean> = recheckDeveloperTools
/** Check again, from the Sync tab or Settings: asks for the tools afresh and refreshes every open vault's sync. */
export const recheckGitTools = () => recheckHook()
let savedHook: (root: string, path?: string) => void = () => {}
export const gitSyncSaved = (root: string, path?: string) => savedHook(root, path)
/** The app's own start-up and quit sequence drive these; registration itself never touches app lifecycle. */
export type GitSyncLifecycle = {
  /** Starts the one-second check for due sends and periodic fetches. */
  start: () => void
  /** Stops the checks, then makes one bounded attempt to send pending work. Never rejects. */
  stop: () => Promise<void>
}
/** Whether the vault or a folder above it has a `.git` entry, read from the file system alone (no Git process). */
export function hasGitFolder(root: string): boolean {
  for (let folder = root; ; folder = dirname(folder)) {
    if (existsSync(join(folder, '.git'))) return true
    if (dirname(folder) === folder) return false
  }
}
/** Sync off and nothing run: what a vault shows on a Mac without the Command Line Tools. */
function withoutTools(root: string): { result: GitVaultSyncResult; discovery: Awaited<ReturnType<typeof inspectGitVault>>; gitFolder: boolean } {
  return {
    result: { state: 'off', enabled: false, computerName: '', pending: [], incoming: [], pairs: [], warnings: [], internalPending: [] },
    discovery: { state: 'tools-missing', reason: MISSING_TOOLS_MESSAGE },
    gitFolder: hasGitFolder(root),
  }
}
/** Eligibility is read-only; the off switch must not be toggled to ask the engine to inspect. */
async function inspectForApp(root: string): ReturnType<typeof inspectGitVault> {
  const discovery = await inspectGitVault(root)
  if (discovery.state !== 'ready') return discovery
  try {
    const git = syncGit(root, {}, 5000)
    const [sparse, drivers, conflicts] = await Promise.all([
      git.run(['config', '--bool', '--get', 'core.sparseCheckout']),
      git.run(['config', '--name-only', '--get-regexp', String.raw`^merge\..*\.driver$`]),
      git.run(['ls-files', '--unmerged', '-z']),
    ])
    if (conflicts.out.length) return { state: 'operation-in-progress', reason: stopSentences['repository-state'] }
    if (sparse.out.toString().trim() === 'true' || drivers.out.length || conflicts.code !== 0) return { state: 'unsupported', reason: stopSentences.unsupported }
    return discovery
  } catch { return { state: 'unavailable', reason: stopSentences['repository-state'] } }
}
/** A vault that has been part of Git vault sync on this Mac: its preference, or sync's own files in the Git folder.
 *  Read from settings and the file system only (no Git process). */
function syncMarker(settings: SettingsStore, root: string): boolean {
  const id = createHash('sha256').update(root).digest('hex')
  if (settings.get('git-vault-sync.enabled.' + id) === true || syncVaultPreferences(settings.get(SYNC_VAULTS_KEY))[id]) return true
  for (let folder = root; ; folder = dirname(folder)) {
    const marker = join(folder, '.git')
    if (existsSync(marker)) {
      let gitDir = marker
      try { const named = /^gitdir: (.+?)\s*$/.exec(readFileSync(marker, 'utf8')); if (named) gitDir = resolve(folder, named[1]!) } catch { /* a folder, not a file */ }
      return existsSync(join(gitDir, 'writeflex-live-history')) || existsSync(join(gitDir, 'index.writeflex-transaction.json'))
    }
    if (dirname(folder) === folder) return false
  }
}
/** Vault sync with Git switched off at launch (the default): none of its code is wired. No engine, save hook,
 *  periodic check, quit send or recovery. The Sync tab gets the remote-copy status (issue 257) and whether the
 *  vault carries a sync marker; nothing here writes to a vault. */
function registerSyncOff(settings: SettingsStore): GitSyncLifecycle {
  const { refreshProtection, currentProtection, tool } = createRemoteCopy(settings)
  const holders = new Map<string, ProtectionHolder & { discovery: Awaited<ReturnType<typeof inspectGitVault>> }>()
  ipcMain.handle('git-sync:call', async (event, input: { action: string; value?: unknown }) => {
    const displayRoot = stateForSender(event.sender.id).workspace?.root
    if (!displayRoot) return null
    const root = canonicalSyncRoot(displayRoot)
    if (input.action === 'install-tools') installDeveloperTools()
    if (input.action === 'check-tools') { await recheckDeveloperTools(); holders.delete(root) }
    const holder = holders.get(root) ?? { gitFolder: hasGitFolder(root),
      discovery: await developerToolsPresent() ? { state: 'unavailable' as const, reason: EXPERIMENTAL_GIT_SYNC_OFF } : { state: 'tools-missing' as const, reason: MISSING_TOOLS_MESSAGE } }
    holders.set(root, holder)
    refreshProtection(root, holder, input.action === 'open')
    return { root: displayRoot, result: withoutTools(root).result, discovery: holder.discovery, gitFolder: holder.gitFolder, busy: false, wait: 3,
      experimentalOff: true, syncMarker: syncMarker(settings, root), protection: currentProtection(holder), backupTool: tool }
  })
  settingsPreferenceHook = async () => { throw new Error(EXPERIMENTAL_GIT_SYNC_OFF) }
  // Only the time of a save, so a save after the last verified upload never leaves the remote copy green. No Git.
  savedHook = (windowRoot, savedPath) => {
    const file = join(canonicalSyncRoot(windowRoot), savedPath ?? '')
    for (const [root, holder] of holders) if (file === root || file.startsWith(root + '/')) holder.saves = [...(holder.saves ?? []), Date.now()].slice(-50)
  }
  return { start: () => {}, stop: async () => {} }
}
export function registerGitSync(settings: SettingsStore, changed: (state: ReturnType<typeof stateForSender>, paths: string[]) => void): GitSyncLifecycle {
  // Read once per launch: switching vault sync on or off takes effect the next time WriteFlex starts.
  const on = experimentalGitSyncOn(settings.get(EXPERIMENTAL_GIT_SYNC_KEY))
  // History appends protect forked journals only while sync runs (git-vault-sync-private-history).
  setSyncAppendProtection(on)
  if (!on) return registerSyncOff(settings)
  const ownWrite: NonNullable<import('./git-vault-sync-types').GitVaultSyncOptions['ownWrite']> = (absolute, expected) => {
    for (const state of allStates()) {
      const ws = state.workspace; if (!ws) continue
      const path = relative(canonicalSyncRoot(ws.root), absolute)
      if (!isAbsolute(path) && path !== '..' && !path.startsWith('../')) ws.recordOwnWrite(path, expected)
    }
  }
  const withFileLock: NonNullable<import('./git-vault-sync-types').GitVaultSyncOptions['withFileLock']> = async (absolute, work) => {
    const states = allStates().filter(s => { const ws=s.workspace; if(!ws)return false; const p=relative(canonicalSyncRoot(ws.root),absolute);return !isAbsolute(p)&&p!=='..'&&!p.startsWith('../') }).sort((a,b)=>a.workspace!.root.localeCompare(b.workspace!.root)||a.window.webContents.id-b.window.webContents.id)
    const take = (i:number): Promise<any> => i===states.length ? work() : states[i]!.workspace!.exclusiveAll(()=>take(i+1))
    return take(0)
  }
  const engine = createGitVaultSync({ settings, ownWrite, withFileLock })
  type Slot = { /** Issue 257: the backup tool's evidence and the folder's ignored writing, read from records only. */ protection?: RemoteProtection; /** Issue 257: when WriteFlex last saved here (any vault, sync on or off), newest last, at most 50. */ saves?: number[]; /** A quit's send did not finish: its intent is kept until a send here confirms nothing is left. */ quitMark?: boolean; /** What the writer is told about that writing. */ leftAtQuit?: 'sending' | 'waiting' | 'sent'; result: GitVaultSyncResult; discovery: Awaited<ReturnType<typeof inspectGitVault>>; busy: boolean; followUp?: 'send' | 'manual-send' | 'fetch'; wait: number; editedAt?: number; failedAt?: number; next: number; checked: number; gitFolder: boolean; firstEdited?: number; edits: Record<string, number>; progress: SendProgress }
  const { refreshProtection, currentProtection, tool } = createRemoteCopy(settings)
  const slots = new Map<string, Slot>(), requests = new Map<string, { sender: number; root: string; windowRoot: string; resolve: (paths: string[]) => void }>()
  const waitKey = (root: string) => 'git-sync.wait.' + createHash('sha256').update(root).digest('hex')
  const members = (root: string) => allStates().filter(s => !!s.workspace && relatedSyncRoots(canonicalSyncRoot(s.workspace.root), root) && !s.window.isDestroyed())
  async function buffers(root: string) {
    const lists = await Promise.all(members(root).map(state => new Promise<string[]>((resolve, reject) => {
      const id = randomUUID(), sender = state.window.webContents.id
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('The editor did not answer.')) }, 2000)
      requests.set(id, { sender, root, windowRoot:state.workspace!.root, resolve: paths => { clearTimeout(timer); resolve(translatedPaths(canonicalSyncRoot(state.workspace!.root),root,paths)) } })
      state.window.webContents.send('git-sync:prepare', { id, root:state.workspace!.root })
    })))
    return [...new Set(lists.flat())]
  }
  ipcMain.handle('git-sync:buffers', (event, input: { id: string; root: string; paths: string[] }) => {
    const request = requests.get(input.id)
    if (!request || request.sender !== event.sender.id || request.windowRoot !== input.root || stateForSender(event.sender.id).workspace?.root !== input.root) return
    if (!Array.isArray(input.paths) || input.paths.some(p => typeof p !== 'string')) return
    requests.delete(input.id); request.resolve(input.paths)
  })
  const enabledKey = (root: string) => 'git-vault-sync.enabled.' + createHash('sha256').update(root).digest('hex')
  const releaseKey = (root: string) => 'git-vault-sync.release-pending.' + createHash('sha256').update(root).digest('hex')
  /** Off while the tools are missing: permission to sync is withdrawn now; the history release, which needs Git, waits. */
  async function withdraw(root: string) {
    await settings.set(enabledKey(root), false, 'Sync for this vault', { log: false })
    await settings.set(releaseKey(root), true, 'Finish turning sync off', { log: false })
  }
  recheckHook = async () => {
    const present = await recheckDeveloperTools()
    // Open vaults load again on their next status check, with or without Git as the new answer says.
    for (const [root, slot] of slots) if (!slot.busy && (slot.discovery.state === 'tools-missing') === present) slots.delete(root)
    return present
  }
  const loading = new Map<string, Promise<Slot>>()
  // The next-open intent of a quit whose send did not finish: one machine setting per vault, written with a check.
  // When it cannot be written it stays in memory only; the next opening still finds that writing waiting to be sent.
  const resumeKey = (root: string) => waitKey(root) + '.resume'
  const markQuit = (root: string, on: boolean): Promise<boolean> => settings.setDurable(resumeKey(root), on, 'Send on next open').catch(() => false)
  const quitMarked = (root: string) => settings.get(resumeKey(root)) === true
  /** Turning sync off retires the intent: the writing stays here and is not the previous quit's to send any more. */
  async function retireQuitMark(root: string, slot: Slot) { slot.quitMark = false; slot.leftAtQuit = undefined; await markQuit(root, false) }
  async function loadOnce(root: string) {
    let slot = slots.get(root)
    if (!slot) {
      const preferences = syncVaultPreferences(settings.get(SYNC_VAULTS_KEY))
      const id = createHash('sha256').update(root).digest('hex')
      if (preferences[id] && preferences[id].path !== root) await settings.updateSyncVault(id,{path:root})
      if (settings.get(releaseKey(root)) === true && await developerToolsPresent()) {
        try { await engine.releaseHistory(root); await settings.set(releaseKey(root), false, 'Finish turning sync off', { log: false }) }
        catch (error) { console.warn('Git sync could not finish turning off; it will try again:', error instanceof Error ? error.message : error) }
      }
      const found = await developerToolsPresent()
        ? { result: await engine.status(root), discovery: await inspectForApp(root), gitFolder: await syncGit(root).run(['rev-parse', '--git-dir']).then(r => r.code === 0, () => false) }
        : withoutTools(root)
      slot = { ...found, busy: false, wait: [1, 3, 10].includes(Number(settings.get(waitKey(root)))) ? Number(settings.get(waitKey(root))) : 3, next: 0, checked: 0, firstEdited: Number(settings.get(waitKey(root) + '.pendingSince')) || undefined, edits: {}, progress:new SendProgress() }
      // A quit whose bounded send did not finish leaves its next-open intent. Opening sends at once and tells the
      // writer; the intent is cleared only once that send confirms against the other copy that nothing is left, never
      // on a local inspection alone (which may have failed and found nothing).
      if (slot.result.enabled && slot.discovery.state !== 'tools-missing' && quitMarked(root)) {
        slot.quitMark = true
        if (slot.result.pending.length || slot.result.internalPending.length) slot.leftAtQuit = 'sending'
        // Nothing seen waiting, but the check could not run: that is no proof the writing arrived.
        else if (slot.result.reason || slot.discovery.state !== 'ready') slot.leftAtQuit = 'waiting'
      }
      slots.set(root, slot)
    }
    return slot
  }
  async function load(root: string): Promise<Slot> {
    const pending = loading.get(root)
    if (pending) return pending
    const work = loadOnce(root)
    loading.set(root, work)
    try { return await work } finally { if (loading.get(root) === work) loading.delete(root) }
  }
  async function operate(root: string, send: boolean, manual = false) {
    const slot = await load(root)
    if (!slot.result.enabled || slot.discovery.state === 'tools-missing') return
    if (slot.busy) { slot.followUp = manual && send ? 'manual-send' : slot.followUp === 'manual-send' ? 'manual-send' : send ? 'send' : slot.followUp ?? 'fetch'; return }
    const editAtStart = slot.editedAt
    slot.busy = true
    try {
      const before = await pendingFingerprint(root, [...slot.result.internalPending,...slot.result.pending.map(d=>d.path)])
      if(send && !slot.progress.shouldSend(before,manual)) {slot.editedAt=undefined;return}
      const headBefore = send ? await syncGit(root).text(['rev-parse','HEAD']) : undefined
      const unsavedPaths = await buffers(root)
      if (settings.get('git-vault-sync.enabled.' + createHash('sha256').update(root).digest('hex')) !== true) return
      const result = await (send ? engine.send(root, { unsavedPaths }) : engine.fetchAndIntegrate(root, { unsavedPaths }))
      if (!members(root).length) return
      // Only what this operation itself brought in refreshes editors (the shown list may be an earlier one, kept).
      const arrived = result.received ?? []
      slot.result = result; slot.checked = Date.now()
      if(send && slot.progress.completed(before,await pendingFingerprint(root,[...result.internalPending,...result.pending.map(d=>d.path)]),result.internalPending.length>0,!result.reason,headBefore!==await syncGit(root).text(['rev-parse','HEAD']))) {slot.editedAt=undefined;console.warn('Git sync paused automatic sending because internal work made no progress. A new change will retry it.')}
      if ((result.pending.length || result.internalPending.length) && slot.editedAt === undefined) { slot.editedAt = Date.now(); slot.firstEdited ??= slot.editedAt; settings.set(waitKey(root) + '.pendingSince', slot.firstEdited, 'Pending sync time', { log: false }) }
      if (result.reason && send && slot.leftAtQuit === 'sending') slot.leftAtQuit = 'waiting'
      if (result.reason) { slot.failedAt ??= slot.firstEdited ?? Date.now(); slot.next = Date.now() + 60_000 * Math.min(10, 2 ** Math.min(3, Math.floor((Date.now() - slot.failedAt) / 60_000))) }
      else { slot.failedAt = undefined; slot.next = Date.now() + 60_000; if (send && slot.editedAt === editAtStart && !result.pending.length && !result.internalPending.length) { slot.editedAt = undefined; slot.firstEdited = undefined; settings.set(waitKey(root) + '.pendingSince', 0, 'Pending sync time', { log: false }); if (slot.quitMark && await markQuit(root, false)) { slot.quitMark = false; if (slot.leftAtQuit) slot.leftAtQuit = 'sent' } } }
      // Existing watcher/renderer path owns clean refresh and dirty-buffer protection.
      const paths = [...new Set([...arrived.map(d => d.path), ...result.pairs.flatMap(p => [p.local, p.other])])]
      for (const state of members(root)) { const ownPaths=translatedPaths(root,canonicalSyncRoot(state.workspace!.root),paths); if(ownPaths.length) { changed(state, ownPaths); state.window.webContents.send('file:changed-on-disk', ownPaths) } }
    } catch {
      slot.result = { ...slot.result, reason: { code: 'operation-failed', message: 'The editor could not confirm which documents are saved.' }, state: 'stopped' }
      slot.next = Date.now() + 60_000
    } finally { slot.busy = false; const followUp = slot.followUp; slot.followUp = undefined; if (followUp && slot.result.enabled && members(root).length) void operate(root, followUp !== 'fetch', followUp === 'manual-send') }
  }
  ipcMain.handle('git-sync:call', async (event, input: { action: string; value?: unknown }) => {
    const displayRoot = stateForSender(event.sender.id).workspace?.root
    if (!displayRoot) return null
    const root=canonicalSyncRoot(displayRoot)
    if (input.action === 'install-tools') installDeveloperTools()
    if (input.action === 'check-tools') await recheckGitTools()
    if (!(await developerToolsPresent())) {
      // No action may reach Git: sync stays off and the panel offers the installer. Turning it off still works.
      const slot = await load(root)
      if (input.action === 'disable') await withdraw(root)
      if (slot.discovery.state !== 'tools-missing' || input.action === 'open' || input.action === 'disable') Object.assign(slot, withoutTools(root))
      refreshProtection(root, slot, input.action === 'open' || input.action === 'disable')
      return { ...slot, protection: currentProtection(slot), backupTool: tool, paused: settings.get(enabledKey(root)) === true, root:displayRoot }
    }
    const slot = await load(root)
    if (input.action === 'open' && !slot.result.enabled) slot.result = await engine.status(root)
    if (input.action === 'open' || input.action === 'enable' || input.action === 'disable') {
      slot.discovery = await inspectForApp(root)
      slot.gitFolder = await syncGit(root).run(['rev-parse', '--git-dir']).then(r => r.code === 0, () => false)
    }
    if (input.action === 'enable' || input.action === 'disable') {
      if (input.action === 'disable') await retireQuitMark(root, slot)
      slot.result = await engine.setEnabled(root, input.action === 'enable')
      const preferences = syncVaultPreferences(settings.get(SYNC_VAULTS_KEY)), id = createHash('sha256').update(root).digest('hex')
      if (preferences[id]) await settings.updateSyncVault(id,{path:root})
      if (slot.result.enabled) { slot.checked = Date.now(); void operate(root, false) }
    } else if (input.action === 'send' || input.action === 'fetch') await operate(root, input.action === 'send', true)
    else if (input.action === 'done' && typeof input.value === 'string') slot.result = await engine.dismissPair(root, input.value)
    else if (input.action === 'wait' && [1, 3, 10].includes(Number(input.value))) { slot.wait = Number(input.value); await settings.set(waitKey(root), slot.wait, 'Automatic sync wait', { log: false }) }
    else if (input.action === 'open' && slot.result.enabled) { slot.checked = Date.now(); void operate(root, slot.quitMark === true) }
    if (input.action === 'e2e-idle' && e2eWriteHooksAllowed(process.env, app.isPackaged)) { if (input.value === 'offline' && slot.result.reason?.code === 'network-unavailable') slot.failedAt = Date.now() - 900001; else { slot.editedAt = Date.now() - slot.wait * 60000; slot.next = 0; tick() } }
    refreshProtection(root, slot, ['open', 'enable', 'disable'].includes(input.action))
    return { ...slot, protection: currentProtection(slot), backupTool: tool, root:displayRoot }
  })
  settingsPreferenceHook=async(id,value)=>{
    const pref=syncVaultPreferences(settings.get(SYNC_VAULTS_KEY))[id]
    if(!pref?.path)throw new Error('Open this vault in WriteFlex first.')
    const root=canonicalSyncRoot(pref.path)
    if(createHash('sha256').update(root).digest('hex')!==id)throw new Error('The vault location changed. Open it again.')
    if(typeof value.enabled==='boolean') {
      if(!(await developerToolsPresent())) {
        if(value.enabled)throw new Error(MISSING_TOOLS_MESSAGE)
        await withdraw(root);Object.assign(await load(root),withoutTools(root))
        return
      }
      if(!value.enabled)await retireQuitMark(root,await load(root))
      const result=await engine.setEnabled(root,value.enabled)
      const slot=await load(root);slot.result=result
      if(value.enabled && (!result.enabled || result.reason))throw new Error(result.reason?.message??'This vault cannot sync.')
      if(result.enabled)void operate(root,false)
    }
    if(value.wait!==undefined) {if(![1,3,10].includes(value.wait))throw new Error('Choose 1, 3 or 10 minutes.');await settings.updateSyncVault(id,{wait:value.wait as 1|3|10});(await load(root)).wait=value.wait}
  }
  savedHook = (windowRoot, savedPath) => {
    const saved = canonicalSyncRoot(windowRoot), file = savedPath === undefined ? undefined : join(saved, savedPath)
    // A save belongs to every vault whose folder holds the saved document, whichever window it was made in: the
    // vault around a nested Collection's window, and a synced vault nested inside the window's folder. That vault is
    // the one that sends, at its quiet deadline and at quit, so it must know about the save.
    const holds = (root: string) => file ? file.startsWith(root + '/') : saved === root || saved.startsWith(root + '/')
    const roots = new Set([saved, ...[...slots.keys(), ...loading.keys()].filter(holds)])
    for (let folder = file ? dirname(file) : saved; ; folder = dirname(folder)) {
      if (settings.get(enabledKey(folder)) === true) roots.add(folder)
      if (dirname(folder) === folder) break
    }
    for (const root of roots) {
      const path = file === undefined ? undefined : relative(root, file)
      void load(root).then(async slot => { slot.saves = [...(slot.saves ?? []), Date.now()].slice(-50); if (!slot.result.enabled) return; slot.progress.changed(); slot.editedAt = Date.now(); slot.firstEdited ??= slot.editedAt; if (path) slot.edits[path] = slot.editedAt; settings.set(waitKey(root) + '.pendingSince', slot.firstEdited, 'Pending sync time', { log: false }); if (!slot.busy) { slot.result = await engine.status(root); if (!slot.result.pending.length && !slot.result.internalPending.length && !slot.result.reason) { slot.editedAt = undefined; slot.firstEdited = undefined; settings.set(waitKey(root) + '.pendingSince', 0, 'Pending sync time', { log: false }) } } })
        // The save has already landed; sync bookkeeping failing afterwards must not surface as an unhandled rejection.
        .catch(error => console.warn('Git sync could not record a save:', error instanceof Error ? error.message : error))
    }
  }
  const tick = () => {
    for (const [root, slot] of slots) {
      if (!members(root).length || slot.discovery.state === 'tools-missing') continue
      slot.result.enabled = settings.get('git-vault-sync.enabled.' + createHash('sha256').update(root).digest('hex')) === true
      slot.wait = Number(settings.get(waitKey(root))) || 3
      if (!slot.result.enabled || slot.busy || Date.now() < slot.next) continue
      if (slot.editedAt && Date.now() - slot.editedAt >= slot.wait * 60_000) void operate(root, true)
      else if (Date.now() - slot.checked >= 600_000 && members(root).some(s => s.window.isFocused())) void operate(root, false)
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined
  const quitAttempt = async () => {
    const short = createGitVaultSync({ settings, ownWrite, withFileLock, networkTimeoutMs: 2000, gitTimeoutMs: 2000, lockWaitMs: 500 })
    const pending = [...slots].filter(([, s]) => s.result.enabled && s.discovery.state !== 'tools-missing' && (s.editedAt || s.result.pending.length || s.result.internalPending.length))
    let bound: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.all(pending.map(async ([root]) => {
      // On disk before sending: a send cut short by the quit is finished on the next opening, and the writer told.
      const slot = slots.get(root)!
      slot.quitMark = true
      let recorded = await markQuit(root, true)
      if (!recorded) console.warn('Git sync could not record unsent writing for the next opening; it will try again after sending.')
      const result = await short.send(root, { unsavedPaths: members(root).length ? await buffers(root) : [] })
      if (!result.reason && !result.pending.length && !result.internalPending.length) { slot.quitMark = false; await markQuit(root, false) }
      else if (!recorded && !(recorded = await markQuit(root, true))) console.warn('Git sync could not record unsent writing for the next opening. It stays waiting here and goes with the next automatic send.')
    })), new Promise(resolve => { bound = setTimeout(resolve, 3000) })])
      .finally(() => clearTimeout(bound))
  }
  return {
    start: () => { if (timer) return; timer = setInterval(tick, 1000); timer.unref() },
    stop: async () => {
      if (timer) { clearInterval(timer); timer = undefined }
      // A renderer closing during the buffer handshake must never cancel normal quit.
      try { await quitAttempt() } catch { /* pending work is retried on the next open */ }
    },
  }
}
