import { evidenceAttachment, type EvidenceTransfer } from '../shared/folio-evidence-transfer'
import { readFolioZoteroEvidence } from './folio-zotero-evidence'
import { stripFencedRegions } from '../shared/markdown/fences'
import { frontmatterBlock } from '../shared/markdown/frontmatter'
import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { posix, relative } from 'node:path'
import { folioKey } from './folio-dir'
import { readFolioPlan } from './plan'
import type { FolioWorkspace } from './folio-workspace'
import { DocumentChangedError, DiskChangedUnderBuffer, NameTaken, type Workspace } from './workspace'
import { readPieceSources, pieceSourcesContext, needsPieceSources } from './piece-sources'
import { collectionCandidates, resolveWikilinkTarget, extractWikilinks } from './wikilinks'
import { parseFrontmatter } from './frontmatter'
import { isRoomSupportName } from '../shared/folio-part-name'
import { titleClashes } from '../shared/folio-room'
import { withoutAbsolutePaths } from '../shared/plain-error-text'
import { applyEvidenceOps, undoEvidenceOps, holdsSectionHeading, leavesFenceOpen, evidenceKey, evidencePartKey, normaliseQuote, parseEvidence, parseEvidenceLink, type EvidenceItem, type EvidenceOp, type EvidenceUndoOp, type RoomEvidence, type RoomEvidenceRow, type RoomPartEvidence } from '../shared/folio-evidence'

export type EvidenceWriteResult = { ok: boolean; token: string | null; message: string; path?: string; conflicts?: Array<{ part: string; ours: string; theirs: string }> }
export type EvidenceWriteOptions = { session: string; expectedOwner?: string; beforeWrite?: (path: string) => Promise<void> }
const tails = new Map<string, Promise<void>>()
const checkpoints = new Set<string>()
const undo = new Map<string, { owner: string; ops: EvidenceUndoOp[] }>()
export function evidencePath(ws: { folioDir: string; root: string }): string {
  const name = posix.basename(ws.folioDir || ws.root)
  return posix.join(ws.folioDir, `_${name}_EVIDENCE-AND-NOTES.md`)
}
function ownerKey(ws: Pick<FolioWorkspace, 'root' | 'folioDir'>): string { const key = folioKey(ws.root, ws.folioDir); return key.root + '\0' + key.dir }
async function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>(resolve => { release = resolve })
  tails.set(key, tail); await before
  try { return await run() } finally { release(); if (tails.get(key) === tail) tails.delete(key) }
}
const UNREADABLE = 'The evidence file cannot be read, so nothing was changed.'
/** The evidence file's text, null when it does not exist; anything else (a folder, a link out of the workspace) refuses. */
async function sourceNow(ws: Workspace, path: string): Promise<string | null> {
  try { return (await ws.readFile(path)).content } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error(UNREADABLE) }
}

/** Where a source really is and its stat: existence, size and mtime. Nothing of the file is read. */
async function sourceStat(ws: Workspace, path: string): Promise<{ real: string; size: number; stamp: string }> {
  const real = await realpath(ws.absolute(path))
  const realRoot = await realpath(ws.root)
  if (relative(realRoot, real).split('\\').join('/').normalize('NFC').toLowerCase() !== path.normalize('NFC').toLowerCase()) throw new Error('The source is not inside its own folder.')
  const info = await stat(real)
  if (!info.isFile()) throw new Error('The source is not a file.')
  return { real, size: info.size, stamp: `${info.size}:${info.mtimeMs}` }
}
type FileFact = { stamp: string; fingerprint: string; label: string | null }
const fileFacts = new Map<string, FileFact>()
/** The fingerprint (first 64 KB, spec D-EV-7) and, for Markdown, the author-year label from the frontmatter in those
 *  same bytes. Read at most once per file per size/mtime pair; the bytes themselves are never kept. */
async function fileFact(ws: Workspace, path: string): Promise<FileFact> {
  const { real, size, stamp } = await sourceStat(ws, path)
  const found = fileFacts.get(real)
  if (found?.stamp === stamp) return found
  const handle = await open(real, 'r')
  try {
    const bytes = Buffer.alloc(Math.min(size, 65536))
    await handle.read(bytes, 0, bytes.length, 0)
    const metadata = /\.(?:md|markdown)$/i.test(path) ? parseFrontmatter(bytes.toString('utf8')) : null
    const year = metadata?.extra.year
    const fact = { stamp, fingerprint: createHash('sha1').update(bytes).digest('hex').slice(0, 16), label: metadata?.author && year ? `${metadata.author} ${year}` : null }
    fileFacts.set(real, fact)
    if (fileFacts.size > 2000) fileFacts.delete(fileFacts.keys().next().value!)
    return fact
  } finally { await handle.close() }
}
/** Quotation checks need the words, so only text formats are read whole, and only below 16 MB; a PDF or other binary
 *  file's bytes are not its text, so its quotes are not checked (null). */
