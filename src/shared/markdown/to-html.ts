/**
 * The HTML emitter (Round B T2) — one of three renderings of the shared document model.
 *
 * Two customers, one function. The clipboard wants a FRAGMENT it can hand to Word, Teams, Outlook
 * and Substack; the file export wants a STANDALONE document that works from a Downloads folder.
 * Both obey the fidelity contract proven in the Outlook work (`microsoft-graph-comms`): explicit
 * paragraph elements, styling stated on the element rather than inherited, real `<a href>`, every
 * character escaped, and tables with borders written on the cells — a receiving application will
 * strip a stylesheet long before it strips an attribute.
 */
import { exportedWidget } from '../widget-export'
import { readDocument, type Block, type Footnote, type Inline, type MarkdownDocument } from './model'
import { safeUrl } from './url-safety'
import { externalLinksOnly } from './external-links'
import { HTML_LIST_TYPE } from './fancy-lists'
import { isSvgFence, sanitiseSvg } from '../sanitise-svg'
import {
  assembleDocument,
  TABLE_REGION_OPEN,
  escapeHtml,
  INLINE_STYLE as STYLE,
  type HtmlDocumentDesign,
  type HtmlDocumentData,
  type HtmlOutlineHeading,
  type ReaderNotesDocument,
  type ReaderEditsDocument,
} from './html-document'

/** What becomes of `[[target]]`. `'text'` is the law: the label survives, the link disappears. The
 *  resolver form is the Collection bundle's ONE exception (Task 7): it returns the id of a section
 *  inside the same file, or null for a target that is not in the bundle — which falls back to text,
 *  so a wikilink never becomes a dead anchor. */
export type WikilinkPolicy = 'text' | { resolve: (target: string) => string | null }

/** What becomes of `![alt](src)`.
 *  - `'keep'` — emit the src as the writer wrote it (what a clipboard paste wants: the receiving
 *    application resolves or drops it, and a copy is not responsible for hosting).
 *  - `'omit'` — drop the image and keep its alt text.
 *  - `{ resolve }` — the caller turns a src into something self-contained (a `data:` URI) or returns
 *    null for a file it could not read; a null is recorded in `missingImages` and the alt text is
 *    kept, so an export completes and reports rather than silently dropping (the PRD's states table).
 *  Only the resolver form can read the disk: this module is pure, so `data:` URIs are built by the
 *  caller in the main process, not here. */
export type ImagePolicy = 'keep' | 'omit' | { resolve: (src: string) => string | null; /** App preview only: a per-window wf-asset origin, never taken from Markdown. */ workspaceAssetBase?: string }

/** What becomes of a ```svg fence's drawn form. THE ONE PLACE THE TWO HTML CUSTOMERS DIVERGE.
 *  - `'inline'` (the default) — the sanitised `<svg>` itself, which is right for an exported FILE:
 *    a browser opens it and draws it crisply at any zoom.
 *  - `{ resolve }` — the caller turns the fence source into a picture URL (a rasterised PNG data
 *    URI), which is what the CLIPBOARD needs: Word, Teams and Outlook DISCARD an inline `<svg>`
 *    when they import HTML, so an inlined drawing disappears on paste. A resolver that returns
 *    null falls back to the fence's own source as code, never to an inline `<svg>`. */
export type SvgFencePolicy = 'inline' | { resolve: (source: string) => string | null }

/** `{ withheld }`: every widget line becomes that one fixed sentence, naming no path (a shared copy). */
export type WidgetHtmlPolicy = 'text' | { withheld: string } | { resolve: (path: string) => string | null }

