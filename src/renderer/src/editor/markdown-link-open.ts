import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * Opening a Markdown link from the draft: ⌘-click on it, or ⌥⏎ with the caret inside it (⌥⏎ is the
 * app-level Follow link command, which tries a wikilink first and then {@link openMarkdownLinkAt}).
 *
 * This is what makes an archive citation's `[archive](writeflex://open?path=…&line=N)` land on the
 * quoted line (WF-4B), and its `[public](https://…)` open in the browser. A plain click still just
 * places the caret, so editing a link's text is never hijacked. Only `writeflex:` and `http(s):`
 * targets open; anything else (file:, zotero:, relative paths) is left alone.
 */

/** The URL of the Markdown link at `pos`, or null. */
export function markdownLinkAt(state: EditorState, pos: number): string | null {
  const tree = syntaxTree(state)
  for (const side of [1, -1] as const) {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name !== 'Link') continue
      const url = node.getChild('URL')
      if (!url) return null
      return state.doc.sliceString(url.from, url.to).replace(/^<|>$/g, '')
    }
  }
  return null
}

/** True for the link targets this opener handles. */
export function isOpenableLink(url: string): boolean {
  return /^(?:writeflex|https?):/i.test(url)
}

/** Open the openable link at `pos` (default: the caret); false when there is none. */
export function openMarkdownLinkAt(view: EditorView, onOpen: (url: string) => void, pos = view.state.selection.main.head): boolean {
  const url = markdownLinkAt(view.state, pos)
  if (!url || !isOpenableLink(url)) return false
  onOpen(url)
  return true
}

export function markdownLinkOpener(onOpen: (url: string) => void): Extension {
  const openAt = (view: EditorView, pos: number): boolean => openMarkdownLinkAt(view, onOpen, pos)
  return [
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!event.metaKey || event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null || !openAt(view, pos)) return false
        event.preventDefault()
        return true
      },
    }),
  ]
}
