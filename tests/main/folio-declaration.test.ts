import * as fs from 'node:fs'
import { afterEach, expect, test, spyOn } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { folioDeclaration } from '../../src/main/folio-declaration'
import { declaresRunningOrder, parkRunningOrder } from '../../src/shared/folio-declaration'
import { folioDirOwning, indexDeclaresPlan, isFolioFolderNow } from '../../src/main/folio-place'
import { isFolio } from '../../src/main/sharing-folio'
import { folderIsFolio } from '../../src/renderer/src/app/folio-routing'
import { registerFolioAgentInstructionsIpc } from '../../src/main/folio-agent-instructions-ipc'
import { restoreTurnedBackFolio, turnBackIntoCollection, createNestedFolio } from '../../src/main/folio-conversion'
import { writeFolioAgentInstructions } from '../../src/main/folio-agent-instructions'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'wf-declaration-')); roots.push(root)
  await mkdir(join(root, 'book'))
  for (const [name, source] of Object.entries(files)) await writeFile(join(root, 'book', name), source)
  return { root, ws: new Workspace(root) }
}
const manifest = '{ "files" : [], "custom": 9007199254740993 }\r\n'
const running = '# Book\r\n\r\n## Running order (draft)\r\n- Unwritten\r\n'
for (const [name, files, expected] of [
  ['manifest only', { '_report-structure.json': manifest }, true],
  ['Index Note only', { '_book_INDEX.md': running }, true],
  ['both', { '_report-structure.json': manifest, '_book_INDEX.md': running }, true],
  ['neither', { '_book_INDEX.md': '# Cover\n' }, false],
  ['heading in fenced code', { '_book_INDEX.md': '```md\n## Running order\n```\n' }, false],
  ['heading in indented code', { '_book_INDEX.md': '    ## Running order\n' }, false],
  ['draft heading', { '_book_INDEX.md': '## Running order (draft)\n' }, true],
  ['unreadable manifest still declares', { '_report-structure.json': 'broken json' }, true],
  ['unfinished Turn back', { '.folio-backup.json': manifest, '_book_INDEX.md': running }, false],
] as Array<[string, Record<string, string>, boolean]>) {
  test(`all Folio callers agree: ${name}; reads write nothing`, async () => {
    const { root, ws } = await fixture(files)
    const before = await readdir(join(root, 'book'))
    expect(folioDeclaration(ws, 'book').isFolio).toBe(expected)
    expect(isFolioFolderNow(root, 'book')).toBe(expected)
    expect(await isFolio(root, 'book')).toBe(expected)
    expect(await folderIsFolio('book', { readFolioDeclaration: async dir => folioDeclaration(ws, dir) })).toBe(expected)
    expect(await folioDirOwning(ws, 'book')).toBe(expected ? 'book' : null)
    const handlers = new Map<string, Function>()
    registerFolioAgentInstructionsIpc({ handle: (key, fn) => handlers.set(key, fn) }, {
      stateForSender: () => ws, requireWorkspace: state => state,
      checkpointFile: async () => { throw new Error('read wrote') },
      notifyCollectionChanged: () => { throw new Error('read wrote') }, notifyChangedOnDisk: () => { throw new Error('read wrote') },
    })
    expect((await handlers.get('folio:agent-instructions')!({ sender: { id: 1 } }, { dir: 'book' })) !== null).toBe(expected)
    expect(await indexDeclaresPlan(ws, 'book')).toBe(declaresRunningOrder(files['_book_INDEX.md'] ?? '') && name !== 'unfinished Turn back')
    expect(await readdir(join(root, 'book'))).toEqual(before)
    for (const [file, source] of Object.entries(files)) expect(await readFile(join(root, 'book', file), 'utf8')).toBe(source)
  })
}

test('Turn back and exact restoration preserve the manifest, all Running order headings and instructions', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running + '\r\n## Running order\r\n- More\r\n', 'AGENTS.md': '# Author\r\nKeep me.\r\n' })
  await writeFolioAgentInstructions(ws, 'book')
  const names = await readdir(join(root, 'book'))
  const original = new Map(await Promise.all(names.map(async name => [name, await readFile(join(root, 'book', name), 'utf8')] as const)))
  await turnBackIntoCollection(ws, 'book')
  expect(folioDeclaration(ws, 'book')).toMatchObject({ isFolio: false, repairNeeded: false, runningOrder: false })
  expect(await readFile(join(root, 'book/AGENTS.md'), 'utf8')).toBe('# Author\r\nKeep me.\r\n')
  expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe('# Book\r\n\r\n')
  const backup = await readFile(join(root, 'book/.folio-turn-back.json'), 'utf8')
  expect(backup).toContain('Running order')
  await restoreTurnedBackFolio(ws, 'book')
  for (const [name, source] of original) expect(await readFile(join(root, 'book', name), 'utf8')).toBe(source)
  expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
  await turnBackIntoCollection(ws, 'book')
  await writeFile(join(root, 'book/_book_INDEX.md'), '# Changed after Turn back\n')
  await expect(restoreTurnedBackFolio(ws, 'book')).rejects.toThrow()
  expect(await readdir(join(root, 'book'))).not.toContain('_report-structure.json')
  expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe('# Changed after Turn back\n')
})

test('generated AGENTS is parked, never left empty; Make Folio restores every byte through the agent seam', async () => {
  const { root, ws } = await fixture({})
  const dir = await createNestedFolio(ws, 'book')
  const original = await readFile(join(root, dir, 'AGENTS.md'), 'utf8')
  await turnBackIntoCollection(ws, dir)
  expect(await readdir(join(root, dir))).not.toContain('AGENTS.md')
  const { buildWriteFlexManifest } = await import('../../src/main/capabilities')
  const result = await buildWriteFlexManifest(ws).capabilities.find(c => c.name === 'folio.create_manifest')!.execute({ dir }, {} as never)
  expect(result.isError).not.toBe(true)
  expect(await readFile(join(root, dir, 'AGENTS.md'), 'utf8')).toBe(original)
})

test('legacy half-state can finish Turn back explicitly, without losing its list or backup', async () => {
  const { root, ws } = await fixture({ '.folio-backup.json': manifest, '_book_INDEX.md': running, 'AGENTS.md': '' })
  expect(folioDeclaration(ws, 'book').repairNeeded).toBe(true)
  await turnBackIntoCollection(ws, 'book')
  expect(folioDeclaration(ws, 'book')).toMatchObject({ isFolio: false, repairNeeded: false })
  expect(await readFile(join(root, 'book/.folio-backup.json'), 'utf8')).toBe(manifest)
  expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe('# Book\r\n\r\n')
})

test('restoration refuses symlinked files and never writes into another folder', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  await turnBackIntoCollection(ws, 'book')
  await writeFile(join(root, 'outside.md'), 'Keep')
  await rm(join(root, 'book/_book_INDEX.md'))
  await symlink(join(root, 'outside.md'), join(root, 'book/_book_INDEX.md'))
  await expect(restoreTurnedBackFolio(ws, 'book')).rejects.toThrow()
  expect(await readFile(join(root, 'outside.md'), 'utf8')).toBe('Keep')
})

test('Undo refuses new instruction files, and preserves every file on refusal', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  await turnBackIntoCollection(ws, 'book')
  await writeFile(join(root, 'book/AGENTS.md'), '# New author instructions\n')
  const before = await readdir(join(root, 'book'))
  const texts = await Promise.all(before.map(name => readFile(join(root, 'book', name), 'utf8')))
  await expect(restoreTurnedBackFolio(ws, 'book')).rejects.toThrow()
  expect(await readdir(join(root, 'book'))).toEqual(before)
  expect(await Promise.all(before.map(name => readFile(join(root, 'book', name), 'utf8')))).toEqual(texts)
})

test('Make Folio after finishing a legacy half-state creates the manifest and preserves the empty instruction file', async () => {
  const { root, ws } = await fixture({ '.folio-backup.json': manifest, '_book_INDEX.md': running, 'AGENTS.md': '' })
  await turnBackIntoCollection(ws, 'book')
  const { buildWriteFlexManifest } = await import('../../src/main/capabilities')
  const result = await buildWriteFlexManifest(ws).capabilities.find(c => c.name === 'folio.create_manifest')!.execute({ dir: 'book' }, {} as never)
  expect(result.isError).not.toBe(true)
  expect(folioDeclaration(ws, 'book')).toMatchObject({ isFolio: true, repairNeeded: false, manifest: true })
  expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe(running)
  expect(await readFile(join(root, 'book/AGENTS.md'), 'utf8')).toBe('')
})

test('parking removes only Running order sections; surrounding text, line endings and code stay exact', () => {
  const before = '# Book\r\nCover prose.\r\n\r\n```md\r\n## Running order\r\n- Example\r\n```\r\n\r\n'
  const section = '## Running order (draft)\r\n- [[One]]\r\n- [[Two]]\r\n```md\r\n## Not a section boundary\r\n```\r\n\r\n'
  const after = '## Notes\r\nKeep these lines.\r\n\r\n### Detail\r\nAnd these.\r\n'
  expect(parkRunningOrder(before + section + after)).toBe(before + after)
  expect(parkRunningOrder('## Running order\n- One')).toBe('')
  expect(parkRunningOrder(before + after)).toBe(before + after)
})

test('Turn back refuses non-UTF-8 originals instead of parking a lossy copy', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  const bytes = Buffer.from([0x23, 0x20, 0xff, 0x0a])
  await writeFile(join(root, 'book/AGENTS.md'), bytes)
  await expect(turnBackIntoCollection(ws, 'book')).rejects.toThrow('backed up exactly')
  expect(await readFile(join(root, 'book/AGENTS.md'))).toEqual(bytes)
  expect(await readFile(join(root, 'book/_report-structure.json'), 'utf8')).toBe(manifest)
  expect(await readdir(join(root, 'book'))).not.toContain('.folio-turn-back.json')
})

test('Undo compares raw bytes even when a lossy UTF-8 decode would look unchanged', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running, 'AGENTS.md': 'Replacement: \ufffd\n' })
  await turnBackIntoCollection(ws, 'book')
  const changed = Buffer.concat([Buffer.from('Replacement: '), Buffer.from([0xff, 0x0a])])
  await writeFile(join(root, 'book/AGENTS.md'), changed)
  await expect(restoreTurnedBackFolio(ws, 'book')).rejects.toThrow('changed on disk')
  expect(await readFile(join(root, 'book/AGENTS.md'))).toEqual(changed)
  expect(await readdir(join(root, 'book'))).not.toContain('_report-structure.json')
})

