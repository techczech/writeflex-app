import { EXPERIMENTAL_GIT_SYNC_KEY, SYNC_VAULTS_KEY, experimentalGitSyncOn, syncVaultPreferences } from '../../shared/git-sync-settings'
import { stopSentences } from '../../shared/git-sync-view'
// WriteFlex's own pages in the shared Settings window (the package's custom-page slot). They hold what
// is not a single setting: the ChatGPT sign-in, the model and voice lists, the Counted Collections, the
// command-line tool and Get started. Every call goes through window.writeflexSettings, which main answers
// only for this window; a preference is written through the shared bridge (window.bridleSettings).
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import type { CustomPage } from '@app-patterns/settings-react'
import type { SettingsView } from '@app-patterns/settings-electron'
import { useIpcAuthFlow } from '@bridle/electron/renderer'
import { groupReadAloudVoices, type SpeechVoiceInfo } from './editor/speech-engine'
import type { SettingsCountedCollection, SettingsModelChoice } from '../../preload/settings-api'

const PROVIDER_NAMES: Record<string, string> = { 'openai-codex': 'ChatGPT', anthropic: 'Anthropic', zai: 'Z.ai' }
const providerName = (id: string): string => PROVIDER_NAMES[id] ?? id

function Notice({ text }: { text: string | null }): JSX.Element | null {
  return text ? <p className="wf-page-note" role="status">{text}</p> : null
}

function SignIn(): JSX.Element {
  const flow = useIpcAuthFlow(window.writeflexSettings.auth, { defaultProviderId: 'openai-codex' })
  const [answer, setAnswer] = useState('')
  const oauth = flow.providers.filter((p) => p.authLanes.includes('oauth'))
  const busy = flow.state.phase === 'authorising' || flow.state.phase === 'auth-url' || flow.state.phase === 'device-code' || flow.state.phase === 'progress' || flow.state.phase === 'input'
  const status =
    flow.state.phase === 'authorising' ? 'Starting sign-in…'
    : flow.state.phase === 'auth-url' ? `Your browser opened for sign-in.${flow.state.instructions ? ` ${flow.state.instructions}` : ''}`
    : flow.state.phase === 'device-code' ? `Enter code ${flow.state.userCode} at ${flow.state.verificationUri}`
    : flow.state.phase === 'progress' ? flow.state.message
    : flow.state.phase === 'complete' ? `Signed in to ${providerName(flow.state.providerId)}.`
    : flow.state.phase === 'error' ? `Sign-in failed: ${flow.state.message}`
    : null
  const input = flow.state.phase === 'input' ? flow.state.request : null
  return (
    <div className="wf-page">
      <p className="wf-page-note">Sign in with your ChatGPT account to use the OpenAI models. API keys for Anthropic and Z.ai are added in Accounts and keys.</p>
      {oauth.map((provider) => (
        <div className="wf-page-row" key={provider.id}>
          <div className="grow">
            <div>{providerName(provider.id)}</div>
            <div className="sub">{provider.configured ? 'Signed in' : 'Not signed in'}</div>
          </div>
          {provider.configured
            ? <button type="button" onClick={() => flow.logout(provider.id)}>Sign out</button>
            : <button type="button" disabled={busy} onClick={() => void flow.login(provider.id)}>Sign in…</button>}
        </div>
      ))}
      <Notice text={status} />
      {input && (
        <form className="wf-page-row" onSubmit={(e) => { e.preventDefault(); flow.respond(input.requestId, answer); setAnswer('') }}>
          <input className="grow" value={answer} placeholder={input.placeholder ?? ''} aria-label={input.message ?? 'Answer'} onChange={(e) => setAnswer(e.target.value)} />
          <button type="submit">Continue</button>
        </form>
      )}
      {busy && <button type="button" onClick={() => flow.cancel()}>Cancel sign-in</button>}
    </div>
  )
}

