import { metadataWorkspace } from './metadata-view-state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState, Facet, Prec, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from '@codemirror/view'
import { extractOutlineOfState } from './outline'
import { WidgetBlockWidget } from './live-preview-widget-block'
import { embedLine } from '../../../shared/markdown/embed-line'
import { CodeWidget, FrontmatterWidget, ImageWidget, MarkmapWidget, MermaidWidget, QueryWidget, SvgWidget, TableWidget } from './live-preview-widgets'
import { changeMarkRanges } from './change-marks'
import { skipWriterReviewTracking } from './writer-review'
import { inlineChangeRanges } from './inline-changes'
import { renumberFootnotes } from './insert-objects'
import { mountObjectEditor, objectEditorReplacement } from './object-editors/registry'
import { reportRendererError } from '../app/RendererErrorBoundary'
import { editorViewModeOf } from './view-mode'

export type LivePreviewKind = 'frontmatter' | 'image' | 'table' | 'code' | 'mermaid' | 'markmap' | 'query' | 'svg' | 'widget'
export type LivePreviewBlock = { kind: LivePreviewKind; from: number; to: number; source: string; language?: string; url?: string; alt?: string }
export type TextRange = { from: number; to: number }

export function widgetKindForFenceLanguage(language: string): Extract<LivePreviewKind, 'code' | 'mermaid' | 'markmap' | 'query' | 'svg'> {
  const normalised = language.toLowerCase()
  return normalised === 'mermaid' || normalised === 'markmap' || normalised === 'query' || normalised === 'svg' ? normalised : 'code'
}

export function intersectsPendingChange(block: TextRange, changes: TextRange[]): boolean {
  return changes.some((change) => change.from < block.to && change.to > block.from)
}

export function rendersBlockWithPendingChange(kind: LivePreviewKind): boolean {
  return kind === 'frontmatter'
}

export function blockHasPendingChange(state: EditorState, block: TextRange): boolean {
  return intersectsPendingChange(block, [...changeMarkRanges(state), ...inlineChangeRanges(state)])
}

function lineEndWithBreak(state: EditorState, lineNumber: number): number {
  const line = state.doc.line(lineNumber)
  return line.to < state.doc.length ? line.to + 1 : line.to
}

export function detectLivePreviewBlocks(state: EditorState, from = 0, to = state.doc.length): LivePreviewBlock[] {
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, to), 50) ?? syntaxTree(state)
  const blocks: LivePreviewBlock[] = []
  if (state.doc.lines >= 2 && state.doc.line(1).text === '---') {
    for (let lineNumber = 2; lineNumber <= state.doc.lines; lineNumber += 1) {
      const line = state.doc.line(lineNumber)
      if (line.text !== '---') continue
      const end = lineEndWithBreak(state, lineNumber)
      if (from < end && to > 0) blocks.push({ kind: 'frontmatter', from: 0, to: end, source: state.doc.sliceString(0, end) })
      break
    }
  }
  tree.iterate({
    from: Math.max(0, from),
    to: Math.min(state.doc.length, to),
    enter(node) {
      const startLine = state.doc.lineAt(node.from)
      const endLine = state.doc.lineAt(node.to)
      const end = lineEndWithBreak(state, endLine.number)
      if (node.name === 'Paragraph') {
        const raw = state.doc.sliceString(node.from, node.to)
        // An embed line alone in its paragraph runs a widget (one block per line, as the model does);
        // `[Embed: web address]` stays text until the refusal notices of ticket 04.
        const embeds = raw.split('\n').map((text) => embedLine(text.replace(/\r$/, '')))
        if (embeds.every((embed) => embed && !embed.refusal) && node.node.parent?.name === 'Document') {
          for (let number = startLine.number; number <= endLine.number; number += 1) {
            const line = state.doc.line(number)
            const embed = embedLine(line.text)
            if (!embed) continue
            blocks.push({ kind: 'widget', from: line.from, to: lineEndWithBreak(state, number), source: line.text.trim(), url: embed.path })
          }
          return false
        }
        const image = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)\s*$/.exec(raw)
        if (!image) return
        blocks.push({ kind: 'image', from: startLine.from, to: end, source: state.doc.sliceString(startLine.from, end), alt: image[1], url: image[2] })
        return false
      }
      if (node.name === 'Table') {
        // GFM absorbs a touching prose line as another table row; keep such lines OUT of the widget
        // (walk find 2026-07-12: typed text vanished into the rendered table) — the block ends at the
        // last line that actually contains a pipe.
        let lastPipeLine = endLine
        while (lastPipeLine.number > startLine.number && !lastPipeLine.text.includes('|')) {
          lastPipeLine = state.doc.line(lastPipeLine.number - 1)
        }
        const tableEnd = lineEndWithBreak(state, lastPipeLine.number)
        blocks.push({ kind: 'table', from: startLine.from, to: tableEnd, source: state.doc.sliceString(startLine.from, tableEnd) })
        return false
      }
      if (node.name === 'FencedCode') {
        const source = state.doc.sliceString(startLine.from, end)
        const info = /^\s*```([^\n`]*)/.exec(source)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? []
        const language = info[0] ?? ''
        // Object → code keeps the object's useful language tag and adds one structural `code`
        // marker. Without it legacy/plain ```mermaid and ```markmap fences remain rendered objects.
        const kind = info.slice(1).some((token) => token.toLowerCase() === 'code')
          ? 'code'
          : widgetKindForFenceLanguage(language)
        blocks.push({ kind, from: startLine.from, to: end, source, language })
        return false
      }
    },
  })
  return blocks.sort((a, b) => a.from - b.from)
}

