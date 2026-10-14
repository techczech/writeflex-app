import { stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { indexNotePath, MANIFEST_NAME, readManifest, resolveManifestFilePath, type Folio } from './folio'
import { jsonArrayLayout, rewriteJsonObjectStringProperty } from './json-array-layout'
import { parseMarkdown } from '../shared/markdown/dialect'
import { readPlan } from './plan'
import type { FileReadResult, MarkdownFile, Workspace } from './workspace'
import { Workspace as WorkspaceAdapter } from './workspace'
import type { RenameRepairDisplayIssue } from '../shared/rename-repair-message'
import { applyPlannedRenameRepair, failedPlannedRenameRepairResult } from './rename-repair-apply'
import {
  buildWikilinkCandidateIndex,
  collectionCandidates,
  extractWikilinks,
  resolveWikilinkTargetFromIndex,
} from './wikilinks'

export type RenameRepairResult = {
  writtenPaths: string[]
  unrepairedReferences: string[]
  issues: RenameRepairIssue[]
}

export type RenameRepairIssue = RenameRepairDisplayIssue

export type RenameRepairOptions = {
  beforeMarkdownWrite?: (path: string) => Promise<void>
  beforeManifestWrite?: (path: string) => Promise<void>
}

export type RenameRepairPlannedWrite = {
  path: string
  content: string
  kind: 'markdown' | 'manifest'
}

type PreparedWrite = RenameRepairPlannedWrite & { current: string }

type ExpectedFile = { path: string; content: string }
type ExpectedOptionalFile = { path: string; content: string | null }

export type RenameRepairPlan = {
  fromPath: string
  toPath: string
  writes: RenameRepairPlannedWrite[]
  manifestChanges: Array<{ path: string; content: string }>
  unrepairedReferences: string[]
  /** References unrelated to the renamed file whose meaning the structural rename would change. */
  bystanderReferences: string[]
  plannedReferences: string[]
  /** Required authored Plan lines deliberately kept unchanged by rule 6. */
  preservedReferences: string[]
  /** User-visible consequences of the rename, keyed to the file whose state makes them true. */
  plannedOutcomes: Array<{ path: string; text: string; kind?: 'available' }>
  /** Inputs apply must find after the rename. These make a stale prediction a refusal, never a write. */
  verification: {
    workspacePaths: string[]
    markdown: ExpectedFile[]
    manifests: ExpectedOptionalFile[]
    renamedContent: string
  }
}

export type MarkdownCodeRange = { from: number; to: number }
type CachedMarkdown = { file: MarkdownFile; content: string }

function planVerification(
  afterFiles: CachedMarkdown[],
  manifestInputs: ExpectedOptionalFile[],
  writes: RenameRepairPlannedWrite[],
  plannedOutcomes: Array<{ path: string; text: string }>,
  renamedContent: string,
): RenameRepairPlan['verification'] {
  const consultedPaths = new Set([
    ...writes.map(({ path }) => path),
    ...plannedOutcomes.map(({ path }) => path),
  ])
  return {
    workspacePaths: afterFiles.map(({ file }) => file.path),
    markdown: afterFiles
      .filter(({ file }) => consultedPaths.has(file.path))
      .map(({ file, content }) => ({ path: file.path, content })),
    manifests: manifestInputs.filter(({ path }) => consultedPaths.has(path)),
    renamedContent,
  }
}

function withoutMarkdownExtension(path: string): string {
  return path.replace(/\.(?:md|markdown|mdx)$/i, '')
}

function pathInside(base: string, path: string): string | null {
  const relative = base ? posix.relative(base, path) : path
  if (!relative || posix.isAbsolute(relative) || relative === '..' || relative.startsWith('../')) return null
  return relative
}

function excludedPlanDestination(workspacePath: string): boolean {
  const segments = workspacePath.split('/')
  return posix.basename(workspacePath).startsWith('_') || segments.some((segment) => segment.toLocaleLowerCase() === 'agent-notes')
}

function replaceJsonObjectPath(raw: string, path: string): string {
  return rewriteJsonObjectStringProperty(raw, 'path', path)
}

function rewriteManifestFilesWithOpaqueEntries(
  source: string,
  original: unknown[],
  rewritten: Array<unknown | null>,
): string {
  const layout = jsonArrayLayout(source, 'files')
  if (layout.entries.length !== original.length || rewritten.length !== original.length) {
    throw new Error('Cannot surgically update a manifest whose parsed entries do not match its source layout.')
  }
  const retained = layout.entries.flatMap((range, index) => {
    const next = rewritten[index]
    if (next === null) return []
    const raw = source.slice(range.start, range.end)
    const before = original[index]
    if (next === before) return [raw]
    if (typeof next !== 'object' || next === null || typeof (next as Record<string, unknown>).path !== 'string') {
      throw new Error('Cannot surgically rewrite an opaque manifest entry.')
    }
    return [replaceJsonObjectPath(raw, (next as Record<string, unknown>).path as string)]
  })
  if (!layout.entries.length) return source
  const leading = source.slice(layout.start + 1, layout.entries[0].start)
  const trailing = source.slice(layout.entries.at(-1)!.end, layout.end)
  const separator = layout.entries.length > 1
    ? source.slice(layout.entries[0].end, layout.entries[1].start)
    : source.includes('\n') || source.includes('\r') ? `,\n` : ','
  const inner = retained.length ? `${leading}${retained.join(separator)}${trailing}` : ''
  return `${source.slice(0, layout.start + 1)}${inner}${source.slice(layout.end)}`
}

function authoredManifestDestinationPaths(
  dir: string,
  manifest: Folio,
  authoredSourcePath: string,
  fromPath: string,
  toPath: string,
): string[] {
  const reportRelative = posix.relative(dir, toPath)
  const contentBase = manifest.contentRoot ? posix.join(dir, manifest.contentRoot) : dir
  const contentRelative = posix.relative(contentBase, toPath)
  if (contentRelative === reportRelative) return [reportRelative]
  const authoredAsReportRelative = posix.normalize(posix.join(dir, authoredSourcePath))
  const authoredAsContentRelative = posix.normalize(posix.join(contentBase, authoredSourcePath))
  const sourceUsesContentConvention = authoredAsContentRelative === fromPath
    && authoredAsReportRelative !== fromPath
  return sourceUsesContentConvention
    ? [contentRelative, reportRelative]
    : [reportRelative, contentRelative]
}

function manifestEntryLabel(entry: Record<string, unknown>): string {
  if (typeof entry.title === 'string' && entry.title.trim()) return entry.title.trim()
  return posix.basename(entry.path as string)
}

type ManifestEntry = Record<string, unknown> & { path: string }
type ManifestCandidate =
  | { index: number; entry: ManifestEntry; proposal: string[] }
  | { index: number; entry: ManifestEntry; removal: true; reason: string }

type ManifestGateContext = {
  path: string
  dir: string
  manifest: Folio
  originalEntries: unknown[]
  toPath: string
  issues: string[]
  plannedReferences: string[]
  plannedOutcomes: Array<{ path: string; text: string }>
  presentAfterRename: ReadonlySet<string>
}

function gateManifestCandidate(candidate: ManifestCandidate, context: ManifestGateContext): ManifestEntry | null {
  const { path, dir, manifest, originalEntries, toPath, issues, plannedReferences, plannedOutcomes, presentAfterRename } = context
  const plannedReference = `${path}: ${candidate.entry.path}`

  if ('removal' in candidate) {
    const outcome = `${plannedReference} was removed because ${candidate.reason}.`
    plannedReferences.push(outcome)
    plannedOutcomes.push({ path, text: outcome })
    return null
  }

  const claimedIndex = originalEntries.findIndex((entry, index) => (
    index !== candidate.index
    && typeof entry === 'object'
    && entry !== null
    && typeof (entry as Record<string, unknown>).path === 'string'
    && (
      candidate.proposal.includes((entry as Record<string, unknown>).path as string)
      || resolveManifestFilePath(
        dir,
        manifest,
        { path: (entry as Record<string, unknown>).path as string },
        presentAfterRename,
      ) === toPath
    )
  ))

  let rewritten = candidate.entry
  if (claimedIndex >= 0) {
    const claimed = originalEntries[claimedIndex] as ManifestEntry
    issues.push(
      `${path}: ${manifestEntryLabel(candidate.entry)} cannot be repaired because the renamed file ${toPath} `
      + `is already claimed by ${manifestEntryLabel(claimed)}.`,
    )
    return rewritten
  }

  const verifiedCandidates = candidate.proposal.filter((authored) => (
    resolveManifestFilePath(dir, manifest, { path: authored }, presentAfterRename) === toPath
  ))
  const verified = verifiedCandidates.find((authored) => pathInside('', authored) !== null)
    ?? verifiedCandidates[0]
  if (verified) rewritten = { ...candidate.entry, path: verified }
  const resolvedOutcome = resolveManifestFilePath(dir, manifest, rewritten, presentAfterRename)
  if (resolvedOutcome !== toPath) {
    issues.push(
      `${path}: ${manifestEntryLabel(candidate.entry)} now resolves to ${resolvedOutcome ?? 'no file'} `
      + `instead of the renamed file ${toPath}.`,
    )
    return rewritten
  }
  plannedReferences.push(plannedReference)
  return rewritten
}

/** CommonMark code ranges, including container-aware blocks and paragraph-bounded inline spans. */
export function scanMarkdownCodeRanges(source: string): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = []
  const cursor = parseMarkdown(source).cursor()
  const visit = (): void => {
    if (cursor.name === 'CodeBlock' || cursor.name === 'FencedCode' || cursor.name === 'InlineCode') {
      ranges.push({ from: cursor.from, to: cursor.to })
      return
    }
    if (!cursor.firstChild()) return
    do visit()
    while (cursor.nextSibling())
    cursor.parent()
  }
  visit()
  return ranges
}

