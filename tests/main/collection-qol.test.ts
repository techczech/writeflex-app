import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { createNestedFolio, turnBackIntoCollection } from '../../src/main/folio-conversion'
import { draftManifest, readManifest } from '../../src/main/folio'
import { writeFolioAgentInstructions } from '../../src/main/folio-agent-instructions'
import { columnOrder, setColumnOrder, orderColumns, moveColumn } from '../../src/renderer/src/components/board-view-state'

import { AGENT_IMPORT } from '../helpers/fake-auth'

const roots: string[] = []
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
afterEach(async () => { if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage'); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'writeflex-collection-qol-')); roots.push(root)
  await mkdir(join(root, 'collection'))
  return { root, ws: new Workspace(root) }
}
test('column order persists, retains new stages, and refuses movement past either end', () => {
  const store = new Map<string, string>()
  globalThis.localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } } as Storage
  const original = ['idea', 'editing', 'ready']
  setColumnOrder('collection', moveColumn(original, 'editing', -1))
  expect(columnOrder('collection')).toEqual(['editing', 'idea', 'ready'])
  expect(columnOrder('other')).toEqual([])
  expect(orderColumns(['idea', 'new', 'editing', 'ready'].map(status => ({ status })), columnOrder('collection')).map(c => c.status)).toEqual(['editing', 'idea', 'ready', 'new'])
  expect(moveColumn(original, 'idea', -1)).toEqual(original)
  expect(moveColumn(original, 'ready', 1)).toEqual(original)
})
test('Start a Folio outline creates a new child with an Index Note; parent stays a collection; repeated creation is distinct', async () => {
  const { root, ws } = await workspace()
  await writeFile(join(root, 'collection/keep.md'), '# Keep\r\n')
  const dir = await createNestedFolio(ws, 'collection')
  expect(dir.startsWith('collection/')).toBe(true)
  expect(await readManifest(ws, 'collection')).toBeNull()
  expect(await readManifest(ws, dir)).not.toBeNull()
  expect(await readFile(join(root, dir, `_${dir.split('/').at(-1)}_INDEX.md`), 'utf8')).toContain('# ')
  expect(await readFile(join(root, 'collection/keep.md'), 'utf8')).toBe('# Keep\r\n')
  expect(await createNestedFolio(ws, 'collection')).not.toBe(dir)
})
test('Make Folio and turn back preserve documents, Index Note and authored instructions byte for byte; Make works again', async () => {
  const { root, ws } = await workspace()
  const originals = { '01-part.md': '# Part\r\n\r\nWords.\r\n', '_collection_INDEX.md': '---\ntitle: Mine\n---\n# Mine\n\n## Running order\n- Part\n', 'AGENTS.md': '# My rules\n\nKeep me.\n', 'CLAUDE.md': '# My Claude rules\n' }
  for (const [name, text] of Object.entries(originals)) await writeFile(join(root, 'collection', name), text)
  await ws.saveFile('collection/_report-structure.json', await draftManifest(ws, 'collection'))
  await writeFolioAgentInstructions(ws, 'collection')
  await turnBackIntoCollection(ws, 'collection')
  expect(await readManifest(ws, 'collection')).toBeNull()
  for (const [name, text] of Object.entries(originals)) expect(await readFile(join(root, 'collection', name), 'utf8')).toBe(name.endsWith('_INDEX.md') ? text.replace('## Running order\n- Part\n', '') : text)
  await ws.saveFile('collection/_report-structure.json', await draftManifest(ws, 'collection'))
  await writeFolioAgentInstructions(ws, 'collection')
  expect(await readManifest(ws, 'collection')).not.toBeNull()
})

