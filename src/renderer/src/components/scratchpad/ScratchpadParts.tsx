// The floating Scratchpad's item parts (ticket 01): the text card with its formatted miniature, the
// actions an item offers, the placement note and the big preview with its Rendered / Markdown switch.
// Wording: docs/design/2026-10-28-floating-scratchpad/mockup/copy/ui-labels.md and ui-messages.md.
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { ArrowLeft } from 'lucide-react'
import { SCRATCH_KIND_LABELS, canPutBack, highlightSegments, linkBaseOf, originLabel, statsLabel, type ScratchGroup, type ScratchItem, type ScratchReferenceAction } from '../../../../shared/scratchpad-items'
import { referenceActionOffered } from '../../../../shared/scratchpad-reference-actions'
import { ScratchpadWidgetPreview } from '../../scratchpad/ScratchpadWidgetPreview'
import { fragmentHtml } from '../../scratchpad/fragment-html'

/** A path inside the folder the item's relative pictures resolve from (its origin's, unless it moved apart). */
const linkPathOf = (item: Parameters<typeof linkBaseOf>[0]): string => { const base = linkBaseOf(item); return base === '' ? '_' : `${base}/_` }

/** The dot palette carried over from the old pane, so legacy `(colour)` marks keep their meaning. */
export const SCRATCH_COLOURS: Array<{ value: string; label: string }> = [
  { value: '#b97d10', label: 'Amber' },
  { value: '#2e6be6', label: 'Blue' },
  { value: '#3f9142', label: 'Green' },
  { value: '#c2405a', label: 'Rose' },
]

export type ItemActionHandlers = {
  show?: (item: ScratchItem) => void
  /** Show one recorded citation position of a cited reference (its index in `cited.positions`). */
  showAt?: (item: ScratchItem, position: number) => void
  collect?: (item: ScratchItem) => void
  /** Collect a canonical Folio source card as a Candidate. */
  collectSource?: (item: ScratchItem) => void
  /** One of the four distinct reference acts. */
  reference?: (item: ScratchItem, action: ScratchReferenceAction) => void
  insert: (item: ScratchItem, mode: 'copy' | 'put-back') => void
  toggleDone: (item: ScratchItem) => void
  setColour: (item: ScratchItem, colour: string | null) => void
  reject: (ids: string[]) => void
  moveBack: (ids: string[]) => void
  openMove: (ids: string[]) => void
  /** Ask to delete forever (Rejected only): the panel confirms first, main re-checks before removing. */
  deleteForever?: (item: ScratchItem) => void
}

/** Links inside a drawn fragment never navigate: the preview is for reading. */
const stopLinks = (event: MouseEvent<HTMLElement>): void => {
  if ((event.target as HTMLElement | null)?.closest?.('a')) event.preventDefault()
}

export function Highlighted({ text, terms }: { text: string; terms: readonly string[] }): JSX.Element {
  return <>{highlightSegments(text, terms).map((seg, i) => (seg.hit ? <mark key={i} className="sp-hit">{seg.text}</mark> : <span key={i}>{seg.text}</span>))}</>
}