export type HtmlOptions = {
  /** Main supplies verified local HTML. Clipboard keeps embed text by default. */
  widgets?: WidgetHtmlPolicy
  /** Bundle-only: map a local Markdown link to its in-file section, or omit its href. */
  linkTarget?: (href: string) => string | null
  /** Default `'text'`. */
  wikilinks?: WikilinkPolicy
  /** `'external-only'` is what an EXPORT asks for (external-links.ts): links a reader cannot follow
   *  (`writeflex://`, `file://`) become their words, and a local citation part such as
   *  `· [archive](…)` is dropped with its separator. Default `'as-written'`, which a copy uses. */
  links?: 'as-written' | 'external-only'
  /** Default `'keep'`. */
  images?: ImagePolicy
  /** Default `'inline'`. */
  svgFences?: SvgFencePolicy
  /** `true` wraps the output in a complete document with its styles inlined; `false` (the default)
   *  emits a fragment, which is what the clipboard wants. */
  standalone?: boolean
  /** Namespaces every generated id (headings, footnotes) so several documents can be concatenated
   *  into one file without their anchors colliding — what the Collection bundle needs. Setting it
   *  also turns heading ids on for a fragment. */
  idPrefix?: string
  /** Standalone only: the `<title>` and nothing else. */
  title?: string
  /** Heading levels are shifted by this much, clamped to h1–h6 — the bundle demotes each piece's
   *  headings so the section titles it generates can sit above them. */
  headingOffset?: number
  /** Emit deterministic heading anchors on fragments that do not already receive them from
   *  `standalone` or `idPrefix`. Default `false`. */
  stableHeadingIds?: boolean
  /** Emit deterministic block ids derived from the current section anchor and block order.
   *  Default `false`. */
  stableBlockIds?: boolean
  /** Structured export-safe data carried to the standalone document assembly seam. */
  documentData?: HtmlDocumentData
  /** Standalone document chrome. The contents sidebar defaults on. */
  sidebar?: boolean
  /** Heading levels the contents lists, 1-6; absent keeps the default four. */
  tocDepth?: number
  /** Standalone document treatment. Defaults to the light rail. */
  design?: HtmlDocumentDesign
  /** Standalone title, standfirst and selected metadata. Defaults on. */
  titleBlock?: boolean
  /** Standalone word count, modified date and Collection status tiles. Defaults off. */
  summaryTiles?: boolean
  /** Standalone cover screen before the document. Defaults off. */
  frontPage?: boolean
  /** Standalone annotation runtime configuration; target ids are collected while rendering. */
  readerNotes?: Omit<ReaderNotesDocument, 'targets'>
  /** Standalone edit-diff runtime configuration; target ids are collected while rendering. */
  readerEdits?: Omit<ReaderEditsDocument, 'targets'>
  /** `true` wraps each table in `<div class="wf-table-region table-scroll">`, which the exported HTML FILE's table
   *  styles and script hang on. Only the file export asks for it: a copy keeps the bare table, whose
   *  own markup is the same either way. Default `false`. */
  tableRegions?: boolean
}

export type HtmlResult = {
  html: string
  /** How many footnotes were rendered at the end. */
  footnotes: number
  /** Image sources the resolver could not resolve, in document order, for the completion message. */
  missingImages: string[]
  /** Stable ids emitted for reader interaction targets, in document order. */
  interactionTargets: string[]
}

const ALIGN: Record<string, string> = { left: 'text-align:left;', centre: 'text-align:center;', right: 'text-align:right;' }

export { escapeHtml } from './html-document'

/** Escape text for a double-quoted attribute value. */
function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;')
}

/** A destination is judged by the ONE shared rule (url-safety.ts) — allowlisted schemes, and the
 *  tab/CR/LF a browser strips before it parses one removed first — then escaped as an attribute.
 *  Null means the destination may not be written at all. */
function attributeUrl(url: string, use: 'link' | 'image'): string | null {
  const safe = safeUrl(url, use)
  return safe === null ? null : escapeAttribute(safe)
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section'
}

type Emitter = {
  options: Required<Pick<HtmlOptions, 'linkTarget' | 'widgets' | 'wikilinks' | 'images' | 'svgFences' | 'standalone' | 'idPrefix' | 'headingOffset' | 'stableHeadingIds' | 'stableBlockIds' | 'tableRegions'>>
  missingImages: string[]
  usedIds: Set<string>
  currentSectionAnchor: string
  blockOrder: number
  interactionTargets: string[]
}

/** The plain text of an inline run — used for heading ids and image alt fallbacks. */
function plainOf(parts: Inline[]): string {
  return parts.map((part) => {
    switch (part.kind) {
      case 'text': case 'code': case 'html': return part.text
      case 'wikilink': return part.label
      case 'break': return ' '
      case 'image': return part.alt
      case 'footnote': return ''
      default: return plainOf(part.children)
    }
  }).join('')
}

