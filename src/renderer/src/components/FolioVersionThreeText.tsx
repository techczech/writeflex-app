import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeft, Check, FilePen, FileDown, Pencil, Send, TriangleAlert } from 'lucide-react'
import { choiceLabels, isSettled, isThreeText, textStateWords, whyLine, type TextChoice, type ThreeText, type ThreeTextRow } from '../../../shared/folio-version-text'
import { plural } from '../../../shared/folio-versions-view'

/**
 * The three texts of a part both of you changed (Folio versions ticket 17), after the locked mockup (docs/design/2026-11-02-folio-versions/mockup/locked/,
 * scene import-decide): what she started from (sent), what she wrote (theirs) and the text now (yours), side by side, one row per stretch of
 * paragraphs, with the decision under the row. Where one side changed a row alone, or both made the same change, the row says so and decides itself.
 * Otherwise: Use theirs, Keep mine, Edit by hand in Text. Unchanged stretches are folded into one line each, so a long part with many changes stays light.
 *
 * Surface type: workspace view (the Versions tab's main column, in place of the decide list). Not a modal, so no focus trap; every key typed here that is
 * not a chord with ⌘ or Control stops here, so none reaches the Folio room's own part commands (Shift+Enter opens the selected part, Delete removes one).
 * Escape goes back to the list. The row under focus is announced (a status region) with what it is and what can be done.
 *
 * Nothing is written by looking. A choice writes only on its own button, over the hashes of the texts shown (main refuses and says so if any moved),
 * and an agent has no way to press it.
 */

export type ResolveSuggestion = (change: { id: string; path: string }, action: 'accept' | 'reject') => Promise<{ applied: boolean; message?: string }>

export type FolioVersionThreeTextProps = {
  dir: string
  revisionId: string
  /** The part's current path. */
  part: string
  /** Back to the decide list. */
  onBack: () => void
  /** Opens the part in the editor with its margin ("Edit by hand in Text"). Absent: that button is drawn disabled. */
  openPart?: (path: string) => void
  /** Accepts or declines a suggestion through the margin's own route (the document owner's). Absent: "Use theirs" says it cannot be done here. */
  resolveSuggestion?: ResolveSuggestion
  /** Whether a part has typed text that is not saved: a choice over its three texts waits for the save, as a take does. */
  isUnsaved?: (path: string) => boolean
}

type Loaded = { state: 'loading' } | { state: 'unavailable'; why: string } | { state: 'ready'; text: ThreeText }
type Said = { tone: 'ok' | 'bad'; text: string } | null

