import { isExportFormat, type ExportFormat, type HtmlExportOptions } from './export'

const HTML_OPTION_KEYS = new Set(['sidebar', 'titleBlock', 'summaryTiles', 'frontPage', 'design', 'tocDepth', 'frontmatterFields', 'readerNotes', 'readerEdits'])
const FRONTMATTER_FIELDS = new Set(['date', 'status', 'author', 'purpose', 'tags', 'series'])

function format(value: unknown): ExportFormat {
  if (!isExportFormat(value)) throw new Error(`“${String(value)}” is not an export format. Choose HTML or Word.`)
  return value
}

function htmlOptions(value: unknown): HtmlExportOptions | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid HTML export options.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !HTML_OPTION_KEYS.has(key))) throw new Error('Invalid HTML export options.')
  if (input.sidebar !== undefined && typeof input.sidebar !== 'boolean') throw new Error('Invalid HTML export options.')
  if (input.titleBlock !== undefined && typeof input.titleBlock !== 'boolean') throw new Error('Invalid HTML export options.')
  if (input.summaryTiles !== undefined && typeof input.summaryTiles !== 'boolean') throw new Error('Invalid HTML export options.')
  if (input.frontPage !== undefined && typeof input.frontPage !== 'boolean') throw new Error('Invalid HTML export options.')
  if (input.readerNotes !== undefined && typeof input.readerNotes !== 'boolean') throw new Error('Invalid HTML export options.')
  if (input.readerEdits !== undefined && typeof input.readerEdits !== 'boolean') throw new Error('Invalid HTML export options.')
  if (input.tocDepth !== undefined && !(typeof input.tocDepth === 'number' && Number.isInteger(input.tocDepth) && input.tocDepth >= 1 && input.tocDepth <= 6)) throw new Error('Invalid HTML export options.')
  if (input.design !== undefined && input.design !== 'a' && input.design !== 'b') throw new Error('Invalid HTML export options.')
  if (input.frontmatterFields !== undefined && (
    !Array.isArray(input.frontmatterFields)
    || !input.frontmatterFields.every((field) => typeof field === 'string' && FRONTMATTER_FIELDS.has(field))
  )) throw new Error('Invalid HTML export options.')
  return {
    ...(input.sidebar === undefined ? {} : { sidebar: input.sidebar }),
    ...(input.titleBlock === undefined ? {} : { titleBlock: input.titleBlock }),
    ...(input.summaryTiles === undefined ? {} : { summaryTiles: input.summaryTiles }),
    ...(input.frontPage === undefined ? {} : { frontPage: input.frontPage }),
    ...(input.readerNotes === undefined ? {} : { readerNotes: input.readerNotes }),
    ...(input.readerEdits === undefined ? {} : { readerEdits: input.readerEdits }),
    ...(input.design === undefined ? {} : { design: input.design }),
    ...(input.tocDepth === undefined ? {} : { tocDepth: input.tocDepth as number }),
    ...(input.frontmatterFields === undefined ? {} : { frontmatterFields: [...new Set(input.frontmatterFields as string[])] }),
  }
}

/** Save the export's Contents depth with the scope's file: true, or absent. Anything else is refused. */
function keepTocDepth(value: unknown): boolean {
  if (value === undefined || value === false) return false
  if (value !== true) throw new Error('Invalid export request.')
  return true
}

export function exportDocumentRequest(input: unknown): {
  path: string
  format: ExportFormat
  target: string
  html?: HtmlExportOptions
  keepTocDepth?: boolean
} {
  const request = (input ?? {}) as Record<string, unknown>
  const html = htmlOptions(request.html)
  const keep = keepTocDepth(request.keepTocDepth)
  return {
    path: String(request.path ?? ''),
    format: format(request.format),
    target: String(request.target ?? ''),
    ...(html === undefined ? {} : { html }),
    ...(keep ? { keepTocDepth: true } : {}),
  }
}

export function exportBundleRequest(input: unknown): {
  dir: string
  format: ExportFormat
  target: string
  html?: HtmlExportOptions
  keepTocDepth?: boolean
} {
  const request = (input ?? {}) as Record<string, unknown>
  const html = htmlOptions(request.html)
  const keep = keepTocDepth(request.keepTocDepth)
  return {
    dir: String(request.dir ?? ''),
    format: format(request.format),
    target: String(request.target ?? ''),
    ...(html === undefined ? {} : { html }),
    ...(keep ? { keepTocDepth: true } : {}),
  }
}
