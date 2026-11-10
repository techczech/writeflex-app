import { useEffect, useLayoutEffect, useReducer, useState, useMemo, type ReactNode } from 'react'
import { answerView, noteReducer, type AnswerView, type UpdateSnapshot, type WhatsNewItem } from '@app-patterns/updates'
import { UpdatesProvider, UpdateMarks as SharedMarks, AboutUpdatesCard, AnswerButtons } from '@app-patterns/updates-react'
import '@app-patterns/updates-react/updates.css'
import { useNoticeSlot } from './notice-slot'
import './update-notices.css'

const NOTES_EVENT = 'writeflex-whats-new'
const ANSWER_EVENT = 'writeflex-update-answer'
const context = (s: UpdateSnapshot) => ({ ...s, now: Date.now() })
export function useUpdates() {
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
function updateActions(setEnabled?: (on: boolean) => void) { return {
  ...window.writeflex.updates,
  loadNotes: async () => (await window.writeflex.updates.whatsNew())?.items ?? null,
  showNotes: showWhatsNew,
  setEnabled: async (on: boolean) => {
    if (setEnabled) setEnabled(on)
    else await window.writeflex.setSetting('updates.checkForNewVersions', on, 'Check for new versions')
  },
} }
export function runCheckForUpdates() {
  void window.writeflex.updates.check().then(snapshot => {
    if (!snapshot.waiting) window.dispatchEvent(new CustomEvent(ANSWER_EVENT, { detail: snapshot }))
  }).catch(() => window.dispatchEvent(new Event('writeflex-update-failed')))
}
function Provider({ snapshot, children, setEnabled }: { snapshot: UpdateSnapshot; children: ReactNode; setEnabled?: (on: boolean) => void }) {
  const actions = useMemo(() => updateActions(setEnabled), [setEnabled])
  return <UpdatesProvider snapshot={snapshot} actions={actions}>{children}</UpdatesProvider>
}
export function UpdateMarks() {
  const snapshot = useUpdates()
  return snapshot && <Provider snapshot={snapshot}><span className="wf-update-marks"><SharedMarks /></span></Provider>
}
export function AboutUpdates({ setEnabled }: { setEnabled: (on: boolean) => void }) {
  const snapshot = useUpdates()
  return snapshot && <Provider snapshot={snapshot} setEnabled={setEnabled}><AboutUpdatesCard /></Provider>
}
export function UpdateNotices({ protectedMode }: { protectedMode: boolean }) {
  const snapshot = useUpdates()
  const actions = window.writeflex.updates
  const [note, dispatch] = useReducer(noteReducer<AnswerView>, { shown: null, held: null })
  const [notes, setNotes] = useState<{ version: string; items: WhatsNewItem[] } | null>(null)
  const slot = useNoticeSlot()
  useEffect(() => {
    void actions.setProtected(protectedMode)
    return () => { void actions.setProtected(false) }
  }, [protectedMode])
  useEffect(() => {
    const take = (snap: UpdateSnapshot) => dispatch({ kind: 'answer', view: answerView(snap.state, context(snap)), busy: snap.busy })
    const onAnswer = (event: Event) => take((event as CustomEvent<UpdateSnapshot>).detail)
    const onNotes = () => { void actions.whatsNew().then(setNotes).catch(() => {}) }
    const failed = () => dispatch({ kind: 'answer', view: { tone: 'warn', title: 'Could not check for updates.', detail: 'WriteFlex could not ask for the answer. Try again.', action: 'try-again' }, busy: false })
    window.addEventListener('writeflex-update-failed', failed)
    const off = actions.onAnswer(take)
    window.addEventListener(ANSWER_EVENT, onAnswer)
    window.addEventListener(NOTES_EVENT, onNotes)
    const offMenu = window.writeflex.onMenuAction(action => {
      if (action === 'check-for-updates') runCheckForUpdates()
      if (action === 'whats-new') showWhatsNew()
    })
    return () => { window.removeEventListener('writeflex-update-failed', failed); off(); offMenu(); window.removeEventListener(ANSWER_EVENT, onAnswer); window.removeEventListener(NOTES_EVENT, onNotes) }
  }, [])
  const busy = protectedMode || snapshot?.busy === true
  useEffect(() => { dispatch({ kind: 'busy', busy }) }, [busy])
  const view = busy ? null : note.shown
  useEffect(() => {
    if (!view || view.action !== null) return
    const timer = setTimeout(() => dispatch({ kind: 'dismiss' }), 6000)
    return () => clearTimeout(timer)
  }, [view])
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
  const answer = snapshot && view && <Provider snapshot={snapshot}><div className="wf-update-note anchored" role="dialog" aria-label="Update" data-update-note data-update-note-tone={view.tone} style={place ? { right: place.right, bottom: place.bottom, left: 'auto', maxWidth: place.maxWidth } : undefined}>
      <button type="button" className="wf-update-close" aria-label="Dismiss update answer" onClick={() => dispatch({ kind: 'dismiss' })}>×</button>
      <strong>{view.title}</strong><p>{view.detail}</p>
      <AnswerButtons view={view} onDone={() => dispatch({ kind: 'dismiss' })} onView={next => dispatch({ kind: 'answer', view: next, busy })} />
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
