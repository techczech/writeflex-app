/** Positional inventory over the app's Markdown tree. Never scans raw prose for objects. */
import type { SyntaxNode } from '@lezer/common'
import { parseMarkdown } from './markdown/dialect'
import { embedLine } from './markdown/embed-line'
import { isSvgFence } from './sanitise-svg'
import { evidenceKey, type EvidenceKind } from './folio-evidence'
import { fragmentTitle, type ScratchItem, type ScratchAssetKind, type ScratchRemovedSpan } from './scratchpad-items'

export type { ScratchRemovedSpan }

/** Spans must be sorted, non-overlapping in-range raw ranges; anything else is not a projection. */
export function validRemovedSpans(spans: readonly ScratchRemovedSpan[] | undefined, rawLength: number): boolean {
  if (!spans) return true
  let end = 0
  for (const span of spans) {
    if (!Number.isInteger(span.from) || !Number.isInteger(span.to) || span.from < end || span.to < span.from || span.to > rawLength) return false
    end = span.to
  }
  return true
}

/** The writing content of a raw buffer: the raw bytes with every excluded span removed.
 *  Assumes `removedSpans` is valid (see `validRemovedSpans`); callers validate first. */
export function projectedWritingContent(raw: string, removedSpans?: readonly ScratchRemovedSpan[]): string {
  if (!removedSpans?.length) return raw
  let clean = ''
  let kept = 0
  for (const span of removedSpans) { clean += raw.slice(kept, span.from); kept = span.to }
  return clean + raw.slice(kept)
}

/**
 * Inventory over a raw editor buffer plus the spans its writing content excludes (pending
 * old-role text in Reviewing). The parser runs on the writing content, so a pending-deleted
 * asset is not current and payloads are the exact writing bytes; every reported position is
 * mapped back through the owned spans to the raw range and visible line the writer sees.
 * Objects are never located by searching for matching Markdown.
 */
export function documentAssetsProjected(path: string, raw: string, basis: 'live' | 'disk', removedSpans?: readonly ScratchRemovedSpan[]): ScratchItem[] {
  if (!removedSpans?.length) return documentAssets(path, raw, basis)
  if (!validRemovedSpans(removedSpans, raw.length)) throw new Error('The live document projection is inconsistent, so its inventory is unavailable.')
  const rawAt: number[] = []
  let clean = ''
  let kept = 0
  for (const span of removedSpans) {
    for (let at = kept; at < span.from; at++) rawAt.push(at)
    clean += raw.slice(kept, span.from)
    kept = span.to
  }
  for (let at = kept; at < raw.length; at++) rawAt.push(at)
  clean += raw.slice(kept)
  const rawRange = (range: { from: number; to: number }): { from: number; to: number; line: number } => {
    const from = rawAt[range.from]
    const to = range.to > range.from ? rawAt[range.to - 1] + 1 : from
    return { from, to, line: raw.slice(0, from).split(/\r\n|\n|\r/).length }
  }
  return documentAssets(path, clean, basis).map(item => {
    const { from, to, line } = rawRange(item.document!)
    return {
      ...item,
      // A cited reference is identified by its canonical citation id, not by its first position.
      id: item.kind === 'ref' ? item.id : `document:${path}:${from}:${item.kind}`,
      document: { from, to, line, basis },
      ...(item.cited ? { cited: { count: item.cited.count, positions: item.cited.positions.map(position => ({ ...rawRange(position), markdown: position.markdown })) } } : {}),
    }
  })
}

