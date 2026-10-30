import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { ScrapStore } from '../../src/main/scraps'
import { ScratchpadStore, scratchpadStoreSeams } from '../../src/main/scratchpad-store'
import { scratchpadReadVerbs } from '../../src/main/verbs/scratchpad-reads'

// Floating-scratchpad ticket 04 at the store seam: Delete forever (Rejected only, checked
// ownership/version/payload, never a source document) and the agent's lossless sendText.
// Real temporary folders; synthetic text only.

let root: string
let ws: Workspace
let scraps: ScrapStore
let store: ScratchpadStore

const DOC = '# Essay\n\nKeep these words.\n'
const payloadPath = (id: string): string => join(root, '.writeflex', `scratchpad-item-${id}.md`)
const recordPath = (id: string): string => join(root, '.writeflex', `scratchpad-item-${id}.json`)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-scratchpad-t04-'))
  ws = new Workspace(root)
  scraps = new ScrapStore(ws)
  store = new ScratchpadStore(ws, scraps)
  await writeFile(join(root, 'essay.md'), DOC, 'utf8')
})
afterEach(async () => {
  scratchpadStoreSeams.afterDeleteRead = undefined
  await rm(root, { recursive: true, force: true })
})

const rejectedCopy = async (markdown = 'Set aside words.'): Promise<string> => {
  const item = await store.addText({ origin: 'essay.md', markdown, how: 'copy', by: 'writer' })
  await store.setStatus([item.id], 'rejected')
  return item.id
}

describe('delete forever', () => {
  test('a rejected lossless item is removed (record and payload); the source document is untouched', async () => {
    const id = await rejectedCopy()
    await store.deleteRejected(id)
    expect(existsSync(recordPath(id))).toBe(false)
    expect(existsSync(payloadPath(id))).toBe(false)
    await expect(store.get(id)).rejects.toThrow()
    expect(await readFile(join(root, 'essay.md'), 'utf8')).toBe(DOC)
  })

  test('an active item refuses: rejecting deletes nothing, and neither does this refusal', async () => {
    const item = await store.addText({ origin: 'essay.md', markdown: 'Still a candidate.', how: 'copy', by: 'writer' })
    await expect(store.deleteRejected(item.id)).rejects.toThrow('Only a rejected item')
    expect(existsSync(recordPath(item.id))).toBe(true)
    expect(existsSync(payloadPath(item.id))).toBe(true)
    expect((await store.get(item.id)).status).toBe('active')
  })

  test('a concurrent payload edit after the read refuses whole: record and payload both stay', async () => {
    const id = await rejectedCopy()
    scratchpadStoreSeams.afterDeleteRead = async () => { await writeFile(payloadPath(id), 'Changed elsewhere.', 'utf8') }
    await expect(store.deleteRejected(id)).rejects.toThrow('kept')
    expect(existsSync(recordPath(id))).toBe(true)
    expect(await readFile(payloadPath(id), 'utf8')).toBe('Changed elsewhere.')
  })

  test('a payload replaced by a symlink refuses; the link target and the record are untouched', async () => {
    const id = await rejectedCopy()
    const outside = join(root, 'outside.md')
    await writeFile(outside, '# Outside\n', 'utf8')
    await rm(payloadPath(id))
    await symlink(outside, payloadPath(id))
    await expect(store.deleteRejected(id)).rejects.toThrow()
    expect(await readFile(outside, 'utf8')).toBe('# Outside\n')
    expect(existsSync(recordPath(id))).toBe(true)
  })

  test('another workspace root cannot delete this root\'s item', async () => {
    const id = await rejectedCopy()
    const elsewhere = await mkdtemp(join(tmpdir(), 'wf-scratchpad-t04-other-'))
    try {
      const foreign = new ScratchpadStore(new Workspace(elsewhere), null)
      await expect(foreign.deleteRejected(id)).rejects.toThrow()
      expect(existsSync(recordPath(id))).toBe(true)
      expect((await store.get(id)).status).toBe('rejected')
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  test('a rejected legacy scrap leaves its scraps file and its overlay; the origin document stays', async () => {
    await mkdir(join(root, 'scraps'), { recursive: true })
    await writeFile(join(root, 'scraps', 'essay-SCRAPS.md'), '## s_old0001\nAn older cutting.\n\n## s_old0002\nKept scrap.\n', 'utf8')
    const legacyId = 'legacy:essay.md#s_old0001'
    await store.setStatus([legacyId], 'rejected')
    await store.deleteRejected(legacyId)
    const left = await readFile(join(root, 'scraps', 'essay-SCRAPS.md'), 'utf8')
    expect(left).not.toContain('An older cutting.')
    expect(left).toContain('Kept scrap.')
    const after = await store.list({ activePath: 'essay.md' })
    expect(after.items.some((item) => item.id === legacyId)).toBe(false)
    expect(await readFile(join(root, 'essay.md'), 'utf8')).toBe(DOC)
  })

  test('a rejected reference candidate is removed without touching its named source file', async () => {
    const note = join(root, 'research-note.md')
    await writeFile(note, '# Note\n\nA quoted sentence.\n', 'utf8')
    const item = await store.addSource({
      origin: 'essay.md', markdown: '[⟨Note⟩](research-note.md)', kind: 'ref',
      sourceRef: { sourceId: 'ref:path:research-note.md', citationId: 'path:research-note.md', evidenceKind: 'file', target: 'research-note.md', label: 'Note', sourcePath: 'research-note.md' },
    })
    await store.setStatus([item.id], 'rejected')
    await store.deleteRejected(item.id)
    expect(existsSync(recordPath(item.id))).toBe(false)
    expect(await readFile(note, 'utf8')).toBe('# Note\n\nA quoted sentence.\n')
    expect(await readFile(join(root, 'essay.md'), 'utf8')).toBe(DOC)
  })
})

describe('agent scratchpad.send_text', () => {
  const verb = () => scratchpadReadVerbs(ws, scraps).find((entry) => entry.id === 'scratchpad.send_text')!
  const ctx = { trigger: { id: 't', source: 'user', trust: 'interactive' }, sessionId: 's', attemptId: 'a', idempotencyKey: 'a', audit: () => {} } as never

  test('exact Markdown is filed as an agent candidate, bypassing the legacy heading grammar', async () => {
    const exact = '\n\n## Kept heading\n\n```md\n## s_fake inside a fence\n```\n\nTail with trailing spaces.  \n'
    const result = await verb().run(ctx, { origin: 'essay.md', markdown: exact, group: 'Methods' } as never)
    expect(result.text).toContain('Filed p_')
    const snapshot = await store.list({ activePath: 'essay.md' })
    const filed = snapshot.items.find((item) => item.markdown === exact)
    expect(filed).toBeDefined()
    expect(filed).toMatchObject({ kind: 'text', how: 'copy', by: 'agent', status: 'active' })
    expect(snapshot.groups.find((group) => group.id === filed!.group)?.name).toBe('Methods')
    expect(await readFile(payloadPath(filed!.id), 'utf8')).toBe(exact)
    // Nothing went through the legacy grammar, and no document changed.
    expect(existsSync(join(root, 'scraps'))).toBe(false)
    expect(await readFile(join(root, 'essay.md'), 'utf8')).toBe(DOC)
  })

  test('an origin outside the workspace documents is refused and nothing is filed', async () => {
    const result = await verb().run(ctx, { origin: 'missing.md', markdown: 'Nowhere text.' } as never)
    expect(result.text).toContain('Not a document in this workspace')
    expect((await store.list({ activePath: 'essay.md' })).items).toEqual([])
  })
})
