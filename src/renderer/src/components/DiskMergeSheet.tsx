import { useEffect, useMemo, useRef, useState } from 'react'
import { GitMerge } from 'lucide-react'
import { sheetKeyAction, trappedFocus } from '../../../shared/folio-add-all'
import { mergeCounts, mergedText, type ConflictPick, type MergeChunk, type ThreeWayMerge } from '../../../shared/three-way-merge'
import { diffSegments, type DiffSegment } from '../app/margin-card'

type Props = {
  fileName: string
  merge: ThreeWayMerge
  busy: boolean
  onMerge: (picks: ConflictPick[]) => void
  onCancel: () => void
}

/** Unchanged runs longer than this fold to a one-line marker. */
const SHOWN_UNCHANGED = 2

const PICKS: ReadonlyArray<{ pick: ConflictPick; label: string }> = [
  { pick: 'mine', label: 'Keep mine' },
  { pick: 'theirs', label: 'Take disk' },
  { pick: 'both', label: 'Keep both' },
]

function Diff({ segments }: { segments: DiffSegment[] }): JSX.Element {
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'del' ? <del key={index}>{segment.text}</del>
          : segment.kind === 'ins' ? <ins key={index}>{segment.text}</ins>
            : <span key={index}>{segment.text}</span>)}
    </>
  )
}

const joined = (lines: readonly string[]): string => lines.join('\n')
/** Words that changed against the version both began from. */
const against = (base: readonly string[], lines: readonly string[]): DiffSegment[] => diffSegments(joined(base), joined(lines), { clip: false })

/** What the summary line says about how the two versions combine. */
export function diskMergeSummary(merge: ThreeWayMerge): string {
  const { fromDisk, fromMine, conflicts } = mergeCounts(merge)
  const changes = (n: number): string => `${n} ${n === 1 ? 'change' : 'changes'}`
  const parts: string[] = []
  if (fromDisk > 0) parts.push(`${changes(fromDisk)} from the disk`)
  if (fromMine > 0) parts.push(`${fromDisk > 0 ? fromMine : changes(fromMine)} of yours`)
  const clean = parts.length === 0 ? '' : `${parts.join(' and ')} ${fromDisk + fromMine === 1 ? 'combines' : 'combine'} on ${fromDisk + fromMine === 1 ? 'its' : 'their'} own.`
  if (conflicts === 0) return clean ? `${clean} Nothing overlaps.` : 'The two versions say the same thing. Merging keeps your text.'
  const asked = conflicts === 1 ? '1 place was changed in both: choose what to keep.' : `${conflicts} places were changed in both: choose what to keep in each.`
  return clean ? `${clean} ${asked}` : asked
}

/** An unchanged run: shown when short; otherwise folded, keeping the line next to each change as its context. */
function Unchanged({ lines, afterChange, beforeChange }: { lines: string[]; afterChange: boolean; beforeChange: boolean }): JSX.Element | null {
  const words = lines.filter((line) => line.trim() !== '')
  if (words.length === 0) return null
  const head = afterChange ? 1 : 0
  const tail = beforeChange ? 1 : 0
  if (words.length <= SHOWN_UNCHANGED + head + tail) return <div className="dm-same">{words.map((line, i) => <p key={i}>{line}</p>)}</div>
  const folded = words.length - head - tail
  return (
    <div className="dm-same">
      {head > 0 && <p>{words[0]}</p>}
      <div className="dm-fold" aria-label={`${folded} unchanged lines`}><span>{folded} unchanged lines</span></div>
      {tail > 0 && <p>{words[words.length - 1]}</p>}
    </div>
  )
}

function Combined({ chunk }: { chunk: Extract<MergeChunk, { kind: 'mine' | 'theirs' | 'both' }> }): JSX.Element {
  const tag = chunk.kind === 'mine' ? 'Yours' : chunk.kind === 'theirs' ? 'From disk' : 'Both'
  return (
    <div className={`dm-auto dm-${chunk.kind}`}>
      <span className="dm-tag">{tag}</span>
      <div className="dm-text"><Diff segments={against(chunk.base, chunk.lines)} /></div>
    </div>
  )
}

/**
 * Where Tab goes inside the sheet: the index of the next focusable control, or `dialog` when there is none
 * (a clean merge while it is written: both buttons are disabled and there are no choices). Tab never
 * leaves the sheet, so the page behind the modal is never reached.
 */
export function diskMergeTabTarget(count: number, current: number, backwards: boolean): number | 'dialog' {
  return trappedFocus(count, current, backwards) ?? 'dialog'
}

