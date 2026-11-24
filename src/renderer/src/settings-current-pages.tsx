// Reuse the app's current Settings controls inside the shared window.
import { useEffect, useState } from 'react'
import type { CustomPage, SheetState } from '@app-patterns/settings-react'
import type { SettingsView } from '@app-patterns/settings-electron'
import { AboutPanel } from './components/settings/AboutPanel'
import { BackupSettingsPanel } from './components/settings/BackupSettingsPanel'
import { SharingSettingsPanel } from './components/settings/SharingSettingsPanel'
import { SharingSetup } from './components/sharing/SharingSetup'
import { ScratchpadSettingsPanel } from './components/settings/ScratchpadSettingsPanel'
import AgentSkillSettings from './components/settings/AgentSkillSettings'

function SharingPage(): JSX.Element {
  const [setup, setSetup] = useState(false)
  const [notice, setNotice] = useState('')
  return <div className="wf-current-page">{notice && <p role="status">{notice}</p>}{setup
    ? <SharingSetup pieceName={null} onBack={() => setSetup(false)} onFlash={setNotice} onOpenSettings={() => setSetup(false)} onDone={() => setSetup(false)} />
    : <SharingSettingsPanel onFlash={setNotice} onOpenSetup={() => setSetup(true)} />}</div>
}

function CurrentPage({ kind, view, resetAll }: { kind: string; view: SettingsView; resetAll(): void }): JSX.Element {
  const [notice, setNotice] = useState('')
  const [context, setContext] = useState<{ root: string | null }>({ root: null })
  useEffect(() => {
    let serial = 0
    const refresh = (): void => {
      const request = ++serial
      void window.writeflexSettings.context().then(context => { if (request === serial) setContext(context) }).catch(() => {})
    }
    const off = window.writeflexSettings.onContextChanged(refresh)
    refresh()
    return () => { ++serial; off() }
  }, [])
  const set = (key: string, value: string | number | boolean, _label: string): void => {
    void Promise.resolve(window.bridleSettings.set(key, value)).then(r => { if (!r.ok) setNotice(r.error) }).catch(() => setNotice('That setting could not be saved.'))
  }
  return <div className="wf-current-page">
    {notice && <p role="status">{notice}</p>}
    {kind === 'updates' && <><AboutPanel onFlash={setNotice} onSet={set} /><button type="button" onClick={resetAll}>Reset all settings…</button></>}
    {kind === 'backup' && <><p className="sub">Vault: {context.root ?? 'Open a vault, then reopen Settings to change its backup.'}</p><BackupSettingsPanel onFlash={setNotice} /></>}
    {kind === 'scratchpad' && <ScratchpadSettingsPanel values={view.state.settings} onSet={set} onFlash={setNotice} workspaceRoot="settings" />}
    {kind === 'command-line' && <AgentSkillSettings onFlash={setNotice} />}
  </div>
}

export function currentPages(view: SettingsView, openSheet: (section: string, sheet: SheetState) => void): CustomPage[] {
  return [
    { id: 'updates', label: 'About and updates', icon: 'info', render: () => <CurrentPage kind="updates" view={view} resetAll={() => openSheet('updates', { kind: 'reset-all' })} /> },
    { id: 'backup', label: 'Backup', icon: 'cloud', render: () => <CurrentPage kind="backup" view={view} resetAll={() => {}} /> },
    { id: 'sharing', label: 'Sharing', icon: 'share', render: () => <SharingPage /> },
    { id: 'scratchpad', label: 'Scratchpad', icon: 'clipboard', render: () => <CurrentPage kind="scratchpad" view={view} resetAll={() => {}} /> },
    { id: 'command-line', label: 'Agents and command-line tool', icon: 'terminal', render: () => <CurrentPage kind="command-line" view={view} resetAll={() => {}} /> },
  ]
}
