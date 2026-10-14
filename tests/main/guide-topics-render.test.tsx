import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { GuideHowItWorksTab } from '../../src/renderer/src/components/GuideHowItWorksTab'
import { GuideFeaturesTab } from '../../src/renderer/src/components/GuideFeaturesTab'
import { tryCaption } from '../../src/renderer/src/components/GuideTopics'
import { FEATURES, HOW_IT_WORKS } from '../../src/shared/guide-topics'

// The two topic tabs as drawn (ticket 08, states 11 and 13 to 16): list rows with Not opened / Read, and What it connects to.
const none = (): void => {}
const sources = { providers: [{ id: 'openai-codex', configured: false }], zoteroFound: true, voices: [{ uri: 'a', name: 'Ava (Enhanced)', lang: 'en', isDefault: false }, { uri: 'b', name: 'Zoe (Enhanced)', lang: 'en', isDefault: false }] }
const how = (read: string[]): string => renderToStaticMarkup(<GuideHowItWorksTab read={read} here overrides={{}} onTopicRead={none} onTry={none} />)
const features = (read: string[], over = sources): string =>
  renderToStaticMarkup(<GuideFeaturesTab read={read} here={false} overrides={{}} onTopicRead={none} onTry={none} sources={over} onConnectionAction={none} />)
const row = (html: string, id: string): string => html.split(`data-topic="${id}"`)[1]!.split('data-topic=')[0]!

test('How it works lists its eight topics with Read or Not opened', () => {
  const html = how(['how.3'])
  expect(html.match(/data-topic="how\.\d"/g)).toHaveLength(8)
  expect(row(html, 'how.3')).toContain('Read')
  expect(row(html, 'how.3')).toContain('data-status="read"')
  expect(row(html, 'how.1')).toContain('Not opened')
  expect(html).toContain(HOW_IT_WORKS[2]!.title)
  expect(html).not.toContain('What it connects to')
})

test('Features lists eleven topics, then What it connects to with the three rows and their one action each', () => {
  const html = features(['feature.2'])
  expect(html.match(/data-topic="feature\.\d+"/g)).toHaveLength(11)
  expect(row(html, 'feature.2')).toContain('data-status="read"')
  expect(html).toContain(FEATURES[10]!.title)
  const connects = html.split('data-guide="connects"')[1]!
  expect(connects).toContain('What it connects to')
  expect(connects).toMatch(/data-connection="model"[^>]*data-state="off"[\s\S]*?Not signed in[\s\S]*?data-action="sign-in"[^>]*>Sign in…/)
  expect(connects).toMatch(/data-connection="zotero"[^>]*data-state="on"[\s\S]*?Found on this Mac/)
  expect(connects).toMatch(/data-connection="voices"[^>]*data-state="on"[\s\S]*?2 enhanced voices installed/)
  expect(connects.match(/data-action="/g)).toHaveLength(1)
})

test('the other states: signed in, Zotero not found, default voice only (state 16)', () => {
  const html = features([], { providers: [{ id: 'openai-codex', configured: true }], zoteroFound: false, voices: [{ uri: 'd', name: 'Daniel', lang: 'en', isDefault: true }] })
  expect(html).toContain('Signed in with ChatGPT')
  expect(html).toMatch(/data-action="get-zotero"[^>]*>Get Zotero/)
  expect(html).toContain('Only the default voice')
  expect(html).toMatch(/data-action="voice-settings"[^>]*>Open voice settings/)
  expect(html).not.toContain('data-action="sign-in"')
})

test('from the person\'s own window a chapter Try it says it opens the Example collection at the file; commands run in place', () => {
  const lesson = HOW_IT_WORKS[2]!
  expect(tryCaption(lesson, true)).toBe('Opens 05 Review and versions.md, where ⌘S makes a checkpoint.')
  expect(tryCaption(lesson, false)).toBe('Opens the Example collection at 05 Review and versions.md.')
  expect(tryCaption(FEATURES[0]!, false)).toBe(FEATURES[0]!.tryIt!.does)
})
