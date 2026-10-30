import { WIDGET_EXPORT_RUNTIME } from '../widget-export'
import documentTemplate from './document.html?raw'
import plainDocumentTemplate from './document-plain.html?raw'
import documentWithoutSidebarTemplate from './document-without-sidebar.html?raw'
import frontPageTemplate from './document-front-page.html?raw'
import frontPageBodyTemplate from './document-front-page-body.html?raw'
import sidebarLinkTemplate from './document-sidebar-link.html?raw'
import bundleSectionTemplate from './document-bundle-section.html?raw'
import plainBundleSectionTemplate from './document-bundle-section-plain.html?raw'
import plainBundleDividerTemplate from './document-bundle-divider-plain.html?raw'
import mastheadATemplate from './document-masthead-a.html?raw'
import mastheadBTemplate from './document-masthead-b.html?raw'
import standfirstTemplate from './document-standfirst.html?raw'
import metadataTemplate from './document-metadata.html?raw'
import chipATemplate from './document-chip-a.html?raw'
import chipBTemplate from './document-chip-b.html?raw'
import summaryTemplate from './document-summary.html?raw'
import summaryOnlyTemplate from './document-summary-only.html?raw'
import summaryCardTemplate from './document-summary-card.html?raw'
import stylesheet from './export-styles.css?raw'
import frontPageStylesheet from './export-front-page.css?raw'
import readerNotesTemplate from './reader-notes.html?raw'
import readerNotesRuntime from './reader-notes-runtime.js?raw'
import readerEditsTemplate from './reader-edits.html?raw'
import readerEditsRuntime from './reader-edits-runtime.js?raw'
import readerBadgeTemplate from './reader-badge.html?raw'
import readerBadgeCommentTemplate from './reader-badge-comment.html?raw'
import readerBadgeEditTemplate from './reader-badge-edit.html?raw'
import readerBadgeRuntime from './reader-badge-runtime.js?raw'
import tableStylesheet from './export-table.css?raw'
import tableRuntimeTemplate from './export-table-runtime.html?raw'
import tableRuntime from './export-table-runtime.js?raw'

export type DocumentParts = {
  title: string
  body?: string
  sections?: readonly HtmlDocumentSection[]
  /** Export-safe source data used to build document chrome without reparsing rendered HTML. */
  documents?: readonly HtmlDocumentData[]
  /**
   * A Folio's contents as the Outline shows it (ADR-0046, folio-heading-flow.ts): one row per chapter, continuing
   * part and heading, in running order, front matter left out. When present the sidebar lists these instead of
   * the documents' own outlines; `tocDepth` cuts at the row's depth (a chapter is depth 1).
   */
  contentsRows?: readonly HtmlContentsRow[]
  /** Contents navigation is present unless explicitly disabled. */
  sidebar?: boolean
  /** How many heading levels the contents lists, 1-6; absent is the default four. The body is unaffected. */
  tocDepth?: number
  /** Locked document treatment. Defaults to the light rail. */
  design?: HtmlDocumentDesign
  /** Title, standfirst and selected frontmatter fields are present unless explicitly disabled. */
  titleBlock?: boolean
  /** Word count, modified date and Collection status tiles. Defaults off. */
  summaryTiles?: boolean
  /** A cover screen filling the first viewport, entered by a click or a scroll. Defaults off. */
  frontPage?: boolean
  /**
   * Front matter (ADR-0046): sections exported before the contents, in the body, and never in the contents
   * sidebar or the summary tiles (`documents` holds the contents only).
   */
  frontMatter?: readonly HtmlDocumentSection[]
  /**
   * The Folio's title page (ADR-0046). With `frontPage` on it is the cover, in place of the generated one: its
   * title, and its body as written beneath. With `frontPage` off it is the first front-matter section.
   */
  cover?: HtmlDocumentCover
  /** A Folio's Details for the generated cover and masthead, used only when there is no title page (a collection has no document data of its own). */
  folioDetails?: HtmlFolioHeaderDetails
  /** Annotation manifest and stable target ids. Omitted structurally when reader notes are off. */
  readerNotes?: ReaderNotesDocument
  /** Edit-diff manifest and stable target ids. Omitted structurally when reader edits are off. */
  readerEdits?: ReaderEditsDocument
}