export function ScratchpadCard({
  item, group, selected, ticked, terms, assetBaseUrl, partName, onSelect, onOpen, onTick, onKeyDown,
}: {
  item: ScratchItem
  group: ScratchGroup | null
  selected: boolean
  ticked: boolean
  terms: readonly string[]
  assetBaseUrl: string | null
  partName: (path: string) => string
  onSelect: () => void
  onOpen: () => void
  onTick: (on: boolean) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}): JSX.Element {
  const html = useMemo(() => fragmentHtml(item.markdown, { originPath: linkPathOf(item), assetBaseUrl }), [item.markdown, item.origin.path, item.origin.base, assetBaseUrl])
  const origin = item.source === 'document' ? `In ${partName(item.origin.path)} · line ${item.document?.line}` : originLabel(item, partName)
  const used = item.uses.find((use) => use.mode === 'copy')
  return (
    <article
      className={`sp-card${selected ? ' selected' : ''}${ticked ? ' ticked' : ''}${item.done ? ' done' : ''}`}
      data-item={item.id}
      data-how={item.how ?? 'legacy'}
      tabIndex={0}
      role="option"
      aria-selected={selected}
      aria-label={`${item.title}. ${SCRATCH_KIND_LABELS[item.kind]}. ${origin}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={onKeyDown}
    >
      {item.source !== 'document' && item.source !== 'canonical' ? <input
        type="checkbox"
        className="sp-tick"
        checked={ticked}
        aria-label={`Tick ${item.title}`}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onTick(event.target.checked)}
      /> : null}
      {item.kind === 'widget'
        ? <div className="sp-mini sp-widget-tile" aria-hidden="true">Widget<span>Run on request</span></div>
        : item.external?.previewDataUri
          ? <div className="sp-mini sp-ext-mini" aria-hidden="true"><img src={item.external.previewDataUri} alt="" /></div>
          : <div className="sp-mini wf-fragment" aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} onClick={stopLinks} />}
      <div className="sp-card-body">
        <div className="sp-badges">
          <span className="sp-badge kind">{SCRATCH_KIND_LABELS[item.kind]}</span>
          <span className={`sp-badge origin${item.how === 'cut' ? ' cut' : ''}`} title={origin}>{origin}</span>
          {item.colour ? <span className="sp-dot" style={{ background: item.colour }} aria-label="Colour mark" /> : null}
        </div>
        <h3 className="sp-title"><Highlighted text={item.title} terms={terms} /></h3>
        <div className="sp-meta">{item.kind === 'text' ? statsLabel(item.markdown) : item.ref ? item.ref.label : item.external ? item.external.fileName : SCRATCH_KIND_LABELS[item.kind]}</div>
        <div className="sp-tags">
          {item.external?.incompatible ? <span className="sp-badge missing">Needs checking</span> : null}
          {item.external?.importedPath ? <span className="sp-badge used" title={item.external.importedPath}>Copied into assets/</span> : null}
          {item.external?.score !== undefined ? <span className="sp-badge">match {item.external.score.toFixed(2)}</span> : null}
          {group ? <span className="sp-group">{group.name}</span> : null}
          {item.done ? <span className="sp-badge done">done</span> : null}
          {item.cited ? <span className="sp-badge cited">Cited {item.cited.count}×</span> : null}
          {item.ref?.attachedParts?.length ? <span className="sp-badge attached" title={item.ref.attachedParts.join(', ')}>Attached · {item.ref.attachedParts.length}</span> : null}
          {item.ref?.state === 'missing' ? <span className="sp-badge missing">File missing</span> : null}
          {item.expandTrigger !== undefined ? <span className="sp-badge expand" title={`Type {${item.expandTrigger}} and a space in the text to expand this scrap in place.`}>expandable</span> : null}
          {used ? <span className="sp-badge used">{used.historical ? `Copied to ${partName(used.path)}` : `Used in ${partName(used.path)}`}</span> : null}
        </div>
        {item.problem ? <p className="sp-problem">{item.problem}</p> : null}
      </div>
    </article>
  )
}

/** What one item offers. Put back only for a recorded cut; Insert a copy for every text item.
 *  A canonical source card can only be collected. A collected Reference/Evidence item offers the
 *  four distinct acts of spec §5 — never Insert a copy. */
export function ItemActions({ item, handlers, canInsert }: { item: ScratchItem; handlers: ItemActionHandlers; canInsert: boolean }): JSX.Element {
  if (item.source === 'document') return <div className="sp-actions" role="group" aria-label="Item actions">
    <button type="button" onClick={() => handlers.show?.(item)}>Show in document</button>
    <button type="button" onClick={() => handlers.collect?.(item)}>Add to Scratchpad</button>
  </div>
  if (item.source === 'canonical') return <div className="sp-actions" role="group" aria-label="Item actions">
    <button type="button" className="primary" onClick={() => handlers.collectSource?.(item)}>Collect to Scratchpad</button>
  </div>
  if ((item.kind === 'ref' || item.kind === 'evidence') && item.ref) {
    const rejectedRef = item.status === 'rejected'
    const blocked = !canInsert || !!item.problem || item.ref.state === 'missing'
    const act = (action: ScratchReferenceAction, label: string, primary = false): JSX.Element | null =>
      !rejectedRef && referenceActionOffered(item.ref!, item.kind as 'ref' | 'evidence', action)
        ? <button key={action} type="button" className={primary ? 'primary' : ''} disabled={blocked} onClick={() => handlers.reference?.(item, action)}>{label}</button>
        : null
    return (
      <div className="sp-actions" role="group" aria-label="Item actions">
        {act('quote', 'Insert quote with citation', true)}
        {act('cite', 'Cite', item.kind === 'ref')}
        {act('link', 'Insert link')}
        {act('attach', 'Attach to part…')}
        <button type="button" onClick={() => handlers.toggleDone(item)}>{item.done ? 'Mark not done' : 'Mark done'}</button>
        <button type="button" onClick={() => handlers.openMove([item.id])}>Move to group…</button>
        {rejectedRef ? <button type="button" onClick={() => handlers.moveBack([item.id])}>Move back</button> : <button type="button" onClick={() => handlers.reject([item.id])}>Reject</button>}
        {rejectedRef && handlers.deleteForever ? <button type="button" className="danger" onClick={() => handlers.deleteForever!(item)}>Delete forever…</button> : null}
        <span className="sp-colours" role="group" aria-label="Colour mark">
          {SCRATCH_COLOURS.map((colour) => (
            <button key={colour.value} type="button" className={`sp-colour${item.colour === colour.value ? ' on' : ''}`} style={{ background: colour.value }} aria-label={colour.label} aria-pressed={item.colour === colour.value} onClick={() => handlers.setColour(item, item.colour === colour.value ? null : colour.value)} />
          ))}
        </span>
      </div>
    )
  }
  const putBack = canPutBack(item)
  const rejected = item.status === 'rejected'
  // An external candidate is blocked only by its recorded incompatibility: a missing local
  // copy is re-checked against the source at insert, in main, not pre-judged here.
  const insertBlocked = item.external ? !!item.external.incompatible : (item.kind !== 'text' && !!item.problem)
  return (
    <div className="sp-actions" role="group" aria-label="Item actions">
      {!rejected && putBack ? <button type="button" className="primary" disabled={!canInsert || insertBlocked} onClick={() => handlers.insert(item, 'put-back')}>Put back</button> : null}
      {!rejected ? <button type="button" className={putBack ? '' : 'primary'} disabled={!canInsert || insertBlocked} onClick={() => handlers.insert(item, 'copy')}>Insert a copy</button> : null}
      {item.uses.some(use => use.mode === 'put-back' && !use.unverified) ? <button type="button" onClick={() => handlers.show?.(item)}>Show in document</button> : null}
      <button type="button" onClick={() => handlers.toggleDone(item)}>{item.done ? 'Mark not done' : 'Mark done'}</button>
      <button type="button" onClick={() => handlers.openMove([item.id])}>Move to group…</button>
      {rejected ? <button type="button" onClick={() => handlers.moveBack([item.id])}>Move back</button> : <button type="button" onClick={() => handlers.reject([item.id])}>Reject</button>}
      {rejected && handlers.deleteForever ? <button type="button" className="danger" onClick={() => handlers.deleteForever!(item)}>Delete forever…</button> : null}
      <span className="sp-colours" role="group" aria-label="Colour mark">
        {SCRATCH_COLOURS.map((colour) => (
          <button key={colour.value} type="button" className={`sp-colour${item.colour === colour.value ? ' on' : ''}`} style={{ background: colour.value }} aria-label={colour.label} aria-pressed={item.colour === colour.value} onClick={() => handlers.setColour(item, item.colour === colour.value ? null : colour.value)} />
        ))}
      </span>
    </div>
  )
}

export type Placement = { part: string; after: string | null } | null
export type ScratchPlace = { path: string; name: string }

/**
 * Where an insert would land, and the way to move the caret without writing: Change place lists the
 * Folio's parts (or the one open document) and navigates to the chosen one's end. It never inserts;
 * choosing a place writes nothing (spec P8, journey 4).
 */
export function PlacementNote({ placement, reference = false, places = [], activePath = null, onChangePlace }: {
  placement: Placement
  reference?: boolean
  places?: readonly ScratchPlace[]
  activePath?: string | null
  onChangePlace?: (path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const note = !placement
    ? 'Click in the text to choose where this goes'
    : reference
      ? <>Goes in <b>{placement.part}</b> at the caret{placement.after ? <>, after “{placement.after}”</> : ''} — or attaches to <b>{placement.part}</b> as evidence</>
      : <>Inserts in <b>{placement.part}</b>, {placement.after ? <>after “{placement.after}”</> : 'at the start'}</>
  return (
    <div className={`sp-place${placement ? '' : ' none'}`}>
      <span className="sp-place-note">{note}</span>
      {onChangePlace && places.length > 0 ? (
        <span className="sp-place-change">
          <button type="button" className="sp-link" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Change place</button>
          {open ? (
            <span
              className="sp-menu sp-place-menu"
              role="menu"
              aria-label="Go to"
              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }}
            >
              <span className="sp-menu-head">Go to</span>
              {places.map((place) => (
                <button
                  key={place.path}
                  type="button"
                  role="menuitemradio"
                  aria-checked={place.path === activePath}
                  onClick={() => { setOpen(false); onChangePlace(place.path) }}
                >
                  {place.path === activePath ? '▸ ' : ''}{place.name}
                </button>
              ))}
              <span className="sp-menu-note">Moves your cursor only. Nothing is written until you insert.</span>
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

export function ScratchpadPreview({
  item, partName, assetBaseUrl, handlers, placement, onBack, root = null, places = [], activePath = null, onChangePlace,
}: {
  item: ScratchItem
  partName: (path: string) => string
  assetBaseUrl: string | null
  handlers: ItemActionHandlers
  placement: Placement
  onBack: () => void
  root?: string | null
  places?: readonly ScratchPlace[]
  activePath?: string | null
  onChangePlace?: (path: string) => void
}): JSX.Element {
  const [view, setView] = useState<'rendered' | 'markdown'>('rendered')
  const html = useMemo(() => fragmentHtml(item.markdown, { originPath: linkPathOf(item), assetBaseUrl }), [item.markdown, item.origin.path, item.origin.base, assetBaseUrl])
  const origin = item.source === 'document' ? `In ${partName(item.origin.path)} · line ${item.document?.line}` : originLabel(item, partName)
  const placedUses = item.uses.filter((use) => use.mode === 'put-back')
  return (
    <section className="sp-preview" aria-label={`Preview of ${item.title}`} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onBack() } }}>
      <div className="sp-preview-head">
        <button type="button" className="sp-back" autoFocus onClick={onBack}><ArrowLeft size={13} aria-hidden="true" /> Back to the list</button>
        <h2 className="sp-preview-title">{item.title}</h2>
      </div>
      <div className="sp-badges">
        <span className="sp-badge kind">{SCRATCH_KIND_LABELS[item.kind]}</span>
        <span className={`sp-badge origin${item.how === 'cut' ? ' cut' : ''}`}>{origin}</span>
        {placedUses.length ? <span className="sp-badge placed">Put back</span> : null}
      </div>
      <div className="sp-preview-meta">
        <span>{origin}</span>
        {item.origin.heading ? <span>§ {item.origin.heading}</span> : null}
        {item.origin.capturedSpan ? <span>Collected at line {item.origin.capturedSpan.line}</span> : null}
        <span>{item.kind === 'text' ? statsLabel(item.markdown) : SCRATCH_KIND_LABELS[item.kind]}</span>
      </div>
      {item.ref ? (
        <div className="sp-ref-details">
          <p><b>{item.ref.label}</b>{item.ref.sourceTitle && item.ref.sourceTitle !== item.ref.label ? <> · {item.ref.sourceTitle}</> : null}</p>
          {item.ref.quote ? <blockquote className="sp-ref-quote">“{item.ref.quote}”</blockquote> : null}
          <p className="sp-ref-target">{item.ref.sourcePath ?? item.ref.target}</p>
          {item.ref.attachedParts?.length ? <p>Attached as evidence to {item.ref.attachedParts.join(', ')}.</p> : null}
          {item.ref.state && item.ref.state !== 'ready' ? <p>{item.ref.state}</p> : null}
          {item.cited ? (
            <div className="sp-ref-cited">
              <p>Cited {item.cited.count}× in {partName(item.origin.path)}:</p>
              {item.cited.positions.map((position, index) => (
                <button key={index} type="button" className="sp-link" onClick={() => handlers.showAt?.(item, index)}>Line {position.line} — Show in document</button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {item.external ? (
        <div className="sp-ref-details">
          <p><b>{item.external.provenance}</b> · {item.external.fileName}</p>
          {item.external.incompatible
            ? <p>{item.external.incompatible} It cannot be inserted; its source stays readable.</p>
            : item.external.importedPath
              ? <p>Copied into <b>{item.external.importedPath}</b> in this workspace. The document no longer depends on the source, and where it came from stays on this item.</p>
              : <p>Collecting kept a pointer and a small preview. The file is copied into this document’s <b>assets/</b> folder only when you insert it, and the source stays on the item.</p>}
        </div>
      ) : null}
      {item.problem ? <p className="sp-problem">{item.problem}</p> : null}
      {placedUses.length ? <p className="sp-note">This text is in the document now. The saved scrap is untouched.</p> : null}
      <div className="sp-switch" role="tablist" aria-label="Show as">
        <button type="button" role="tab" aria-selected={view === 'rendered'} className={view === 'rendered' ? 'on' : ''} onClick={() => setView('rendered')}>Rendered</button>
        <button type="button" role="tab" aria-selected={view === 'markdown'} className={view === 'markdown' ? 'on' : ''} onClick={() => setView('markdown')}>Markdown</button>
      </div>
      <div className="sp-preview-body" tabIndex={0}>
        {view === 'rendered'
          ? item.kind === 'widget'
            ? <ScratchpadWidgetPreview item={item} root={root} />
            : item.external?.importedPath && assetBaseUrl
              ? <div className="wf-fragment"><img src={`${assetBaseUrl.replace(/\/$/, '')}/${item.external.importedPath.split('/').map(encodeURIComponent).join('/')}`} alt={item.title} /></div>
              : item.external?.previewDataUri
                ? <div className="wf-fragment"><img src={item.external.previewDataUri} alt={item.title} /></div>
                : <div className="wf-fragment" dangerouslySetInnerHTML={{ __html: html }} onClick={stopLinks} />
          : <pre className="sp-source">{item.markdown}</pre>}
      </div>
      <ItemActions item={item} handlers={handlers} canInsert={placement !== null} />
      {item.source !== 'document' && item.source !== 'canonical' ? <PlacementNote placement={placement} reference={item.kind === 'ref' || item.kind === 'evidence'} places={places} activePath={activePath} onChangePlace={onChangePlace} /> : null}
    </section>
  )
}

function ScratchpadCompareColumn({
  item, partName, assetBaseUrl, handlers, placement, root, onTakeOut,
}: {
  item: ScratchItem
  partName: (path: string) => string
  assetBaseUrl: string | null
  handlers: ItemActionHandlers
  placement: Placement
  root: string | null
  onTakeOut: (item: ScratchItem) => void
}): JSX.Element {
  const [view, setView] = useState<'rendered' | 'markdown'>('rendered')
  const html = useMemo(() => fragmentHtml(item.markdown, { originPath: linkPathOf(item), assetBaseUrl }), [item.markdown, item.origin.path, item.origin.base, assetBaseUrl])
  const origin = item.source === 'document' ? `In ${partName(item.origin.path)} · line ${item.document?.line}` : originLabel(item, partName)
  return (
    <article className="sp-compare-col" data-compare-item={item.id} aria-label={`Comparing ${item.title}`}>
      <div className="sp-badges">
        <span className="sp-badge kind">{SCRATCH_KIND_LABELS[item.kind]}</span>
        <span className={`sp-badge origin${item.how === 'cut' ? ' cut' : ''}`} title={origin}>{origin}</span>
        {item.cited ? <span className="sp-badge cited">Cited {item.cited.count}×</span> : null}
        {item.ref?.state === 'missing' ? <span className="sp-badge missing">File missing</span> : null}
      </div>
      <h3 className="sp-compare-title">{item.title}</h3>
      <div className="sp-meta">{item.kind === 'text' ? statsLabel(item.markdown) : item.ref ? item.ref.label : SCRATCH_KIND_LABELS[item.kind]}</div>
      {item.ref?.quote ? <blockquote className="sp-ref-quote">“{item.ref.quote}”</blockquote> : null}
      {item.problem ? <p className="sp-problem">{item.problem}</p> : null}
      <div className="sp-switch" role="tablist" aria-label="Show as">
        <button type="button" role="tab" aria-selected={view === 'rendered'} className={view === 'rendered' ? 'on' : ''} onClick={() => setView('rendered')}>Rendered</button>
        <button type="button" role="tab" aria-selected={view === 'markdown'} className={view === 'markdown' ? 'on' : ''} onClick={() => setView('markdown')}>Markdown</button>
      </div>
      <div className="sp-compare-body" tabIndex={0}>
        {view === 'rendered'
          ? item.kind === 'widget'
            ? <ScratchpadWidgetPreview item={item} root={root} />
            : item.external?.previewDataUri && !item.external.importedPath
              ? <div className="wf-fragment"><img src={item.external.previewDataUri} alt={item.title} /></div>
              : <div className="wf-fragment" dangerouslySetInnerHTML={{ __html: html }} onClick={stopLinks} />
          : <pre className="sp-source">{item.markdown}</pre>}
      </div>
      <ItemActions item={item} handlers={handlers} canInsert={placement !== null} />
      <div className="sp-actions">
        <button type="button" onClick={() => onTakeOut(item)}>Take out</button>
      </div>
    </article>
  )
}

/**
 * Compare side by side (journey 2, JB7): two to four candidates large, each with its own typed
 * actions — a reference still cites/links/attaches, text and assets still insert, a widget still
 * runs only sealed on request. Comparison itself is chrome: nothing is written until an item's own
 * action is pressed, and Take out / Back change only what is shown.
 */
export function ScratchpadCompare({
  items, partName, assetBaseUrl, handlers, placement, root = null, places = [], activePath = null, onChangePlace, onBack, onTakeOut,
}: {
  items: readonly ScratchItem[]
  partName: (path: string) => string
  assetBaseUrl: string | null
  handlers: ItemActionHandlers
  placement: Placement
  root?: string | null
  places?: readonly ScratchPlace[]
  activePath?: string | null
  onChangePlace?: (path: string) => void
  onBack: () => void
  onTakeOut: (item: ScratchItem) => void
}): JSX.Element {
  return (
    <section
      className="sp-compare"
      aria-label="Compare side by side"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onBack() } }}
    >
      <div className="sp-preview-head">
        <button type="button" className="sp-back" autoFocus onClick={onBack}><ArrowLeft size={13} aria-hidden="true" /> Back to the list</button>
        <h2 className="sp-preview-title">Compare side by side</h2>
      </div>
      {items.some((item) => item.source !== 'document' && item.source !== 'canonical')
        ? <PlacementNote placement={placement} reference={items.every((item) => item.kind === 'ref' || item.kind === 'evidence')} places={places} activePath={activePath} onChangePlace={onChangePlace} />
        : null}
      <div className="sp-compare-cols">
        {items.map((item) => (
          <ScratchpadCompareColumn key={item.id} item={item} partName={partName} assetBaseUrl={assetBaseUrl} handlers={handlers} placement={placement} root={root} onTakeOut={onTakeOut} />
        ))}
      </div>
    </section>
  )
}
