import { declaresSectionPage, sectionMembership } from '../shared/folio-sections'
import { countAttachedEvidence, readEvidence } from './folio-evidence'
import { folioFiles } from './folio-files'
import { evidencePartKey } from '../shared/folio-evidence'
/**
 * The agent's two read-only views of a report folder (ticket 08; design
 * docs/design/2026-08-10-agent-and-multi-part-works/2026-09-27-verbs-and-report-skill-draft.md):
 *
 * - `readPlanForAgent` — the running order as readPlan parses it, each part weighed, plus the
 *   Markdown files under the Folio's content_root that are not in it (strays).
 * - `compareParts` — for two near-identical files (a sync conflict copy beside its original), the
 *   passages only one side has, in document order. A passage is a block by ADR-0039's rule.
 *
 * Neither writes anything. Paths are checked against the folder and the Workspace boundary before any
 * read, and every refusal is a readable sentence the agent can act on.
 */

import { existsSync, statSync } from 'node:fs'
import { posix } from 'node:path'
import { collectionCoverPaths, readManifest, pathUnderFolioRoot } from './folio'
import { readFolioPlan, readPlan } from './plan'
import { parseFrontmatter } from './frontmatter'
import { findFlags, type Flag } from '../shared/markdown/flags'
import { labelOfTags, priorityOfTags, readLabelVocabulary, type RoomLabel, type RoomPriority } from '../shared/folio-room'
import { collectionCandidates } from './wikilinks'
import { documentWordCount, passageWordCount } from './collection'
import { isPathInFolder, type Workspace } from './workspace'
import { AGENT_NOTE_DIR } from './agent-note-dir'
import { frontmatterBlock } from '../shared/markdown/frontmatter'
import { blockRangesOf } from '../shared/markdown/line-blocks'

export type AgentPlanPart = {
  /** A section opening, marked only in its file’s frontmatter. */
  sectionPage?: true
  /** Title of the owning section; omitted before the first section and for front matter/openings. */
  section?: string
  title: string
  gloss: string | null
  role: string
  /** Workspace-relative file, or null for an unwritten part (a plan line whose link points at nothing). */
  path: string | null
  /** Body words (frontmatter excluded, the Digest's rule); null for an unwritten part. */
  words: number | null
  exists: boolean
  synopsis: string | null
  label: RoomLabel | null
  priority: RoomPriority | null
  status: string
  /** Evidence rows the room shows for this part; null when the Folio's evidence file cannot be read. */
  evidenceCount: number | null
  openFlags: Flag[]
}

export type AgentPlanStray = { path: string; title: string; words: number }

export type AgentPlanReadout = {
  dir: string
  hasIndexNote: boolean
  /** The canonical Index Note path when it exists, else null. */
  indexPath: string | null
  /** The Folio manifest's content_root ('' when the parts sit in the folder or there is no manifest). */
  contentRoot: string
  parts: AgentPlanPart[]
  strays: AgentPlanStray[]
  /** Present only when the Folio's evidence-and-notes file exists but cannot be read; a plain sentence. */
  evidenceProblem?: string
}

export type ComparedSide = 'a' | 'b'
export type ComparedPassage = {
  side: ComparedSide
  /** The passage exactly as it stands in its file. */
  text: string
  /** 1-based line in its own file where the passage starts. */
  line: number
  words: number
}
export type ComparedFile = { path: string; words: number; modifiedAt: number }
export type PartComparison = {
  dir: string
  a: ComparedFile
  b: ComparedFile
  /** 2 × words in shared passages ÷ (words in a + words in b), two decimals; 1 when both are empty. */
  similarity: number
  larger: ComparedSide | 'equal'
  identical: boolean
  frontmatterDiffers: boolean
  /** Passages only one side has, in document order; within a gap between shared passages, a's first. */
  passages: ComparedPassage[]
}

/** App-owned folders whose Markdown is never a report part (Journey 4; Scraps and Sources by definition). */
const NEVER_PARTS = new Set([AGENT_NOTE_DIR, 'scraps', 'research'])

function inDir(dir: string, sub: string): string {
  return dir === '' ? sub : sub === '' ? dir : posix.join(dir, sub)
}

/** The readable-refusal form of the Workspace guard: a normalised workspace-relative path, or a throw. */
function workspacePath(ws: Workspace, path: unknown, field: string): string {
  if (typeof path !== 'string') throw new Error(`${field} must be a Workspace-relative path.`)
  if (path === '' || path === '.') return ''
  if (posix.isAbsolute(path)) throw new Error(`${field} "${path}" is an absolute path; give it relative to the Workspace root.`)
  const normalised = posix.normalize(path).replace(/\/+$/, '')
  try {
    ws.absolute(normalised)
  } catch {
    throw new Error(`${field} "${path}" is outside the open Workspace.`)
  }
  return normalised === '.' ? '' : normalised
}

