import { Fragment, type ReactNode } from 'react'
import { readDocument, type Block, type Inline } from '../../../shared/markdown/model'
import { readTaskLines, type TaskLine } from '../../../shared/markdown/task-lines'
import { safeUrl } from '../../../shared/markdown/url-safety'

/**
 * Tickable boxes (checkbox-lists ticket 04, hifi-direction-1 frame 10). Given, each task item's box is
 * a real checkbox that reports its item — by the line it sits on in `text` — and `extra` may add to
 * the item (a pending agent proposal). Without it, boxes are drawn but cannot be ticked.
 */
export type NoteTasks = {
  onToggle: (item: TaskLine) => void
  extra?: (item: TaskLine) => ReactNode
}

/** The task items as the renderer walks them, paired with their lines — or null when the two readings
 *  disagree (a box in a footnote definition, say), in which case no box is tickable rather than the
 *  wrong one. The model and the line reader parse with the one dialect, in document order. */
function pairTaskLines(blocks: Block[], text: string): TaskLine[] | null {
  let count = 0
  const walk = (list: Block[]): void => {
    for (const block of list) {
      if (block.kind === 'quote') walk(block.children)
      if (block.kind !== 'list') continue
      for (const item of block.items) {
        if (item.task !== null) count += 1
        walk(item.children)
      }
    }
  }
  walk(blocks)
  const lines = readTaskLines(text)
  return lines.length === count ? lines : null
}

type RenderContext = { tasks?: NoteTasks; lines: TaskLine[] | null; next: number }

/**
 * An agent note's body, read in WriteFlex's ONE Markdown dialect (shared/markdown/model.ts) and
 * rendered as React nodes.
 *
 * A note is a Markdown file in the writer's folder, opened in the editor like any other, so the pane
 * must read it the way the editor and every export read it: CommonMark lists (a blank line between
 * `1.` items is still one loose list, numbered from the number the author wrote), footnotes,
 * `==mark==` and wikilinks under the disappearing-wikilink law. Nothing agent-authored is injected
 * as markup: raw HTML is shown as text, destinations go through the shared url-safety rule, and
 * images show their alt text (a note is read beside the piece, not a place to load pictures).
 *
 * The wrapper keeps the `bridle-md` class so the host's Markdown theming applies unchanged.
 */
export function NoteMarkdown({ text, className, tasks }: { text: string; className?: string; tasks?: NoteTasks }): JSX.Element {
  const document = readDocument(text ?? '')
  const ctx: RenderContext = { tasks, lines: tasks ? pairTaskLines(document.blocks, text ?? '') : null, next: 0 }
  // Footnotes render with no tick context: their boxes are drawn, never tickable (see pairTaskLines).
  const footnoteCtx: RenderContext = { lines: null, next: 0 }
  return (
    <div className={className ? `bridle-md ${className}` : 'bridle-md'}>
      {renderBlocks(document.blocks, ctx)}
      {document.footnotes.length > 0 && (
        <ol className="note-footnotes">
          {document.footnotes.map((note) => <li key={note.index} value={note.index}>{renderItemBody(note.children, footnoteCtx)}</li>)}
        </ol>
      )}
    </div>
  )
}

function renderBlocks(blocks: Block[], ctx: RenderContext): ReactNode[] {
  return blocks.map((block, index) => renderBlock(block, index, ctx))
}

/** A list item or footnote: a leading paragraph stays flat (`<li>text</li>`), as a tight list renders. */
function renderItemBody(children: Block[], ctx: RenderContext): ReactNode {
  const [first, ...rest] = children
  if (!first) return null
  if (first.kind !== 'paragraph') return renderBlocks(children, ctx)
  return (
    <>
      {renderInlines(first.children)}
      {rest.map((block, index) => renderBlock(block, index + 1, ctx))}
    </>
  )
}

/** One task item: the box in the marker's place, then the words. The pairing index is taken BEFORE the
 *  item's own nested lists render, which is the order the line reader lists them in. */
