import { test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { draftManifest, fallbackFolioParts, MANIFEST_NAME, parseManifest } from '../../src/main/folio'
import {
  FOLIO_RULES,
  NEW_CLAUDE_FILE,
  actOnFolioAgentInstructions,
  folioAgentInstructionsStatus,
  maintainedBlock,
  maintainedInstructionsBody,
  newAgentsFile,
  parseAgentsText,
  writeFolioAgentInstructions,
  withBlockAppended,
} from '../../src/main/folio-agent-instructions'
import { declaresRunningOrder, PLAN_BACKUP_SUFFIX } from '../../src/main/plan'
import { PLAN_ROLES } from '../../src/shared/plan-line'
import { AGENTS_FILE, CLAUDE_FILE, CLAUDE_IMPORT_LINE } from '../../src/shared/folio-agent-files'

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-agents-'))
  ws = new Workspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
/** A Folio folder with one part: WriteFlex writes instructions only into a folder that is there. */
const folder = async (dir: string): Promise<void> => write(`${dir}/01-part.md`, '# Part\n')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
const has = (rel: string): boolean => existsSync(join(root, rel))

/** A maintained part as an older WriteFlex wrote it: unedited, but not today's text. */
const olderBody = (): string => maintainedInstructionsBody().replace('compiled in a fixed order.', 'compiled in order.')

// ---- The state table, one test per row ----

test('state: new Folio, no instruction files — both files are written', async () => {
  await write('r/01-a.md', '# A\n')
  expect(await writeFolioAgentInstructions(ws, 'r')).toEqual(['r/AGENTS.md', 'r/CLAUDE.md'])
  expect(read('r/AGENTS.md')).toBe(newAgentsFile())
  expect(read('r/CLAUDE.md')).toBe(`${CLAUDE_IMPORT_LINE}\n`)
  const status = await folioAgentInstructionsStatus(ws, 'r')
  expect(status).toEqual({ dir: 'r', agentsPath: 'r/AGENTS.md', claudePath: 'r/CLAUDE.md', agents: 'current', claude: 'imports', written: [] })
})

test('state: folder already has AGENTS.md — the maintained part is appended and nothing else changes', async () => {
  const mine = '# My agents\n\nWrite in British English.\n'
  await write('r/AGENTS.md', mine)
  await writeFolioAgentInstructions(ws, 'r')
  const after = read('r/AGENTS.md')
  expect(after.startsWith(mine)).toBe(true)
  expect(after).toBe(withBlockAppended(mine))
  // Without a final newline the author's bytes are still a prefix.
  await write('s/AGENTS.md', 'No newline')
  await writeFolioAgentInstructions(ws, 's')
  expect(read('s/AGENTS.md').startsWith('No newline\n\n<!-- BEGIN WriteFlex Folio instructions')).toBe(true)
})

test('state: folder already has CLAUDE.md — left alone, the panel notes it and offers the import line', async () => {
  const mine = 'Use the house style.\n'
  await write('r/CLAUDE.md', mine)
  expect(await writeFolioAgentInstructions(ws, 'r')).toEqual(['r/AGENTS.md'])
  expect(read('r/CLAUDE.md')).toBe(mine)
  expect((await folioAgentInstructionsStatus(ws, 'r')).claude).toBe('own')
  expect(await actOnFolioAgentInstructions(ws, 'r', 'write-claude')).toEqual(['r/CLAUDE.md'])
  expect(read('r/CLAUDE.md')).toBe(`${mine}${CLAUDE_IMPORT_LINE}\n`)
  expect((await folioAgentInstructionsStatus(ws, 'r')).claude).toBe('imports')
  // An author's CLAUDE.md that already imports AGENTS.md is never touched again.
  expect(await actOnFolioAgentInstructions(ws, 'r', 'write-claude')).toEqual([])
})

test('state: author edited their part — never touched by refresh, Restore or make', async () => {
  await folder('r')
  await writeFolioAgentInstructions(ws, 'r')
  const edited = read('r/AGENTS.md').replace(/Add your own instructions[^\n]*/, 'Audience: policy makers.\nSources: research/ only.')
  await write('r/AGENTS.md', edited)
  expect((await folioAgentInstructionsStatus(ws, 'r')).agents).toBe('current')
  expect(read('r/AGENTS.md')).toBe(edited)
  expect(await writeFolioAgentInstructions(ws, 'r')).toEqual([])
  expect(await actOnFolioAgentInstructions(ws, 'r', 'restore')).toEqual([])
  expect(read('r/AGENTS.md')).toBe(edited)
})

test('state: author edited the maintained part — not refreshed, Restore puts it back and keeps their part', async () => {
  await write('r/AGENTS.md', `# Mine\n\nKeep me.\n\n${maintainedBlock(olderBody())}\n\nAlso mine.\n`)
  const edited = read('r/AGENTS.md').replace('This folder is a Folio', 'This folder is MY Folio')
  await write('r/AGENTS.md', edited)
  const status = await folioAgentInstructionsStatus(ws, 'r')
  expect(status.agents).toBe('edited')
  expect(status.written).toEqual([])
  expect(read('r/AGENTS.md')).toBe(edited)
  expect(await writeFolioAgentInstructions(ws, 'r')).toEqual(['r/CLAUDE.md'])
  expect(read('r/AGENTS.md')).toBe(edited)

  const checkpoints: string[] = []
  expect(await actOnFolioAgentInstructions(ws, 'r', 'restore', async (path) => { checkpoints.push(path) })).toEqual(['r/AGENTS.md'])
  expect(checkpoints).toEqual(['r/AGENTS.md'])
  expect(read('r/AGENTS.md')).toBe(`# Mine\n\nKeep me.\n\n${maintainedBlock()}\n\nAlso mine.\n`)
  expect((await folioAgentInstructionsStatus(ws, 'r')).agents).toBe('current')
})

test('state: a new WriteFlex version changes the rules — the part is refreshed where unedited, the rest kept', async () => {
  // A file saved with CRLF line endings: the hash reads LF, and the refreshed part keeps the file's CRLF.
  const around = (block: string) => `# Mine\r\n\r\nKeep me.\r\n\r\n${block.replace(/\n/g, '\r\n')}\r\n\r\n## Your instructions\r\n\r\nVoice: plain.\r\n`
  await write('r/AGENTS.md', around(maintainedBlock(olderBody())))
  const status = await folioAgentInstructionsStatus(ws, 'r')
  expect(status.written).toEqual(['r/AGENTS.md'])
  expect(status.agents).toBe('current')
  expect(read('r/AGENTS.md')).toBe(around(maintainedBlock()))
  // A second read writes nothing.
  expect((await folioAgentInstructionsStatus(ws, 'r')).written).toEqual([])
})

test('state: a file deleted by hand — reported missing, never recreated silently, written again on request', async () => {
  await folder('r')
  await writeFolioAgentInstructions(ws, 'r')
  await rm(join(root, 'r/AGENTS.md'))
  await rm(join(root, 'r/CLAUDE.md'))
  const status = await folioAgentInstructionsStatus(ws, 'r')
  expect([status.agents, status.claude, status.written]).toEqual(['missing', 'missing', []])
  expect(has('r/AGENTS.md') || has('r/CLAUDE.md')).toBe(false)
  expect(await actOnFolioAgentInstructions(ws, 'r', 'restore')).toEqual(['r/AGENTS.md'])
  expect(await actOnFolioAgentInstructions(ws, 'r', 'write-claude')).toEqual(['r/CLAUDE.md'])
  expect(read('r/AGENTS.md')).toBe(newAgentsFile())
  expect(read('r/CLAUDE.md')).toBe(NEW_CLAUDE_FILE)
})

test('state: a Folio inside another Folio’s folder has its own instructions', async () => {
  await folder('outer/inner')
  await writeFolioAgentInstructions(ws, 'outer')
  await writeFolioAgentInstructions(ws, 'outer/inner')
  expect(has('outer/AGENTS.md') && has('outer/inner/AGENTS.md')).toBe(true)
  expect(has('outer/CLAUDE.md') && has('outer/inner/CLAUDE.md')).toBe(true)
  await write('outer/inner/AGENTS.md', read('outer/inner/AGENTS.md').replace('This folder is a Folio', 'Changed'))
  expect((await folioAgentInstructionsStatus(ws, 'outer')).agents).toBe('current')
  expect((await folioAgentInstructionsStatus(ws, 'outer/inner')).agents).toBe('edited')
})

test('state: a sync conflict copy of AGENTS.md is not a part, like the original', async () => {
  await write('r/01-a.md', '# A\n')
  await write('r/AGENTS.md', '# Mine\n')
  await write('r/AGENTS-Other Mac.md', '# Mine, the other Mac\n')
  await write('r/CLAUDE (conflicted copy).md', '@AGENTS.md\n')
  expect(await fallbackFolioParts(ws, 'r')).toEqual(['r/01-a.md'])
})

// ---- Write safety ----

test('a damaged marker line: status says so and no route writes the file', async () => {
  const damaged = `# Mine\n\n${maintainedBlock()}\n`.replace('<!-- END WriteFlex Folio instructions -->', '<!-- END -->')
  await write('r/AGENTS.md', damaged)
  expect((await folioAgentInstructionsStatus(ws, 'r')).agents).toBe('damaged')
  await writeFolioAgentInstructions(ws, 'r')
  await expect(actOnFolioAgentInstructions(ws, 'r', 'restore')).rejects.toThrow(/marker line/)
  expect(read('r/AGENTS.md')).toBe(damaged)
  // Two BEGIN lines are damaged too.
  expect(parseAgentsText(`${maintainedBlock()}\n${maintainedBlock()}\n`).kind).toBe('damaged')
})

test('a symbolic link named AGENTS.md or CLAUDE.md is never written through', async () => {
  await write('elsewhere.md', 'Target.\n')
  await mkdir(join(root, 'r'), { recursive: true })
  await symlink(join(root, 'elsewhere.md'), join(root, 'r', 'AGENTS.md'))
  await symlink(join(root, 'elsewhere.md'), join(root, 'r', 'CLAUDE.md'))
  expect(await writeFolioAgentInstructions(ws, 'r')).toEqual([])
  const status = await folioAgentInstructionsStatus(ws, 'r')
  expect([status.agents, status.claude]).toEqual(['unreadable', 'unreadable'])
  await expect(actOnFolioAgentInstructions(ws, 'r', 'restore')).rejects.toThrow(/not a plain file/)
  await expect(actOnFolioAgentInstructions(ws, 'r', 'write-claude')).rejects.toThrow(/not a plain file/)
  expect(read('elsewhere.md')).toBe('Target.\n')
})

test('a file that appears or changes during a write is not overwritten', async () => {
  // Restore reads the edited file, then the author saves again before the rename: refused, their bytes stay.
  await folder('r')
  await writeFolioAgentInstructions(ws, 'r')
  await write('r/AGENTS.md', read('r/AGENTS.md').replace('This folder is a Folio', 'Edited once'))
  const later = read('r/AGENTS.md').replace('Edited once', 'Edited twice')
  await expect(actOnFolioAgentInstructions(ws, 'r', 'restore', async () => { await write('r/AGENTS.md', later) })).rejects.toThrow(/changed while WriteFlex was writing/)
  expect(read('r/AGENTS.md')).toBe(later)
})

// ---- The maintained text against the Folio rules (spec, "What must always hold" 5) ----

test('the maintained text states the rules the Folio code applies', async () => {
  const body = maintainedInstructionsBody()
  // The manifest name and every role the Plan and Add accept.
  expect(FOLIO_RULES.manifest).toBe(MANIFEST_NAME)
  expect(body).toContain(`\`${MANIFEST_NAME}\``)
  expect([...FOLIO_RULES.roles]).toEqual([...PLAN_ROLES])
  for (const role of PLAN_ROLES) expect(body).toContain(role)
  // The role an added part gets is the one Make Folio drafts.
  await write('d/01-a.md', '# A\n')
  expect(JSON.parse(await draftManifest(ws, 'd')).files[0].role).toBe(FOLIO_RULES.defaultRole)
  // The entry shape the text tells an agent to add is one the manifest reader keeps.
  const shape = /add `(\{ "path": "<file name>", "role": "[a-z]+" \})` to `files`/.exec(body)?.[1]
  expect(shape).toBeDefined()
  const parsed = parseManifest('', `{ "files": [${shape!.replace('<file name>', '01-a.md')}] }`)
  expect(parsed?.files).toEqual([{ path: '01-a.md', role: FOLIO_RULES.defaultRole }])
  // The Index Note heading the text names declares a running order.
  expect(declaresRunningOrder(`# R\n\n${FOLIO_RULES.runningOrderHeading}\n`)).toBe(true)
  expect(body).toContain(FOLIO_RULES.runningOrderHeading)
  // The backup suffix is the Plan's.
  expect(FOLIO_RULES.backupSuffix).toBe(PLAN_BACKUP_SUFFIX)
  // The WriteFlex folder is hidden from every listing.
  expect(ws.isVisiblePath(`${FOLIO_RULES.appFolder}/x/file.md`)).toBe(false)
  expect(body).toContain(`\`${FOLIO_RULES.appFolder}/\``)
})

test('the files the text calls "never parts" are exactly the ones the part rule leaves out', async () => {
  const body = maintainedInstructionsBody()
  const never = [
    '_notes.md',
    ...FOLIO_RULES.coverNames,
    '_f.md',
    '_f_INDEX.md',
    `03-draft.md${FOLIO_RULES.backupSuffix}`,
    ...FOLIO_RULES.agentFiles,
    'AGENTS-Other.md',
  ]
  for (const name of [...FOLIO_RULES.coverNames, ...FOLIO_RULES.agentFiles]) expect(body).toContain(`\`${name}\``)
  expect(body).toContain('`_`')
  expect(body).toContain(`\`${FOLIO_RULES.backupSuffix}\``)
  expect(body).toContain('sync conflict copies')
  const parts = ['10-close.md', FOLIO_RULES.numberedExamples[1], FOLIO_RULES.numberedExamples[0], 'zeta.md']
  for (const name of [...never, ...parts]) await write(`f/${name}`, '# X\n')
  // Numbered first in numeric order, then the rest by name: what "numbered file names give the order" says.
  expect(await fallbackFolioParts(ws, 'f')).toEqual(['f/01-intro.md', 'f/02_method.md', 'f/10-close.md', 'f/zeta.md'])
  for (const example of FOLIO_RULES.numberedExamples) expect(body).toContain(example)
})

test('the marker lines are the ones the parser reads, and the hash records the body', () => {
  const parsed = parseAgentsText(newAgentsFile())
  expect(parsed.kind).toBe('block')
  if (parsed.kind === 'block') expect(parsed.body).toBe(maintainedInstructionsBody())
  expect(parseAgentsText('# Nothing here\n').kind).toBe('none')
  expect(AGENTS_FILE).toBe('AGENTS.md')
  expect(CLAUDE_FILE).toBe('CLAUDE.md')
})