function isInsideRange(from: number, to: number, ranges: MarkdownCodeRange[]): boolean {
  return ranges.some((range) => from >= range.from && to <= range.to)
}

async function workspacePathExists(workspace: Workspace, path: string): Promise<boolean> {
  try {
    await stat(workspace.absolute(path))
    return true
  } catch {
    return false
  }
}

class CachedWorkspace extends WorkspaceAdapter {
  private readonly byPath: Map<string, CachedMarkdown>

  constructor(
    private readonly source: Workspace,
    private readonly files: CachedMarkdown[],
    private readonly readThrough: (path: string) => Promise<FileReadResult>,
  ) {
    super(source.root)
    this.byPath = new Map(files.map((file) => [file.file.path, file]))
  }

  override absolute(path: string): string {
    return this.source.absolute(path)
  }

  override async listFiles(): Promise<MarkdownFile[]> {
    return this.files.map(({ file }) => file)
  }

  override async readFile(path: string): Promise<FileReadResult> {
    const result = this.byPath.get(path)
    return result ?? this.readThrough(path)
  }
}

function cachedWorkspace(
  workspace: Workspace,
  files: CachedMarkdown[],
  readThrough: (path: string) => Promise<FileReadResult>,
): Workspace {
  return new CachedWorkspace(workspace, files, readThrough)
}

