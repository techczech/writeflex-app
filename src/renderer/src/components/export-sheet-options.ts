import type { ExportFormat, FolioLeftOut, HtmlExportOptions } from '../../../preload'
import {
  isTocDepth,
  normaliseExportPresetLastUsed,
  type ExportPresetChoice,
  type ExportPresetLastUsed,
} from '../../../shared/export-presets'

export const EXPORT_MASTHEAD_FIELDS = ['date', 'status', 'author', 'purpose', 'tags', 'series'] as const
export type ExportMastheadField = (typeof EXPORT_MASTHEAD_FIELDS)[number]

export type ExportSheetOptions = {
  sidebar: boolean
  titleBlock: boolean
  readerNotes: boolean
  readerEdits: boolean
  summaryTiles: boolean
  frontPage: boolean
  design: 'a' | 'b'
  /** Heading levels the contents lists, 1-6 (6 is All); absent keeps the default. */
  tocDepth?: number
  frontmatterFields: ExportMastheadField[]
}

export const DEFAULT_EXPORT_SHEET_OPTIONS: ExportSheetOptions = {
  sidebar: true,
  titleBlock: true,
  readerNotes: false,
  readerEdits: false,
  summaryTiles: false,
  frontPage: false,
  design: 'a',
  frontmatterFields: ['date', 'status', 'author'],
}

type ExportSheetStorage = Pick<Storage, 'getItem' | 'setItem'>

export function exportSheetStorageKey(workspaceRoot: string): string {
  return `writeflex:export-options:${workspaceRoot}`
}

function isMastheadField(value: unknown): value is ExportMastheadField {
  return typeof value === 'string' && (EXPORT_MASTHEAD_FIELDS as readonly string[]).includes(value)
}

function parseOptions(value: unknown): ExportSheetOptions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (typeof input.sidebar !== 'boolean'
    || typeof input.titleBlock !== 'boolean'
    || (input.readerNotes !== undefined && typeof input.readerNotes !== 'boolean')
    || (input.readerEdits !== undefined && typeof input.readerEdits !== 'boolean')
    || typeof input.summaryTiles !== 'boolean'
    || (input.frontPage !== undefined && typeof input.frontPage !== 'boolean')
    || (input.design !== 'a' && input.design !== 'b')
    || (input.tocDepth !== undefined && !isTocDepth(input.tocDepth))
    || !Array.isArray(input.frontmatterFields)
    || !input.frontmatterFields.every(isMastheadField)) return null
  return {
    sidebar: input.sidebar,
    titleBlock: input.titleBlock,
    readerNotes: input.readerNotes === true,
    readerEdits: input.readerEdits === true,
    summaryTiles: input.summaryTiles,
    frontPage: input.frontPage === true,
    design: input.design,
    ...(input.tocDepth === undefined ? {} : { tocDepth: input.tocDepth as number }),
    frontmatterFields: [...new Set(input.frontmatterFields)],
  }
}

export function loadExportSheetOptions(workspaceRoot: string, storage: ExportSheetStorage): ExportSheetOptions {
  try {
    const saved = storage.getItem(exportSheetStorageKey(workspaceRoot))
    return saved === null ? { ...DEFAULT_EXPORT_SHEET_OPTIONS, frontmatterFields: [...DEFAULT_EXPORT_SHEET_OPTIONS.frontmatterFields] }
      : parseOptions(JSON.parse(saved)) ?? { ...DEFAULT_EXPORT_SHEET_OPTIONS, frontmatterFields: [...DEFAULT_EXPORT_SHEET_OPTIONS.frontmatterFields] }
  } catch {
    return { ...DEFAULT_EXPORT_SHEET_OPTIONS, frontmatterFields: [...DEFAULT_EXPORT_SHEET_OPTIONS.frontmatterFields] }
  }
}