export type HtmlDocumentDesign = 'a' | 'b'
/** One row of a Folio's contents. `depth` counts from the chapter level: 0 is a chapter, 1 sits one level in. */
export type HtmlContentsRow = { anchor: string; text: string; depth: number; chapter: boolean }
export type HtmlOutlineHeading = { level: number; text: string; anchor: string }
export type HtmlFrontmatterValue = string | number | readonly string[]
export type HtmlDocumentSection = { anchor: string; title: string; body: string; ownPage?: boolean }
/** A title page: its title, its rendered body, and its own selected header fields (for the chips, when shown). */
export type HtmlDocumentCover = {
  title: string
  body: string
  data?: HtmlDocumentData
  /** The Folio's standfirst from its Details (shown under the title, above the title page's own body). */
  standfirst?: string
}
/** What a Folio with no title page shows on its generated cover and masthead, from its Details (shared/folio-cover-details.ts). */
export type HtmlFolioHeaderDetails = { standfirst: string | null; frontmatter: Readonly<Record<string, HtmlFrontmatterValue>> }
export type ReaderNotesDocument = { documentId: string; targets: readonly string[] }
export type ReaderEditsDocument = { documentId: string; targets: readonly string[] }

/** The export-safe subset available to later HTML document features. No raw frontmatter or
 * collection provenance can inhabit this shape. */
export type HtmlDocumentData = {
  frontmatter: Readonly<Record<string, HtmlFrontmatterValue>>
  outline: readonly HtmlOutlineHeading[]
  metadata: {
    title: string
    description: string | null
    purpose: string | null
    status: string | null
    modified: number
    words: number
  }
}

/** Escape text for an element body. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function declarations(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = stylesheet.match(new RegExp(`(?:^|\\n)${escapedSelector}\\{([^}]*)\\}`))
  if (!match) throw new Error(`Missing export style: ${selector}`)
  return match[1]
}

export const INLINE_STYLE = {
  paragraph: declarations('.wf-paragraph'),
  heading: declarations('.wf-heading'),
  quote: declarations('.wf-quote'),
  list: declarations('.wf-list'),
  item: declarations('.wf-item'),
  taskItem: declarations('.wf-task-item'),
  pre: declarations('.wf-pre'),
  codeInPre: declarations('.wf-code-in-pre'),
  code: declarations('.wf-code'),
  table: declarations('.wf-table'),
  cell: declarations('.wf-cell'),
  headerCell: declarations('.wf-header-cell'),
  rule: declarations('.wf-rule'),
  mark: declarations('.wf-mark'),
  kbd: declarations('.wf-kbd'),
  image: declarations('.wf-image'),
  figure: declarations('.wf-figure'),
  footnotes: declarations('.wf-footnotes'),
  backref: declarations('.wf-backref'),
}

const DOCUMENT_STYLES = `body{${declarations('body')}}img{${declarations('img')}}table{${declarations('table')}}`
const PLAIN_BUNDLE_STYLES = {
  section: declarations('.wf-bundle-section'),
  title: declarations('.wf-bundle-section-title'),
  divider: declarations('.wf-bundle-section-rule'),
}

/**
 * Fill a template's `{{name}}` placeholders in ONE pass over the template's own text. A value is put in
 * and never read again, so placeholder text inside a value (a widget's source, a title, a piece's body)
 * stays exactly as written. Chained `.replace` calls did re-read: a later one could substitute inside
 * what an earlier one had inserted. A placeholder with no value here is left as it is.
 */
function fill(template: string, values: Readonly<Record<string, () => string>>): string {
  return template.replace(/\{\{([a-z-]+)\}\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? values[name]() : placeholder)
}

export function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;')
}

/** How the emitter opens the wrapper around a table (to-html.ts closes the tag). The `table-scroll`
 * class gives the table its own horizontal scroll box at a narrow width, in the file export and on the
 * sharing reader page alike (both render through this emitter). Its presence in the body is what brings
 * the table styles and the table script into the page. */
