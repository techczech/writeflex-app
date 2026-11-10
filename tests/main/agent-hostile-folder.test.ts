import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridleAuth, createModelService, type Bridle } from '@bridle/core'
import { WorkspaceAgent } from '../../src/main/agent'
import { Workspace } from '../../src/main/workspace'

test('the real WriteFlex factory starts Pi without hostile folder packages or prompt additions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wf-hostile-folder-'))
  const workspace = join(root, 'workspace')
  const appDataDir = join(root, 'app-data')
  const marker = join(root, 'npm-command-ran')
  const markerPhrase = 'WRITEFLEX_HOSTILE_APPEND_SYSTEM_FIXTURE'
  const auth = BridleAuth.inMemory()
  const models = createModelService({ auth, appDataDir, include: ['openai'], fetch: async () => {
    throw new Error('The hostile-folder startup regression must stay offline')
  } })
  let agent: WorkspaceAgent | undefined
  try {
    await mkdir(join(workspace, '.pi'), { recursive: true })
    const command = join(root, 'marker.sh')
    await writeFile(command, `#!/bin/sh\nprintf ran > '${marker}'\nexit 1\n`)
    await chmod(command, 0o755)
    await writeFile(join(workspace, '.pi', 'settings.json'), JSON.stringify({
      packages: ['npm:anything'], npmCommand: [command],
    }))
    await writeFile(join(workspace, '.pi', 'APPEND_SYSTEM.md'), markerPhrase)
    await writeFile(join(workspace, 'APPEND_SYSTEM.md'), markerPhrase)
    // The supported host model-service seam supplies an offline descriptor. The real
    // createBridle/createAgentSession/DefaultResourceLoader path is left intact.
    // No turn is sent, no provider credentials exist, and no provider transport runs.
    const listed = models.list().all[0]!
    const model = { ...models.resolve(listed.provider, listed.id),
      provider: 'writeflex-offline-fixture', id: 'startup-only', baseUrl: 'http://127.0.0.1:1' }
    models.resolve = () => model
    agent = await WorkspaceAgent.create({
      mode: 'work', workspace: new Workspace(workspace), appDataDir, auth, modelService: models,
      defaults: { provider: model.provider, modelId: model.id },
      onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    })
    // Bridle's explicit unsafeSession observation surface exposes the actual Pi
    // session. This cast adds no production option and replaces no runtime object.
    const { unsafeSession: session } = (agent as unknown as { bridle: Bridle }).bridle
    expect(session.constructor.name).toBe('AgentSession')
    expect(session.resourceLoader.constructor.name).toBe('DefaultResourceLoader')
    expect(session.resourceLoader.getAppendSystemPrompt()).toEqual([])
    expect(session.resourceLoader.getAppendSystemPromptSources()).toEqual([])
    expect(session.sessionId.length).toBeGreaterThan(0)
    expect(session.model?.provider).toBe(model.provider)
    expect(session.systemPrompt.length).toBeGreaterThan(0)
    expect(session.systemPrompt).not.toContain(markerPhrase)
    expect(session.systemPrompt).not.toContain('<addendum>')
    expect(existsSync(marker)).toBe(false)
  } finally {
    await agent?.dispose()
    models.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