/** Validate a report folder: inside the Workspace, and an existing folder. */
export function agentPlanDir(ws: Workspace, dir: unknown): string {
  const normalised = workspacePath(ws, dir, 'dir')
  const absolute = normalised === '' ? ws.root : ws.absolute(normalised)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`dir "${normalised}" is not a folder in the open Workspace.`)
  }
  return normalised
}

/** Validate a file named relative to the Workspace: inside the Workspace AND inside `dir`. */
export function agentPlanFile(ws: Workspace, dir: string, path: unknown, field: string): string {
  const normalised = workspacePath(ws, path, field)
  if (normalised === '' || !isPathInFolder(normalised, dir) || normalised === dir) {
    throw new Error(`${field} "${String(path)}" is not inside ${dir === '' ? 'the Workspace' : `the folder "${dir}"`}; give a Workspace-relative path to a file in that folder.`)
  }
  return normalised
}

function neverAPart(path: string, root: string): boolean {
  if (posix.basename(path).startsWith('_')) return true
  const inside = root === '' ? path : path.slice(root.length + 1)
  return inside.split('/').slice(0, -1).some((segment) => NEVER_PARTS.has(segment.toLocaleLowerCase()))
}

/** `options.summary` (the per-turn assistant summary) counts attached evidence from the evidence file alone and skips the strays; plan.read never sets it. */
export async function readPlanForAgent(ws: Workspace, dirInput: unknown, options: { summary?: boolean; manifestOrder?: boolean } = {}): Promise<AgentPlanReadout> {
  const dir = agentPlanDir(ws, dirInput)
  // The command line follows the room's manifest order; proposal callers keep their Index Note basis.
  const plan = options.manifestOrder ? await readFolioPlan(ws, dir) : await readPlan(ws, dir)
  const source = plan && !plan.indexNoteAbsent ? await ws.readFile(plan.indexPath).then(read => read.content, () => null) : null
  const labels = readLabelVocabulary(source).labels
  const manifest = await readManifest(ws, dir)
  const contentRoot = manifest?.contentRoot ?? ''
  const root = inDir(dir, contentRoot)

  const parts: AgentPlanPart[] = []
  const contents = new Map<string,string>()
  for (const part of plan?.parts ?? []) {
    let words: number | null = null
    let exists = false
    let status = 'idea'
    let openFlags: Flag[] = []
    if (part.path) {
      try {
        const content = (await ws.readFile(part.path)).content
        contents.set(part.path,content)
        words = documentWordCount(content)
        status = parseFrontmatter(content)?.status?.trim() || 'Unsorted'
        openFlags = findFlags(content)
        exists = true
      } catch {
        // Resolved at parse time but gone since: report it as missing rather than failing the read.
      }
    }
    parts.push({ title: part.title, gloss: part.gloss, role: part.role, path: part.path, words, exists, synopsis: part.gloss, label: labelOfTags(part.tags, labels), priority: priorityOfTags(part.tags), status, openFlags, evidenceCount:0 })
  }

  const membership = sectionMembership(parts.map(part => ({ sectionPage: part.path ? declaresSectionPage(contents.get(part.path) ?? '') : false, frontMatter: part.role === 'front-matter' })))
  parts.forEach((part, index) => {
    if (part.path && part.role !== 'front-matter' && declaresSectionPage(contents.get(part.path) ?? '')) part.sectionPage = true
    const owner = membership[index]
    if (owner !== null) part.section = parts[owner].title
  })

  let evidenceProblem: string | undefined
  if (plan && options.summary) {
    // The per-turn summary counts what the evidence file lists; it never touches the sources themselves.
    const evidence = await countAttachedEvidence(ws, dir, parts.map(part => part.title))
    if (evidence.state === 'unreadable') evidenceProblem = evidence.message
    for (const part of parts) part.evidenceCount = evidence.state === 'unreadable' ? null : evidence.counts[evidencePartKey(part.title)] ?? 0
  } else if (plan) {
    const evidence = await readEvidence(ws, dir, parts.map(part => ({ title: part.title, path: part.path, content: part.path ? contents.get(part.path) : undefined })), await folioFiles(ws, dir))
    if (evidence.state === 'unreadable') evidenceProblem = evidence.message
    for (const part of parts) part.evidenceCount = evidence.state === 'unreadable' ? null : evidence.parts[evidencePartKey(part.title)]?.rows.length ?? 0
  }

  const inOrder = new Set(parts.flatMap((part) => (part.path ? [part.path] : [])))
  const covers = new Set([...collectionCoverPaths(ws, dir), ...collectionCoverPaths(ws, root)])
  const strays: AgentPlanStray[] = []
  const candidates = options.summary ? [] : await collectionCandidates(ws, root)
  const discovered = new Set(candidates.map(candidate => candidate.path))
  const knownStrays = options.summary ? [] : (plan?.unlisted ?? []).flatMap(part => part.path && !discovered.has(part.path) ? [{ path: part.path, title: part.title }] : [])
  for (const candidate of [...candidates, ...knownStrays]) {
    const candidateRoot = pathUnderFolioRoot(root, candidate.path) ? root : dir
    if (inOrder.has(candidate.path) || covers.has(candidate.path) || neverAPart(candidate.path, candidateRoot)) continue
    strays.push({
      path: candidate.path,
      title: candidate.title,
      words: documentWordCount((await ws.readFile(candidate.path)).content),
    })
  }
  strays.sort((left, right) => left.path.localeCompare(right.path))

  return { dir, hasIndexNote: plan !== null && !plan.indexNoteAbsent, indexPath: plan?.indexNoteAbsent ? null : plan?.indexPath ?? null, contentRoot, parts, strays, ...(evidenceProblem ? { evidenceProblem } : {}) }
}

