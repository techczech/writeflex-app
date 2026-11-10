import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CircleCheck, FileDown, History, Minus, Plus, Replace, TriangleAlert } from 'lucide-react'
import {
  STRUCTURE_CHOICES, decidedWords, progressLine, rowWords,
  type DecideList, type DecidePart, type DecideSuggestion, type MatchRowOfList, type StructureRow,
} from '../../../shared/folio-version-decide'
import type { FolioDecisionChoice } from '../../../shared/folio-version-records'
import { plural } from '../../../shared/folio-versions-view'
import { FolioVersionThreeText, type ResolveSuggestion } from './FolioVersionThreeText'

/**
 * Step 3 of Import: decide (Folio versions ticket 16), after the locked mockup
 * (docs/design/2026-11-02-folio-versions/mockup/locked/, scenes import-decide and decide-refused). A workspace view in the Versions tab's
 * main column while the timeline folds to a thin rail. One row per part holds the suggestions staged in its margin; a suggestion is
 * accepted or declined where every proposal is (the part's margin, reached with "Open in Text"). The structure decisions the writer always
 * makes themself sit below: add a new section as a part, use the Word file's order or keep theirs, take a part out of the running order.
 * Progress ("5 of 22 decided") counts both, and when the last row is settled the view offers to save the Folio as "After <name>’s revision".
 *
 * Nothing is written by looking. A structure decision writes only on its own button, against the running order the list showed (main
 * refuses and says so if it moved), and an agent has no way to press it.
 *
 * Keys. This is a workspace view, not a modal, so there is no focus trap to build; every key typed here that is not a chord with ⌘ or Control
 * stops here, so none reaches the Folio room's own part commands (Shift+Enter opens the selected part, Delete removes one). Escape leaves
 * with nothing written, except while a decision is being made.
 */

export type FolioVersionDecideProps = {
  dir: string
  revisionId: string
  /** Leave the step; the tab shows the version as it was. */
  onClose: () => void
  /** Opens a part in the editor with its margin (the way "Return to text" does). Absent: "Open in Text" is not drawn. */
  openPart?: (path: string) => void
  /** Opens the save sheet with the name proposed. Absent: the offer is drawn without its button. */
  onSaveVersion?: (suggestedName?: string) => void
  /** Ticket 17: accepts or declines a suggestion through the margin's own route, for the three texts. Absent: they say it cannot be done here. */
  resolveSuggestion?: ResolveSuggestion
  /** Ticket 17: whether a part has typed text that is not saved; a choice over its three texts waits for the save. */
  isUnsaved?: (path: string) => boolean
}

type Loaded = { state: 'loading' } | { state: 'gone' } | { state: 'ready'; list: DecideList }

const OUTCOME_WORDS: Record<DecideSuggestion['outcome'], string> = { waiting: 'waiting', accepted: 'accepted', declined: 'declined', closed: 'closed' }

/** The drop-down value for "none of the parts: a new section" (a part is named by its path, which cannot be this). */
const NONE = '\u0000none'

const clip = (text: string, length = 140): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

function suggestionLine(suggestion: DecideSuggestion): string {
  if (suggestion.kind === 'insert') return `Adds “${clip(suggestion.newText)}”`
  if (suggestion.kind === 'delete') return `Removes “${clip(suggestion.oldText)}”`
  return `Changes “${clip(suggestion.oldText, 80)}” to “${clip(suggestion.newText, 80)}”`
}

function SuggestionIcon({ kind }: { kind: DecideSuggestion['kind'] }): JSX.Element {
  const Icon = kind === 'insert' ? Plus : kind === 'delete' ? Minus : Replace
  return <Icon aria-hidden="true" className="fvd-kind" />
}