async function quoteText(ws: Workspace, path: string): Promise<string | null> {
  if (!/\.(?:md|markdown|mdx|txt|html?)$/i.test(path)) return null
  const { real, size } = await sourceStat(ws, path)
  if (size > 16 * 1024 * 1024) return null
  return (await readFile(real, 'utf8')).replace(/<[^>]*>/g, '')
}
function filePath(ws: Pick<FolioWorkspace, 'folioDir'>, target: string): string {
  let decoded = target
  try { decoded = decodeURIComponent(target) } catch { /* a literal percent in a hand-written name */ }
  if (!decoded || /[\\\0]/.test(decoded) || posix.isAbsolute(decoded) || /^[a-z][a-z\d+.-]*:/i.test(decoded)) throw new Error('Choose a file inside this Folio.')
  const normal = posix.normalize(decoded)
  if (normal === '..' || normal.startsWith('../')) throw new Error('Choose a file inside this Folio.')
  return posix.join(ws.folioDir, normal)
}
const lineWithFingerprint = (line: string, fingerprint: string): string => {
  const ending = /\r\n|\n|\r/.exec(line)?.[0] ?? '\n'
  return line.replace(/[\r\n]+$/, '').replace(/\s*<!--wf:sha1-16=[a-f\d]{16}-->/g, '') + ` <!--wf:sha1-16=${fingerprint}-->${ending}`
}

