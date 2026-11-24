// Git vault sync: On/off settings.
// Guards ADR-0055 "App integration" (parcel 2) and parcel 4: switching sync off means no Git operation at all; the per-machine, per-vault switch persists and survives concurrent setting writes.
// Real `git`, a bare remote and two clones through the shared fixture; no Electron.
import { test, expect } from 'bun:test'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createGitVaultSync } from '../../src/main/git-vault-sync'
import { SettingsStore } from '../../src/main/settings'
import { fixture, snapshot, mergesWithoutRenames } from './git-vault-sync-fixture'

const timeout = 60_000

test('switch off means no Git operation; per-machine per-vault switch survives a new SettingsStore', async () => {
  const f = await fixture(false, false)
  try {
    await f.put(f.a, 'draft.md', 'Off means leave this alone.\n'); const before = await snapshot(f)
    const trace = join(f.base, 'off-git-trace.log')
    const off = f.engineA({ gitEnv: { ...f.gitEnv, GIT_TRACE: trace } })
    expect((await off.status(f.av)).state).toBe('off'); expect((await off.send(f.av)).state).toBe('off'); expect((await off.fetchAndIntegrate(f.av)).state).toBe('off')
    expect(await lstat(trace).then(() => true, () => false)).toBe(false)
    expect(await snapshot(f)).toEqual(before)
    await f.A.setEnabled(f.av, true)
    const reopened = createGitVaultSync({ settings: new SettingsStore(join(f.base, 'a-settings.json')), gitEnv: f.gitEnv, renameProbe: mergesWithoutRenames })
    expect((await reopened.status(f.av)).enabled).toBe(true); expect((await f.B.status(f.bv)).enabled).toBe(false)
    await reopened.setEnabled(f.av, false); expect((await reopened.send(f.av)).state).toBe('off'); expect(await snapshot(f)).toEqual(before)
  } finally { await f.close() }
}, timeout)

test('S8 simultaneous shared-setting updates retain both vaults',async()=>{
 const f=await fixture();let shared: any
 try{
  const {openPreferences}=await import('../../src/main/shared-preferences')
  shared=await openPreferences(f.settingsA,f.base,'0.29.0',()=>{})
  const a='a'.repeat(64),b='b'.repeat(64)
  await Promise.all([f.settingsA.set('git-vault-sync.enabled.'+a,true,'A'),f.settingsA.set('git-vault-sync.enabled.'+b,true,'B')])
  expect(f.settingsA.get('git-vault-sync.enabled.'+a)).toBe(true);expect(f.settingsA.get('git-vault-sync.enabled.'+b)).toBe(true)
  await Promise.all([f.settingsA.set('git-vault-sync.enabled.'+a,false,'Off'),f.settingsA.updateSyncVault(a,{path:'/synthetic/vault'})])
  expect(f.settingsA.get('git-vault-sync.enabled.'+a)).toBe(false)
  expect(JSON.parse(String(f.settingsA.get('sync.vaults')))[a].path).toBe('/synthetic/vault')
 }finally{await shared?.close();await f.close()}
},120000)