const KBD_OPEN = /^<kbd>$/i
const KBD_CLOSE = /^<\/kbd>$/i

/** `<kbd>…</kbd>` is the one raw-HTML construct that is emitted as an element (a key cap). Only the
 *  bare, attribute-free tag pair qualifies, and only when the closer is in the same inline run;
 *  anything else stays shown-not-run text. The element and its style are ours, not the writer's. */
function inlines(parts: Inline[], emitter: Emitter): string {
  let out = ''
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part.kind === 'html' && KBD_OPEN.test(part.text)) {
      let close = -1
      for (let next = index + 1; next < parts.length; next++) {
        const candidate = parts[next]
        if (candidate.kind !== 'html') continue
        if (KBD_CLOSE.test(candidate.text)) close = next
        if (close >= 0 || KBD_OPEN.test(candidate.text)) break
      }
      if (close > 0) {
        out += `<kbd style="${STYLE.kbd}">${inlines(parts.slice(index + 1, close), emitter)}</kbd>`
        index = close
        continue
      }
    }
    out += inline(part, emitter)
  }
  return out
}

function inline(part: Inline, emitter: Emitter): string {
  switch (part.kind) {
    case 'text': return escapeHtml(part.text)
    case 'emphasis': return `<em>${inlines(part.children, emitter)}</em>`
    case 'strong': return `<strong>${inlines(part.children, emitter)}</strong>`
    case 'strike': return `<s>${inlines(part.children, emitter)}</s>`
    case 'mark': return `<mark style="${STYLE.mark}">${inlines(part.children, emitter)}</mark>`
    case 'code': return `<code style="${STYLE.code}">${escapeHtml(part.text)}</code>`
    case 'break': return '<br />'
    // Raw HTML the writer typed is SHOWN, not run: a copy must not smuggle markup into someone
    // else's document, and an exported file is opened by other people.
    case 'html': return escapeHtml(part.text)
    case 'link': {
      const target = emitter.options.linkTarget(part.href)
      const href = target === null ? null : attributeUrl(target, 'link')
      const body = inlines(part.children, emitter)
      if (href === null) return body
      const title = part.title ? ` title="${escapeAttribute(part.title)}"` : ''
      return `<a href="${href}"${title}>${body}</a>`
    }
    case 'image': return image(part, emitter)
    case 'wikilink': {
      // The disappearing-wikilink law. A resolver may promote it to an internal anchor (the bundle);
      // anything it declines to resolve degrades to the label text, never to a dead anchor.
      const label = escapeHtml(part.label)
      if (emitter.options.wikilinks === 'text') return label
      const anchor = emitter.options.wikilinks.resolve(part.target)
      return anchor ? `<a href="#${escapeAttribute(anchor)}">${label}</a>` : label
    }
    case 'footnote': {
      const id = `${emitter.options.idPrefix}fn-${part.index}`
      const back = `${emitter.options.idPrefix}fnref-${part.index}-${part.occurrence}`
      return `<sup id="${escapeAttribute(back)}"><a href="#${escapeAttribute(id)}" style="${STYLE.backref}">${part.index}</a></sup>`
    }
  }
}

function image(part: Extract<Inline, { kind: 'image' }>, emitter: Emitter): string {
  const alt = escapeAttribute(part.alt)
  const policy = emitter.options.images
  if (policy === 'omit') return escapeHtml(part.alt)
  const src = policy === 'keep' ? part.src : policy.resolve(part.src)
  if (src === null) {
    emitter.missingImages.push(part.src)
    return escapeHtml(part.alt)
  }
  const base = typeof policy === 'object' ? policy.workspaceAssetBase?.replace(/\/$/, '') : undefined
  const workspaceImage = base && /^wf-asset:\/\/[a-z0-9-]+$/i.test(base) && src.startsWith(`${base}/`) && !/[\u0000-\u0020\u007f\\]/.test(src)
  const safe = workspaceImage ? escapeAttribute(src) : attributeUrl(src, 'image')
  if (safe === null) return escapeHtml(part.alt)
  const title = part.title ? ` title="${escapeAttribute(part.title)}"` : ''
  return `<img src="${safe}" alt="${alt}"${title} style="${STYLE.image}" />`
}

