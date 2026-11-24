// Update notices and updating in place (ADR-0054, porting TalkWeaver ADR-0044 §3). One mark in the status bar's notice
// slot, whose text follows the click's state: "0.29.0 is available" → "Downloading 0.29.0 · 42%" → "Restart to finish
// updating" / "Restarting into 0.29.0…" / "Update to 0.29.0 failed" / "Reopen WriteFlex to update". Its popover is the
// shared one (apu-update-pop, @app-patterns/updates-react's styling), drawn from update-notices-view.ts. The answer to
// Check for Updates… and the About card read the same view model. Hidden during distraction-free writing.
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowUpCircle, Download, RotateCw } from 'lucide-react'
import { SETTING_HINT, aboutLines, noteReducer, privacyText, storeAboutDetail, storeAboutLine, type WhatsNewItem } from '@app-patterns/updates'
import { UpdatesProvider, WhatsNewMark } from '@app-patterns/updates-react'
import '@app-patterns/updates-react/updates.css'
import { ALPHA_HINT, UPDATE_SENDS_TAIL } from '../../../shared/update-install'
import { answerOf, cardOf, installAnswer, markView, openAnswerView, popoverView, resultEvent, viewContext, type OpenAnswer, type PopoverAction, type UpdateSnapshot, type WfAnswerView } from './update-notices-view'
import { useNoticeSlot } from './notice-slot'
import './update-notices.css'

const NOTES_EVENT = 'writeflex-whats-new'
const ANSWER_EVENT = 'writeflex-update-answer'

export function useUpdates(): UpdateSnapshot | null {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null)
  useEffect(() => {
    let live = true
    const api = window.writeflex.updates
    const read = () => { void api.get().then(s => { if (live) setSnapshot(s) }).catch(() => {}) }
    read()
    const off = api.onChange(s => { if (live) setSnapshot(s) })
    window.addEventListener('focus', read)
    return () => { live = false; off(); window.removeEventListener('focus', read) }
  }, [])
  return snapshot
}
export function showWhatsNew() { window.dispatchEvent(new Event(NOTES_EVENT)) }

/** The shared package's actions (its What's new mark), bound to WriteFlex's IPC. */
function sharedActions() {
  return {
    ...window.writeflex.updates,
    loadNotes: async () => (await window.writeflex.updates.whatsNew())?.items ?? null,
    showNotes: showWhatsNew,
    setEnabled: (on: boolean) => window.writeflex.setSetting('updates.checkForNewVersions', on, 'Check for new versions'),
  }
}
function Provider({ snapshot, children }: { snapshot: UpdateSnapshot; children: ReactNode }) {
  const actions = useMemo(sharedActions, [])
  // The shared provider is typed for the release-only snapshot; WriteFlex's snapshot carries more.
  return <UpdatesProvider snapshot={snapshot as never} actions={actions}>{children}</UpdatesProvider>
}

/** Check for Updates… (menu, palette): while an update is under way, its state is the answer and nothing is asked;
 *  otherwise one check, whose answer offers Update where this copy can update itself. */
export function runCheckForUpdates() {
  const api = window.writeflex.updates
  void api.get().then(current => {
    if (installAnswer(current)) { window.dispatchEvent(new CustomEvent(ANSWER_EVENT, { detail: current })); return }
    return api.check().then(snapshot => {
      if (!snapshot.waiting) window.dispatchEvent(new CustomEvent(ANSWER_EVENT, { detail: snapshot }))
    })
  }).catch(() => window.dispatchEvent(new Event('writeflex-update-failed')))
}

/** What every update button does. Cancel and Restart send nothing; Update sends only the version the person saw, and
 *  main acts on its own validated offer, or on nothing when the offer is now another version (the windows are told). */
async function act(action: PopoverAction | WfAnswerView['action'], version?: string): Promise<UpdateSnapshot | null> {
  const api = window.writeflex.updates
  switch (action) {
    case 'update': case 'retry-update': return version ? api.update(version) : api.get()
    case 'cancel': return api.cancel()
    case 'restart': return api.restart()
    case 'not-now': return api.notNow()
    case 'skip': return version ? api.skip(version) : null
    case 'stop-skipping': return api.stopSkipping()
    case 'download': await api.download(); return null
    case 'open-store': await api.openStore(); return null
    case 'check': case 'try-again': return api.check()
    default: return null
  }
}

// ── The status-bar mark and its popover ─────────────────────────────────────────────────────────