function ModelPage({ view, openAccounts }: { view: SettingsView; openAccounts(): void }): JSX.Element {
  const [models, setModels] = useState<SettingsModelChoice[] | null>(null)
  const [fallback, setFallback] = useState<string>('')
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    void window.writeflexSettings.models().then((r) => {
      setModels(r.models)
      setFallback(`${r.defaults.model.provider}::${r.defaults.model.id}`)
    }).catch(() => setModels([]))
  }, [])
  const stored = typeof view.state.settings['agent.model'] === 'string' ? String(view.state.settings['agent.model']) : ''
  const selected = stored || fallback
  const choose = async (raw: string): Promise<void> => {
    const r = await window.bridleSettings.set('agent.model', raw)
    setNotice(r.ok ? null : r.error)
  }
  return (
    <div className="wf-page">
      <p className="wf-page-note">The model WriteFlex uses for suggestions and housekeeping. Only the models of providers you are signed in to, or have a key for, are listed.</p>
      {models === null ? <p className="wf-page-note">Looking for models…</p> : models.length === 0 && !selected ? (
        <p className="wf-page-note">No models are available yet: sign in or add a key first.</p>
      ) : (
        <ModelChoices models={models} selected={selected} onChoose={choose} />
      )}
      {models !== null && selected && !models.some(m => `${m.provider}::${m.id}` === selected) && <p role="status">The saved model is unavailable. <button type="button" onClick={openAccounts}>Sign in or add a key</button></p>}
      <Notice text={notice} />
    </div>
  )
}

/** Options come only from the runnable inventory; an unavailable selection remains explicit. */
export function ModelChoices({ models, selected, onChoose }: { models: SettingsModelChoice[]; selected: string; onChoose(value: string): void }): JSX.Element {
  return <div className="wf-page-row"><label className="grow" htmlFor="wf-model">Model</label>
    <select id="wf-model" value={selected} onChange={e => onChoose(e.target.value)}>
      {!models.some(m => `${m.provider}::${m.id}` === selected) && selected && <option value={selected}>{selected}</option>}
      {models.map(m => <option key={`${m.provider}::${m.id}`} value={`${m.provider}::${m.id}`}>{`${m.name} (${providerName(m.provider)})`}</option>)}
    </select></div>
}

export function usePlatformVoices(): SpeechVoiceInfo[] {
  const [voices, setVoices] = useState<SpeechVoiceInfo[]>([])
  useEffect(() => {
    const synth = globalThis.speechSynthesis
    const read = (): void => setVoices((synth?.getVoices() ?? []).map(v => ({ uri: v.voiceURI, name: v.name, lang: v.lang, isDefault: v.default })))
    read()
    synth?.addEventListener?.('voiceschanged', read)
    return () => synth?.removeEventListener?.('voiceschanged', read)
  }, [])
  return voices
}

export function VoiceChoices({ voices, stored, onChoose }: { voices: SpeechVoiceInfo[]; stored: string; onChoose(value: string): void }): JSX.Element {
  const { featured, other } = groupReadAloudVoices(voices)
  return <div className="wf-page-row"><label className="grow" htmlFor="wf-voice">Voice</label>
    <select id="wf-voice" value={stored} onChange={e => onChoose(e.target.value)}>
      <option value="">System voice</option>
      {stored && !voices.some(v => v.uri === stored) && <option value={stored}>{stored} (unavailable)</option>}
      {[...featured, ...other].map(v => <option key={v.uri} value={v.uri}>{`${v.name} (${v.lang})`}</option>)}
    </select></div>
}

function VoicePage({ view }: { view: SettingsView }): JSX.Element {
  const voices = usePlatformVoices()
  const stored = typeof view.state.settings['readAloud.voiceURI'] === 'string' ? String(view.state.settings['readAloud.voiceURI']) : ''
  return (
    <div className="wf-page">
      <p className="wf-page-note">The voice Read aloud uses. The system voice follows the voice chosen in macOS.</p>
      <VoiceChoices voices={voices} stored={stored} onChoose={value => { void window.bridleSettings.set('readAloud.voiceURI', value) }} />
    </div>
  )
}