function headingId(text: string, emitter: Emitter): string {
  const base = `${emitter.options.idPrefix}${slug(text)}`
  let id = base
  let counter = 2
  while (emitter.usedIds.has(id)) id = `${base}-${counter++}`
  emitter.usedIds.add(id)
  return id
}

function nextBlockId(emitter: Emitter): string {
  if (!emitter.options.stableBlockIds) return ''
  emitter.blockOrder += 1
  const id = `${emitter.currentSectionAnchor}-block-${emitter.blockOrder}`
  emitter.interactionTargets.push(id)
  return ` id="${escapeAttribute(id)}"`
}

/** Build the export outline from the same shared document model the emitter consumes. */
export function htmlOutline(document: MarkdownDocument, idPrefix = ''): HtmlOutlineHeading[] {
  const used = new Set<string>()
  const visit = (entries: Block[]): HtmlOutlineHeading[] => entries.flatMap((entry) => {
    if (entry.kind === 'heading') {
      const base = `${idPrefix}${slug(plainOf(entry.children))}`
      let anchor = base
      let counter = 2
      while (used.has(anchor)) anchor = `${base}-${counter++}`
      used.add(anchor)
      return [{ level: entry.level, text: plainOf(entry.children), anchor }]
    }
    if (entry.kind === 'quote') return visit(entry.children)
    if (entry.kind === 'list') return entry.items.flatMap((item) => visit(item.children))
    return []
  })
  return visit(document.blocks)
}

function blocks(list: Block[], emitter: Emitter): string[] {
  return list.flatMap((entry) => block(entry, emitter))
}

