import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChangeDock, type ChangeDockProps } from '../../src/renderer/src/components/ChangeDock'
import type { Change } from '../../src/preload'

const change = (id: string, over: Partial<Change> = {}): Change => ({
  id,
  path: 'draft.md',
  ts: 1,
  provenance: 'agent',
  editClass: 'content',
  category: 'wording',
  summary: id,
  oldText: 'old text',
  newText: 'new text',
  status: 'pending',
  isCorrection: false,
  ...over,
})

const renderDock = (changes: Change[], over: Partial<ChangeDockProps> = {}): string => renderToStaticMarkup(
  <ChangeDock
    changes={changes}
    selectedId={null}
    onSelect={() => {}}
    onAccept={() => {}}
    onReject={() => {}}
    onHold={() => {}}
    onRevertToActive={() => {}}
    onSendOriginalToScratchpad={() => {}}
    onAcceptAll={() => {}}
    onAcceptInsertions={() => {}}
    onAcceptDeletions={() => {}}
    onAcceptMany={() => {}}
    onRejectMany={() => {}}
    onAcceptSession={() => {}}
    onDiscard={() => {}}
    onSendBack={() => {}}
    onSaveVersion={() => {}}
    onViewSession={() => {}}
    onViewVersion={() => {}}
    onOpenCompare={() => {}}
    onRenameVersion={() => {}}
    onReturnToCurrent={() => {}}
    onClose={() => {}}
    versions={[]}
    allChanges={changes}
    {...over}
  />,
)

test('working changes fold copy edits into an expandable quiet summary', () => {
  const html = renderDock([
    change('c_typo', { editClass: 'copy', category: 'typo', oldText: 'teh', newText: 'the' }),
    change('c_grammar', { editClass: 'copy', category: 'grammar', oldText: 'didnt', newText: 'did not' }),
  ], { initialQuietOpen: true })

  expect(html).toContain('2 quiet fixes')
  // Pending quiet fixes say so honestly; 'applied' only once they are (post-accept/save).
  expect(html).toContain('typos &amp; grammar, fold in when you save')
  expect(html).toContain('<s>teh</s>')
  expect(html).toContain('<i>the</i>')
})

test('quiet fixes can be hidden from the working list', () => {
  const html = renderDock([
    change('c_typo', { editClass: 'copy', category: 'typo', oldText: 'teh', newText: 'the' }),
  ], { initialQuietOpen: true, initialQuietHidden: true })

  expect(html).toContain('Show quiet fixes')
  expect(html).not.toContain('typos &amp; grammar, applied')
  expect(html).not.toContain('<s>teh</s>')
})

test('agent content edits render as provisional cards with foundation-v2 verbs', () => {
  const html = renderDock([
    change('c_wording', { category: 'wording', oldText: 'make my way', newText: 'walk' }),
  ])

  expect(html).toContain('Wording · provisional')
  expect(html).toContain('<s>make my way</s>')
  expect(html).toContain('<i>walk</i>')
  expect(html).toContain('Keep old')
  expect(html).toContain('Change to new')
  expect(html).toContain('Hold both')
})

test('held changes render as workshop cards with only resolve options', () => {
  const html = renderDock([
    change('c_held', { status: 'held', oldText: 'shallows', newText: 'shoals' }),
  ])

  expect(html).toContain('Workshopping')
  expect(html).toContain('shallows')
  expect(html).toContain('shoals')
  expect(html).toContain('held open, both visible')
  expect(html).toContain('Keep old')
  expect(html).toContain('Change to new')
  expect(html).not.toContain('Hold both')
})

test('writer edits are grouped as unreviewed edits and reviewable one at a time, same verbs as agent edits', () => {
  // ADR-0016 / walk feedback: your own edits resolve exactly like an agent proposal — Keep old /
  // Change to new / Hold both, per edit — under the session heading.
  const html = renderDock([
    change('c_writer', {
      provenance: 'writer',
      editClass: 'content',
      category: 'wording',
      oldText: 'plain',
      newText: 'careful',
    }),
  ])

  expect(html).toContain('Unreviewed edits')
  expect(html).toContain('your edit')
  expect(html).toContain('<s>plain</s>')
  expect(html).toContain('<i>careful</i>')
  expect(html).toContain('Keep old')
  expect(html).toContain('Change to new')
  expect(html).toContain('Hold both')
})

