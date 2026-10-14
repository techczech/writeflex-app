/**
 * The clipboard payload (Round B T5).
 *
 * Every copy leaves WriteFlex through the main process, because only the main process can write
 * SEVERAL flavours at once — and one flavour is exactly what fails. Word, Teams and Outlook
 * negotiate the clipboard and take RTF as authoritative; a paste of HTML alone is reinterpreted,
 * restyled to the host document's theme, or flattened. So a rich copy writes RTF, HTML and plain
 * text together and lets the receiving application choose.
 *
 * The rendering is pure and lives here, apart from the IPC handler, so the payload can be checked
 * without an Electron window (the sound-pack pattern).
 */
import { toHtml } from '../shared/markdown/to-html'
import { toRtf } from '../shared/markdown/to-rtf'
import { toPlain } from '../shared/markdown/to-plain'
import { toNormalisedMarkdown } from '../shared/markdown/to-markdown'
import { readDocument } from '../shared/markdown/model'
import {
  loadPictures,
  loadSvgFences,
  pastedHtmlImages,
  pastedHtmlSvgFences,
  rtfImages,
  rtfSvgFences,
  type DrawnFences,
  type LoadedPictures,
} from './pictures'

/** The three copy commands. `rich` is the flagship; the other two are single-flavour by design. */
export type ClipboardKind = 'rich' | 'markdown' | 'plain'

/** Exactly the shape Electron's `clipboard.write` takes. */
export type ClipboardPayload = { text: string; html?: string; rtf?: string }

export const CLIPBOARD_KINDS: ClipboardKind[] = ['rich', 'markdown', 'plain']

/** Human-readable names, used in the flash the writer reads back. */
export const CLIPBOARD_KIND_LABELS: Record<ClipboardKind, string> = {
  rich: 'rich text',
  markdown: 'Markdown',
  plain: 'plain text',
}

/**
 * Where the copied text came FROM, so its pictures can be resolved. A copy without it still copies
 * — the app has to survive a document that is not on disk yet — but its pictures cannot travel,
 * because a relative `src` means nothing to the application receiving the paste.
 */
export type CopyContext = { workspace: { root: string }; path: string }

/**
 * Render `markdown` into the flavours `kind` implies.
 *
 * - `rich` — RTF + HTML + plain text, written together.
 * - `markdown` — the document's own Markdown, normalised.
 * - `plain` — prose with the markup removed.
 *
 * A rich copy carries its PICTURES: read through the same workspace-containment check the export
 * uses, then written as `data:` URIs in the HTML flavour and as `{\pict}` groups in the RTF one.
 * Anything that could not be read degrades to its alt text, exactly as an export degrades it.
 *
 * Frontmatter, comments and wikilinks are handled by the emitters, so no path here can leak them.
 * Rejects with a recovery action when the input is not something that can be copied; an empty
 * payload is refused outright rather than silently emptying the writer's clipboard.
 */
export async function clipboardPayload(
  markdown: unknown,
  kind: unknown,
  context?: CopyContext | null,
): Promise<{ kind: ClipboardKind; payload: ClipboardPayload }> {
  if (typeof markdown !== 'string') throw new Error('Nothing was handed to the clipboard — try the command again with a document open.')
  if (typeof kind !== 'string' || !CLIPBOARD_KINDS.includes(kind as ClipboardKind)) {
    throw new Error(`“${String(kind)}” is not a way of copying. Use the palette’s Copy commands.`)
  }
  const chosen = kind as ClipboardKind
  const payload: ClipboardPayload = chosen === 'rich'
    ? richPayload(markdown, await drawings(markdown, context ?? null))
    : chosen === 'markdown'
      ? { text: toNormalisedMarkdown(markdown) }
      : { text: toPlain(markdown) }
  if (payload.text.trim() === '' && !payload.html) {
    throw new Error('There is nothing to copy — select some text, or put the caret in a document with words in it.')
  }
  return { kind: chosen, payload }
}

type Drawings = { pictures: LoadedPictures | null; fences: DrawnFences }

/**
 * The pictures a copy can carry. Never fatal: a file that cannot be read must not cost the writer
 * the copy itself. A ```svg fence needs no document context — its bytes are in the text — so it is
 * drawn even for a copy that has nowhere to resolve file paths against.
 */
async function drawings(markdown: string, context: CopyContext | null): Promise<Drawings> {
  try {
    const document = readDocument(markdown)
    return {
      pictures: context ? await loadPictures(context.workspace, document, context.path) : null,
      fences: await loadSvgFences(document),
    }
  } catch {
    return { pictures: null, fences: new Map() }
  }
}

function richPayload(markdown: string, drawn: Drawings): ClipboardPayload {
  // Without a document to resolve against, an image is dropped rather than emitted as a path the
  // receiving application would render as a broken picture: `'omit'` keeps its alt text instead.
  //
  // The HTML flavour here is NOT the exported HTML file, and the difference is deliberate (the user's
  // usability review find on 0.9.1: SVGs pasted into Word and Teams vanished). A file is opened in a browser,
  // which draws an inline `<svg>` crisply at any zoom; a paste is imported by Word, Teams or
  // Outlook, all of which DISCARD an inline `<svg>` and an `image/svg+xml` data URI. So the
  // clipboard's HTML asks for the rasterised form of anything the receiver cannot draw
  // (`pastedHtmlImages`/`pastedHtmlSvgFences`) while `main/export.ts` keeps `htmlImages` + the
  // emitter's default `'inline'` fences. Unifying them re-breaks the paste, silently.
  return {
    text: toPlain(markdown),
    html: toHtml(markdown, {
      images: drawn.pictures ? pastedHtmlImages(drawn.pictures) : 'omit',
      svgFences: pastedHtmlSvgFences(drawn.fences),
    }).html,
    rtf: toRtf(markdown, {
      images: drawn.pictures ? rtfImages(drawn.pictures) : 'alt',
      svgFences: rtfSvgFences(drawn.fences),
    }),
  }
}