function renderTaskItem(done: boolean, children: Block[], key: number, ctx: RenderContext): ReactNode {
  const line = ctx.lines ? ctx.lines[ctx.next++] : undefined
  const tasks = ctx.tasks
  const body = renderItemBody(children, ctx)
  if (!line || !tasks) {
    return (
      <li key={key} className="bridle-md-task-item note-task">
        <input type="checkbox" className="note-task-box" checked={done} disabled readOnly tabIndex={-1} aria-label={done ? 'Completed task' : 'Incomplete task'} />
        <span className="note-task-text">{body}</span>
      </li>
    )
  }
  return (
    <li key={key} className={done ? 'bridle-md-task-item note-task done' : 'bridle-md-task-item note-task'} data-task-line={line.line}>
      <input
        type="checkbox"
        className="note-task-box"
        checked={done}
        onChange={() => tasks.onToggle(line)}
        aria-label={`${done ? 'Untick' : 'Tick'}: ${line.text}`}
      />
      <span className="note-task-text">{body}{tasks.extra?.(line)}</span>
    </li>
  )
}

function renderBlock(block: Block, key: number, ctx: RenderContext): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${Math.min(4, block.level)}` as 'h1' | 'h2' | 'h3' | 'h4'
      return <Tag key={key}>{renderInlines(block.children)}</Tag>
    }
    case 'paragraph':
      return block.children.length === 0 ? null : <p key={key}>{renderInlines(block.children)}</p>
    case 'quote':
      return <blockquote key={key}>{renderBlocks(block.children, ctx)}</blockquote>
    case 'list': {
      const items = block.items.map((item, index) => {
        if (item.task === null) return <li key={index}>{renderItemBody(item.children, ctx)}</li>
        return renderTaskItem(item.task === 'done', item.children, index, ctx)
      })
      if (!block.ordered) return <ul key={key}>{items}</ul>
      return <ol key={key} start={block.start === 1 ? undefined : block.start}>{items}</ol>
    }
    case 'code':
      return <pre key={key}><code data-language={block.language || undefined}>{block.text}</code></pre>
    case 'rule':
      return <hr key={key} />
    case 'html':
      // Shown, never run: an agent's raw HTML reads as the characters it wrote.
      return <p key={key}><code>{block.text}</code></p>
    case 'widget':
      return <p key={key}>{block.source}</p>
    case 'table': {
      const align = (index: number): { textAlign: 'left' | 'center' | 'right' } | undefined => {
        const value = block.alignments[index]
        return value ? { textAlign: value === 'centre' ? 'center' : value } : undefined
      }
      return (
        <div key={key} className="bridle-md-table-wrap">
          <table>
            {block.header.length > 0 && (
              <thead><tr>{block.header.map((cell, index) => <th key={index} style={align(index)}>{renderInlines(cell)}</th>)}</tr></thead>
            )}
            {block.rows.length > 0 && (
              <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index} style={align(index)}>{renderInlines(cell)}</td>)}</tr>)}</tbody>
            )}
          </table>
        </div>
      )
    }
  }
}

function renderInlines(parts: Inline[]): ReactNode[] {
  return parts.map((part, index) => renderInline(part, index))
}

function renderInline(part: Inline, key: number): ReactNode {
  switch (part.kind) {
    case 'text': return <Fragment key={key}>{part.text}</Fragment>
    case 'emphasis': return <em key={key}>{renderInlines(part.children)}</em>
    case 'strong': return <strong key={key}>{renderInlines(part.children)}</strong>
    case 'strike': return <del key={key}>{renderInlines(part.children)}</del>
    case 'mark': return <mark key={key}>{renderInlines(part.children)}</mark>
    case 'code': return <code key={key}>{part.text}</code>
    case 'break': return <br key={key} />
    case 'html': return <Fragment key={key}>{part.text}</Fragment>
    case 'image': return <Fragment key={key}>{part.alt}</Fragment>
    case 'wikilink': return <Fragment key={key}>{part.label}</Fragment>
    case 'footnote': return <sup key={key}>{part.index}</sup>
    case 'link': {
      const href = safeUrl(part.href, 'link')
      if (href === null) return <Fragment key={key}>{renderInlines(part.children)}</Fragment>
      return <a key={key} href={href} title={part.title} target="_blank" rel="noreferrer noopener">{renderInlines(part.children)}</a>
    }
  }
}
