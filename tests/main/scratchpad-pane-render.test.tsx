import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScratchpadPane } from '../../src/renderer/src/components/ScratchpadPane'

test('the empty surface is named Scratchpad while saved items remain scraps', () => {
  const html = renderToStaticMarkup(
    <ScratchpadPane
      scraps={[]}
      focusTick={0}
      onToggleDone={() => {}}
      onSetColour={() => {}}
      onRemove={() => {}}
      onInsert={() => {}}
      onNewScrap={() => {}}
      sources={[]}
      onOpenSource={() => {}}
      onRevealSource={() => {}}
    />,
  )

  expect(html).toContain('Scratchpad')
  expect(html).toContain('cut one')
  expect(html).not.toContain('Scraps live')
})
