// The floating Scratchpad's item model: the shapes main and renderer share, and the pure parts of the
// panel (scope, typed search, lists, arrival-day sections, fragment statistics). No I/O here.
// Design: docs/design/2026-10-28-floating-scratchpad/ (ADR-0050). Exact text and local visual assets
// share collection metadata; document inventory is a derived positional projection.

export type ScratchKind = 'text' | 'pic' | 'svg' | 'table' | 'widget' | 'ref' | 'evidence'
/** The kinds that name one complete local visual object in a document (collectable and type-checked as such). */
export type ScratchAssetKind = 'pic' | 'svg' | 'table' | 'widget'
export const SCRATCH_KIND_LABELS: Record<ScratchKind, string> = { text: 'Text', pic: 'Picture', svg: 'SVG', table: 'Table', widget: 'Widget', ref: 'Reference', evidence: 'Evidence' }
/** How a lossless text item was captured. `null` is a legacy scrap whose capture is unknown: it is
 *  never presented as a cutting (spec §7.4). */
export type ScratchHow = 'cut' | 'copy' | null
export type ScratchStatus = 'active' | 'rejected'
export type ScratchScope = 'folio' | 'document' | 'workspace'
export type ScratchList = 'candidates' | 'document' | 'rejected'

/** One explicit, app-recorded insertion of an item into a document. Placement is never inferred from
 *  matching prose; only these records (made by Insert a copy / Put back) say an item is used. */
export interface ScratchUse {
  useId: string
  path: string
  mode: 'copy' | 'put-back'
  at: string
  /** The editor session whose anchor stands for this use (set by main from the calling window). */
  holder?: string
  /** On a listing only: that session is gone (the document was closed with the app or its window), so
   *  the anchor that made this claim checkable no longer exists. Never stored. */
  unverified?: true
  /** A Board/agent copy-for-reuse record: it says the payload WAS copied to `path` at `at`, never that
   *  the words are there now (no editor anchor stands for it, and Undo of the receiving step leaves
   *  this historical record standing). The candidate itself stays in Candidates, reusable. */
  historical?: true
}

/** Main's typed receipt for ONE accepted agent Put back (ticket 04 correction): the exact fragment
 *  main wrote, at its exact offsets in the written document's editor form. The accepting window's
 *  editor turns it into an explicit anchor on the SAME transaction that takes the accepted text;
 *  until that anchor exists no placed use is recorded anywhere. Never supplied by a renderer. */
export interface ScratchPlacementReceipt {
  itemId: string
  useId: string
  path: string
  markdown: string
  from: number
  to: number
}

export interface ScratchGroup { id: string; name: string }

/** A raw-editor span the live writing content excludes (a pending old-role span in Reviewing).
 *  The one coordinate contract for inventory: a live buffer travels as its RAW editor text plus
 *  these spans; inventory parses the writing content (raw minus the spans) and reports every
 *  position back in raw coordinates, so navigation selects what the writer sees. */
export interface ScratchRemovedSpan { from: number; to: number }
/** One window's live buffer for inventory: raw editor text, or null when owned but unavailable. */
export interface ScratchLiveBuffer { path: string; content: string | null; removedSpans?: ScratchRemovedSpan[] }

/** The canonical evidence identity a Reference or Evidence item points at (ticket 03). Identity and
 *  provenance are the existing Folio evidence/Zotero/archive records' own — `citationId` is the
 *  evidence store's key (`evidenceKey`), never a second id scheme, and never inferred from prose. */