export function saveExportSheetOptions(
  workspaceRoot: string,
  options: ExportSheetOptions,
  storage: ExportSheetStorage,
): void {
  try {
    storage.setItem(exportSheetStorageKey(workspaceRoot), JSON.stringify(options))
  } catch {
    // Export choices are convenience state; an unavailable localStorage must not block exporting.
  }
}

/** Restore the complete last-used choice from the existing per-Workspace renderer seam. */
export function loadExportPresetLastUsed(workspaceRoot: string, storage: ExportSheetStorage): ExportPresetLastUsed | null {
  try {
    const saved = storage.getItem(exportSheetStorageKey(workspaceRoot))
    if (saved === null) return null
    const parsed = JSON.parse(saved) as unknown
    const current = normaliseExportPresetLastUsed(parsed)
    if (current) return current
    // Ticket 06 stored only HTML options. Preserve them as an unnamed HTML combination on upgrade.
    const legacy = parseOptions(parsed)
    return legacy ? { choice: exportPresetChoice('html', legacy), sourcePresetId: null } : null
  } catch {
    return null
  }
}

export function saveExportPresetLastUsed(
  workspaceRoot: string,
  lastUsed: ExportPresetLastUsed,
  storage: ExportSheetStorage,
): void {
  try { storage.setItem(exportSheetStorageKey(workspaceRoot), JSON.stringify(lastUsed)) } catch {
    // Last-used choices are convenience state; an unavailable renderer store must not block export.
  }
}

export function exportPresetChoice(format: ExportFormat, options: ExportSheetOptions): ExportPresetChoice {
  return { format, ...options, frontmatterFields: [...options.frontmatterFields] }
}

export function exportSheetOptions(choice: ExportPresetChoice): ExportSheetOptions {
  return {
    sidebar: choice.sidebar,
    titleBlock: choice.titleBlock,
    readerNotes: choice.readerNotes,
    readerEdits: choice.readerEdits,
    summaryTiles: choice.summaryTiles,
    frontPage: choice.frontPage,
    design: choice.design,
    ...(choice.tocDepth === undefined ? {} : { tocDepth: choice.tocDepth }),
    frontmatterFields: [...choice.frontmatterFields],
  }
}

function list(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
}

