/**
 * What Cite, Insert link and Insert quote with citation write (ticket 03, spec §5). The formatting is
 * the app's existing citation syntax — the same chip, quote block and archive link the Folio room's
 * "Insert citation" writes (`src/renderer/src/editor/citation.ts`, `archive-insert.ts`) — kept pure
 * here so main prepares the exact Markdown and the renderer only ever inserts what main prepared.
 * File and note links are written relative to the DESTINATION part, as the room writes them.
 */
import type { ScratchReferenceAction, ScratchSourceRef } from './scratchpad-items'

const safeLabel = (label: string): string => label.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
const safeUrl = (url: string): string => (/[()\s]/.test(url) ? `<${url}>` : url)

/** The chip alone: `⟨Lea and Street 1998⟩` as an ordinary link. */
export function referenceChip(label: string, link: string): string {
  const who = label.replace(/^⟨|⟩$/g, '').trim() || 'Reference'
  return `[${safeLabel(`⟨${who}⟩`)}](${safeUrl(link)})`
}

/** The Folio room's relative link: from the destination part's folder to the source file. */
export function relativeLinkTo(destinationPath: string, sourcePath: string): string {
  const from = destinationPath.split('/').slice(0, -1)
  const to = sourcePath.split('/')
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift() }
  return [...from.map(() => '..'), ...to].join('/')
}

/** The citation target as it should be written into `destinationPath`. */
export function citationTargetFor(ref: Pick<ScratchSourceRef, 'evidenceKind' | 'target' | 'sourcePath' | 'highlightTarget'>, destinationPath: string, forHighlight = false): string {
  if (forHighlight && ref.highlightTarget) return ref.highlightTarget
  if ((ref.evidenceKind === 'file' || ref.evidenceKind === 'note') && ref.sourcePath) return relativeLinkTo(destinationPath, ref.sourcePath)
  return ref.target
}

/** A quote and its chip, as the room writes it. The quoted words are ordinary Markdown. */
export function quoteWithCitation(quote: string, label: string, link: string): string {
  const text = quote.replace(/\s+/g, ' ').trim()
  const chip = referenceChip(label, link)
  if (!text) return chip
  const quoted = `“${text}”`.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n')
  return `${quoted}\n>\n> ${chip}`
}

/** The archive piece's ordinary link (the room's `archiveLinkMarkdown`). */
export function archiveReferenceLink(title: string, target: string): string {
  return `[${safeLabel(title.trim() || 'Archive piece')}](${safeUrl(target)})`
}

export type PreparedReferenceMarkdown = { markdown: string; style: 'inline' | 'block'; label: string }

/**
 * The exact Markdown one act writes into `destinationPath`, from a canonical source as it stands.
 * - cite: the citation chip (inline). Archive pieces have no chip in WriteFlex — their canonical
 *   insertion is the archive link, which is the Link act, so Cite refuses rather than rename a link.
 * - link: an ordinary link or wikilink; no content, no chip.
 * - quote: the quoted words as a blockquote with the chip; the citation points at the highlight
 *   when the evidence item names one.
 */
export function referenceMarkdown(ref: ScratchSourceRef, action: Exclude<ScratchReferenceAction, 'attach'>, destinationPath: string): PreparedReferenceMarkdown {
  const label = ref.label.replace(/^⟨|⟩$/g, '').trim() || ref.sourceTitle || 'Reference'
  if (action === 'quote') {
    const quote = ref.quote?.trim()
    if (!quote) throw new Error('This evidence has no quoted words to insert. Cite it, link to it, or attach it instead.')
    const link = citationTargetFor(ref, destinationPath, true)
    const chipLabel = ref.highlightLabel?.replace(/^⟨|⟩$/g, '').trim() || label
    return { markdown: quoteWithCitation(quote, chipLabel, link), style: 'block', label }
  }
  if (action === 'cite') {
    if (ref.evidenceKind === 'archive') throw new Error('An archive piece is linked, not cited with a chip. Use Insert link.')
    return { markdown: referenceChip(label, citationTargetFor(ref, destinationPath)), style: 'inline', label }
  }
  if (ref.evidenceKind === 'archive') return { markdown: archiveReferenceLink(ref.sourceTitle ?? label, ref.target), style: 'inline', label }
  if (ref.evidenceKind === 'note') return { markdown: `[[${ref.target}]]`, style: 'inline', label }
  const text = ref.sourceTitle?.trim() || label
  return { markdown: `[${safeLabel(text)}](${safeUrl(citationTargetFor(ref, destinationPath))})`, style: 'inline', label }
}

/** Whether the act is offered on a source at all (before its live state is considered). */
export function referenceActionOffered(ref: Pick<ScratchSourceRef, 'evidenceKind' | 'quote'>, kind: 'ref' | 'evidence', action: ScratchReferenceAction): boolean {
  if (action === 'quote') return kind === 'evidence' && typeof ref.quote === 'string' && ref.quote.trim() !== ''
  if (action === 'cite') return ref.evidenceKind !== 'archive'
  return true
}