export interface ScratchSourceRef {
  /** The canonical source id inside the Folio's evidence: `ref:<evidenceKey>` or
   *  `ev:<evidenceKey>#<highlightKey>` for one quoted highlight of that source. */
  sourceId: string
  citationId: string
  evidenceKind: 'file' | 'note' | 'zotero' | 'archive'
  /** The canonical target as the evidence record holds it (a zotero:// item, an archive URL, a note title, a
   *  Folio-relative file target). */
  target: string
  /** The citation label the evidence record formats (author–year), used for the chip. */
  label: string
  /** The source's own title when the record carries one. */
  sourceTitle?: string
  /** The quoted words (evidence items); null when the canonical record cannot confirm them now. */
  quote?: string | null
  /** The highlight's own target (a Zotero annotation link) when the evidence item names one. */
  highlightTarget?: string | null
  /** The page-aware citation label of the highlight, when the record formats one. */
  highlightLabel?: string | null
  /** The resolved workspace-relative file for file/note sources, null when it does not resolve. */
  sourcePath?: string | null
  /** The Folio part (title) this source was collected from. */
  sourcePart?: string
  /** The canonical record's state when last read ('ready', 'missing', a Zotero state, …). */
  state?: string
  /** Part titles this source is attached to as evidence, as the canonical record said last time. */
  attachedParts?: string[]
}

/** One canonical Folio source or quoted highlight, projected as a candidate card. Nothing here is a
 *  copy of the record: collecting keeps this pointer and a preview, and every action re-reads the
 *  canonical evidence before it writes. */
export interface ScratchSource {
  sourceId: string
  kind: 'ref' | 'evidence'
  ref: ScratchSourceRef
  title: string
  /** The preview Markdown (the citation chip for a reference, the quote for evidence). Derived, never the payload. */
  preview: string
  /** The part document this source was read from (the collected item's origin). */
  originPath: string
  heading: string | null
  /** Set when the canonical source cannot be acted on as it stands (missing, Zotero unavailable, …). */
  problem?: string
  /** The item id once collected, so the panel shows the collected card instead of the pointer. */
  collectedId?: string
}

/** The external provenance of a collected TalkWeaver/SlideWell candidate (ticket 05). The stored
 *  payload is only its preview; `providerId` is the source app's own identity for the shown asset
 *  (a TalkWeaver vault + vault-relative file, or a SlideWell `well:`/`triage:` id) and `sha256`
 *  the shown version's checked bytes. Nothing here is a filesystem authority: main re-derives
 *  the root from the enabled source's own registry/catalogue, revalidates the pointer and the
 *  digest at insert, and refuses when the source changed. Additive: older records have no
 *  `external` field and are read exactly as before. */
export interface ScratchExternalRef {
  source: 'talkweaver' | 'slidewell'
  /** TalkWeaver: `vault:<vaultId>:<vault-relative path>`; SlideWell: its `well:<id>`/`triage:<hash>`. */
  providerId: string
  kind: 'pic' | 'widget'
  /** The file's own name (`img-ab12cd3.png`, `research-loop.svg`), never a path with folders. */
  fileName: string
  title: string
  /** Human provenance as the source stated it, e.g. `TalkWeaver · workshop-slides-2026`. */
  provenance: string
  /** SHA-256 and size of the checked source bytes the writer was shown (collect and proposal). */
  sha256: string
  bytes: number
  /** SlideWell semantic match (0..1) when the result came from the picture service. */
  score?: number
  /** Set when the shown bytes cannot be inserted as they stand (an incompatible widget page, a
   *  picture type WriteFlex cannot keep); the card says so instead of pretending otherwise. */
  incompatible?: string
  /** A small preview of the shown bytes (data URI, capped in main); never the asset itself. */
  previewDataUri?: string
  /** The local owned copy a first insertion made (workspace-relative, in the receiving
   *  document/Folio `assets/`), and its digest. Later inserts reuse it — checked, never silently. */
  importedPath?: string
  importedSha256?: string
}

/** One connected TalkWeaver vault, as TalkWeaver's own registry names it (read-only adapter). */
export interface ScratchExternalVault {
  id: string
  name: string
  /** What browsing found there, in words (`148 pictures`), or why it cannot be browsed now. */
  note: string
  available: boolean
}

/** A connection's state, for Settings and its Scratchpad tab. `off` is answered without any
 *  discovery at all (no registry, catalogue, database or socket is touched while off). */