export const TABLE_REGION_OPEN = '<div class="wf-table-region table-scroll"'

/**
 * The table script as it goes into the page: one inline `<script>`, built from the script's own
 * source and nothing else. No part of a document is ever put into it, so no table cell, title or
 * widget can change what it does.
 *
 * The source must not end its own element early (`</script`) or open the comment state in which a
 * `<script` further on would swallow the end tag (`<!--`). That is a fact about a file in this
 * repository, so it is asserted where a mistake is caught before release: a unit test over the
 * source (tests/main/export-table-regions.test.ts). Here the same check only decides whether the
 * script is safe to write: a source that fails it gives null, and the page is exported with its
 * tables formatted and without controls. It never throws, because this module is loaded by every
 * export and every clipboard copy.
 */
export function tableRuntimeScript(source: string = tableRuntime): string | null {
  if (/<\/script|<!--/i.test(source)) return null
  return fill(tableRuntimeTemplate.replace(/\n$/, ''), { runtime: () => source })
}

/** The script for this build's own source, or null when that source is not safe to inline. */
export const TABLE_RUNTIME_SCRIPT: string | null = tableRuntimeScript()

/** What follows the body of a page that holds a table: the script, or nothing and a logged error.
 *  Exported for its test only; `assembleDocument` is its one caller. */
export function tableRuntimeFill(script: string | null): string {
  if (script !== null) return `\n${script}`
  console.error('WriteFlex export: the table script contains </script or <!-- and was left out; tables are exported without sort, filter and search.')
  return ''
}

function sidebarLink(input: { className: string; anchor: string; text: string }): string {
  return fill(sidebarLinkTemplate, {
    'link-class': () => escapeAttribute(input.className),
    anchor: () => escapeAttribute(input.anchor),
    text: () => escapeHtml(input.text),
  })
}

/** The deepest heading the contents lists when the writer chose no depth: the long-standing four levels. */
export const DEFAULT_CONTENTS_DEPTH = 4

/** The depth the contents lists: a chosen whole number 1-6, else the default. Anything else is not a choice. */
export function contentsDepth(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6 ? value : DEFAULT_CONTENTS_DEPTH
}

/**
 * The contents links. A heading deeper than `depth` is left out of the list only (the document keeps it).
 * Every listed heading is indented to its true depth, counted from the shallowest one listed, and a
 * collection's piece titles sit one level above its headings.
 */
function sidebarLinks(documents: readonly HtmlDocumentData[], depth: number, rows?: readonly HtmlContentsRow[]): string {
  if (rows) {
    return rows.filter((row) => row.depth + 1 <= depth)
      .map((row) => sidebarLink({ className: row.chapter ? 'piece-link' : `level-${row.depth + 1}`, anchor: row.anchor, text: row.text }))
      .join('\n')
  }
  const collection = documents.length > 1
  const shown = documents.map((document) => document.outline.filter((heading) => heading.level >= 1 && heading.level <= depth))
  const shallowest = Math.min(...shown.flat().map((heading) => heading.level), 6)
  return documents.flatMap((document, index) => {
    const piece = collection
      ? [sidebarLink({ className: 'piece-link', anchor: `p${index + 1}-section`, text: document.metadata.title })]
      : []
    const headings = shown[index].map((heading) => sidebarLink({
      className: `level-${heading.level - shallowest + 1 + (collection ? 1 : 0)}`,
      anchor: heading.anchor,
      text: heading.text,
    }))
    return [...piece, ...headings]
  }).join('\n')
}

/** The anchor of a title page that is exported as a section (its cover is off). */
export const TITLE_PAGE_ANCHOR = 'wf-title-page'