/** "Merge" on the changed-on-disk banner: what combines on its own, and a choice for each place both changed. */
export function DiskMergeSheet({ fileName, merge, busy, onMerge, onCancel }: Props): JSX.Element {
  const [picks, setPicks] = useState<Array<ConflictPick | undefined>>(() => Array.from({ length: merge.conflicts }, () => undefined))
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLElement | null>(null)
  const open = picks.filter((pick) => pick === undefined).length
  const ready = useMemo(() => mergedText(merge, picks) !== null, [merge, picks])

  useEffect(() => { (firstRef.current ?? dialogRef.current?.querySelector<HTMLElement>('.dm-merge'))?.focus() }, [])
  // While the merge is written its buttons are disabled; focus on one of them would fall out to the page.
  // The dialog itself (tabIndex -1) holds it instead, so its keys stay its own.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!busy || !dialog) return
    const at = document.activeElement as HTMLElement | null
    if (!at || !dialog.contains(at) || (at as HTMLButtonElement).disabled) dialog.focus()
  }, [busy])

  const submit = (): void => { if (ready && !busy) onMerge(picks.map((pick) => pick as ConflictPick)) }

  /** The sheet's keys from any focus inside it: Esc cancels, ⌘↵ merges, Tab and ⇧Tab stay inside. */
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const dialog = dialogRef.current
    if (!dialog) return
    const action = sheetKeyAction(event)
    // While the merge is being written there is nothing left to cancel: Esc waits for it.
    if (action === 'close') { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); return }
    if (action === 'add') { event.preventDefault(); event.stopPropagation(); submit(); return }
    if (action !== 'tab') return
    // Radios: only the checked one (or the first of an unanswered group) is a Tab stop.
    const tabStop = (el: HTMLElement): boolean => {
      if (!(el instanceof HTMLInputElement)) return true
      if (el.checked) return true
      const group = dialog.querySelectorAll<HTMLInputElement>(`input[name="${el.name}"]`)
      return group[0] === el && ![...group].some((radio) => radio.checked)
    }
    const focusable = [...dialog.querySelectorAll<HTMLElement>('input[type="radio"], button:not([disabled])')].filter(tabStop)
    const next = diskMergeTabTarget(focusable.length, focusable.indexOf(document.activeElement as HTMLElement), event.shiftKey)
    event.preventDefault()
    if (next === 'dialog') dialog.focus()
    else focusable[next]?.focus()
  }

  return (
    <div className="overlay open" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}>
      <div ref={dialogRef} className="sheet dm-sheet" role="dialog" aria-modal="true" tabIndex={-1} aria-busy={busy} aria-labelledby="dm-title" aria-describedby="dm-summary" data-testid="disk-merge-sheet" onKeyDown={onKeyDown}>
        <header>
          <GitMerge className="icon" aria-hidden="true" />
          <h2 id="dm-title">Merge with the version on disk</h2>
          <span className="dm-file">{fileName}</span>
        </header>
        <p id="dm-summary" className="dm-summary">{diskMergeSummary(merge)}</p>
        <div className="dm-body" aria-label="The merged document">
          {merge.chunks.map((chunk, index) => {
            if (chunk.kind === 'same') return <Unchanged key={index} lines={chunk.lines} afterChange={index > 0} beforeChange={index < merge.chunks.length - 1} />
            if (chunk.kind !== 'conflict') return <Combined key={index} chunk={chunk} />
            const pick = picks[chunk.index]
            const choose = (next: ConflictPick): void => setPicks((current) => current.map((p, i) => (i === chunk.index ? next : p)))
            const shows = (side: 'mine' | 'theirs'): boolean => pick === side || pick === 'both'
            return (
              <section key={index} className={`dm-conflict${pick ? ' picked' : ''}`} data-testid="disk-merge-conflict" aria-label={`Changed in both, ${chunk.index + 1} of ${merge.conflicts}`}>
                <div className="dm-conflict-head">
                  <span className="dm-conflict-title">Changed in both</span>
                  <div className="dm-picks" role="radiogroup" aria-label="Which to keep">
                    {PICKS.map(({ pick: option, label }, i) => (
                      <label key={option} className={`dm-pick${pick === option ? ' on' : ''}`}>
                        <input
                          type="radio"
                          name={`dm-conflict-${chunk.index}`}
                          value={option}
                          checked={pick === option}
                          onChange={() => choose(option)}
                          ref={chunk.index === 0 && i === 0 ? (el) => { firstRef.current = el } : undefined}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="dm-sides">
                  <div className={`dm-side dm-side-mine${shows('mine') ? ' kept' : pick ? ' dropped' : ''}`}>
                    <h3>Yours</h3>
                    <div className="dm-text">{chunk.mine.length ? <Diff segments={against(chunk.base, chunk.mine)} /> : <em className="dm-gone">Removed in yours</em>}</div>
                  </div>
                  <div className={`dm-side dm-side-theirs${shows('theirs') ? ' kept' : pick ? ' dropped' : ''}`}>
                    <h3>On disk</h3>
                    <div className="dm-text">{chunk.theirs.length ? <Diff segments={against(chunk.base, chunk.theirs)} /> : <em className="dm-gone">Removed on disk</em>}</div>
                  </div>
                </div>
              </section>
            )
          })}
        </div>
        <footer>
          <span className="grow">
            {open > 0
              ? `Choose for ${open === 1 ? '1 more place' : `${open} more places`} to merge.`
              : 'Both versions are kept in History before the merge is saved.'}
          </span>
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel <kbd>esc</kbd></button>
          <button type="button" className="btn primary dm-merge" disabled={!ready || busy} onClick={submit}>
            <GitMerge className="icon sm" aria-hidden="true" />Merge and save <kbd>⌘↵</kbd>
          </button>
        </footer>
      </div>
    </div>
  )
}