export interface ScratchExternalStatus {
  source: 'talkweaver' | 'slidewell'
  state: 'off' | 'connected' | 'unavailable'
  /** What is wrong, in one sentence, when the state is `unavailable`. */
  reason?: string
  /** TalkWeaver: every vault its registry names, open or not (Settings chooses among the open). */
  vaults?: ScratchExternalVault[]
  /** TalkWeaver: the vault ids the writer chose to browse, that are still there and open. */
  chosenVaults?: string[]
  /** SlideWell: its readable catalogue can be word-searched/browsed without the app running. */
  catalogue?: boolean
  /** SlideWell: the local picture service (semantic search) is running. */
  semantic?: boolean
}

/** One search result from a connected source. `handle` is main's opaque, epoch-bound authority
 *  for exactly this shown version; the renderer and the agent can never name a path or provider. */
export interface ScratchExternalResult {
  handle: string
  source: 'talkweaver' | 'slidewell'
  kind: 'pic' | 'widget'
  title: string
  /** Where it stands, in words (`TalkWeaver · dominiks-presentations-library`, `SlideWell · match 0.82`). */
  provenance: string
  detail?: string
  score?: number
  previewDataUri?: string
  /** Set when this result cannot be inserted as it stands; shown on the card, never hidden. */
  incompatible?: string
  /** The collected item's id once collected, so the tab can say so instead of offering it twice. */
  collectedId?: string
}

export interface ScratchItem {
  /** `p_…` for lossless items; `legacy:<origin>#<s_…>` for a scrap read from a SCRAPS.md file. */
  id: string
  source: 'lossless' | 'legacy' | 'document' | 'canonical'
  kind: ScratchKind
  how: ScratchHow
  by: 'writer' | 'agent'
  /** ISO time it was set aside; null for legacy scraps (their files carry no time). */
  createdAt: string | null
  /** Workspace-relative path of the document it came from, and the heading it sat under. It follows
   *  app-owned renames and moves; `base` is the folder relative links resolve from when that is no
   *  longer the document's own (the document moved without its pictures). */
  origin: { path: string; heading: string | null; base?: string; capturedSpan?: { from: number; to: number; line: number } }
  title: string
  /** The exact Markdown, byte for byte as captured (lossless) or as the legacy reader projects it. */
  markdown: string
  group: string | null
  status: ScratchStatus
  done: boolean
  colour?: string
  expandTrigger?: string
  uses: ScratchUse[]
  /** Said to the writer on the card, e.g. the payload changed on disk since it was saved. */
  problem?: string
  /** Derived source span, never a stored identity or hidden document marker. */
  document?: { from: number; to: number; line: number; basis: 'live' | 'disk' }
  /** Reference/Evidence pointer and provenance (kinds `ref`/`evidence`, collected or canonical). */
  ref?: ScratchSourceRef
  /** External-source pointer and provenance (ticket 05): a collected TalkWeaver/SlideWell
   *  candidate. Its payload is only a preview; insertion revalidates this pointer in main. */
  external?: ScratchExternalRef
  /** A cited reference in the document inventory: how often its canonical citation id is cited and
   *  the exact source range of every citation. `document` is the first of these. */
  cited?: { count: number; positions: Array<{ from: number; to: number; line: number; markdown: string }> }
  /** Opaque checked version of the body (and, for lossless items, its record) as this listing read
   *  it. A confirmation (Delete forever, the approval-bound `scratchpad.delete` verb) carries it
   *  back, so a body changed while the confirmation waited refuses instead of being silently
   *  re-authorised by a fresh read. Derived on read; never stored. */
  version?: string
}

export interface ScratchSnapshot {
  items: ScratchItem[]
  groups: ScratchGroup[]
  /** Records that could not be read, said as they are; nothing named here was rewritten or deleted. */
  notices: string[]
  /** The Folio folder the asking document belongs to ('' the workspace folder), or null for none. */
  folioDir: string | null
}

export type ScratchReply<T = Record<string, never>> = ({ ok: true } & T) | { ok: false; error: string }