function block(entry: Block, emitter: Emitter, suppressBlockId = false): string[] {
  switch (entry.kind) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, entry.level + emitter.options.headingOffset))
      const wantsId = emitter.options.standalone || emitter.options.idPrefix !== '' || emitter.options.stableHeadingIds
      const needsAnchor = wantsId || emitter.options.stableBlockIds
      const anchor = needsAnchor ? headingId(plainOf(entry.children), emitter) : ''
      if (needsAnchor) {
        emitter.currentSectionAnchor = anchor
        emitter.blockOrder = 0
      }
      const id = wantsId ? ` id="${escapeAttribute(anchor)}"` : ''
      if (wantsId && emitter.options.stableBlockIds) emitter.interactionTargets.push(anchor)
      return [`<h${level}${id} style="${STYLE.heading}">${inlines(entry.children, emitter)}</h${level}>`]
    }
    case 'paragraph': {
      const body = inlines(entry.children, emitter)
      if (body === '') return []
      const id = suppressBlockId ? '' : nextBlockId(emitter)
      return [`<p${id} style="${STYLE.paragraph}">${body}</p>`]
    }
    case 'quote':
      return [`<blockquote style="${STYLE.quote}">${blocks(entry.children, emitter).join('')}</blockquote>`]
    case 'list': {
      const tag = entry.ordered ? 'ol' : 'ul'
      const start = entry.ordered && entry.start !== 1 ? ` start="${entry.start}"` : ''
      // A lettered or roman list keeps its letters (the locked export frame): `type` for readers that
      // honour the attribute, the matching list-style-type for the ones that only read styles.
      const lettering = entry.lettering
        ? { type: ` type="${HTML_LIST_TYPE[entry.lettering.numbering]}"`, style: `list-style-type:${entry.lettering.numbering};` }
        : { type: '', style: '' }
      const items = entry.items.map((item) => {
        // Task boxes are Unicode, not <input>: a checkbox element is stripped or disabled by most
        // paste targets, while the box character survives into Word, Teams and plain text alike.
        const box = item.task === null ? '' : item.task === 'done' ? '☑ ' : '☐ '
        const id = nextBlockId(emitter)
        const rendered = item.children.flatMap((child, index) => block(
          child,
          emitter,
          index === 0 && child.kind === 'paragraph',
        ))
        const [first, ...rest] = rendered
        const opened = first === undefined
          ? box
          : first.startsWith('<p ')
            // A single-paragraph item stays flat: `<li>text</li>`, not `<li><p>text</p></li>`, which
            // is what a paste target renders with the least invention of its own.
            ? box + first.replace(/^<p [^>]*>/, '').replace(/<\/p>$/, '')
            : box + first
        // A box stands in for the bullet (the locked export frame, docs/design/2026-09-27-checkbox-
        // lists): an unordered task item drops its dot, a numbered one keeps its number.
        const style = item.task !== null && !entry.ordered ? STYLE.taskItem : STYLE.item
        return `<li${id} style="${style}">${opened}${rest.join('')}</li>`
      }).join('')
      return [`<${tag}${lettering.type}${start} style="${STYLE.list}${lettering.style}">${items}</${tag}>`]
    }
    case 'code': {
      // A ```svg fence is one of the app's object types and the editor DRAWS it, so an export and a
      // copy draw it too — through the app's own sanitiser (shared/sanitise-svg), never a second
      // one. A fence the sanitiser refuses falls back to code, which is what makes a removal a
      // visible failure rather than a hole. ```mermaid and ```markmap stay code by design.
      //
      // The one deliberate divergence between this module's two customers: the exported FILE
      // inlines the SVG, the CLIPBOARD hands over a rasterised PNG through the resolver, because
      // Word and Teams throw an inline <svg> away when they import HTML. Do not "unify" these —
      // the paired tests in tests/main/svg-fence.test.ts name why.
      if (isSvgFence(entry.language)) {
        const fences = emitter.options.svgFences
        if (fences === 'inline') {
          const drawn = sanitiseSvg(entry.text)
          if ('svg' in drawn) return [`<p${nextBlockId(emitter)} style="${STYLE.figure}">${drawn.svg}</p>`]
        } else {
          const src = fences.resolve(entry.text)
          const safe = src === null ? null : attributeUrl(src, 'image')
          if (safe !== null) return [`<p${nextBlockId(emitter)} style="${STYLE.figure}"><img src="${safe}" alt="" style="${STYLE.image}" /></p>`]
        }
      }
      const language = entry.language ? ` class="language-${escapeAttribute(entry.language)}"` : ''
      // Every other fence body is escaped, never interpreted: a code fence containing HTML must
      // READ as that HTML, not run as it.
      return [`<pre${nextBlockId(emitter)} style="${STYLE.pre}"><code${language} style="${STYLE.codeInPre}">${escapeHtml(entry.text)}</code></pre>`]
    }
    case 'rule': return [`<hr${nextBlockId(emitter)} style="${STYLE.rule}" />`]
    case 'widget': {
      if (emitter.options.widgets === 'text') return [`<p${nextBlockId(emitter)} style="${STYLE.paragraph}">${escapeHtml(entry.source)}</p>`]
      if ('withheld' in emitter.options.widgets) return [`<p${nextBlockId(emitter)} role="note" style="${STYLE.paragraph}">${escapeHtml(emitter.options.widgets.withheld)}</p>`]
      const page = entry.refusal ? null : emitter.options.widgets.resolve(entry.path)
      return [page === null ? '<p role="note">Interactive widget unavailable: the local HTML file could not be included.</p>' : exportedWidget(page)]
    }
    case 'html': return [`<p${nextBlockId(emitter)} style="${STYLE.paragraph}"><code style="${STYLE.code}">${escapeHtml(entry.text)}</code></p>`]
    case 'table': {
      const cell = (content: Inline[], index: number, header: boolean): string => {
        const align = ALIGN[entry.alignments[index] ?? ''] ?? ''
        const tag = header ? 'th' : 'td'
        return `<${tag} style="${header ? STYLE.headerCell : STYLE.cell}${align}">${inlines(content, emitter)}</${tag}>`
      }
      const head = entry.header.length
        ? `<thead><tr>${entry.header.map((content, index) => cell(content, index, true)).join('')}</tr></thead>`
        : ''
      const body = entry.rows.length
        ? `<tbody>${entry.rows.map((row) => `<tr>${row.map((content, index) => cell(content, index, false)).join('')}</tr>`).join('')}</tbody>`
        : ''
      // border/cellspacing attributes as well as the styles: Word and Outlook honour the attributes
      // when they discard the CSS.
      const table = `<table${nextBlockId(emitter)} border="1" cellspacing="0" cellpadding="6" style="${STYLE.table}">${head}${body}</table>`
      return [emitter.options.tableRegions ? `${TABLE_REGION_OPEN}>${table}</div>` : table]
    }
  }
}

