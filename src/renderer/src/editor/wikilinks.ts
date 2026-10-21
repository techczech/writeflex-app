import { Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'

export type WikilinkResolution = { target: string; display: string; to: string | null; ambiguous?: string[] }
export type WikilinkRange = {
  from: number
  to: number
  target: string
  display: string
  path: string | null
  dead: boolean
  invalid?: true
  ambiguous: string[] | undefined
}

export type MaterialiseSeed = { title: string; gist: string }

export const setWikilinkResolutions = StateEffect.define<WikilinkResolution[]>()
const WIKILINK = /\[\[([^\]\n]*)\]\]/g

/**
 * The key a link's resolution is filed under. A `./` path link resolves by its exact case (main wikilinks.ts
 * `resolveWikilinkPath`): `[[./A]]` and `[[./a]]` can name two files, so its key keeps the case. Every other link
 * resolves case-insensitively, so its key is folded.
 */
function resolutionKey(target: string): string {
  return target.trim().startsWith('./') ? `path:${target}` : `name:${target.toLocaleLowerCase()}`
}

/** Pure parser/classifier used by the StateField and headless regression tests. */
export function wikilinkRanges(doc: string, resolutions: WikilinkResolution[]): WikilinkRange[] {
  const byTarget = new Map(resolutions.map((item) => [resolutionKey(item.target), item]))
  return [...doc.matchAll(WIKILINK)].map((match) => {
    const raw = match[1]
    const separator = raw.indexOf('|')
    const target = (separator < 0 ? raw : raw.slice(0, separator)).split('#', 1)[0].trim()
    const invalid = target === ''
    const resolution = invalid ? undefined : byTarget.get(resolutionKey(target))
    const display = invalid ? 'Untitled idea' : ((separator < 0 ? target : raw.slice(separator + 1).trim()) || target)
    return {
      from: match.index,
      to: match.index + match[0].length,
      target,
      display,
      path: resolution?.to ?? null,
      dead: resolution?.to == null,
      ...(invalid ? { invalid: true as const } : {}),
      ambiguous: resolution?.ambiguous,
    }
  })
}

function decorations(doc: string, resolutions: WikilinkResolution[]): DecorationSet {
  return Decoration.set(wikilinkRanges(doc, resolutions).map((link) => Decoration.mark({
    class: `cm-wikilink ${link.dead ? 'dead' : 'live'}${link.invalid ? ' invalid' : ''}${link.ambiguous ? ' ambiguous' : ''}`,
    attributes: {
      'data-wikilink-target': link.target,
      'data-wikilink-display': link.display,
      ...(link.path ? { 'data-wikilink-path': link.path } : {}),
      title: link.invalid
        ? 'Idea Link needs a title'
        : link.dead
          ? `${link.display} — Idea, not written yet`
          : link.ambiguous
            ? `${link.display} — opens ${link.path}; ${link.ambiguous.length} matches`
            : `${link.display} — open Piece`,
    },
  }).range(link.from, link.to)), true)
}

type WikilinkField = { resolutions: WikilinkResolution[]; decorations: DecorationSet }

export const wikilinkField = StateField.define<WikilinkField>({
  create(state) {
    return { resolutions: [], decorations: decorations(state.doc.toString(), []) }
  },
  update(value, transaction) {
    let resolutions = value.resolutions
    for (const effect of transaction.effects) if (effect.is(setWikilinkResolutions)) resolutions = effect.value
    return transaction.docChanged || resolutions !== value.resolutions
      ? { resolutions, decorations: decorations(transaction.state.doc.toString(), resolutions) }
      : value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

export function wikilinkAt(doc: string, position: number, resolutions: WikilinkResolution[]): WikilinkRange | null {
  return wikilinkRanges(doc, resolutions).find((link) => position >= link.from && position <= link.to) ?? null
}

/** Derive human-facing Stub fields from an Idea Link, never from its filename syntax. */
export function materialiseSeed(doc: string, link: WikilinkRange): MaterialiseSeed {
  const title = link.display.replace(/\.(?:md|markdown|mdx)$/i, '').trim()
  const lineStart = Math.max(doc.lastIndexOf('\n', link.from - 1) + 1, 0)
  const lineEnd = doc.indexOf('\n', link.to)
  const gist = doc.slice(lineStart, lineEnd < 0 ? doc.length : lineEnd).replace(doc.slice(link.from, link.to), title).trim()
  return { title, gist: gist.toLocaleLowerCase() === title.toLocaleLowerCase() ? '' : gist }
}

/** True when the caret is in a wikilink whose target resolves to no file: the only link "Create this note" can act on. */
export function canMaterialiseAtCaret(state: EditorState): boolean {
  const field = state.field(wikilinkField, false)
  if (!field) return false
  const link = wikilinkAt(state.doc.toString(), state.selection.main.head, field.resolutions)
  return link !== null && link.dead
}

export function activateWikilinkAtCursor(view: EditorView, onActivate: (link: WikilinkRange) => void): boolean {
  const field = view.state.field(wikilinkField)
  const link = wikilinkAt(view.state.doc.toString(), view.state.selection.main.head, field.resolutions)
  if (!link) return false
  onActivate(link)
  return true
}

/** StateField-owned inline affordance with click and keyboard activation. */
export function wikilinks(onActivate: (link: WikilinkRange) => void): Extension {
  const activateAtCursor = (view: EditorView): boolean => activateWikilinkAtCursor(view, onActivate)
  return [
    wikilinkField,
    Prec.high(keymap.of([{ key: 'Alt-Enter', preventDefault: true, run: activateAtCursor }])),
    EditorView.domEventHandlers({
      click(event, view) {
        const element = (event.target as HTMLElement | null)?.closest<HTMLElement>('.cm-wikilink')
        if (!element) return false
        const position = view.posAtDOM(element)
        const field = view.state.field(wikilinkField)
        const link = wikilinkAt(view.state.doc.toString(), position, field.resolutions)
        if (!link) return false
        event.preventDefault()
        onActivate(link)
        return true
      },
    }),
  ]
}
