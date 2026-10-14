import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { GuidePane, type GuidePaneProps } from '../../src/renderer/src/components/GuidePane'
import { chapterFor, deriveChapters } from '../../src/renderer/src/commands/guide-chapters'
import { emptyGuideProgress, withChapterFinished, withChapterOpened, withCommandRan, withStepDone, type GuideProgress } from '../../src/shared/guide-progress'

// The Guide's Learn the commands tab (ticket 07; mockup-onboarding-hifi-v2 states 02, 03, 05, 06, 08, 09):
// each chapter history, the first steps, This chapter beside a lesson file. Drawn from props, no IPC.

const chapters = deriveChapters()
const shape = chapterFor(chapters, 'Shape the document')!
const none = (): void => {}
const render = (progress: GuideProgress, over: Partial<GuidePaneProps> = {}): string =>
  renderToStaticMarkup(
    <GuidePane
      progress={progress}
      context={{ shown: true, here: true }}
      overrides={{}}
      activeFileName="00 Start here.md"
      onOpenFolder={none} onNewFile={none} onOpenExample={none} onOpenChapter={none} onChapterFinished={none} onChapterOpened={none}
      onTopicRead={none} onTry={none} onConnectionAction={none} connections={{ providers: null, zoteroFound: null, voices: null }}
      {...over}
    />,
  )
const row = (html: string, task: string): string => html.split(`data-chapter="${task}"`)[1]!.split('data-chapter=')[0]!
const ranAll = (ids: readonly string[]): GuideProgress => ids.reduce((progress, id) => withCommandRan(progress, id), emptyGuideProgress())

test('the four histories on the chapter rows, from the record', () => {
  const at = new Date(2026, 9, 6, 12).getTime()
  const rows = shape.rows.flatMap((r) => r.ids)
  let progress = withChapterOpened(emptyGuideProgress(), 'Shape the document')
  progress = withChapterFinished(progress, 'Listen', at)
  for (const id of ['review.nextChange', 'review.acceptAndNext']) progress = withCommandRan(progress, id)
  const html = render(progress)
  expect(row(html, 'Write')).toContain('Not opened')
  expect(row(html, 'Shape the document')).toContain('>Opened<')
  expect(row(html, 'Listen')).toContain('Finished 6 Oct')
  expect(row(html, 'Review and versions')).toMatch(/2 of \d+ tried/)
  expect(row(html, 'Review and versions')).toContain('class="bar"')
  expect(html).toContain('1 of 10 finished')
  expect(rows.length).toBeGreaterThan(0)
})

test('a chapter row shows a count whose total is the number of rows listed in the chapter', () => {
  const html = render(ranAll(['fold.current']), { activeFileName: '02 Shape the document.md' })
  const total = shape.rows.length
  expect(html).toContain(`1 of ${total} tried`)
  expect(html.match(/data-command="/g)).toHaveLength(total)
  expect(html).toContain(`data-total="${total}"`)
})

test('first steps: the first undone step offers its button, later ones wait, done ones show what was done', () => {
  const fresh = render(withStepDone(emptyGuideProgress(), 'example'))
  expect(fresh).toContain('1 of 3')
  expect(fresh).toMatch(/data-step="folder"[^>]*>[\s\S]*?Open folder…[\s\S]*?⌘O/)
  expect(fresh).not.toMatch(/data-step="file"[^>]*>[\s\S]{0,300}<button/)
  expect(fresh).toContain('Opened')

  let two = withStepDone(emptyGuideProgress(), 'folder', 'walking-book')
  two = withStepDone(two, 'file', 'Chapter 1.md')
  const own = render(two, { context: { shown: true, here: false } })
  expect(own).toContain('2 of 3')
  expect(own).toContain('walking-book')
  expect(own).toContain('Chapter 1.md')
  expect(own).toMatch(/data-step="example"[^>]*>[\s\S]*?<button[^>]*>Open<\/button>/)
})

test('the steps card goes once all three are done and a chapter has been opened', () => {
  let all = withStepDone(withStepDone(withStepDone(emptyGuideProgress(), 'folder', 'f'), 'file', 'a.md'), 'example')
  expect(render(all)).toContain('data-guide="steps"')
  all = withChapterOpened(all, 'Write')
  expect(render(all)).not.toContain('data-guide="steps"')
})

test('"New file" is not offered in the example\'s own window', () => {
  const progress = withStepDone(emptyGuideProgress(), 'folder', 'walking-book')
  expect(render(progress, { context: { shown: true, here: true } })).not.toContain('New file')
  expect(render(progress, { context: { shown: true, here: false } })).toContain('New file')
})

test('beside a lesson file: This chapter by sub-group, ticked rows, the next row marked, both caps on a pair', () => {
  const html = render(ranAll(['fold.current', 'outline.moveBlockDown']), { activeFileName: '02 Shape the document.md' })
  expect(html).toContain('This chapter')
  expect(html).toContain('2 of')
  expect(html).toMatch(/data-subgroup="Fold"[\s\S]*?1 of 3/)
  expect(html).toMatch(/data-command="fold.current" data-ticked="true"/)
  // Either key of the pair ticks the one row.
  expect(html).toMatch(/data-command="outline.moveBlockUp" data-ticked="true"/)
  expect(html).toMatch(/data-command="outline.moveBlockUp"[\s\S]*?<kbd>⌥⌘↑<\/kbd><kbd>⌥⌘↓<\/kbd>/)
  // The first row not yet ticked is the marked one.
  expect(html.match(/class="g-cmd next"/g)).toHaveLength(1)
  expect(html).toContain('class="g-cmd next" data-command="fold.all"')
  expect(html).toContain('2 of 10')
  expect(html).not.toContain('data-guide="chapters"')
})

test('a finished chapter reads Finished with the date and offers the next chapter', () => {
  const at = new Date(2026, 9, 6, 12).getTime()
  const progress = withChapterFinished(ranAll(shape.rows.flatMap((r) => r.ids)), 'Shape the document', at)
  const html = render(progress, { activeFileName: '02 Shape the document.md' })
  expect(html).toContain('Finished 6 Oct')
  expect(html).toContain('Next chapter: Stay focused')
  expect(html).toContain('g-prog full')
  expect(html).not.toContain('class="g-cmd next"')
})

test('the Welcome file and files that are no lesson show the list; a lesson shows its chapter only in the example\'s own window', () => {
  expect(render(emptyGuideProgress(), { activeFileName: '00 Start here.md' })).toContain('data-guide="chapters"')
  expect(render(emptyGuideProgress(), { activeFileName: 'notes.md' })).toContain('data-guide="chapters"')
  const own = render(emptyGuideProgress(), { activeFileName: '02 Shape the document.md', context: { shown: true, here: false } })
  expect(own).toContain('data-guide="chapters"')
  expect(own).not.toContain('data-guide="this-chapter"')
})

test('three tabs, Learn the commands first; the other two are enabled since ticket 08; no removal control', () => {
  const html = render(emptyGuideProgress())
  expect(html).toMatch(/<button[^>]*aria-selected="true"[^>]*>Learn the commands<\/button>/)
  expect(html).toMatch(/<button[^>]*aria-selected="false"[^>]*>How it works<\/button>/)
  expect(html).toMatch(/<button[^>]*aria-selected="false"[^>]*>Features to delight you<\/button>/)
  expect(html).not.toContain('disabled=""')
  expect(html).not.toContain('Remove the example')
})
