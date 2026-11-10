import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { StickyNote } from 'lucide-react'
import { NoteMarkdown } from './NoteMarkdown'
import { versionParagraphs } from '../../../shared/folio-version-paragraphs'
import { VERSION_CUT_REASON, type VersionTextSide } from '../../../shared/folio-version-scratchpad'
import { registerVersionSelection, sendVersionSelection, type VersionSelection } from '../scratchpad/version-send'

/**
 * Send a copy to the Scratchpad from the text of a saved Folio version (ADR-0052 § Sending text to the Scratchpad; Folio versions ticket
 * 10), in the read-only view and in Compare. NOTHING HERE WRITES OR EDITS: the text is drawn read only; a paragraph has a gutter icon
 * (on hover and on keyboard focus) and a selected run shows the Scratchpad's bubble (Send a copy to Scratchpad, Copy, Cut disabled). Both
 * name the paragraphs by NUMBER; main reads the saved copy itself and writes the Scratchpad item (`scratchpad/version-send.ts`).
 *
 * A "unit" is anything that carries `data-fv-unit` with its source (`data-fv-id`, `data-fv-path`, `data-fv-side`) and the paragraph
 * numbers it stands for (`data-fv-from`, `data-fv-to`). A selection is sent as the range from the first to the last unit it touches,
 * and only when they all come from one source.
 */

export type UnitSource = { id: string; path: string; side: VersionTextSide }

/** The attributes that make an element a unit of text that can be sent. */
export const unitAttributes = (source: UnitSource, from: number, to: number) => ({
  'data-fv-unit': '', 'data-fv-id': source.id, 'data-fv-path': source.path, 'data-fv-side': source.side, 'data-fv-from': String(from), 'data-fv-to': String(to),
})

const paragraphLabel = (from: number, to: number): string => (from === to ? `paragraph ${from}` : `paragraphs ${from} to ${to}`)

/** The gutter icon of a unit. Visible on hover and on keyboard focus; always in the Tab order. */
export function SendUnitButton({ dir, source, from, to }: { dir: string; source: UnitSource; from: number; to: number }): JSX.Element {
  return (
    <button type="button" className="fvb-send" data-testid="send-unit" aria-label={`Send ${paragraphLabel(from, to)} to the Scratchpad`} title="Send a copy to Scratchpad"
      onClick={(event) => { event.preventDefault(); void sendVersionSelection({ dir, ...source, from, to }) }}>
      <StickyNote aria-hidden="true" />
    </button>
  )
}

/** A part's saved text, one unit per paragraph: each with its gutter icon, drawn by the app's own Markdown reader. */
export function VersionBlocks({ dir, source, text }: { dir: string; source: UnitSource; text: string }): JSX.Element {
  const blocks = useMemo(() => versionParagraphs(text).map((paragraph) => ({ n: paragraph.n, markdown: text.slice(paragraph.from, paragraph.to) })), [text])
  return (
    <>
      {blocks.map((block) => (
        <div key={block.n} className="fvb" {...unitAttributes(source, block.n, block.n)} data-testid="reading-block">
          <SendUnitButton dir={dir} source={source} from={block.n} to={block.n} />
          <NoteMarkdown text={block.markdown} />
        </div>
      ))}
    </>
  )
}

type Held = { selection: VersionSelection; rect: { left: number; top: number; bottom: number }; text: string }

/** Whether `range` holds any text of `unit` (a boundary that only touches the unit does not count). */
function holdsTextOf(range: Range, unit: HTMLElement): boolean {
  const inside = document.createRange()
  inside.selectNodeContents(unit)
  if (range.compareBoundaryPoints(Range.START_TO_END, inside) <= 0) return false
  if (range.compareBoundaryPoints(Range.END_TO_START, inside) >= 0) return false
  const common = range.cloneRange()
  if (common.compareBoundaryPoints(Range.START_TO_START, inside) < 0) common.setStart(inside.startContainer, inside.startOffset)
  if (common.compareBoundaryPoints(Range.END_TO_END, inside) > 0) common.setEnd(inside.endContainer, inside.endOffset)
  return common.toString().trim() !== ''
}

