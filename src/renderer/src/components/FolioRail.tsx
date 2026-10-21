import { useEffect, useRef, type ReactNode } from 'react'
import { BookOpen, Plus } from 'lucide-react'
import { roleLabel } from '../../../shared/folio-front-matter'
import type { PlanDisplayRow } from '../plan/plan-view-model'

/** A file under Not in the outline that can become front matter (the Plan's `frontMatterOffer`). */
export type FrontMatterOffer = { index: number; title: string; path: string; refusal?: string | null }

const wordsText = (words: number | null): string | null => (words === null ? null : `${words.toLocaleString('en-GB')} ${words === 1 ? 'word' : 'words'}`)

/** The "Length" line of the selected-part panel: words and headings, whichever are known. */
export function partLengthText(words: number | null, headings: number | null): string {
  const parts = [wordsText(words), headings === null ? null : `${headings} ${headings === 1 ? 'heading' : 'headings'}`].filter((part): part is string => part !== null)
  return parts.length ? parts.join(' · ') : 'not written yet'
}

/**
 * The selected part's settings in the side rail (2026-10-19 redesign, element 4, option B): role, file, length and
 * the heading switch (with the title-conflict flag and fixes). The controls arrive as nodes: the page owns them.
 */
export function FolioSelectedPanel({ row, headingCount, roleControl, headingControl }: { row: PlanDisplayRow | null; headingCount: number | null; roleControl: ReactNode; headingControl: ReactNode }): JSX.Element {
  return (
    <section className="rail-card" aria-label="Selected part" data-plan-selected-panel="true">
      <header className="rail-head"><span className="rail-k">Selected part</span>{row && <span className="rail-note">{row.title}</span>}</header>
      {!row && <p className="rail-empty">Select a part in the running order to change its role or heading.</p>}
      {row && (
        <>
          <dl className="rail-facts">
            <dt>Role</dt><dd>{roleControl}</dd>
            <dt>File</dt><dd className="rail-mono" data-plan-selected-file="true">{row.path ?? 'not written yet'}</dd>
            <dt>Length</dt><dd className="rail-mono" data-plan-selected-length="true">{partLengthText(row.words, row.written ? headingCount : null)}</dd>
            {row.written && <><dt>Heading</dt><dd>{headingControl}</dd></>}
          </dl>
          <div className="rail-keys kbhint"><kbd>⏎</kbd> {row.written ? 'open' : 'write this part'} · <kbd>⌥↑↓</kbd> move · <kbd>R</kbd> role · <kbd>⌘⌫</kbd> take out</div>
        </>
      )}
    </section>
  )
}

export type FolioFrontMatterSlotProps = {
  rows: PlanDisplayRow[]
  selected: number | null
  offers: FrontMatterOffer[]
  busy: boolean
  /** Whether the Choose a file menu is open (the palette command opens it too). */
  menuOpen: boolean
  onMenuOpen: (open: boolean) => void
  onSelect: (index: number) => void
  onChoose: (offer: FrontMatterOffer) => void
  onTakeOut: (index: number) => void
}

/**
 * Front matter in the side rail (element 3, option B): "None yet" with Choose a file while empty; once filled,
 * one line per front-matter part with Take out (the title page is also the Cover band above the chapters).
 */
export function FolioFrontMatterSlot({ rows, selected, offers, busy, menuOpen, onMenuOpen, onSelect, onChoose, onTakeOut }: FolioFrontMatterSlotProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onPointer = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) onMenuOpen(false) }
    window.addEventListener('pointerdown', onPointer)
    return () => window.removeEventListener('pointerdown', onPointer)
  }, [menuOpen, onMenuOpen])

  const menuKey = (event: React.KeyboardEvent): void => {
    const list = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = list.indexOf(document.activeElement as HTMLElement)
    const move = (to: number): void => { event.preventDefault(); list[(to + list.length) % list.length]?.focus() }
    if (event.key === 'ArrowDown') move(at + 1)
    else if (event.key === 'ArrowUp') move(at - 1)
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onMenuOpen(false); root.current?.querySelector<HTMLElement>('[data-plan-choose-front]')?.focus() }
    else if (event.key === 'Tab') onMenuOpen(false)
  }

  const chooser = (
    <div className="rail-choose" ref={root}>
      <button type="button" className="rail-btn" data-plan-choose-front="true" aria-haspopup="menu" aria-expanded={menuOpen} disabled={busy || offers.length === 0} title={offers.length === 0 ? 'No file under Not in the outline can be front matter yet. A part can also be given the Front matter role.' : 'Choose a file from Not in the outline to put before the contents'} onClick={() => onMenuOpen(!menuOpen)}>
        Choose a file
      </button>
      {menuOpen && offers.length > 0 && (
        <div className="rail-menu" role="menu" aria-label="Choose front matter" onKeyDown={menuKey}>
          {offers.map((offer) => (
            <button key={offer.path} type="button" role="menuitem" className="folio-open-item" data-plan-choose-front-item={offer.path} disabled={Boolean(offer.refusal)} title={offer.refusal ?? undefined} onClick={() => { onMenuOpen(false); onChoose(offer) }}>{offer.title}</button>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <section className="rail-card" aria-label="Front matter" data-plan-front-matter="true">
      <header className="rail-head"><span className="rail-k">Front matter</span><span className="rail-note">before the contents · never in it</span></header>
      {rows.length === 0 ? (
        <div className="rail-slot empty" data-plan-front-empty="true">
          <Plus className="icon sm" aria-hidden="true" />
          <span className="rail-slot-text"><strong>None yet</strong><span>{offers.length > 0 ? 'The title page below can go here' : 'A title page or a preface can go here'}</span></span>
          {chooser}
        </div>
      ) : (
        <>
          {rows.map((row) => {
            const index = row.index ?? 0
            return (
              <div key={row.path ?? row.title} className={`rail-slot filled${selected === index ? ' sel' : ''}`} data-plan-front-slot={row.path ?? undefined}>
                <BookOpen className="icon sm" aria-hidden="true" />
                <button type="button" className="rail-slot-text rail-slot-pick" onClick={() => onSelect(index)}><strong>{row.title}</strong><span>{[row.path, row.titlePage ? 'the export’s cover' : roleLabel(row.role)].filter(Boolean).join(' · ')}</span></button>
                <button type="button" className="rail-btn" data-plan-take-out-front={row.path ?? undefined} disabled={busy} title="Take this out of the Folio outline; the file stays where it is" aria-label={`Take out ${row.title}`} onClick={() => onTakeOut(index)}>Take out</button>
              </div>
            )
          })}
          {offers.length > 0 && <div className="rail-more">{chooser}</div>}
        </>
      )}
    </section>
  )
}