/** Metadata-like source that can no longer be parsed because its opening fence moved or never closed. */
export function malformedFrontmatterRange(doc: string): TextRange | null {
  const lines = doc.split('\n'); let offset = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line !== '---') { offset += line.length + 1; continue }
    let end = doc.length; let innerEnd = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor] !== '---') continue
      innerEnd = cursor
      end = lines.slice(0, cursor + 1).join('\n').length + (cursor < lines.length - 1 ? 1 : 0)
      break
    }
    const metadataLike = lines.slice(index + 1, innerEnd).some((candidate) => /^(?:[A-Za-z0-9_-]+|"[^"]+"|'[^']+')\s*:/.test(candidate))
    if (metadataLike && (index > 0 || innerEnd === lines.length)) return { from: offset, to: end }
    return null
  }
  return null
}

export function blockJumpTarget(blocks: TextRange[], pos: number, direction: 1 | -1): number | null {
  const ordered = [...blocks].sort((a, b) => a.from - b.from)
  const target = direction > 0 ? ordered.find((block) => block.from > pos) : ordered.reverse().find((block) => block.from < pos)
  return target?.from ?? null
}

export function shouldProtectBackspaceAfterBlock(blocks: TextRange[], pos: number): boolean {
  return blocks.some((block) => block.to === pos)
}

export function headingJumpTarget(state: EditorState, pos: number, direction: 1 | -1): number | null {
  const headings = extractOutlineOfState(state, state.doc.toString())
  const target = direction > 0 ? headings.find((heading) => heading.from > pos) : [...headings].reverse().find((heading) => heading.from < pos)
  return target?.from ?? null
}

type OpenBlock = { from: number; to: number } | null
export const setOpenLivePreviewBlock = StateEffect.define<OpenBlock>({
  map: (value, mapping) => (value ? { from: mapping.mapPos(value.from, -1), to: mapping.mapPos(value.to, 1) } : value),
})
const openBlockField = StateField.define<OpenBlock>({
  create: () => null,
  update(value, tr) {
    const effect = tr.effects.find((item) => item.is(setOpenLivePreviewBlock))
    if (effect) return effect.value
    if (!value || !tr.docChanged) return value
    // Edge assoc GROWS the open region: typing at its end (a new table row, a new outline node)
    // stays inside the editing state instead of falling out of it (walk find 2026-07-12).
    const from = tr.changes.mapPos(value.from, -1), to = tr.changes.mapPos(value.to, 1)
    return from < to ? { from, to } : null
  },
})

function localAssetUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  return `${base.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`
}

export function widgetFor(block: LivePreviewBlock, assetBaseUrl: string, selected: boolean, pending: boolean, documentPath: string | null = null): WidgetType {
  if (block.kind === 'frontmatter') return new FrontmatterWidget(block.source, selected, pending, documentPath, (view) => {
    if (blockHasPendingChange(view.state, block)) view.state.facet(livePreviewConfig).onPendingMetadataEdit?.()
    view.dispatch({ selection: { anchor: block.from }, effects: setOpenLivePreviewBlock.of(block), scrollIntoView: true })
    view.focus()
  })
  if (block.kind === 'image') return new ImageWidget(block.source, localAssetUrl(assetBaseUrl, block.url ?? ''), block.alt ?? '', selected)
  if (block.kind === 'table') return new TableWidget(block.source, selected)
  if (block.kind === 'mermaid') return new MermaidWidget(block.source, selected)
  if (block.kind === 'markmap') return new MarkmapWidget(block.source, selected)
  if (block.kind === 'query') return new QueryWidget(block, selected, {
    edit(view) {
      view.dispatch({ selection: { anchor: block.from }, effects: setOpenLivePreviewBlock.of(block), scrollIntoView: true })
      view.focus()
    },
    sort(view, replacement) {
      view.dispatch({
        changes: { from: block.from, to: block.to, insert: replacement },
        selection: { anchor: block.from },
        annotations: [skipWriterReviewTracking.of(true)],
        scrollIntoView: true,
      })
      view.focus()
    },
  })
  if (block.kind === 'svg') return new SvgWidget(block.source, selected)
  return new CodeWidget(block.source, block.language ?? '', selected)
}

const editHints: Record<LivePreviewKind, string> = {
  frontmatter: 'editing metadata',
  table: 'editing table source — pipes make columns',
  code: 'editing ``` code',
  mermaid: 'mermaid flowchart',
  markmap: 'one node per line — indent to nest',
  query: 'editing query source — one key per line',
  svg: 'SVG illustration',
  image: 'image link',
  widget: 'widget line',
}

class DoneWidget extends WidgetType {
  constructor(readonly block: LivePreviewBlock) { super() }
  eq(other: WidgetType): boolean { return other instanceof DoneWidget && other.block.kind === this.block.kind && other.block.from === this.block.from && other.block.to === this.block.to }
  toDOM(view: EditorView): HTMLElement {
    const bar = document.createElement('div'); bar.className = 'lp-editbar'
    const text = document.createElement('span'); text.className = 'grow'; text.textContent = editHints[this.block.kind]
    const button = document.createElement('button'); button.type = 'button'; button.className = 'lp-done'; button.innerHTML = '✓ Done <kbd>⌘↵</kbd>'
    button.addEventListener('click', () => { view.dispatch({ selection: { anchor: this.block.from }, effects: setOpenLivePreviewBlock.of(null), scrollIntoView: true }); view.focus() })
    bar.append(text, button); return bar
  }
  ignoreEvent(): boolean { return false }
}

