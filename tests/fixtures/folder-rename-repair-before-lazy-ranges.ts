// Frozen planning path from fa557015 (PR #290 merge) for the differential test.
import { mappedLocator, movedDocumentLinks } from '../../src/main/moved-document-links'
import { posix } from 'node:path'
import { pathLinkTargetsFor, scanMarkdownCodeRanges } from '../../src/main/rename-repair'
import {
  buildWikilinkCandidateIndex,
  collectionCandidates,
  extractWikilinks,
  isPathLink,
  resolveWikilinkPath,
  type Candidate,
  type CandidateIndex,
} from '../../src/main/wikilinks'
import type { Workspace } from '../../src/main/workspace'
import type { FolderRenameRepairPlan } from '../../src/main/folder-rename-repair'

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

/** Every path-link write a folder rename from `fromFolder` to `toFolder` needs, read before the rename. */
export async function planFolderRenameRepairBeforeLazyRanges(workspace: Workspace, fromFolder: string, toFolder: string): Promise<FolderRenameRepairPlan> {
  const plan: FolderRenameRepairPlan = { fromFolder, toFolder, writes: [], plannedReferences: [], unrepairedReferences: [] }
  if (fromFolder === '' || fromFolder === toFolder) return plan
  const before = await collectionCandidates(workspace, '')
  const after: Candidate[] = before.map((candidate) => ({ ...candidate, path: movedPath(fromFolder, toFolder, candidate.path) }))
  const beforeIndex = buildWikilinkCandidateIndex(before)
  const afterIndex = buildWikilinkCandidateIndex(after)
  for (const { path } of before) {
    const source = (await workspace.readFile(path)).content
    if (under(fromFolder, path)) {
      const destination = movedPath(fromFolder, toFolder, path)
      const outgoing = await movedDocumentLinks(workspace, source, path, destination,
        mappedLocator(workspace, (target) => movedPath(fromFolder, toFolder, target)))
      plan.unrepairedReferences.push(...outgoing.unrepairedReferences)
      if (outgoing.content !== source) {
        plan.writes.push({ path: destination, current: source, content: outgoing.content, destinations: outgoing.destinations })
        plan.plannedReferences.push(...outgoing.references)
      }
      continue
    }
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