function cachedReads(workspace: Workspace): (path: string) => Promise<FileReadResult> {
  const reads = new Map<string, Promise<FileReadResult>>()
  return (path) => {
    const existing = reads.get(path)
    if (existing) return existing
    const pending = workspace.readFile(path)
    reads.set(path, pending)
    return pending
  }
}

type PlanTitleLink = { from: number; to: number; path: string | null }
type PlanLineResolutions = Map<string, Map<number, PlanTitleLink>>

function lineAtOffset(source: string, offset: number): number {
  return (source.slice(0, offset).match(/\r\n|\n|\r/g) ?? []).length
}

async function planLineResolutions(
  workspace: Workspace,
  files: CachedMarkdown[],
  readThrough: (path: string) => Promise<FileReadResult>,
): Promise<PlanLineResolutions> {
  const view = cachedWorkspace(workspace, files, readThrough)
  const resolutions: PlanLineResolutions = new Map()
  for (const { file, content: source } of files) {
    const dir = file.directory
    if (file.path !== indexNotePath(view, dir)) continue
    const plan = await readPlan(view, dir)
    if (!plan) continue
    const links = extractWikilinks(source)
    const firstLinkByLine = new Map<number, ReturnType<typeof extractWikilinks>[number]>()
    for (const link of links) {
      const line = lineAtOffset(source, link.from)
      if (!firstLinkByLine.has(line)) firstLinkByLine.set(line, link)
    }
    resolutions.set(file.path, new Map(plan.parts.flatMap((part) => {
      const titleLink = firstLinkByLine.get(part.line)
      return titleLink ? [[part.line, { from: titleLink.from, to: titleLink.to, path: part.path }]] : []
    })))
  }
  return resolutions
}