test('an unchanged generated AGENTS file from an older template is parked and restored byte-exactly', async () => {
  const { newAgentsFile } = await import('../../src/main/folio-agent-instructions')
  const agents = newAgentsFile('Earlier maintained template.').replaceAll('\n', '\r\n')
  const { root, ws } = await fixture({ '_report-structure.json': manifest, 'AGENTS.md': agents })
  await turnBackIntoCollection(ws, 'book')
  expect(await readdir(join(root, 'book'))).not.toContain('AGENTS.md')
  await restoreTurnedBackFolio(ws, 'book')
  expect(await readFile(join(root, 'book/AGENTS.md'), 'utf8')).toBe(agents)
})


async function makeFolio(ws: Workspace, dir = 'book') {
  const { buildWriteFlexManifest } = await import('../../src/main/capabilities')
  return buildWriteFlexManifest(ws).capabilities.find(c => c.name === 'folio.create_manifest')!.execute({ dir }, {} as never)
}

for (const changed of ['_book_INDEX.md', 'AGENTS.md', 'CLAUDE.md']) {
  test(`Make Folio drafts after a later ${changed} edit and reports the parked bytes`, async () => {
    const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
    await turnBackIntoCollection(ws, 'book')
    await writeFile(join(root, 'book', changed), '# New author text\n')
    const result = await makeFolio(ws)
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result)).toContain('not reapplied')
    expect(JSON.stringify(result)).toContain('.folio-turn-back.json')
    expect((await readFile(join(root, 'book', changed), 'utf8')).startsWith('# New author text\n')).toBe(true)
    expect(folioDeclaration(ws, 'book').manifest).toBe(true)
    expect(await readFile(join(root, 'book/.folio-turn-back.json'), 'utf8')).toContain('Running order')
  })
}

test('twenty Turn back / restore cycles retire receipts and keep their size bounded', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running.repeat(20) })
  const sizes: number[] = []
  for (let cycle = 0; cycle < 20; cycle++) {
    await turnBackIntoCollection(ws, 'book')
    sizes.push((await readFile(join(root, 'book/.folio-turn-back.json'))).length)
    await restoreTurnedBackFolio(ws, 'book')
    expect(await readdir(join(root, 'book'))).not.toContain('.folio-turn-back.json')
  }
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(100)
  expect((await readdir(join(root, 'book'))).filter(name => name.startsWith('.folio-turn-back'))).toHaveLength(0)
})

test('a new Running order after Turn back declares a Folio even beside a manifest backup', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  await turnBackIntoCollection(ws, 'book')
  await writeFile(join(root, 'book/_book_INDEX.md'), running)
  expect(folioDeclaration(ws, 'book')).toMatchObject({ isFolio: true, repairNeeded: false })
})

test('Index-Note-only Turn back does not fabricate a manifest backup and keeps an empty author AGENTS', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running, 'AGENTS.md': '' })
  await turnBackIntoCollection(ws, 'book')
  expect(await readdir(join(root, 'book'))).not.toContain('.folio-backup.json')
  expect(await readFile(join(root, 'book/AGENTS.md'), 'utf8')).toBe('')
  await restoreTurnedBackFolio(ws, 'book')
  expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe(running)
})

test('a corrupt receipt is reported but does not block Make Folio', async () => {
  const { root, ws } = await fixture({ '.folio-turn-back.json': '{broken', '01-Part.md': '# Part' })
  const result = await makeFolio(ws)
  expect(result.isError).not.toBe(true)
  expect(JSON.stringify(result)).toContain('could not be read')
  expect(JSON.stringify(result)).toContain('not reapplied')
  expect(await readFile(join(root, 'book/.folio-turn-back.json'), 'utf8')).toBe('{broken')
  expect(folioDeclaration(ws, 'book').manifest).toBe(true)
})

test('a second Turn back recovers a pending receipt after only some conversion writes landed', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  await turnBackIntoCollection(ws, 'book')
  const path = join(root, 'book/.folio-turn-back.json')
  const receipt = JSON.parse(await readFile(path, 'utf8'))
  receipt.status = 'pending'
  // Simulate a crash after the Index Note write but before removing the manifest.
  await writeFile(join(root, 'book/_report-structure.json'), manifest)
  await writeFile(path, JSON.stringify(receipt))
  await turnBackIntoCollection(ws, 'book')
  expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('complete')
  await restoreTurnedBackFolio(ws, 'book')
  expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe(running)
  expect(await readFile(join(root, 'book/_report-structure.json'), 'utf8')).toBe(manifest)
})

test('nested Folio creation refuses an Index-Note-only parent', async () => {
  const { ws } = await fixture({ '_book_INDEX.md': running })
  await expect(createNestedFolio(ws, 'book')).rejects.toThrow("Folios cannot contain another Folio")
})

test('tab groups use the Running order declaration before a nearer collection cover', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/parts'))
  await writeFile(join(root, 'book/parts/README.md'), '# Parts')
  const { resolveTabGroups } = await import('../../src/main/tab-groups')
  expect(await resolveTabGroups(ws, ['book/parts/one.md'])).toEqual({ 'book/parts/one.md': 'book' })
})


test('Make Folio preview is the exact restored manifest, including when a new file was added', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  await turnBackIntoCollection(ws, 'book')
  await writeFile(join(root, 'book/02-new.md'), '# New')
  const { prepareMakeFolio } = await import('../../src/main/folio-conversion')
  const preview = await prepareMakeFolio(ws, 'book')
  expect(preview.draft).toBe(manifest)
  await makeFolio(ws)
  expect(await readFile(join(root, 'book/_report-structure.json'), 'utf8')).toBe(preview.draft)
})

test('a later conversion preserves a stale receipt without embedding or escaping it', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  await turnBackIntoCollection(ws, 'book')
  const parked = await readFile(join(root, 'book/.folio-turn-back.json'), 'utf8')
  await writeFile(join(root, 'book/_book_INDEX.md'), '# New cover')
  await makeFolio(ws)
  await turnBackIntoCollection(ws, 'book')
  const files = await readdir(join(root, 'book'))
  const retired = files.filter(name => name.startsWith('.folio-turn-back-retired-'))
  expect(retired).toHaveLength(1)
  expect(await readFile(join(root, 'book', retired[0]), 'utf8')).toBe(parked)
  expect(JSON.parse(await readFile(join(root, 'book/.folio-turn-back.json'), 'utf8')).previousReceipt).toBeUndefined()
})

for (const landed of [0, 1, 2, 3, 4, 5, 6]) {
  test(`pending Turn back restores after ${landed} writes landed`, async () => {
    const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
    await turnBackIntoCollection(ws, 'book')
    const path = join(root, 'book/.folio-turn-back.json')
    const receipt = JSON.parse(await readFile(path, 'utf8'))
    for (const edit of receipt.edits.slice(landed)) {
      if (edit.before === null) await rm(join(root, edit.path), { force: true })
      else await writeFile(join(root, edit.path), edit.before)
    }
    receipt.status = 'pending'
    await writeFile(path, JSON.stringify(receipt))
    await restoreTurnedBackFolio(ws, 'book')
    expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe(running)
    expect(await readFile(join(root, 'book/_report-structure.json'), 'utf8')).toBe(manifest)
    expect(await readdir(join(root, 'book'))).not.toContain('.folio-turn-back.json')
  })
}


test('Make Folio drafts when a previously absent Index Note was created after Turn back', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest })
  await turnBackIntoCollection(ws, 'book')
  await writeFile(join(root, 'book/_book_INDEX.md'), '# New cover\n')
  const result = await makeFolio(ws)
  expect(result.isError).not.toBe(true)
  expect(JSON.stringify(result)).toContain('not reapplied')
  expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe('# New cover\n')
})

test('a stale receipt retirement is included in the agent snapshot paths', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  await turnBackIntoCollection(ws, 'book')
  await writeFile(join(root, 'book/_book_INDEX.md'), '# New cover')
  await makeFolio(ws)
  const { buildWriteFlexManifest } = await import('../../src/main/capabilities')
  const verb = buildWriteFlexManifest(ws).capabilities.find(c => c.name === 'folio.turn_back')!
  const declared = await verb.touchedPaths!({ dir: 'book' })
  const result = await verb.execute({ dir: 'book' }, {} as never)
  expect(result.isError).not.toBe(true)
  for (const path of (result.details as { paths: string[] }).paths) expect(declared).toContain(ws.absolute(path))
})

test('the pending receipt is on disk before any Turn back edits, and complete only afterwards', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  const original = ws.saveFileOverRead.bind(ws)
  const seen: string[] = []
  ws.saveFileOverRead = async (...args) => {
    if (args[0] === 'book/_book_INDEX.md') {
      const receipt = JSON.parse(await readFile(join(root, 'book/.folio-turn-back.json'), 'utf8'))
      seen.push(receipt.status)
      expect(receipt.edits.find((edit: { path: string }) => edit.path === args[0]).before).toBe(running)
    }
    return original(...args)
  }
  await turnBackIntoCollection(ws, 'book')
  expect(seen).toEqual(['pending'])
  expect(JSON.parse(await readFile(join(root, 'book/.folio-turn-back.json'), 'utf8')).status).toBe('complete')
})


test('Make Folio preserves restored older instructions for an Index-Note-only Folio', async () => {
  const { newAgentsFile } = await import('../../src/main/folio-agent-instructions')
  const agents = newAgentsFile('Earlier maintained template.')
  const { root, ws } = await fixture({ '_book_INDEX.md': running, 'AGENTS.md': agents })
  await turnBackIntoCollection(ws, 'book')
  const result = await makeFolio(ws)
  expect(result.isError).not.toBe(true)
  expect(await readFile(join(root, 'book/AGENTS.md'), 'utf8')).toBe(agents)
  expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe(running)
})


test('Turn back records its own removals so delayed watcher events do not expire immediate Undo', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest })
  await writeFolioAgentInstructions(ws, 'book')
  await turnBackIntoCollection(ws, 'book')
  expect(ws.wasRecentlyWrittenByApp('book/_report-structure.json')).toBe(true)
  expect(ws.wasRecentlyWrittenByApp('book/AGENTS.md')).toBe(true)
  // A genuinely later create must still be reported, even inside the own-write window.
  await writeFile(join(root, 'book/AGENTS.md'), '# Author')
  expect(ws.wasRecentlyWrittenByApp('book/AGENTS.md')).toBe(false)
})


