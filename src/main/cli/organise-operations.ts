/**
 * Direct writes that reorganise: rename or move a document, move a folder (both with link repair, both
 * undoable as one step), move something to the Trash, and undo. Link repair is the app's own
 * (rename-repair.ts), planned and applied through the WritingWorkspace so each repaired file is written
 * by the WriteSession and remembered for undo. A repair that fails partway is put back by the caller
 * (write-access.ts) and reported as refused.
 */
import { guardFolioFolderMove } from '../folio-declaration'

import { lstatSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { MANIFEST_NAME, indexNotePath, readManifest, resolveManifestFilePath } from '../folio'
import { applyRenameRepair, planRenameRepair, type RenameRepairIssue } from '../rename-repair'
import type { Workspace } from '../workspace'
import { undoEntry } from './journal'
import { idOfFileName, requestFileName } from './request-format'
import { followInReview } from './review-waiting'
import { undoInterrupted, type PlannedRecord } from './journal-intent'
import { CliError, type Operation } from './operation'
import { markdownPath, visiblePath } from './paths'
import { applied, writeAccess } from './write-support'
import type { WriteAccess } from './write-access'

const isFolder = (ws: Workspace, path: string): boolean => {
  try { return statSync(ws.absolute(path)).isDirectory() } catch { return false }
}
const exists = (ws: Workspace, path: string): boolean => {
  try { lstatSync(ws.absolute(path)); return true } catch { return false }
}
/** Whether two names stand for one file (a name differing only in letter case on a disk that ignores case). */
const sameFile = (ws: Workspace, a: string, b: string): boolean => {
  try {
    const [one, other] = [lstatSync(ws.absolute(a)), lstatSync(ws.absolute(b))]
    return one.ino === other.ino && one.dev === other.dev
  } catch { return false }
}
/** The size of the file at `path` now, or 0 when there is none. */
const sizeOf = (ws: Workspace, path: string): number => {
  try { return lstatSync(ws.absolute(path)).size } catch { return 0 }
}

type PlannedMove = { from: string; to: string; kind: 'file' | 'folder'; /** Where the moved file is now, when not yet at `from`. */ sizeAt?: string }

/**
 * Everything a move will put on record, for the journal's budget before the first change: the moves,
 * the moved file's own content when a file moves, and every file the link repairs will rewrite, with
 * its size now. `where` gives the path a planned write will have when it is made; a file already on
 * record is counted again only as the line naming its new fingerprint.
 */
function plannedRecord(ws: Workspace, moves: PlannedMove[], rewrites: string[], where: (path: string) => string): PlannedRecord {
  const files: PlannedRecord['files'] = []
  /** Keyed by the path each file has once everything has moved. */
  const onRecord = new Set<string>()
  const add = (sizeAt: string, line: string, key: string): void => {
    files.push({ path: line, beforeBytes: onRecord.has(key) ? null : sizeOf(ws, sizeAt) })
    onRecord.add(key)
  }
  for (const move of moves) if (move.kind === 'file') add(move.sizeAt ?? move.from, move.from, where(move.to))
  for (const path of rewrites) add(path, where(path), where(path))
  return { moves: moves.map(({ from, to, kind }) => ({ from, to, kind })), files }
}

/**
 * Sharing (ticket 04): a link follows what this moved, and ends with what this sent to the Trash, as
 * when WriteFlex does either itself. Told once the change is finished (committed); never stops it.
 */
async function followInSharing(access: WriteAccess, change: { moved: Array<{ from: string; to: string }> } | { trashed: string[] }): Promise<string[]> {
  if (!access.sharing) return []
  try {
    const line = 'moved' in change
      ? (change.moved.length ? await access.sharing.moved(change.moved.map(({ from, to }) => ({ from, to }))) : null)
      : await access.sharing.trashed(change.trashed)
    return line ? [line] : []
  } catch { return [] }
}

const noticeLines = (notices: string[]): string => (notices.length ? `\n${notices.map((notice) => `  - ${notice}`).join('\n')}` : '')
const issueTexts = (issues: RenameRepairIssue[]): string[] => issues.map((issue) => issue.text)

/**
 * What a moved folder's own manifests point at, before and after. Per-file repair sees one file move
 * at a time and so misreads a manifest that travelled with the folder; this compares the whole move.
 */
async function innerManifestNotices(ws: Workspace, from: string, to: string, before: Set<string>, after: Set<string>, folders: string[], now: (was: string) => string): Promise<string[]> {
  const notices: string[] = []
  const moved = (path: string | null): string | null => (path !== null && (path === from || path.startsWith(`${from}/`)) ? now(path) : path)
  for (const folder of folders.filter((candidate) => candidate === to || candidate.startsWith(`${to}/`))) {
    const manifest = await readManifest(ws, folder)
    if (!manifest) continue
    const was = `${from}${folder.slice(to.length)}`
    for (const file of manifest.files) {
      const pointedAt = moved(resolveManifestFilePath(was, manifest, file, before))
      const pointsAt = resolveManifestFilePath(folder, manifest, file, after)
      if (pointedAt !== pointsAt) notices.push(`${folder}/${MANIFEST_NAME}: ${file.path} pointed at ${pointedAt ?? 'no file'} and now points at ${pointsAt ?? 'no file'}.`)
    }
  }
  return notices
}

export const ORGANISE_OPERATIONS: Operation[] = [
  {
    name: 'move', group: 'Find and manage files', behaviour: 'direct', writes: true,
    summary: 'Rename or move a document. Links to it in other documents and Folio manifests are repaired. Undoable.',
    args: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative path of the document.' },
      { name: 'to', type: 'string', required: true, positional: true, description: 'Its new Collection-relative path, or an existing folder to move it into. To rename in place, give the folder too.' },
    ],
    run: async (ctx, args) => {
      const access = writeAccess(ctx)
      const ws = access.workspace
      const from = visiblePath(ws, String(args.path), { markdown: true })
      if (!exists(ws, from)) throw new CliError(`${from} does not exist.`)
      const typed = String(args.to)
      const into = typed === '.' || isFolder(ws, typed)
      const to = into
        ? visiblePath(ws, posix.join(visiblePath(ws, typed, { allowRoot: true }), posix.basename(from)), { markdown: true })
        : visiblePath(ws, markdownPath(typed), { markdown: true })
      if (to === from) throw new CliError(`${from} is already there. Nothing was changed.`)
      const plan = await planRenameRepair(ws, from, to)
      // The whole record is budgeted before anything changes; the intent still counts as it grows.
      access.journal.budget(plannedRecord(ws, [{ from, to, kind: 'file' }], plan.writes.map((write) => write.path), (path) => (path === from ? to : path)))
      await access.session.move(from, to, 'file')
      const repair = await applyRenameRepair(plan, ws)
      const notices = issueTexts(repair.issues)
      const undo = await access.commit(`Moved ${from} to ${to}`)
      const review = await followInReview(access, [{ from, to }])
      const sharing = await followInSharing(access, { moved: [{ from, to }] })
      return applied(
        `Moved ${from} to ${to}; links repaired in ${repair.writtenPaths.length} file${repair.writtenPaths.length === 1 ? '' : 's'}.${noticeLines([...notices, ...review.lines, ...sharing])}`,
        { from, to, repaired: repair.writtenPaths, notices, ...review.data }, undo,
      )
    },
  },
  {
    name: 'move-folder', group: 'Find and manage files', behaviour: 'direct', writes: true,
    summary: 'Rename or move a folder. Its Index Note is renamed with it, and links to the documents in it are repaired. Undoable as one step.',
    details: [
      `A folder's Index Note is the document in it named after it: _<folder name>_INDEX.md. When the folder's name changes, that note is renamed to match in the same operation (talks/_talks_INDEX.md becomes events/_events_INDEX.md), links to it are repaired like links to any moved document, and one "writeflex undo" puts the folder, the note and every repaired link back.`,
      'If the folder already holds a file with the name its Index Note would take, the whole move is refused before anything changes. A folder with no Index Note, and a folder moved without a change of name, are moved as they are.',
    ].join('\n'),
    args: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative path of the folder.' },
      { name: 'to', type: 'string', required: true, positional: true, description: 'Its new Collection-relative path, or an existing folder to move it into.' },
    ],
    run: async (ctx, args) => {
      const access = writeAccess(ctx)
      const ws = access.workspace
      const from = visiblePath(ws, String(args.path))
      if (!isFolder(ws, from)) throw new CliError(`${from} is not a folder.`)
      const typed = visiblePath(ws, String(args.to), { allowRoot: true })
      const to = typed === '' || (isFolder(ws, typed) && typed.toLowerCase() !== from.toLowerCase()) ? visiblePath(ws, posix.join(typed, posix.basename(from))) : typed
      if (to === from) throw new CliError(`${from} is already there. Nothing was changed.`)
      const before = (await ws.listFiles()).map((file) => file.path)
      const inside = before.filter((path) => path.startsWith(`${from}/`)).sort()
      // The folder's Index Note is named after the folder (folio.ts `indexNotePath`, the app's one
      // rule for it), so it is renamed with it: judged whole before anything is changed.
      const oldIndex = indexNotePath(ws, from)
      const newIndex = indexNotePath(ws, to)
      const renamesIndex = posix.basename(oldIndex) !== posix.basename(newIndex) && inside.includes(oldIndex)
      if (renamesIndex) {
        const inTheWay = `${from}/${posix.basename(newIndex)}`
        if (exists(ws, inTheWay) && !sameFile(ws, inTheWay, oldIndex)) {
          throw new CliError(
            `${from} was not moved: its Index Note ${oldIndex} would be renamed to ${newIndex} with the folder, and the folder already holds a file of that name (${inTheWay}). `
            + 'Nothing was changed. Rename or move that file first, then move the folder.',
          )
        }
      }
      /** Where a document that was inside the folder is once the move is done. */
      const now = (was: string): string => (renamesIndex && was === oldIndex ? newIndex : `${to}${was.slice(from.length)}`)
      // The whole record is budgeted before anything changes: the repairs are planned here as well, each
      // as if its document moved alone, which names every file a repair after the move can rewrite.
      // The intent still counts as it grows, as the second defence.
      const rewrites: string[] = []
      for (const was of inside) rewrites.push(...(await planRenameRepair(ws, was, now(was))).writes.map((write) => write.path))
      const indexMove = renamesIndex ? [{ from: `${to}/${posix.basename(oldIndex)}`, to: newIndex, kind: 'file' as const, sizeAt: oldIndex }] : []
      const where = (path: string): string => (path === from || path.startsWith(`${from}/`) ? now(path) : path)
      access.journal.budget(plannedRecord(ws, [{ from, to, kind: 'folder' }, ...indexMove], rewrites, where))
      await guardFolioFolderMove(ws, from, to, renamesIndex)
      await access.session.move(from, to, 'folder')
      // Same operation, same journal entry: one undo reverses the folder and its Index Note together.
      if (renamesIndex) await access.session.move(`${to}/${posix.basename(oldIndex)}`, newIndex, 'file')

      // One document at a time, each planned against the Collection as it now stands.
      const repaired = new Set<string>()
      const notices = new Set<string>()
      // `<folder>/<manifest name>: ...` from a manifest that travelled with the folder; judged whole, below.
      const fromInnerManifest = (text: string): boolean => {
        const at = text.indexOf(`/${MANIFEST_NAME}: `)
        return at > 0 && (text.slice(0, at) === to || text.slice(0, at).startsWith(`${to}/`))
      }
      for (const was of inside) {
        const plan = await planRenameRepair(ws, was, now(was))
        const repair = await applyRenameRepair(plan, ws)
        for (const path of repair.writtenPaths) repaired.add(path)
        for (const text of issueTexts(repair.issues)) if (!fromInnerManifest(text)) notices.add(text)
      }
      const after = new Set((await ws.listFiles()).map((file) => file.path))
      for (const notice of await innerManifestNotices(ws, from, to, new Set(before), after, await ws.listFolders(), now)) notices.add(notice)
      const undo = await access.commit(`Moved folder ${from} to ${to}`)
      // Everything that moved, in the order made: the folder, then its Index Note inside it.
      const moved = [{ from, to, kind: 'folder' as const }, ...(renamesIndex ? [{ from: `${to}/${posix.basename(oldIndex)}`, to: newIndex, kind: 'file' as const }] : [])]
      const review = await followInReview(access, moved)
      const sharing = await followInSharing(access, { moved })
      return applied(
        `Moved folder ${from} to ${to} (${inside.length} document${inside.length === 1 ? '' : 's'})${renamesIndex ? `, and renamed its Index Note with it: ${oldIndex} is now ${newIndex}` : ''}; links repaired in ${repaired.size} file${repaired.size === 1 ? '' : 's'}.${noticeLines([...notices, ...review.lines, ...sharing])}`,
        { from, to, documents: inside.length, moved, ...(renamesIndex ? { indexNote: { from: oldIndex, to: newIndex } } : {}), repaired: [...repaired], notices: [...notices], ...review.data }, undo,
      )
    },
  },
  {
    name: 'trash', group: 'Find and manage files', behaviour: 'direct', writes: true,
    summary: 'Move a file or folder to the system Trash. It can be put back from the Trash; nothing is deleted for good.',
    args: [{ name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative path of the file or folder.' }],
    run: async (ctx, args) => {
      const access = writeAccess(ctx)
      const ws = access.workspace
      const folder = isFolder(ws, String(args.path))
      const path = folder ? visiblePath(ws, String(args.path)) : ws.relative(ws.absolute(visibleFile(ws, String(args.path))))
      if (!exists(ws, path)) throw new CliError(`${path} does not exist.`)
      const kind = folder ? 'folder' : 'file'
      await access.session.trash(path, kind, access.trash)
      if (exists(ws, path)) throw new CliError(`${path} is still there: the system did not move it to the Trash.`, 'failed')
      const sharing = await followInSharing(access, { trashed: [path] })
      return applied(`Moved ${path} to the Trash. Put it back from the Trash if it is wanted; "writeflex undo" does not.${noticeLines(sharing)}`, { trashed: path, kind })
    },
  },
  {
    name: 'undo', group: 'Find and manage files', behaviour: 'direct', writes: (args) => args.list !== true,
    summary: 'Undo a direct change the command line made (a move or a change to an existing document), or list them with --list. See describe for what it does not cover.',
    details: [
      'Undone: a path the command line moved or renamed (moved back, with the links it repaired restored) and an existing document it changed (its text from before is put back), including a change interrupted partway. Each route undoes its own: a change the command line made directly (the Collection closed in WriteFlex) is undone the same way, and a change WriteFlex made for a request is undone with the Collection open in WriteFlex. --list shows both and says which is which.',
      'NOT undone: a file or folder the command line created (create, create-folder, duplicate, note, a new manifest): undo never deletes, so a new file stays and must be trashed. Nothing sent to the Trash by trash. A version saved by save-version. A file written by export. A change proposed for review: it has changed nothing, so take it back with withdraw while it waits, and reject it in WriteFlex once it is in the review dock.',
      'It refuses, and changes nothing, if a file it would restore has changed since the command line wrote it, a path it would move back is taken, or the folder at a moved folder\'s new name is not the folder that was moved (files edited inside a moved folder go back with their edits). A folder move is undone together with the rename of its Index Note. Entries are kept for 30 days, on this Mac only (outside the Collection, in WriteFlex\'s application data): a change made from the command line on another Mac is not on record here.',
    ].join('\n'),
    args: [
      { name: 'id', type: 'string', positional: true, description: 'The change to undo, as --list shows it. Default: the most recent one not yet undone.' },
      { name: 'list', type: 'boolean', description: 'List the recorded changes, newest first, and change nothing.' },
    ],
    run: async (ctx, args) => {
      if (args.list === true) {
        const { Journal } = await import('./journal')
        if (!ctx.records) throw new CliError('The undo journal was not located for this run.', 'failed')
        // Both journals, each from its own folder: the command line's direct changes, and the changes WriteFlex made on request.
        const rows: Array<{ id: string; at: string; operation: string; summary: string; files: number; undone: boolean; interrupted: boolean; undoStopped: boolean; by: 'command-line' | 'app' }> = []
        const unreadable: string[] = []
        for (const by of ['command-line', 'app'] as const) {
          const listed = await new Journal(ctx.workspace.root, ctx.records, { route: by }).list()
          unreadable.push(...listed.unreadable)
          rows.push(...listed.entries.map((entry) => ({ id: entry.id, at: entry.at, operation: entry.operation, summary: entry.summary, files: entry.files.length, undone: entry.undoneAt !== undefined, interrupted: entry.interrupted === true, undoStopped: entry.undoStopped !== undefined, by })))
        }
        rows.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        const who = { 'command-line': 'by the command line directly; undone with the Collection closed in WriteFlex', app: 'by WriteFlex on request; undone with the Collection open in WriteFlex' }
        return {
          data: { changes: rows, unreadable },
          text: rows.length
            ? rows.map((row) => `${row.id}  ${row.at.slice(0, 16).replace('T', ' ')}  ${row.summary}${row.interrupted && !row.undone ? '  (interrupted)' : ''}${row.undoStopped ? '  (an undo of it did not finish)' : ''}${row.undone ? '  (undone)' : ''}  [${who[row.by]}]`).join('\n')
            : 'No change by the command line, made directly or by WriteFlex on request, is on record for this Collection on this Mac.',
        }
      }
      // A request id (as a shown-first operation prints it) is not a journal entry: say what it is.
      if (args.id !== undefined && idOfFileName(requestFileName(String(args.id).trim())) !== null) {
        throw new CliError(
          `${String(args.id).trim()} is a change proposed for review, not a direct change, so "writeflex undo" does not cover it: it has changed nothing. `
          + 'While it is still waiting, take it back with "writeflex withdraw <id>" ("writeflex waiting" lists those). Once it is in WriteFlex\'s review dock, reject it there; if it was accepted, WriteFlex\'s own undo for an accepted change applies.',
        )
      }
      const access = writeAccess(ctx)
      const entry = await access.journal.find(args.id === undefined ? undefined : String(args.id))
      access.journal.undoing(entry)
      // A change that did not finish, and a finished one whose undo did not, are both put back file by
      // file: each file is judged by what it holds now (journal-intent.ts).
      if (entry.interrupted || entry.undoStopped) {
        const intent = { id: entry.id, at: entry.at, operation: entry.operation, moves: entry.moves, files: entry.files.map((file) => ({ path: file.path, before: file.before, wrote: file.wrote ?? [file.after] })) }
        const { restored, moved, refused } = await undoInterrupted(intent, access.workspace, access.session)
        const lines = [...moved.map((move) => `${move.from} moved back to ${move.to}`), ...restored.map((path) => `${path} restored`)]
        const what = entry.interrupted ? `the interrupted ${entry.operation}` : `the ${entry.operation}`
        if (refused.length) {
          // What was put back stays put back, and stays on record as an undo that did not finish.
          access.session.forget()
          await access.journal.keepUndoIntent(entry)
          throw new CliError(
            `Undo of ${what} (${entry.id}) is not complete. Refused and left as they are: ${refused.map((refusal) => `${refusal.path} ${refusal.reason}`).join('; ')}.`
            + (lines.length ? ` Done: ${lines.join('; ')}.` : ' Nothing else needed putting back.'),
          )
        }
        await access.journal.markUndone(entry)
        access.session.forget()
        const review = await followInReview(access, moved)
        const sharing = await followInSharing(access, { moved })
        return applied(`Undone: ${entry.summary}${noticeLines([...lines, ...review.lines, ...sharing])}`, { undone: entry.id, summary: entry.summary, restored, moved, ...(entry.interrupted ? { interrupted: true } : {}), ...(entry.undoStopped ? { resumed: true } : {}), ...review.data })
      }
      const { restored, moved } = await undoEntry(entry, access.workspace, access.session)
      await access.journal.markUndone(entry)
      access.session.forget()
      // The requests that followed the move follow it back: the journal's own record of the move is what is replayed.
      const review = await followInReview(access, moved)
      const sharing = await followInSharing(access, { moved })
      return applied(
        `Undone: ${entry.summary}${noticeLines([...moved.map((move) => `${move.from} moved back to ${move.to}`), ...restored.map((path) => `${path} restored`), ...review.lines, ...sharing])}`,
        { undone: entry.id, summary: entry.summary, restored, moved, ...review.data },
      )
    },
  },
]

/** A Collection-relative path of any visible file (a picture, a PDF), not only a Markdown one. */
function visibleFile(ws: Workspace, input: string): string {
  if (input === '') throw new CliError('A path is needed.', 'usage')
  const verdict = ws.classifyPath(input, 'file')
  if (verdict === 'outside') throw new CliError(`${input} is outside the Collection at ${ws.root}.`)
  if (verdict === 'hidden') throw new CliError(`${input} is under a dot-folder or an ignored folder, which is not part of the Collection.`)
  return input
}