type ReferenceResolution = {
  resolve(filePath: string, source: string, link: ReturnType<typeof extractWikilinks>[number]): string | null
  isPlanTitleLink(filePath: string, source: string, link: ReturnType<typeof extractWikilinks>[number]): boolean
}

function referenceResolution(
  planLines: PlanLineResolutions,
  candidateIndex: ReturnType<typeof buildWikilinkCandidateIndex>,
): ReferenceResolution {
  const planResolution = (
    filePath: string,
    source: string,
    link: ReturnType<typeof extractWikilinks>[number],
  ): { found: boolean; path: string | null } => {
    const line = planLines.get(filePath)
    const lineNumber = lineAtOffset(source, link.from)
    const titleLink = line?.get(lineNumber)
    return titleLink?.from === link.from && titleLink.to === link.to
      ? { found: true, path: titleLink.path }
      : { found: false, path: null }
  }
  return {
    resolve: (filePath, source, link) => {
      const scoped = planResolution(filePath, source, link)
      const workspacePath = resolveWikilinkTargetFromIndex(filePath, link.target, candidateIndex).to
      return scoped.found
        ? scoped.path ?? workspacePath
        : workspacePath
    },
    isPlanTitleLink: (filePath, source, link) => planResolution(filePath, source, link).found,
  }
}

function readsWithPlannedWrites(
  readThrough: (path: string) => Promise<FileReadResult>,
  writes: RenameRepairPlannedWrite[],
): (path: string) => Promise<FileReadResult> {
  const byPath = new Map(writes.map((write) => [write.path, write.content]))
  return async (path) => {
    const result = await readThrough(path)
    const content = byPath.get(path)
    return content === undefined ? result : { ...result, content }
  }
}

async function rewrittenPlanResolution(
  workspace: Workspace,
  files: CachedMarkdown[],
  filePath: string,
  source: string,
  link: ReturnType<typeof extractWikilinks>[number],
  replacement: string,
  readThrough: (path: string) => Promise<FileReadResult>,
  candidateIndex: ReturnType<typeof buildWikilinkCandidateIndex>,
  plannedManifestWrites: RenameRepairPlannedWrite[],
): Promise<string | null> {
  const raw = source.slice(link.from + 2, link.to - 2)
  const rewritten = rewrittenTarget(raw, replacement)
  const nextSource = `${source.slice(0, link.from)}[[${rewritten}]]${source.slice(link.to)}`
  const nextFiles = files.map((file) => file.file.path === filePath ? { ...file, content: nextSource } : file)
  const nextLink = extractWikilinks(nextSource).find((candidate) => candidate.from === link.from)
  if (!nextLink) return null
  const resolutions = await planLineResolutions(
    workspace,
    nextFiles,
    readsWithPlannedWrites(readThrough, plannedManifestWrites),
  )
  return referenceResolution(resolutions, candidateIndex).resolve(filePath, nextSource, nextLink)
}

type PrepareManifestWritesOptions = {
  workspace: Workspace
  readThrough: (path: string) => Promise<FileReadResult>
  folders: string[]
  fromPath: string
  toPath: string
  issues: string[]
  bystanderReferences: string[]
  plannedReferences: string[]
  plannedOutcomes: Array<{ path: string; text: string }>
  manifestInputs: ExpectedOptionalFile[]
  presentBeforeRename: ReadonlySet<string>
  presentAfterRename: ReadonlySet<string>
}