test('pending writer edits render the roll-forward head and byte-exact status-only Accept session foot', () => {
  const openedAt = Date.now() - 41 * 60_000
  const html = renderDock([
    change('c_writer', {
      path: 'notes/test-idea.md',
      provenance: 'writer',
      editClass: 'content',
      oldText: 'plain',
      newText: 'careful',
    }),
  ], {
    sessionDocumentPath: 'notes/test-idea.md',
    sessionOpenedAt: openedAt,
    onAcceptSession: () => {},
  } as unknown as Partial<ChangeDockProps>)

  expect(html).toContain('rv-title')
  expect(html).toContain('Unreviewed edits')
  expect(html).toContain('Pending edits to <b>test-idea.md</b>.')
  expect(html).toContain('rv-accept')
  expect(html).toContain('Accept session')
  expect(html).toContain('Settles this session. <b>Your text is unchanged</b> — it was final the moment you typed it. Reject is the only thing that rewrites.')
})

test('the session surface is absent without pending writer edits', () => {
  const html = renderDock([
    change('c_agent'),
    change('c_writer_accepted', { provenance: 'writer', status: 'accepted' }),
  ], {
    sessionDocumentPath: 'draft.md',
    sessionOpenedAt: Date.now(),
    onAcceptSession: () => {},
  } as unknown as Partial<ChangeDockProps>)

  expect(html).not.toContain('Unreviewed edits')
  expect(html).not.toContain('Accept session')
})

test('change cards can send any original to Scratchpad and revert accepted changes to active', () => {
  const pendingHtml = renderDock([change('c_pending')])
  expect(pendingHtml).toContain('Send original to Scratchpad')
  expect(pendingHtml).not.toContain('Revert to active')

  const acceptedHtml = renderDock([
    change('c_accepted', { provenance: 'writer', status: 'accepted', oldText: 'before', newText: 'after' }),
  ])
  expect(acceptedHtml).toContain('Send original to Scratchpad')
  expect(acceptedHtml).toContain('Revert to active')
})

test('the pinned run bar accepts or discards the whole run; by-kind buttons only as a subset', () => {
  // Approved review-run-actions v1-A: Accept all / Discard run / Send back live in the run bar at the
  // pane's foot; the top bar keeps only the by-kind subsets (and the selection status when selecting).
  const html = renderDock([
    change('c_ins', { editClass: 'insert', oldText: '', newText: 'a new sentence.' }),
    change('c_del', { oldText: 'stray words', newText: '' }),
    change('c_repl', { oldText: 'plain', newText: 'careful' }),
  ])
  expect(html).toContain('Accept all 3')
  expect(html).toContain('Discard run')
  expect(html).toContain('Send back')
  expect(html).toContain('Insertions 1')
  expect(html).toContain('Deletions 1')
})

test('a single pending change still gets the run bar (no by-kind subset row)', () => {
  const html = renderDock([change('c1', { oldText: 'plain', newText: 'careful' })])
  expect(html).toContain('Accept all 1')
  expect(html).toContain('Discard run')
  expect(html).not.toContain('Insertions')
})

test('a drifted (unanchored) card offers Discard suggestion / Reconsider, never Keep old', () => {
  // Once the passage has changed there is no meaningful "old" to keep: the suggestion is dropped or
  // handed back to the agent to redo against the current text.
  const html = renderDock(
    [change('c_drift', { oldText: 'gone text', newText: 'proposed text' })],
    { unanchoredIds: ['c_drift'], onRevise: () => {} },
  )
  expect(html).toContain('The passage has changed')
  expect(html).toContain('Discard suggestion')
  expect(html).toContain('Reconsider')
  expect(html).not.toContain('Keep old')
})

test('rejected agent proposals fold away with a Reopen escape hatch; rejected writer edits do not', () => {
  const html = renderDock(
    [
      change('c_rej', { status: 'rejected', oldText: 'plain', newText: 'careful' }),
      change('c_wrej', { status: 'rejected', provenance: 'writer', oldText: '', newText: 'typed' }),
    ],
    { onReopen: () => {}, initialQuietOpen: true },
  )
  expect(html).toContain('1 rejected')
  expect(html).toContain('reopen if that was a mistake')

  const openHtml = renderDock(
    [change('c_rej', { status: 'rejected', oldText: 'plain', newText: 'careful' })],
    { onReopen: () => {} },
  )
  expect(openHtml).toContain('1 rejected')
})

test('reviewable cards carry a multi-select checkbox', () => {
  const html = renderDock([change('c1', { oldText: 'plain', newText: 'careful' })])
  expect(html).toContain('type="checkbox"')
  expect(html).toContain('Select this change for a batch action')
})

test('embedded review idle state is calm and has no permanent run actions', () => {
  const html = renderDock([], { surface: 'review' })

  expect(html).toContain('No working changes.')
  expect(html).not.toContain('No review run yet')
  expect(html).not.toContain('Discard')
  expect(html).not.toContain('Send back')
})

test('embedded versions surface uses Save version wording', () => {
  const html = renderDock([], { surface: 'versions' })

  expect(html).toContain('No saved versions yet.')
  expect(html).toContain('Save version')
  expect(html).not.toContain('Name version')
})
