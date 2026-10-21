/**
 * Agent instructions written into every Folio (spec 2026-10-14, ticket 0.23-08). When a folder becomes a
 * Folio, WriteFlex writes `AGENTS.md` (a part it maintains, between two marker lines, then the author's
 * part) and a one-line `CLAUDE.md` that imports it. This module is the only writer of those two files.
 *
 * What holds under every state (the spec's table):
 * - The author's part (everything in AGENTS.md outside the marker lines) is never changed.
 * - The maintained part is replaced only while it is exactly what WriteFlex wrote: the BEGIN line records
 *   a hash of the text WriteFlex put between the markers, and a part whose text no longer matches it was
 *   edited by the author and is never refreshed (Restore puts it back, on request only).
 * - An AGENTS.md that was there before keeps every byte; the maintained part is appended at its end.
 * - An existing CLAUDE.md is never changed except by the author's own request to add the import line.
 * - Nothing is recreated silently: a file deleted by hand is reported as missing and written again only on request.
 * - Turn back into a collection removes the maintained block, keeping any text the person wrote.
 * - Every write checks, in the tick of its rename, that the file on disk is still the text it was made
 *   from (or still absent for a new file); a symbolic link is never written through.
 *
 * The maintained text is generated from `FOLIO_RULES`, the constants the Folio code itself uses; a test
 * (folio-agent-instructions.test.ts) checks each statement against the code so the two cannot drift.
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { MANIFEST_NAME } from './folio'
import type { Workspace } from './workspace'
import {
  AGENTS_FILE,
  CLAUDE_FILE,
  CLAUDE_IMPORT_LINE,
  type AgentsState,
  type ClaudeState,
  type FolioAgentInstructionsAction,
  type FolioAgentInstructionsStatus,
} from '../shared/folio-agent-files'

export type { AgentsState, ClaudeState, FolioAgentInstructionsAction, FolioAgentInstructionsStatus }
import { PLAN_ROLES } from '../shared/plan-line'

/** The facts the maintained text states, from the constants the Folio code uses. */
export const FOLIO_RULES = {
  manifest: MANIFEST_NAME,
  roles: PLAN_ROLES,
  defaultRole: 'section',
  backupSuffix: '.writeflex-backup',
  coverNames: ['README.md', 'index.md'],
  agentFiles: [AGENTS_FILE, CLAUDE_FILE],
  numberedExamples: ['01-intro.md', '02_method.md'],
  runningOrderHeading: '## Running order',
  appFolder: '.writeflex',
} as const

const BEGIN_PREFIX = '<!-- BEGIN WriteFlex Folio instructions ('
const BEGIN_LINE = /^<!-- BEGIN WriteFlex Folio instructions \(([0-9a-f]{12})(?:; separator=[012])?\)[^\n]*-->\s*$/
const BEGIN_LOOSE = /^<!--\s*BEGIN WriteFlex Folio instructions/
const END_LINE = '<!-- END WriteFlex Folio instructions -->'
const END_LOOSE = /^<!--\s*END WriteFlex Folio instructions/