for (const crash of ['before writes', 'after writes then Make']) {
  test(`stale pending Turn back is archived and replaced: ${crash}`, async () => {
    const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
    await turnBackIntoCollection(ws, 'book')
    const receiptPath = join(root, 'book/.folio-turn-back.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    receipt.status = 'pending'
    if (crash === 'before writes') {
      for (const edit of receipt.edits) {
        if (edit.before === null) await rm(join(root, edit.path), { force: true })
        else await writeFile(join(root, edit.path), edit.before)
      }
    }
    const parked = JSON.stringify(receipt)
    await writeFile(receiptPath, parked)
    await writeFile(join(root, 'book/_book_INDEX.md'), '# Later author edit\n')
    if (crash !== 'before writes') expect((await makeFolio(ws)).isError).not.toBe(true)
    await turnBackIntoCollection(ws, 'book')
    const retired = (await readdir(join(root, 'book'))).filter(name => name.startsWith('.folio-turn-back-retired-'))
    expect(retired).toHaveLength(1)
    expect(await readFile(join(root, 'book', retired[0]), 'utf8')).toBe(parked)
    expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe('# Later author edit\n')
    expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
  })
}

test('Index Note only Make restores Beta before Alpha without adding a manifest, and writes missing instructions', async () => {
  const ordered = '# Book\r\n\r\n## Running order\r\n- [[02-Beta]]\r\n- [[01-Alpha]]\r\n'
  const { root, ws } = await fixture({ '_book_INDEX.md': ordered, '01-Alpha.md': '# Alpha', '02-Beta.md': '# Beta' })
  await turnBackIntoCollection(ws, 'book')
  const result = await makeFolio(ws)
  expect(result.isError).not.toBe(true)
  expect(JSON.stringify(result)).toContain('Restored')
  expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe(ordered)
  expect(await readdir(join(root, 'book'))).not.toContain('_report-structure.json')
  expect(await readFile(join(root, 'book/AGENTS.md'), 'utf8')).toContain('Folio')
  const { folioPieces } = await import('../../src/main/folio')
  expect(await folioPieces(ws, 'book')).toBeNull()
  const { readPlan } = await import('../../src/main/plan')
  expect((await readPlan(ws, 'book'))?.parts.map(part => part.path)).toEqual(['book/02-Beta.md', 'book/01-Alpha.md'])
})

for (const marker of ['_report-structure.json', '_book_INDEX.md']) {
  for (const target of ['book/ch', '']) {
    test(`Make refuses nested Folio target ${target || 'root'} with ${marker}`, async () => {
      const { root, ws } = await fixture({ [marker]: marker.endsWith('.json') ? manifest : running, '01-Part.md': '# Part' })
      await mkdir(join(root, 'book/ch'))
      await writeFile(join(root, 'book/ch/01-Part.md'), '# Child')
      await writeFile(join(root, '01-Part.md'), '# Root')
      const result = await makeFolio(ws, target)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).toContain('book')
      expect(await readdir(join(root, target))).not.toContain(target === '' ? '_report-structure.json' : 'AGENTS.md')
    })
  }
}

test('Index Note only focus and instruction exclusion use the Folio declaration', async () => {
  const { ws } = await fixture({ '_book_INDEX.md': running, 'AGENTS.md': '# Instructions' })
  const { isFolioAgentInstructionsFile } = await import('../../src/main/folio')
  const { folderFocusKind } = await import('../../src/main/folder-focus')
  expect(isFolioAgentInstructionsFile(ws, 'book/AGENTS.md')).toBe(true)
  expect(await folderFocusKind(ws, 'book')).toBe('folio')
})

test('stale receipt cycles preserve the original Running order bytes in retired receipts after six cycles', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  for (let i = 0; i < 6; i++) {
    await turnBackIntoCollection(ws, 'book')
    await writeFile(join(root, 'book/_book_INDEX.md'), `# Cover ${i}`)
    await makeFolio(ws)
  }
  await turnBackIntoCollection(ws, 'book')
  const names = (await readdir(join(root, 'book'))).filter(name => name.startsWith('.folio-turn-back-retired-'))
  expect(names).toHaveLength(6)
  const receipts = await Promise.all(names.map(async name => JSON.parse(await readFile(join(root, 'book', name), 'utf8'))))
  expect(receipts.some(receipt => receipt.edits.some((edit: { before: string | null }) => edit.before === running))).toBe(true)
})


test('Make falls back when files change after the restore preview, while strict Undo refuses', async () => {
  const { prepareMakeFolio } = await import('../../src/main/folio-conversion')
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  await turnBackIntoCollection(ws, 'book')
  const preview = await prepareMakeFolio(ws, 'book')
  await writeFile(join(root, 'book/_book_INDEX.md'), '# Changed during confirm')
  await expect(restoreTurnedBackFolio(ws, 'book', { expectedSource: preview.receiptSource })).rejects.toThrow('changed on disk')
  expect(await restoreTurnedBackFolio(ws, 'book', { expectedSource: preview.receiptSource, fallback: true })).toBeNull()
  expect((await makeFolio(ws)).isError).not.toBe(true)
  expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe('# Changed during confirm')
})

test('retirement path ignores receipt mtime and refuses bytes outside the snapshot', async () => {
  const { utimes } = await import('node:fs/promises')
  const { buildWriteFlexManifest } = await import('../../src/main/capabilities')
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  await turnBackIntoCollection(ws, 'book')
  await writeFile(join(root, 'book/_book_INDEX.md'), '# Changed')
  await makeFolio(ws)
  const verb = buildWriteFlexManifest(ws).capabilities.find(c => c.name === 'folio.turn_back')!
  const declared = await verb.touchedPaths!({ dir: 'book' })
  await utimes(join(root, 'book/.folio-turn-back.json'), new Date('2001-01-01'), new Date('2001-01-01'))
  const result = await verb.execute({ dir: 'book' }, { resolvedTouchedPaths: declared } as never)
  expect(result.isError).not.toBe(true)
  for (const path of (result.details as { paths: string[] }).paths) expect(declared).toContain(ws.absolute(path))
  await makeFolio(ws)
  await writeFile(join(root, 'book/.folio-turn-back.json'), '{different receipt')
  const refused = await verb.execute({ dir: 'book' }, { resolvedTouchedPaths: declared } as never)
  expect(refused.isError).toBe(true)
  expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
})


test('P8: Undo Turn back refuses a newly declared ancestor Folio without changing the receipt', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  await turnBackIntoCollection(ws, 'book')
  const receipt = await readFile(join(root, 'book/.folio-turn-back.json'), 'utf8')
  await writeFile(join(root, '_report-structure.json'), manifest)
  await expect(restoreTurnedBackFolio(ws, 'book')).rejects.toThrow('workspace root')
  expect(await readFile(join(root, 'book/.folio-turn-back.json'), 'utf8')).toBe(receipt)
  expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
})

for (const existingIndex of [false, true]) {
  for (const route of ['index', 'plan', 'proposal'] as const) {
    if (route === 'index' && existingIndex) continue
    test(`${route} refuses declaring above a descendant Folio; existing Index Note: ${existingIndex}`, async () => {
      const { root, ws } = await fixture(existingIndex ? { '_book_INDEX.md': '# Book\n' } : {})
      await mkdir(join(root, 'book/ch'))
      await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
      if (route === 'plan' && !existingIndex) await writeFile(join(root, 'book/_report-structure.json'), manifest)
      const before = await readdir(join(root, 'book'))
      if (route === 'index') {
        const { createIndexNote } = await import('../../src/main/collection')
        await expect(createIndexNote(ws, 'book')).rejects.toThrow('book/ch')
      } else if (route === 'proposal') {
        const { prepareProposal } = await import('../../src/main/plan-proposal')
        await expect(prepareProposal(ws, { dir: 'book', changes: [{ op: 'insert', title: 'Part' }] })).rejects.toThrow('book/ch')
      } else {
        const { insertPart } = await import('../../src/main/plan')
        await expect(insertPart(ws, 'book', 0, { title: 'Part' }, { createsIndexNote: true })).rejects.toThrow('book/ch')
      }
      expect(await readdir(join(root, 'book'))).toEqual(before)
      if (existingIndex) expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe('# Book\n')
    })
  }
}

test('Start Folio chooses the unused suffix before checking related Folios', async () => {
  const { root, ws } = await fixture({})
  await mkdir(join(root, 'book/Untitled Folio/ch'), { recursive: true })
  await writeFile(join(root, 'book/Untitled Folio/ch/_report-structure.json'), manifest)
  expect(await createNestedFolio(ws, 'book')).toBe('book/Untitled Folio 2')
})


test('P10: an unreadable descendant is skipped with a plain report and Make can continue', async () => {
  const { assertNoRelatedFolio } = await import('../../src/main/folio-declaration')
  const { root, ws } = await fixture({ '01-Part.md': '# Part' })
  const locked = join(root, 'book/locked')
  await mkdir(locked)
  await chmod(locked, 0)
  const messages: string[] = []
  try {
    await assertNoRelatedFolio(ws, 'book', message => messages.push(message))
    expect(messages).toEqual(['Skipped book/locked while checking for Folios because the folder or its Index Note could not be read.'])
    expect((await makeFolio(ws)).isError).not.toBe(true)
  } finally { await chmod(locked, 0o700) }
})

test('an unreadable descendant Index Note is skipped and named in plain words', async () => {
  const { assertNoRelatedFolio } = await import('../../src/main/folio-declaration')
  const { root, ws } = await fixture({})
  await mkdir(join(root, 'book/child'))
  const path = join(root, 'book/child/_child_INDEX.md')
  await writeFile(path, running)
  await chmod(path, 0)
  const messages: string[] = []
  try {
    await assertNoRelatedFolio(ws, 'book', message => messages.push(message))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Skipped book/child')
    expect(messages[0]).not.toContain('EACCES')
  } finally { await chmod(path, 0o600) }
})

test('the related Folio walk skips only the app walk exclusions', async () => {
  const { assertNoRelatedFolio } = await import('../../src/main/folio-declaration')
  const { root, ws } = await fixture({})
  for (const name of ['.git', 'node_modules', '.writeflex', '.folio-bin', 'out', 'release', '.old']) {
    await mkdir(join(root, 'book', name))
    await writeFile(join(root, 'book', name, '_report-structure.json'), manifest)
  }
  await assertNoRelatedFolio(ws, 'book')
  expect(await createNestedFolio(ws, 'book')).toBe('book/Untitled Folio')
})

