import { posix } from 'node:path'
import { parseFrontmatter } from './frontmatter'
import { AGENT_NOTE_DIR } from './agent-note-create'
import type { FileReadResult, Workspace } from './workspace'
import { countTaskLines, readTaskLines, toggleTaskLine, type TaskCounts, type TaskLine } from '../shared/markdown/task-lines'

/**
 * Checkbox items read and ticked on disk (docs/design/2026-09-27-checkbox-lists, frame 10): the
 * `tasks.list` / `tasks.toggle` agent verbs and the Agent notes pane's tick all come through here,
 * so the agent's answer to "what's left?" and the boxes the writer sees are one reading of one file.
 */
export type TaskItemView = { line: number; text: string }
export type TaskListing = { path: string; open: TaskItemView[]; done: TaskItemView[]; counts: TaskCounts }

export function taskListing(path: string, content: string): TaskListing {
  const items = readTaskLines(content)
  const view = (item: TaskLine): TaskItemView => ({ line: item.line, text: item.text })
  return {
    path,
    open: items.filter((item) => !item.checked).map(view),
    done: items.filter((item) => item.checked).map(view),
    counts: countTaskLines(items),
  }
}

export async function listTasksInFile(workspace: Workspace, path: string): Promise<TaskListing> {
  const file = await workspace.readFile(path)
  return taskListing(file.file.path, file.content)
}

/** The item on `line`, or a refusal naming what is there instead. */
export async function taskOnLine(workspace: Workspace, path: string, line: number): Promise<TaskLine> {
  if (!Number.isInteger(line) || line < 1) throw new Error('line must be a 1-based line number (tasks.list gives it).')
  const item = readTaskLines((await workspace.readFile(path)).content).find((candidate) => candidate.line === line)
  if (!item) throw new Error(`Line ${line} of ${path} has no checkbox; call tasks.list for the lines that do.`)
  return item
}

export type TaskToggleResult = { saved: FileReadResult; line: number; checked: boolean; text: string }

/** Tick or untick the box on `line` of `path`: ONE character written, the rest of the file as it was. */
export async function toggleTaskInFile(workspace: Workspace, path: string, line: number, expected?: boolean): Promise<TaskToggleResult> {
  const source = await workspace.readFile(path)
  const next = toggleTaskLine(source.content, line, expected)
  const saved = await workspace.saveFile(path, next.text)
  return { saved, line, checked: next.checked, text: next.item.text }
}

/** Whether `path` is an agent's prose note (`agent-notes/…`, frontmatter `author: agent`). */
export function isAgentProseNote(path: string, content: string): boolean {
  if (posix.basename(posix.dirname(path)) !== AGENT_NOTE_DIR) return false
  const frontmatter = parseFrontmatter(content)
  return frontmatter?.author === 'agent' && typeof frontmatter.extra.source_document === 'string'
}

/**
 * The Agent notes pane's tick (journey B): writes into the NOTE's file only. Anything that is not an
 * agent note is refused before a byte is written, so a tick in the pane can never land in the piece.
 */
export async function toggleAgentNoteTask(workspace: Workspace, path: string, line: number, expected: boolean): Promise<TaskToggleResult> {
  const source = await workspace.readFile(path)
  if (!isAgentProseNote(source.file.path, source.content)) throw new Error(`${path} is not an agent note; the Agent notes pane ticks only agent notes.`)
  return toggleTaskInFile(workspace, source.file.path, line, expected)
}
