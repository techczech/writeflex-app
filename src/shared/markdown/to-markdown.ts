/**
 * The normalised-Markdown emitter (Round B T4).
 *
 * "Copy as Markdown" hands another Markdown tool — a repo, a CMS, another editor — the document's
 * OWN bytes, minus the two things that never leave the app and minus the one syntax that means
 * nothing outside it. So this is deliberately NOT a re-render of the document model: it does not
 * rewrite the writer's tables, reflow their prose or renumber their lists. It removes frontmatter
 * (ADR-0019) and comments (ADR-0021), flattens wikilinks to their label text, and is otherwise
 * byte-faithful.
 */
import { exportSource, flattenWikilinks } from './dialect'

const FENCE_LINE = /^\s*(?:```|~~~)/
/** A line indented far enough to be a code block — but only where one may BEGIN (CommonMark: an
 *  indented block cannot interrupt a paragraph), which is why the scan tracks the blank before it. */
const INDENTED_CODE_LINE = /^(?: {4}|\t)/
const BLANK_LINE = /^[ \t]*$/

/** Flatten wikilinks outside inline code spans: inside backticks the brackets are the writer's own
 *  characters, exactly as the editor and the other emitters treat them. */
function flattenOutsideCode(line: string): string {
  // Odd indices are the captured code spans, which pass through untouched.
  return line.split(/(`+[^`]*`+)/g).map((part, index) => (index % 2 === 1 ? part : flattenWikilinks(part))).join('')
}

/** The document as Markdown another tool can read: frontmatter and comments gone, wikilinks
 *  flattened, everything else the writer's own bytes.
 *
 *  Code is quoted, so it is left alone — fenced blocks, indented blocks and backtick spans keep
 *  their literal `[[x]]`, which is the same boundary the model-building flavours draw (model.ts). */
export function toNormalisedMarkdown(markdown: string): string {
  let inFence = false
  let inIndentedCode = false
  let afterBlank = true // the top of the document can open an indented block
  const lines = exportSource(markdown).split('\n').map((line) => {
    if (FENCE_LINE.test(line)) { inFence = !inFence; inIndentedCode = false; afterBlank = false; return line }
    if (inFence) return line
    const blank = BLANK_LINE.test(line)
    const indented = INDENTED_CODE_LINE.test(line) && (afterBlank || inIndentedCode)
    if (!blank) inIndentedCode = indented
    afterBlank = blank
    return indented || (blank && inIndentedCode) ? line : flattenOutsideCode(line)
  })
  const body = lines.join('\n').replace(/\s+$/, '')
  return body === '' ? '' : `${body}\n`
}