test('restoration reports added instruction files and excludes unchanged receipt entries', async () => {
  const { writeRestoredFolioInstructions, restoredFolioMessage } = await import('../../src/main/folio-conversion')
  const { ws } = await fixture({ '_book_INDEX.md': running })
  await turnBackIntoCollection(ws, 'book')
  const paths = await restoreTurnedBackFolio(ws, 'book')
  expect(paths).not.toContain('book/_report-structure.json')
  expect(paths).not.toContain('book/AGENTS.md')
  const added = await writeRestoredFolioInstructions(ws, 'book')
  expect(added).toEqual(['book/AGENTS.md', 'book/CLAUDE.md', 'book/.folio-instructions.json'])
  expect(restoredFolioMessage(added)).toContain('Added missing files: book/AGENTS.md')
  expect(restoredFolioMessage(added)).not.toContain('exactly')
  expect(restoredFolioMessage([])).toContain('exactly')
})


test('strict Undo refuses a new descendant Folio and keeps both folders unchanged', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest, '_book_INDEX.md': running })
  await turnBackIntoCollection(ws, 'book')
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_ch_INDEX.md'), running)
  const parked = await readFile(join(root, 'book/.folio-turn-back.json'), 'utf8')
  await expect(restoreTurnedBackFolio(ws, 'book')).rejects.toThrow('book/ch')
  expect(await readFile(join(root, 'book/.folio-turn-back.json'), 'utf8')).toBe(parked)
  expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
})

test('accepting a previously prepared proposal rechecks descendants before declaring an existing Index Note', async () => {
  const { runPlanOperations } = await import('../../src/main/plan-proposal')
  const { root, ws } = await fixture({ '_book_INDEX.md': '# Book\n' })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  await expect(runPlanOperations(ws, 'book', [{ op: 'insertPart', title: 'Part' }])).rejects.toThrow('book/ch')
  expect(await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')).toBe('# Book\n')
})

test('a prepared manifest creation refuses a related Folio before its write', async () => {
  const { writePreparedManifest } = await import('../../src/main/plan')
  const { root, ws } = await fixture({})
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  await expect(writePreparedManifest(ws, { path: 'book/_report-structure.json', current: null, next: manifest })).rejects.toThrow('book/ch')
  expect(await readdir(join(root, 'book'))).toEqual(['ch'])
})

test('Add Undo also checks the shared one-Folio guard before restoring documents', async () => {
  const { readFolioDocuments, recordAdd, undoRecordedAdd, forgetAddUndoRecords } = await import('../../src/main/folio-add-undo')
  const { insertPart } = await import('../../src/main/plan')
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  const before = readFolioDocuments(ws, 'book')
  await insertPart(ws, 'book', 0, { title: 'Extra' })
  const after = readFolioDocuments(ws, 'book')
  const token = recordAdd(ws, 'book', before, after)!
  await writeFile(join(root, '_report-structure.json'), manifest)
  try {
    const result = await undoRecordedAdd(ws, 'book', token)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('workspace root')
    expect(readFolioDocuments(ws, 'book')).toEqual(after)
  } finally { forgetAddUndoRecords() }
})

for (const name of ['archive', 'archives', 'archived', 'Archive']) test(`N1: a Folio inside ${name} blocks its ancestor`, async () => {
  const { assertNoRelatedFolio } = await import('../../src/main/folio-declaration')
  const { root, ws } = await fixture({})
  await mkdir(join(root, `book/${name}/old`), { recursive: true })
  await writeFile(join(root, `book/${name}/old/_report-structure.json`), manifest)
  await expect(assertNoRelatedFolio(ws, 'book')).rejects.toThrow(`book/${name}/old`)
  await expect(ws.saveFile('book/_report-structure.json', manifest)).rejects.toThrow('already occupies')
})

for (const mode of ['create', 'save', 'rename', 'guarded-create', 'guarded-save', 'guarded-rename', 'cli'] as const) test(`the declaration seam refuses ${mode}`, async () => {
  const { writeWhole } = await import('../../src/main/cli/guarded-fs')
  const { root, ws } = await fixture({ '_report-structure.json': manifest })
  await mkdir(join(root, 'book/ch'))
  const target = 'book/ch/_ch_INDEX.md'
  const options = { documentOnly: mode.startsWith('guarded') }
  if (mode.includes('save') || mode === 'cli') await writeFile(join(root, target), '# Cover\n')
  if (mode.includes('rename')) await writeFile(join(root, 'book/ch/draft.md'), running)
  const act = () => mode.includes('create') ? ws.createFile(target, running, options)
    : mode.includes('rename') ? ws.renameFile('book/ch/draft.md', target, options)
    : mode === 'cli' ? writeWhole(ws, target, running, 'replace')
    : ws.saveFile(target, running, options)
  await expect(act()).rejects.toThrow('already occupies')
  expect(folioDeclaration(ws, 'book/ch').isFolio).toBe(false)
})

test('N2 and prose.insert cannot declare a second Folio', async () => {
  const { buildVerbTable } = await import('../../src/main/verbs')
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  const verbs = buildVerbTable(ws)
  const create = verbs.find(v => v.id === 'housekeeping.create_file')!
  const input = { path: 'book/ch/_ch_INDEX.md', content: running }
  try { const result = await create.run({} as never, input); expect(result.text).toContain('already occupies') }
  catch (error) { expect(String(error)).toContain('already occupies') }
  await writeFile(join(root, input.path), '# Cover\n')
  const insert = verbs.find(v => v.id === 'prose.insert')!
  try { const result = await insert.run({} as never, { path: input.path, text: '\n## Running order\n', insertAfter: '', category: 'structure', summary: 'Declare' }); expect(result.text).toContain('already occupies') }
  catch (error) { expect(String(error)).toContain('already occupies') }
  expect(await readFile(join(root, input.path), 'utf8')).toBe('# Cover\n')
})

test('editor saves typed running order, ignores its declaration and shows the notice', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  const path = 'book/ch/_ch_INDEX.md'
  await writeFile(join(root, path), '# Cover\n')
  const notices: string[] = []
  ws.onWriteNotice = message => notices.push(message)
  await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
  expect(await readFile(join(root, path), 'utf8')).toBe(running)
  expect(folioDeclaration(ws, 'book/ch').isFolio).toBe(false)
  expect(await folioDirOwning(ws, 'book/ch')).toBe('book')
  expect(notices).toEqual(["This note's running order is set aside: book is already the Folio here. Turn that Folio back first, then use Make Folio here to use this one."])
})

test('skipped-folder notices reach agent, CLI and plan results', async () => {
  const { buildVerbTable } = await import('../../src/main/verbs')
  const { writeWhole } = await import('../../src/main/cli/guarded-fs')
  const { withPlanLock } = await import('../../src/main/plan-lock')
  const { assertNoRelatedFolio } = await import('../../src/main/folio-declaration')
  for (const route of ['agent', 'cli', 'plan']) {
    const { root, ws } = await fixture({ '_book_INDEX.md': '# Book\n' })
    const locked = join(root, 'book/locked/_locked_INDEX.md')
    await mkdir(join(root, 'book/locked'))
    await writeFile(locked, running)
    await chmod(locked, 0)
    try {
      if (route === 'agent') {
        const verb = buildVerbTable(ws).find(v => v.id === 'folio.create_manifest')!
        const result = await verb.run({} as never, { dir: 'book' })
        expect(result.text).toContain('Skipped book/locked')
      } else if (route === 'cli') {
        const result = await writeWhole(ws, 'book/_book_INDEX.md', running, 'replace')
        expect(result.notices?.join(' ')).toContain('Skipped book/locked')
      } else {
        const result = await withPlanLock(ws, 'book', async () => {
          await assertNoRelatedFolio(ws, 'book')
          return { notices: [] as string[] }
        })
        expect(result.notices?.join(' ')).toContain('Skipped book/locked')
      }
    } finally { await chmod(locked, 0o600) }
  }
})

test('rename_file into the Index Note name is refused before the source moves', async () => {
  const { buildVerbTable } = await import('../../src/main/verbs')
  const { root, ws } = await fixture({ '_report-structure.json': manifest })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/draft.md'), running)
  const verb = buildVerbTable(ws).find(v => v.id === 'housekeeping.rename_file')!
  const input = { path: 'book/ch/draft.md', newPath: '_ch_INDEX.md' }
  const paths = await (verb.touchedPaths as Function)(input)
  const result = await verb.run({ resolvedTouchedPaths: paths } as never, input)
  expect(result.text).toContain('already occupies')
  expect(await readFile(join(root, input.path), 'utf8')).toBe(running)
  expect((await readdir(join(root, 'book/ch')))).toEqual(['draft.md'])
})