class ObjectEditorWidget extends WidgetType {
  constructor(readonly block: LivePreviewBlock) { super() }
  eq(other: WidgetType): boolean { return other instanceof ObjectEditorWidget && other.block.kind === this.block.kind && other.block.from === this.block.from && other.block.to === this.block.to && other.block.source === this.block.source }
  toDOM(view: EditorView): HTMLElement {
    const commit = (inner: string): boolean => {
      const replacement = objectEditorReplacement(this.block, inner)
      const refusal = objectEditorCommitRefusal(this.block, view.state.doc.toString(), replacement)
      if (refusal) {
        const message = `[error] ObjectEditor commit refused: ${refusal}`
        console.error(message)
        void reportRendererError(new Error(message))
        return false
      }
      // Replace ONLY the block's range (a full-doc replace remaps every writer mark in the file),
      // and OUTSIDE track-changes: in Reviewing mode the filter turned this into old-table-struck +
      // new-table-inserted — raw-buffer soup no table can render from (C4 review find, 2026-07-12).
      // Reviewable object edits need their own designed diff surface — a v2 round.
      view.dispatch({
        changes: { from: this.block.from, to: Math.min(this.block.to, view.state.doc.length), insert: replacement },
        selection: { anchor: this.block.from },
        effects: setOpenLivePreviewBlock.of(null),
        annotations: [skipWriterReviewTracking.of(true)],
        scrollIntoView: true,
      })
      const committed = detectLivePreviewBlocks(view.state).find((item) => item.from === this.block.from)
      if (committed?.kind !== this.block.kind) {
        const message = `[warning] ObjectEditor commit no longer detects as ${this.block.kind}.\nBefore:\n${this.block.source}\nAfter:\n${replacement}`
        console.error(message)
        void reportRendererError(new Error(message))
      }
      // Metadata edits own the header only, even when the body has non-canonical footnote numbering.
      if (this.block.kind !== 'frontmatter') {
        const footnotes = renumberFootnotes(view.state.doc.toString())
        if (footnotes) view.dispatch({ changes: footnotes.changes, annotations: [skipWriterReviewTracking.of(true)] })
      }
      view.focus()
      return true
    }
    /**
     * Leave the editor WITHOUT touching the document: the selection lands where the block starts
     * and the open-block effect clears, exactly as the Done button does for an image.
     *
     * A transaction with no changes is never its own undo step (CM's history folds a bare
     * selection into the last change event's `selectionsAfter`), which is the whole point: closing
     * an editor the writer never typed in must cost the undo stack nothing.
     */
    const close = (): void => {
      view.dispatch({ selection: { anchor: this.block.from }, effects: setOpenLivePreviewBlock.of(null), scrollIntoView: true })
      view.focus()
    }
    // The slot carries the editor's vertical spacing as padding: CodeMirror measures a block widget's
    // box without its margin, and a margin here desynchronises its height map (keys move by screen position).
    const slot = document.createElement('div')
    slot.className = 'oe-slot'
    slot.append(mountObjectEditor(this.block, { commit, close }, { workspace: metadataWorkspace(view.dom), path: view.state.facet(livePreviewConfig).documentPath() }) ?? new DoneWidget(this.block).toDOM(view))
    return slot
  }
  // The EDITING widget owns its events entirely — with false, CM processed clicks inside the
  // editor and yanked focus back to the document (C4.1 review find: cell/node clicks dead).
  ignoreEvent(): boolean { return true }
  destroy(dom: HTMLElement): void {
    // Teardown without an explicit Done (live-preview toggle, view swap) still commits; the
    // fail-closed range guard turns stale cross-file commits into safe no-ops (C7.2 review find).
    // DEFERRED: destroy runs inside CM's update cycle, where dispatch is forbidden.
    const commit = ((dom.firstElementChild ?? dom) as HTMLElement & { __wfCommit?: () => void }).__wfCommit
    if (commit) queueMicrotask(commit)
  }
}

export function objectEditorCommitRefusal(block: LivePreviewBlock, currentDoc: string, replacement: string): string | null {
  if (block.source.trim() !== '' && replacement.trim() === '') return 'replacement was empty while the original block was not'
  if (currentDoc.slice(block.from, block.to) !== block.source) return 'the editor shell was stale and no longer matched the active document'
  return null
}

export function shouldEscapeAboveBlock(block: Pick<LivePreviewBlock, 'kind' | 'from'>): boolean {
  return block.kind !== 'frontmatter' && block.from === 0
}

/** What a document (not a caret) decides: the blocks and the ranges that colour them. A bare caret
 *  move leaves all of it alone, so it is kept and only the selection-dependent decorations are redone. */
type PreviewStructure = { blocks: LivePreviewBlock[]; pendingRanges: TextRange[]; malformedMetadata: TextRange | null }
type PreviewState = {
  blocks: LivePreviewBlock[]
  decorations: DecorationSet
  atomic: DecorationSet
  /** Null in raw mode, where nothing is rendered. */
  structure: PreviewStructure | null
  /** Per block: is a selection head on it (the only selection-dependent input to the decorations)? */
  selected: boolean[]
}