/** The selection inside `root`, as the paragraphs it touches, or null (nothing selected, or text of more than one source). */
export function readUnitSelection(root: HTMLElement, dir: string): Held | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const units = [...root.querySelectorAll<HTMLElement>('[data-fv-unit][data-fv-id]')].filter((unit) => range.intersectsNode(unit) && holdsTextOf(range, unit))
  const first = units[0]
  if (!first) return null
  const { fvId, fvPath, fvSide } = first.dataset
  if (!units.every((unit) => unit.dataset.fvId === fvId && unit.dataset.fvPath === fvPath && unit.dataset.fvSide === fvSide)) return null
  const numbers = units.flatMap((unit) => [Number(unit.dataset.fvFrom), Number(unit.dataset.fvTo)])
  if (numbers.some((n) => !Number.isSafeInteger(n) || n < 1) || !fvId || !fvPath || !fvSide) return null
  const rect = range.getBoundingClientRect()
  return { selection: { dir, id: fvId, path: fvPath, side: fvSide as VersionTextSide, from: Math.min(...numbers), to: Math.max(...numbers) }, rect: { left: rect.left, top: rect.top, bottom: rect.bottom }, text: selection.toString() }
}

/**
 * The Scratchpad's bubble over a selection of saved text, and the registration that lets the existing "Send a copy to Scratchpad" command send
 * the same selection. Returns the bubble to draw. `root` is the element whose units may be selected.
 */
export function useVersionSelectionBubble(root: React.RefObject<HTMLElement | null>, dir: string): JSX.Element | null {
  const [held, setHeld] = useState<Held | null>(null)
  const last = useRef<Held | null>(null)
  useEffect(() => {
    const onChange = (): void => {
      const element = root.current
      if (!element) return
      const found = readUnitSelection(element, dir)
      if (found) { last.current = found; setHeld(found); return }
      setHeld(null)
      // A selection that moved out of the text (to the palette's field, say) is remembered for the command; one collapsed inside it is not.
      const anchor = window.getSelection()?.anchorNode ?? null
      if (anchor && element.contains(anchor)) last.current = null
    }
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [root, dir])
  useEffect(() => registerVersionSelection(() => last.current?.selection ?? null), [])
  // The bubble leaves with the send: the selection is let go, as the editor's bubble does once its copy is made.
  const send = useCallback((): void => { if (held) { void sendVersionSelection(held.selection); window.getSelection()?.removeAllRanges() } }, [held])
  const copy = useCallback((): void => {
    if (!held) return
    void navigator.clipboard?.writeText(held.text).catch(() => undefined)
  }, [held])
  const shown = held
  if (!shown) return null
  const count = shown.selection.to - shown.selection.from + 1
  const width = 420
  const left = Math.round(Math.min(Math.max(shown.rect.left, 8), Math.max(8, window.innerWidth - width - 8)))
  const top = shown.rect.top - 46 >= 50 ? Math.round(shown.rect.top - 46) : Math.round(shown.rect.bottom + 8)
  return createPortal(
    <div className="sp-bubble" role="toolbar" aria-label="Send the selection to the Scratchpad" data-testid="version-bubble" style={{ left, top }}
      onMouseDown={(event) => event.preventDefault()}>
      <span className="sp-bubble-count">{count === 1 ? '1 paragraph selected' : `${count} paragraphs selected`}</span>
      <button type="button" data-testid="bubble-send" onClick={(event) => { event.preventDefault(); send() }}>Send a copy to Scratchpad</button>
      <button type="button" data-testid="bubble-copy" onClick={(event) => { event.preventDefault(); copy() }}>Copy</button>
      <button type="button" data-testid="bubble-cut" aria-disabled="true" title={VERSION_CUT_REASON} onClick={(event) => event.preventDefault()}>Cut to Scratchpad</button>
    </div>,
    document.body,
  )
}
