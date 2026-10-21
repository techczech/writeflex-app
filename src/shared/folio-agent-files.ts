/**
 * THE never-a-part rule for a Folio's agent instructions (spec 2026-10-14, "What must always hold" 1).
 * `AGENTS.md` and `CLAUDE.md` tell an agent how the Folio works; they are never pieces of the work. A
 * sync conflict copy of either (`AGENTS-Other.md`, `AGENTS (conflicted copy).md`) is treated like the
 * original. Pure and Node-free, so main's part lists and the renderer's Outline grouping share it.
 *
 * Where it applies (decision recorded in the 0.23-08 report):
 * - Every list of Folio parts or candidate parts applies it by name alone, in any folder: the running
 *   order fallback, the drafted manifest, the manifest's own entries, Add and Add all, the Plan's
 *   unlisted files, the Outline's "Also in this folder". Those lists only ever describe a Folio (or a
 *   folder about to become one), so the name is enough.
 * - The Collection lists (the Folder dashboard rows, the Board, the Word export, word counts, digests)
 *   apply it only to a file inside a Folio: its own folder or a folder above it holds a manifest
 *   (`isFolioAgentInstructionsFile` in main), so an AGENTS.md in a folder that is in no Folio keeps showing.
 */

import { isConflictCopyOf } from './conflict-copy'

/** The file every agent reads (Codex and most others). WriteFlex keeps one part of it. */
export const AGENTS_FILE = 'AGENTS.md'
/** The file Claude Code reads. WriteFlex writes it as one import line, and never changes one it did not write. */
export const CLAUDE_FILE = 'CLAUDE.md'
/** The one line WriteFlex writes as `CLAUDE.md`: Claude Code's import of `AGENTS.md`. */
export const CLAUDE_IMPORT_LINE = '@AGENTS.md'

const NAMES = [AGENTS_FILE, CLAUDE_FILE] as const

/** The file name of a workspace path (or the name itself). */
function nameOf(pathOrName: string): string {
  const cut = pathOrName.lastIndexOf('/')
  return cut < 0 ? pathOrName : pathOrName.slice(cut + 1)
}

/**
 * Whether a file's name makes it agent instructions: `AGENTS.md` or `CLAUDE.md` (any letter case), or a
 * sync conflict copy of either. A copy keeps the original's spelling (`AGENTS-Other.md`,
 * `CLAUDE (conflicted copy).md`), so the copy rule is read with the capitals as written: a part named
 * `agents-guide.md` stays a part. Never a Folio part.
 */
export function isAgentInstructionsName(pathOrName: string): boolean {
  const name = nameOf(pathOrName)
  const folded = name.toLocaleLowerCase()
  return NAMES.some((original) => (
    folded === original.toLocaleLowerCase()
    || (name.startsWith(original.slice(0, -'.md'.length)) && /\.md$/i.test(name) && isConflictCopyOf(name, original))
  ))
}

export type AgentsState =
  /** No AGENTS.md. */
  | 'missing'
  /** WriteFlex's part is there, unedited, and is today's text. */
  | 'current'
  /** WriteFlex's part was edited by the author: it is not refreshed; Restore puts it back. */
  | 'edited'
  /** A marker line is missing, doubled or changed: WriteFlex leaves the file alone. */
  | 'damaged'
  /** AGENTS.md has no WriteFlex part (the author took it out). */
  | 'no-maintained-part'
  /** Not a plain file (a link, a folder) or not readable: WriteFlex leaves it alone. */
  | 'unreadable'

export type ClaudeState =
  /** No CLAUDE.md. */
  | 'missing'
  /** CLAUDE.md imports AGENTS.md (WriteFlex's line, or the author's file with the line). */
  | 'imports'
  /** The author's own CLAUDE.md, which does not import AGENTS.md: Claude Code reads it, not AGENTS.md. */
  | 'own'
  | 'unreadable'

export type FolioAgentInstructionsStatus = {
  dir: string
  agentsPath: string
  claudePath: string
  agents: AgentsState
  claude: ClaudeState
  /** Paths written by this read: an unedited maintained part refreshed to today's text. */
  written: string[]
}

export type FolioAgentInstructionsAction = 'restore' | 'write-claude'