/** Half-open: block.to is the NEXT line's start (the atomic skip lands there), which must not
 *  read as "still on the block". A block ending at EOF keeps the inclusive end (nowhere past it). */
function selectedFlagsOf(state: EditorState, blocks: LivePreviewBlock[]): boolean[] {
  return blocks.map((block) => {
    const onBlock = (head: number): boolean => head >= block.from && (head < block.to || (block.to >= state.doc.length && head <= block.to))
    return state.selection.ranges.some((selection) => onBlock(selection.head))
  })
}

/** {@link malformedFrontmatterRange} for a live document, reading only as far as the first fence's
 *  closing partner (the function looks no further) instead of copying and splitting the whole text. */
export function malformedFrontmatterRangeOf(state: EditorState): TextRange | null {
  const { doc } = state
  let seen = 0
  let readTo = -1
  let offset = 0
  for (const line of doc.iterLines()) {
    if (line === '---') {
      seen += 1
      if (seen === 2) { readTo = Math.min(doc.length, offset + line.length + 1); break }
    }
    offset += line.length + 1
  }
  if (seen === 0) return null
  return malformedFrontmatterRange(readTo >= 0 ? doc.sliceString(0, readTo) : doc.toString())
}

const sameFlags = (a: boolean[], b: boolean[]): boolean => a.length === b.length && a.every((flag, index) => flag === b[index])

/** Block decorations MUST come from state, never a ViewPlugin — CM6's tile DocView hard-crashes on
 *  plugin-provided block replaces (C1 review find, 2026-07-11: "Cannot destructure property 'tile'").
 *  The whole document is scanned (no viewport limit — a StateField has no view); detect is a single
 *  tree iteration, cheap at prose scale. */
function buildPreview(state: EditorState): PreviewState {
  if (editorViewModeOf(state) === 'raw') return { blocks: [], decorations: Decoration.none, atomic: Decoration.none, structure: null, selected: [] }
  const structure: PreviewStructure = {
    blocks: detectLivePreviewBlocks(state),
    pendingRanges: [...changeMarkRanges(state), ...inlineChangeRanges(state)],
    malformedMetadata: malformedFrontmatterRangeOf(state),
  }
  return composePreview(state, structure, selectedFlagsOf(state, structure.blocks))
}

function composePreview(state: EditorState, structure: PreviewStructure, selectedFlags: boolean[]): PreviewState {
  const open = state.field(openBlockField)
  const { blocks, pendingRanges, malformedMetadata } = structure
  const config = state.facet(livePreviewConfig)
  const ranges: Range<Decoration>[] = []
  const atomicRanges: Range<Decoration>[] = []
  if (malformedMetadata) ranges.push(Decoration.mark({ class: 'lp-malformed-frontmatter-source' }).range(malformedMetadata.from, malformedMetadata.to))
  if (open) {
    const block = blocks.find((item) => item.from === open.from)
    if (block) {
      const lastLineEnd = state.doc.lineAt(Math.max(block.from, block.to - 1)).to
      if (block.kind === 'image') {
        let line = state.doc.lineAt(open.from)
        while (line.from < open.to) { ranges.push(Decoration.line({ class: 'lp-editing-line' }).range(line.from)); if (line.number >= state.doc.lines) break; line = state.doc.line(line.number + 1) }
        ranges.push(Decoration.widget({ widget: new DoneWidget(block), side: 1, block: true }).range(lastLineEnd))
      } else {
        ranges.push(Decoration.replace({ widget: new ObjectEditorWidget(block), block: true }).range(block.from, lastLineEnd))
      }
    }
  }
  for (const [blockIndex, block] of blocks.entries()) {
    const pending = intersectsPendingChange(block, pendingRanges)
    // ADR-0018 consequence, metadata exception : ordinary blocks show
    // pending diffs as source, but frontmatter always stays the clickable form and carries a badge.
    if ((open && block.from === open.from) || (pending && !rendersBlockWithPendingChange(block.kind))) continue
    const selected = selectedFlags[blockIndex]!
    if (block.kind === 'widget') {
      // The widget goes after its line; the line itself is hidden unless the cursor is on it.
      const line = state.doc.lineAt(block.from)
      ranges.push(Decoration.line({ class: selected ? 'wf-widget-line wf-widget-line-open' : 'wf-widget-line' }).range(line.from))
      ranges.push(Decoration.widget({ widget: new WidgetBlockWidget(block.source, block.url ?? '', config.documentPath() ?? ''), side: 1, block: true }).range(line.to))
      continue
    }
    // Replace ranges stop at the last line's END (never swallowing the line break); the selection
    // outline lives on the widget itself — both required by CM's tile geometry.
    const lastLineEnd = state.doc.lineAt(Math.max(block.from, block.to - 1)).to
    const deco = Decoration.replace({ widget: widgetFor(block, config.assetBaseUrl(), selected, pending, config.documentPath()), block: true })
    ranges.push(deco.range(block.from, lastLineEnd))
    // The ATOMIC range swallows the trailing line break too, so one ↓ from the block steps fully
    // past it (mockup grammar: land on, then move past) — while the visual replace stops at the
    // line end, which is what CM's tile geometry requires.
    atomicRanges.push(deco.range(block.from, Math.min(state.doc.length, lastLineEnd + 1)))
  }
  return { blocks, decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomicRanges, true), structure, selected: selectedFlags }
}