test('turn back keeps an authored import, clears only a recorded generated import, and an empty Folio can be made again', async () => {
  const { root, ws } = await workspace()
  const child = await createNestedFolio(ws, 'collection')
  await turnBackIntoCollection(ws, child)
  expect(await Bun.file(join(root, child, 'CLAUDE.md')).exists()).toBe(false)
  expect(await Bun.file(join(root, child, 'AGENTS.md')).exists()).toBe(false)
  await ws.saveFile(`${child}/_report-structure.json`, await draftManifest(ws, child))
  await writeFolioAgentInstructions(ws, child)
  expect(await readFile(join(root, child, 'CLAUDE.md'), 'utf8')).toBe(AGENT_IMPORT + '\n')
  expect(await readManifest(ws, child)).not.toBeNull()
  await writeFile(join(root, 'collection/CLAUDE.md'), AGENT_IMPORT + '\n')
  // Legacy nested data is fixture setup; the workspace write seam now refuses creating it.
  await writeFile(join(root, 'collection/_report-structure.json'), '{"files":[]}\n')
  await turnBackIntoCollection(ws, 'collection')
  expect(await readFile(join(root, 'collection/CLAUDE.md'), 'utf8')).toBe(AGENT_IMPORT + '\n')
})
test('instruction separators round-trip without changing the author’s newline, including after refresh', async () => {
  const { root, ws } = await workspace()
  const { folioAgentInstructionsStatus } = await import('../../src/main/folio-agent-instructions')
  for (const original of ['No newline', 'One newline\n', 'Two newlines\n\n', '# Rules\r\n\r\nMine.\r\n', '']) {
    await writeFile(join(root, 'collection/AGENTS.md'), original)
    await ws.saveFile('collection/_report-structure.json', '{"files":[]}\n')
    await writeFolioAgentInstructions(ws, 'collection')
    await folioAgentInstructionsStatus(ws, 'collection')
    await turnBackIntoCollection(ws, 'collection')
    if (original) expect(await readFile(join(root, 'collection/AGENTS.md'), 'utf8')).toBe(original)
    else expect(await Bun.file(join(root, 'collection/AGENTS.md')).exists()).toBe(false)
  }
})
test('edited maintained instructions retain the author’s words; damaged markers refuse without removing the manifest', async () => {
  const { root, ws } = await workspace()
  const child = await createNestedFolio(ws, 'collection')
  const path = join(root, child, 'AGENTS.md')
  const original = await readFile(path, 'utf8')
  await writeFile(path, original.replace('compiled in a fixed order.', 'compiled in a fixed order. My own addition.'))
  await turnBackIntoCollection(ws, child)
  expect(await readFile(path, 'utf8')).toContain('My own addition.')
  expect(await readFile(path, 'utf8')).not.toContain('<!-- BEGIN')
  await ws.saveFile(`${child}/_report-structure.json`, '{"files":[]}\n')
  await writeFile(path, original.replace('<!-- END WriteFlex Folio instructions -->', '<!-- damaged -->'))
  await expect(turnBackIntoCollection(ws, child)).rejects.toThrow('damaged')
  expect(await readManifest(ws, child)).not.toBeNull()
})
test('conversion refuses hidden folders and instruction symlinks', async () => {
  const { root, ws } = await workspace()
  await expect(createNestedFolio(ws, '.writeflex')).rejects.toThrow('visible folder')
  const child = await createNestedFolio(ws, 'collection')
  const { symlink } = await import('node:fs/promises')
  await rm(join(root, child, 'AGENTS.md'))
  await writeFile(join(root, 'keep.md'), '# Keep\n')
  await symlink(join(root, 'keep.md'), join(root, child, 'AGENTS.md'))
  await expect(turnBackIntoCollection(ws, child)).rejects.toThrow('plain files')
  expect(await readFile(join(root, 'keep.md'), 'utf8')).toBe('# Keep\n')
  expect(await readManifest(ws, child)).not.toBeNull()
})
test('the inverse agent verb requires approval, declares its exact write paths, and preserves content', async () => {
  const { root, ws } = await workspace()
  const { buildWriteFlexManifest, writeflexApprovalPolicy } = await import('../../src/main/capabilities')
  const child = await createNestedFolio(ws, 'collection')
  const verb = buildWriteFlexManifest(ws).capabilities.find(c => c.name === 'folio.turn_back')!
  const policy = writeflexApprovalPolicy()
  for (const trust of ['interactive', 'trusted_app', 'background'] as const) {
    expect(await policy({ capability: verb, input: { dir: child }, trigger: { id: 'conversion', source: 'user', trust } })).toBe(trust === 'background' ? 'deny' : 'ask')
  }
  expect(await verb.touchedPaths!({ dir: child })).toEqual(['_report-structure.json', 'AGENTS.md', 'CLAUDE.md', '.folio-instructions.json', '.folio-backup.json', '.folio-turn-back.json', '_Untitled Folio_INDEX.md'].map(name => join(root, child, name)))
  const result = await verb.execute({ dir: child }, {} as never)
  expect(result.isError).not.toBe(true)
  expect(await readManifest(ws, child)).toBeNull()
})


