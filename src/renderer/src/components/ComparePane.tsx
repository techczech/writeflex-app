import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowLeftRight } from 'lucide-react'
import type { Version, VersionCompareEndpointId, VersionCompareResult } from '../../../preload'
import {
  buildMarkdownBlocks,
  buildSideBySideCompareRows,
  syncScrollPair,
  type CompareChangeKind,
  type CompareMarkdownBlock,
  type CompareMarkdownSpan,
  type CompareSideBySideRow,
  type CompareSidePart,
  type ScrollSyncState,
} from './compare-side-by-side'
import { compareToColumnMode } from './compare-live'

type ComparePaneProps = {
  versions: Version[]
  result: VersionCompareResult | null
  loading: boolean
  error: string
  fromId: VersionCompareEndpointId
  toId: VersionCompareEndpointId
  onFromChange: (id: VersionCompareEndpointId) => void
  onToChange: (id: VersionCompareEndpointId) => void
  onSwap: () => void
  onBack: () => void
  getEditableToScrollElement?: () => HTMLElement | null
}

const PROVENANCE_LABEL = {
  agent: 'agent',
  writer: 'you',
  reviewer: 'reviewer',
} as const

function endpointOptions(versions: Version[]): { id: VersionCompareEndpointId; label: string }[] {
  return [
    { id: 'working', label: 'Working' },
    ...versions.map((version) => ({ id: version.id as VersionCompareEndpointId, label: version.name })),
  ]
}

function endpointMeta(result: VersionCompareResult | null, side: 'from' | 'to'): string {
  const endpoint = result?.[side]
  if (!endpoint) return ''
  if (endpoint.working) return 'Current text'
  const author = endpoint.author?.name ?? 'Unknown author'
  const date = endpoint.ts
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(endpoint.ts))
    : 'No date'
  return `${author} · ${date}`
}

function endpointName(options: ReturnType<typeof endpointOptions>, id: VersionCompareEndpointId): string {
  return options.find((option) => option.id === id)?.label ?? 'Version'
}

function partClass(part: CompareSidePart): string | undefined {
  if (part.formatting && part.kind === 'added') return 'compare-fmt compare-add'
  if (part.formatting && part.kind === 'removed') return 'compare-fmt compare-remove'
  if (part.formatting) return 'compare-fmt'
  if (part.kind === 'added') return 'compare-add'
  if (part.kind === 'removed') return 'compare-remove'
  return undefined
}

function spanWithStyle(span: CompareMarkdownSpan, node: JSX.Element): JSX.Element {
  if (span.style === 'strong') return <strong>{node}</strong>
  if (span.style === 'emphasis') return <em>{node}</em>
  if (span.style === 'code') return <code>{node}</code>
  if (span.style === 'link') return <a>{node}</a>
  return node
}

function renderSpans(spans: CompareMarkdownSpan[]): JSX.Element[] {
  return spans.map((span, index) => {
    const className = partClass(span)
    const node = <span className={className}>{span.text}</span>
    return <span key={index}>{spanWithStyle(span, node)}</span>
  })
}

function renderBlock(block: CompareMarkdownBlock, index: number): JSX.Element {
  const children = renderSpans(block.children)
  if (block.kind === 'heading') {
    const Heading = `h${Math.min(Math.max(block.level ?? 1, 1), 6)}` as keyof JSX.IntrinsicElements
    return <Heading key={index} className="compare-md-block">{children}</Heading>
  }
  if (block.kind === 'blockquote') return <blockquote key={index} className="compare-md-block"><p>{children}</p></blockquote>
  if (block.kind === 'list-item') {
    const List = block.ordered ? 'ol' : 'ul'
    return <List key={index} className="compare-md-block compare-md-list"><li>{children}</li></List>
  }
  if (block.kind === 'blank') return <div key={index} className="compare-md-blank" aria-hidden="true" />
  return <p key={index} className="compare-md-block">{children}</p>
}

function renderParts(parts: CompareSidePart[], gapLabel: string): JSX.Element {
  if (parts.length === 0) return <span className="compare-gap">{gapLabel}</span>
  return <>{buildMarkdownBlocks(parts).map(renderBlock)}</>
}