const previewField = StateField.define<PreviewState>({
  create: buildPreview,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && !tr.effects.length) return value
    if (!tr.docChanged && !tr.effects.length && value.structure) {
      // A caret move alone: the blocks, pending ranges and metadata are unchanged, and the
      // decorations only differ when a block gained or lost the caret.
      const selected = selectedFlagsOf(tr.state, value.structure.blocks)
      return sameFlags(selected, value.selected) ? value : composePreview(tr.state, value.structure, selected)
    }
    return buildPreview(tr.state)
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
  ],
})

type PreviewConfig = { onPendingMetadataEdit?: () => void; assetBaseUrl: () => string; pendingRanges: () => TextRange[]; documentPath: () => string | null }
const livePreviewConfig = Facet.define<PreviewConfig, PreviewConfig>({
  combine: (values) => values[0] ?? { assetBaseUrl: () => '', pendingRanges: () => [], documentPath: () => null },
})

export function livePreviewBlocks(state: EditorState): LivePreviewBlock[] {
  return state.field(previewField, false)?.blocks ?? []
}

export function activeBlock(view: EditorView): LivePreviewBlock | undefined {
  const pos = view.state.selection.main.head
  const docLength = view.state.doc.length
  return livePreviewBlocks(view.state).find((block) => pos >= block.from && (pos < block.to || (block.to >= docLength && pos <= block.to)))
}

const previewEventHandlers = (onPendingMetadataEdit?: () => void): Extension => EditorView.domEventHandlers({
  mousedown(event, view) {
    const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-live-preview-block]')
    if (!el) return false
    const pos = view.posAtDOM(el)
    // Double-click opens HERE (event.detail counts the click run): the first click's selection
    // outline re-renders the widget, so a separate dblclick handler saw a detached target and
    // silently did nothing (C4 review find).
    const block = event.detail >= 2 ? livePreviewBlocks(view.state).find((item) => pos >= item.from && pos <= item.to) : undefined
    if (block) {
      if (block.kind === 'frontmatter' && blockHasPendingChange(view.state, block)) onPendingMetadataEdit?.()
      view.dispatch({ selection: { anchor: block.from }, effects: setOpenLivePreviewBlock.of(block) })
    }
    else view.dispatch({ selection: { anchor: pos } })
    view.focus()
    return true
  },
})