test('removing markers around an edited CRLF instruction block preserves its authored body bytes', async () => {
  const { newAgentsFile } = await import('../../src/main/folio-agent-instructions')
  const { withoutFolioInstructions } = await import('../../src/main/folio-conversion')
  const source = newAgentsFile().replace(/\n/g, '\r\n').replace('compiled in a fixed order.', 'compiled in a fixed order. My words.')
  const beginEnd = source.indexOf('\n', source.indexOf('<!-- BEGIN')) + 1
  const endStart = source.indexOf('<!-- END')
  expect(withoutFolioInstructions(source)).toContain(source.slice(beginEnd, endStart))
})


test('turn back preserves every byte of a generated CLAUDE file edited by the author', async () => {
  const { root, ws } = await workspace()
  const child = await createNestedFolio(ws, 'collection')
  await writeFile(join(root, child, 'CLAUDE.md'), '# My rules\r\n\r\n' + AGENT_IMPORT + '\r\nKeep these words.\r\n')
  await turnBackIntoCollection(ws, child)
  expect(await readFile(join(root, child, 'CLAUDE.md'), 'utf8')).toBe('# My rules\r\n\r\n' + AGENT_IMPORT + '\r\nKeep these words.\r\n')
})


test('a Folio without an Index Note restores its manifest byte-identically, including roles and metadata', async () => {
  const { root, ws } = await workspace()
  const source = '{\n  "title": "My book", "title_matter": "front.md", "output": "book.html",\n  "files": [ {"path":"front.md","role":"front-matter","toc":false},\n    {"path":"z.md","role":"section","render":"markdown"}, {"path":"a.md","role":"appendix"} ]\n}\n'
  for (const name of ['front.md', 'z.md', 'a.md']) await writeFile(join(root, 'collection', name), '# Part\n')
  await ws.saveFile('collection/_report-structure.json', source)
  await turnBackIntoCollection(ws, 'collection')
  expect(await readManifest(ws, 'collection')).toBeNull()
  const restored = await draftManifest(ws, 'collection')
  expect(restored).toBe(source)
  await ws.saveFile('collection/_report-structure.json', restored)
  const { recordFolioInstructionOwnership } = await import('../../src/main/folio-conversion')
  await recordFolioInstructionOwnership(ws, 'collection', await writeFolioAgentInstructions(ws, 'collection'))
  expect(await readFile(join(root, 'collection/_report-structure.json'), 'utf8')).toBe(source)
})

test('restoring a backup drops missing nested entries and appends new files as sections, retaining authored bytes', async () => {
  const { root, ws } = await workspace()
  await mkdir(join(root, 'collection/contents/nested'), { recursive: true })
  await writeFile(join(root, 'collection/contents/nested/keep.md'), '# Keep\n')
  const kept = '{ "path" : "nested/keep.md", "role":"appendix", "custom":9007199254740993 }'
  const source = '{"content_root":"contents", "title":"Keep", "custom":1e400, "files":[' + kept + ',{"path":"gone.md","role":"front-matter"}]}'
  await ws.saveFile('collection/_report-structure.json', source)
  await turnBackIntoCollection(ws, 'collection')
  await writeFile(join(root, 'collection/contents/new.md'), '# New\n')
  const restored = await draftManifest(ws, 'collection')
  expect(restored).toContain(kept)
  expect(restored).toContain('"custom":1e400')
  expect(JSON.parse(restored).files).toEqual([JSON.parse(kept), { path: 'new.md', role: 'section' }])
})

test('Start a Folio outline and turn back both work at the workspace root', async () => {
  const { root, ws } = await workspace()
  const child = await createNestedFolio(ws, '')
  expect(child).toBe('Untitled Folio')
  // Reproduce existing nested data without bypassing the app's declaration refusal.
  await expect(ws.saveFile('_report-structure.json', '{"files":[]}\n')).rejects.toThrow('already occupies')
  await writeFile(join(root, '_report-structure.json'), '{"files":[]}\n')
  await turnBackIntoCollection(ws, '')
  expect(await readManifest(ws, '')).toBeNull()
  expect(await draftManifest(ws, '')).toBe('{"files":[]}\n')
})

test('legacy appended instructions remove both added newlines from a file without a trailing newline', async () => {
  const { maintainedBlock } = await import('../../src/main/folio-agent-instructions')
  const { withoutFolioInstructions } = await import('../../src/main/folio-conversion')
  expect(withoutFolioInstructions('X\n\n' + maintainedBlock() + '\n')).toBe('X')
})

