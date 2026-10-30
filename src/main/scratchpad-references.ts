/**
 * Folio References and Evidence in the Scratchpad (ticket 03, spec §5–§8).
 *
 * The canonical records already exist: the Folio evidence file, each part's sources and citations,
 * and the Zotero/archive representations the Folio room reads (`readEvidence`). This module only
 * projects them into candidate cards and runs the four distinct acts over them. It creates no
 * second evidence database and never rewrites a source record: collecting keeps a typed pointer,
 * every action re-reads the canonical evidence before it writes, and Attach goes through the
 * existing `attachEvidence` operation with its expectation guard and restore-point contract.
 */
import type { Workspace } from './workspace'
import type { ScratchpadStore } from './scratchpad-store'
import { readEvidence, attachEvidence, undoEvidence, evidencePath } from './folio-evidence'
import { readLiveOwnerProjections } from './scratchpad-inventory'
import { FolioWorkspace } from './folio-workspace'
import { folioKey } from './folio-dir'
import { readFolioPlan } from './plan'
import { evidencePartKey, type RoomEvidenceRow } from '../shared/folio-evidence'
import type { EvidenceTransfer } from '../shared/folio-evidence-transfer'
import type { ScratchItem, ScratchReferenceAction, ScratchSource, ScratchSourceRef } from '../shared/scratchpad-items'
import { referenceMarkdown, type PreparedReferenceMarkdown } from '../shared/scratchpad-reference-actions'

export type EvidenceCheckpoint = (path: string) => Promise<void>

const REF_GROUP = 'References'
const MISSING = 'The file is not at its last known place. The card keeps its title; the document is not affected.'

function problemOf(row: RoomEvidenceRow): string | undefined {
  if (row.state === 'missing') return MISSING
  if (row.state === 'changed since attached') return 'This source changed since it was attached. Check it before relying on it.'
  if (row.state !== 'ready') return row.state
  return undefined
}

function refOf(row: RoomEvidenceRow, partTitle: string, attachedParts: string[]): ScratchSourceRef {
  return {
    sourceId: `ref:${row.key}`,
    citationId: row.key,
    evidenceKind: row.kind,
    target: row.target,
    label: row.citationLabel ?? row.title.replace(/^⟨|⟩$/g, ''),
    ...(row.sourceTitle ? { sourceTitle: row.sourceTitle } : row.kind === 'archive' || row.kind === 'zotero' ? {} : { sourceTitle: row.title.replace(/^⟨|⟩$/g, '') }),
    sourcePath: row.path,
    sourcePart: partTitle,
    state: row.state,
    attachedParts,
  }
}

/** The Folio that owns `activePath`, its Plan parts and the merged canonical evidence over them. */
async function folioEvidence(ws: Workspace, store: ScratchpadStore, activePath: string): Promise<{
  dir: string
  parts: Array<{ title: string; path: string | null }>
  rowsOf: (title: string) => RoomEvidenceRow[]
  notices: string[]
} | { notices: string[] }> {
  const active = store.documentPath(activePath)
  const dir = store.folioDirFor(active)
  if (dir === null) return { notices: [] }
  const plan = await readFolioPlan(ws, dir)
  if (!plan) return { notices: ['The Folio could not be read, so its references and evidence are unavailable.'] }
  const parts = [...plan.parts, ...plan.unlisted].map(part => ({ title: part.title, path: part.path && !part.resolution ? part.path : null }))
  // Canonical identity and attached evidence still come from `readEvidence` alone. Parts with a
  // current/cached unsaved owner contribute their live writing content (raw minus Reviewing's
  // excluded spans) through its given-content argument, so an unsaved citation can be collected
  // before save. A blocked owner (unavailable/conflicting/inconsistent) is handed empty given
  // content with a notice — its cited rows stay absent rather than stale disk standing in. Only
  // parts with no live owner omit `content`, which is `readEvidence`'s read-from-disk signal.
  const livePaths = [...new Set(parts.flatMap(part => part.path ? [part.path] : []))]
  const live = await readLiveOwnerProjections(ws.root, livePaths)
  const given = parts.map(part => {
    if (part.path && live.projected.has(part.path)) return { title: part.title, path: part.path, content: live.projected.get(part.path)! }
    if (part.path && live.blocked.has(part.path)) return { title: part.title, path: part.path, content: '' }
    return { title: part.title, path: part.path }
  })
  const evidence = await readEvidence(ws, dir, given)
  const notices = [...(plan.notices ?? []), ...live.blocked.values()]
  if (evidence.state === 'unreadable') notices.push(evidence.message ?? 'The evidence file cannot be read.')
  return { dir, parts, rowsOf: (title) => evidence.parts[evidencePartKey(title)]?.rows ?? [], notices }
}

/**
 * The Folio's canonical sources as collectable cards: one Reference per distinct source across
 * the Folio's parts, and one Evidence card per quoted highlight. A source already collected is
 * marked with its item id so the panel shows the collected card, not a second pointer.
 */