export function documentAssets(path: string, source: string, basis: 'live' | 'disk'): ScratchItem[] {
  const items: ScratchItem[] = []
  // The parser expects LF. Keep a coordinate map so payloads and navigation stay in original bytes.
  const offsets: number[] = []
  let parsed = ''
  for (let at = 0; at < source.length; at++) {
    offsets.push(at)
    if (source[at] === '\r') { parsed += '\n'; if (source[at + 1] === '\n') at++ }
    else parsed += source[at]
  }
  offsets.push(source.length)
  const slice = (from: number, to: number): string => source.slice(offsets[from], offsets[to])
  const tree = parseMarkdown(parsed)
  let heading: string | null = null
  type CitationHit = { citationId: string; evidenceKind: EvidenceKind; target: string; label: string; sourcePath: string | null; from: number; to: number; line: number; markdown: string; heading: string | null }
  const citations: CitationHit[] = []
  function add(node: SyntaxNode, kind: ScratchAssetKind, title?: string): void {
    const markdown = slice(node.from, node.to)
    const from = offsets[node.from], to = offsets[node.to]
    items.push({ id: `document:${path}:${from}:${kind}`, source: 'document', kind, how: 'copy', by: 'writer',
      createdAt: null, origin: { path, heading }, title: title || fragmentTitle(markdown), markdown,
      group: null, status: 'active', done: false, uses: [],
      document: { from, to, line: source.slice(0, from).split(/\r\n|\n|\r/).length, basis } })
  }
  function tryCitation(node: SyntaxNode): void {
    // A citation is the app's chip: a link whose label is ⟨…⟩. Its identity is the canonical
    // evidence key of its target (a file target resolved against this document's folder, as
    // the evidence surfaces resolve it), never its wording.
    const markdown = slice(node.from, node.to)
    const match = /^\[((?:\\.|[^\]\\])*)\]\((<[^>\r\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)$/.exec(markdown)
    const label = match?.[1].replace(/\\([\\[\]])/g, '$1') ?? ''
    if (!(match && label.startsWith('⟨') && label.endsWith('⟩'))) return
    const target = match[2].replace(/^<|>$/g, '')
    const evidenceKind: EvidenceKind = target.startsWith('zotero://') ? 'zotero' : /^(?:https?:|file:|writeflex:)/i.test(target) ? 'archive' : 'file'
    let sourcePath: string | null = null
    let citationId: string
    if (evidenceKind === 'file') {
      let decoded = target
      try { decoded = decodeURIComponent(target) } catch { /* a literal percent stays literal */ }
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      const parts: string[] = []
      let escaped = false
      for (const part of `${dir ? `${dir}/` : ''}${decoded.split(/[?#]/)[0]}`.split('/')) {
        if (!part || part === '.') continue
        if (part === '..') { if (parts.length) parts.pop(); else escaped = true }
        else parts.push(part)
      }
      sourcePath = escaped ? null : parts.join('/')
      citationId = sourcePath ? `path:${sourcePath}` : evidenceKey(target)
    } else citationId = evidenceKey(target, evidenceKind)
    const from = offsets[node.from], to = offsets[node.to]
    citations.push({ citationId, evidenceKind, target, label: label.slice(1, -1), sourcePath, from, to, line: source.slice(0, from).split(/\r\n|\n|\r/).length, markdown, heading })
  }
  // Secondary scan of a table's cells: citation chips only. The table stays the one complete
  // asset (its captured bytes are unchanged); chips inside it still count as cited references.
  // Code subtrees are skipped, as in the main walk, so a chip typed as code never counts.
  function collectTableCitations(parent: SyntaxNode): void {
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'CommentBlock', 'Frontmatter'].includes(node.name)) continue
      if (node.name === 'Link') { tryCitation(node); continue }
      collectTableCitations(node)
    }
  }
  function walk(parent: SyntaxNode): void {
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (/^(?:ATX|Setext)Heading/.test(node.name)) heading = fragmentTitle(slice(node.from, node.to))
      if (node.name === 'FencedCode') {
        const info = node.getChild('CodeInfo')
        if (info && isSvgFence(slice(info.from, info.to)) && node.getChildren('CodeMark').length === 2) add(node, 'svg', heading ? `SVG · ${heading}` : 'SVG')
        continue
      }
      if (['CodeBlock', 'InlineCode', 'HTMLBlock', 'CommentBlock', 'Frontmatter'].includes(node.name)) continue
      if (node.name === 'Table') { add(node, 'table', heading ? `Table · ${heading}` : 'Table'); collectTableCitations(node); continue }
      if (node.name === 'Image') { add(node, 'pic'); continue }
      if (node.name === 'Link') { tryCitation(node); continue }
      // Widgets have to be a complete top-level paragraph, as the document model requires.
      if (node.name === 'Paragraph' && parent.name === 'Document') {
        const embed = embedLine(slice(node.from, node.to))
        if (embed && !embed.refusal) { add(node, 'widget', embed.path.split('/').pop()); continue }
      }
      walk(node)
    }
  }
  walk(tree.topNode)
  // Cited references: one card per canonical citation id, with every citation's exact range.
  const grouped = new Map<string, CitationHit[]>()
  for (const hit of citations) grouped.set(hit.citationId, [...(grouped.get(hit.citationId) ?? []), hit])
  for (const hits of grouped.values()) {
    const first = hits[0]
    items.push({
      id: `document:${path}:ref:${first.citationId}`, source: 'document', kind: 'ref', how: 'copy', by: 'writer',
      createdAt: null, origin: { path, heading: first.heading }, title: first.label || 'Reference', markdown: first.markdown,
      group: null, status: 'active', done: false, uses: [],
      document: { from: first.from, to: first.to, line: first.line, basis },
      ref: { sourceId: `ref:${first.citationId}`, citationId: first.citationId, evidenceKind: first.evidenceKind, target: first.target, label: first.label, sourcePath: first.sourcePath },
      cited: { count: hits.length, positions: hits.map(hit => ({ from: hit.from, to: hit.to, line: hit.line, markdown: hit.markdown })) },
    })
  }
  items.sort((a, b) => a.document!.from - b.document!.from)
  return items
}

/** Revalidate the exact position AND parser classification; never search for matching content.
 *  `source` is the same coordinate contract as inventory: raw text, optionally with the spans
 *  its writing content excludes. A plain string is a buffer with nothing excluded. */
export function assetStillCurrent(item: ScratchItem, source: string | { raw: string; removedSpans?: readonly ScratchRemovedSpan[] }): boolean {
  if (!item.document) return false
  const { raw, removedSpans } = typeof source === 'string' ? { raw: source, removedSpans: undefined } : source
  if (!validRemovedSpans(removedSpans, raw.length)) return false
  const now = documentAssetsProjected(item.origin.path, raw, item.document.basis, removedSpans)
  // A cited reference is shown at one of its own recorded citation ranges: that exact range, with
  // that citation's exact Markdown, must still be one of the reference's live positions.
  if (item.kind === 'ref' && item.cited) {
    return now.some(candidate => candidate.id === item.id && candidate.cited?.positions.some(position =>
      position.from === item.document!.from && position.to === item.document!.to && position.markdown === item.markdown))
  }
  return now.some(candidate => candidate.kind === item.kind &&
    candidate.document!.from === item.document!.from && candidate.document!.to === item.document!.to && candidate.markdown === item.markdown)
}