/** The text WriteFlex maintains between the marker lines. Generated from `FOLIO_RULES`. */
export function maintainedInstructionsBody(): string {
  const r = FOLIO_RULES
  const roles = r.roles.join(', ')
  return [
    '## How this Folio works',
    '',
    'WriteFlex keeps this part up to date. Put your own instructions below the END line.',
    '',
    'This folder is a Folio: one document made of parts, compiled in a fixed order.',
    '',
    '### Files',
    '',
    `- \`${r.manifest}\` (the manifest) holds the running order. Its \`files\` array lists the parts in order; each entry has a \`path\` and a \`role\` (one of: ${roles}). When \`content_root\` is set, it names the folder inside this one where the parts sit, and each \`path\` is relative to it.`,
    '- A part is a Markdown file in this folder, or in `content_root`. A part never lies outside this folder.',
    `- \`_<folder name>_INDEX.md\`, when there is one, is the Index Note. Its \`${r.runningOrderHeading}\` list records the same order as the manifest: change both the same way, or WriteFlex shows that they disagree.`,
    `- Never parts: files whose names start with \`_\`, the cover notes (${r.coverNames.map((name) => `\`${name}\``).join(', ')}, \`_<folder name>.md\`), backups ending \`${r.backupSuffix}\`, and the agent instructions ${r.agentFiles.map((name) => `\`${name}\``).join(' and ')} (and sync conflict copies of either).`,
    '- A Markdown file with no entry in the manifest is in the folder but not in the running order.',
    `- Front matter (a title page, a preface, acknowledgements) has the role \`front-matter\` and \`"toc": false\` in its entry; its entries come first in \`files\`. It exports before the contents page and is never listed in it. A part whose own frontmatter says \`role: title-matter\` is the title page, and the export uses it as the cover.`,
    '',
    '### WriteFlex\'s own files: do not edit by hand',
    '',
    `- The \`${r.appFolder}/\` folder and any file ending \`${r.backupSuffix}\`.`,
    `- The part of \`${AGENTS_FILE}\` between the BEGIN and END lines. If it is edited, WriteFlex stops updating it.`,
    '',
    '### Changing the Folio',
    '',
    `- Add a part: create the Markdown file, starting with a \`# Title\` line, then add \`{ "path": "<file name>", "role": "${r.defaultRole}" }\` to \`files\`. Its place in \`files\` is its place in the Folio.`,
    '- Move a part: move its entry within `files`. Change nothing else in the manifest, and keep it valid JSON.',
    '- Leave a part out: remove its entry. The file stays in the folder.',
    '- Sections are the headings inside a part. Move a section by moving its heading and its text from one part file to another.',
    `- Numbered file names (\`${r.numberedExamples[0]}\`, \`${r.numberedExamples[1]}\`) give the order only while there is no manifest; once there is one, the manifest decides.`,
    '',
    '### Proposing a change',
    '',
    '- If the `writeflex` command is installed (`writeflex help` runs), use it instead of editing files: the writer reviews its changes in WriteFlex, with undo. Declare yourself with `--source claude-code` or `--source codex`.',
    '- Otherwise edit the files. WriteFlex shows the writer changes made outside it.',
  ].join('\n')
}

/** The hash a BEGIN line records: of the maintained text, line endings made LF. */
function bodyHash(body: string): string {
  return createHash('sha256').update(body.replace(/\r\n?/g, '\n'), 'utf8').digest('hex').slice(0, 12)
}

function beginLine(body: string): string {
  return `${BEGIN_PREFIX}${bodyHash(body)}): WriteFlex keeps the text up to the END line current. Your own instructions go below it. -->`
}

/** The maintained part, marker lines included, with no trailing newline. */
export function maintainedBlock(body = maintainedInstructionsBody()): string {
  return `${beginLine(body)}\n${body}\n${END_LINE}`
}

const AUTHOR_HEADING = '## Your instructions'
const AUTHOR_PLACEHOLDER = 'Add your own instructions for agents here: the voice, the audience, the sources to use. WriteFlex never changes anything below the END line.'

/** The AGENTS.md WriteFlex writes when there was none. */
export function newAgentsFile(body = maintainedInstructionsBody()): string {
  return `# Agent instructions\n\n${maintainedBlock(body)}\n\n${AUTHOR_HEADING}\n\n${AUTHOR_PLACEHOLDER}\n`
}

/** The CLAUDE.md WriteFlex writes when there was none. */
export const NEW_CLAUDE_FILE = `${CLAUDE_IMPORT_LINE}\n`

/** Where the maintained part sits in a file, by character offset: `start` is the BEGIN line's first
 *  character, `end` is just after the END line (its line ending not included). */
type Block = { start: number; end: number; body: string; recorded: string; crlf: boolean }
type Parsed = { kind: 'none' } | { kind: 'damaged' } | ({ kind: 'block' } & Block)

/** Find the maintained part. Exactly one well-formed BEGIN line followed by exactly one END line is a
 *  block; any other use of the markers is damaged, and a damaged file is never written. */
export function parseAgentsText(text: string): Parsed {
  const lines: Array<{ text: string; start: number; end: number }> = []
  let at = 0
  while (at <= text.length) {
    const next = text.indexOf('\n', at)
    const stop = next < 0 ? text.length : next
    const raw = text.slice(at, stop)
    // `end` stops before a line's own CR, so a replacement keeps the file's line ending after the END line.
    lines.push({ text: raw.replace(/\r$/, ''), start: at, end: raw.endsWith('\r') ? stop - 1 : stop })
    if (next < 0) break
    at = next + 1
  }
  const begins = lines.filter((line) => BEGIN_LOOSE.test(line.text))
  const ends = lines.filter((line) => END_LOOSE.test(line.text))
  if (begins.length === 0 && ends.length === 0) return { kind: 'none' }
  if (begins.length !== 1 || ends.length !== 1) return { kind: 'damaged' }
  const begin = begins[0]
  const end = ends[0]
  const recorded = BEGIN_LINE.exec(begin.text)?.[1]
  if (!recorded || end.text.trim() !== END_LINE || end.start <= begin.start) return { kind: 'damaged' }
  const inner = lines.filter((line) => line.start > begin.start && line.start < end.start)
  const body = inner.map((line) => line.text).join('\n')
  return { kind: 'block', start: begin.start, end: end.end, body, recorded, crlf: text.slice(begin.start, end.end).includes('\r\n') }
}