/** A canonical source shown as a candidate card before it is collected. It is a pointer, not an item:
 *  it cannot be ticked, rejected or inserted; Collect to Scratchpad is its one action. */
export function sourceItemOf(source: ScratchSource): ScratchItem {
  return {
    id: `source:${source.sourceId}`, source: 'canonical', kind: source.kind, how: 'copy', by: 'writer', createdAt: null,
    origin: { path: source.originPath, heading: source.heading }, title: source.title, markdown: source.preview,
    group: null, status: 'active', done: false, uses: [], ref: source.ref,
    ...(source.problem ? { problem: source.problem } : {}),
  }
}

/** The four distinct acts of spec §5. `quote` inserts content, `cite`/`link` add an inline reference
 *  or link, `attach` writes no text at all. One act is never silently another. */
export type ScratchReferenceAction = 'quote' | 'cite' | 'link' | 'attach'

/** A lossless Scratchpad item's id (`p_…`), as opposed to a legacy scrap's (`s_…`, or `legacy:…` here). */
export const isLosslessItemId = (id: string): boolean => /^p_[0-9a-z]{6,40}$/.test(id)

/** A put-back makes the item placed: it leaves Candidates while its anchor can still confirm it. A
 *  put-back whose editor session is gone is unverified and holds nothing (spec §7.6, ticket 01 R4). */
export const isPlaced = (item: Pick<ScratchItem, 'uses'>): boolean => item.uses.some((use) => use.mode === 'put-back' && !use.unverified)

/** The folder relative links in an item's Markdown resolve from (its origin's, unless it moved apart). */
export const linkBaseOf = (item: Pick<ScratchItem, 'origin'>): string => item.origin.base ?? (item.origin.path.includes('/') ? item.origin.path.slice(0, item.origin.path.lastIndexOf('/')) : '')

/** Said on the card when an earlier put-back can no longer be confirmed. */
export function unverifiedNote(item: Pick<ScratchItem, 'uses'>, partName: (path: string) => string = defaultPartName): string | null {
  const lost = item.uses.find((use) => use.mode === 'put-back' && use.unverified)
  if (!lost || isPlaced(item)) return null
  return `Put back in ${partName(lost.path)} earlier. WriteFlex can no longer confirm it is still there (the document was closed), so it is a candidate again.`
}

/** Put back is offered only for a recorded cut (never for a copy or a legacy scrap of unknown kind). */
export const canPutBack = (item: Pick<ScratchItem, 'how' | 'source' | 'uses'> & { kind?: ScratchKind }): boolean => (item.kind === undefined || item.kind === 'text') && item.source === 'lossless' && item.how === 'cut' && !isPlaced(item)

// ── Fragment statistics and titles (derived; the payload stays authoritative) ─────────────────

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** Paragraph-like blocks (runs of non-blank lines outside fences count as one; a fence counts as one)
 *  and words of prose. A display count, not a parse. */
export function fragmentStats(markdown: string): { paragraphs: number; words: number } {
  let paragraphs = 0
  let words = 0
  let inBlock = false
  let fence: string | null = null
  for (const raw of markdown.split(/\r\n|\n|\r/)) {
    const line = raw
    if (fence) {
      if (line.trimStart().startsWith(fence)) fence = null
      continue
    }
    const open = FENCE.exec(line)
    if (open) { fence = open[1]; paragraphs += 1; inBlock = false; continue }
    if (line.trim() === '') { inBlock = false; continue }
    if (!inBlock) { paragraphs += 1; inBlock = true }
    words += line.replace(/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?)/, '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  }
  return { paragraphs, words }
}

/** The first heading's text, or the first words; never empty. */
export function fragmentTitle(markdown: string): string {
  let fence: string | null = null
  let first = ''
  for (const line of markdown.split(/\r\n|\n|\r/)) {
    if (fence) { if (line.trimStart().startsWith(fence)) fence = null; continue }
    const open = FENCE.exec(line)
    if (open) { fence = open[1]; continue }
    const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading && heading[1]) return plainInline(heading[1])
    if (!first && line.trim()) first = plainInline(line.replace(/^\s*(?:[-*+]\s|\d+[.)]\s|>\s?)+/, ''))
  }
  const words = first.split(/\s+/).filter(Boolean)
  const title = words.slice(0, 9).join(' ')
  return title ? (words.length > 9 ? `${title}…` : title) : 'Empty fragment'
}