type Block = { text: string; key: string; line: number; words: number }

function bodyBlocks(content: string): { frontmatter: string; blocks: Block[] } {
  const fm = frontmatterBlock(content)
  const bodyStart = fm ? fm.end : content.startsWith('﻿') ? 1 : 0
  const body = content.slice(bodyStart)
  const lineOffset = content.slice(0, bodyStart).split('\n').length - 1
  const blocks = blockRangesOf(body).map((range) => {
    const text = body.slice(range.from, range.to).replace(/\r$/, '')
    return {
      text,
      key: text.replace(/\r/g, '').replace(/[ \t]+$/gm, ''),
      line: lineOffset + body.slice(0, range.from).split('\n').length,
      words: passageWordCount(text),
    }
  })
  return { frontmatter: content.slice(0, bodyStart).replace(/\r/g, '').trim(), blocks }
}

/** Longest common subsequence alignment of two block lists: the matched index pairs, in order. */
function alignBlocks(left: Block[], right: Block[]): Array<[number, number]> {
  let start = 0
  while (start < left.length && start < right.length && left[start].key === right[start].key) start += 1
  let endLeft = left.length
  let endRight = right.length
  while (endLeft > start && endRight > start && left[endLeft - 1].key === right[endRight - 1].key) {
    endLeft -= 1
    endRight -= 1
  }
  const pairs: Array<[number, number]> = []
  for (let index = 0; index < start; index += 1) pairs.push([index, index])

  const rows = endLeft - start
  const cols = endRight - start
  const width = cols + 1
  const table = new Uint32Array((rows + 1) * width)
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i * width + j] = left[start + i].key === right[start + j].key
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (left[start + i].key === right[start + j].key) {
      pairs.push([start + i, start + j])
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i += 1
    else j += 1
  }

  for (let offset = 0; offset < left.length - endLeft; offset += 1) pairs.push([endLeft + offset, endRight + offset])
  return pairs
}

export async function compareParts(ws: Workspace, dirInput: unknown, aInput: unknown, bInput: unknown): Promise<PartComparison> {
  const dir = agentPlanDir(ws, dirInput)
  const aPath = agentPlanFile(ws, dir, aInput, 'a')
  const bPath = agentPlanFile(ws, dir, bInput, 'b')
  if (aPath === bPath) throw new Error(`a and b are the same file (${aPath}); name two different files to compare.`)
  const readSide = async (path: string, field: string) => {
    try {
      return await ws.readFile(path)
    } catch {
      throw new Error(`${field} "${path}" does not exist in the open Workspace.`)
    }
  }
  const aFile = await readSide(aPath, 'a')
  const bFile = await readSide(bPath, 'b')
  const a = bodyBlocks(aFile.content)
  const b = bodyBlocks(bFile.content)

  const passages: ComparedPassage[] = []
  const emit = (side: ComparedSide, block: Block) => passages.push({ side, text: block.text, line: block.line, words: block.words })
  let nextA = 0
  let nextB = 0
  let sharedWords = 0
  for (const [matchA, matchB] of [...alignBlocks(a.blocks, b.blocks), [a.blocks.length, b.blocks.length] as [number, number]]) {
    for (; nextA < matchA; nextA += 1) emit('a', a.blocks[nextA])
    for (; nextB < matchB; nextB += 1) emit('b', b.blocks[nextB])
    if (matchA < a.blocks.length) sharedWords += a.blocks[matchA].words
    nextA = matchA + 1
    nextB = matchB + 1
  }

  const aWords = a.blocks.reduce((sum, block) => sum + block.words, 0)
  const bWords = b.blocks.reduce((sum, block) => sum + block.words, 0)
  const similarity = aWords + bWords === 0 ? 1 : Math.round((200 * sharedWords) / (aWords + bWords)) / 100
  const frontmatterDiffers = a.frontmatter !== b.frontmatter
  return {
    dir,
    a: { path: aFile.file.path, words: documentWordCount(aFile.content), modifiedAt: aFile.file.modifiedAt },
    b: { path: bFile.file.path, words: documentWordCount(bFile.content), modifiedAt: bFile.file.modifiedAt },
    similarity,
    larger: aWords === bWords ? 'equal' : aWords > bWords ? 'a' : 'b',
    identical: passages.length === 0 && !frontmatterDiffers,
    frontmatterDiffers,
    passages,
  }
}
