// The Scratchpad's optional source tabs (ADR-0050 ticket 05, design states 13–14): TalkWeaver
// vaults and SlideWell, each present only while its own Settings switch is on. Browsing never
// copies anything: Collect to Scratchpad keeps a pointer and a small preview in main, and the
// file enters the document's assets/ only when the collected candidate is inserted. Results
// are named here only by main's opaque handles; an enabled-but-unavailable source keeps its
// tab and explains itself, with Open Settings and Check again.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Search } from 'lucide-react'
import { SCRATCH_KIND_LABELS, type ScratchExternalResult, type ScratchExternalStatus } from '../../../../shared/scratchpad-items'
import type { ScratchExternalSourceId } from '../../../../shared/scratchpad-source-settings'

export function ScratchpadExternalBrowser({
  source, root, activePath, say, onOpenSettings,
}: {
  source: ScratchExternalSourceId
  root: string | null
  activePath: string | null
  say: (message: string) => void
  onOpenSettings?: () => void
}): JSX.Element {
  const bridge = window.writeflex.scratchpad
  const [status, setStatus] = useState<ScratchExternalStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [vault, setVault] = useState('all')
  const [mode, setMode] = useState<'words' | 'meaning'>('words')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ScratchExternalResult[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ask = useRef(0)

  const loadStatus = useCallback(async (): Promise<ScratchExternalStatus | null> => {
    if (!root) return null
    const asked = ++ask.current
    const reply = await bridge.externalStatus({ root, source }).catch(() => ({ ok: false as const, error: 'The Scratchpad did not answer.' }))
    if (asked !== ask.current) return null
    if (!reply.ok) { setStatusError(reply.error); return null }
    setStatusError(null)
    setStatus(reply.status)
    return reply.status
  }, [bridge, root, source])

  const search = useCallback(async (overrides: { query?: string; vault?: string; mode?: 'words' | 'meaning' } = {}) => {
    if (!root) return
    const asked = ++ask.current
    setBusy(true)
    setSearchError(null)
    const reply = await bridge.externalSearch({
      root, source,
      query: overrides.query ?? query,
      ...(source === 'talkweaver' ? { vault: overrides.vault ?? vault } : { mode: overrides.mode ?? mode }),
    }).catch(() => ({ ok: false as const, error: 'The Scratchpad did not answer.' }))
    if (asked !== ask.current) return
    setBusy(false)
    if (!reply.ok) { setSearchError(reply.error); setResults(null); return }
    setStatus(reply.status)
    setResults(reply.results)
    setNote(reply.note ?? null)
  }, [bridge, root, source, query, vault, mode])

  useEffect(() => {
    setStatus(null); setResults(null); setNote(null); setSearchError(null); setQuery(''); setVault('all'); setMode('words')
    void (async () => {
      const current = await loadStatus()
      if (current?.state === 'connected') void search({ query: '', vault: 'all', mode: 'words' })
    })()
  }, [source, root]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (event: FormEvent): void => { event.preventDefault(); void search() }
  const checkAgain = (): void => {
    void (async () => {
      const current = await loadStatus()
      if (current?.state === 'connected') void search()
    })()
  }

  const collect = async (result: ScratchExternalResult): Promise<void> => {
    if (!root || !activePath) { say('Open a document first, so the Scratchpad knows which collection this belongs to.'); return }
    const reply = await bridge.externalCollect({ root, handle: result.handle, activePath }).catch(() => ({ ok: false as const, error: 'The Scratchpad did not answer.' }))
    if (!reply.ok) { say(`Nothing was collected: ${reply.error}`); return }
    setResults((current) => current?.map((entry) => (entry.handle === result.handle ? { ...entry, collectedId: reply.item.id } : entry)) ?? current)
    say(`Collected ${result.title} to the Scratchpad. Nothing was copied yet.`)
  }

  const unavailableActions = (
    <div className="sp-actions">
      {onOpenSettings ? <button type="button" onClick={onOpenSettings}>Open Settings</button> : null}
      <button type="button" onClick={checkAgain}>Check again</button>
    </div>
  )

  if (!root) return <div className="sp-external"><p className="sp-note">Open a folder to browse this source.</p></div>
  if (statusError) {
    return (
      <div className="sp-external">
        <div className="sp-empty"><h3>{source === 'talkweaver' ? 'TalkWeaver could not be checked' : 'SlideWell could not be checked'}</h3><p>{statusError}</p></div>
        {unavailableActions}
      </div>
    )
  }
  if (status === null) return <div className="sp-external"><p className="sp-note">Checking…</p></div>
  if (status.state === 'off') {
    return (
      <div className="sp-external">
        <div className="sp-empty"><h3>{source === 'talkweaver' ? 'TalkWeaver vaults are off' : 'SlideWell is off'}</h3><p>Turn this connection on in Settings › Scratchpad to browse it here.</p></div>
        {unavailableActions}
      </div>
    )
  }
  if (status.state === 'unavailable' && !(source === 'slidewell' && status.catalogue)) {
    return (
      <div className="sp-external">
        <div className="sp-empty">
          <h3>{source === 'talkweaver' ? 'TalkWeaver was not found on this Mac' : 'SlideWell is not running'}</h3>
          <p>{status.reason ?? (source === 'talkweaver' ? 'Install TalkWeaver, or turn this connection off in Settings. Your own Scratchpad is not affected.' : 'Start SlideWell for semantic picture search, or turn this connection off in Settings. Your own Scratchpad is not affected.')}</p>
        </div>
        {unavailableActions}
      </div>
    )
  }

  const chosenVaults = status.vaults?.filter((entry) => status.chosenVaults?.includes(entry.id)) ?? []
  const noVaultChosen = source === 'talkweaver' && chosenVaults.length === 0

  return (
    <div className="sp-external">
      {source === 'talkweaver' ? (
        <div className="sp-ext-row">
          <label className="sp-ext-vault">
            <span>Show vault</span>
            <select aria-label="Show vault" value={vault} onChange={(event) => { setVault(event.target.value); void search({ vault: event.target.value }) }}>
              <option value="all">All chosen vaults</option>
              {chosenVaults.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </select>
          </label>
        </div>
      ) : (
        <>
          <p className="sp-note">Describe the picture you want in your own words. Results come from your SlideWell index and nothing is sent anywhere else.</p>
          {status.catalogue && !status.semantic ? (
            <div className="sp-ext-note">
              <p><b>SlideWell is not running.</b> Start SlideWell for semantic picture search, or browse the readable catalogue by file name below.</p>
            </div>
          ) : null}
          <div className="sp-doc-scope" role="group" aria-label="Search by">
            <button type="button" aria-pressed={mode === 'words'} className={mode === 'words' ? 'on' : ''} onClick={() => { setMode('words'); void search({ mode: 'words' }) }}>Words in the catalogue</button>
            <button type="button" aria-pressed={mode === 'meaning'} className={mode === 'meaning' ? 'on' : ''} disabled={!status.semantic} onClick={() => { setMode('meaning'); void search({ mode: 'meaning' }) }}>What it shows</button>
          </div>
        </>
      )}
      <form className="sp-search-row" onSubmit={submit}>
        <label className="sp-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={source === 'talkweaver' ? 'Search titles, talks and file names' : 'Describe the picture you want'}
            aria-label={source === 'talkweaver' ? 'Search TalkWeaver vaults' : 'Search SlideWell'}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? <button type="button" className="sp-clear" onClick={() => { setQuery(''); void search({ query: '' }) }}>Clear</button> : null}
        </label>
        <button type="submit" disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
        {source === 'slidewell' && mode === 'words' ? <button type="button" disabled={busy} onClick={() => { setQuery(''); void search({ query: '', mode: 'words' }) }}>Browse indexed files</button> : null}
      </form>
      <p className="sp-note">Collecting keeps a pointer and a small preview. The file is copied into this document’s <b>assets/</b> folder only when you insert it, and the source stays on the item.</p>
      <div className="sp-list" aria-live="polite">
        {noVaultChosen ? (
          <div className="sp-empty"><h3>No vault is selected</h3><p>Choose vaults in Settings › Scratchpad, then come back here.</p>{unavailableActions}</div>
        ) : searchError ? (
          <><p className="sp-notice">{searchError}</p>{unavailableActions}</>
        ) : results === null ? (
          <p className="sp-note">{busy ? 'Searching…' : 'Nothing searched yet.'}</p>
        ) : results.length === 0 ? (
          <p className="sp-empty-line">Nothing matches.</p>
        ) : (
          <>
            <p className="sp-summary"><b>{results.length} {results.length === 1 ? 'item' : 'items'}</b>{query.trim() ? ` match “${query.trim()}”` : ', newest first'}</p>
            <div className="sp-grid">
              {results.map((result) => (
                <article key={result.handle} className="sp-card sp-ext-card" aria-label={`${result.title}. ${SCRATCH_KIND_LABELS[result.kind]}. ${result.provenance}`}>
                  {result.kind === 'widget'
                    ? <div className="sp-mini sp-widget-tile" aria-hidden="true">Widget<span>Runs sealed, on request</span></div>
                    : result.previewDataUri
                      ? <div className="sp-mini sp-ext-mini"><img src={result.previewDataUri} alt="" /></div>
                      : <div className="sp-mini sp-widget-tile" aria-hidden="true">Picture<span>{result.title}</span></div>}
                  <div className="sp-card-body">
                    <div className="sp-badges">
                      <span className="sp-badge kind">{SCRATCH_KIND_LABELS[result.kind]}</span>
                      <span className="sp-badge origin" title={result.provenance}>{result.provenance}</span>
                      {result.score !== undefined ? <span className="sp-badge">match {result.score.toFixed(2)}</span> : null}
                      {result.incompatible ? <span className="sp-badge missing">Needs checking</span> : null}
                    </div>
                    <h3 className="sp-title">{result.title}</h3>
                    <div className="sp-meta">{result.detail || SCRATCH_KIND_LABELS[result.kind]}</div>
                    {result.incompatible ? <p className="sp-problem">{result.incompatible}</p> : null}
                    <div className="sp-actions">
                      {result.collectedId
                        ? <span className="sp-badge used">In the Scratchpad</span>
                        : <button type="button" className="primary" onClick={() => void collect(result)}>Collect to Scratchpad</button>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
        {note ? <p className="sp-note">{note}</p> : null}
      </div>
    </div>
  )
}