function plainInline(text: string): string {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~]+/g, '').replace(/\s+/g, ' ').trim()
}

// ── Scope: Folio across parts, the single document, or everything ─────────────────────────────

/** Whether `path` lies in `dir` ('' is the workspace folder). */
export const inFolder = (path: string, dir: string): boolean => dir === '' || path.startsWith(`${dir}/`)

export function inScope(item: Pick<ScratchItem, 'origin'>, scope: ScratchScope, context: { activePath: string | null; folioDir: string | null }): boolean {
  if (scope === 'workspace') return true
  if (scope === 'folio' && context.folioDir !== null) return inFolder(item.origin.path, context.folioDir)
  return context.activePath !== null && item.origin.path === context.activePath
}

/** What the scope menu offers: a Folio only when the document is in one. */
export function effectiveScope(scope: ScratchScope, folioDir: string | null): ScratchScope {
  return scope === 'folio' && folioDir === null ? 'document' : scope
}

// ── Lists ──────────────────────────────────────────────────────────────────────────────────────

export function listOf(item: ScratchItem): ScratchList {
  if (item.source === 'document') return 'document'
  if (item.status === 'rejected') return 'rejected'
  return isPlaced(item) ? 'document' : 'candidates'
}

// ── Search: typed prefixes and chips are one state (the query text) ────────────────────────────

/** The typed prefixes the search understands. Only `text` has items in ticket 01; the rest parse so a
 *  typed prefix never reads as a plain word. */
export const SEARCH_KINDS = ['text', 'pic', 'svg', 'table', 'widget', 'ref', 'evidence'] as const
export type SearchKind = (typeof SEARCH_KINDS)[number]
export interface ParsedQuery { kinds: SearchKind[]; from: string[]; terms: string[] }

const PREFIX = /^(text|pic|svg|table|widget|ref|evidence):(.*)$/i