async function prepareManifestWrites({
  workspace,
  readThrough,
  folders,
  fromPath,
  toPath,
  issues,
  bystanderReferences,
  plannedReferences,
  plannedOutcomes,
  manifestInputs,
  presentBeforeRename,
  presentAfterRename,
}: PrepareManifestWritesOptions): Promise<PreparedWrite[]> {
  const writes: PreparedWrite[] = []
  for (const dir of ['', ...folders]) {
    const path = dir ? `${dir}/${MANIFEST_NAME}` : MANIFEST_NAME
    if (!(await workspacePathExists(workspace, path))) {
      manifestInputs.push({ path, content: null })
      continue
    }
    const current = (await readThrough(path)).content
    manifestInputs.push({ path, content: current })
    const manifestWorkspace = { readFile: async (): Promise<FileReadResult> => ({ file: { path, name: MANIFEST_NAME, directory: dir, modifiedAt: 0, size: current.length }, content: current }) }
    const parsedManifest = await readManifest(manifestWorkspace, dir)
    if (!parsedManifest) {
      issues.push(`${path}: Cannot repair references in an unreadable Folio manifest.`)
      continue
    }
    const parsed = JSON.parse(current) as { files?: unknown }
    if (!Array.isArray(parsed.files)) continue
    const originalEntries = parsed.files
    for (const entry of originalEntries) {
      if (typeof entry !== 'object' || entry === null || typeof (entry as Record<string, unknown>).path !== 'string') continue
      const file = entry as ManifestEntry
      const before = resolveManifestFilePath(dir, parsedManifest, file, presentBeforeRename)
      const after = resolveManifestFilePath(dir, parsedManifest, file, presentAfterRename)
      if (before === fromPath || before === after) continue
      const title = manifestEntryLabel(file)
      const reference = title === file.path ? file.path : `${title} (${file.path})`
      const issue = `${path}: ${reference} changed meaning from ${before ?? 'no file'} to ${after ?? 'no file'} because of the rename.`
      issues.push(issue)
      bystanderReferences.push(issue)
    }
    const candidates = originalEntries.flatMap((entry, index): ManifestCandidate[] => {
      if (typeof entry !== 'object' || entry === null || typeof (entry as Record<string, unknown>).path !== 'string') return []
      const file = entry as ManifestEntry
      if (resolveManifestFilePath(dir, parsedManifest, file, presentBeforeRename) !== fromPath) return []
      const reportRelative = pathInside(dir, toPath)
      const sourceWasInReport = pathInside(dir, fromPath) !== null
      if (excludedPlanDestination(toPath)) {
        return [{ index, entry: file, removal: true, reason: `${toPath} is excluded from Folio parts` }]
      }
      if (!reportRelative && sourceWasInReport) {
        return [{ index, entry: file, removal: true, reason: `${toPath} left the report folder` }]
      }
      return [{
        index,
        entry: file,
        proposal: authoredManifestDestinationPaths(dir, parsedManifest, file.path, fromPath, toPath),
      }]
    })
    if (!candidates.length) continue
    const plannedReferenceStart = plannedReferences.length
    const plannedOutcomeStart = plannedOutcomes.length
    const gatedEntries = candidates.map((candidate) => gateManifestCandidate(candidate, {
      path,
      dir,
      manifest: parsedManifest,
      originalEntries,
      toPath,
      issues,
      plannedReferences,
      plannedOutcomes,
      presentAfterRename,
    }))
    const rewrittenEntries = [...originalEntries]
    candidates.forEach((candidate, index) => {
      rewrittenEntries[candidate.index] = gatedEntries[index]
    })
    let rewritten: string
    try {
      // Array position is the entry identity. A desired path is data, never a lookup key for source bytes.
      rewritten = rewriteManifestFilesWithOpaqueEntries(current, originalEntries, rewrittenEntries)
    } catch (error) {
      plannedReferences.splice(plannedReferenceStart)
      plannedOutcomes.splice(plannedOutcomeStart)
      const reason = error instanceof Error ? error.message : String(error)
      const references = originalEntries
        .filter((entry): entry is Record<string, unknown> => (
          typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).path === 'string'
          && resolveManifestFilePath(dir, parsedManifest, { path: (entry as Record<string, unknown>).path as string }, presentBeforeRename) === fromPath
        ))
        .map((entry) => `${path}: ${entry.path as string}`)
      issues.push(...references.map((reference) => `${reference} cannot be repaired because ${reason}`))
      continue
    }
    const next = preserveOriginalLineEndings(current, rewritten)
    if (next !== current) writes.push({ path, current, content: next, kind: 'manifest' })
  }
  return writes
}

function canonicalWorkspacePath(workspace: Workspace, path: string): string {
  return workspace.relative(workspace.absolute(path))
}

async function planLinesToPreserve(workspace: Workspace, folders: string[], fromPath: string, toPath: string): Promise<Map<string, string>> {
  const paths = new Map<string, string>()
  for (const dir of ['', ...folders]) {
    const indexPath = indexNotePath(workspace, dir)
    if (fromPath === indexPath || !(await workspacePathExists(workspace, indexPath))) continue
    const fromRelative = pathInside(dir, fromPath)
    if (!fromRelative) continue
    const toRelative = pathInside(dir, toPath)
    if (!toRelative) paths.set(indexPath, 'the renamed file left this report')
    else if (excludedPlanDestination(toPath)) paths.set(indexPath, 'the destination is excluded from this report')
  }
  return paths
}