test('two competing declaration writes share the collection turn', async () => {
  const { writeWhole } = await import('../../src/main/cli/guarded-fs')
  const { root, ws } = await fixture({})
  await mkdir(join(root, 'book/ch'))
  const results = await Promise.allSettled([
    ws.saveFile('book/_report-structure.json', manifest),
    writeWhole(ws, 'book/ch/_ch_INDEX.md', running, 'create'),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  expect(String(rejected.reason)).toContain('already occupies')
})

for (const direction of ['above', 'inside']) {
  test(`X1: manifest Folio wins editor declaration ${direction} with a history record`, async () => {
    const { root, ws } = await fixture({})
    await mkdir(join(root, 'book/ch'))
    const existing = direction === 'above' ? 'book/ch' : 'book'
    const candidate = direction === 'above' ? 'book' : 'book/ch'
    await writeFile(join(root, existing, '_report-structure.json'), manifest)
    const path = `${candidate}/_${candidate.split('/').at(-1)}_INDEX.md`
    await writeFile(join(root, path), '# Cover\n')
    const notices: string[] = []
    ws.onWriteNotice = message => notices.push(message)
    const writes: import('../../src/main/workspace').OperationWrite[] = []
    await ws.recordingOperationWrites(writes, () => ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' }))
    expect(await readFile(join(root, path), 'utf8')).toBe(running)
    expect(folioDeclaration(ws, existing).isFolio).toBe(true)
    expect(folioDeclaration(new Workspace(root), candidate).isFolio).toBe(false)
    expect(writes.some(write => write.path === '.writeflex/folio-declarations-set-aside.json')).toBe(true)
    expect(notices).toEqual([`This note's running order is set aside: ${existing} is already the Folio here. Turn that Folio back first, then use Make Folio here to use this one.`])
    await turnBackIntoCollection(ws, existing)
    expect(folioDeclaration(ws, candidate).isFolio).toBe(false)
    expect((await makeFolio(ws, candidate)).isError).not.toBe(true)
    expect(folioDeclaration(ws, candidate).isFolio).toBe(true)
  })
}
for (const name of ['_BOOK_index.md', '_BoOk_INDEX.md']) {
  test(`case variant ${name} cannot declare above an existing Folio`, async () => {
    const { root, ws } = await fixture({})
    await mkdir(join(root, 'book/ch'))
    await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
    await expect(ws.createFile(`book/${name}`, running)).rejects.toThrow('already occupies')
  })
}
for (const documentOnly of [false, true]) {
  test(`folder rename checks the destination Index Note name, guarded=${documentOnly}`, async () => {
    const { root, ws } = await fixture({ '_report-structure.json': manifest })
    await mkdir(join(root, 'book/tmp'))
    await writeFile(join(root, 'book/tmp/_ch_INDEX.md'), running)
    await expect(ws.renameFolder('book/tmp', 'ch', { documentOnly })).rejects.toThrow('already occupies')
    expect(await readFile(join(root, 'book/tmp/_ch_INDEX.md'), 'utf8')).toBe(running)
  })
}
for (const declaration of ['_report-structure.json', '_x_INDEX.md']) {
  test(`folder move refuses overlapping ${declaration}`, async () => {
    const { root, ws } = await fixture({ '_report-structure.json': manifest })
    await mkdir(join(root, 'x'))
    await writeFile(join(root, 'x', declaration), declaration.endsWith('.json') ? manifest : running)
    const { moveDocumentGuarded } = await import('../../src/main/guarded-document-move')
    await expect(moveDocumentGuarded(ws, 'x', 'book/x', 'folder')).rejects.toThrow('already occupies')
    expect(await readFile(join(root, 'x', declaration), 'utf8')).toBe(declaration.endsWith('.json') ? manifest : running)
  })
}
test('unreadable ancestor never refuses editor text and names the folder', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  const path = 'book/ch/_ch_INDEX.md'
  await writeFile(join(root, path), '# Cover\n')
  const notices: string[] = []
  ws.onWriteNotice = message => notices.push(message)
  await chmod(join(root, 'book/_book_INDEX.md'), 0)
  try {
    await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
    expect(await readFile(join(root, path), 'utf8')).toBe(running)
    expect(notices.join(' ')).toContain('Skipped book while checking')
  } finally { await chmod(join(root, 'book/_book_INDEX.md'), 0o600) }
})

test('NFC and NFD declaring names share the guard', async () => {
  const { root, ws } = await fixture({})
  await mkdir(join(root, 'caf\u00e9/ch'), { recursive: true })
  await writeFile(join(root, 'caf\u00e9/ch/_report-structure.json'), manifest)
  await expect(ws.createFile('caf\u00e9/_CAFE\u0301_index.md', running)).rejects.toThrow('already occupies')
})
for (const route of ['agent', 'cli']) {
  test(`${route} case-variant declaration cannot take over an existing Folio`, async () => {
    const { root, ws } = await fixture({})
    await mkdir(join(root, 'book/ch'))
    await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
    if (route === 'cli') {
      const { writeWhole } = await import('../../src/main/cli/guarded-fs')
      await expect(writeWhole(ws, 'book/_BOOK_index.md', running, 'create')).rejects.toThrow('already occupies')
    } else {
      const { buildVerbTable } = await import('../../src/main/verbs')
      const verb = buildVerbTable(ws).find(v => v.id === 'housekeeping.create_file')!
      const input = { path: 'book/_BOOK_index.md', content: running, category: 'structure', summary: 'Declare' }
      try { expect((await verb.run({} as never, input)).text).toContain('already occupies') }
      catch (error) { expect(String(error)).toContain('already occupies') }
    }
    expect(folioDeclaration(ws, 'book/ch').isFolio).toBe(true)
    expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
  })
}
test('set-aside state clears only after a successful non-declaring write', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  const path = 'book/ch/_ch_INDEX.md'
  await writeFile(join(root, path), '# Cover\n')
  await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
  const before = await readFile(join(root, '.writeflex/folio-declarations-set-aside.json'), 'utf8')
  await expect(ws.saveEditorText(path, '# Cover\n', { kind: 'disk', text: running }, { beforeCommit: () => { throw new Error('Refused commit') } })).rejects.toThrow('Refused commit')
  expect(await readFile(join(root, '.writeflex/folio-declarations-set-aside.json'), 'utf8')).toBe(before)
  expect(folioDeclaration(ws, 'book/ch').isFolio).toBe(false)
  await ws.saveFile(path, '# Cover\n', { documentOnly: true })
  expect(JSON.parse(await readFile(join(root, '.writeflex/folio-declarations-set-aside.json'), 'utf8'))).toEqual([])
})
test('outside-file ownership and vault works share the set-aside answer', async () => {
  const { root, ws } = await fixture({})
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_ch_INDEX.md'), running)
  const path = 'book/_book_INDEX.md'
  await writeFile(join(root, path), '# Cover\n')
  await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
  const { documentFolio } = await import('../../src/main/standard-widgets/outside-files')
  expect(await documentFolio(root, 'book/ch/01.md')).toEqual({ ok: true, folder: 'book/ch' })
  const { detectVaultWorks, DEFAULT_VAULT_WORK_SETTINGS, markdownFactsFrom } = await import('../../src/main/vault-works')
  const texts = new Map([[path, running], ['book/ch/_ch_INDEX.md', running]])
  const result = detectVaultWorks({ rootName: 'vault', files: [...texts.keys()], folders: ['book', 'book/ch'], manifests: [] }, DEFAULT_VAULT_WORK_SETTINGS, {
    declaration: dir => folioDeclaration(ws, dir),
    markdown: name => markdownFactsFrom(texts.get(name) ?? '', name, 'Book'), manifest: () => null,
  })
  expect(result.works.some(work => work.kind === 'folio' && work.path === 'book/ch')).toBe(true)
})

test('moving a set-aside folder retains its set-aside declaration', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  await mkdir(join(root, 'elsewhere'))
  const path = 'book/ch/_ch_INDEX.md'
  await writeFile(join(root, path), '# Cover\n')
  await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
  const { moveDocumentGuarded } = await import('../../src/main/guarded-document-move')
  await moveDocumentGuarded(ws, 'book/ch', 'elsewhere/ch', 'folder')
  expect(await readFile(join(root, 'elsewhere/ch/_ch_INDEX.md'), 'utf8')).toBe(running)
  expect(folioDeclaration(new Workspace(root), 'elsewhere/ch').isFolio).toBe(false)
})

for (const route of ['cli', 'workspace']) {
  test(`r6 set-aside parent refuses a manifest from ${route}; existing Folio stays`, async () => {
    const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
    await mkdir(join(root, 'book/ch'))
    await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
    await ws.saveEditorText('book/_book_INDEX.md', running, { kind: 'disk', text: '# Cover\n' })
    const write = route === 'cli'
      ? (await import('../../src/main/cli/guarded-fs')).writeWhole(ws, 'book/_report-structure.json', manifest, 'create')
      : ws.saveFile('book/_report-structure.json', manifest)
    await expect(write).rejects.toThrow('book/ch already occupies')
    await ws.saveEditorText('book/_book_INDEX.md', '# Cover\n', { kind: 'disk', text: running })
    expect(folioDeclaration(new Workspace(root), 'book/ch').isFolio).toBe(true)
  })
}
test('r6 malformed store leaves editor saves and readers available and preserves corrupt bytes', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
  await mkdir(join(root, '.writeflex'))
  const corrupt = '<<<<<<< sync conflict\n'
  await writeFile(join(root, '.writeflex/folio-declarations-set-aside.json'), corrupt)
  const notices: string[] = []
  ws.onWriteNotice = message => notices.push(message)
  await ws.saveEditorText('book/_book_INDEX.md', running, { kind: 'disk', text: '# Cover\n' })
  expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
  expect(await readFile(join(root, '.writeflex/folio-declarations-set-aside.json'), 'utf8')).toBe(corrupt)
  expect(notices.join(' ')).toContain('could not be read')
})
test('r6 refused editor commit does not create a set-aside entry', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest })
  await mkdir(join(root, 'book/ch'))
  const path = 'book/ch/_ch_INDEX.md'
  await writeFile(join(root, path), '# Cover\n')
  await expect(ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' }, { beforeCommit: () => { throw new Error('Commit refused') } })).rejects.toThrow('Commit refused')
  expect(await readFile(join(root, path), 'utf8')).toBe('# Cover\n')
  expect(await readFile(join(root, '.writeflex/folio-declarations-set-aside.json'), 'utf8').catch(() => null)).toBeNull()
})
test('r6 legacy nested Folio may move inside its existing outer Folio because it creates no new overlap', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  await ws.renameFolder('book/ch', 'chapter')
  expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
  expect(await readFile(join(root, 'book/chapter/_report-structure.json'), 'utf8')).toBe(manifest)
})