export function FolioVersionDecide({ dir, revisionId, onClose, openPart, onSaveVersion, resolveSuggestion, isUnsaved }: FolioVersionDecideProps): JSX.Element {
  const root = useRef<HTMLDivElement | null>(null)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [busy, setBusy] = useState<string | null>(null)
  const [said, setSaid] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [tick, setTick] = useState(0)
  // Ticket 17: the part whose three texts are open, in place of the list.
  const [threeOf, setThreeOf] = useState<string | null>(null)

  // The list again whenever the ledger changes (an Accept or Decline in a margin) or the history does.
  useEffect(() => window.writeflex.onChangesChanged(() => setTick((value) => value + 1)), [])
  useEffect(() => window.writeflex.onVersionsChanged(() => setTick((value) => value + 1)), [])
  useEffect(() => {
    let live = true
    void window.writeflex.folioVersions.decideList(dir, revisionId).then(
      (list) => { if (live) setLoaded(list ? { state: 'ready', list } : { state: 'gone' }) },
      () => { if (live) setLoaded({ state: 'gone' }) },
    )
    return () => { live = false }
  }, [dir, revisionId, tick])
  useEffect(() => { requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-testid="decide-heading"]')?.focus()) }, [])

  const decide = useCallback(async (list: DecideList, key: string, choice: FolioDecisionChoice, part?: string): Promise<void> => {
    setBusy(key); setSaid(null)
    try {
      const answer = await window.writeflex.folioVersions.decide({ dir, revision: revisionId, row: key, choice, expected: list.order, ...(part !== undefined ? { part } : {}) })
      if (answer.status === 'done') { setSaid({ tone: 'ok', text: answer.message }); setLoaded({ state: 'ready', list: answer.list }) }
      else { setSaid({ tone: 'bad', text: answer.message }); if (answer.list) setLoaded({ state: 'ready', list: answer.list }) }
    } catch {
      setSaid({ tone: 'bad', text: 'Something went wrong, and WriteFlex cannot say what was written. Check the running order.' })
    } finally {
      setBusy(null)
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-testid="decide-status"]')?.focus())
    }
  }, [dir, revisionId])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Nothing typed here reaches the Folio room's own keys. A chord with ⌘ or Control is the app's (the palette, the cheat sheet).
    if (!(event.metaKey || event.ctrlKey)) event.stopPropagation()
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && busy === null) {
      event.preventDefault()
      onClose()
    }
  }

  const stepper = (
    <ol className="fvi-stepper" aria-label="Import steps">
      <li className="done">1 Choose the file</li>
      <li className="done">2 Match sections</li>
      <li className="on" aria-current="step">3 Decide</li>
    </ol>
  )

  if (loaded.state === 'loading') return <div className="fvi fvd" data-testid="folio-decide" aria-busy="true" ref={root}>{stepper}</div>
  if (loaded.state === 'gone') {
    return (
      <div className="fvi fvd" data-testid="folio-decide" data-state="gone" ref={root} onKeyDown={onKeyDown}>
        {stepper}
        <section className="fvi-card">
          <h3 className="fvs-card-head" tabIndex={-1} data-testid="decide-heading">This revision is not here</h3>
          <div className="fvi-done"><TriangleAlert className="icon" aria-hidden="true" /><p>It is not in this Folio’s history any more, so there is nothing to decide.</p></div>
          <div className="fvi-foot"><button type="button" className="fv-btn" data-testid="decide-close" onClick={onClose}>Back to the timeline</button></div>
        </section>
      </div>
    )
  }

  if (threeOf !== null) {
    return <FolioVersionThreeText dir={dir} revisionId={revisionId} part={threeOf} onBack={() => { setThreeOf(null); setTick((value) => value + 1) }} {...(openPart ? { openPart } : {})} {...(resolveSuggestion ? { resolveSuggestion } : {})} {...(isUnsaved ? { isUnsaved } : {})} />
  }

  return (
    <DecideView
      list={loaded.list} busy={busy} said={said} rootRef={root} onKeyDown={onKeyDown} onClose={onClose} onOpenTexts={(path) => setThreeOf(path)}
      onDecide={(row, choice) => { if (busy === null) void decide(loaded.list, row.key, choice) }}
      onPlace={(match, part) => { if (busy === null) void decide(loaded.list, match.key, part === null ? 'none' : 'confirm', part ?? undefined) }}
      {...(openPart ? { openPart } : {})} {...(onSaveVersion ? { onSaveVersion } : {})}
    />
  )
}

export type DecideViewProps = {
  list: DecideList
  /** The row key being decided, or null. */
  busy: string | null
  said: { tone: 'ok' | 'bad'; text: string } | null
  rootRef?: { current: HTMLDivElement | null }
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  onClose: () => void
  onDecide: (row: StructureRow, choice: FolioDecisionChoice) => void
  /** Place a section of the Word file that matches no part: as a part (by its label) or, with null, as a new section. */
  onPlace?: (match: MatchRowOfList, part: string | null) => void
  openPart?: (path: string) => void
  onSaveVersion?: (suggestedName?: string) => void
  /** Ticket 17: open the three texts of a part. Absent: the parts both of you changed are listed without the button. */
  onOpenTexts?: (path: string) => void
}