const MarkIconOf = ({ icon }: { icon: 'available' | 'restart' | 'warn' }) =>
  icon === 'warn' ? <AlertTriangle size={11} aria-hidden /> : icon === 'restart' ? <RotateCw size={11} aria-hidden /> : <ArrowUpCircle size={11} aria-hidden />

/** Each button's hook for the hidden e2e specs (tests/e2e/update-notices.spec.ts reads these). */
const BUTTON_HOOK: Record<PopoverAction, string> = {
  update: 'data-update-update', download: 'data-update-download', 'not-now': 'data-update-not-now', skip: 'data-update-skip',
  cancel: 'data-update-cancel', restart: 'data-update-restart', later: 'data-update-later', 'retry-update': 'data-update-retry',
}

function PopoverBody({ snap, close }: { snap: UpdateSnapshot; close: () => void }) {
  const view = popoverView(snap)
  if (!view) return null
  // The version this popover names: the offer's, or (Try again) the failed attempt's.
  const shown = view.notesVersion ?? (snap.install.phase !== 'idle' ? snap.install.version : undefined)
  const press = (action: PopoverAction): void => {
    // Not now, Skip, Later and Download are done with the popover; the others change its state in place.
    if (action === 'later') { close(); return }
    void act(action, action === 'skip' ? view.notesVersion : shown)
    if (action === 'not-now' || action === 'skip' || action === 'download') close()
  }
  return <>
    <h3>{view.title}</h3>
    {view.progress !== undefined && <div className="wf-update-progress" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.progress} data-update-progress={view.progress}><span style={{ width: `${view.progress}%` }} /></div>}
    <div className="apu-update-sub" data-update-state={view.state} {...(snap.install.phase === 'waiting' ? { 'data-update-held': snap.blockers.join(' ') } : {})}>{view.sub}</div>
    {view.summary && view.summary.length > 0 && <ul>{view.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>}
    {view.refusal && <div className="apu-update-sub" data-update-refusal={snap.refusal ?? ''}>{view.refusal}</div>}
    {view.buttons.length > 0 && <div className="apu-update-actions">
      {view.buttons.map(button => (
        <button key={button.action} type="button"
          className={`apu-update-btn${button.primary ? ' apu-update-btn--primary' : ''}${button.quiet ? ' apu-update-btn--quiet' : ''}`}
          data-update-action={button.action}
          {...{ [BUTTON_HOOK[button.action]]: true }}
          disabled={button.disabledReason !== undefined}
          title={button.disabledReason}
          aria-describedby={button.disabledReason ? 'wf-update-held-reason' : undefined}
          onClick={() => press(button.action)}>
          {button.action === 'update' && <ArrowUpCircle size={13} aria-hidden />}
          {button.action === 'restart' && <RotateCw size={13} aria-hidden />}
          {button.action === 'download' && <Download size={13} aria-hidden />}
          {button.label}
        </button>
      ))}
    </div>}
    {view.buttons.some(b => b.disabledReason) && <span id="wf-update-held-reason" hidden>{view.buttons.find(b => b.disabledReason)?.disabledReason}</span>}
    {(view.foot || view.notesVersion) && <div className="apu-update-foot">
      {view.foot}{' '}
      {view.notesVersion && <button type="button" className="apu-update-link" data-update-notes onClick={() => void window.writeflex.updates.openNotes(view.notesVersion!)}>What&rsquo;s new in {view.notesVersion}</button>}
    </div>}
  </>
}