function rowProvenanceClass(row: CompareSideBySideRow): string {
  if (row.provenance === 'writer') return 'prov-writer'
  if (row.provenance === 'agent') return 'prov-agent'
  if (row.provenance === 'reviewer') return 'prov-reviewer'
  return ''
}

export function ComparePane({
  versions,
  result,
  loading,
  error,
  fromId,
  toId,
  onFromChange,
  onToChange,
  onSwap,
  onBack,
  getEditableToScrollElement,
}: ComparePaneProps): JSX.Element {
  const [hiddenSource, setHiddenSource] = useState<Set<string>>(() => new Set())
  const [hiddenChangeKinds, setHiddenChangeKinds] = useState<Set<CompareChangeKind>>(() => new Set())
  const fromScrollRef = useRef<HTMLDivElement | null>(null)
  const toScrollRef = useRef<HTMLDivElement | null>(null)
  const syncState = useRef<ScrollSyncState>({ locked: false })
  const options = useMemo(() => endpointOptions(versions), [versions])
  const editableTo = compareToColumnMode(toId) === 'editable-working'
  const rows = useMemo(
    () =>
      buildSideBySideCompareRows(result, {
        hiddenProvenance: hiddenSource,
        hiddenChangeKinds,
      }),
    [result, hiddenSource, hiddenChangeKinds],
  )
  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const change of result?.changes ?? []) {
      counts.set(change.provenance, (counts.get(change.provenance) ?? 0) + 1)
    }
    return (['writer', 'agent', 'reviewer'] as const)
      .map((key) => ({ key, label: PROVENANCE_LABEL[key], count: counts.get(key) ?? 0 }))
      .filter((item) => item.count > 0)
  }, [result])
  const changeCounts = useMemo(() => {
    const counts = { added: 0, removed: 0 }
    for (const change of result?.changes ?? []) {
      if (change.diffKind !== 'removed') counts.added += 1
      if (change.diffKind !== 'added') counts.removed += 1
    }
    return counts
  }, [result])
  const tally = useMemo(() => {
    const source = sourceCounts.map((item) => `${item.label} ${item.count}`).join(' · ')
    return `${result?.changes.length ?? 0} changes${source ? ` · ${source}` : ''}`
  }, [result, sourceCounts])

  const toggleSource = useCallback((key: string) => {
    setHiddenSource((current) => {
      const next = new Set(current)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }, [])
  const toggleChangeKind = useCallback((kind: CompareChangeKind) => {
    setHiddenChangeKinds((current) => {
      const next = new Set(current)
      next.has(kind) ? next.delete(kind) : next.add(kind)
      return next
    })
  }, [])
  const syncScroll = useCallback((side: 'from' | 'to') => {
    const from = fromScrollRef.current
    const to = editableTo ? getEditableToScrollElement?.() ?? null : toScrollRef.current
    if (!from || !to) return
    const source = side === 'from' ? from : to
    const target = side === 'from' ? to : from
    syncScrollPair(source, target, syncState.current, (unlock) => requestAnimationFrame(unlock))
  }, [editableTo, getEditableToScrollElement])

  useEffect(() => {
    if (!editableTo) return
    const to = getEditableToScrollElement?.()
    if (!to) return
    const onScroll = (): void => syncScroll('to')
    to.addEventListener('scroll', onScroll)
    return () => to.removeEventListener('scroll', onScroll)
  }, [editableTo, getEditableToScrollElement, syncScroll])

  const renderRows = (side: 'from' | 'to'): JSX.Element[] =>
    rows.map((row) => (
      <div
        key={`${side}-${row.id}`}
        className={`compare-doc-row ${row.kind !== 'equal' ? `changed ${rowProvenanceClass(row)}` : ''}${row.dimmed ? ' dimmed' : ''}`}
        title={row.author ? `${row.author.name} · ${row.provenance ? PROVENANCE_LABEL[row.provenance] : ''}` : undefined}
      >
        <div className="compare-row-text">
          {renderParts(side === 'from' ? row.left : row.right, side === 'from' ? 'Added on the right' : 'Removed on the left')}
        </div>
      </div>
    ))

  return (
    <section className="compare-main" aria-label="Compare versions">
      <div className="compare-bar">
        <button className="compare-back" type="button" onClick={onBack}>
          <ArrowLeft className="icon" aria-hidden="true" />
          Back to editing
        </button>
        <h1>Compare</h1>
        <div className="compare-pickers">
          <label>
            <span>From</span>
            <select value={fromId} onChange={(e) => onFromChange(e.target.value as VersionCompareEndpointId)}>
              {options.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <button className="compare-swap" type="button" onClick={onSwap} title="Swap comparison direction" aria-label="Swap comparison direction">
            <ArrowLeftRight className="icon" aria-hidden="true" />
          </button>
          <label>
            <span>To</span>
            <select value={toId} onChange={(e) => onToChange(e.target.value as VersionCompareEndpointId)}>
              {options.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
        <span className="compare-spacer" />
        <span className="compare-tally" aria-live="polite">
          {loading ? 'Loading comparison…' : error || tally}
        </span>
        <div className="compare-filters-main" aria-label="Compare filters">
          <span className="compare-filter-label">source</span>
          {sourceCounts.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`compare-chip source-${item.key}${hiddenSource.has(item.key) ? ' off' : ''}`}
              aria-pressed={!hiddenSource.has(item.key)}
              onClick={() => toggleSource(item.key)}
            >
              <span className="sw" aria-hidden="true" />
              {item.label} {item.count}
            </button>
          ))}
          <span className="compare-filter-sep" aria-hidden="true" />
          <span className="compare-filter-label">change</span>
          <button
            type="button"
            className={`compare-chip change-added${hiddenChangeKinds.has('added') ? ' off' : ''}`}
            aria-pressed={!hiddenChangeKinds.has('added')}
            onClick={() => toggleChangeKind('added')}
          >
            <span className="sw" aria-hidden="true" />
            added {changeCounts.added}
          </button>
          <button
            type="button"
            className={`compare-chip change-removed${hiddenChangeKinds.has('removed') ? ' off' : ''}`}
            aria-pressed={!hiddenChangeKinds.has('removed')}
            onClick={() => toggleChangeKind('removed')}
          >
            <span className="sw" aria-hidden="true" />
            removed {changeCounts.removed}
          </button>
        </div>
      </div>

      <div className="compare-columns-main">
        <div className="compare-separator" aria-hidden="true" />
        <div className="compare-column-pane" ref={fromScrollRef} onScroll={() => syncScroll('from')}>
          <div className="compare-column-head">
            <span>From · read-only</span>
            <b>{endpointName(options, fromId)}</b>
            <small>{endpointMeta(result, 'from')}</small>
          </div>
          <article className="compare-doc" aria-label="From document">
            {renderRows('from')}
          </article>
        </div>
        <div className="compare-column-pane to-column" ref={toScrollRef} onScroll={() => syncScroll('to')}>
          <div className="compare-column-head">
            <span>{editableTo ? 'To · editable' : 'To · read-only'}</span>
            <b>{endpointName(options, toId)}</b>
            <small>{editableTo ? 'Edit here — diff updates live' : endpointMeta(result, 'to')}</small>
          </div>
          {editableTo ? (
            <div className="compare-doc compare-doc-to live-editor-slot" aria-label="To document live editor" />
          ) : (
            <article className="compare-doc compare-doc-to" aria-label="To document" data-editable-seam="readonly-version">
              {renderRows('to')}
            </article>
          )}
        </div>
      </div>

      <div className="compare-legend">
        <span className="compare-legend-strong">Colour = author:</span>
        <span><i className="dot writer" /> you</span>
        <span><i className="dot agent" /> agent</span>
        <span><i className="dot reviewer" /> reviewer</span>
        <span className="compare-legend-note">highlighted = added (To) · struck = removed (From)</span>
      </div>
    </section>
  )
}