/** The step as drawn for a list already read (the render seam of the tests). */
export function DecideView({ list, busy, said, rootRef, onKeyDown, onClose, onDecide, onPlace, openPart, onSaveVersion, onOpenTexts }: DecideViewProps): JSX.Element {
  const stepper = (
    <ol className="fvi-stepper" aria-label="Import steps">
      <li className="done">1 Choose the file</li>
      <li className="done">2 Match sections</li>
      <li className="on" aria-current="step">3 Decide</li>
    </ol>
  )
  const { revision } = list
  const waiting = list.parts.reduce((sum, part) => sum + part.suggestions.filter((entry) => entry.outcome === 'waiting').length, 0)
  const open = list.matches.filter((match) => match.choice === undefined)

  return (
    <div className="fvi fvd" data-testid="folio-decide" data-state={revision.withdrawn ? 'withdrawn' : list.complete ? 'complete' : 'deciding'} aria-busy={busy !== null || undefined} ref={rootRef} onKeyDown={onKeyDown}>
      {stepper}
      <section className="fvi-card" data-testid="decide-card">
        <h3 className="fvs-card-head fvd-head" tabIndex={-1} data-testid="decide-heading">
          <span>Deciding on {revision.from}’s revision</span>
          <span className="fv-chip acc" data-testid="decide-progress" role="status">{progressLine(list.progress)}</span>
        </h3>
        <p className="fvi-sum" data-testid="decide-summary">
          {revision.file} · {revision.by !== null ? `brought in by ${revision.by}` : 'brought in by you'}. Your text is untouched until you accept a change.
        </p>
        <div className="fvd-status" role="status" tabIndex={-1} data-testid="decide-status" data-tone={said?.tone}>{said?.text ?? ''}</div>

        {revision.withdrawn && <div className="fvi-done"><TriangleAlert className="icon" aria-hidden="true" /><p data-testid="decide-withdrawn">This revision is withdrawn, so there is nothing left to decide.</p></div>}

        {list.complete && (
          <div className="fvd-offer" data-testid="decide-offer">
            <CircleCheck aria-hidden="true" className="icon" />
            <div>
              <b>Everything is decided.</b> Save the Folio as a version, so “{list.offer}” can be compared with the one that was sent.
            </div>
            {onSaveVersion && <button type="button" className="fv-btn pri" data-testid="decide-save" onClick={() => onSaveVersion(list.offer ?? undefined)}><History aria-hidden="true" />Save “{list.offer}”…</button>}
          </div>
        )}

        {!revision.withdrawn && list.progress.total === 0 && open.length === 0 && (
          <div className="fvi-done"><CircleCheck className="icon" aria-hidden="true" /><p data-testid="decide-nothing">The Word file holds nothing to decide: no change to your parts, no new section and no part missing.</p></div>
        )}

        {open.length > 0 && (
          <>
            <h4 className="fvd-sub">To place <span className="fvd-count">{plural(open.length, 'section')} of the Word file {open.length === 1 ? 'matches' : 'match'} no part yet</span></h4>
            <p className="fvd-lead" data-testid="decide-unplaced" role="status">Only you can say which part a section is. Sections that moved and parts the Word file lacks are listed once {open.length === 1 ? 'it is' : 'they are'} placed.</p>
            <ul className="fvd-rows" data-testid="decide-matches">
              {open.map((match) => (
                <li key={match.key} className="fvd-row" data-testid="decide-match" data-key={match.key}>
                  <div className="fvd-row-text">“{match.heading === '' ? '(no heading)' : match.heading}”</div>
                  {onPlace && (
                    <select className="fvi-input" aria-label={`Which part is “${match.heading}”?`} data-testid="decide-place" value="" disabled={busy !== null} onChange={(event) => { if (event.target.value !== '') onPlace(match, event.target.value === NONE ? null : event.target.value) }}>
                      <option value="" disabled>Choose a part…</option>
                      {list.placeable.map((part) => <option key={part.label} value={part.label}>{part.title}{part.role === 'unlisted' ? ' (not in the outline)' : ''}</option>)}
                      <option value={NONE}>None: a new section</option>
                    </select>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {(list.texts ?? []).length > 0 && (
          <>
            <h4 className="fvd-sub">Three texts <span className="fvd-count">{plural(list.texts.length, 'part')} to read side by side</span></h4>
            <ul className="fvd-parts" data-testid="decide-texts">
              {list.texts.map((part) => (
                <li key={part.path} className="fvd-part" data-testid="decide-text-part" data-path={part.path} data-open={part.settled < part.total ? 'true' : undefined}>
                  <div className="fvd-part-head">
                    <span className="fvd-part-title">{part.position !== null ? <span className="fvd-num">{part.position}</span> : null}{part.title}</span>
                    {part.both && <span className="fv-chip warn" data-chip="both">both of you changed this part</span>}
                    <span className="fvd-count" data-testid="decide-text-count">{part.settled} of {part.total} decided</span>
                    {onOpenTexts && <button type="button" className="fv-btn" data-testid="decide-open-texts" onClick={() => onOpenTexts(part.path)}>Read the three texts</button>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {list.parts.length > 0 && (
          <>
            <h4 className="fvd-sub">In the margins <span className="fvd-count">{waiting === 0 ? 'all decided' : `${plural(waiting, 'suggestion')} waiting`}</span></h4>
            <ul className="fvd-parts" data-testid="decide-parts">
              {list.parts.map((part) => <PartRow key={part.path} part={part} {...(openPart ? { openPart } : {})} />)}
            </ul>
          </>
        )}

        {list.rows.length > 0 && (
          <>
            <h4 className="fvd-sub">Structure <span className="fvd-count">{list.rows.filter((row) => row.choice !== undefined).length} of {list.rows.length} decided</span></h4>
            <ul className="fvd-rows" data-testid="decide-rows">
              {list.rows.map((row) => (
                <li key={row.key} className="fvd-row" data-testid="decide-row" data-kind={row.kind} data-key={row.key} data-decided={row.choice !== undefined ? 'true' : undefined}>
                  <div className="fvd-row-text">
                    {row.choice !== undefined
                      ? <span data-testid="decide-row-decided">{decidedWords(row)}</span>
                      : <span>{rowWords(row)}</span>}
                  </div>
                  {row.choice !== undefined
                    ? <span className="fv-chip acc" data-chip="decided">decided</span>
                    : (
                      <div className="fvd-choices">
                        {STRUCTURE_CHOICES[row.kind].map((entry, at) => (
                          <button key={entry.choice} type="button" className={`fv-btn${at === 0 ? '' : ' plain'}`} data-testid={`decide-${entry.choice}`} title={entry.note} aria-disabled={busy !== null ? true : undefined}
                            onClick={() => { if (busy === null) onDecide(row, entry.choice) }}>{entry.label}</button>
                        ))}
                      </div>
                    )}
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="fvi-foot">
          <span className="fvi-need" data-testid="decide-need">{list.complete ? 'Every row is settled.' : revision.withdrawn ? '' : `${list.progress.total - list.progress.decided} left to decide.`}</span>
          <button type="button" className="fv-btn" data-testid="decide-close" disabled={busy !== null} onClick={onClose}><FileDown aria-hidden="true" />Back to the timeline</button>
        </div>
      </section>
    </div>
  )
}

function PartRow({ part, openPart }: { part: DecidePart; openPart?: (path: string) => void }): JSX.Element {
  const decided = part.suggestions.filter((entry) => entry.outcome !== 'waiting').length
  return (
    <li className="fvd-part" data-testid="decide-part" data-path={part.path} data-open={decided < part.suggestions.length ? 'true' : undefined}>
      <div className="fvd-part-head">
        <span className="fvd-part-title">{part.position !== null ? <span className="fvd-num">{part.position}</span> : null}{part.title}</span>
        {part.position === null && <span className="fv-chip" data-chip="not-in-order">not in the outline</span>}
        <span className="fvd-count" data-testid="decide-part-count">{decided} of {part.suggestions.length} decided</span>
        {openPart && <button type="button" className="fv-btn" data-testid="decide-open" onClick={() => openPart(part.path)}>Open in Text</button>}
      </div>
      <ul className="fvd-suggestions">
        {part.suggestions.map((suggestion) => (
          <li key={suggestion.id} data-testid="decide-suggestion" data-outcome={suggestion.outcome}>
            <SuggestionIcon kind={suggestion.kind} />
            <span className="fvd-text">{suggestionLine(suggestion)}{suggestion.why ? <span className="fvi-why"> {suggestion.why}</span> : null}</span>
            <span className={`fv-chip${suggestion.outcome === 'waiting' ? ' warn' : suggestion.outcome === 'accepted' ? ' acc' : ''}`} data-chip={suggestion.outcome}>{OUTCOME_WORDS[suggestion.outcome]}</span>
          </li>
        ))}
      </ul>
    </li>
  )
}