async function prepare(ws: FolioWorkspace, ops: readonly EvidenceUndoOp[], restoring: boolean): Promise<EvidenceUndoOp[]> {
  const plan = await readFolioPlan(ws, ws.folioDir)
  if (!plan) throw new Error('That folder is no longer a Folio.')
  const clashes = titleClashes(plan.parts.map(part => part.title))
  const result: EvidenceUndoOp[] = []
  for (const op of ops) {
    const index = plan.parts.findIndex(part => evidencePartKey(part.title) === evidencePartKey(op.part))
    if (index < 0) throw new Error(`“${op.part}” is no longer in the running order.`)
    if (clashes.has(index)) throw new Error('Two parts share that title. Give them different titles before attaching evidence or notes.')
    // A whole-section restore exists only as a recorded Undo; the room can never send one.
    if (op.kind === 'section') { if (!restoring) throw new Error('Invalid evidence edit.'); result.push(op); continue }
    if (!['item', 'line', 'notes'].includes(op.kind) || typeof op.part !== 'string' || !op.part.trim() || op.part.length > 500) throw new Error('Invalid evidence edit.')
    if (op.kind === 'notes') {
      if (op.value !== null && ((!restoring && /^#/m.test(op.value)) || holdsSectionHeading(op.value))) throw new Error('Notes cannot hold headings.')
      if (op.value !== null && leavesFenceOpen(op.value)) throw new Error('These notes open a code block with ``` or ~~~ and never close it, so nothing was changed. Close the code block and try again.')
      result.push(op); continue
    }
    if (op.value === null) { result.push(op); continue }
    if (leavesFenceOpen(op.value)) throw new Error('That evidence item opens a code block it never closes, so nothing was changed.')
    const item = parseEvidenceLink(op.value)
    if (!item) throw new Error('That evidence link cannot be read.')
    if (item.kind === 'file' && !restoring) {
      const target = filePath(ws, item.target)
      if (isRoomSupportName(target)) throw new Error('Choose a source file, rather than a Folio support file.')
      if (op.kind === 'line' || op.expect === null) {
        const fact = await fileFact(ws, target)
        const first = op.value.match(/[^\r\n]*(?:\r\n|\n|\r|$)/)![0]
        result.push({ ...op, value: lineWithFingerprint(first, fact.fingerprint) + op.value.slice(first.length) }); continue
      }
    }
    result.push(op)
  }
  return result
}

async function write(ws: FolioWorkspace, input: readonly EvidenceUndoOp[], options: EvidenceWriteOptions, restoring = false): Promise<EvidenceWriteResult> {
  const path = evidencePath(ws), owner = ownerKey(ws)
  if ((options.expectedOwner !== undefined && options.expectedOwner !== owner) || !options.session || options.session.length > 128 || input.length > 100) return { ok: false, token: null, message: 'Invalid evidence edit.' }
  try {
    const ops = await prepare(ws, input, restoring)
    const session = owner + '\0' + options.session
    let basis = await sourceNow(ws, path)
    const apply = (text: string) => restoring ? undoEvidenceOps(text, ops) : applyEvidenceOps(text, ops as EvidenceOp[])
    let applied = apply(basis ?? '')
    // Undo restores everything the save changed or writes nothing: one part changed since refuses the whole Undo.
    if (restoring && applied.refused.length) return { ok: false, token: null, message: 'The evidence or notes changed elsewhere. Your edit was not applied.' }
    if (applied.source === (basis ?? '')) return { ok: false, token: null, message: applied.refused.length ? 'The evidence or notes changed elsewhere. Your edit was not applied.' : 'Nothing changed.' }
    if (!checkpoints.has(session)) {
      await options.beforeWrite?.(path)
      checkpoints.add(session)
      if (checkpoints.size > 512) checkpoints.delete(checkpoints.values().next().value!)
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await ws.saveFileOver(path, applied.source, basis === null ? { kind: 'create' } : { kind: 'disk', text: basis })
        let token: string | null = null
        if (!restoring && applied.inverse.length) {
          token = 'ev:' + randomUUID(); undo.set(token, { owner, ops: applied.inverse })
          if (undo.size > 100) undo.delete(undo.keys().next().value!)
        }
        const conflicts = applied.refused.filter((op): op is Extract<EvidenceOp, { kind: 'notes' }> => op.kind === 'notes').map(op => ({ part: op.part, ours: op.value ?? '', theirs: parseEvidence(basis ?? '').sections.find(section => evidencePartKey(section.title) === evidencePartKey(op.part))?.notes?.raw ?? '' }))
        const message = restoring
          ? 'Undone. Other evidence and notes were kept.'
          : applied.refused.length ? `Saved ${applied.applied.length} edits. ${applied.refused.length} edits changed elsewhere and were not applied.` : 'Saved the evidence and notes.'
        return { ok: true, path, token, conflicts, message }
      } catch (error) {
        if (!(error instanceof DocumentChangedError || error instanceof DiskChangedUnderBuffer || error instanceof NameTaken) || attempt === 1) throw error
        basis = await sourceNow(ws, path)
        applied = apply(basis ?? '')
        if (!applied.applied.length || (restoring && applied.refused.length)) return { ok: false, token: null, message: 'The evidence or notes changed elsewhere. Your edit was not applied.', conflicts: applied.refused.filter(op => op.kind === 'notes').map(op => ({ part: op.part, ours: op.value ?? '', theirs: parseEvidence(basis ?? '').sections.find(section => evidencePartKey(section.title) === evidencePartKey(op.part))?.notes?.raw ?? '' })) }
      }
    }
    throw new Error('The evidence changed again. Your remaining edits were not applied.')
  } catch (error) { return { ok: false, token: null, message: withoutAbsolutePaths(error instanceof Error ? error.message : String(error), ws.root) } }
}
export function attachEvidence(ws: FolioWorkspace, part: string, input: EvidenceTransfer, options: EvidenceWriteOptions): Promise<EvidenceWriteResult> {
  return serial(ownerKey(ws), async () => {
    try {
      if (options.expectedOwner !== undefined && options.expectedOwner !== ownerKey(ws)) throw new Error('The workspace changed. The source was not attached.')
      let source = input
      if (source.kind === 'zotero' && source.annotation) {
        const fact = (await readFolioZoteroEvidence([{ target: source.itemTarget, highlights: [source.annotation.target] }]))[0]
        const confirmed = fact?.highlights.some(highlight => highlight.target === (source as Extract<EvidenceTransfer, { kind: 'zotero' }>).annotation?.target)
        source = { ...source, pending: confirmed ? false : fact?.state === 'ready' ? true : source.pending }
      }
      const current = await sourceNow(ws, evidencePath(ws)) ?? ''
      const existing = parseEvidence(current).sections.filter(section => evidencePartKey(section.title) === evidencePartKey(part)).flatMap(section => section.items)
      const attachment = evidenceAttachment(part, ws.folioDir, source, existing, parseEvidence(current).eol)
      if (!attachment.op) return { ok: false, token: null, message: attachment.message ?? 'That source is already attached.' }
      const answer = await write(ws, [attachment.op], options)
      return attachment.message && answer.ok ? { ...answer, message: attachment.message } : answer
    } catch (error) { return { ok: false, token: null, message: withoutAbsolutePaths(error instanceof Error ? error.message : String(error), ws.root) } }
  })
}
export function writeEvidence(ws: FolioWorkspace, ops: readonly EvidenceOp[], options: EvidenceWriteOptions): Promise<EvidenceWriteResult> { return serial(ownerKey(ws), () => write(ws, ops, options)) }
export function undoEvidence(ws: FolioWorkspace, token: string, options: EvidenceWriteOptions): Promise<EvidenceWriteResult> {
  return serial(ownerKey(ws), async () => {
    const record = undo.get(token)
    if (!record || record.owner !== ownerKey(ws)) return { ok: false, token: null, message: 'That evidence edit can no longer be undone.' }
    const result = await write(ws, record.ops, options, true)
    if (result.ok) undo.delete(token)
    return result
  })
}

/** The source an attached item names, as every evidence surface identifies it: the resolved file for a file or note link
 *  (so `[[Meeting]]` and `[meeting.md](notes/meeting.md)` are one source), else the link's own key. */
type Candidates = Awaited<ReturnType<typeof collectionCandidates>>
function attachedPath(dir: string, path: string, item: EvidenceItem, candidates: Candidates): string | null {
  if (item.kind === 'file') { try { return filePath({ folioDir: dir }, item.target) } catch { return null } }
  return item.kind === 'note' ? resolveWikilinkTarget(path, item.target, candidates).to : null
}
const sourceIdentity = (targetPath: string | null, item: EvidenceItem): string => targetPath ? 'path:' + targetPath : item.key
const evidenceCandidates = async (ws: Pick<Workspace, 'listFiles' | 'readFile'>): Promise<Candidates> => (await collectionCandidates(ws, '')).filter(candidate => !isRoomSupportName(candidate.path))

const UNREADABLE_READ = 'The evidence file cannot be read. WriteFlex shows no evidence or notes until it can.'
/** The per-turn summary's count: distinct sources attached to each part in the evidence file, identified as the room
 *  identifies them. Only the evidence file is read and parsed — plus the workspace's note titles when a part attaches a
 *  `[[note]]`, to resolve it; no source stat or bytes, no highlight check, no Zotero. */
export async function countAttachedEvidence(ws: Pick<Workspace, 'root' | 'readFile' | 'listFiles'>, dir: string, titles: readonly string[]): Promise<{ state: RoomEvidence['state']; message?: string; counts: Record<string, number> }> {
  const path = evidencePath({ root: ws.root, folioDir: dir })
  let source: string | null
  try { source = (await ws.readFile(path)).content } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') source = null
    else return { state: 'unreadable', message: UNREADABLE_READ, counts: Object.create(null) }
  }
  const sections = parseEvidence(source ?? '').sections
  const keys = new Set(titles.map(evidencePartKey))
  const counted = sections.filter(section => keys.has(evidencePartKey(section.title)))
  const candidates = counted.some(section => section.items.some(item => item.kind === 'note')) ? await evidenceCandidates(ws) : []
  const counts: Record<string, number> = Object.create(null)
  for (const key of keys) {
    counts[key] = new Set(counted.filter(section => evidencePartKey(section.title) === key).flatMap(section => section.items.map(item => sourceIdentity(attachedPath(dir, path, item, candidates), item)))).size
  }
  return { state: source === null ? 'missing' : 'ready', counts }
}

/** Read the merged evidence set. A missing support file remains absent; one that cannot be read is `unreadable` with an
 *  empty model, never a throw. Sources are stat-checked; bytes are read only for fingerprints and quotation checks. */
export async function readEvidence(ws: Workspace, dir: string, given?: Array<{ title: string; path: string | null; content?: string }>, files: string[] = []): Promise<RoomEvidence> {
  const path = evidencePath({ root: ws.root, folioDir: dir })
  let source: string | null
  try { source = (await ws.readFile(path)).content } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') source = null
    // A folder, a link out of the workspace or any other failure: the room still opens and says so (as the map does).
    else return { path, state: 'unreadable', message: UNREADABLE_READ, eol: '\n', parts: Object.create(null), orphans: [], candidates: [] }
  }
  const sourceContext = pieceSourcesContext(ws, dir)
  const document = parseEvidence(source ?? '')
  const parts = given ?? (await readFolioPlan(ws, dir))?.parts ?? []
  const candidates = await evidenceCandidates(ws)
  const within = (file: string): boolean => !dir || file.startsWith(dir + '/')
  const choices = [...new Map([...files.filter(file => !isRoomSupportName(file)).map(file => [file, { path: file, title: posix.basename(file), kind: 'file' as const }] as const), ...candidates.map(candidate => [candidate.path, { path: candidate.path, title: candidate.title, kind: within(candidate.path) ? 'file' as const : 'note' as const }] as const)]).values()]
  const answer: RoomEvidence = { path, state: source === null ? 'missing' : 'ready', eol: document.eol, parts: Object.create(null), orphans: [], candidates: choices }
  for (const part of parts) {
    const sections = document.sections.filter(section => evidencePartKey(section.title) === evidencePartKey(part.title))
    const model: RoomPartEvidence = { rows: [], notes: sections[0]?.notes?.raw.trimEnd() ?? '', additionalNotes: sections.slice(1).map(section => section.notes?.raw.trimEnd() ?? '').filter(Boolean), notesBasis: sections[0]?.notes?.raw ?? null, duplicate: sections.length > 1 }
    const placed = new Map<string, RoomEvidenceRow>()
    for (const section of sections) for (const item of section.items) {
      const targetPath = attachedPath(dir, path, item, candidates)
      const key = sourceIdentity(targetPath, item)
      const previous = placed.get(key)
      if (previous) { for (const highlight of item.highlights) if (!previous.highlights.some(existing => existing.key === highlight.key)) previous.highlights.push(highlight); continue }
      const row: RoomEvidenceRow = { key, kind: item.kind, target: item.target, title: item.label, path: targetPath, origins: ['attached here'], item, removable: section === sections[0], state: item.kind === 'zotero' ? 'Zotero not available' : 'ready', highlights: [...item.highlights] }
      if (item.kind === 'file' || item.kind === 'note') {
        if (!targetPath) row.state = 'missing'
        else {
          try {
            // The 64 KB start is read only when it answers something: a fingerprint to compare or a Markdown label.
            const fact = item.fingerprint || /\.(?:md|markdown)$/i.test(targetPath) ? await fileFact(ws, targetPath) : (await sourceStat(ws, targetPath), null)
            if (item.fingerprint && fact && fact.fingerprint !== item.fingerprint) row.state = 'changed since attached'
            const label = fact?.label ?? candidates.find(candidate => candidate.path === targetPath)?.title ?? item.label
            row.citationLabel = label
            row.citation = `[⟨${label.replace(/[\[\]]/g, '')}⟩](${targetPath})`
          } catch { row.state = 'missing' }
        }
      }
      if (row.kind === 'archive') row.citation = row.target
      placed.set(key, row); model.rows.push(row)
    }
    if (part.path) {
      const text = 'content' in part ? part.content ?? '' : (await ws.readFile(part.path)).content
      if (needsPieceSources(text)) {
        const listing = await readPieceSources(ws, { path: part.path, dir }, sourceContext).catch(() => null)
        for (const entry of listing?.entries ?? []) {
          const key = entry.path ? 'path:' + entry.path : 'note:' + evidencePartKey(entry.title)
          let row = placed.get(key)
          if (!row) { row = { key, kind: 'note', target: entry.title, title: entry.title, path: entry.path, origins: [], item: null, removable: false, state: entry.path ? 'ready' : 'missing', highlights: [] }; model.rows.push(row); placed.set(key, row) }
          if (entry.status !== 'cited') row.origins.push('listed in the part’s sources')
          if (entry.status !== 'listed') row.origins.push('cited in the text')
        }
      }
      const block = frontmatterBlock(text)
      const prose = stripFencedRegions(block ? text.slice(block.end) : text)
      const cited = [
        ...extractWikilinks(prose).map(link => ({ kind: 'note' as const, target: link.target, label: link.display, path: resolveWikilinkTarget(part.path!, link.target, candidates).to })),
        ...[...prose.matchAll(/(?<!!)\[((?:\\.|[^\]\\])*)\]\((<[^>\r\n]+>|[^)\r\n]+)\)/g)].flatMap(match => {
          const link = parseEvidenceLink('- ' + match[0]); if (!link || link.target.startsWith('#')) return []
          let path: string | null = null
          if (link.kind === 'file') {
            try { const raw = decodeURIComponent(link.target); const normal = posix.normalize(posix.join(posix.dirname(part.path!), raw)); ws.absolute(normal); path = normal } catch { /* unresolved references are retained */ }
          }
          return [{ ...link, path }]
        }),
      ]
      for (const citation of cited) {
        const key = citation.path ? 'path:' + citation.path : citation.kind === 'note' ? 'note:' + evidencePartKey(citation.target) : evidenceKey(citation.target, citation.kind)
        let row = placed.get(key)
        if (!row) {
          row = { key, kind: citation.kind, target: citation.target, title: citation.label, path: citation.path, origins: [], item: null, removable: false, state: citation.kind === 'zotero' ? 'Zotero not available' : citation.path || citation.kind === 'archive' ? 'ready' : 'missing', highlights: [] }
          model.rows.push(row); placed.set(key, row)
        }
        if (!row.origins.includes('cited in the text')) row.origins.push('cited in the text')
      }
    }
    // Validate after merging: highlights from every duplicate section use the same source version.
    for (const row of model.rows) if (row.path && (row.kind === 'file' || row.kind === 'note')) {
      try {
        if (!row.highlights.some(highlight => highlight.quote !== null)) { await sourceStat(ws, row.path); continue }
        const text = await quoteText(ws, row.path)
        if (text === null) { await sourceStat(ws, row.path); continue }
        const words = normaliseQuote(text)
        row.highlights = row.highlights.map(highlight => ({ ...highlight, ...(highlight.quote !== null && !words.includes(normaliseQuote(highlight.quote)) ? { state: 'not in the file any more' } : {}) }))
      } catch { row.state = 'missing' }
    }
    answer.parts[evidencePartKey(part.title)] = model
  }
  const zoteroRows = Object.values(answer.parts).flatMap(part => part.rows.filter(row => row.kind === 'zotero'))
  const requests = [...new Map(zoteroRows.map(row => [row.target, { target: row.target, highlights: [...(row.target.includes('?annotation=') ? [row.target] : []), ...zoteroRows.filter(other => other.target === row.target).flatMap(other => other.highlights.flatMap(highlight => highlight.target ? [highlight.target] : []))] }])).values()]
  const facts = await readFolioZoteroEvidence(requests)
  for (const row of zoteroRows) {
    const live = facts.find(fact => fact.target === row.target)
    row.state = live?.state ?? 'Zotero not available'
    if(live?.itemTarget && row.item===null) { row.target=live.itemTarget;row.key=evidenceKey(live.itemTarget,'zotero') }
    row.sourceTitle = live?.title
    row.citationLabel = live?.label ?? row.title.replace(/^⟨|⟩$/g, '')
    row.citation = row.target
    row.highlights = row.highlights.map(highlight => {
      const quote = live?.highlights.find(value => value.target === highlight.target)
      return { ...highlight, quote: quote?.quote ?? null, citation: quote?.label, ...(quote ? quote.bodyKind && quote.bodyKind !== 'quote' ? {state:quote.bodyKind === 'note' ? 'Reader note in Zotero' : 'Page mark in Zotero'} : {} : { state: live?.state === 'ready' ? 'highlight deleted in Zotero' : live?.state ?? 'Zotero not available' }) }
    })
  }
  for(const part of Object.values(answer.parts)) {
    const rows=new Map<string,RoomEvidenceRow>()
    for(const row of part.rows) {
      const key=row.kind==='zotero'?evidenceKey(row.target,'zotero'):row.key
      const previous=rows.get(key)
      if(!previous){rows.set(key,row);continue}
      for(const origin of row.origins)if(!previous.origins.includes(origin))previous.origins.push(origin)
      for(const highlight of row.highlights)if(!previous.highlights.some(value=>value.key===highlight.key))previous.highlights.push(highlight)
      if(!previous.item && row.item){previous.item=row.item;previous.removable=row.removable}
    }
    part.rows=[...rows.values()]
  }
  answer.orphans = document.sections.filter(section => !parts.some(part => evidencePartKey(part.title) === evidencePartKey(section.title))).map(section => ({ title: section.title, notes: section.notes?.raw.trimEnd() ?? '' }))
  return answer
}