/**
 * A widget's embed line is hidden (one pixel) until the cursor is on it, and CodeMirror's vertical
 * motion steps over a line that thin, from either side. A vertical step into a widget's line lands on
 * it, which opens it (the drawing's "cursor on the block"); the step after that leaves it onto the
 * very next line. Either end of the step being such a line, the move is by document line, not by
 * screen position.
 */
function stepOntoWidgetLine(view: EditorView, direction: 1 | -1): boolean {
  const { state } = view
  const selection = state.selection.main
  const open = state.field(openBlockField)
  if (!selection.empty || state.selection.ranges.length > 1 || (open && selection.head >= open.from && selection.head <= open.to)) return false
  const line = state.doc.lineAt(selection.head)
  const next = line.number + direction
  if (next < 1 || next > state.doc.lines) return false
  const target = state.doc.line(next)
  const widgetLines = livePreviewBlocks(state).filter((block) => block.kind === 'widget')
  if (!widgetLines.some((block) => block.from === target.from || block.from === line.from)) return false
  view.dispatch({ selection: { anchor: Math.min(target.to, target.from + (selection.head - line.from)) }, scrollIntoView: true, userEvent: 'select' })
  return true
}

/** Rendered-block navigation (registry commands navigation.nextBlock / previousBlock). */
export function jumpToBlock(view: EditorView, direction: 1 | -1): boolean { return jump(view, 'block', direction) }

function jump(view: EditorView, kind: 'block' | 'heading', direction: 1 | -1): boolean {
  const pos = view.state.selection.main.head
  const target = kind === 'block' ? blockJumpTarget(livePreviewBlocks(view.state), pos, direction) : headingJumpTarget(view.state, pos, direction)
  if (target == null) return false
  view.dispatch({ selection: { anchor: target }, effects: setOpenLivePreviewBlock.of(null), scrollIntoView: true })
  return true
}

