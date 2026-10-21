import { lstatSync } from 'node:fs'
import { posix } from 'node:path'
import { pathLinkTargetsFor, scanMarkdownCodeRanges } from './rename-repair'
import {
  buildWikilinkCandidateIndex,
  collectionCandidates,
  extractWikilinks,
  isPathLink,
  resolveWikilinkPath,
  type Candidate,
  type CandidateIndex,
} from './wikilinks'
import { SavedButNotReadBack, type Workspace } from './workspace'

/**
 * Folder rename repair (Sol round 4): a `./` path link (`[[./contents/a]]`) names a file by where it is, so renaming a
 * folder on its way leaves the link naming nothing. A title or file-name link never changes meaning when a folder is
 * renamed (titles and file names do not move), so path links are the only references this repairs.
 *
 * Only a note outside the renamed folder can lose such a link: a `./` link never climbs, so a link from inside the
 * folder names a file inside it and moves with it unchanged. Each repaired link is rewritten as the path to the file's
 * new place, kept in its form (with or without an extension), and only when that path names exactly that file after
 * the rename. Each write stands on its own (every rewrite is right on its own after the rename), so a write refused
 * because the note changed meanwhile leaves the others in place and is reported, never retried over the change.
 */
export type FolderRenameRepairPlan = {
  fromFolder: string
  toFolder: string
  /** `destinations`: the moved files the rewritten links name, each checked to be there just before the write. */
  writes: Array<{ path: string; current: string; content: string; destinations: string[] }>
  plannedReferences: string[]
  unrepairedReferences: string[]
}

export type FolderRenameRepairResult = { writtenPaths: string[]; unrepairedReferences: string[] }

function under(folder: string, path: string): boolean {
  return folder === '' || path.startsWith(`${folder}/`)
}

function movedPath(fromFolder: string, toFolder: string, path: string): string {
  return under(fromFolder, path) ? `${toFolder}${path.slice(fromFolder.length)}` : path
}

function rewrittenRaw(raw: string, replacement: string): string {
  const separator = raw.indexOf('|')
  const target = separator < 0 ? raw : raw.slice(0, separator)
  const label = separator < 0 ? '' : raw.slice(separator)
  const leading = /^\s*/.exec(target)?.[0] ?? ''
  const trailing = /\s*$/.exec(target)?.[0] ?? ''
  const core = target.slice(leading.length, target.length - trailing.length)
  const anchorAt = core.indexOf('#')
  const anchor = anchorAt < 0 ? '' : core.slice(anchorAt)
  return `${leading}${replacement}${anchor}${trailing}${label}`
}

/** Whether `written` (a whole `[[...]]`) reads, by the app's reader, as one link from `from` that names `file` alone. */
function writtenLinkNames(from: string, written: string, file: string, index: CandidateIndex): boolean {
  const parsed = extractWikilinks(written)
  return parsed.length === 1 && parsed[0].from === 0 && parsed[0].to === written.length && isPathLink(parsed[0].target)
    && resolveWikilinkPath(from, parsed[0].target, index) === file
}

function isFileAt(workspace: Workspace, path: string): boolean {
  try {
    return lstatSync(workspace.absolute(path)).isFile()
  } catch {
    return false
  }
}

/** Every path-link write a folder rename from `fromFolder` to `toFolder` needs, read before the rename. */
export async function planFolderRenameRepair(workspace: Workspace, fromFolder: string, toFolder: string): Promise<FolderRenameRepairPlan> {
  const plan: FolderRenameRepairPlan = { fromFolder, toFolder, writes: [], plannedReferences: [], unrepairedReferences: [] }
  if (fromFolder === '' || fromFolder === toFolder) return plan
  const before = await collectionCandidates(workspace, '')
  const after: Candidate[] = before.map((candidate) => ({ ...candidate, path: movedPath(fromFolder, toFolder, candidate.path) }))
  const beforeIndex = buildWikilinkCandidateIndex(before)
  const afterIndex = buildWikilinkCandidateIndex(after)
  for (const { path } of before) {
    if (under(fromFolder, path)) continue
    const source = (await workspace.readFile(path)).content
    const skipped = scanMarkdownCodeRanges(source)
    let next = source
    const repaired: string[] = []
    const destinations = new Set<string>()
    for (const link of [...extractWikilinks(source)].reverse()) {
      if (!isPathLink(link.target)) continue
      if (skipped.some((range) => link.from >= range.from && link.to <= range.to)) continue
      if (source.slice(link.from, link.to) !== link.raw) continue
      const was = resolveWikilinkPath(path, link.target, beforeIndex)
      if (!was || !under(fromFolder, was)) continue
      const now = movedPath(fromFolder, toFolder, was)
      if (resolveWikilinkPath(path, link.target, afterIndex) === now) continue
      const inner = source.slice(link.from + 2, link.to - 2)
      // Written only when the link as written parses, by the app's own reader, to exactly the moved file: a folder
      // name holding `#`, `|` or `]` would otherwise turn into an anchor, a label or a broken link (Sol round 5).
      const chosen = pathLinkTargetsFor(path, now, link.target)
        .map((option) => `[[${rewrittenRaw(inner, option)}]]`)
        .find((written) => writtenLinkNames(path, written, now, afterIndex))
      if (!chosen) {
        plan.unrepairedReferences.push(`${path}: ${link.raw} cannot be repaired because no path link from ${posix.dirname(path) === '.' ? 'the workspace root' : posix.dirname(path)} names ${now} alone`)
        continue
      }
      next = `${next.slice(0, link.from)}${chosen}${next.slice(link.to)}`
      destinations.add(now)
      repaired.unshift(`${path}: ${link.raw}`)
    }
    if (next !== source) {
      plan.writes.push({ path, current: source, content: next, destinations: [...destinations].sort() })
      plan.plannedReferences.push(...repaired)
    }
  }
  return plan
}

/**
 * Write the planned repairs after the rename. Each write replaces only the text the plan read (`saveFileOverRead`):
 * a note changed since is left as it is and its references reported as unrepaired.
 */
export async function applyFolderRenameRepair(
  plan: FolderRenameRepairPlan,
  workspace: Workspace,
  beforeWrite: (path: string) => Promise<void> = async () => undefined,
): Promise<FolderRenameRepairResult> {
  const writtenPaths: string[] = []
  const unrepairedReferences = [...plan.unrepairedReferences]
  for (const write of plan.writes) {
    try {
      await beforeWrite(write.path)
      // Checked after the last await before the write: a link is never rewritten to a file that moved on since the
      // plan (Sol round 5; the caller also holds the write turn across rename and repair).
      const gone = write.destinations.find((destination) => !isFileAt(workspace, destination))
      if (gone) throw new Error(`${gone} is no longer there`)
      try {
        await workspace.saveFileOverRead(write.path, write.content, write.current)
      } catch (error) {
        if (!(error instanceof SavedButNotReadBack)) throw error // written; only the read-back failed
      }
      writtenPaths.push(write.path)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      unrepairedReferences.push(
        ...plan.plannedReferences
          .filter((reference) => reference.startsWith(`${write.path}: `))
          .map((reference) => `${reference} was not repaired: ${reason}`),
      )
    }
  }
  return { writtenPaths, unrepairedReferences }
}
