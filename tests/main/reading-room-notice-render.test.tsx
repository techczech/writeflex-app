import { expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PLUGIN_INSTALL_SENTENCE,
  ReadingRoomNotice,
  type ReadingRoomNoticeProps,
} from '../../src/renderer/src/components/ReadingRoomNotice'

function render(props: Omit<ReadingRoomNoticeProps, 'onSync'>, onSync = (): void => {}): {
  element: ReactElement | null
  markup: string
} {
  const element = ReadingRoomNotice({ ...props, onSync })
  return { element, markup: element ? renderToStaticMarkup(element) : '' }
}

test('nothing waiting draws nothing', () => {
  expect(render({ refusal: null, refusalCode: null, waiting: 0 }).element).toBeNull()
})

test('waiting for Zotero says how many and when they are sent, singular and plural', () => {
  const onSync = (): void => {}
  const one = render({
    refusal: 'Zotero is not open. Your highlights are saved here and are sent when Zotero is open.',
    refusalCode: 'zotero-closed',
    waiting: 1,
  }, onSync)
  expect(one.markup).toContain('<strong>1 highlight waiting for Zotero.</strong> It is sent when Zotero is open.')
  expect(one.markup).toContain('>Sync now</button>')
  expect(one.markup).toContain('role="status"')
  expect((one.element!.props.children as ReactElement[]).at(-1)!.props.onClick).toBe(onSync)
  expect(one.markup.toLowerCase()).not.toContain('dismiss')

  const several = render({ refusal: null, refusalCode: null, waiting: 3 })
  expect(several.markup).toContain('<strong>3 highlights waiting for Zotero.</strong> They are sent when Zotero is open.')

  // Zotero answering slowly is the same ordinary wait, not an error.
  const busy = render({ refusal: 'Zotero did not answer in time.', refusalCode: 'zotero-busy', waiting: 2 })
  expect(busy.markup).toContain('They are sent when Zotero is open.')
  expect(busy.markup).not.toContain('reading-room-notice-error')
})

test('Zotero without the plugin, or with an old one, says how to install it and shows the plugin file', () => {
  for (const refusalCode of ['plugin-missing', 'plugin-outdated']) {
    const onShowPlugin = (): void => {}
    const { element, markup } = render({ onShowPlugin, refusal: 'whatever main said', refusalCode, waiting: 4 })
    expect(markup).toContain(`<strong>4 highlights waiting for Zotero.</strong> ${PLUGIN_INSTALL_SENTENCE}`)
    expect(PLUGIN_INSTALL_SENTENCE).toBe(
      'To send highlights to Zotero, install the WriteFlex plugin in Zotero: Tools, Plugins, then install from file.',
    )
    expect(markup).toContain('>Show plugin file</button>')
    expect(markup).not.toContain('Sync now')
    expect(markup).toContain('role="alert"')
    expect((element!.props.children as ReactElement[]).at(-1)!.props.onClick).toBe(onShowPlugin)
  }
})

test('a write refused for another reason is an error, with the reason and a retry', () => {
  const reason = 'The WriteFlex plugin in Zotero did not accept this copy of WriteFlex. Restart Zotero, then try again.'
  const { markup } = render({ refusal: reason, refusalCode: 'plugin-not-paired', waiting: 2 })
  expect(markup).toContain('reading-room-notice-error')
  expect(markup).toContain('role="alert"')
  expect(markup).toContain('<strong>2 highlights could not be written to Zotero.</strong>')
  expect(markup).toContain(reason)
  expect(markup).toContain('>Try again</button>')
})
