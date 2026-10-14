import { expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

test('the Reading Room refusal notice keeps its safe lead and carries the sync action', async () => {
  const module = await import('../../src/renderer/src/components/ReadingRoomNotice').catch(() => ({}))
  const Notice = (module as Record<string, unknown>).ReadingRoomNotice
  expect(typeof Notice).toBe('function')

  const onSync = (): void => {}
  const element = (Notice as (props: {
    refusal: string
    onSync: () => void
  }) => ReactElement)({
    refusal: 'Close Zotero and this highlight will be saved to your library.',
    onSync,
  })
  const markup = renderToStaticMarkup(element)

  expect(markup).toContain('<strong>Saved here, waiting for Zotero.</strong>')
  expect(markup).toContain('Close Zotero and this highlight will be saved to your library.')
  expect(markup).toContain('>Sync now</button>')
  expect(element.props.children.at(-1).props.onClick).toBe(onSync)
  expect(markup.toLowerCase()).not.toContain('dismiss')
})
