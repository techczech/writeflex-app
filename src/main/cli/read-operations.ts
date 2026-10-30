/**
 * The read-only operations. Each delegates to the code the app itself uses for the same question
 * (Workspace, the collection query, the plan reads, the stores' list methods) and adds only argument
 * checking and plain-text rendering. None writes anything.
 */
import { inLine } from './terminal-text'
import { stat } from 'node:fs/promises'
import { evaluateCollectionQuery } from '../query-engine'
import { compareParts, readPlanForAgent } from '../plan-agent-reads'
import { describeListing, readPieceSources } from '../piece-sources'
import { ScrapStore } from '../scraps'
import { ScratchpadStore } from '../scratchpad-store'
import { readScratchInventory } from '../scratchpad-inventory'
import { listScrapsWithScratchpad } from '../scrap-listing'
import { listTasksInFile } from '../tasks'
import { VersionStore } from '../versions'
import { isPathInFolder } from '../workspace'
import { CliError, type Operation } from './operation'
import { visiblePath } from './paths'
import { readSection } from './sections'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Refusals thrown by the app's own readers are already readable sentences; pass them on as such. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(error instanceof Error ? error.message : String(error), 'failed')
  }
}

const date = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

export const READ_OPERATIONS: Operation[] = [
  {
    name: 'search', group: 'Find and manage files', behaviour: 'direct',
    summary: 'Search the Collection. Ranked pieces, one match per piece, with the best line.',
    args: [
      { name: 'query', type: 'string', required: true, positional: true, description: 'Search terms; the same syntax as the app\'s search (quotes, -not, tag:, /regex/).' },
      { name: 'folder', type: 'string', description: 'Limit results to one folder.' },
      { name: 'limit', type: 'integer', description: 'Most matches to return (default 300).' },
    ],
    run: ({ workspace }, args) => guarded(async () => {
      const folder = args.folder === undefined ? undefined : visiblePath(workspace, str(args.folder), { allowRoot: true })
      const result = await workspace.search(str(args.query), {
        ...(typeof args.limit === 'number' ? { maxResults: args.limit } : {}),
        ...(folder ? { scope: { folder, results: 'folder' as const } } : {}),
      })
      const lines = result.matches.map((m) => `${inLine(m.path)}:${m.line}: ${inLine(m.preview.trim())}`)
      const tail = result.total > result.matches.length ? [`${result.total - result.matches.length} more not shown.`] : []
      return { data: result, text: [...lines, ...tail, lines.length === 0 ? 'No matches.' : ''].filter(Boolean).join('\n') }
    }),
  },
  {
    name: 'files', group: 'Find and manage files', behaviour: 'direct',
    summary: 'List the Markdown files and folders in the Collection, or under one folder.',
    args: [{ name: 'folder', type: 'string', positional: true, description: 'Folder to list under (default: the whole Collection).' }],
    run: ({ workspace }, args) => guarded(async () => {
      const folder = args.folder === undefined ? '' : visiblePath(workspace, str(args.folder), { allowRoot: true })
      const files = (await workspace.listFiles()).filter((f) => !folder || isPathInFolder(f.path, folder))
      const folders = (await workspace.listFolders()).filter((f) => !folder || isPathInFolder(f, folder))
      return { data: { folder, folders, files }, text: [...folders.map((f) => `${inLine(f)}/`), ...files.map((f) => inLine(f.path))].join('\n') || 'Nothing here.' }
    }),
  },
  {
    name: 'query', group: 'Find and manage files', behaviour: 'direct',
    summary: 'Run a Collection query (the app\'s query blocks) and list the matching pieces.',
    args: [
      { name: 'query', type: 'string', required: true, positional: true, description: 'Query source, e.g. "status: draft\\nsort: date desc".' },
      { name: 'dir', type: 'string', description: 'Collection folder to run it in (default: the root).' },
    ],
    run: ({ workspace }, args) => guarded(async () => {
      const dir = args.dir === undefined ? '' : visiblePath(workspace, str(args.dir), { allowRoot: true })
      const result = await evaluateCollectionQuery(workspace, dir, str(args.query).replace(/\\n/g, '\n'))
      if (!result.ok) throw new CliError(`Query line ${result.error.line}: ${result.error.humanReadable}`, 'usage')
      const text = result.rows.map((r) => [r.path, r.status ?? '-', `${r.words} words`, r.title].join('\t')).join('\n')
      return { data: result, text: text || 'No pieces match.' }
    }),
  },
  {
    name: 'read', group: 'Find and manage files', behaviour: 'direct',
    summary: 'Read a document, or one section of it (a heading and what sits under it).',
    args: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative Markdown path.' },
      { name: 'section', type: 'string', description: 'Heading text (or its slug) of the section to read.' },
    ],
    run: ({ workspace }, args) => guarded(async () => {
      const { file, content } = await workspace.readFile(visiblePath(workspace, str(args.path), { markdown: true }))
      if (args.section === undefined) return { data: { file, content }, text: content, verbatim: true, fromDocument: true }
      const section = readSection(content, str(args.section))
      return { data: { file, section }, text: section.text, verbatim: true, fromDocument: true }
    }),
  },
  {
    name: 'tasks', group: 'Collect and plan', behaviour: 'direct',
    summary: 'List the open and done checkbox items of a piece or an agent note.',
    args: [{ name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative Markdown path.' }],
    run: ({ workspace }, args) => guarded(async () => {
      const listing = await listTasksInFile(workspace, visiblePath(workspace, str(args.path), { markdown: true }))
      const row = (mark: string) => (t: { line: number; text: string }) => `${mark} line ${t.line}: ${t.text}`
      const text = [...listing.open.map(row('[ ]')), ...listing.done.map(row('[x]'))].join('\n')
      return { data: listing, text: text || 'No checkbox items.' }
    }),
  },
  {
    name: 'sources', group: 'Collect and plan', behaviour: 'direct',
    summary: 'List one piece\'s sources: those its frontmatter lists and those its text cites.',
    args: [{ name: 'path', type: 'string', required: true, positional: true, description: 'The piece\'s Collection-relative path.' }],
    run: ({ workspace }, args) => guarded(async () => {
      const listing = await readPieceSources(workspace, { path: visiblePath(workspace, str(args.path), { markdown: true }) })
      return { data: listing, text: describeListing(listing) }
    }),
  },
  {
    name: 'scratchpad', group: 'Collect and plan', behaviour: 'direct',
    summary: 'Read typed Scratchpad candidates with exact payloads, and optionally document inventory. Each inventory span says live or disk.',
    args: [
      { name: 'path', type: 'string', positional: true, description: 'Document to inventory; omitted lists candidates only.' },
      { name: 'folio', type: 'boolean', description: 'Include the resolved parts of this document’s Folio.' },
    ],
    run: ({ workspace }, args) => guarded(async () => {
      const path = args.path === undefined ? null : visiblePath(workspace, str(args.path), { markdown: true })
      const snapshot = await new ScratchpadStore(workspace, new ScrapStore(workspace)).list({ activePath: path })
      const inventory = path ? await readScratchInventory(workspace, { activePath: path, scope: args.folio ? 'folio' : 'part' }) : { items: [], notices: [] }
      return { data: { ...snapshot, inventory }, text: [
        ...snapshot.items.map(item => `${item.kind} [${item.id}] from ${item.origin.path}: ${item.title}`),
        ...inventory.items.map(item => `${item.kind} in ${item.origin.path}:${item.document!.line} (${item.document!.basis}): ${item.title}`),
        ...snapshot.notices, ...inventory.notices,
      ].join('\n') || 'The Scratchpad is empty.' }
    }),
  },
  {
    name: 'scraps', group: 'Collect and plan', behaviour: 'direct',
    summary: 'List the Collection\'s scraps (cuttings set aside), optionally one file\'s.',
    args: [{ name: 'origin', type: 'string', positional: true, description: 'Only the scraps filed under this file.' }],
    run: ({ workspace }, args) => guarded(async () => {
      const origin = args.origin === undefined ? undefined : visiblePath(workspace, str(args.origin), { markdown: true })
      const scraps = await listScrapsWithScratchpad(workspace, new ScrapStore(workspace), origin ? { origin } : undefined)
      const text = scraps.map((s) => `${s.origin} [${s.id}]${s.done ? ' (done)' : ''}: ${s.text.replace(/\s+/g, ' ').trim()}`).join('\n')
      return { data: { scraps }, text: text || 'No scraps.' }
    }),
  },
  {
    name: 'running-order', group: 'Collect and plan', behaviour: 'direct',
    summary: 'Read a Folio\'s running order: its parts in order, unwritten parts, and strays.',
    args: [{ name: 'dir', type: 'string', positional: true, description: 'The Folio\'s folder (default: the root).' }],
    run: ({ workspace }, args) => guarded(async () => {
      const dir = args.dir === undefined ? '' : visiblePath(workspace, str(args.dir), { allowRoot: true })
      const plan = await readPlanForAgent(workspace, dir, { manifestOrder: true })
      const parts = plan.parts.map((p, i) => `${i + 1}. ${inLine(p.title)} [${p.sectionPage ? 'Section page' : p.role}]${p.section ? ` · in ${inLine(p.section)}` : ''} ${p.path === null || p.path === undefined ? '(unwritten)' : inLine(p.path)}${p.words === null ? '' : `, ${p.words} words`}`)
      const strays = plan.strays.map((s) => `stray: ${inLine(s.path)} (${inLine(s.title)}, ${s.words} words)`)
      return { data: plan, text: [[...parts, ...strays].join('\n') || 'The running order is empty.', ...(plan.evidenceProblem ? [plan.evidenceProblem] : [])].join('\n') }
    }),
  },
  {
    name: 'compare-parts', group: 'Collect and plan', behaviour: 'direct',
    summary: 'Compare two near-identical files in a folder (e.g. a sync conflict copy) and list the passages only one side has.',
    args: [
      { name: 'a', type: 'string', required: true, positional: true, description: 'First file.' },
      { name: 'b', type: 'string', required: true, positional: true, description: 'Second file.' },
      { name: 'dir', type: 'string', description: 'The folder holding both (default: the first file\'s folder).' },
    ],
    run: ({ workspace }, args) => guarded(async () => {
      const a = visiblePath(workspace, str(args.a), { markdown: true })
      const b = visiblePath(workspace, str(args.b), { markdown: true })
      const dir = args.dir === undefined ? a.split('/').slice(0, -1).join('/') : visiblePath(workspace, str(args.dir), { allowRoot: true })
      const comparison = await compareParts(workspace, dir, a, b)
      const passages = comparison.passages.map((p) => `only in ${p.side} (line ${p.line}, ${p.words} words): ${p.text.replace(/\s+/g, ' ').trim()}`)
      return { data: comparison, text: [`${comparison.a.path} vs ${comparison.b.path}`, ...passages].join('\n') }
    }),
  },
  {
    name: 'versions', group: 'Review and versions', behaviour: 'direct',
    summary: 'List saved versions, newest first, for one document or the whole Collection.',
    args: [{ name: 'path', type: 'string', positional: true, description: 'Only this document\'s versions.' }],
    run: ({ workspace }, args) => guarded(async () => {
      const path = args.path === undefined ? undefined : visiblePath(workspace, str(args.path), { markdown: true })
      const versions = await new VersionStore(workspace).list(path ? { path } : undefined)
      const text = versions.map((v) => `${date(v.ts)}  ${v.path}  ${v.name}  (${v.author.name})  ${v.id}`).join('\n')
      return { data: { versions }, text: text || 'No versions.' }
    }),
  },
  {
    name: 'open', group: 'Find and manage files', behaviour: 'direct',
    summary: 'Open a file in WriteFlex, optionally at a line, through the writeflex://open link.',
    args: [
      { name: 'path', type: 'string', required: true, positional: true, description: 'Collection-relative Markdown path.' },
      { name: 'line', type: 'integer', description: 'Line to open at (1-based).' },
    ],
    run: (ctx, args) => guarded(async () => {
      const rel = visiblePath(ctx.workspace, str(args.path), { markdown: true })
      const abs = ctx.workspace.absolute(rel)
      if (!(await stat(abs).then((s) => s.isFile(), () => false))) throw new CliError(`${rel} does not exist.`)
      const line = typeof args.line === 'number' ? args.line : undefined
      if (line !== undefined && line < 1) throw new CliError('--line must be 1 or more.', 'usage')
      const url = `writeflex://open?path=${encodeURIComponent(abs)}${line ? `&line=${line}` : ''}`
      await ctx.openUrl(url)
      return { data: { url, path: rel, ...(line ? { line } : {}) }, text: `Asked WriteFlex to open ${rel}${line ? ` at line ${line}` : ''}.` }
    }),
  },
]
