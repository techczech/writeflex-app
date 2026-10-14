import { expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

void mock.module('@bridle/electron/renderer', () => ({
  useIpcAuthFlow: () => ({
    state: { phase: 'idle' }, providers: [], login: async () => {}, respond: () => false,
    setApiKey: () => {}, logout: () => {}, cancel: () => {},
  }),
}))

;(globalThis as { window?: unknown }).window = { writeflex: { auth: {} } }
import { AgentPanel, unavailableModelTitle } from '../../src/renderer/src/components/AgentPanel'
import type { UseAgent } from '../../src/renderer/src/hooks/useAgent'

const markdown = [
  '# Reply',
  '',
  '- First item',
  '  - Nested item',
  '',
  'Use `const value = 1`, **bold text**, *italic text* and [the guide](https://example.com/guide).',
  '',
  '```ts',
  'const answer = 42',
  '```',
  '',
  '| Name | State |',
  '| --- | --- |',
  '| Draft | Ready |',
].join('\n')

function renderConversation(agentText: string, userText = '# Keep **my syntax** plain', agentOverrides: Partial<UseAgent> = {}): string {
  const agent = {
    available: true,
    history: [],
    messages: [
      { kind: 'user', id: 'user-1', text: userText, at: 1 },
      { kind: 'agent', id: 'agent-1', text: agentText, activity: [], at: 2, running: false, undoable: false },
    ],
    suggestions: [],
    running: false,
    model: { provider: 'openai-codex', id: 'gpt-5.5' },
    models: [{ provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' }],
    catalogue: [{ provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' }],
    thinking: 'high',
    modelNotice: null,
    thread: null,
    threadFolder: null,
    completion: null,
    prompt: () => {},
    promptAsIs: () => {},
    promptAsIsOnFolder: () => {},
    replaceState: () => {},
    setModel: async () => {},
    setThinking: async () => {},
    abort: async () => {},
    undoTurn: () => {},
    noteUserSave: () => {},
    noteSuggestionApplied: () => false,
    ...agentOverrides,
  } satisfies UseAgent

  return renderToStaticMarkup(
    <AgentPanel
      agent={agent}
      onClose={() => {}}
      focusRequest={{ tick: 0 }}
      onViewSuggestion={() => {}}
      onExit={() => {}}
      scratchpad={{
        items: [],
        request: { tick: 0, focus: false },
        onToggleDone: () => {},
        onSetColour: () => {},
        onRemove: () => {},
        onInsert: () => {},
        onNewScrap: () => {},
        sources: [],
        onOpenSource: () => {},
        onRevealSource: () => {},
      }}
      embedded
      activeFile={null}
      activeCollectionDir={null}
      onOpenDigestPiece={() => {}}
      onManageSkills={() => {}}
      onOpenAccountSettings={() => {}}
      onShowSkillToast={() => {}}
      onOpenReviewing={() => {}}
      onOpenNotes={() => {}}
    />,
  )
}

test('agent replies render Markdown structure while the writer bubble stays literal text', () => {
  const html = renderConversation(markdown)
  const agentReply = html.match(/<div class="msg-agent">([\s\S]*?)<\/div><\/div><\/div><div class="agent-composer">/)?.[1] ?? ''
  const userBubble = html.match(/<div class="bubble">([\s\S]*?)<\/div>/)?.[1] ?? ''

  expect(agentReply).toContain('<h1>Reply</h1>')
  expect(agentReply).toContain('<ul>')
  expect(agentReply).toContain('<li>First item<ul><li>Nested item</li></ul></li>')
  expect(agentReply).toContain('<code>const value = 1</code>')
  expect(agentReply).toContain('<strong>bold text</strong>')
  expect(agentReply).toContain('<em>italic text</em>')
  expect(agentReply).toContain('<a href="https://example.com/guide" target="_blank" rel="noreferrer noopener">the guide</a>')
  expect(agentReply).toContain('<pre><code data-language="ts">const answer = 42</code></pre>')
  expect(agentReply).toContain('<table><thead><tr><th>Name</th><th>State</th></tr></thead>')
  expect(agentReply).toContain('<tbody><tr><td>Draft</td><td>Ready</td></tr></tbody></table>')
  expect(agentReply).not.toContain('# Reply')
  expect(agentReply).not.toContain('**bold text**')
  expect(agentReply).not.toContain('*italic text*')
  expect(agentReply).not.toContain('[the guide]')
  expect(agentReply).not.toContain('| Name | State |')

  expect(userBubble).toBe('# Keep **my syntax** plain')
  expect(userBubble).not.toContain('<h1>')
  expect(userBubble).not.toContain('<strong>')
})

test('an unterminated fenced reply renders the partial code and does not throw', () => {
  const html = renderConversation('```js\nconst partial = true')
  expect(html).toContain('<pre><code data-language="js">const partial = true</code></pre>')
  expect(html).not.toContain('```')
})

test('the composer control always names the next turn model and reasoning level accessibly', () => {
  const html = renderConversation('Done.')
  expect(html).toContain('aria-label="Model and reasoning for this chat: GPT-5.5; high"')
  expect(html).toContain('GPT-5.5')
  expect(html).toContain('GPT-5.5 · high')
})

test('disabled model choices explain whether the provider is signed out or the model is missing from its available set', () => {
  const available = [{ provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' }]
  expect(unavailableModelTitle(
    { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }, available,
  )).toBe('GPT-5.6 Sol is not in the available model set.')
  expect(unavailableModelTitle(
    { provider: 'anthropic', id: 'claude-opus', name: 'Claude Opus' }, available,
  )).toBe('Anthropic is signed out.')
})