for (const documentOnly of [false, true]) {
  test(`r6 entries follow note and folder moves and remain after trash and Put Back; guarded=${documentOnly}`, async () => {
    const { root, ws } = await fixture({ '_book_INDEX.md': running })
    await mkdir(join(root, 'book/ch'))
    const file = 'book/ch/_ch_INDEX.md'
    await writeFile(join(root, file), '# Cover\n')
    await ws.saveEditorText(file, running, { kind: 'disk', text: '# Cover\n' })
    const store = join(root, '.writeflex/folio-declarations-set-aside.json')
    await ws.renameFolder('book/ch', 'novel', { documentOnly })
    expect(JSON.parse(await readFile(store, 'utf8')).map((e: {file: string}) => e.file)).toEqual(['book/novel/_ch_index.md'])
    await ws.renameFile('book/novel/_ch_INDEX.md', '_novel_INDEX.md', { documentOnly })
    expect(folioDeclaration(new Workspace(root), 'book/novel').isFolio).toBe(false)
    expect(JSON.parse(await readFile(store, 'utf8')).map((e: {file: string}) => e.file)).toEqual(['book/novel/_novel_index.md'])
    await ws.moveToTrash('book/novel/_novel_INDEX.md', absolute => rm(absolute))
    expect(JSON.parse(await readFile(store, 'utf8')).map((e: {file: string}) => e.file)).toEqual(['book/novel/_novel_index.md'])
    await writeFile(join(root, 'book/novel/_novel_INDEX.md'), running)
    expect(folioDeclaration(new Workspace(root), 'book').isFolio).toBe(true)
    expect(folioDeclaration(new Workspace(root), 'book/novel').isFolio).toBe(false)
  })
}
test('r8 externally replaced declaring file retains its path history until Make', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  const path = 'book/_book_INDEX.md'
  await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
  await rm(join(root, 'book/ch/_report-structure.json'))
  await rm(join(root, path))
  await writeFile(join(root, path), running + '\nExternal replacement\n')
  expect(folioDeclaration(new Workspace(root), 'book').isFolio).toBe(false)
})
test('r6 CLI edits of a set-aside note retain its decision after the committed bytes change', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  const path = 'book/_book_INDEX.md'
  await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
  const { writeWhole } = await import('../../src/main/cli/guarded-fs')
  await writeWhole(ws, path, running + '\nStill the writer’s note\n', 'replace')
  expect(folioDeclaration(new Workspace(root), 'book').isFolio).toBe(false)
  expect(folioDeclaration(new Workspace(root), 'book/ch').isFolio).toBe(true)
})
test('r6 moving into a set-aside tree names the Folio readers actually use', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
  await mkdir(join(root, 'book/ch'))
  await mkdir(join(root, 'x'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  await ws.saveEditorText('book/_book_INDEX.md', running, { kind: 'disk', text: '# Cover\n' })
  await writeFile(join(root, 'x/_report-structure.json'), manifest)
  const { moveDocumentGuarded } = await import('../../src/main/guarded-document-move')
  await expect(moveDocumentGuarded(ws, 'x', 'book/ch/x', 'folder')).rejects.toThrow('book/ch already occupies')
})

for (const trigger of ['cli edit', 'editor edit', 'note rename', 'trash', 'Make']) {
  test(`r8 legacy recorded manifest: ${trigger} names the established Folio or weakens text`, async () => {
    const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
    await mkdir(join(root, 'book/ch'))
    await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
    const path = 'book/_book_INDEX.md'
    await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
    // An outside manifest joins the recorded outer note; the established child still wins.
    await writeFile(join(root, 'book/_report-structure.json'), manifest)
    const { writeWhole } = await import('../../src/main/cli/guarded-fs')
    const { activateFolioDeclaration } = await import('../../src/main/folio-declaration')
    const operation = trigger === 'cli edit' ? writeWhole(ws, path, '# Cover\n', 'replace')
      : trigger === 'editor edit' ? ws.saveEditorText(path, '# Cover\n', { kind: 'disk', text: running })
      : trigger === 'note rename' ? ws.renameFile(path, 'cover.md', { documentOnly: true })
      : trigger === 'trash' ? ws.moveToTrash(path, absolute => rm(absolute))
      : activateFolioDeclaration(ws, 'book')
    if (trigger === 'editor edit') {
      await operation
      expect((await readFile(join(root, path), 'utf8')).replaceAll('\r\n', '\n')).toBe('# Cover\n')
    } else {
      await expect(operation).rejects.toThrow('book/ch already occupies')
      expect(await readFile(join(root, path), 'utf8')).toBe(running)
      expect(folioDeclaration(ws, 'book/ch').isFolio).toBe(true)
      expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
    }
  })
}
test('r6 failed CLI Make does not clear the set-aside note before its manifest commit', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_ch_INDEX.md'), '# Cover\n')
  const path = 'book/ch/_ch_INDEX.md'
  await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
  await turnBackIntoCollection(ws, 'book')
  const { CREATE_OPERATIONS } = await import('../../src/main/cli/create-operations')
  const make = CREATE_OPERATIONS.find(operation => operation.name === 'create-manifest')!
  await expect(make.run({ workspace: ws, write: { session: { create: async () => { throw new Error('Manifest commit refused') } } } } as never, { folder: 'book/ch' })).rejects.toThrow('Manifest commit refused')
  expect(folioDeclaration(new Workspace(root), 'book/ch').isFolio).toBe(false)
})
test('r6 moving a legacy nested Folio deeper inside the same outer Folio creates no new overlap', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest })
  await mkdir(join(root, 'book/ch'))
  await mkdir(join(root, 'book/parts'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  const { moveDocumentGuarded } = await import('../../src/main/guarded-document-move')
  await moveDocumentGuarded(ws, 'book/ch', 'book/parts/ch', 'folder')
  expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
  expect(await readFile(join(root, 'book/parts/ch/_report-structure.json'), 'utf8')).toBe(manifest)
})

test('r6 folder rename cannot release an externally armed manifest when its set-aside note loses the Index Note name', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  await ws.saveEditorText('book/_book_INDEX.md', running, { kind: 'disk', text: '# Cover\n' })
  await writeFile(join(root, 'book/_report-structure.json'), manifest)
  await expect(ws.renameFolder('book', 'novel')).rejects.toThrow('book/ch already occupies')
  expect(folioDeclaration(ws, 'book/ch').isFolio).toBe(true)
  expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
})

for (const corrupt of ['{}', '[null]', '[{"folder":7,"file":"book/_book_INDEX.md"}]']) {
  test(`r6 malformed store shape ${corrupt} cannot refuse an editor save or a reader`, async () => {
    const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
    await mkdir(join(root, '.writeflex'))
    await writeFile(join(root, '.writeflex/folio-declarations-set-aside.json'), corrupt)
    await ws.saveEditorText('book/_book_INDEX.md', running, { kind: 'disk', text: '# Cover\n' })
    expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
    expect(await readFile(join(root, '.writeflex/folio-declarations-set-aside.json'), 'utf8')).toBe(corrupt)
  })
}
test('r6 exported writers cannot acquire editor authority with an editor boolean', async () => {
  const { root, ws } = await fixture({ '_report-structure.json': manifest })
  await mkdir(join(root, 'book/ch'))
  const { guardFolioWrite } = await import('../../src/main/folio-declaration')
  await expect(guardFolioWrite(ws, 'book/ch/_ch_INDEX.md', running, { editor: true } as never)).rejects.toThrow('book already occupies')
})

test('r6 a carried set-aside note cannot bypass the guard by taking a manifest name', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  const path = 'book/_book_INDEX.md'
  await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
  const { moveDocumentGuarded } = await import('../../src/main/guarded-document-move')
  await expect(moveDocumentGuarded(ws, path, 'book/_report-structure.json', 'file')).rejects.toThrow('book/ch already occupies')
  expect(folioDeclaration(ws, 'book/ch').isFolio).toBe(true)
})

// r7 precedence: kind × relative position × record availability.
for (const outer of ['manifest', 'index'] as const) for (const inner of ['manifest', 'index'] as const) {
  for (const record of ['absent', 'outer', 'inner', 'corrupt'] as const) {
    test(`r7 precedence outer=${outer} inner=${inner} record=${record}`, async () => {
      const { root, ws } = await fixture({})
      await mkdir(join(root, 'book/ch'))
      await writeFile(join(root, 'book', outer === 'manifest' ? '_report-structure.json' : '_book_INDEX.md'), outer === 'manifest' ? manifest : running)
      await writeFile(join(root, 'book/ch', inner === 'manifest' ? '_report-structure.json' : '_ch_INDEX.md'), inner === 'manifest' ? manifest : running)
      if (outer === 'manifest') await writeFile(join(root, 'book/_book_INDEX.md'), running)
      if (inner === 'manifest') await writeFile(join(root, 'book/ch/_ch_INDEX.md'), running)
      if (record !== 'absent') {
        await mkdir(join(root, '.writeflex'))
        const folder = record === 'inner' ? 'book/ch' : 'book'
        await writeFile(join(root, '.writeflex/folio-declarations-set-aside.json'), record === 'corrupt' ? '<<<<<<< conflict' : JSON.stringify([{ folder, file: folder + (record === 'inner' ? '/_ch_INDEX.md' : '/_book_INDEX.md') }]))
      }
      const winner = outer !== inner ? (outer === 'manifest' ? 'book' : 'book/ch')
        : record === 'outer' ? 'book/ch' : record === 'inner' ? 'book'
        : outer === 'index' && record === 'absent' ? 'book/ch' : 'book'
      for (const folder of ['book', 'book/ch']) expect(folioDeclaration(ws, folder).isFolio).toBe(folder === winner)
    })
  }
}
for (const probe of ['Q1', 'Q1b', 'Q2', 'Q3', 'Q6']) test(`r7 ${probe}: manifest inner survives loss of the redundant outer decision`, async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  if (probe === 'Q6') ws.writeAppStoreFile = async () => { throw new Error('Disk full') }
  const path = 'book/_book_INDEX.md'
  await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
  if (probe === 'Q1') await writeFile(join(root, path), running + '\nOutside edit\n')
  if (probe === 'Q1b') await writeFile(join(root, path), running.replaceAll('\r\n', '\n'))
  if (probe === 'Q2') { await ws.moveToTrash(path, absolute => rm(absolute)); await writeFile(join(root, path), running) }
  if (probe === 'Q3') { await mkdir(join(root, '.writeflex'), { recursive: true }); await writeFile(join(root, '.writeflex/folio-declarations-set-aside.json'), '<<<<<<< conflict') }
  expect(folioDeclaration(new Workspace(root), 'book').isFolio).toBe(false)
  expect(folioDeclaration(new Workspace(root), 'book/ch').isFolio).toBe(true)
})

for (const retry of ['save', 'unchanged save', 'claim'] as const) test(`r7 failed child record saves bytes, warns truthfully and retries on ${retry}`, async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  const path = 'book/ch/_ch_INDEX.md'
  await writeFile(join(root, path), '# Cover\n')
  const notices: string[] = []
  ws.onWriteNotice = message => notices.push(message)
  const writer = ws.writeAppStoreFile.bind(ws)
  let attempts = 0
  ws.writeAppStoreFile = async () => { attempts++; throw new Error('Disk full') }
  await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
  expect(attempts).toBe(2)
  expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
  expect(folioDeclaration(ws, 'book/ch').isFolio).toBe(false)
  expect(await readFile(join(root, path), 'utf8')).toBe(running)
  expect(notices.join(' ')).toContain('The running order in book/ch could not be set aside. book may stop being the Folio after reopening.')
  expect(notices.join(' ')).toContain('remove the running-order heading in book/ch, or Turn back one of the Folios')
  expect(notices.join(' ')).not.toContain("This note's running order is set aside")
  ws.writeAppStoreFile = writer
  if (retry === 'save') await ws.saveEditorText(path, running + '\nEdit\n', { kind: 'disk', text: running })
  else if (retry === 'unchanged save') {
    notices.length = 0
    await ws.saveEditorText(path, running, { kind: 'disk', text: running })
    expect(notices.join(' ')).toContain('book is already the Folio here')
  } else {
    const { CollectionOwnership } = await import('../../src/main/collection-ownership')
    const owner = new CollectionOwnership({ schedule: () => () => {} })
    try { expect(await owner.claim(root)).toBe('owned') } finally { await owner.release(root) }
  }
  expect(JSON.parse(await readFile(join(root, '.writeflex/folio-declarations-set-aside.json'), 'utf8'))).toEqual([{ folder: 'book/ch', file: 'book/ch/_ch_index.md' }])
  expect(folioDeclaration(new Workspace(root), 'book').isFolio).toBe(true)
  expect(folioDeclaration(new Workspace(root), 'book/ch').isFolio).toBe(false)
})