/** The mark (and the shared What's new mark) in the status bar's notice slot. */
export function UpdateMarks({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const snap = useUpdates()
  const mark = useRef<HTMLButtonElement | null>(null)
  const popover = useRef<HTMLDivElement | null>(null)
  const view = snap ? markView(snap) : null
  useEffect(() => { if (open && !view) onOpenChange(false) }, [open, view])
  // Keyboard: opening moves focus to the popover's first button that can be pressed, and so does a change of state
  // that took away the button that had it (Update becomes Cancel; Cancel becomes Update).
  const phase = snap?.install.phase
  useEffect(() => {
    if (!open) return
    if (popover.current?.contains(document.activeElement)) return
    popover.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
  }, [open, phase])
  if (!snap) return null
  return <Provider snapshot={snap}><span className="wf-update-marks">
    {view && <>
      <span style={{ margin: '0 8px', color: 'var(--app-updates-line, #d9d0c1)' }}>|</span>
      <span className="apu-update-anchor">
        <button type="button" ref={mark} className={`apu-update-mark${view.failed ? ' wf-update-mark--failed' : ''}`} data-update-mark data-update-phase={view.phase}
          aria-expanded={open} aria-haspopup="dialog" title={view.phase === 'idle' ? 'A new version of WriteFlex is out' : 'Updating WriteFlex'} onClick={() => onOpenChange(!open)}>
          <MarkIconOf icon={view.icon} />{' '}{view.text}
        </button>
        {open && (
          <div className="apu-update-pop" ref={popover} role="dialog" aria-label="Updating WriteFlex" data-update-popover>
            <PopoverBody snap={snap} close={() => { onOpenChange(false); mark.current?.focus() }} />
          </div>
        )}
      </span>
    </>}
    <WhatsNewMark />
  </span></Provider>
}

// ── The buttons under an answer (the note and the About card) ───────────────────────────────────

export function AnswerButtons({ snap, view, onDone, onView, size }: { snap: UpdateSnapshot; view: WfAnswerView; onDone?: () => void; onView?: (next: UpdateSnapshot) => void; size?: 'card' }) {
  if (view.action === null && !view.downloadLink) return null
  const cls = (primary: boolean): string => `apu-update-btn${primary ? ' apu-update-btn--primary' : ''}`
  const after = (next: UpdateSnapshot | null): void => { if (next) onView?.(next) }
  const run = (action: WfAnswerView['action']) => () => { void act(action, view.version).then(after) }
  const host = new URL(snap.identity.feedUrl).host
  const downloadButton = <button type="button" className={cls(view.action === 'download')} data-update-download onClick={() => { void act('download'); onDone?.() }}><Download size={13} aria-hidden /> {size === 'card' ? 'Download…' : `Download from ${host}`}</button>
  return (
    <div className="apu-update-actions">
      {view.action === 'update' && <button type="button" className={cls(true)} data-update-update onClick={run('update')}><ArrowUpCircle size={13} aria-hidden /> Update</button>}
      {view.action === 'download' && downloadButton}
      {view.action === 'cancel' && <button type="button" className={cls(false)} data-update-cancel onClick={run('cancel')}>Cancel</button>}
      {view.action === 'restart' && <button type="button" className={cls(true)} data-update-restart disabled={view.held !== undefined} title={view.held} onClick={run('restart')}><RotateCw size={13} aria-hidden /> Restart</button>}
      {view.action === 'retry-update' && <button type="button" className={cls(true)} data-update-retry onClick={run('retry-update')}>Try again</button>}
      {view.downloadLink && view.action !== 'download' && downloadButton}
      {view.action === 'stop-skipping' && <button type="button" className={cls(false)} data-update-stop-skipping onClick={run('stop-skipping')}>Stop skipping</button>}
      {view.action === 'try-again' && <button type="button" className={cls(false)} data-update-try-again onClick={run('try-again')}>Try again</button>}
      {view.action === 'open-store' && <button type="button" className={cls(false)} data-update-open-store onClick={() => { void act('open-store'); onDone?.() }}>Open in {snap.identity.storeName ?? 'app store'}</button>}
      {view.action === 'check' && <button type="button" className={cls(false)} data-update-check onClick={run('check')}>Check for updates</button>}
      {view.whatsNew && view.version && <button type="button" className="apu-update-link" data-update-notes onClick={() => void window.writeflex.updates.openNotes(view.version!)}>What&rsquo;s new in {view.version}</button>}
    </div>
  )
}

// ── Settings › About and updates ─────────────────────────────────────────────────────────────────

const card = { border: '1px solid var(--app-updates-line, #d9d0c1)', borderRadius: 8, overflow: 'hidden', margin: '8px 0 10px', background: 'var(--app-updates-panel, #fffdf8)' } as const
const cardHead = { padding: '7px 12px', fontSize: 12.5, fontWeight: 700, background: 'var(--app-updates-hover, #ede8dc)', borderBottom: '1px solid var(--app-updates-line, #d9d0c1)' } as const
const cardRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '9px 12px', borderTop: '1px solid var(--app-updates-line, #d9d0c1)' } as const
const sub = { fontSize: 11.5, color: 'var(--app-updates-muted, #5d6875)', marginTop: 2, lineHeight: 1.4 } as const

/** The New versions card: Check for new versions, Get early versions (alpha), the state of the last check or of an
 *  update under way, Check for updates, and what the check sends. A Store copy has no New versions card. */