function rewrittenTarget(raw: string, replacement: string): string {
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

function preserveOriginalLineEndings(source: string, rewritten: string): string {
  const sourceEndings = source.match(/\r\n|\n|\r/g) ?? []
  if (!sourceEndings.length) return rewritten
  let index = 0
  return rewritten.replace(/\r\n|\n|\r/g, () => sourceEndings[index++] ?? sourceEndings.at(-1)!)
}

function renamedView(file: CachedMarkdown, fromPath: string, toPath: string): CachedMarkdown {
  if (file.file.path !== fromPath) return file
  return {
    file: {
      ...file.file,
      path: toPath,
      name: posix.basename(toPath),
      directory: posix.dirname(toPath) === '.' ? '' : posix.dirname(toPath),
    },
    content: file.content,
  }
}

type MarkdownReferenceAnalysis = {
  file: MarkdownFile
  source: string
  links: ReturnType<typeof extractWikilinks>
  skipped: MarkdownCodeRange[]
}

function analyseMarkdownReferences(
  afterFiles: CachedMarkdown[],
  fromPath: string,
  toPath: string,
  beforeResolution: ReferenceResolution,
  afterResolution: ReferenceResolution,
): {
  files: MarkdownReferenceAnalysis[]
  bystanderReferences: string[]
  plannedOutcomes: Array<{ path: string; text: string; kind?: 'available' }>
} {
  const bystanderReferences: string[] = []
  const plannedOutcomes: Array<{ path: string; text: string; kind?: 'available' }> = []
  const namedOutcomes = new Set<string>()
  const files = afterFiles.map(({ file, content: source }): MarkdownReferenceAnalysis => {
    const skipped = scanMarkdownCodeRanges(source)
    const links = extractWikilinks(source)
    const beforeFrom = file.path === toPath ? fromPath : file.path
    for (const link of links) {
      if (isInsideRange(link.from, link.to, skipped)) continue
      const before = beforeResolution.resolve(beforeFrom, source, link)
      const after = afterResolution.resolve(file.path, source, link)
      if (before === fromPath || before === after) continue
      if (before === null && after !== null) {
        const availableAdoption = beforeResolution.isPlanTitleLink(beforeFrom, source, link)
          || afterResolution.isPlanTitleLink(file.path, source, link)
        const text = availableAdoption
          ? `${toPath} now matches planned part ${link.raw} in ${file.path}; you can adopt it when you want to.`
          : `This now fulfils ${link.raw} in ${file.path}.`
        if (!namedOutcomes.has(text)) {
          namedOutcomes.add(text)
          plannedOutcomes.push({ path: file.path, text, ...(availableAdoption ? { kind: 'available' as const } : {}) })
        }
        continue
      }
      bystanderReferences.push(
        `${file.path}: ${link.raw} changed meaning from ${before ?? 'no file'} to ${after ?? 'no file'} because of the rename.`,
      )
    }
    return { file, source, links, skipped }
  })
  return { files, bystanderReferences, plannedOutcomes }
}

async function buildRenameRepairPlan(
  workspace: Workspace,
  fromPath: string,
  toPath: string,
  beforeFiles: CachedMarkdown[],
  afterFiles: CachedMarkdown[],
  renamedContent: string,
  initialIssues: string[],
): Promise<RenameRepairPlan> {
  const folders = await workspace.listFolders()
  const readThrough = cachedReads(workspace)
  const afterCandidateList = await collectionCandidates(cachedWorkspace(workspace, afterFiles, readThrough), '')
  const beforeCandidateList = await collectionCandidates(cachedWorkspace(workspace, beforeFiles, readThrough), '')
  const beforeIndex = buildWikilinkCandidateIndex(beforeCandidateList)
  const afterIndex = buildWikilinkCandidateIndex(afterCandidateList)
  const beforeResolution = referenceResolution(await planLineResolutions(workspace, beforeFiles, readThrough), beforeIndex)
  const afterResolution = referenceResolution(await planLineResolutions(workspace, afterFiles, readThrough), afterIndex)
  const markdownReferences = analyseMarkdownReferences(afterFiles, fromPath, toPath, beforeResolution, afterResolution)
  const replacement = withoutMarkdownExtension(posix.basename(toPath))
  const preservePlanLinesIn = await planLinesToPreserve(workspace, folders, fromPath, toPath)
  const writes: PreparedWrite[] = []
  const bystanderReferences = [...markdownReferences.bystanderReferences]
  const issues = [...initialIssues, ...bystanderReferences]
  const plannedReferences: string[] = []
  const preservedReferences: string[] = []
  const plannedOutcomes: Array<{ path: string; text: string; kind?: 'available' }> = [...markdownReferences.plannedOutcomes]
  const manifestInputs: ExpectedOptionalFile[] = []
  const manifestWrites = await prepareManifestWrites({
    workspace,
    readThrough,
    folders,
    fromPath,
    toPath,
    issues,
    bystanderReferences,
    plannedReferences,
    plannedOutcomes,
    manifestInputs,
    presentBeforeRename: new Set(beforeFiles.map(({ file }) => file.path)),
    presentAfterRename: new Set(afterFiles.map(({ file }) => file.path)),
  })

  for (const { file, source, links, skipped } of markdownReferences.files) {
    const preservedPlanReason = preservePlanLinesIn.get(file.path)
    const mismatched = links.filter((link) => source.slice(link.from, link.to) !== link.raw)
    if (mismatched.length) {
      issues.push(...mismatched.map((link) => `${file.path}: ${link.raw} cannot be repaired because its source offsets do not match the original text`))
      continue
    }
    let next = source
    const repairedReferences: string[] = []
    for (const link of [...links].reverse()) {
      if (isInsideRange(link.from, link.to, skipped)) continue
      const beforeFrom = file.path === toPath ? fromPath : file.path
      if (beforeResolution.resolve(beforeFrom, source, link) !== fromPath) continue
      const isPlanTitleLink = beforeResolution.isPlanTitleLink(beforeFrom, source, link)
      if (preservedPlanReason && isPlanTitleLink) {
        preservedReferences.push(`${file.path}: [[${link.target}]] was left unchanged because ${preservedPlanReason}.`)
        continue
      }
      if (excludedPlanDestination(toPath) && isPlanTitleLink) {
        issues.push(
          `${file.path}: [[${link.target}]] cannot be repaired as [[${replacement}]] because the destination is excluded from Plans`,
        )
        continue
      }
      if (afterResolution.resolve(file.path, source, link) === toPath) continue
      const verification = isPlanTitleLink
        ? await rewrittenPlanResolution(
          workspace,
          afterFiles,
          file.path,
          source,
          link,
          replacement,
          readThrough,
          afterIndex,
          manifestWrites,
        )
        : resolveWikilinkTargetFromIndex(file.path, replacement, afterIndex).to
      if (verification !== toPath) {
        issues.push(
          `${file.path}: [[${link.target}]] cannot be repaired as [[${replacement}]] because it would resolve to ${verification ?? 'no file'}`,
        )
        continue
      }
      const raw = source.slice(link.from + 2, link.to - 2)
      const repaired = rewrittenTarget(raw, replacement)
      next = `${next.slice(0, link.from)}[[${repaired}]]${next.slice(link.to)}`
      repairedReferences.unshift(`${file.path}: ${link.raw}`)
    }
    plannedReferences.push(...repairedReferences)
    if (next !== source) writes.push({ path: file.path, current: source, content: next, kind: 'markdown' })
  }
  writes.push(...manifestWrites)

  const plan: RenameRepairPlan = {
    fromPath,
    toPath,
    writes: writes.map(({ path, content, kind }) => ({ path, content, kind })),
    manifestChanges: writes.filter(({ kind }) => kind === 'manifest').map(({ path, content }) => ({ path, content })),
    unrepairedReferences: issues,
    bystanderReferences,
    plannedReferences,
    preservedReferences,
    plannedOutcomes,
    verification: planVerification(afterFiles, manifestInputs, writes, plannedOutcomes, renamedContent),
  }
  return plan
}

async function planRenameRepairBeforeRename(
  workspace: Workspace,
  fromPath: string,
  toPath: string,
  files: CachedMarkdown[],
): Promise<RenameRepairPlan> {
  const renamedFile = files.find(({ file }) => file.path === fromPath)
  if (!renamedFile) throw new Error(`Cannot prepare Rename Repair because ${fromPath} is not in the Workspace file list.`)
  const afterFiles = files
    .map((file) => renamedView(file, fromPath, toPath))
    .filter(({ file }) => file.path !== toPath || workspace.isVisiblePath(toPath))
    .sort((left, right) => left.file.path.localeCompare(right.file.path))
  const issues = workspace.isVisiblePath(toPath)
    ? []
    : [`${toPath}: The renamed file is outside the Workspace file list, so its references cannot be repaired.`]
  return buildRenameRepairPlan(workspace, fromPath, toPath, files, afterFiles, renamedFile.content, issues)
}

async function planRenameRepairAfterRename(
  workspace: Workspace,
  fromPath: string,
  toPath: string,
  files: CachedMarkdown[],
): Promise<RenameRepairPlan> {
  const listedRenamedFile = files.find(({ file }) => file.path === toPath)
  const renamedOutsideFileList = !listedRenamedFile && await workspacePathExists(workspace, toPath)
  if (!listedRenamedFile && !renamedOutsideFileList) throw new Error(`File not found: ${fromPath}`)
  const renamedFile = listedRenamedFile ?? await workspace.readFile(toPath)
  const afterWithRenamed = listedRenamedFile ? files : [...files, renamedFile]
  const beforeFiles = afterWithRenamed.map((file) => renamedView(file, toPath, fromPath))
  const issues = renamedOutsideFileList
    ? [`${toPath}: The renamed file is outside the Workspace file list, so its references cannot be repaired.`]
    : []
  return buildRenameRepairPlan(workspace, fromPath, toPath, beforeFiles, files, renamedFile.content, issues)
}

/**
 * Predict every rename-repair write from either the pre-rename or post-rename workspace state. This
 * remains the single read-only seam used by both today's compatibility door and preflight callers.
 */
export async function planRenameRepair(
  workspace: Workspace,
  fromPath: string,
  toPath: string,
): Promise<RenameRepairPlan> {
  fromPath = canonicalWorkspacePath(workspace, fromPath)
  toPath = canonicalWorkspacePath(workspace, toPath)
  const listedFiles = await workspace.listFiles()
  const files = await Promise.all(listedFiles.map(async (file): Promise<CachedMarkdown> => ({
    file,
    content: (await workspace.readFile(file.path)).content,
  })))
  return files.some(({ file }) => file.path === fromPath)
    ? planRenameRepairBeforeRename(workspace, fromPath, toPath, files)
    : planRenameRepairAfterRename(workspace, fromPath, toPath, files)
}

/** Preserve the plan's reference identity when applying it fails after the structural rename. */
export async function failedRenameRepairResult(
  plan: RenameRepairPlan,
  workspace: Workspace,
  error: unknown,
): Promise<RenameRepairResult> {
  return classifyPlanNotices(plan, await failedPlannedRenameRepairResult(plan, workspace, error))
}

function classifyPlanNotices(plan: RenameRepairPlan, repair: RenameRepairResult): RenameRepairResult {
  const available = new Set(plan.plannedOutcomes
    .filter((outcome) => outcome.kind === 'available')
    .map((outcome) => outcome.text))
  const issues = repair.issues.map((issue): RenameRepairIssue => (
    issue.kind === 'outcome' && available.has(issue.text)
      ? { kind: 'available', text: issue.text }
      : issue
  ))
  const noticeIndex = issues.findIndex((issue) => (
    issue.kind === 'outcome' || issue.kind === 'available' || issue.kind === 'file' || issue.kind === 'reason'
  ))
  issues.splice(
    noticeIndex < 0 ? issues.length : noticeIndex,
    0,
    ...plan.preservedReferences.map((text): RenameRepairIssue => ({ kind: 'preserved', text })),
  )
  return {
    ...repair,
    issues,
  }
}

export async function applyRenameRepair(
  plan: RenameRepairPlan,
  workspace: Workspace,
  options: RenameRepairOptions = {},
): Promise<RenameRepairResult> {
  return classifyPlanNotices(plan, await applyPlannedRenameRepair(plan, workspace, options))
}

/** Compatibility door for today's post-rename callers. */
export async function repairRename(
  workspace: Workspace,
  fromPath: string,
  toPath: string,
  options: RenameRepairOptions = {},
): Promise<RenameRepairResult> {
  const plan = await planRenameRepair(workspace, fromPath, toPath)
  return applyRenameRepair(plan, workspace, options)
}
