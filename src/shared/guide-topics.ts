// The Guide's two topic tabs (ADR-0043, ticket 08): How it works (8) and Features to delight you (11,
// ending with What it connects to). Words are the topics file's, verbatim (`guide-topics-text.ts`, checked
// by tests/main/guide-topics.test.ts). Each topic adds an id, a picture key and at most one Try it. Pure data.
import type { TaskGroup } from '../renderer/src/commands/command-task-groups'
import { FEATURES_TEXT, HOW_TEXT } from './guide-topics-text'

/**
 * What Try it does. `example`: bring the Example collection's window forward (main opens it from any
 * window). `chapter`: open that chapter's lesson file there (`01 Write.md` … `10 Set up WriteFlex.md`; what
 * each caption promises is checked against the file by tests/main/lesson-files.test.ts). `objects`: open
 * `11 Objects.md`, the lesson on the objects Insert object offers (it is no chapter). `command`: run the
 * registry command in the window the person is in, beside their own file.
 */
export type TopicTarget =
  | { kind: 'example' }
  | { kind: 'chapter'; chapter: TaskGroup }
  | { kind: 'objects' }
  | { kind: 'command'; id: string }

export type TopicTry = { target: TopicTarget; /** The caption under the button. */ does: string }

export type GuideTopic = { id: string; title: string; body: string; picture: string; tryIt?: TopicTry }

export const TOPIC_TRY_LABEL = 'Try it'

const example = (does: string): TopicTry => ({ target: { kind: 'example' }, does })
const chapter = (task: TaskGroup, does: string): TopicTry => ({ target: { kind: 'chapter', chapter: task }, does })
const objects = (does: string): TopicTry => ({ target: { kind: 'objects' }, does })
const command = (id: string, does: string): TopicTry => ({ target: { kind: 'command', id }, does })

const HOW_EXTRA: ReadonlyArray<{ picture: string; tryIt?: TopicTry }> = [
  { picture: 'folder', tryIt: example('Opens the Example collection: one folder, one window.') },
  { picture: 'plain', tryIt: example('Opens the Example collection: twelve plain Markdown files.') },
  { picture: 'save', tryIt: chapter('Review and versions', 'Opens 05 Review and versions.md, where ⌘S makes a checkpoint.') },
  { picture: 'blocks', tryIt: chapter('Shape the document', 'Opens 02 Shape the document.md, to move and fold lines.') },
  { picture: 'modes', tryIt: chapter('Review and versions', 'Opens 05 Review and versions.md, to switch between Drafting and Reviewing.') },
  { picture: 'agent', tryIt: chapter('Work with the agent', 'Opens 08 Work with the agent.md.') },
  { picture: 'skills', tryIt: chapter('Work with the agent', 'Opens 08 Work with the agent.md, where the skills are.') },
  { picture: 'collections', tryIt: chapter('Collect and plan', 'Opens 07 Collect and plan.md.') },
]

const FEATURES_EXTRA: ReadonlyArray<{ picture: string; tryIt?: TopicTry }> = [
  { picture: 'send', tryIt: command('export.document', 'Opens Export… for the file you have open.') },
  { picture: 'listen', tryIt: command('readAloud.pauseResume', 'Reads the file you have open aloud.') },
  { picture: 'focus', tryIt: command('focus.open', 'Opens Focus and readability.') },
  { picture: 'session', tryIt: command('session.start', 'Starts a timed writing session.') },
  { picture: 'reader', tryIt: command('readingRoom.toggle', 'Opens the Reading Room beside the file you have open.') },
  { picture: 'diagrams', tryIt: objects('Opens 11 Objects.md, with a working table, picture, widget, diagram and more to edit, add and remove.') },
  { picture: 'capture', tryIt: command('idea.capture', 'Opens the idea capture box.') },
  { picture: 'versions', tryIt: command('app.versions', 'Opens Versions for the file you have open.') },
  { picture: 'copy', tryIt: command('copy.rich', 'Copies the file you have open as rich text.') },
  { picture: 'search', tryIt: command('app.search', 'Opens Search across the folder.') },
  { picture: 'settings', tryIt: command('app.settings', 'Opens Settings.') },
]

const build = (prefix: string, text: ReadonlyArray<readonly [string, string]>, extra: typeof HOW_EXTRA): GuideTopic[] =>
  text.map(([title, body], index) => ({ id: `${prefix}.${index + 1}`, title, body, ...extra[index]! }))

export const HOW_IT_WORKS: readonly GuideTopic[] = build('how', HOW_TEXT, HOW_EXTRA)
export const FEATURES: readonly GuideTopic[] = build('feature', FEATURES_TEXT, FEATURES_EXTRA)
export const ALL_TOPICS: readonly GuideTopic[] = [...HOW_IT_WORKS, ...FEATURES]
export const isTopicId = (value: unknown): value is string => typeof value === 'string' && ALL_TOPICS.some((topic) => topic.id === value)

export type TopicTab = 'how' | 'features'
export const topicsOf = (tab: TopicTab): readonly GuideTopic[] => (tab === 'how' ? HOW_IT_WORKS : FEATURES)