function footnoteList(footnotes: Footnote[], emitter: Emitter): string {
  if (!footnotes.length) return ''
  const items = footnotes.map((note) => {
    const id = `${emitter.options.idPrefix}fn-${note.index}`
    const content = note.children.flatMap((child, index) => block(
      child,
      emitter,
      index === 0 && child.kind === 'paragraph',
    ))
    const first = content[0] ?? ''
    const body = first.startsWith('<p ') ? first.replace(/^<p [^>]*>/, '').replace(/<\/p>$/, '') : first
    const backs = Array.from({ length: note.occurrences }, (_unused, occurrence) =>
      `<a href="#${escapeAttribute(`${emitter.options.idPrefix}fnref-${note.index}-${occurrence + 1}`)}" style="${STYLE.backref}">&#8617;</a>`).join(' ')
    return `<li id="${escapeAttribute(id)}" style="${STYLE.item}">${body} ${backs}${content.slice(1).join('')}</li>`
  }).join('')
  return `<section style="${STYLE.footnotes}"><ol style="${STYLE.list}">${items}</ol></section>`
}

/**
 * Render Markdown as HTML. Frontmatter and comments are gone before the parse (model.ts), so they
 * cannot reach the output by any path.
 */
export function toHtml(markdown: string, options: HtmlOptions = {}): HtmlResult {
  const idPrefix = options.idPrefix ?? ''
  const rootSectionAnchor = `${idPrefix}document`
  const emitter: Emitter = {
    options: {
      widgets: options.widgets ?? 'text',
      linkTarget: options.linkTarget ?? ((href) => href),
      wikilinks: options.wikilinks ?? 'text',
      images: options.images ?? 'keep',
      svgFences: options.svgFences ?? 'inline',
      standalone: options.standalone ?? false,
      idPrefix,
      headingOffset: options.headingOffset ?? 0,
      stableHeadingIds: (options.readerNotes || options.readerEdits) ? true : options.stableHeadingIds ?? false,
      stableBlockIds: (options.readerNotes || options.readerEdits) ? true : options.stableBlockIds ?? false,
      tableRegions: options.tableRegions ?? false,
    },
    missingImages: [],
    usedIds: new Set((options.readerNotes || options.readerEdits || options.stableBlockIds) ? [rootSectionAnchor] : []),
    currentSectionAnchor: rootSectionAnchor,
    blockOrder: 0,
    interactionTargets: [],
  }
  const read = readDocument(markdown)
  const document = options.links === 'external-only' ? externalLinksOnly(read) : read
  const body = blocks(document.blocks, emitter).join('\n') + (document.footnotes.length ? '\n' : '')
  const html = body + footnoteList(document.footnotes, emitter)
  if (!emitter.options.standalone) {
    return { html, footnotes: document.footnotes.length, missingImages: emitter.missingImages, interactionTargets: emitter.interactionTargets }
  }
  const firstHeading = document.blocks.find(
    (entry): entry is Extract<Block, { kind: 'heading' }> => entry.kind === 'heading',
  )
  const title = options.title ?? (plainOf(firstHeading?.children ?? []) || 'Document')
  return {
    html: assembleDocument({
      title,
      body: html,
      ...(options.documentData ? { documents: [options.documentData] } : {}),
      sidebar: options.sidebar,
      tocDepth: options.tocDepth,
      design: options.design,
      titleBlock: options.titleBlock,
      summaryTiles: options.summaryTiles,
      frontPage: options.frontPage,
      ...(options.readerNotes ? { readerNotes: { ...options.readerNotes, targets: emitter.interactionTargets } } : {}),
      ...(options.readerEdits ? { readerEdits: { ...options.readerEdits, targets: emitter.interactionTargets } } : {}),
    }),
    footnotes: document.footnotes.length,
    missingImages: emitter.missingImages,
    interactionTargets: emitter.interactionTargets,
  }
}
