import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, ExternalLink, FolderSearch, Headphones, Heading, History, LayoutGrid, PenLine,
  RotateCcw, Share, SlidersHorizontal, Sparkles, Target, Trash2, type LucideIcon,
} from 'lucide-react'
import type { OverrideMap } from '../commands/chords'
import { TASK_GROUPS, type TaskGroup } from '../commands/command-task-groups'
import {
  chapterFor, chapterOfLessonFile, deriveChapters, nextUntried, rowChords, rowTried, triedCount, type Chapter, type ChapterRow,
} from '../commands/guide-chapters'
import { chapterHistory, chapterHistoryText, type ChapterHistory, type GuideProgress } from '../../../shared/guide-progress'
import type { ConnectionActionId, ConnectionSources } from '../../../shared/guide-connections'
import type { TopicTarget } from '../../../shared/guide-topics'
import { GuideHowItWorksTab } from './GuideHowItWorksTab'
import { GuideFeaturesTab } from './GuideFeaturesTab'

/**
 * The Guide tab (ADR-0043, ticket 07; mockup-onboarding-hifi-v2 states 02, 03, 05, 06, 08, 09, 10, 34).
 * Learn the commands: the first steps while they are not all done, then the ten chapters with their
 * history; beside a lesson file in the Example collection's own window, This chapter, the task's
 * commands by sub-group, each ticked the first time it runs. The component draws props: progress
 * and the window's context come from App, and every action is a callback.
 *
 * How it works and Features to delight you (ticket 08, states 11 to 16) are their own components
 * (`GuideHowItWorksTab`, `GuideFeaturesTab`); this component only chooses the tab.
 */
export const GUIDE_TEXT = {
  segments: ['Learn the commands', 'How it works', 'Features to delight you'],
  steps: { bar: 'First steps', open: 'Open a folder', file: 'Make your first file', example: 'Open the Example collection', openAction: 'Open folder…', fileAction: 'New file', exampleAction: 'Open', opened: 'Opened' },
  chaptersBar: 'Chapters',
  finishedOf: (n: number, of: number): string => `${n} of ${of} finished`,
  openInExample: 'Open in the Example collection',
  /** After removal (state 33): a chapter offers this in place of opening its lesson. */
  bringBack: 'Bring back the Example collection',
  removeExample: 'Remove the example…',
  thisChapter: 'This chapter',
  nextChapter: 'Next chapter',
} as const

const TASK_ICON: Record<TaskGroup, LucideIcon> = {
  'Write': PenLine,
  'Shape the document': Heading,
  'Stay focused': Target,
  'Listen': Headphones,
  'Review and versions': History,
  'Find and manage files': FolderSearch,
  'Collect and plan': LayoutGrid,
  'Work with the agent': Sparkles,
  'Share and export': Share,
  'Set up WriteFlex': SlidersHorizontal,
}

export type GuideContextView = { shown: boolean; here: boolean; canRestore?: boolean }

export type GuidePaneProps = {
  progress: GuideProgress
  /** `here`: this window is the Example collection's own. */
  context: GuideContextView
  overrides: OverrideMap
  /** The active file's name (not its folder), or null: a lesson file selects its chapter (here only). */
  activeFileName: string | null
  chapters?: readonly Chapter[]
  onOpenFolder: () => void
  onNewFile: () => void
  onOpenExample: () => void
  /** Open a chapter's lesson file in the Example collection's window. */
  onOpenChapter: (task: TaskGroup) => void
  /** Open "Remove the example?" (ticket 10). Offered on the first screen of the example's own window. */
  onRemoveExample?: () => void
  /** Bring the Example collection back (ticket 10). Offered by a chapter while the example is not shown. */
  onRestoreExample?: () => void
  /** Render seam: the chapter whose row is open when the pane is first drawn (the person's own window). */
  initialExpanded?: TaskGroup
  /** Every row of the chapter has been tried (the first time this window sees it): main stamps the date. */
  onChapterFinished: (task: TaskGroup) => void
  /** The lesson file of this chapter is the active file. */
  onChapterOpened: (task: TaskGroup) => void
  /** A topic was opened (How it works, Features to delight you): it reads Read from now on. */
  onTopicRead: (id: string) => void
  /** A topic's Try it: bring the Example collection forward, open a lesson file there, or run a command here. */
  onTry: (target: TopicTarget) => void
  /** What it connects to: the three sources, read from this machine, and the row actions. */
  connections: ConnectionSources
  onConnectionAction: (action: ConnectionActionId) => void
}