test('rollback attempts every applied restore and reports the original error plus failed paths', async () => {
  const { root, ws } = await workspace()
  const child = await createNestedFolio(ws, 'collection')
  const ownership = await readFile(join(root, child, '.folio-instructions.json'), 'utf8')
  const agents = await readFile(join(root, child, 'AGENTS.md'), 'utf8')
  const claudePath = child + '/CLAUDE.md'
  const saveCreate = ws.saveFileOver.bind(ws)
  ws.saveFileOver = async (path, next, expected, options) => {
    if (path === claudePath) { attempted.push(path); throw new Error('restore failure') }
    if (next === agents) attempted.push(path)
    return saveCreate(path, next, expected, options)
  }
  const save = ws.saveFileOverRead.bind(ws)
  const remove = ws.removeFileOverRead.bind(ws)
  const attempted: string[] = []
  ws.removeFileOverRead = (path, before) => {
    if (path.endsWith('_report-structure.json')) throw new Error('original conversion failure')
    remove(path, before)
  }
  ws.saveFileOverRead = async (path, next, before, options) => {
    if (next === agents) attempted.push(path)
    return save(path, next, before, options)
  }
  let failure: Error | undefined
  try { await turnBackIntoCollection(ws, child) } catch (error) { failure = error as Error }
  expect(failure?.message).toContain('original conversion failure')
  expect(failure?.message).toContain(claudePath)
  expect(failure?.cause).toBeInstanceOf(Error)
  expect(attempted).toEqual([claudePath, child + '/AGENTS.md'])
  expect(await readFile(join(root, child, 'AGENTS.md'), 'utf8')).toBe(agents)
  expect(await readFile(join(root, child, '.folio-instructions.json'), 'utf8')).toBe(ownership)
  expect(await Bun.file(join(root, child, '.folio-backup.json')).exists()).toBe(false)
})

test('Make and turn back preserve an author-edited generated CLAUDE file byte for byte', async () => {
  const { root, ws } = await workspace()
  const child = await createNestedFolio(ws, 'collection')
  await writeFile(join(root, child, 'CLAUDE.md'), AGENT_IMPORT + '\n# Mine\n')
  await turnBackIntoCollection(ws, child)
  await ws.saveFile(child + '/_report-structure.json', await draftManifest(ws, child))
  await writeFolioAgentInstructions(ws, child)
  expect(await readFile(join(root, child, 'CLAUDE.md'), 'utf8')).toBe(AGENT_IMPORT + '\n# Mine\n')
})

test('agent conversion refuses before any write if the open instruction editors cannot save', async () => {
  const { root, ws } = await workspace()
  const { buildWriteFlexManifest } = await import('../../src/main/capabilities')
  const child = await createNestedFolio(ws, 'collection')
  const source = await readFile(join(root, child, '_report-structure.json'), 'utf8')
  const seen: string[] = []
  const manifest = buildWriteFlexManifest(ws, undefined, { prepareFolioInstructions: async dir => {
    seen.push(dir)
    throw new Error('Save any open AGENTS.md and CLAUDE.md editors before changing this Folio.')
  } })
  for (const name of ['folio.turn_back', 'folio.create_manifest']) {
    const result = await manifest.capabilities.find(c => c.name === name)!.execute({ dir: child }, {} as never)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Save any open AGENTS.md and CLAUDE.md')
  }
  expect(seen).toEqual([child, child])
  expect(await readFile(join(root, child, '_report-structure.json'), 'utf8')).toBe(source)
})

test('Start checkpoints existing instructions before modifying them and refuses inside a Folio accurately', async () => {
  const { root, ws } = await workspace()
  const save = ws.saveFile.bind(ws)
  ws.saveFile = async (path, content, options) => {
    const result = await save(path, content, options)
    if (path.endsWith('_report-structure.json')) await writeFile(join(root, path.replace('_report-structure.json', 'AGENTS.md')), '# Mine\n')
    return result
  }
  const checked: string[] = []
  const child = await createNestedFolio(ws, 'collection', async path => {
    expect(await readFile(join(root, path), 'utf8')).toBe('# Mine\n')
    checked.push(path)
  })
  expect(checked).toEqual([child + '/AGENTS.md'])
  await expect(createNestedFolio(ws, child)).rejects.toThrow("Folios cannot contain another Folio")
})


