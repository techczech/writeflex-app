import { ensureSyntaxTree, language, syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { Tree } from '@lezer/common'
import { parseMarkdown } from '../../../shared/markdown/dialect'
import { frontmatterBlock } from '../../../shared/markdown/frontmatter'

export type OutlineHeading = { level: number; text: string; from: number }

/** A heading with its subordinate headings nested underneath — the shape the outline panel renders.
 *  Children are the following headings of a strictly greater level, until one of equal-or-higher level. */
export type OutlineNode = OutlineHeading & { children: OutlineNode[] }

/**
 * The open file's headings in document order (salvaged from M1's proven extractor). ATX (`## Title`)
 * and Setext (`Title\n---`) headings are recognised; fenced-code hashes and `#nospace` lines are not.
 * `from` is the heading's start offset — the outline panel jumps the cursor there and follows it back.
 */
export function extractOutline(doc: string): OutlineHeading[] {
  // The app's ONE dialect, not the bare CommonMark parser: the outline must agree with the editor
  // and the exporters about where a heading is.
  return outlineOfTree(parseMarkdown(doc), doc)
}

/**
 * {@link extractOutline} for a live editor state: the headings come off the editor's own incremental
 * syntax tree instead of a second whole-document parse. `text` is `state.doc.toString()` (passed in
 * because the caller already holds it). A state with no language has no tree and is parsed as before.
 */
export function extractOutlineOfState(state: EditorState, text: string): OutlineHeading[] {
  if (!state.facet(language)) return extractOutline(text)
  // Only a tree that covers the whole document is the document's outline; a half-parsed one is not.
  const tree = syntaxTreeAvailable(state) ? syntaxTree(state) : ensureSyntaxTree(state, state.doc.length, 25)
  return tree ? outlineOfTree(tree, text) : extractOutline(text)
}

function outlineOfTree(tree: Tree, doc: string): OutlineHeading[] {
  // Frontmatter is metadata, not writing (ADR-0019): to the Markdown parser its closing `---` is a
  // Setext underline, which turned `title: …` into an H2 spanning the block. The ONE recogniser in
  // shared/markdown/frontmatter.ts says where the block ends; nothing inside it is a heading.
  const bodyStart = frontmatterBlock(doc)?.end ?? 0
  const headings: OutlineHeading[] = []
  tree.iterate({
    enter(node) {
      if (node.from < bodyStart) return
      const atx = node.name.match(/^ATXHeading(\d)$/)
      const setext = node.name.match(/^SetextHeading(\d)$/)
      if (!atx && !setext) return
      const level = Number((atx ?? setext)![1])
      const raw = doc.slice(node.from, node.to)
      const text = atx
        ? raw.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim()
        : raw.split('\n')[0].trim()
      headings.push({ level, text, from: node.from })
      return false
    },
  })
  return headings
}

/**
 * Nest a flat heading list into a tree by level. A heading becomes a child of the nearest preceding
 * heading of a lower level; an irregular jump (H1 straight to H3) attaches to whatever is open, so
 * every heading always lands somewhere. Powers the panel's collapsible sections.
 */
export function buildOutlineTree(headings: OutlineHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = []
  const stack: OutlineNode[] = []
  for (const heading of headings) {
    const node: OutlineNode = { ...heading, children: [] }
    while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop()
    if (stack.length) stack[stack.length - 1].children.push(node)
    else roots.push(node)
    stack.push(node)
  }
  return roots
}

/**
 * The index of the heading whose section the cursor sits in — the last heading starting at or before
 * `pos` — or -1 when the cursor is above the first heading. The panel marks this row aria-current so
 * the outline tracks the caret (M1's cursor-follow behaviour).
 */
export function activeHeadingIndex(headings: OutlineHeading[], pos: number): number {
  let index = -1
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].from <= pos) index = i
    else break
  }
  return index
}