type GuideTab = 'learn' | 'how' | 'features'
const TAB_ORDER: readonly GuideTab[] = ['learn', 'how', 'features']

const StatusText = ({ history }: { history: ChapterHistory }): JSX.Element => {
  const text = chapterHistoryText(history)
  if (history.kind === 'finished') return <span className="st-done" data-status="finished"><Check className="icon sm" aria-hidden="true" />{text}</span>
  if (history.kind === 'tried') {
    return (
      <span className="st-part" data-status="tried">
        <i className="bar" aria-hidden="true"><b style={{ width: `${Math.round((history.tried / history.total) * 100)}%` }} /></i>
        {text}
      </span>
    )
  }
  return <span className={history.kind === 'opened' ? 'st-open' : 'st-none'} data-status={history.kind}>{text}</span>
}

function StepsCard({ progress, here, onOpenFolder, onNewFile, onOpenExample }: Pick<GuidePaneProps, 'progress' | 'onOpenFolder' | 'onNewFile' | 'onOpenExample'> & { here: boolean }): JSX.Element {
  const T = GUIDE_TEXT.steps
  const rows = [
    { key: 'folder', label: T.open, done: progress.steps.folder, action: T.openAction, chord: '⌘O', run: onOpenFolder },
    { key: 'file', label: T.file, done: progress.steps.file, action: T.fileAction, chord: '⌘N', run: onNewFile, ownWindowOnly: true },
    { key: 'example', label: T.example, done: progress.steps.example ? T.opened : undefined, action: T.exampleAction, chord: '', run: onOpenExample },
  ]
  const now = rows.findIndex((row) => !row.done)
  const done = rows.filter((row) => row.done).length
  return (
    <div className="g-card" data-guide="steps">
      <div className="g-bar"><span>{T.bar}</span><span className="g-barx">{done} of 3</span></div>
      {rows.map((row, index) => {
        const state = row.done ? 'done' : index === now ? 'now' : 'wait'
        // "New file" makes a file in the window's own folder, so the example's window offers none.
        const offered = state === 'now' && !(row.ownWindowOnly && here)
        return (
          <div className={`g-step ${state}`} key={row.key} data-step={row.key}>
            {state === 'done' ? <span className="tick on"><Check aria-hidden="true" /></span> : <span className="num">{index + 1}</span>}
            <span className="g-name">{row.label}</span>
            {state === 'done' && <span className="g-dim">{row.done}</span>}
            {offered && <button type="button" className="g-btn primary sm" onClick={row.run}>{row.action}{row.chord && <kbd>{row.chord}</kbd>}</button>}
          </div>
        )
      })}
    </div>
  )
}