function documentBody(parts: DocumentParts, sidebar: boolean): string {
  if (!parts.sections) return parts.body ?? ''
  const template = sidebar ? bundleSectionTemplate : plainBundleSectionTemplate
  const titlePage: HtmlDocumentSection[] = parts.cover && !(parts.frontPage ?? false)
    ? [{ anchor: TITLE_PAGE_ANCHOR, title: parts.cover.title, body: parts.cover.body }]
    : []
  return [...titlePage, ...(parts.frontMatter ?? []), ...parts.sections].map((section, index) => {
    let rendered = fill(template, {
      anchor: () => escapeAttribute(section.anchor),
      'section-style': () => (section.ownPage ? 'break-before:page;break-after:page;page-break-before:always;page-break-after:always;' : '') + PLAIN_BUNDLE_STYLES.section,
      'title-style': () => PLAIN_BUNDLE_STYLES.title,
      title: () => escapeHtml(section.title),
      body: () => section.body,
    })
    if (section.ownPage && sidebar) rendered = rendered.replace('<section ', '<section style="break-before:page;break-after:page;page-break-before:always;page-break-after:always" ')
    const divider = fill(plainBundleDividerTemplate, { 'divider-style': () => PLAIN_BUNDLE_STYLES.divider })
    return sidebar || index === 0 ? rendered : `${divider}${rendered}`
  }).join('\n')
}

const LONG_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})
const INTEGER = new Intl.NumberFormat('en-GB')

function dateValue(value: string | number): string {
  if (typeof value === 'number') return LONG_DATE.format(new Date(value))
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!iso) return value
  return LONG_DATE.format(new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))))
}