export async function readCanonicalSources(ws: Workspace, store: ScratchpadStore, activePath: string): Promise<{ sources: ScratchSource[]; notices: string[] }> {
  const folio = await folioEvidence(ws, store, activePath)
  if (!('dir' in folio)) return { sources: [], notices: folio.notices }
  const fallbackOrigin = evidencePath({ root: ws.root, folioDir: folio.dir })
  const references = new Map<string, ScratchSource>()
  const evidenceCards = new Map<string, ScratchSource>()
  for (const part of folio.parts) {
    for (const row of folio.rowsOf(part.title)) {
      const attached = row.origins.includes('attached here')
      let source = references.get(row.key)
      if (!source) {
        const ref = refOf(row, part.title, attached ? [part.title] : [])
        source = {
          sourceId: ref.sourceId, kind: 'ref', ref,
          title: ref.sourceTitle?.trim() || ref.label || 'Reference',
          preview: previewOf(ref, part.path ?? fallbackOrigin),
          originPath: part.path ?? fallbackOrigin, heading: null,
          ...(problemOf(row) ? { problem: problemOf(row) } : {}),
        }
        references.set(row.key, source)
      } else if (attached && !source.ref.attachedParts?.includes(part.title)) {
        source.ref = { ...source.ref, attachedParts: [...(source.ref.attachedParts ?? []), part.title] }
      }
      for (const highlight of row.highlights) {
        if (highlight.quote === null || highlight.quote.trim() === '') continue
        const sourceId = `ev:${row.key}#${highlight.key}`
        if (evidenceCards.has(sourceId)) continue
        const ref: ScratchSourceRef = {
          ...refOf(row, part.title, attached ? [part.title] : []),
          sourceId,
          quote: highlight.quote,
          highlightTarget: highlight.target,
          ...(highlight.citation ? { highlightLabel: highlight.citation } : {}),
        }
        evidenceCards.set(sourceId, {
          sourceId, kind: 'evidence', ref,
          title: ref.sourceTitle?.trim() || ref.label || 'Evidence',
          preview: previewOf(ref, part.path ?? fallbackOrigin, true),
          originPath: part.path ?? fallbackOrigin, heading: null,
          ...(highlight.state ? { problem: highlight.state } : problemOf(row) ? { problem: problemOf(row) } : {}),
        })
      }
    }
  }
  const sources = [...references.values(), ...evidenceCards.values()]
  const collected = new Map<string, string>()
  for (const item of await store.listLossless([])) if (item.ref) collected.set(item.ref.sourceId, item.id)
  for (const source of sources) {
    const id = collected.get(source.sourceId)
    if (id) source.collectedId = id
  }
  return { sources, notices: folio.notices }
}

function previewOf(ref: ScratchSourceRef, destinationPath: string, quote = false): string {
  try {
    if (quote) return referenceMarkdown(ref, 'quote', destinationPath).markdown
    return referenceMarkdown(ref, ref.evidenceKind === 'archive' ? 'link' : 'cite', destinationPath).markdown
  } catch { return ref.sourceTitle ?? ref.label }
}

/** Collect one canonical source by id. Main re-derives it; a rendering's copy is never stored.
 *  References land in the References group, the literature-review group of the design. */
export async function collectCanonicalSource(ws: Workspace, store: ScratchpadStore, input: { activePath: string; sourceId: string; by?: 'writer' | 'agent' }): Promise<ScratchItem> {
  const { sources } = await readCanonicalSources(ws, store, input.activePath)
  const source = sources.find(candidate => candidate.sourceId === input.sourceId)
  if (!source) throw new Error('That source is not in this Folio\'s evidence any more. The list has been refreshed; nothing was collected.')
  if (source.collectedId) return store.get(source.collectedId)
  const item = await store.addSource({ origin: source.originPath, markdown: source.preview, kind: source.kind, heading: source.heading, sourceRef: source.ref, by: input.by })
  if (source.kind === 'ref') {
    const group = await store.createGroup(REF_GROUP)
    await store.setGroup([item.id], group.id)
    return store.get(item.id)
  }
  return item
}

/** The item's canonical source as it stands now, or a refusal a writer can act on. */
async function liveRef(ws: Workspace, store: ScratchpadStore, item: ScratchItem): Promise<ScratchSourceRef> {
  if ((item.kind !== 'ref' && item.kind !== 'evidence') || !item.ref) throw new Error('That item is not a reference or evidence.')
  const { sources } = await readCanonicalSources(ws, store, item.origin.path)
  const source = sources.find(candidate => candidate.sourceId === item.ref!.sourceId)
  if (!source) {
    throw new Error('That source is not in the Folio\'s evidence any more. The card is kept; reject it, or collect the source again from the Folio\'s evidence.')
  }
  if (source.ref.state === 'missing') throw new Error(`${MISSING} Nothing was written.`)
  return source.ref
}