function fieldList(items: string[]): string {
  if (items.length < 3) return list(items)
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

const FIELD_LABELS: Record<ExportMastheadField, string> = {
  date: 'date',
  status: 'status',
  author: 'author',
  purpose: 'purpose',
  tags: 'tags',
  series: 'series',
}

/** The sheet's truth statement: derived from the payload, never maintained as parallel copy. */
export function exportDisclosure(format: ExportFormat, options: ExportSheetOptions): string {
  if (format === 'docx') {
    return 'This Word export carries the document’s headings, lists, tables, images and footnotes. HTML-only contents, title details, front page, summary tiles, design and masthead-field choices stay behind; frontmatter, comments, wikilinks, and your // margin notes never travel.'
  }

  const included: string[] = []
  const omitted: string[] = []
  if (options.sidebar) included.push('a contents sidebar')
  else omitted.push('the contents sidebar')
  if (options.titleBlock) {
    const fields = options.frontmatterFields.map((field) => FIELD_LABELS[field])
    included.push(fields.length > 0 ? `a title block with ${fieldList(fields)}` : 'a title block')
  } else {
    omitted.push('the title block and masthead fields')
  }
  if (options.frontPage) included.push('a front page cover')
  else omitted.push('the front page')
  if (options.summaryTiles) included.push('word-count and modified-date tiles')
  if (options.readerNotes) included.push('reader comments with Markdown and JSON return files')
  if (options.readerEdits) included.push('reader editing with a JSON diff return file')
  if (options.design === 'b') included.push('Editorial design')
  included.push('print styling')
  if (!options.readerNotes) omitted.push('reader comments')
  if (!options.readerEdits) omitted.push('reader editing')
  if (!options.summaryTiles) omitted.push('word-count and modified-date tiles')
  omitted.push('unselected frontmatter', 'your // margin notes never travel')
  return `This export includes ${list(included)}. It leaves out ${list(omitted)}.`
}

export function htmlExportOptions(options: ExportSheetOptions): HtmlExportOptions {
  return {
    sidebar: options.sidebar,
    titleBlock: options.titleBlock,
    summaryTiles: options.summaryTiles,
    frontPage: options.frontPage,
    design: options.design,
    ...(options.tocDepth === undefined ? {} : { tocDepth: options.tocDepth }),
    frontmatterFields: options.frontmatterFields,
    readerNotes: options.readerNotes,
    readerEdits: options.readerEdits,
  }
}

export function exportSheetChoice(
  scope: 'piece' | 'collection',
  format: ExportFormat,
  options: ExportSheetOptions,
  home?: ExportTocDepthHome | null,
): { scope: 'piece' | 'collection'; format: ExportFormat; html?: HtmlExportOptions; keepTocDepth?: true } {
  return {
    scope,
    format,
    ...(format === 'html' ? { html: htmlExportOptions(options) } : {}),
    // A depth the writer chose for a scope with a file home is saved there by main as the HTML export runs.
    ...(format === 'html' && home?.chosen ? { keepTocDepth: true as const } : {}),
  }
}

/** A listed Folio entry the export will leave out, as main reported it. */
export type ExportLeftOut = FolioLeftOut

const LEFT_OUT_REASONS: Record<ExportLeftOut['reason'], string> = {
  'not-found': 'file not found',
  'outside-folio': 'outside this Folio’s folder',
  'agent-instructions': 'agent instructions are never part of the Folio',
}

/** The line above the left-out list, and one row per entry: its path as the manifest wrote it, and why. */
export function exportLeftOutLines(leftOut: readonly ExportLeftOut[]): { heading: string; rows: string[] } | null {
  if (leftOut.length === 0) return null
  return {
    heading: `${leftOut.length} listed ${leftOut.length === 1 ? 'piece' : 'pieces'} will be left out:`,
    rows: leftOut.map((entry) => `${entry.path} — ${LEFT_OUT_REASONS[entry.reason]}`),
  }
}

/**
 * What the finished line says was written, without its full stop. A single piece: "Exported". A whole
 * collection: "Exported 31 pieces", or "Exported 29 of 31 listed pieces" when listed entries were left out.
 */
export function exportedPhrase(done: { pieces: number; listed: number }, bundled: boolean): string {
  if (!bundled) return 'Exported'
  if (done.listed > done.pieces) return `Exported ${done.pieces} of ${done.listed} listed pieces`
  return `Exported ${done.pieces} ${done.pieces === 1 ? 'piece' : 'pieces'}`
}

/**
 * Where the Contents depth for one scope is kept: the file (`toc_depth` in a document's own frontmatter,
 * or in a Folio's Index Note) and what it says now. A scope with such a file shows the file's value,
 * Default when the key is absent; only a scope without one uses the last-used/preset depth. The sheet
 * never writes it: a depth chosen here is saved by main when an HTML export runs (export.ts).
 */
export type ExportTocDepthHome = {
  /** Plain words for the hint under the control: where the choice is saved. */
  label: string
  depth: number | null
  /** The writer chose this depth in the sheet: the export uses it exactly and main saves it with the
   *  file when an HTML export runs. Untouched, the sheet only shows what the file says. */
  chosen?: boolean
}

/** Does this scope's file decide the depth? Whenever the scope has one: absent there means Default. */
export const tocDepthHomeGoverns = (home: ExportTocDepthHome | null | undefined): home is ExportTocDepthHome => !!home

/**
 * The Contents depth the sheet shows and exports: with a file home, the file's `toc_depth` or the depth
 * chosen here (undefined, i.e. Default and no explicit depth sent, when there is none); without one, the
 * last-used or preset value.
 */
export function sheetTocDepth(lastUsed: number | undefined, home: ExportTocDepthHome | null | undefined): number | undefined {
  return tocDepthHomeGoverns(home) ? home.depth ?? undefined : lastUsed
}