function fieldLabel(field: string): string {
  const words = field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function frontmatterValue(field: string, value: HtmlFrontmatterValue): string {
  if (field === 'date' && (typeof value === 'string' || typeof value === 'number')) return dateValue(value)
  return Array.isArray(value) ? value.join(', ') : String(value)
}

function metadata(data: Pick<HtmlDocumentData, 'frontmatter'> | undefined, design: HtmlDocumentDesign): string {
  if (!data) return ''
  const template = design === 'a' ? chipATemplate : chipBTemplate
  const chips = Object.entries(data.frontmatter).flatMap(([field, value]) => {
    const renderedValue = frontmatterValue(field, value)
    if (renderedValue.trim() === '') return []
    return [fill(template, {
      label: () => escapeHtml(fieldLabel(field)),
      value: () => escapeHtml(renderedValue),
    })]
  })
  return chips.length
    ? fill(metadataTemplate, { chips: () => chips.join('\n') })
    : ''
}

type SummaryCard = { value: string; label: string }

function summaryCards(parts: DocumentParts): SummaryCard[] {
  const documents = parts.documents ?? []
  if (!documents.length) return []
  const collection = parts.sections !== undefined
  const words = documents.reduce((total, document) => total + document.metadata.words, 0)
  // a reduce, not Math.max(...): a spread passes one argument per document. -Infinity is Math.max's own start.
  const modified = documents.reduce((latest, document) => Math.max(latest, document.metadata.modified), -Infinity)
  const cards: SummaryCard[] = [
    { value: INTEGER.format(words), label: 'words' },
    { value: dateValue(modified), label: 'last modified' },
  ]
  if (collection) {
    const statuses = [...new Set(documents.map((document) => document.metadata.status).filter(
      (status): status is string => status !== null && status.trim() !== '',
    ))]
    if (statuses.length === 1) cards.push({ value: statuses[0], label: 'collection status' })
  }
  return cards
}

function summary(parts: DocumentParts, standalone: boolean): string {
  const cards = summaryCards(parts).map((card) => fill(summaryCardTemplate, {
    value: () => escapeHtml(card.value),
    label: () => escapeHtml(card.label),
  }))
  if (!cards.length) return ''
  const template = standalone ? summaryOnlyTemplate : summaryTemplate
  return fill(template, { cards: () => cards.join('\n') })
}

function documentHeader(parts: DocumentParts, design: HtmlDocumentDesign): string {
  const titleBlock = parts.titleBlock ?? true
  const summaryTiles = parts.summaryTiles ?? false
  if (!titleBlock) return summaryTiles ? summary(parts, true) : ''
  const collection = parts.sections !== undefined
  const data = collection ? undefined : parts.documents?.[0]
  const details = collection ? parts.folioDetails : undefined
  const standfirst = data?.metadata.description?.trim() ?? details?.standfirst?.trim()
  const template = design === 'a' ? mastheadATemplate : mastheadBTemplate
  return fill(template, {
    'masthead-title': () => escapeHtml(parts.title),
    standfirst: () => standfirst ? fill(standfirstTemplate, { standfirst: () => escapeHtml(standfirst) }) : '',
    metadata: () => metadata(data ?? details, design),
    summary: () => summaryTiles ? summary(parts, false) : '',
  })
}

/** The cover screen: the title, the standfirst and the selected chips in the chosen design's own
 * language, with no contents sidebar beside it. The reader enters the document by clicking the
 * cover (a plain in-page link, so it works with scripting off) or simply by scrolling past it. */
function frontPage(parts: DocumentParts, design: HtmlDocumentDesign): string {
  if (!parts.frontPage) return ''
  if (parts.cover) return titlePageCover(parts.cover, design)
  const collection = parts.sections !== undefined
  const data = collection ? undefined : parts.documents?.[0]
  const details = collection ? parts.folioDetails : undefined
  const standfirst = data?.metadata.description?.trim() ?? details?.standfirst?.trim()
  return fill(frontPageTemplate, {
    'cover-title': () => escapeHtml(parts.title),
    standfirst: () => standfirst ? fill(standfirstTemplate, { standfirst: () => escapeHtml(standfirst) }) : '',
    metadata: () => metadata(data ?? details, design),
  })
}

/**
 * Whether a title-page cover carries the Date / Status / Author chips under its body. On: the owner approved the
 * cover chips as drawn in ADR-0046 mockup e (2026-10-19). Flip here and nowhere else.
 */
export const TITLE_PAGE_COVER_CHIPS = true

/** The chips under a title-page cover: the title page's own selected header fields, or nothing (`TITLE_PAGE_COVER_CHIPS`). */
export function titlePageCoverChips(cover: HtmlDocumentCover, design: HtmlDocumentDesign, show: boolean = TITLE_PAGE_COVER_CHIPS): string {
  return show ? metadata(cover.data, design) : ''
}

/** The cover drawn from the Folio's title page: its title, its body as written beneath, then the chips (if shown).
 *  It carries the title page's anchor, so a link to the title page lands on the cover. */
function titlePageCover(cover: HtmlDocumentCover, design: HtmlDocumentDesign): string {
  return `<span class="front-page-anchor" id="${TITLE_PAGE_ANCHOR}" aria-hidden="true"></span>\n` + fill(frontPageTemplate, {
    'cover-title': () => escapeHtml(cover.title),
    standfirst: () => (cover.standfirst ? fill(standfirstTemplate, { standfirst: () => escapeHtml(cover.standfirst as string) }) : '') + fill(frontPageBodyTemplate, { body: () => cover.body }),
    metadata: () => titlePageCoverChips(cover, design),
  })
}

type ReaderModes = 'notes' | 'edits' | 'both'

/** What the badge and the return action are CALLED. Two modes, one sentence each: the reader never
 * has to work out which half of the document a control belongs to (ticket 13, §7d). */
const READER_BADGE_LABEL: Record<ReaderModes, string> = {
  notes: 'Comment',
  edits: 'Suggest edits',
  both: 'Comment or suggest edits',
}
const READER_RETURN_LABEL: Record<ReaderModes, string> = {
  notes: 'Export comments',
  edits: 'Export edits',
  both: 'Export comments and edits',
}

/** What the explainer says before it says how. the user's sentences, answered 2026-09-12: the reader
 * is told what this copy of the document IS and what to do with it, and only then how. */
const READER_BADGE_INTRO: Record<ReaderModes, string> = {
  notes: 'This is a version of this document for comments. You can export and email your suggestions to the author.',
  edits: 'This is a version of this document for editing. You can export and email your suggestions to the author.',
  both: 'This is a version of this document for comments and editing. You can export and email your suggestions to the author.',
}

/** One floating badge for the whole document, naming the modes it was exported with, with the
 * explainer for each mode behind hover and keyboard focus, and one explicit return action. */
function readerBadge(parts: DocumentParts): string {
  const notes = parts.readerNotes !== undefined
  const edits = parts.readerEdits !== undefined
  if (!notes && !edits) return ''
  const modes: ReaderModes = notes && edits ? 'both' : notes ? 'notes' : 'edits'
  const explainer = [notes ? readerBadgeCommentTemplate : '', edits ? readerBadgeEditTemplate : '']
    .filter((part) => part !== '')
    .join('')
    .replace(/\n$/, '')
  return fill(readerBadgeTemplate, {
    intro: () => escapeHtml(READER_BADGE_INTRO[modes]),
    explainer: () => explainer,
    'badge-label': () => READER_BADGE_LABEL[modes],
    'return-label': () => READER_RETURN_LABEL[modes],
    runtime: () => readerBadgeRuntime,
  })
}

function readerSurfaces(parts: DocumentParts): string {
  if (!parts.readerNotes && !parts.readerEdits) return ''
  const manifest = {
    schemaVersion: 1,
    documentId: (parts.readerNotes ?? parts.readerEdits)!.documentId,
    contentSelector: '.content',
    sectionSelector: 'section[id]',
    blockSelector: 'p[id], li[id], h1[id], h2[id], h3[id], h4[id], dt[id], dd[id]',
    ...(parts.readerNotes ? { annotations: { enabled: true, targets: [...parts.readerNotes.targets] } } : {}),
    ...(parts.readerEdits ? { editDiff: { enabled: true, targets: [...parts.readerEdits.targets] } } : {}),
  }
  const encodedManifest = JSON.stringify(manifest).replace(/</g, '\\u003c')
  const notes = parts.readerNotes
    ? fill(readerNotesTemplate, { runtime: () => readerNotesRuntime })
    : ''
  const edits = parts.readerEdits
    ? fill(readerEditsTemplate, { runtime: () => readerEditsRuntime })
    : ''
  // The badge carries each mode's drawer button, so it is parsed before the runtimes that bind them.
  return `<script id="writeflex-interaction-manifest" type="application/json">${encodedManifest}</script>\n${readerBadge(parts)}\n${notes}\n${edits}`
}

/** Assemble the standalone HTML shell and optional document chrome from imported assets. */
export function assembleDocument(parts: DocumentParts): string {
  const sidebar = parts.sidebar ?? true
  const titleBlock = parts.titleBlock ?? true
  const summaryTiles = parts.summaryTiles ?? false
  const design = parts.design ?? 'a'
  const frontPageOn = parts.frontPage ?? false
  const styledDocument = sidebar || titleBlock || summaryTiles || frontPageOn
    || parts.readerNotes !== undefined || parts.readerEdits !== undefined
  const template = !styledDocument
    ? plainDocumentTemplate
    : sidebar
      ? documentTemplate
      : documentWithoutSidebarTemplate
  const body = documentBody(parts, sidebar)
  const hasWidgets = body.includes('<figure class="wf-export-widget"')
  // Only the HTML file export writes table regions, and escaped text can never hold this markup.
  const hasTables = body.includes(TABLE_REGION_OPEN)
  const pageStyles = styledDocument
    ? (frontPageOn ? `${stylesheet}${frontPageStylesheet}` : stylesheet)
    : DOCUMENT_STYLES
  // The widget host policy goes into the template's own <head>, before anything is filled in.
  const shell = hasWidgets
    ? template.replace('<head>', () => `<head><meta http-equiv="Content-Security-Policy" content="frame-src 'none'; child-src 'none'; worker-src 'none'">`)
    : template
  return fill(shell, {
    title: () => escapeHtml(parts.title),
    styles: () => hasTables ? `${pageStyles}\n${tableStylesheet}` : pageStyles,
    design: () => design,
    'sidebar-title': () => escapeHtml(parts.title),
    sidebar: () => sidebarLinks(parts.documents ?? [], contentsDepth(parts.tocDepth), parts.contentsRows),
    'document-header': () => documentHeader(parts, design),
    // The table script follows the document body, once, however many tables the page holds.
    body: () => `${hasWidgets ? WIDGET_EXPORT_RUNTIME : ''}${body}${hasTables ? tableRuntimeFill(TABLE_RUNTIME_SCRIPT) : ''}`,
    'reader-notes': () => readerSurfaces(parts),
    'front-page': () => frontPage(parts, design),
  })
}