/** `objects` marks the backtick trigger: it opens the object list itself, not the place's actions. */
export type LivePreviewCommand = { x: number; y: number; block: LivePreviewBlock | null; objects?: true }
export function livePreview(opts: { assetBaseUrl: () => string; documentPath?: () => string | null; pendingRanges?: () => TextRange[]; overlayOpen?: () => boolean; onCommandK?: (command: LivePreviewCommand) => void; onPendingMetadataEdit?: () => void }): Extension {
  // Typing the third backtick of ``` on an otherwise-empty line summons the INSERT MENU instead of
  // planting an unbalanced fence — a hand-typed ``` swallowed everything below it into one broken
  // code block (walk find 2026-07-12). The two typed backticks are removed; the menu's own insert
  // actions plant balanced skeletons.
  // Typing while a closed block is selected must never edit the block's source (walk find
  // 2026-07-12: keystrokes corrupted the table header). The text lands on a fresh
  // blank-line-separated paragraph below the block instead.
  const typeEscape = EditorView.inputHandler.of((view, from, to, text) => {
    if (view.state.field(openBlockField)) return false
    const blocks = view.state.field(previewField, false)?.blocks ?? []
    const block = blocks.find((item) => from >= item.from && from < item.to)
    // A widget's embed line is real, editable text (its block sits after it).
    if (!block || block.kind === 'widget') return false
    const insertAt = Math.min(block.to, view.state.doc.length)
    const needsGap = view.state.doc.sliceString(insertAt, Math.min(insertAt + 1, view.state.doc.length)) !== '\n'
    const lead = insertAt >= view.state.doc.length || needsGap ? '\n\n' : '\n'
    view.dispatch({
      changes: { from: insertAt, insert: `${lead}${text}` },
      selection: { anchor: insertAt + lead.length + text.length },
      scrollIntoView: true,
    })
    return true
  })

  const fenceTrigger = EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== '`' || !opts.onCommandK || opts.overlayOpen?.()) return false
    const line = view.state.doc.lineAt(from)
    if (view.state.doc.sliceString(line.from, from) !== '``') return false
    if (view.state.doc.sliceString(to, line.to).trim() !== '') return false
    view.dispatch({ changes: { from: line.from, to }, selection: { anchor: line.from } })
    const coords = view.coordsAtPos(line.from)
    if (coords) opts.onCommandK({ x: coords.left, y: coords.bottom + 4, block: null, objects: true })
    return true
  })
  return [
    typeEscape,
    fenceTrigger,
    openBlockField, livePreviewConfig.of({ assetBaseUrl: opts.assetBaseUrl, pendingRanges: opts.pendingRanges ?? (() => []), documentPath: opts.documentPath ?? (() => null), onPendingMetadataEdit: opts.onPendingMetadataEdit }),
    previewField,
    previewEventHandlers(opts.onPendingMetadataEdit),
    // High precedence: ↵-on-a-block must win over the default insertNewline (which would otherwise
    // MUTATE the document instead of opening the block — the exact opposite of the locked model).
    Prec.high(keymap.of([
      {
        key: 'Enter',
        run(view) {
          // Inside an OPEN block ↵ is a plain newline — new table rows, new outline nodes
          // (walk find 2026-07-12: "cannot add lines"). Only a closed, selected block opens.
          const open = view.state.field(openBlockField)
          const head = view.state.selection.main.head
          if (open && head >= open.from && head <= open.to) return false
          const block = activeBlock(view)
          if (!block || block.kind === 'widget') return false
          if (block.kind === 'frontmatter' && blockHasPendingChange(view.state, block)) opts.onPendingMetadataEdit?.()
          view.dispatch({ selection: { anchor: block.from }, effects: setOpenLivePreviewBlock.of(block), scrollIntoView: true })
          return true
        },
      },
      {
        key: 'ArrowDown',
        run(view) {
          if (stepOntoWidgetLine(view, 1)) return true
          // A trailing block must always be escapable: ↓ from a selected block with nothing after
          // it CREATES the line to land on (walk find 2026-07-12: "no way I can add anything after").
          if (view.state.field(openBlockField)) return false
          const block = activeBlock(view)
          if (!block || block.to < view.state.doc.length) return false
          view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\n' }, selection: { anchor: view.state.doc.length + 2 }, scrollIntoView: true })
          return true
        },
      },
      {
        key: 'Backspace',
        run(view) {
          if (view.state.field(openBlockField) || !view.state.selection.main.empty) return false
          return shouldProtectBackspaceAfterBlock(livePreviewBlocks(view.state), view.state.selection.main.head)
        },
      },
      {
        key: 'ArrowRight',
        run(view) {
          // → from a selected block moves to just after it (creating the line at doc end).
          if (view.state.field(openBlockField)) return false
          const block = activeBlock(view)
          if (!block || block.kind === 'widget') return false
          if (block.to >= view.state.doc.length) {
            view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\n' }, selection: { anchor: view.state.doc.length + 2 }, scrollIntoView: true })
          } else {
            view.dispatch({ selection: { anchor: Math.min(block.to, view.state.doc.length) }, scrollIntoView: true })
          }
          return true
        },
      },
      {
        key: 'ArrowUp',
        run(view) {
          if (stepOntoWidgetLine(view, -1)) return true
          // Symmetric: ↑ from a leading block at the document start creates a line above it.
          if (view.state.field(openBlockField)) return false
          const block = activeBlock(view)
          if (!block || !shouldEscapeAboveBlock(block)) return block?.kind === 'frontmatter'
          view.dispatch({ changes: { from: 0, insert: '\n\n' }, selection: { anchor: 0 }, scrollIntoView: true })
          return true
        },
      },
      { key: 'Mod-Enter', run(view) { const open = view.state.field(openBlockField); if (!open) return false; view.dispatch({ selection: { anchor: open.from }, effects: setOpenLivePreviewBlock.of(null), scrollIntoView: true }); return true } },
      { key: 'Mod-k', preventDefault: true, run(view) {
        if (opts.overlayOpen?.()) return false
        const block = activeBlock(view) ?? null
        const coords = view.coordsAtPos(block?.from ?? view.state.selection.main.head)
        if (!coords) return false
        opts.onCommandK?.({ x: coords.left, y: coords.bottom + 4, block })
        return true
      } },
    ])),
  ]
}