function ChapterList({ chapters, progress, here, gone, expanded, onPick, onOpenChapter, onRestoreExample }: {
  chapters: readonly Chapter[]
  progress: GuideProgress
  here: boolean
  /** The example is not shown (the Guide reopened after removal): a chapter offers to bring it back. */
  gone: boolean
  onRestoreExample?: () => void
  expanded: TaskGroup | null
  onPick: (task: TaskGroup) => void
  onOpenChapter: (task: TaskGroup) => void
}): JSX.Element {
  const ran = new Set(progress.ran)
  const finished = chapters.filter((chapter) => progress.finished[chapter.task] !== undefined).length
  return (
    <div className="g-card" data-guide="chapters">
      <div className="g-bar"><span>{GUIDE_TEXT.chaptersBar}</span><span className="g-barx">{GUIDE_TEXT.finishedOf(finished, chapters.length)}</span></div>
      {chapters.map((chapter) => {
        const Icon = TASK_ICON[chapter.task]
        const history = chapterHistory(progress, chapter.task, triedCount(chapter, ran), chapter.rows.length)
        const open = !here && expanded === chapter.task
        return (
          <div className={`g-row${open ? ' focus' : ''}`} key={chapter.task} data-chapter={chapter.task}>
            <button type="button" className="g-row1" aria-expanded={here ? undefined : open} onClick={() => onPick(chapter.task)}>
              <span className="g-ico"><Icon className="icon sm" aria-hidden="true" /></span>
              <span className="g-name">{chapter.task}</span>
              <StatusText history={history} />
              <ChevronRight className="icon sm go" aria-hidden="true" />
            </button>
            {open && (
              <div className="g-bring">
                {gone ? (
                  <button type="button" className="g-btn sm" data-action="bring-back-example" onClick={() => onRestoreExample?.()}>
                    <RotateCcw className="icon sm" aria-hidden="true" />{GUIDE_TEXT.bringBack}
                  </button>
                ) : (
                  <button type="button" className="g-btn sm" data-action="open-in-example" onClick={() => onOpenChapter(chapter.task)}>
                    <ExternalLink className="icon sm" aria-hidden="true" />{GUIDE_TEXT.openInExample}
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ChapterDetail({ chapter, index, progress, overrides, onBack, onStep, onOpenChapter }: {
  chapter: Chapter
  index: number
  progress: GuideProgress
  overrides: OverrideMap
  onBack: () => void
  onStep: (delta: 1 | -1) => void
  onOpenChapter: (task: TaskGroup) => void
}): JSX.Element {
  const ran = new Set(progress.ran)
  const Icon = TASK_ICON[chapter.task]
  const total = chapter.rows.length
  const tried = triedCount(chapter, ran)
  const history = chapterHistory(progress, chapter.task, tried, total)
  const isFinished = history.kind === 'finished'
  const next = TASK_GROUPS[index + 1]
  const upNext = nextUntried(chapter, ran)
  return (
    <>
      <div className="g-nav">
        <button type="button" className="g-back" data-action="back" onClick={onBack}><ArrowLeft className="icon sm" aria-hidden="true" />{GUIDE_TEXT.chaptersBar}</button>
        <span className="g-pos">{index + 1} of {TASK_GROUPS.length}</span>
        <button type="button" className="g-step-btn" aria-label="Previous chapter" disabled={index === 0} onClick={() => onStep(-1)}><ChevronLeft className="icon sm" aria-hidden="true" /></button>
        <button type="button" className="g-step-btn" aria-label="Next chapter" disabled={index === TASK_GROUPS.length - 1} onClick={() => onStep(1)}><ChevronRight className="icon sm" aria-hidden="true" /></button>
      </div>
      <h2 className="g-title"><Icon className="icon" aria-hidden="true" />{chapter.task}</h2>
      {isFinished && next && (
        <button type="button" className="g-btn primary wide" data-action="next-chapter" onClick={() => onOpenChapter(next)}>
          {GUIDE_TEXT.nextChapter}: {next}<ArrowRight className="icon sm" aria-hidden="true" />
        </button>
      )}
      <div className="g-card" data-guide="this-chapter" data-tried={tried} data-total={total}>
        <div className="g-bar">
          <span>{GUIDE_TEXT.thisChapter}</span>
          {isFinished
            ? <StatusText history={history} />
            : <span className="g-barx strong" data-count>{chapterHistoryText({ kind: 'tried', tried, total })}</span>}
        </div>
        <div className={`g-prog${isFinished ? ' full' : ''}`}><b style={{ width: `${total === 0 ? 0 : (tried / total) * 100}%` }} /></div>
        {chapter.subgroups.map((group) => {
          const n = group.rows.filter((row) => rowTried(row, ran)).length
          return (
            <div key={group.name} data-subgroup={group.name}>
              <div className="g-sub"><span>{group.name}</span><span className="g-barx">{n} of {group.rows.length}</span></div>
              {group.rows.map((row) => <CommandRow key={row.id} row={row} on={rowTried(row, ran)} next={upNext === row} overrides={overrides} />)}
            </div>
          )
        })}
      </div>
    </>
  )
}

function CommandRow({ row, on, next, overrides }: { row: ChapterRow; on: boolean; next: boolean; overrides: OverrideMap }): JSX.Element {
  const chords = rowChords(row, overrides)
  return (
    <div className={`g-cmd${on ? ' on' : ''}${next ? ' next' : ''}`} data-command={row.id} data-ticked={on}>
      <span className={`tick${on ? ' on' : ''}`} role="img" aria-label={on ? 'Tried' : 'Not tried yet'}>{on && <Check aria-hidden="true" />}</span>
      <span className="g-name">{row.label}</span>
      <span className="keys">{chords.map((chord) => <kbd key={chord}>{chord}</kbd>)}</span>
    </div>
  )
}

export function GuidePane(props: GuidePaneProps): JSX.Element {
  const { progress, context, overrides, activeFileName, onOpenFolder, onNewFile, onOpenExample, onOpenChapter, onChapterFinished, onChapterOpened, onTopicRead, onTry, connections, onConnectionAction, onRemoveExample, onRestoreExample } = props
  const chapters = useMemo(() => props.chapters ?? deriveChapters(), [props.chapters])
  const ran = useMemo(() => new Set(progress.ran), [progress.ran])
  // A lesson file open in the Example collection's own window selects its chapter; 00 Start here.md and
  // any other file show the list. Back to Chapters is the person's choice and lasts until the file changes.
  const lesson = context.here && activeFileName ? chapterOfLessonFile(activeFileName) : null
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<TaskGroup | null>(props.initialExpanded ?? null)
  const [tab, setTab] = useState<GuideTab>('learn')
  const detail = lesson !== null && dismissedFor !== activeFileName ? chapterFor(chapters, lesson) ?? null : null

  useEffect(() => { if (lesson) onChapterOpened(lesson) }, [lesson]) // eslint-disable-line react-hooks/exhaustive-deps
  // The first time a chapter's every row has been tried, main stamps the date; later runs change nothing.
  useEffect(() => {
    for (const chapter of chapters) {
      if (progress.finished[chapter.task] === undefined && chapter.rows.length > 0 && triedCount(chapter, ran) === chapter.rows.length) onChapterFinished(chapter.task)
    }
  }, [chapters, ran, progress.finished]) // eslint-disable-line react-hooks/exhaustive-deps

  const steps = progress.steps
  const stepsDone = [steps.folder, steps.file, steps.example].filter(Boolean).length
  const showSteps = stepsDone < 3 || progress.opened.length === 0

  const pick = (task: TaskGroup): void => {
    if (context.here) { setDismissedFor(null); onOpenChapter(task) } // the example's own window: the lesson opens here
    else setExpanded((current) => (current === task ? null : task))
  }
  const step = (delta: 1 | -1): void => {
    if (!detail) return
    const target = TASK_GROUPS[TASK_GROUPS.indexOf(detail.task) + delta]
    if (target) onOpenChapter(target)
  }

  return (
    <div className="guide" data-guide="root">
      <div className="g-seg" role="tablist" aria-label="Guide">
        {GUIDE_TEXT.segments.map((name, index) => (
          <button key={name} type="button" role="tab" aria-selected={TAB_ORDER[index] === tab} className={TAB_ORDER[index] === tab ? 'on' : undefined} onClick={() => setTab(TAB_ORDER[index]!)}>{name}</button>
        ))}
      </div>
      <div className="g-body"><div className="g-scr">
        {tab === 'how' && <GuideHowItWorksTab read={progress.read} here={context.here} overrides={overrides} onTopicRead={onTopicRead} onTry={onTry} />}
        {tab === 'features' && <GuideFeaturesTab read={progress.read} here={context.here} overrides={overrides} onTopicRead={onTopicRead} onTry={onTry} sources={connections} onConnectionAction={onConnectionAction} />}
        {tab !== 'learn' ? null : detail ? (
          <ChapterDetail
            chapter={detail}
            index={TASK_GROUPS.indexOf(detail.task)}
            progress={progress}
            overrides={overrides}
            onBack={() => setDismissedFor(activeFileName)}
            onStep={step}
            onOpenChapter={onOpenChapter}
          />
        ) : (
          <>
            {showSteps && <StepsCard progress={progress} here={context.here} onOpenFolder={onOpenFolder} onNewFile={onNewFile} onOpenExample={onOpenExample} />}
            <ChapterList chapters={chapters} progress={progress} here={context.here} gone={!context.shown} expanded={expanded} onPick={pick} onOpenChapter={onOpenChapter} onRestoreExample={onRestoreExample} />
            {context.here && onRemoveExample && (
              <div className="g-foot">
                <button type="button" className="g-ghost rm" data-action="remove-example" onClick={onRemoveExample}>
                  <Trash2 className="icon sm" aria-hidden="true" />{GUIDE_TEXT.removeExample}
                </button>
              </div>
            )}
          </>
        )}
      </div></div>
    </div>
  )
}