function CountedPage(): JSX.Element {
  const [list, setList] = useState<SettingsCountedCollection[] | null>(null)
  const [changes, setChanges] = useState<Awaited<ReturnType<typeof window.writeflexSettings.countedChanges>>>([])
  const [notice, setNotice] = useState<string | null>(null)
  const load = useCallback(() => { void Promise.all([window.writeflexSettings.countedCollections(), window.writeflexSettings.countedChanges()]).then(([items, history]) => { setList(items); setChanges(history) }).catch(() => setList([])) }, [])
  useEffect(load, [load])
  return (
    <div className="wf-page">
      <p className="wf-page-note">Collections whose writing counts toward the Diary. A Collection is counted from the main window (Count toward the Diary); here it can be un-counted.</p>
      {list === null ? null : list.length === 0 ? <p className="wf-page-note">No Collections count toward the Diary.</p> : list.map((c) => (
        <div className="wf-page-row" key={`${c.root}:${c.dir}`}>
          <div className="grow">
            <div>{c.name}</div>
            <div className="sub">{c.pieces} {c.pieces === 1 ? 'piece' : 'pieces'}</div>
          </div>
          <button type="button" onClick={() => void window.writeflexSettings.uncount(c.root, c.dir).then(() => load(), (e: unknown) => setNotice(e instanceof Error ? e.message : 'That could not be changed.'))}>Un-count</button>
        </div>
      ))}
      {changes.length > 0 && <div><h3>Counted Collection changes</h3>{changes.map(change => <div className="wf-page-row wf-counted-change" key={`${change.key}:${change.at}`}>
        <div className="grow">{change.label}<div className="sub">{change.old === true ? 'On' : 'Off'} → {change.new === true ? 'On' : 'Off'}{change.reverted ? ' · reset' : ''}</div></div>
        <button type="button" disabled={change.reverted} aria-label={`Reset ${change.label}`} onClick={() => void window.writeflexSettings.resetCounted({ index: change.index, key: change.key, at: change.at }).then(load, (e: unknown) => setNotice(e instanceof Error ? e.message : 'That change could not be reset.'))}>Reset</button>
      </div>)}</div>}
      <Notice text={notice} />
    </div>
  )
}

function CommandLinePage(): JSX.Element {
  const [notice, setNotice] = useState<string | null>(null)
  return (
    <div className="wf-page">
      <p className="wf-page-note">The writeflex command lets Claude Code, Codex and other agents search and read your Collection, and change WriteFlex’s settings with writeflex settings.</p>
      <div className="wf-page-row">
        <div className="grow">Command-line tool</div>
        <button type="button" onClick={() => void window.writeflexSettings.installCommandLineTool().then((r) => setNotice(r.message), () => setNotice('Could not install the command-line tool.'))}>Install command-line tool</button>
      </div>
      <Notice text={notice} />
    </div>
  )
}

function GetStartedPage(): JSX.Element {
  const [state, setState] = useState<{ removed: boolean; canRestore: boolean }>({ removed: false, canRestore: false })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const load = (): void => { void window.writeflexSettings.getStarted().then(setState).catch(() => setNotice('The example’s status could not be read.')) }
  useEffect(load, [])
  const run = (id: 'view.configureActionBar' | 'guide.open' | 'example.restore'): void => { void window.writeflexSettings.runInMainWindow(id) }
  const restore = async (): Promise<void> => {
    setBusy(true); setNotice(null)
    try { const result = await window.writeflexSettings.restoreExample(); if (!result.ok) setNotice(result.message ?? 'The example could not be restored.'); load() }
    catch { setNotice('The example could not be restored.') }
    finally { setBusy(false) }
  }
  return (
    <div className="wf-page" id="sec-get-started">
      <h3>Get started</h3>
      <div className="wf-page-row" data-row="get-started">
        <div className="grow"><span className="lbl">Get started</span>{state.removed && <small>The example was removed</small>}</div>
        {state.canRestore && <button type="button" data-action="restore-example" disabled={busy} onClick={() => void restore()}>Show the example on the start screen again</button>}
        <button type="button" data-action="open-guide" onClick={() => run('guide.open')}>Open the Guide</button>
      </div>
      <div className="wf-page-row"><div className="grow">The action bar’s buttons</div><button type="button" onClick={() => run('view.configureActionBar')}>Configure the action bar…</button></div>
      <Notice text={notice} />
    </div>
  )
}