for (const change of ['outside edit', 'line endings', 'trash put back', 'corrupt store'] as const) test(`r7 child Index-Note-only record survives ${change}`, async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  const path = 'book/ch/_ch_INDEX.md'
  await writeFile(join(root, path), '# Cover\n')
  await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
  const store = join(root, '.writeflex/folio-declarations-set-aside.json')
  expect(JSON.parse(await readFile(store, 'utf8'))).toEqual([{ folder: 'book/ch', file: 'book/ch/_ch_index.md' }])
  if (change === 'outside edit') await writeFile(join(root, path), running + '\nOutside edit\n')
  if (change === 'line endings') await writeFile(join(root, path), running.replaceAll('\r\n', '\n'))
  if (change === 'trash put back') { await ws.moveToTrash(path, absolute => rm(absolute)); await writeFile(join(root, path), running) }
  if (change === 'corrupt store') await writeFile(store, '<<<<<<< conflict')
  expect(folioDeclaration(new Workspace(root), 'book').isFolio).toBe(true)
  expect(folioDeclaration(new Workspace(root), 'book/ch').isFolio).toBe(false)
})
for (const route of ['cli', 'workspace'] as const) for (const later of ['editor removal', 'agent rename'] as const) {
  test(`r7 T1/T1b/T2: ${route} cannot write a second manifest before ${later}`, async () => {
    const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
    await mkdir(join(root, 'book/ch'))
    await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
    const path = 'book/_book_INDEX.md'
    await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
    const { writeWhole } = await import('../../src/main/cli/guarded-fs')
    await expect(route === 'cli' ? writeWhole(ws, 'book/_report-structure.json', manifest, 'create') : ws.saveFile('book/_report-structure.json', manifest)).rejects.toThrow('book/ch already occupies')
    if (later === 'editor removal') await ws.saveEditorText(path, '# Cover\n', { kind: 'disk', text: running })
    else await ws.renameFile(path, 'cover.md', { documentOnly: true })
    expect(folioDeclaration(new Workspace(root), 'book/ch').isFolio).toBe(true)
    expect(await readFile(join(root, 'book/_report-structure.json'), 'utf8').catch(() => null)).toBeNull()
  })
}
test('r7 legacy outside-created two-manifest overlap uses the outer Folio immediately', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  await writeFile(join(root, 'book/_book_INDEX.md'), running)
  await writeFile(join(root, 'book/_report-structure.json'), manifest)
  expect(folioDeclaration(new Workspace(root), 'book').isFolio).toBe(true)
  expect(folioDeclaration(new Workspace(root), 'book/ch').isFolio).toBe(false)
})
for (const route of ['widget', 'rollback'] as const) test(`r8 unrecorded overlap removal succeeds through ${route}`, async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  await writeFile(join(root, 'book/_report-structure.json'), manifest)
  const path = 'book/_book_INDEX.md'
  if (route === 'widget') {
    const { checkedFolder, removeOriginalGuarded } = await import('../../src/main/standard-widgets/own-folder')
    removeOriginalGuarded(ws, root, { from: path, to: 'book/cover.md', fromFolder: checkedFolder(root, 'book'), read: running })
  } else {
    const { rollBackOperationWrites } = await import('../../src/main/operation-rollback')
    const result = await rollBackOperationWrites(ws, [{ path, before: null, after: running }])
    expect(result.restored).toEqual([path])
    expect(result.failed).toEqual([])
  }
  expect(await readFile(join(root, path), 'utf8').catch(() => null)).toBeNull()
  expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
})
test('r7 editor repeat saves of a losing note still name the Folio in use', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  const notices: string[] = []
  ws.onWriteNotice = message => notices.push(message)
  await ws.saveEditorText('book/_book_INDEX.md', running, { kind: 'disk', text: '# Cover\n' })
  notices.length = 0
  await ws.saveEditorText('book/_book_INDEX.md', running + '\nMore\n', { kind: 'disk', text: running })
  expect(notices.join(' ')).toContain('book/ch is already the Folio here')
})

test('r7 a guarded writer does not mutate frozen caller options', async () => {
  const { ws } = await fixture({})
  const { writeDocumentGuarded } = await import('../../src/main/guarded-document-write')
  const options = Object.freeze({})
  await writeDocumentGuarded(ws, 'book/ordinary.md', '# Ordinary\n', 'create', options)
  expect(Object.keys(options)).toEqual([])
})


for (const outerManifest of [false, true]) for (const innerManifest of [false, true]) {
  for (const record of ['absent', 'outer', 'inner', 'corrupt']) {
    test(`r8 editor removes headings in precedence row ${outerManifest}/${innerManifest}/${record}`, async () => {
      const { root, ws } = await fixture({ '_book_INDEX.md': running })
      await mkdir(join(root, 'book/ch'))
      await writeFile(join(root, 'book/ch/_ch_INDEX.md'), running)
      if (outerManifest) await writeFile(join(root, 'book/_report-structure.json'), manifest)
      if (innerManifest) await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
      if (record !== 'absent') {
        await mkdir(join(root, '.writeflex'))
        const folder = record === 'inner' ? 'book/ch' : 'book'
        await writeFile(join(root, '.writeflex/folio-declarations-set-aside.json'), record === 'corrupt' ? '<<<<<<< conflict' : JSON.stringify([{ folder, file: folder + (folder === 'book' ? '/_book_INDEX.md' : '/_ch_INDEX.md') }]))
      }
      for (const path of ['book/_book_INDEX.md', 'book/ch/_ch_INDEX.md']) {
        await ws.saveEditorText(path, '# Cover\n', { kind: 'disk', text: running })
        expect((await readFile(join(root, path), 'utf8')).replaceAll('\r\n', '\n')).toBe('# Cover\n')
      }
    })
  }
}
for (const direction of ['inner', 'outer']) test(`r8 A/E records ${direction} newcomer, keeps last good history and requires Make after Turn back`, async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': direction === 'inner' ? running : '# Cover\n' })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_ch_INDEX.md'), direction === 'inner' ? '# Cover\n' : running)
  const newcomer = direction === 'inner' ? 'book/ch' : 'book'
  const established = direction === 'inner' ? 'book' : 'book/ch'
  const path = newcomer + (direction === 'inner' ? '/_ch_INDEX.md' : '/_book_INDEX.md')
  await ws.saveEditorText(path, running, { kind: 'disk', text: '# Cover\n' })
  const store = join(root, '.writeflex/folio-declarations-set-aside.json')
  expect(JSON.parse(await readFile(store, 'utf8'))).toEqual([{ folder: newcomer, file: path.toLowerCase() }])
  expect(folioDeclaration(ws, established).isFolio).toBe(true)
  await writeFile(store, '<<<<<<< conflict')
  expect(folioDeclaration(ws, established).isFolio).toBe(true)
  expect(folioDeclaration(ws, newcomer).isFolio).toBe(false)
  await writeFile(store, JSON.stringify([{ folder: newcomer, file: path.toLowerCase() }]))
  await turnBackIntoCollection(ws, established)
  expect(folioDeclaration(ws, newcomer).isFolio).toBe(false)
  const { activateFolioDeclaration } = await import('../../src/main/folio-declaration')
  await activateFolioDeclaration(ws, newcomer)
  expect(folioDeclaration(ws, newcomer).isFolio).toBe(true)
})
for (const action of ['save', 'turn back', 'rename', 'trash']) test(`r8 B/C/C2 ordinary manifest Folio allows ${action}`, async () => {
  const { root, ws } = await fixture({ '_report-structure.json': '{"schema_version":1,"files":[]}', '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_ch_INDEX.md'), '# Cover\n')
  await ws.saveEditorText('book/ch/_ch_INDEX.md', running, { kind: 'disk', text: '# Cover\n' })
  if (action === 'save') await ws.saveEditorText('book/_book_INDEX.md', '# Cover\n', { kind: 'disk', text: running })
  if (action === 'turn back') await turnBackIntoCollection(ws, 'book')
  if (action === 'rename') await ws.renameFolder('book', 'novel')
  if (action === 'trash') await ws.moveToTrash('book/_book_INDEX.md', absolute => rm(absolute))
  expect(folioDeclaration(ws, action === 'rename' ? 'novel' : 'book').isFolio).toBe(action !== 'turn back')
  expect(folioDeclaration(ws, action === 'rename' ? 'novel/ch' : 'book/ch').isFolio).toBe(false)
})
test('r8 D outside unrecorded child running order uses the accepted inner default', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_ch_INDEX.md'), running)
  expect(folioDeclaration(ws, 'book/ch').isFolio).toBe(true)
  expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
})
test('r8 Make reports a failed store clear', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_ch_INDEX.md'), '# Cover\n')
  await ws.saveEditorText('book/ch/_ch_INDEX.md', running, { kind: 'disk', text: '# Cover\n' })
  await turnBackIntoCollection(ws, 'book')
  ws.writeAppStoreFile = async () => { throw new Error('Disk full') }
  const { activateFolioDeclaration } = await import('../../src/main/folio-declaration')
  await expect(activateFolioDeclaration(ws, 'book/ch')).rejects.toThrow('could not')
  expect(folioDeclaration(ws, 'book/ch').isFolio).toBe(false)
})

test('r8 cold unreadable store names the affected pair and uses the precedence default', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_ch_INDEX.md'), running)
  await mkdir(join(root, '.writeflex'))
  await writeFile(join(root, '.writeflex/folio-declarations-set-aside.json'), '<<<<<<< conflict')
  const notices: string[] = []
  ws.onWriteNotice = message => notices.push(message)
  expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
  expect(folioDeclaration(ws, 'book/ch').isFolio).toBe(false)
  expect(notices.join(' ')).toContain('book and book/ch')
  expect(notices.join(' ')).toContain('no session history')
})