export function AboutUpdates({ setEnabled, setAlpha }: { setEnabled: (on: boolean) => void; setAlpha: (on: boolean) => void }) {
  const snap = useUpdates()
  const [asked, setAsked] = useState(false)
  const [hasNotes, setHasNotes] = useState(false)
  useEffect(() => {
    let live = true
    void window.writeflex.updates.whatsNew().then(n => { if (live) setHasNotes(n !== null) }).catch(() => {})
    return () => { live = false }
  }, [])
  if (!snap) return null
  const about = aboutLines(viewContext(snap))
  // The card always follows the latest snapshot: a check's answer arrives as one, so no older local answer can outlast a newer one.
  const view = snap.waiting || (asked && snap.busy)
    ? answerOf({ ...snap, waiting: true })
    : asked && !snap.checking ? answerOf(snap) : cardOf(snap)
  return <Provider snapshot={snap}><div className="apu-updates">
    <div style={card} data-about-card>
      <div style={cardHead}>{snap.identity.appName}</div>
      <div style={{ ...cardRow, borderTop: 'none' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }} data-about-version>{about.version}</div>
          <div style={sub} data-about-where>{about.where}</div>
        </div>
        {hasNotes && <button type="button" className="apu-update-btn" data-about-whats-new onClick={showWhatsNew}>What&rsquo;s new in {snap.running}</button>}
      </div>
      {snap.source === 'store' && (
        <div style={cardRow} data-about-store>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{storeAboutLine(snap.identity)}</div>
            <div style={sub}>{storeAboutDetail}</div>
          </div>
          <button type="button" className="apu-update-btn" data-update-open-store onClick={() => void window.writeflex.updates.openStore()}>Open in {snap.identity.storeName ?? 'app store'}</button>
        </div>
      )}
    </div>
    {snap.source !== 'store' && (
      <div style={card} data-updates-card>
        <div style={cardHead}>New versions</div>
        <div style={{ ...cardRow, borderTop: 'none' }} data-setting="check-for-new-versions">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>Check for new versions</div>
            <div style={sub}>{SETTING_HINT}</div>
          </div>
          <button type="button" role="switch" aria-checked={snap.enabled} aria-label="Check for new versions" className="apu-update-switch" onClick={() => { setAsked(false); setEnabled(!snap.enabled) }} />
        </div>
        <div style={cardRow} data-setting="alpha-versions">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>Get early versions (alpha)</div>
            <div style={sub} data-update-alpha-hint>{ALPHA_HINT}</div>
          </div>
          <button type="button" role="switch" aria-checked={snap.alpha} aria-label="Get early versions (alpha)" className="apu-update-switch" data-update-alpha onClick={() => { setAsked(false); setAlpha(!snap.alpha) }} />
        </div>
        {view && (
          <div style={cardRow} data-update-state={view.tone}>
            <div style={{ minWidth: 0 }}>
              <div className={`apu-update-state--${view.tone}`} style={{ fontSize: 12.5, fontWeight: 600 }}>{view.title}</div>
              {view.detail && <div style={sub}>{view.detail}</div>}
            </div>
            {snap.checking
              ? <button type="button" className="apu-update-btn" disabled>Check for updates</button>
              : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <AnswerButtons snap={snap} view={view} size="card" onView={() => setAsked(true)} />
                  {view.action !== 'check' && view.action !== 'try-again' && snap.install.phase === 'idle' && (
                    <button type="button" className="apu-update-btn" data-update-check onClick={() => { void window.writeflex.updates.check().then(() => setAsked(true)) }}>Check for updates</button>
                  )}
                </div>
              )}
          </div>
        )}
        <div style={cardRow}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>What the check sends</div>
            <div style={sub} data-update-sends>{privacyText(snap.identity)} {UPDATE_SENDS_TAIL}</div>
          </div>
        </div>
      </div>
    )}
  </div></Provider>
}

// ── The answer to Check for Updates…, and What's new ────────────────────────────────────────────

