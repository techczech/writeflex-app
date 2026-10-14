/**
 * The plain-text emitter (Round B T4) — the third rendering of the shared document model.
 *
 * "Copy as plain text" is for a search box, a terminal, a form: prose with the markup taken off.
 * Structure the reader can still see in a plain-text field is kept as characters (list bullets,
 * task boxes, table columns as tabs); structure that only exists as punctuation goes.
 */
import { readDocument, type Block, type Inline } from './model'
import { labelFor } from './fancy-lists'

function inlines(parts: Inline[]): string {
  return parts.map(inline).join('')
}

function inline(part: Inline): string {
  switch (part.kind) {
    // A soft wrap inside a paragraph is not a line break — it reads as a space, as it does in every
    // rendering of the document. A HARD break (below) is the one that keeps its newline.
    case 'text': return part.text.replace(/\n[ \t]*/g, ' ')
    case 'code': case 'html': return part.text
    case 'emphasis': case 'strong': case 'strike': case 'mark': return inlines(part.children)
    // A link is reduced to its label; a bare URL's label IS the URL, so it survives intact.
    case 'link': return inlines(part.children)
    case 'image': return part.alt
    case 'wikilink': return part.label
    case 'footnote': return `[${part.index}]`
    case 'break': return '\n'
  }
}

function blocks(list: Block[], indent: string): string[] {
  return list.flatMap((entry) => block(entry, indent))
}

function block(entry: Block, indent: string): string[] {
  switch (entry.kind) {
    case 'heading': case 'paragraph': {
      const text = inlines(entry.children).trim()
      return text === '' ? [] : [indent + text]
    }
    case 'quote': return blocks(entry.children, indent)
    case 'list':
      return entry.items.flatMap((item, index) => {
        const marker = entry.ordered
          ? entry.lettering
            ? `${labelFor(entry.start + index, entry.lettering.numbering)}${entry.lettering.delimiter} `
            : `${entry.start + index}. `
          : '• '
        const box = item.task === null ? '' : item.task === 'done' ? '☑ ' : '☐ '
        const [first, ...rest] = item.children
        const head = first && first.kind === 'paragraph'
          ? [`${indent}${marker}${box}${inlines(first.children).trim()}`]
          : [`${indent}${marker}${box}`.trimEnd()]
        const tail = first && first.kind === 'paragraph' ? rest : item.children
        return [...head, ...blocks(tail, `${indent}  `)]
      })
    case 'code': return entry.text.split('\n').map((line) => indent + line)
    // A horizontal rule is punctuation, not words: nothing to say in a search box.
    case 'rule': return []
    case 'html': return [indent + entry.text]
    case 'widget': return [indent + entry.source]
    case 'table': return [
      ...(entry.header.length ? [indent + entry.header.map(inlines).join('\t')] : []),
      ...entry.rows.map((row) => indent + row.map(inlines).join('\t')),
    ]
  }
}

/**
 * Render Markdown as plain prose. Frontmatter and comments are gone before the parse (model.ts),
 * and wikilinks arrive as their label text under the disappearing-wikilink law.
 */
export function toPlain(markdown: string): string {
  const document = readDocument(markdown)
  const groups = document.blocks.map((entry) => block(entry, '').join('\n')).filter((group) => group !== '')
  const notes = document.footnotes.map((note) => `[${note.index}] ${blocks(note.children, '').join(' ').trim()}`)
  const all = [...groups, ...(notes.length ? [notes.join('\n')] : [])]
  return all.length ? `${all.join('\n\n')}\n` : ''
}