/** The exact Markdown an act writes into `destination`, prepared from the canonical record now. */
export async function prepareCanonicalReference(ws: Workspace, store: ScratchpadStore, input: { id: string; action: Exclude<ScratchReferenceAction, 'attach'>; destination: string }): Promise<PreparedReferenceMarkdown> {
  const destination = store.documentPath(input.destination)
  const item = await store.get(input.id)
  if (item.status !== 'active') throw new Error('Move this item back to Candidates first.')
  const ref = await liveRef(ws, store, item)
  return referenceMarkdown(ref, input.action, destination)
}

function transferOf(ref: ScratchSourceRef): EvidenceTransfer {
  switch (ref.evidenceKind) {
    case 'file':
      if (!ref.sourcePath) throw new Error(MISSING)
      return { kind: 'file', path: ref.sourcePath, ...(ref.quote?.trim() ? { quote: ref.quote } : {}) }
    case 'note':
      return { kind: 'note', title: ref.target }
    case 'archive':
      return { kind: 'archive', title: ref.sourceTitle?.trim() || ref.label, url: ref.target }
    case 'zotero':
      return {
        kind: 'zotero', itemTarget: ref.target, label: ref.label,
        ...(ref.highlightTarget ? { annotation: { target: ref.highlightTarget, label: ref.highlightLabel?.replace(/^⟨|⟩$/g, '') || ref.label } } : {}),
      }
  }
}

async function destinationPart(ws: Workspace, store: ScratchpadStore, destinationInput: string): Promise<{ dir: string; title: string; path: string }> {
  const destination = store.documentPath(destinationInput)
  const dir = store.folioDirFor(destination)
  if (dir === null) throw new Error('Attach to part works inside a Folio. This document is not in one, so nothing was attached.')
  const plan = await readFolioPlan(ws, dir)
  if (!plan) throw new Error('That folder is no longer a Folio, so nothing was attached.')
  const part = [...plan.parts, ...plan.unlisted].find(candidate => candidate.path === destination && !candidate.resolution)
  if (!part) throw new Error('That document is not a part of this Folio, so nothing was attached. Open the part it should go to and attach again.')
  return { dir, title: part.title, path: destination }
}

const expectedOwnerOf = (ws: Workspace, dir: string): string => {
  const key = folioKey(ws.root, dir)
  return `${key.root}\0${key.dir}`
}

/** Attach through the existing evidence operation: expectation guard, restore point, its own Undo token. */
export async function attachCanonicalReference(
  ws: Workspace, store: ScratchpadStore,
  input: { id: string; destination: string },
  options: { session: string; checkpoint?: EvidenceCheckpoint },
): Promise<{ token: string | null; part: string; label: string; message: string }> {
  const item = await store.get(input.id)
  if (item.status !== 'active') throw new Error('Move this item back to Candidates before attaching it.')
  const part = await destinationPart(ws, store, input.destination)
  if (store.folioDirFor(item.origin.path) !== part.dir) {
    throw new Error('That source belongs to another Folio, so it was not attached here. Collect it in this Folio first.')
  }
  const ref = await liveRef(ws, store, item)
  const answer = await attachEvidence(new FolioWorkspace(ws, part.dir), part.title, transferOf(ref), {
    session: options.session,
    expectedOwner: expectedOwnerOf(ws, part.dir),
    ...(options.checkpoint ? { beforeWrite: options.checkpoint } : {}),
  })
  if (!answer.ok) throw new Error(answer.message)
  await refreshAfterEvidenceChange(ws, store, item)
  return { token: answer.token, part: part.title, label: ref.label, message: answer.message }
}

export async function undoCanonicalAttach(
  ws: Workspace, store: ScratchpadStore,
  input: { id: string; token: string; destination: string },
  options: { session: string; checkpoint?: EvidenceCheckpoint },
): Promise<{ message: string }> {
  if (!input.token.startsWith('ev:')) throw new Error('That attach can no longer be undone.')
  const item = await store.get(input.id)
  const part = await destinationPart(ws, store, input.destination)
  const answer = await undoEvidence(new FolioWorkspace(ws, part.dir), input.token, {
    session: options.session,
    ...(options.checkpoint ? { beforeWrite: options.checkpoint } : {}),
  })
  if (!answer.ok) throw new Error(answer.message)
  await refreshAfterEvidenceChange(ws, store, item)
  return { message: answer.message }
}

/** Keep the card's pointer facts (state, attached parts) with the canonical record after a write. */
async function refreshAfterEvidenceChange(ws: Workspace, store: ScratchpadStore, item: ScratchItem): Promise<void> {
  try {
    const ref = await liveRef(ws, store, item)
    await store.refreshSourceRef(item.id, ref)
  } catch { /* the evidence write itself stands; the card re-reads the record on its next action */ }
}