test('r8 watched Collection reuses its declaration map and invalidates it for outside and app writes', async () => {
  const { createWatchRouter } = await import('../../src/main/workspace-watcher')
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  for (let i = 0; i < 200; i++) await mkdir(join(root, 'book', `part-${i}`))
  const router = createWatchRouter(ws, () => {})
  try {
    expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
    const readDirs = spyOn(fs, 'readdirSync')
    try {
      for (let i = 0; i < 10; i++) expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
      expect(readDirs).not.toHaveBeenCalled()
    } finally { readDirs.mockRestore() }
    await writeFile(join(root, 'book/part-199/_part-199_INDEX.md'), running)
    router.take('book/part-199/_part-199_INDEX.md')
    expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
    await ws.saveFile('book/part-199/_part-199_INDEX.md', '# Cover\n')
    expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
  } finally { router.dispose() }
})

test('r8 Make clears a pending session record that never reached disk', async () => {
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_ch_INDEX.md'), '# Cover\n')
  const writeStore = ws.writeAppStoreFile.bind(ws)
  ws.writeAppStoreFile = async () => { throw new Error('Disk full') }
  await ws.saveEditorText('book/ch/_ch_INDEX.md', running, { kind: 'disk', text: '# Cover\n' })
  // The established note disappears while the set-aside retry remains pending.
  await rm(join(root, 'book/_book_INDEX.md'))
  ws.writeAppStoreFile = writeStore
  const { activateFolioDeclaration } = await import('../../src/main/folio-declaration')
  await activateFolioDeclaration(ws, 'book/ch')
  expect(folioDeclaration(ws, 'book/ch').isFolio).toBe(true)
})

test('r8 synchronous rollback removal invalidates a watched declaration before the watcher delivers', async () => {
  const { createWatchRouter } = await import('../../src/main/workspace-watcher')
  const { ws } = await fixture({ '_book_INDEX.md': running })
  const router = createWatchRouter(ws, () => {})
  try {
    expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
    ws.removeFileOverRead('book/_book_INDEX.md', running)
    expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
  } finally { router.dispose() }
})

test('r8 failed native watcher setup releases the declaration cache', async () => {
  const { createWorkspaceWatcher } = await import('../../src/main/workspace-watcher')
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  const nativeWatch = spyOn(fs, 'watch').mockImplementation(() => { throw new Error('No watch descriptors') })
  try { expect(() => createWorkspaceWatcher(ws, () => {})).toThrow('No watch descriptors') }
  finally { nativeWatch.mockRestore() }
  expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
  await writeFile(join(root, 'book/_book_INDEX.md'), '# Cover\n')
  expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
})


test('r9 W1 guards see outside declarations before any watcher event', async () => {
  const { createWatchRouter } = await import('../../src/main/workspace-watcher')
  const { writeWhole } = await import('../../src/main/cli/guarded-fs')
  const { root, ws } = await fixture({})
  await mkdir(join(root, 'book/ch'))
  const router = createWatchRouter(ws, () => {})
  try {
    expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
    await writeFile(join(root, 'book/_book_INDEX.md'), running)
    await expect(writeWhole(ws, 'book/ch/_ch_INDEX.md', running, 'create')).rejects.toThrow('book already occupies')
    expect(await readdir(join(root, 'book/ch'))).toEqual([])
  } finally { router.dispose() }
})

test('r10 failed watcher recreation logs and retains fingerprint reads', async () => {
  const { EventEmitter } = await import('node:events')
  const { createWorkspaceWatcher } = await import('../../src/main/workspace-watcher')
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  const emitter = Object.assign(new EventEmitter(), { close() {} })
  const nativeWatch = spyOn(fs, 'watch').mockReturnValueOnce(emitter as unknown as fs.FSWatcher)
    .mockImplementation(() => { throw new Error('No watch descriptors') })
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const watcher = createWorkspaceWatcher(ws, () => {})
  try {
    expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
    emitter.emit('error', new Error('lost FSEvents'))
    expect(nativeWatch).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.map(call => String(call[0])).join(' ')).toContain('could not be recreated')
    emitter.emit('error', new Error('duplicate error'))
    expect(nativeWatch).toHaveBeenCalledTimes(2)
    await writeFile(join(root, 'book/_book_INDEX.md'), '# Cover\n')
    expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
    await writeFile(join(root, 'book/_book_INDEX.md'), running)
    expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
  } finally { watcher.dispose(); nativeWatch.mockRestore(); warn.mockRestore() }
})

test('r9 changed-folder invalidation keeps unrelated cached folders and ignores journal appends', async () => {
  const { createWatchRouter } = await import('../../src/main/workspace-watcher')
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'other'))
  const router = createWatchRouter(ws, () => {})
  try {
    folioDeclaration(ws, 'book')
    folioDeclaration(ws, 'other')
    const reads = spyOn(fs, 'readdirSync')
    try {
      router.take('.writeflex/versions.jsonl')
      ws.recordOwnWrite('.writeflex/versions.jsonl')
      folioDeclaration(ws, 'book')
      expect(reads).not.toHaveBeenCalled()
      router.take('other/new.md')
      ws.recordOwnWrite('other/new.md')
      folioDeclaration(ws, 'book')
      expect(reads.mock.calls.map(call => String(call[0]))).not.toContain(join(root, 'book'))
    } finally { reads.mockRestore() }
  } finally { router.dispose() }
})


test('r10 Collection close retains failed retries and last-good history across reopen', async () => {
  const { clearFolioDeclarations } = await import('../../src/main/folio-declaration')
  const { CollectionOwnership } = await import('../../src/main/collection-ownership')
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_ch_INDEX.md'), '# Cover\n')
  const writeStore = ws.writeAppStoreFile.bind(ws)
  ws.writeAppStoreFile = async () => { throw new Error('Disk full') }
  await ws.saveEditorText('book/ch/_ch_INDEX.md', running, { kind: 'disk', text: '# Cover\n' })
  ws.writeAppStoreFile = writeStore
  clearFolioDeclarations(root)
  const owner = new CollectionOwnership({ schedule: () => () => {} })
  try {
    expect(await owner.claim(root)).toBe('owned')
    expect(JSON.parse(await readFile(join(root, '.writeflex/folio-declarations-set-aside.json'), 'utf8')))
      .toEqual([{ folder: 'book/ch', file: 'book/ch/_ch_index.md' }])
    const reopened = new Workspace(root)
    expect(folioDeclaration(reopened, 'book').isFolio).toBe(true)
    expect(folioDeclaration(reopened, 'book/ch').isFolio).toBe(false)
    await writeFile(join(root, '.writeflex/folio-declarations-set-aside.json'), 'broken')
    clearFolioDeclarations(root)
    expect(folioDeclaration(new Workspace(root), 'book').isFolio).toBe(true)
    expect(folioDeclaration(new Workspace(root), 'book/ch').isFolio).toBe(false)
  } finally { await owner.release(root) }
})

test('r10 clear leaves watched refcounts owned by their disposers', async () => {
  const { clearFolioDeclarations, watchFolioDeclarations } = await import('../../src/main/folio-declaration')
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  const releaseFirst = watchFolioDeclarations(root)
  const releaseSecond = watchFolioDeclarations(root)
  try {
    clearFolioDeclarations(root)
    releaseFirst()
    expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
    await writeFile(join(root, 'book/_book_INDEX.md'), '# Cover\n')
    expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
  } finally { releaseSecond() }
  expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
})

test('r10 own-write invalidation matches differently cased and normalised paths', async () => {
  const { createWatchRouter } = await import('../../src/main/workspace-watcher')
  const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
  const router = createWatchRouter(ws, () => {})
  try {
    expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
    await writeFile(join(root, 'book/_book_INDEX.md'), running)
    ws.recordOwnWrite('Book/_Book_INDEX.md')
    expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
  } finally { router.dispose() }
})



test('r9 removal guard uses fresh fingerprints before an outside manifest event', async () => {
  const { createWatchRouter } = await import('../../src/main/workspace-watcher')
  const { guardFolioRemoval } = await import('../../src/main/folio-declaration')
  const { root, ws } = await fixture({ '_book_INDEX.md': '# Cover\n' })
  await mkdir(join(root, 'book/ch'))
  await writeFile(join(root, 'book/ch/_report-structure.json'), manifest)
  await ws.saveEditorText('book/_book_INDEX.md', running, { kind: 'disk', text: '# Cover\n' })
  const router = createWatchRouter(ws, () => {})
  try {
    expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
    await writeFile(join(root, 'book/_report-structure.json'), manifest)
    expect(() => guardFolioRemoval(ws, 'book/_book_INDEX.md')).toThrow('book/ch already occupies')
  } finally { router.dispose() }
})


test('r10 watcher recreates once, delivers events, then falls back on another error', async () => {
  const { EventEmitter } = await import('node:events')
  const { createWorkspaceWatcher } = await import('../../src/main/workspace-watcher')
  const { root, ws } = await fixture({ '_book_INDEX.md': running })
  const firstClose = () => {}
  const secondClose = () => {}
  const first = Object.assign(new EventEmitter(), { close: firstClose })
  const second = Object.assign(new EventEmitter(), { close: secondClose })
  const closedFirst = spyOn(first, 'close')
  const closedSecond = spyOn(second, 'close')
  const nativeWatch = spyOn(fs, 'watch').mockReturnValueOnce(first as unknown as fs.FSWatcher)
    .mockReturnValueOnce(second as unknown as fs.FSWatcher)
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const changed: string[][] = []
  const watcher = createWorkspaceWatcher(ws, paths => changed.push(paths), 0)
  try {
    first.emit('error', new Error('lost watch'))
    expect(nativeWatch).toHaveBeenCalledTimes(2)
    expect(closedFirst).toHaveBeenCalledTimes(1)
    expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
    await writeFile(join(root, 'book/_book_INDEX.md'), '# Cover\n')
    const callback = nativeWatch.mock.calls[1][2] as Function
    callback('change', 'book/_book_INDEX.md')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(changed).toEqual([['book/_book_INDEX.md']])
    expect(folioDeclaration(ws, 'book').isFolio).toBe(false)
    second.emit('error', new Error('lost replacement'))
    expect(nativeWatch).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.map(call => String(call[0])).join(' ')).toContain('no further recreation')
    await writeFile(join(root, 'book/_book_INDEX.md'), running)
    expect(folioDeclaration(ws, 'book').isFolio).toBe(true)
  } finally {
    watcher.dispose()
    expect(closedSecond).toHaveBeenCalledTimes(1)
    nativeWatch.mockRestore(); warn.mockRestore()
  }
})