/** Called before an existing file is changed (a restore point), never for a new file. */
export type BeforeChange = (path: string) => Promise<void>

const pathIn = (dir: string, name: string): string => (dir === '' ? name : posix.join(dir, name))

type Disk = { kind: 'absent' } | { kind: 'file'; text: string } | { kind: 'unreadable' }

function readDisk(ws: Workspace, path: string): Disk {
  let absolute: string
  try {
    absolute = ws.absolute(path)
  } catch {
    return { kind: 'unreadable' }
  }
  try {
    const info = lstatSync(absolute)
    if (!info.isFile()) return { kind: 'unreadable' }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' }
  }
  try {
    return { kind: 'file', text: readFileSync(absolute, 'utf8') }
  } catch {
    return { kind: 'unreadable' }
  }
}

/** The file on disk is still `expected` (or still absent when `expected` is null). Synchronous: the check
 *  runs in the tick of the rename or the unlink. */
function stillIs(ws: Workspace, path: string, expected: string | null): boolean {
  const now = readDisk(ws, path)
  return expected === null ? now.kind === 'absent' : now.kind === 'file' && now.text === expected
}

const changedMeanwhile = (path: string): Error => new Error(`${path} changed while WriteFlex was writing it, so nothing was changed.`)

/** Write `next` over a file that held `current` (null = it did not exist), refusing if the disk moved. */
async function writeGuarded(ws: Workspace, path: string, current: string | null, next: string, beforeChange?: BeforeChange): Promise<void> {
  if (current !== null) await beforeChange?.(path)
  // The bytes were compared just above and are compared again at the rename, so an empty result (an empty
  // AGENTS.md that held only WriteFlex's part) is a deliberate write, not a lost document.
  await ws.saveFileWithoutReadBack(path, next, {
    allowExplicitEmpty: true,
    beforeCommit: () => {
      if (!stillIs(ws, path, current)) throw changedMeanwhile(path)
    },
  })
}

function agentsStateOf(disk: Disk): AgentsState {
  if (disk.kind === 'absent') return 'missing'
  if (disk.kind === 'unreadable') return 'unreadable'
  const parsed = parseAgentsText(disk.text)
  if (parsed.kind === 'none') return 'no-maintained-part'
  if (parsed.kind === 'damaged') return 'damaged'
  if (bodyHash(parsed.body) !== parsed.recorded) return 'edited'
  return 'current'
}

/** Whether a CLAUDE.md text imports AGENTS.md (a line `@AGENTS.md` or `@./AGENTS.md`). */
export function importsAgents(text: string): boolean {
  return text.split(/\r?\n/).some((line) => /^@(?:\.\/)?AGENTS\.md\s*$/.test(line.trim()))
}

function claudeStateOf(disk: Disk): ClaudeState {
  if (disk.kind === 'absent') return 'missing'
  if (disk.kind === 'unreadable') return 'unreadable'
  return importsAgents(disk.text) ? 'imports' : 'own'
}

/** Replace the block in `text` with today's maintained part; every other character stays. */
function withBlockReplaced(text: string, block: Block): string {
  const separator = /; separator=([012])/.exec(text.slice(block.start, text.indexOf('\n', block.start)))?.[1]
  const fresh = separator === undefined ? maintainedBlock() : maintainedBlock().replace('): WriteFlex', `; separator=${separator}): WriteFlex`)
  return `${text.slice(0, block.start)}${block.crlf ? fresh.replace(/\n/g, '\r\n') : fresh}${text.slice(block.end)}`
}

/** Append the maintained part to an author's AGENTS.md: a blank line, then the part. Nothing else changes. */
export function withBlockAppended(text: string): string {
  const separator = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return `${text}${separator}${maintainedBlock().replace('): WriteFlex', `; separator=${separator.length}): WriteFlex`)}\n`
}

/**
 * Make Folio: write the instructions into a folder that has just become a Folio. A missing AGENTS.md is
 * written whole; an existing one without WriteFlex's part gets it appended; one that already has it is
 * refreshed only when unedited. A missing CLAUDE.md is written; an existing one is left alone.
 * Returns the paths written.
 */