function words(text: string): string[] {
  const out: string[] = []
  const re = /(?:[^\s"]+:)?"[^"]*"|\S+/g
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[0])
  return out
}

export function parseQuery(query: string): ParsedQuery {
  const parsed: ParsedQuery = { kinds: [], from: [], terms: [] }
  const list = words(query.trim())
  for (let i = 0; i < list.length; i++) {
    const word = list[i]
    const prefix = PREFIX.exec(word)
    if (prefix) {
      const kind = prefix[1].toLowerCase() as SearchKind
      if (!parsed.kinds.includes(kind)) parsed.kinds.push(kind)
      const rest = prefix[2].replace(/"/g, '').toLowerCase()
      if (rest) parsed.terms.push(rest)
      continue
    }
    const from = /^from:(.*)$/i.exec(word)
    if (from) {
      let value = from[1]
      if (!value && i + 1 < list.length) value = list[++i]
      value = value.replace(/"/g, '').toLowerCase()
      if (value) parsed.from.push(value)
      continue
    }
    const term = word.replace(/"/g, '').toLowerCase()
    if (term) parsed.terms.push(term)
  }
  return parsed
}

/** A chip click: adds `<kind>:` in front, or takes that prefix off. */
export function toggleKindInQuery(query: string, kind: SearchKind): string {
  const own = new RegExp(`^${kind}:`, 'i')
  const out: string[] = []
  let found = false
  for (const word of words(query.trim())) {
    if (own.test(word)) {
      found = true
      const rest = word.replace(own, '')
      if (rest) out.push(rest)
    } else out.push(word)
  }
  if (!found) out.unshift(`${kind}:`)
  return out.join(' ')
}

export function matchesQuery(item: ScratchItem, parsed: ParsedQuery): boolean {
  if (parsed.kinds.length > 0 && !parsed.kinds.includes(item.kind)) return false
  const origin = item.origin.path.toLowerCase()
  if (!parsed.from.every((word) => origin.includes(word))) return false
  if (parsed.terms.length === 0) return true
  const refHay = item.ref ? `\n${item.ref.label}\n${item.ref.sourceTitle ?? ''}\n${item.ref.target}\n${item.ref.quote ?? ''}\n${item.ref.sourcePart ?? ''}` : ''
  const extHay = item.external ? `\n${item.external.provenance}\n${item.external.fileName}` : ''
  const hay = `${item.title}\n${item.markdown}\n${item.origin.path}\n${item.origin.heading ?? ''}${refHay}${extHay}`.toLowerCase()
  return parsed.terms.every((term) => hay.includes(term))
}

/** Runs of `text`, marking those that contain one of the terms (terms under 2 letters are ignored). */
export function highlightSegments(text: string, terms: readonly string[]): Array<{ text: string; hit: boolean }> {
  const usable = [...new Set(terms.filter((term) => term.length >= 2))]
  if (usable.length === 0 || text === '') return [{ text, hit: false }]
  const escaped = usable.sort((a, b) => b.length - a.length).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'ig')
  const out: Array<{ text: string; hit: boolean }> = []
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false })
    out.push({ text: m[0], hit: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false })
  return out
}

export type GroupFilter = 'all' | 'ungrouped' | string

export interface VisibleOptions {
  list: ScratchList
  scope: ScratchScope
  activePath: string | null
  folioDir: string | null
  group: GroupFilter
  query: string
}

/** Items in scope and in the list, filtered by group and search; newest first, legacy after. */
export function visibleItems(items: readonly ScratchItem[], options: VisibleOptions): ScratchItem[] {
  const parsed = parseQuery(options.query)
  const scope = effectiveScope(options.scope, options.folioDir)
  return items
    .filter((item) => listOf(item) === options.list)
    .filter((item) => inScope(item, scope, options))
    .filter((item) => (options.group === 'all' ? true : options.group === 'ungrouped' ? item.group === null : item.group === options.group))
    .filter((item) => matchesQuery(item, parsed))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
}

export function listCounts(items: readonly ScratchItem[], options: Omit<VisibleOptions, 'list' | 'group' | 'query'>): Record<ScratchList, number> {
  const scope = effectiveScope(options.scope, options.folioDir)
  const counts: Record<ScratchList, number> = { candidates: 0, document: 0, rejected: 0 }
  for (const item of items) if (inScope(item, scope, options)) counts[listOf(item)] += 1
  return counts
}

export interface ItemSection { key: string; label: string; items: ScratchItem[] }

/** Locally saved candidates share day sections (“Added today”); legacy scraps, which carry no time,
 *  are grouped by their origin file as the old pane grouped them. */
export function daySections(items: readonly ScratchItem[], now: Date = new Date()): ItemSection[] {
  const sections: ItemSection[] = []
  const byKey = new Map<string, ItemSection>()
  const day = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = day(now)
  const yesterday = day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  for (const item of items) {
    let key: string
    let label: string
    if (item.source === 'canonical') {
      key = 'canonical'
      label = 'From the Folio’s evidence'
    } else if (item.createdAt) {
      const when = new Date(item.createdAt)
      key = day(when)
      label = key === today ? 'Added today' : key === yesterday ? 'Added yesterday' : `Added ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(when)}`
    } else {
      key = `legacy:${item.origin.path}`
      label = `From ${item.origin.path.split('/').pop() ?? item.origin.path}`
    }
    let section = byKey.get(key)
    if (!section) {
      section = { key, label, items: [] }
      byKey.set(key, section)
      sections.push(section)
    }
    section.items.push(item)
  }
  return sections
}

/** Short origin wording for a card badge: “Cut from …”, “Copied from …” or “Saved scrap · …”. */
export function originLabel(item: Pick<ScratchItem, 'how' | 'origin' | 'by'> & Partial<Pick<ScratchItem, 'kind' | 'ref' | 'source' | 'external'>>, partName: (path: string) => string = defaultPartName): string {
  if (item.external) return item.external.provenance
  if (item.by === 'agent') return 'Suggested by the agent'
  if ((item.kind === 'ref' || item.kind === 'evidence') && item.ref) {
    const part = item.ref.sourcePart ?? partName(item.origin.path)
    return item.source === 'canonical' ? `From the Folio's evidence · ${part}` : `Collected · ${part}`
  }
  const part = partName(item.origin.path)
  if (item.how === 'cut') return `Cut from ${part}`
  if (item.how === 'copy') return `Copied from ${part}`
  return `Saved scrap · ${part}`
}

export const defaultPartName = (path: string): string => (path.split('/').pop() ?? path).replace(/\.(md|markdown|mdx)$/i, '')

export function statsLabel(markdown: string): string {
  const { paragraphs, words } = fragmentStats(markdown)
  const w = `${words} ${words === 1 ? 'word' : 'words'}`
  return paragraphs === 1 ? `1 paragraph · ${w}` : `${paragraphs} paragraphs · ${w}`
}

// ── The preload bridge (src/main/scratchpad-ipc.ts answers it) ─────────────────────────────────

/** Every call names the folder the renderer believes it is in (`root`); main refuses a stale one. */
type Rooted<T = Record<string, never>> = { root: string } & T
export interface ScratchpadBridge {
  list(input: Rooted<{ activePath: string | null }>): Promise<ScratchReply<{ snapshot: ScratchSnapshot }>>
  collectAsset(input: Rooted<{ origin: string; markdown: string; kind: ScratchAssetKind; from: number; to: number }>): Promise<ScratchReply<{ item: ScratchItem }>>
  inventory(input: Rooted<{ activePath: string; scope: 'part' | 'folio' }>): Promise<ScratchReply<{ items: ScratchItem[]; notices: string[] }>>
  sendText(input: Rooted<{ origin: string; markdown: string; heading?: string | null }>): Promise<ScratchReply<{ item: ScratchItem }>>
  /** The Folio's canonical sources and quoted highlights as collectable candidate cards. Read-only:
   *  the evidence records are projected, never copied or rewritten. */
  sources(input: Rooted<{ activePath: string }>): Promise<ScratchReply<{ sources: ScratchSource[]; notices: string[] }>>
  /** Keep a pointer to one canonical source as a Reference/Evidence candidate. Main re-derives the
   *  source from the canonical evidence by `sourceId`; the renderer's copy is never stored. */
  collectSource(input: Rooted<{ activePath: string; sourceId: string }>): Promise<ScratchReply<{ item: ScratchItem }>>
  /** The exact Markdown an act would write into `destination`, prepared from the canonical record
   *  as it stands now. `inline` lands at the caret; `block` after the caret's paragraph. */
  prepareReference(input: Rooted<{ id: string; action: Exclude<ScratchReferenceAction, 'attach'>; destination: string }>): Promise<ScratchReply<{ markdown: string; style: 'inline' | 'block'; label: string }>>
  /** Attach the item's canonical source to the part that owns `destination`, through the existing
   *  evidence operation (expectation guard + restore point). `token` undoes exactly this attach. */
  attachReference(input: Rooted<{ id: string; destination: string }>): Promise<ScratchReply<{ token: string | null; part: string; label: string; message: string }>>
  undoAttach(input: Rooted<{ token: string; destination: string; id: string }>): Promise<ScratchReply<{ message: string }>>
  /** Internal capture phases. Main owns the reservation holder; no user-facing status is added. */
  reserveCut(input: Rooted<{ id: string }>): Promise<ScratchReply>
  cancelCut(input: Rooted<{ id: string }>): Promise<ScratchReply>
  confirmCut(input: Rooted<{ id: string }>): Promise<ScratchReply>
  discardCopy(input: Rooted<{ id: string }>): Promise<ScratchReply>
  /** Delete forever, from the Rejected list only and behind the panel's confirmation: main re-checks
   *  the stored item (owner, status, version, payload digest) before removing anything. */
  deleteForever(input: Rooted<{ id: string; version: string }>): Promise<ScratchReply>
  setStatus(input: Rooted<{ ids: string[]; status: ScratchStatus }>): Promise<ScratchReply>
  setGroup(input: Rooted<{ ids: string[]; group: string | null }>): Promise<ScratchReply>
  createGroup(input: Rooted<{ name: string }>): Promise<ScratchReply<{ group: ScratchGroup }>>
  toggleDone(input: Rooted<{ id: string }>): Promise<ScratchReply>
  setColour(input: Rooted<{ id: string; colour: string | null }>): Promise<ScratchReply>
  recordUse(input: Rooted<{ id: string; use: { useId: string; path: string; mode: 'copy' | 'put-back' } }>): Promise<ScratchReply>
  dropUse(input: Rooted<{ id: string; useId: string }>): Promise<ScratchReply>
  /** This window's editor opened `path` afresh: its uses there other than `keep` lost their anchor. */
  releaseUses(input: Rooted<{ path: string; keep: string[] }>): Promise<ScratchReply<{ dropped: number }>>
  prepareInsert(input: Rooted<{ id: string; destination: string }>): Promise<ScratchReply<{ markdown: string; rewritten: number }>>
  /** The checked widget bytes for a sealed preview, read once in main under the item's current
   *  authority (a saved item by id, or a document asset by its exact source span). The returned
   *  `html` is exactly what passed the compatibility check; `markdown` is the current payload the
   *  bytes belong to, so a stale panel snapshot can be told to refresh instead of running. */
  prepareWidgetPreview(input: Rooted<{ id: string } | { origin: string; markdown: string; from: number; to: number }>): Promise<ScratchReply<{ html: string; title: string; markdown: string }>>
  /** One optional source's connection state (ticket 05). While the source's Settings switch is
   *  off, main answers `off` without any discovery — no registry, catalogue, database or socket
   *  read happens behind this call. Not folder-bound in effect, but it travels the same rooted
   *  channel discipline as every other Scratchpad call. */
  externalStatus(input: Rooted<{ source: 'talkweaver' | 'slidewell' }>): Promise<ScratchReply<{ status: ScratchExternalStatus }>>
  /** Search one ENABLED source. Results carry opaque epoch-bound handles only — never a path.
   *  `vault` narrows TalkWeaver to one chosen vault (`all` = every chosen vault); `mode` picks
   *  SlideWell's readable-catalogue word search or its running picture service. An empty query
   *  browses (newest first, bounded). */
  externalSearch(input: Rooted<{ source: 'talkweaver' | 'slidewell'; query: string; vault?: string; mode?: 'words' | 'meaning' }>): Promise<ScratchReply<{ results: ScratchExternalResult[]; status: ScratchExternalStatus; note?: string }>>
  /** Keep one result as a Candidate: a pointer plus a small preview. No asset bytes are copied
   *  into the workspace by collecting; that happens only on insertion. */
  externalCollect(input: Rooted<{ handle: string; activePath: string; group?: string | null }>): Promise<ScratchReply<{ item: ScratchItem }>>
  /** The writer pressed Insert a copy on a collected external candidate: main revalidates the
   *  pointer and the shown version against the still-enabled source, copies ONLY those checked
   *  bytes into the destination's `assets/` (exclusive, never an overwrite; an earlier local
   *  copy is reused after a checked read), records the copy on the item, and returns the exact
   *  Markdown for the editor to insert at the caret. */
  externalImport(input: Rooted<{ id: string; destination: string }>): Promise<ScratchReply<{ markdown: string; copied: boolean }>>
  onReadBuffersRequested(fn: (request: { id: string; root: string; paths: string[] }) => void): () => void
  answerBuffers(input: { id: string; root: string; buffers: ScratchLiveBuffer[] }): Promise<void>
  onChanged(fn: () => void): () => void
}