test('turn back parks generated CLAUDE, clears ownership, then Make preserves a new authored CLAUDE', async () => {
  const { root, ws } = await workspace()
  const child = await createNestedFolio(ws, 'collection')
  await turnBackIntoCollection(ws, child)
  expect(await readFile(join(root, child, '.folio-turn-back.json'), 'utf8')).toContain('CLAUDE.md')
  expect(await Bun.file(join(root, child, '.folio-instructions.json')).exists()).toBe(false)
  const mine = '# My own Claude rules\n'
  await writeFile(join(root, child, 'CLAUDE.md'), mine)
  await ws.saveFile(`${child}/_report-structure.json`, await draftManifest(ws, child))
  await writeFolioAgentInstructions(ws, child)
  expect(await readFile(join(root, child, 'CLAUDE.md'), 'utf8')).toBe(mine)
})

test('normal generated instruction round trip records exact hashes and clears ownership each time', async () => {
  const { root, ws } = await workspace()
  const { createHash } = await import('node:crypto')
  const { recordFolioInstructionOwnership } = await import('../../src/main/folio-conversion')
  const child = await createNestedFolio(ws, 'collection')
  for (let round = 0; round < 2; round++) {
    const text = await readFile(join(root, child, 'CLAUDE.md'), 'utf8')
    const ownership = JSON.parse(await readFile(join(root, child, '.folio-instructions.json'), 'utf8'))
    expect(ownership.claudeHash).toBe(createHash('sha256').update(text).digest('hex'))
    await turnBackIntoCollection(ws, child)
    expect(await Bun.file(join(root, child, 'CLAUDE.md')).exists()).toBe(false)
    expect(await Bun.file(join(root, child, '.folio-instructions.json')).exists()).toBe(false)
    await ws.saveFile(`${child}/_report-structure.json`, await draftManifest(ws, child))
    await recordFolioInstructionOwnership(ws, child, await writeFolioAgentInstructions(ws, child))
  }
})

for (const bad of ['not json', '{"files":5}', '[]', '{"content_root":"../outside","files":[]}']) {
  test(`Make falls back to a fresh running order and warns without changing bad backup: ${bad}`, async () => {
    const { root, ws } = await workspace()
    const { folioConfirmSummaryFromDraft } = await import('../../src/shared/folio-confirm-summary')
    await writeFile(join(root, 'collection/01-part.md'), '# Part\n')
    await writeFile(join(root, 'collection/.folio-backup.json'), bad)
    const warnings: string[] = []
    const draft = await draftManifest(ws, 'collection', warning => warnings.push(warning))
    expect(JSON.parse(draft).files).toEqual([{ path: '01-part.md', role: 'section' }])
    expect(warnings).toEqual(['The saved running order could not be read. A fresh running order was made.'])
    expect(folioConfirmSummaryFromDraft(draft, warnings[0])).toContain(warnings[0])
    const { buildWriteFlexManifest } = await import('../../src/main/capabilities')
    const verb = buildWriteFlexManifest(ws).capabilities.find(c => c.name === 'folio.create_manifest')!
    expect(await verb.preview!({ dir: 'collection' })).toContain(warnings[0])
    expect((await verb.execute({ dir: 'collection' }, {} as never)).isError).not.toBe(true)
    expect((await readManifest(ws, 'collection'))?.files).toEqual([{ path: '01-part.md', role: 'section' }])
    expect(await readFile(join(root, 'collection/.folio-backup.json'), 'utf8')).toBe(bad)
  })
}


test('legacy boolean ownership cannot append to or remove from an authored CLAUDE file', async () => {
  const { root, ws } = await workspace()
  const mine = '# My own Claude rules\n' + AGENT_IMPORT + '\n'
  await writeFile(join(root, 'collection/CLAUDE.md'), mine)
  await ws.saveFile('collection/_report-structure.json', '{"files":[],"_writeflex_folio":{"claudeImportCreated":true}}\n')
  await ws.saveFile('collection/.folio-instructions.json', '{"claudeImportCreated":true}\n')
  await turnBackIntoCollection(ws, 'collection')
  expect(await readFile(join(root, 'collection/CLAUDE.md'), 'utf8')).toBe(mine)
  await writeFile(join(root, 'collection/CLAUDE.md'), '# My own Claude rules\n')
  await ws.saveFile('collection/_report-structure.json', await draftManifest(ws, 'collection'))
  await ws.saveFile('collection/.folio-instructions.json', '{"claudeImportCreated":true}\n')
  await writeFolioAgentInstructions(ws, 'collection')
  expect(await readFile(join(root, 'collection/CLAUDE.md'), 'utf8')).toBe('# My own Claude rules\n')
})