export function FolioVersionThreeText({ dir, revisionId, part, onBack, openPart, resolveSuggestion, isUnsaved }: FolioVersionThreeTextProps): JSX.Element {
  const root = useRef<HTMLDivElement | null>(null)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [said, setSaid] = useState<Said>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => window.writeflex.onChangesChanged(() => setTick((value) => value + 1)), [])
  useEffect(() => window.writeflex.onVersionsChanged(() => setTick((value) => value + 1)), [])
  useEffect(() => {
    let live = true
    void window.writeflex.folioVersions.textRead(dir, revisionId, part).then(
      (read) => { if (live) setLoaded(read === null ? { state: 'unavailable', why: 'This revision is not in this Folio any more.' } : isThreeText(read) ? { state: 'ready', text: read } : { state: 'unavailable', why: read.unavailable }) },
      () => { if (live) setLoaded({ state: 'unavailable', why: 'The three texts could not be read.' }) },
    )
    return () => { live = false }
  }, [dir, revisionId, part, tick])
  useEffect(() => { requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-testid="three-heading"]')?.focus()) }, [])

  const decide = useCallback(async (text: ThreeText, row: ThreeTextRow, choice: TextChoice): Promise<void> => {
    setBusy(row.key); setSaid(null)
    try {
      // Text typed in the part and not saved is not what the three texts show: the choice waits for the save (nothing is asked of main).
      if (isUnsaved?.(part)) { setSaid({ tone: 'bad', text: `“${text.part.title}” has text you have typed that is not saved yet. Save it, then decide. Nothing was changed.` }); return }
      const answer = await window.writeflex.folioVersions.textDecide({ dir, revision: revisionId, part, row: row.key, choice, seen: text.seen })
      if (answer.status === 'done') { setSaid({ tone: 'ok', text: answer.message }); setLoaded({ state: 'ready', text: answer.text }) }
      else if (answer.status === 'refused') { setSaid({ tone: 'bad', text: answer.message }); if (answer.text) setLoaded({ state: 'ready', text: answer.text }) }
      else if (answer.status === 'hand') {
        setSaid({ tone: 'ok', text: answer.message }); setTick((value) => value + 1)
        openPart?.(answer.path)
      } else if (!resolveSuggestion) setSaid({ tone: 'bad', text: 'This window cannot accept or decline a suggestion here. Do it in the part’s margin. Nothing was changed.' })
      else {
        // The suggestion is staged (or was waiting): accepted or declined through the margin's own route, the one every proposal has.
        const result = await resolveSuggestion({ id: answer.changeId, path: answer.path }, answer.action)
        if (result.applied) setSaid({ tone: 'ok', text: answer.action === 'accept' ? `Their text is in “${text.part.title}”, attributed to ${text.revision.from}.` : 'Kept your text. Nothing in the part was changed.' })
        else setSaid({ tone: 'bad', text: `${result.message ?? 'That could not be applied.'} The suggestion is still waiting in the margin of “${text.part.title}”.` })
        setTick((value) => value + 1)
      }
    } catch {
      setSaid({ tone: 'bad', text: 'Something went wrong, and WriteFlex cannot say what was written. Check the part’s margin.' })
    } finally {
      setBusy(null)
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-testid="three-status"]')?.focus())
    }
  }, [dir, revisionId, part, openPart, resolveSuggestion, isUnsaved])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.metaKey || event.ctrlKey)) event.stopPropagation()
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && busy === null) { event.preventDefault(); onBack() }
  }

  if (loaded.state === 'loading') return <div className="fvi fvd fvt" data-testid="folio-three-text" aria-busy="true" ref={root} />
  if (loaded.state === 'unavailable') {
    return (
      <div className="fvi fvd fvt" data-testid="folio-three-text" data-state="unavailable" ref={root} onKeyDown={onKeyDown}>
        <section className="fvi-card">
          <h3 className="fvs-card-head" tabIndex={-1} data-testid="three-heading">The three texts are not available</h3>
          <div className="fvi-done"><TriangleAlert className="icon" aria-hidden="true" /><p data-testid="three-unavailable">{loaded.why}</p></div>
          <div className="fvi-foot"><button type="button" className="fv-btn" data-testid="three-back" onClick={onBack}>Back to all decisions</button></div>
        </section>
      </div>
    )
  }
  return <ThreeTextView text={loaded.text} busy={busy} said={said} rootRef={root} onKeyDown={onKeyDown} onBack={onBack} onDecide={(row, choice) => { if (busy === null) void decide(loaded.text, row, choice) }} canOpen={openPart !== undefined} />
}

export type ThreeTextViewProps = {
  text: ThreeText
  busy: string | null
  said: Said
  rootRef?: { current: HTMLDivElement | null }
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  onBack: () => void
  onDecide: (row: ThreeTextRow, choice: TextChoice) => void
  canOpen?: boolean
}

/** The paragraphs of a cell, one block each, so a long cell reads as the part does. */
function Cell({ paragraphs, empty, tone }: { paragraphs: string[]; empty: string; tone?: 'gone' | 'new' }): JSX.Element {
  if (paragraphs.length === 0) return <div className="fvt-cell fvt-none">{empty}</div>
  return <div className={`fvt-cell${tone ? ` ${tone}` : ''}`}>{paragraphs.map((paragraph, at) => <p key={at} className="fvt-para">{paragraph}</p>)}</div>
}

