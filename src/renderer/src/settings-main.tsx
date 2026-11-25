// Entry of the Settings window: the shared @app-patterns/settings-react window over WriteFlex's schema and
// command registry, plus WriteFlex's own pages. State and every action come from main through the
// preload bridge (window.bridleSettings); nothing here reads or writes a file.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { SettingsWindow, type RowHint, type SheetState, type Slot } from '@app-patterns/settings-react'
import type { SectionRequest, SettingsView } from '@app-patterns/settings-electron'
import '@app-patterns/settings-react/settings.css'
import './styles/tokens.css'
import './styles/sharing.css'
import './settings-page.css'
import { currentPages } from './settings-current-pages'
import { MENUS } from '../../shared/bridle-commands'
import { THEME_SETTING } from '../../shared/appearance'
import { useAppearance } from './hooks/useAppearance'
import { ACCOUNT_SLOTS, schema } from '../../shared/settings-schema'
import { settingsDisplaySchema, settingsShortcutDisplay } from './settings-display'
import { WindowTitlebar } from './components/WindowTitlebar'
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
  'sounds.typing.volume': { step: 0.05 },
  'sounds.ambient.volume': { step: 0.05 },
  'agent.model': { summary: 'Choose it on the Model page', example: 'openai-codex::gpt-5.5' },
  'readAloud.voiceURI': { summary: 'Choose it on the Voice page' },
  'keyboard.appKeys': { summary: 'Managed by migration. Rebind commands on the Shortcuts page.' },
}

type Opened = { section: string; sheet?: SheetState; n: number }

function SettingsApp(): React.JSX.Element {
  const voices = usePlatformVoices()
  const [view, setView] = useState<SettingsView | null>(null)
  useAppearance(view?.state.settings[THEME_SETTING])
  const [opened, setOpened] = useState<Opened>({ section: 'general', n: 0 })
  const [seenAt, setSeenAt] = useState(() => Date.now())
  const [viewFailed, setViewFailed] = useState(false)
  const [importFailed, setImportFailed] = useState(false)
  const sectionVersion = useRef(0)
  const readView = useRef<(() => void) | null>(null)
  const showSection = useCallback((section: string, sheet?: SheetState): number => {
    const n = ++sectionVersion.current
    setImportFailed(false)
    setOpened({ section, n, ...(sheet ? { sheet } : {}) })
    return n
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
    let live = true
    let hasView = false
    let latestRead = 0
    let pendingImport: { section: string; n: number } | null = null

    const startImport = (): void => {
      if (!hasView || !pendingImport) return
      const { section, n } = pendingImport
      pendingImport = null
      const isCurrent = () => live && n === sectionVersion.current
      if (!isCurrent()) return
      void Promise.resolve(bridge.importPick()).then((picked) => {
        if (!isCurrent() || !picked) return
        showSection(section, {
          kind: picked.preview.refused ? 'refused' : 'import', fileName: picked.fileName, preview: picked.preview,
        })
      }, () => { if (isCurrent()) setImportFailed(true) })
    }
    const open = (request: SectionRequest): void => {
      const n = showSection(request.section)
      pendingImport = request.action === 'import' ? { section: request.section, n } : null
      startImport()
    }
    const acceptView = (next: SettingsView): void => {
      hasView = true
      setView(next)
      setViewFailed(false)
    }

    const offChanged = bridge.onChanged((next) => {
      acceptView(next)
      startImport()
    })
    const offSection = bridge.onSection(open)
    const read = (): void => {
      const n = ++latestRead
      // A pushed view supersedes any pending read of the initial view.
      const isCurrent = () => live && n === latestRead && !hasView
      setViewFailed(false)
      void bridge.view().then((next) => {
        if (!isCurrent()) return
        acceptView(next)
        // The host can return the original open request on retry. Any section already received wins.
        if (next.request && sectionVersion.current === 0) open(next.request)
        else startImport()
      }, () => { if (isCurrent()) setViewFailed(true) })
    }
    readView.current = read
    // Subscribe first. In development, let StrictMode discard its first effect before the one-shot host request.
    queueMicrotask(() => { if (live) read() })
    return () => {
      live = false
      readView.current = null
      offChanged()
      offSection()
    }
  }, [showSection])

  // ChatGPT is a sign-in, not a key: its row offers Sign out, and signing in is on the Sign in page.
  const slots = useMemo<Slot[] | undefined>(() => view?.slots.map((s) => ({
    ...s,
    group: 'Model providers',
    ...(ACCOUNT_SLOTS.has(s.id) ? { kind: 'account' as const, icon: 'message-circle' } : { icon: 'key-round' }),
  })), [view])
  const customPages = useCustomPages(view, useCallback(() => { showSection('accounts') }, [showSection]))

  const titlebar = <WindowTitlebar className="wf-titlebar"><span>Settings</span></WindowTitlebar>
  if (!view) return (
    <>
      {titlebar}
      {viewFailed ? (
        <div role="alert" className="bsw-notice wf-settings-problem">
          <span>Settings could not be loaded.</span>
          <button type="button" className="bsw-btn" onClick={() => readView.current?.()}>Try again</button>
        </div>
      ) : <div role="status" className="wf-settings-loading">Loading settings…</div>}
    </>
  )
  const pages = [...customPages.filter(p => p.id !== 'command-line'), ...currentPages(view, showSection)]
  return (
    <>
      {titlebar}
      {view.problem && <div role="alert" className="bsw-notice wf-settings-problem">{view.problem}</div>}
      {importFailed && <div role="alert" className="bsw-notice wf-settings-problem">Could not start the settings import.</div>}
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