export async function writeFolioAgentInstructions(ws: Workspace, dir: string, beforeChange?: BeforeChange): Promise<string[]> {
  const agentsPath = pathIn(dir, AGENTS_FILE)
  const claudePath = pathIn(dir, CLAUDE_FILE)
  const written: string[] = []
  const agents = readDisk(ws, agentsPath)
  if (agents.kind === 'absent') {
    await writeGuarded(ws, agentsPath, null, newAgentsFile())
    written.push(agentsPath)
  } else if (agents.kind === 'file') {
    const parsed = parseAgentsText(agents.text)
    if (parsed.kind === 'none') {
      await writeGuarded(ws, agentsPath, agents.text, withBlockAppended(agents.text), beforeChange)
      written.push(agentsPath)
    } else if (parsed.kind === 'block' && bodyHash(parsed.body) === parsed.recorded && parsed.body !== maintainedInstructionsBody()) {
      await writeGuarded(ws, agentsPath, agents.text, withBlockReplaced(agents.text, parsed), beforeChange)
      written.push(agentsPath)
    }
  }
  const claude = readDisk(ws, claudePath)
  // Existing instructions belong to the author; an old ownership record cannot authorise an append.
  if (claude.kind === 'absent') {
    await writeGuarded(ws, claudePath, null, NEW_CLAUDE_FILE)
    written.push(claudePath)
  }
  return written
}

/**
 * What the Plan and the Folder dashboard show for a Folio's instructions. The one write it may make: an
 * unedited maintained part whose text is not today's (a new WriteFlex version changed the Folio rules)
 * is refreshed in place. Nothing missing is recreated here.
 */
export async function folioAgentInstructionsStatus(ws: Workspace, dir: string, beforeChange?: BeforeChange): Promise<FolioAgentInstructionsStatus> {
  const agentsPath = pathIn(dir, AGENTS_FILE)
  const claudePath = pathIn(dir, CLAUDE_FILE)
  const written: string[] = []
  const agents = readDisk(ws, agentsPath)
  if (agents.kind === 'file') {
    const parsed = parseAgentsText(agents.text)
    if (parsed.kind === 'block' && bodyHash(parsed.body) === parsed.recorded && parsed.body !== maintainedInstructionsBody()) {
      try {
        await writeGuarded(ws, agentsPath, agents.text, withBlockReplaced(agents.text, parsed), beforeChange)
        written.push(agentsPath)
      } catch {
        // The file changed under the refresh: nothing was written, and the next read tries again.
      }
    }
  }
  return {
    dir,
    agentsPath,
    claudePath,
    agents: agentsStateOf(readDisk(ws, agentsPath)),
    claude: claudeStateOf(readDisk(ws, claudePath)),
    written,
  }
}

/**
 * The author's requests from the panel. `restore`: put WriteFlex's part back as today's text (an edited
 * part is replaced, a missing part is appended, a missing file is written again). `write-claude`: write a
 * missing CLAUDE.md, or add the import line at the end of the author's own. Both refuse a damaged or
 * unreadable file. Returns the paths written.
 */
export async function actOnFolioAgentInstructions(ws: Workspace, dir: string, action: FolioAgentInstructionsAction, beforeChange?: BeforeChange): Promise<string[]> {
  if (action === 'restore') {
    const path = pathIn(dir, AGENTS_FILE)
    const disk = readDisk(ws, path)
    if (disk.kind === 'unreadable') throw new Error(`${path} is not a plain file WriteFlex can write, so nothing was changed.`)
    if (disk.kind === 'absent') {
      await writeGuarded(ws, path, null, newAgentsFile())
      return [path]
    }
    const parsed = parseAgentsText(disk.text)
    if (parsed.kind === 'damaged') throw new Error(`A WriteFlex marker line in ${path} is missing or changed, so WriteFlex cannot tell its part from yours. Nothing was changed.`)
    const next = parsed.kind === 'none' ? withBlockAppended(disk.text) : withBlockReplaced(disk.text, parsed)
    if (next === disk.text) return []
    await writeGuarded(ws, path, disk.text, next, beforeChange)
    return [path]
  }
  if (action === 'write-claude') {
    const path = pathIn(dir, CLAUDE_FILE)
    const disk = readDisk(ws, path)
    if (disk.kind === 'unreadable') throw new Error(`${path} is not a plain file WriteFlex can write, so nothing was changed.`)
    if (disk.kind === 'absent') {
      await writeGuarded(ws, path, null, NEW_CLAUDE_FILE)
      return [path]
    }
    if (importsAgents(disk.text)) return []
    const separator = disk.text === '' || disk.text.endsWith('\n') ? '' : '\n'
    await writeGuarded(ws, path, disk.text, `${disk.text}${separator}${CLAUDE_IMPORT_LINE}\n`, beforeChange)
    return [path]
  }
  throw new Error('Unknown agent instructions action.')
}