function GitSyncPreferences({ view }: { view: SettingsView }): JSX.Element {
  const entries = syncVaultPreferences(view.state.settings[SYNC_VAULTS_KEY])
  const [problem,setProblem]=useState<string|null>(null)
  const [tools,setTools]=useState<boolean|null>(null)
  const askTools=(action:'status'|'install'|'check')=>void window.writeflexSettings.gitTools(action).then(r=>setTools(r.present),()=>setTools(null))
  useEffect(()=>askTools('status'),[])
  const change=(id:string,value:{enabled?:boolean;wait?:number})=>void window.writeflexSettings.gitSync(id,value).then(()=>setProblem(null),e=>setProblem(String(e.message??e)))
  return <div className="wf-page">{tools===false&&<div className="wf-page-row" role="status"><span className="grow">{stopSentences['tools-missing']}</span><button type="button" onClick={()=>askTools('install')}>Install Command Line Tools</button><button type="button" onClick={()=>askTools('check')}>Check again</button></div>}<p className="wf-page-note">{experimentalGitSyncOn(view.state.settings[EXPERIMENTAL_GIT_SYNC_KEY]) ? 'Git sync is per vault on this Mac. Turn it on in that vault’s Sync tab.' : 'Git sync is experimental. While “Vault sync with Git (experimental)” in Advanced is off, nothing is sent or received; switching it on or off takes effect the next time WriteFlex starts.'}</p>{Object.entries(entries).map(([id,entry]) => <div className="wf-page-row" key={id}><span className="grow">{entry.path ?? `Vault ${id.slice(0,8)}`}{tools===false&&entry.enabled?' (paused)':''}</span><label><input type="checkbox" aria-label={`Sync for ${id}`} checked={entry.enabled} onChange={e => change(id,{enabled:e.target.checked})} />Sync</label><select aria-label={`Send wait for ${id}`} value={entry.wait} onChange={e => change(id,{wait:Number(e.target.value)})}>{[1,3,10].map(n => <option key={n} value={n}>{n} {n===1?'minute':'minutes'}</option>)}</select></div>)}<Notice text={problem}/></div>
}

/** The custom pages, in sidebar order. Ids match settings-host.ts CUSTOM_PAGES. */
export function useCustomPages(view: SettingsView | null, openAccounts: () => void): CustomPage[] {
  return useMemo(() => (view ? [
    { id: 'git-sync', label: 'Git sync', icon: 'refresh-cw', render: () => <GitSyncPreferences view={view} /> },
    { id: 'sign-in', label: 'Sign in', icon: 'log-in', placement: 'all' as const, render: () => <SignIn /> },
    { id: 'model', label: 'Model', icon: 'bot', render: () => <ModelPage view={view} openAccounts={openAccounts} /> },
    { id: 'voice', label: 'Voice', icon: 'audio-lines', render: () => <VoicePage view={view} /> },
    { id: 'counted', label: 'Counted Collections', icon: 'book-open-check', render: () => <CountedPage /> },
    { id: 'command-line', label: 'Command-line tool', icon: 'terminal', render: () => <CommandLinePage /> },
    { id: 'get-started', label: 'Get started', icon: 'sparkles', render: () => <GetStartedPage /> },
  ] : []), [view, openAccounts])
}
