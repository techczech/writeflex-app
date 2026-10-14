/**
 * An exported file keeps only the links its reader can follow (scout-search-panel ticket 02).
 *
 * A citation inserted from the archive panel, or pasted from Highlight Scout, carries
 * `· [archive](writeflex://open?path=…)` — a link into the writer's own folder. It is right in the
 * editor, where it opens the piece at its line, and meaningless in a file someone else opens. So an
 * EXPORT rewrites the document model (never the file on disk) before an emitter sees it:
 *
 * - A link to the web (`http`, `https`) or to a person (`mailto`, `tel`) stays a link.
 * - A link the url-safety allowlist refuses (`writeflex:`, `file:`, `zotero:` or anything else)
 *   becomes its own words as plain text — the writer's words are never silently deleted.
 * - Except the citation tail: a LOCAL link that stands alone as one ` · ` part of a line (the
 *   `· [archive](…)` of a citation) is dropped together with its separator, because "· archive" as
 *   plain text is a dangling word pointing nowhere. `…, 2016 · [archive](…) · [public](https://…)`
 *   exports as `…, 2016 · public`, with "public" still a link.
 *
 * Relative and `#fragment` destinations are not schemes, so this module leaves them as they are.
 */
import { safeUrl } from './url-safety'
import type { Block, Footnote, Inline, MarkdownDocument } from './model'

/** Schemes that name something on this Mac only. A refused link with one of these may be dropped as
 *  a citation part; any other refused link keeps its words. */
const LOCAL_SCHEMES = new Set(['writeflex', 'file', 'zotero'])
const SCHEME = /^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/

/** True when an export must not carry this destination as a link. */
export function isExportRefusedLink(href: string): boolean {
  return safeUrl(href, 'link') === null
}

/** True for a destination that only means something on the writer's own machine. */
export function isLocalOnlyLink(href: string): boolean {
  const scheme = SCHEME.exec(href.replace(/[\u0000-\u001f\u007f]/g, ''))
  return scheme !== null && LOCAL_SCHEMES.has(scheme[1].toLowerCase())
}

const SEPARATOR_BEFORE = /\s*·\s*$/
const SEPARATOR_AFTER = /^\s*·\s*/
const ENDS_WITH_SEPARATOR = /\s·\s*$/
const STARTS_WITH_SEPARATOR = /^\s*·\s/

function endsPart(part: Inline | undefined): boolean {
  return part === undefined || part.kind === 'break' || (part.kind === 'text' && part.text.trim() === '')
}

/** A local link that is the whole of one ` · ` part: a separator on at least one side, and on the
 *  other side either another separator or the edge of the line. `previous` is the part before the
 *  link as already rewritten (the last part written so far), `next` the part after it as read. */
function standsAlone(previous: Inline | undefined, next: Inline | undefined): 'before' | 'after' | null {
  const separatorBefore = previous?.kind === 'text' && ENDS_WITH_SEPARATOR.test(previous.text)
  const separatorAfter = next?.kind === 'text' && STARTS_WITH_SEPARATOR.test(next.text)
  if (separatorBefore && (separatorAfter || endsPart(next))) return 'before'
  if (separatorAfter && endsPart(previous)) return 'after'
  return null
}

/**
 * One pass, linear in the number of parts (nested parts included): each part is read once from
 * `parts` and appended to `out`. Nothing is inserted into or deleted from the middle of an array,
 * and no array is copied per link, so a paragraph of N refused links costs N steps, not N x N.
 *
 * What a refused link sees as its neighbours is fixed by that order:
 * - before it, the LAST PART WRITTEN: a text part whose separator an earlier link already took, the
 *   last word of an earlier link that became its words, or a part carried over as it was;
 * - after it, the next part AS READ, never yet rewritten.
 * Empty text parts stay in `out` until the end, because an empty part beside a link counts as the
 * edge of the line; they are dropped once, after the pass.
 */
function inlines(parts: Inline[]): Inline[] {
  const out: Inline[] = []
  /** The next part with its leading separator taken by the link before it; it replaces that part as read. */
  let trimmedNext: Inline | null = null
  for (let index = 0; index < parts.length; index++) {
    const part: Inline = trimmedNext ?? { ...parts[index] }
    trimmedNext = null
    if (part.kind === 'emphasis' || part.kind === 'strong' || part.kind === 'strike' || part.kind === 'mark') {
      out.push({ ...part, children: inlines(part.children) })
      continue
    }
    if (part.kind !== 'link' || !isExportRefusedLink(part.href)) {
      out.push(part.kind === 'link' ? { ...part, children: inlines(part.children) } : part)
      continue
    }
    const next: Inline | undefined = parts[index + 1]
    const alone = isLocalOnlyLink(part.href) ? standsAlone(out[out.length - 1], next) : null
    if (alone === 'before') {
      const previous = out[out.length - 1] as Extract<Inline, { kind: 'text' }>
      out[out.length - 1] = { kind: 'text', text: previous.text.replace(SEPARATOR_BEFORE, '') }
    } else if (alone === 'after') {
      trimmedNext = { kind: 'text', text: (next as Extract<Inline, { kind: 'text' }>).text.replace(SEPARATOR_AFTER, '') }
    } else {
      // one at a time: out.push(...words) passes one argument per part of the link's text
      for (const word of inlines(part.children)) out.push(word)
    }
  }
  return out.filter((part) => part.kind !== 'text' || part.text !== '')
}

function block(entry: Block): Block {
  switch (entry.kind) {
    case 'heading': case 'paragraph': return { ...entry, children: inlines(entry.children) }
    case 'quote': return { ...entry, children: entry.children.map(block) }
    case 'list': return { ...entry, items: entry.items.map((item) => ({ ...item, children: item.children.map(block) })) }
    case 'table': return {
      ...entry,
      header: entry.header.map(inlines),
      rows: entry.rows.map((row) => row.map(inlines)),
    }
    default: return entry
  }
}

function footnote(note: Footnote): Footnote {
  return { ...note, children: note.children.map(block) }
}

/** The document an export emits: the same model with every link a reader cannot follow turned into
 *  its words (or, as a citation part, dropped with its separator). Pure; the input is not changed. */
export function externalLinksOnly(document: MarkdownDocument): MarkdownDocument {
  return { blocks: document.blocks.map(block), footnotes: document.footnotes.map(footnote) }
}
