import { renderToStaticMarkup } from 'react-dom/server'
import { ActionsHere } from '../../src/renderer/src/components/ActionsHere'
import type { Place } from '../../src/renderer/src/commands/place'

/** The Actions here panel at a place, as markup (no editor state, so no command that needs a document). */
export const renderActionsHere = (place: Place): string =>
  renderToStaticMarkup(<ActionsHere x={0} y={0} place={place} onClose={() => {}} />)

export type RenderedRow = { id: string; label: string; chords: string[]; markup: string }

/** The menu item rows of the panel, in order, with the chords each shows. The "All commands…" row is not among them. */
export function renderedRows(html: string): RenderedRow[] {
  return html.split('<div id="ak-row-').slice(1).flatMap((chunk) => {
    const id = chunk.match(/data-action-id="([^"]+)"/)?.[1]
    if (!id || id === 'all-commands') return []
    const label = chunk.match(/<span class="grow">([^<]*)<\/span>/)?.[1] ?? ''
    return [{ id, label, chords: [...chunk.slice(0, chunk.indexOf('</div>')).matchAll(/<kbd>([^<]*)<\/kbd>/g)].map((match) => match[1]), markup: chunk.slice(0, chunk.indexOf('</div>')) }]
  })
}
