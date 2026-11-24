// Entry of the Settings window: the shared @app-patterns/settings-react window over WriteFlex's schema and
// command registry, plus WriteFlex's own pages. State and every action come from main through the
// preload bridge (window.bridleSettings); nothing here reads or writes a file.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { SettingsWindow, type RowHint, type SheetState, type Slot } from '@app-patterns/settings-react'
import type { SectionRequest, SettingsView } from '@app-patterns/settings-electron'
import '@app-patterns/settings-react/settings.css'
import './styles/tokens.css'
import './styles/sharing.css'
import './settings-page.css'
import { currentPages } from './settings-current-pages'
import { MENUS } from '../../shared/bridle-commands'
import { ACCOUNT_SLOTS, schema } from '../../shared/settings-schema'
import { settingsDisplaySchema, settingsShortcutDisplay } from './settings-display'
import { useCustomPages, usePlatformVoices } from './settings-pages'

const bridge = window.bridleSettings

const ROW_HINTS: Record<string, RowHint> = {
  'appearance.theme': { control: 'segmented' },
  'editor.viewMode': { control: 'segmented' },
  'editor.lineWidth': { control: 'segmented' },
  'editor.proseSize': { control: 'segmented' },
  'editor.fixedLine': { control: 'segmented', summary: '0.33 top third · 0.5 middle · 0.67 lower third' },
  'editor.ruler.opacity': { step: 5 },
  'readAloud.rate': { step: 0.1 },
  'sounds.typing.enabled': { summary: 'Distinct sounds for keys, Space, Return and Backspace' },
  'sounds.typing.scheme': { control: 'segmented' },
  'sounds.typing.volume': { step: 0.05 },
  'sounds.ambient.volume': { step: 0.05 },
  'agent.model': { summary: 'Choose it on the Model page', example: 'openai-codex::gpt-5.5' },
  'readAloud.voiceURI': { summary: 'Choose it on the Voice page' },
  'keyboard.appKeys': { summary: 'Managed by migration. Rebind commands on the Shortcuts page.' },
}

type Opened = { section: string; sheet?: SheetState; n: number }

function SettingsApp(): React.JSX.Element | null {
  const voices = usePlatformVoices()
  const [view, setView] = useState<SettingsView | null>(null)
  const [opened, setOpened] = useState<Opened>({ section: 'general', n: 0 })
  const [seenAt, setSeenAt] = useState(() => Date.now())
  const open = useCallback(async (req: SectionRequest): Promise<void> => {
    let sheet: SheetState | undefined
    if (req.action === 'import') {
      const picked = await bridge.importPick()
      if (picked) sheet = { kind: picked.preview.refused ? 'refused' : 'import', fileName: picked.fileName, preview: picked.preview }
    }
    setOpened((o) => ({ section: req.section, ...(sheet ? { sheet } : {}), n: o.n + 1 }))
  }, [])

  useEffect(() => {
    const focus = (): void => {
      const element = document.activeElement
      void window.writeflexSettings.menuFocus(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable)).catch(() => {})
    }
    document.addEventListener('focusin', focus)
    document.addEventListener('focusout', focus)
    return () => { document.removeEventListener('focusin', focus); document.removeEventListener('focusout', focus) }
  }, [])

  useEffect(() => {
    void bridge.view().then((v) => {
      setView(v)
      if (v.request) void open(v.request)
    })
    const offChanged = bridge.onChanged(setView)
    const offSection = bridge.onSection((r) => void open(r))
    return () => {
      offChanged()
      offSection()
    }
  }, [open])

  // ChatGPT is a sign-in, not a key: its row offers Sign out, and signing in is on the Sign in page.
  const slots = useMemo<Slot[] | undefined>(() => view?.slots.map((s) => ({
    ...s,
    group: 'Model providers',
    ...(ACCOUNT_SLOTS.has(s.id) ? { kind: 'account' as const, icon: 'message-circle' } : { icon: 'key-round' }),
  })), [view])
  const customPages = useCustomPages(view, useCallback(() => setOpened(o => ({ section: 'accounts', n: o.n + 1 })), []))

  if (!view) return null
  const pages = [...customPages.filter(p => p.id !== 'command-line'), ...currentPages(view, (section, sheet) => setOpened(o => ({ section, sheet, n: o.n + 1 })))]
  return (
    <>
      <div className="wf-titlebar">Settings</div>
      {view.problem && <div role="alert" className="wf-settings-problem">{view.problem}</div>}
      <SettingsWindow
        key={opened.n}
        className="wf-settings"
        schema={settingsDisplaySchema(view.state, voices)}
        {...settingsShortcutDisplay(view.state)}
        menus={MENUS}
        appInfo={view.appInfo}
        actions={{ ...bridge, signOut: (id) => bridge.removeSecret(id) }}
        {...(slots ? { slots } : {})}
        rowHints={view.state.settings['diary.folder'] ? ROW_HINTS : {
          ...ROW_HINTS,
          'diary.folder': { summary: 'Choose a Diary folder before starting a session.' },
        }}
        customPages={pages}
        changesSeenAt={seenAt}
        onChangesSeen={setSeenAt}
        initial={{ section: opened.section, ...(opened.sheet ? { sheet: opened.sheet } : {}) }}
      />
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
)