/** The step as drawn for a read already made (the render seam of the tests). */
export function ThreeTextView({ text, busy, said, rootRef, onKeyDown, onBack, onDecide, canOpen = true }: ThreeTextViewProps): JSX.Element {
  const who = text.revision.from
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set())
  const [announce, setAnnounce] = useState('')
  const changed = text.rows.filter((row) => row.kind !== 'same')
  const position = (row: ThreeTextRow): number => changed.indexOf(row) + 1
  const announceRow = (row: ThreeTextRow): void => {
    if (row.kind === 'same') return
    setAnnounce(`Row ${position(row)} of ${changed.length}: ${whyLine(row, who)} ${textStateWords[row.state]}.`)
  }
  const unfold = (at: number): void => setFolded((prev) => { const next = new Set(prev); if (next.has(at)) next.delete(at); else next.add(at); return next })

  return (
    <div className="fvi fvd fvt" data-testid="folio-three-text" data-state="ready" aria-busy={busy !== null || undefined} ref={rootRef} onKeyDown={onKeyDown}>
      <section className="fvi-card" data-testid="three-card">
        <div className="fvt-top">
          <button type="button" className="fv-btn plain" data-testid="three-back" disabled={busy !== null} onClick={onBack}><ArrowLeft aria-hidden="true" />All decisions</button>
          <h3 className="fvs-card-head fvt-title" tabIndex={-1} data-testid="three-heading">{text.part.position !== null ? <span className="fvd-num">{text.part.position}</span> : null}{text.part.title}</h3>
          <span className="fv-chip warn" data-testid="three-chip">both of you changed this part</span>
          <span className="fvd-count fvt-count" data-testid="three-progress">{text.counts.settled} of {text.counts.changed} decided</span>
        </div>
        <div className="fvd-status" role="status" tabIndex={-1} data-testid="three-status" data-tone={said?.tone}>{said?.text ?? ''}</div>
        <div className="fvt-sr" role="status" aria-live="polite" data-testid="three-announce">{announce}</div>

        {changed.length === 0 && <div className="fvi-done"><Check className="icon" aria-hidden="true" /><p data-testid="three-nothing">Nothing in this part differs between the three texts.</p></div>}

        <div className="fvt-grid" role="list" aria-label={`The three texts of “${text.part.title}”`}>
          <div className="fvt-heads" aria-hidden="true">
            <div className="fvt-colhd"><Send aria-hidden="true" />Sent</div>
            <div className="fvt-colhd"><FileDown aria-hidden="true" />{who}</div>
            <div className="fvt-colhd"><Pencil aria-hidden="true" />Yours now</div>
          </div>
          {text.rows.map((row, at) => {
            if (row.kind === 'same') {
              const open = folded.has(at)
              return (
                <div key={at} className="fvt-same" role="listitem" data-testid="three-same" data-count={row.yours.length}>
                  <button type="button" className="fv-btn plain fvt-fold" aria-expanded={open} onClick={() => unfold(at)}>{plural(row.yours.length, 'paragraph')} unchanged{open ? ' · hide' : ' · show'}</button>
                  {open && <div className="fvt-trio"><Cell paragraphs={row.sent} empty="" /><Cell paragraphs={row.hers} empty="" /><Cell paragraphs={row.yours} empty="" /></div>}
                </div>
              )
            }
            const decides = row.kind === 'only-hers' || row.kind === 'both-different'
            const labels = choiceLabels(row)
            const settled = isSettled(row.state)
            return (
              <div key={at} className="fvt-row" role="listitem" data-testid="three-row" data-kind={row.kind} data-state={row.state} data-key={row.key}
                aria-label={`Row ${position(row)} of ${changed.length}: ${whyLine(row, who)}`} onFocus={() => announceRow(row)}>
                <div className="fvt-trio">
                  <Cell paragraphs={row.sent} empty="Not in the sent text." />
                  <Cell paragraphs={row.hers} empty={row.herChange === 'delete' ? `${who} deleted this.` : row.kind === 'only-mine' ? 'Same as sent.' : 'Not in their text.'} tone={row.herChange === 'delete' ? 'gone' : row.herChange === 'insert' ? 'new' : undefined} />
                  <Cell paragraphs={row.yours} empty={row.yourChange === 'delete' ? 'You took this out.' : 'Not in your text.'} tone={row.yourChange === 'insert' ? 'new' : undefined} />
                </div>
                <div className="fvt-dec">
                  <span className="fvt-why" data-testid="three-why">{settled ? <Check aria-hidden="true" className="fvt-ic" /> : <TriangleAlert aria-hidden="true" className="fvt-ic" />}{whyLine(row, who)}{row.why ? <span className="fvi-why"> {row.why}</span> : null}</span>
                  {decides && !settled && (
                    <span className="fvd-choices">
                      <button type="button" className="fv-btn" data-testid="three-theirs" aria-disabled={busy !== null ? true : undefined} onClick={() => { if (busy === null) onDecide(row, 'theirs') }}>{labels.theirs}</button>
                      <button type="button" className="fv-btn plain" data-testid="three-mine" aria-disabled={busy !== null ? true : undefined} onClick={() => { if (busy === null) onDecide(row, 'mine') }}>{labels.mine}</button>
                      <button type="button" className="fv-btn plain" data-testid="three-hand" aria-disabled={busy !== null || !canOpen ? true : undefined} onClick={() => { if (busy === null && canOpen) onDecide(row, 'hand') }}><FilePen aria-hidden="true" />Edit by hand in Text</button>
                    </span>
                  )}
                  <span className={`fv-chip${settled ? ' acc' : ' warn'}`} data-chip={row.state}>{textStateWords[row.state]}</span>
                </div>
              </div>
            )
          })}
        </div>
        <div className="fvi-foot">
          <span className="fvi-need" data-testid="three-need">{text.counts.settled === text.counts.changed ? 'Every row of this part is settled.' : `${text.counts.changed - text.counts.settled} left to decide in this part.`}</span>
          <button type="button" className="fv-btn" data-testid="three-done" disabled={busy !== null} onClick={onBack}>Back to all decisions</button>
        </div>
      </section>
    </div>
  )
}