export function UpdateNotices({ protectedMode }: { protectedMode: boolean }) {
  const live = useUpdates()
  const actions = window.writeflex.updates
  // The newest snapshot by arrival, whichever way it came (a change, a check's answer, a button's result): an open
  // answer is drawn from it, never from the snapshot it was opened with.
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null)
  useEffect(() => { if (live) setSnapshot(live) }, [live])
  // Whether an answer is open (and which kind) is kept apart from what it says (openAnswerView).
  const [note, dispatch] = useReducer(noteReducer<OpenAnswer>, { shown: null, held: null })
  const [opened, setOpened] = useState(0)
  const [notes, setNotes] = useState<{ version: string; items: WhatsNewItem[] } | null>(null)
  const slot = useNoticeSlot()
  useEffect(() => {
    void actions.setProtected(protectedMode)
    return () => { void actions.setProtected(false) }
  }, [protectedMode])
  // Only an answer the person just asked for (Check for Updates…) takes the focus; one that waited for distraction-free
  // writing to end does not pull the writer out of the text.
  const focusAnswer = useRef(false)
  useEffect(() => {
    const take = (snap: UpdateSnapshot) => { setSnapshot(snap); setOpened(n => n + 1); dispatch({ kind: 'answer', view: 'check', busy: snap.busy }) }
    const onAnswer = (event: Event) => { focusAnswer.current = true; take((event as CustomEvent<UpdateSnapshot>).detail) }
    const onNotes = () => { void actions.whatsNew().then(setNotes).catch(() => {}) }
    const failed = () => { setOpened(n => n + 1); dispatch({ kind: 'answer', view: 'could-not-ask', busy: false }) }
    window.addEventListener('writeflex-update-failed', failed)
    const off = actions.onAnswer(take)
    window.addEventListener(ANSWER_EVENT, onAnswer)
    window.addEventListener(NOTES_EVENT, onNotes)
    return () => { window.removeEventListener('writeflex-update-failed', failed); off(); window.removeEventListener(ANSWER_EVENT, onAnswer); window.removeEventListener(NOTES_EVENT, onNotes) }
  }, [])
  const busy = protectedMode || snapshot?.busy === true
  useEffect(() => { dispatch({ kind: 'busy', busy }) }, [busy])
  const shown = busy ? null : note.shown
  const view = useMemo(() => openAnswerView(shown, snapshot), [shown, snapshot])
  // An answer with nothing to press goes after six seconds; one that later offers a button (a download began) stays.
  const quiet = view !== null && view.action === null
  useEffect(() => {
    if (!quiet) return
    const timer = setTimeout(() => dispatch({ kind: 'dismiss' }), 6000)
    return () => clearTimeout(timer)
  }, [quiet, opened])
  useEffect(() => {
    if (!notes) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setNotes(null) }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [notes])
  // The answer is a small dialog anchored to the status bar's notice slot, right edges aligned, so it stays inside the editor
  // column: it never lands on the right sidebar or the composer, and it is not a row in the status bar (R2).
  const [place, setPlace] = useState<{ right: number; bottom: number; maxWidth: number } | null>(null)
  useLayoutEffect(() => {
    if (!view || !slot) { setPlace(null); return }
    const box = slot.getBoundingClientRect()
    setPlace({ right: Math.max(8, window.innerWidth - box.right), bottom: window.innerHeight - box.top + 6, maxWidth: Math.max(240, box.right - 8) })
  }, [view, slot])
  // Keyboard: an answer that offers a button takes the focus, so Check for Updates… from the palette can be answered
  // with Return (Update, Restart, Try again) and closed with Escape.
  const noteRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!view || view.action === null || !place || !focusAnswer.current) return
    focusAnswer.current = false
    noteRef.current?.querySelector<HTMLButtonElement>('.apu-update-actions button:not([disabled])')?.focus()
  }, [view, place])
  useEffect(() => {
    if (!view) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dispatch({ kind: 'dismiss' }) }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [view])
  const answer = snapshot && view && <Provider snapshot={snapshot}><div ref={noteRef} className="wf-update-note anchored" role="dialog" aria-label="Update" data-update-note data-update-note-tone={view.tone} style={place ? { right: place.right, bottom: place.bottom, left: 'auto', maxWidth: place.maxWidth } : undefined}>
      <button type="button" className="wf-update-close" aria-label="Dismiss update answer" onClick={() => dispatch({ kind: 'dismiss' })}>×</button>
      <strong>{view.title}</strong><p>{view.detail}</p>
      <AnswerButtons snap={snapshot} view={view} onDone={() => dispatch({ kind: 'dismiss' })} onView={next => { setSnapshot(next); dispatch(resultEvent(next)) }} />
    </div></Provider>
  return <>
    {answer}
    {notes && !busy && <div className="wf-update-note wf-whats-new" role="dialog" aria-label="What’s new in WriteFlex" tabIndex={-1} ref={node => node?.focus()}>
      <button type="button" className="wf-update-close" aria-label="Close What’s new" onClick={() => setNotes(null)}>×</button>
      <h3>What’s new in WriteFlex {notes.version}</h3>
      <ul>{notes.items.map((item, i) => <li key={i}>{item.title && <strong>{item.title} </strong>}{item.text}</li>)}</ul>
    </div>}
  </>
}
