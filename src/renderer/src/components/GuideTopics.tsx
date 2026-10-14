import { useEffect, useState } from 'react'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Play } from 'lucide-react'
import type { OverrideMap } from '../commands/chords'
import { resolveChord } from '../commands/chords'
import { lessonFileFor } from '../commands/guide-chapters'
import { EXAMPLE_OBJECTS_FILE } from '../../../shared/example-files'
import { TOPIC_TRY_LABEL, topicsOf, type GuideTopic, type TopicTab, type TopicTarget } from '../../../shared/guide-topics'
import { GuidePicture } from './GuidePicture'

/**
 * The topic list and one open topic, shared by How it works and Features to delight you (ADR-0043, ticket 08;
 * mockup-onboarding-hifi-v2 states 11 to 15). A topic is a heading, its sentences, one picture and at most
 * one Try it. Opening a topic marks it Read. Drawn from props: every action is a callback.
 */
export const TOPIC_TEXT = {
  tabName: { how: 'How it works', features: 'Features to delight you' } as const,
  notOpened: 'Not opened',
  read: 'Read',
} as const

export type TopicsViewProps = {
  tab: TopicTab
  /** Topic ids already read (the record's `read`). */
  read: readonly string[]
  /** True in the Example collection's own window. */
  here: boolean
  overrides: OverrideMap
  onTopicRead: (id: string) => void
  onTry: (target: TopicTarget) => void
}

/** What sits under Try it: the topic's own words, or, from the person's own window, where it goes. */
export function tryCaption(topic: GuideTopic, here: boolean): string {
  const tryIt = topic.tryIt
  if (!tryIt) return ''
  if (tryIt.target.kind === 'chapter' && !here) return `Opens the Example collection at ${lessonFileFor(tryIt.target.chapter)}.`
  if (tryIt.target.kind === 'objects' && !here) return `Opens the Example collection at ${EXAMPLE_OBJECTS_FILE}.`
  return tryIt.does
}

function TopicList({ topics, read, onPick }: { topics: readonly GuideTopic[]; read: readonly string[]; onPick: (index: number) => void }): JSX.Element {
  return (
    <div className="g-card" data-guide="topics">
      {topics.map((topic, index) => {
        const isRead = read.includes(topic.id)
        return (
          <button type="button" className="g-topic" key={topic.id} data-topic={topic.id} data-read={isRead} onClick={() => onPick(index)}>
            <span className="g-n">{index + 1}</span>
            <span className="g-t2">
              <span className="g-name">{topic.title}</span>
              {isRead
                ? <span className="st-done" data-status="read"><Check className="icon sm" aria-hidden="true" />{TOPIC_TEXT.read}</span>
                : <span className="st-none" data-status="not-opened">{TOPIC_TEXT.notOpened}</span>}
            </span>
            <ChevronRight className="icon sm go" aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}

function TopicDetail({ topics, index, here, overrides, tab, onBack, onStep, onTopicRead, onTry }: {
  topics: readonly GuideTopic[]
  index: number
  here: boolean
  overrides: OverrideMap
  tab: TopicTab
  onBack: () => void
  onStep: (delta: 1 | -1) => void
  onTopicRead: (id: string) => void
  onTry: (target: TopicTarget) => void
}): JSX.Element {
  const topic = topics[index]!
  useEffect(() => { onTopicRead(topic.id) }, [topic.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const target = topic.tryIt?.target
  const chord = target?.kind === 'command' ? resolveChord(target.id, overrides) : null
  return (
    <>
      <div className="g-nav">
        <button type="button" className="g-back" data-action="back" onClick={onBack}><ArrowLeft className="icon sm" aria-hidden="true" />{TOPIC_TEXT.tabName[tab]}</button>
        <span className="g-pos">{index + 1} of {topics.length}</span>
        <button type="button" className="g-step-btn" aria-label="Previous topic" disabled={index === 0} onClick={() => onStep(-1)}><ChevronLeft className="icon sm" aria-hidden="true" /></button>
        <button type="button" className="g-step-btn" aria-label="Next topic" disabled={index === topics.length - 1} onClick={() => onStep(1)}><ChevronRight className="icon sm" aria-hidden="true" /></button>
      </div>
      <div data-guide="topic" data-topic={topic.id}>
        <h2 className="g-title topic">{topic.title}</h2>
        <p className="g-p">{topic.body}</p>
        <div className="g-pic"><GuidePicture name={topic.picture} /></div>
        {topic.tryIt && target && (
          <div className="g-try">
            <button type="button" className="g-btn primary" data-action="try-it" onClick={() => onTry(target)}>
              <Play className="icon sm" aria-hidden="true" />{TOPIC_TRY_LABEL}{chord && <kbd>{chord}</kbd>}
            </button>
            <span className="g-dim">{tryCaption(topic, here)}</span>
          </div>
        )}
      </div>
    </>
  )
}

/** The list, or the one open topic with its back, position and previous/next controls fixed above it. */
export function TopicsView(props: TopicsViewProps & { after?: JSX.Element | null }): JSX.Element {
  const topics = topicsOf(props.tab)
  const [open, setOpen] = useState<number | null>(null)
  if (open !== null) {
    return (
      <TopicDetail
        topics={topics} index={open} here={props.here} overrides={props.overrides} tab={props.tab}
        onBack={() => setOpen(null)} onStep={(delta) => setOpen((now) => (now === null ? now : Math.min(topics.length - 1, Math.max(0, now + delta))))}
        onTopicRead={props.onTopicRead} onTry={props.onTry}
      />
    )
  }
  return <><TopicList topics={topics} read={props.read} onPick={setOpen} />{props.after}</>
}
