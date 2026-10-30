/**
 * The agent's Scratchpad insertions (spec §8, ticket 04): `scratchpad.insert` (a copy),
 * `scratchpad.put_back` (a recorded cut returned to a document) and the Reference/Evidence acts
 * (cite, link, insert quote), prepared ONCE and bound to the Change the writer reviews.
 *
 * What the writer sees is what Accept inserts. `prepare…` runs at staging (Change ingestion and the
 * verb's own stage validation) and freezes the exact prepared Markdown, the exact resulting
 * document, the Scratchpad item's version, the destination's digest and — for a widget — the
 * checked page's digest into a `ScratchBoundInsert`. The frozen bound lives in the accepting
 * agent's memory (agent.ts) beside the Change id; the Change record carries the same Markdown the
 * writer reviewed plus a durable marker of its verb. `executeBoundInsert` never re-prepares as an
 * authority: it re-reads only to REFUSE — a changed item, a changed canonical source, a changed
 * widget page, a changed destination or a live buffer that no longer matches the reviewed basis
 * all refuse with nothing written and the candidate kept. It then writes the bound document text
 * once (one Undo group, through the guarded save) and records the use through the store's checked
 * writer; if that required record fails after the document landed, only this operation's own
 * receiving write is conditionally put back (operation receipts, R7).
 *
 * Put back is narrower than a copy: only a genuine recorded cut (`canPutBack`), and only into a
 * document with a LIVE editable owner whose buffer still matches the reviewed basis. Main
 * records no placed use itself: it returns a typed `ScratchPlacementReceipt` (exact fragment,
 * exact offsets in the written text), the accepting window's editor creates the explicit
 * CodeMirror anchor on the same transaction that takes the accepted text, and the established
 * anchor-sync records/drops the use under that window's main-derived holder as Undo/Redo move
 * the anchor. With no live owner it refuses before writing; with no verified anchor the cutting
 * stays a candidate. It never fabricates a placement from matching prose or hidden markers.
 *
 * Rendered picture bytes are bound the same way (R2): preparation freezes a checked (contained,
 * no-follow) digest of every local image the prepared Markdown renders in the destination, and
 * execution re-reads them checked at Accept and again synchronously in the commit tick.
 */
import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import type { Workspace } from './workspace'
import type { ScratchpadStore } from './scratchpad-store'
import { prepareCanonicalReference } from './scratchpad-references'
import { assertRenderedResources, assertRenderedResourcesSync, freezeRenderedResources, readCheckedScratchWidget, type RenderedResourceProof } from './scratchpad-assets'
import { editorTextOf } from '../shared/line-endings'
import type { ScratchPlacementReceipt } from '../shared/scratchpad-items'
import { readLiveOwnerProjections } from './scratchpad-inventory'
import { currentScratchpadHolders } from './scratchpad-holders'
import { fingerprintOfRead } from './guarded-document-read'
import { rollBackOperationWrites, rollbackMessage } from './operation-rollback'
import { resolveProseInsert } from './verbs/verb-support'
import { canPutBack } from '../shared/scratchpad-items'
import { scratchpadExternalSources, type ExternalImportPlan, type ScratchpadExternalSources } from './scratchpad-external'

export const SCRATCHPAD_INSERT_VERBS = ['scratchpad.insert', 'scratchpad.put_back', 'scratchpad.cite', 'scratchpad.link', 'scratchpad.insert_quote'] as const
export type ScratchpadInsertVerb = (typeof SCRATCHPAD_INSERT_VERBS)[number]

export type ScratchInsertInput = { id: string; path: string; insertAfter: string }

/** Everything an accept is bound to. Frozen at staging; `markdown` and `nextContent` are the exact bytes. */
export type ScratchBoundInsert = {
  verb: ScratchpadInsertVerb
  itemId: string
  /** The item version the listing showed (record+payload digest); any source change moves it. */
  itemVersion: string
  /** The exact prepared Markdown the Change shows (rebased for the destination; the whole table). */
  markdown: string
  destPath: string
  /** The destination exactly as reviewed (the inline acts show it whole, as widgets.insert does). */
  destContent: string
  /** SHA-256 of the destination exactly as reviewed. */
  destSha256: string
  /** The destination after the insertion, byte for byte — what Accept writes. */
  nextContent: string
  mode: 'copy' | 'put-back'
  /** For a widget item: SHA-256 of the compatibility-checked page the embed line names. */
  widgetSha256?: string
  /** The checked bytes of every local image the prepared Markdown renders in the destination
   *  (a selected picture/local SVG, and local images embedded in a rich fragment). Frozen at
   *  preparation; revalidated at Accept and again in the tick of the document commit. */
  resources: RenderedResourceProof[]
  /** For a collected TalkWeaver/SlideWell candidate (ticket 05): the import this proposal is
   *  bound to — the shown source version and its planned exclusive destination, prepared
   *  WITHOUT copying anything (staging and validateStage write nothing). Only Accept copies
   *  the selected checked bytes, through the same prepared authority; the planned asset does
   *  not exist during review, so its proof is this source binding plus a checked digest of
   *  the copied file in the commit tick — `freezeRenderedResources` is NOT weakened for the
   *  assets that already exist, and a planned-file freeze is never faked. */
  externalImport?: ExternalImportPlan
  /** The fragment's exact span in `nextContent` (block acts). The put-back receipt carries it in
   *  editor form so the accepting editor anchors exactly what main wrote — never a prose search. */
  fragment?: { from: number; to: number }
  label: string
}

const sha256 = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const dirOf = (path: string): string => (posix.dirname(path) === '.' ? '' : posix.dirname(path))

/** The live-owner rule shared by staging and accepting: a document open with unsaved or blocked text
 *  is never silently written under. A live buffer that matches the basis is fine. */
async function assertLiveBasis(ws: Workspace, path: string, basis: string, needOwner: boolean): Promise<void> {
  const live = await readLiveOwnerProjections(ws.root, [path])
  const blocked = live.blocked.get(path)
  if (blocked) throw new Error(blocked)
  const projected = live.projected.get(path)
  if (projected === undefined) {
    if (needOwner) throw new Error(`Open ${path} in WriteFlex, then accept again. Put back needs the document open in an editor so its place is held there; nothing was written and the cutting stays in the Scratchpad.`)
    return
  }
  if (projected !== basis) {
    throw new Error(`${path} is open with text that differs from the version this proposal was made over (unsaved edits, or Reviewing marks). Save it, then ask the agent again; nothing was written.`)
  }
}

/** The destination exactly as it stands on disk, with the live-owner rule applied. */
async function destinationBasis(ws: Workspace, path: string, needOwner: boolean): Promise<{ content: string }> {
  const read = await ws.readFile(path)
  await assertLiveBasis(ws, path, read.content, needOwner)
  return { content: read.content }
}

/** An inline act's placement (cite, link): directly after the unique anchor, with one space of glue. */
function inlineNext(content: string, path: string, insertAfter: string, markdown: string): string {
  const first = content.indexOf(insertAfter)
  if (!insertAfter || first === -1) throw new Error(`insertAfter was not found in ${path}; re-read the file and retry with the exact current text.`)
  if (content.indexOf(insertAfter, first + insertAfter.length) !== -1) throw new Error(`insertAfter is not unique in ${path}; include more surrounding context.`)
  const at = first + insertAfter.length
  const glue = /\s$/.test(insertAfter) || at >= content.length || /^\s/.test(content[at]) ? '' : ' '
  return content.slice(0, at) + glue + markdown + content.slice(at)
}

/**
 * Prepare one agent Scratchpad insertion and bind it. Reads the item (and, for a reference act, the
 * canonical source) exactly once here; execution re-reads only to refuse. Throws the refusal.
 */
export async function prepareBoundInsert(
  ws: Workspace,
  store: ScratchpadStore,
  verb: ScratchpadInsertVerb,
  input: ScratchInsertInput,
  external: ScratchpadExternalSources = scratchpadExternalSources(),
): Promise<ScratchBoundInsert> {
  const destPath = store.documentPath(input.path)
  const mode: 'copy' | 'put-back' = verb === 'scratchpad.put_back' ? 'put-back' : 'copy'
  const item = await store.get(input.id)
  if (item.status !== 'active') throw new Error('Move this item back to Candidates before using it.')
  if (!item.version) throw new Error('That item could not be checked, so nothing was proposed.')
  if (mode === 'put-back' && !canPutBack(item)) {
    throw new Error('Put back is only for text cut to the Scratchpad that is not in a document now. Use scratchpad.insert for a copy.')
  }
  const basis = await destinationBasis(ws, destPath, false)
  if (verb === 'scratchpad.cite' || verb === 'scratchpad.link' || verb === 'scratchpad.insert_quote') {
    const action = verb === 'scratchpad.cite' ? 'cite' : verb === 'scratchpad.link' ? 'link' : 'quote'
    const prepared = await prepareCanonicalReference(ws, store, { id: input.id, action, destination: destPath })
    const placed = prepared.style === 'block'
      ? resolveProseInsert(basis.content, { path: destPath, insertAfter: input.insertAfter, text: prepared.markdown, category: 'other', summary: `Quote from ${prepared.label}` })
      : null
    const nextContent = placed ? placed.nextContent : inlineNext(basis.content, destPath, input.insertAfter, prepared.markdown)
    const resources = await freezeRenderedResources(ws.root, destPath, prepared.markdown)
    return {
      verb, itemId: item.id, itemVersion: item.version, markdown: prepared.markdown, destPath,
      destContent: basis.content, destSha256: sha256(basis.content), nextContent, mode: 'copy', label: prepared.label,
      resources, ...(placed ? { fragment: placed.range } : {}),
    }
  }
  // A collected external candidate: bind the shown source version and a planned exclusive
  // destination WITHOUT copying (staging writes nothing). Accept alone imports. A candidate
  // whose local copy already stands in the workspace freezes that copy's bytes like any
  // other rendered resource; a not-yet-copied asset is proven by its source binding here
  // and by the copied file's checked digest in the commit tick at Accept.
  if (item.external) {
    const plan = await external.planImport(ws, item, destPath)
    const markdown = external.markdownFor(item.external, destPath, plan.path)
    const placedExternal = resolveProseInsert(basis.content, {
      path: destPath, insertAfter: input.insertAfter, text: markdown, category: 'other',
      summary: `Insert “${item.title}”`,
    })
    const resources = plan.reuse ? await freezeRenderedResources(ws.root, destPath, markdown) : []
    return {
      verb, itemId: item.id, itemVersion: item.version, markdown, destPath,
      destContent: basis.content, destSha256: sha256(basis.content), nextContent: placedExternal.nextContent, mode: 'copy',
      ...(item.kind === 'widget' ? { widgetSha256: item.external.sha256 } : {}), label: item.title,
      resources, externalImport: plan, fragment: placedExternal.range,
    }
  }
  // The generic insert: the store's own checked preparation (exact payload, relative links rebased
  // from the recorded origin or refused, asset compatibility re-checked). References and quoted
  // evidence are refused here: they travel their explicit acts above.
  const prepared = await store.prepareInsert(input.id, destPath)
  if (!prepared.ok) throw new Error(prepared.error)
  let widgetSha256: string | undefined
  if (item.kind === 'widget') {
    const fromDir = item.origin.base ?? dirOf(item.origin.path)
    const checked = await readCheckedScratchWidget(ws.root, fromDir ? `${fromDir}/_` : '_', item.markdown)
    widgetSha256 = sha256(checked.html)
  }
  const placed = resolveProseInsert(basis.content, {
    path: destPath, insertAfter: input.insertAfter, text: prepared.markdown, category: 'other',
    summary: mode === 'put-back' ? `Put back “${item.title}”` : `Insert “${item.title}”`,
  })
  const resources = await freezeRenderedResources(ws.root, destPath, prepared.markdown)
  return {
    verb, itemId: item.id, itemVersion: item.version, markdown: prepared.markdown, destPath,
    destContent: basis.content, destSha256: sha256(basis.content), nextContent: placed.nextContent, mode,
    ...(widgetSha256 ? { widgetSha256 } : {}), label: item.title,
    resources, fragment: placed.range,
  }
}

/**
 * Carry out one bound insertion at Accept. Revalidates everything the bound froze and refuses —
 * writing nothing, keeping the candidate — when any of it moved. `holder` is the accepting
 * window's main-derived editor-session holder (required for put-back; unused for a copy, whose
 * use is historical). Returns the saved file for the accept's response.
 */
export async function executeBoundInsert(
  ws: Workspace,
  store: ScratchpadStore,
  bound: ScratchBoundInsert,
  holder: string | null,
  external: ScratchpadExternalSources = scratchpadExternalSources(),
): Promise<{ text: string; file: Awaited<ReturnType<Workspace['saveFileOverRead']>>; placement?: ScratchPlacementReceipt }> {
  // The candidate as it stands now: same version, still usable. A changed payload, record,
  // status or placement refuses the whole accept instead of re-authorising a fresh read.
  const item = await store.get(bound.itemId)
  if (item.version !== bound.itemVersion) throw new Error('That Scratchpad item changed since this proposal was made, so nothing was inserted. The item is kept; ask the agent again to see it as it stands.')
  if (item.status !== 'active') throw new Error('That Scratchpad item was rejected since this proposal was made, so nothing was inserted.')
  if (bound.mode === 'put-back' && !canPutBack(item)) throw new Error('That cutting is in a document now, or is no longer a cutting, so it was not put back again.')
  if (bound.externalImport) {
    // Bound to the shown source version, not to a fresh preparation: the candidate's own
    // version check above already refuses a changed pointer/payload, and the import below
    // re-reads the source only to refuse on a digest that is no longer the bound one.
    if (!item.external || item.external.providerId !== bound.externalImport.providerId || item.external.sha256 !== bound.externalImport.sha256) {
      throw new Error('That Scratchpad item changed since this proposal was made, so nothing was copied or inserted. The item is kept; ask the agent again.')
    }
  } else if (bound.verb === 'scratchpad.cite' || bound.verb === 'scratchpad.link' || bound.verb === 'scratchpad.insert_quote') {
    // The canonical source may have changed without the candidate's record moving: the prepared
    // Markdown must still come out byte-identical, or the reviewed words are not what would land.
    const action = bound.verb === 'scratchpad.cite' ? 'cite' : bound.verb === 'scratchpad.link' ? 'link' : 'quote'
    const again = await prepareCanonicalReference(ws, store, { id: bound.itemId, action, destination: bound.destPath })
    if (again.markdown !== bound.markdown) throw new Error('That source changed since this proposal was made, so nothing was inserted. The card is kept; ask the agent again to see it as it stands.')
  } else {
    const again = await store.prepareInsert(bound.itemId, bound.destPath)
    if (!again.ok) throw new Error(again.error)
    if (again.markdown !== bound.markdown) throw new Error('That Scratchpad item changed since this proposal was made, so nothing was inserted. The item is kept; ask the agent again.')
    if (bound.widgetSha256 !== undefined) {
      const fromDir = item.origin.base ?? dirOf(item.origin.path)
      const checked = await readCheckedScratchWidget(ws.root, fromDir ? `${fromDir}/_` : '_', item.markdown)
      if (sha256(checked.html) !== bound.widgetSha256) throw new Error('That widget changed since this proposal was made, so nothing was inserted. Ask the agent again to see it as it stands.')
    }
  }
  // The rendered picture bytes exactly as reviewed (R2): identical Markdown for the same path is
  // not proof of identical bytes, so every frozen resource is re-read checked, here after the
  // waits above and again synchronously in the tick of the document commit below.
  await assertRenderedResources(ws.root, bound.resources ?? [])
  // The destination exactly as reviewed, under the live-owner rule. Put back additionally needs a
  // live editable owner and its window's holder, still live now.
  const source = await ws.readFile(bound.destPath)
  if (sha256(source.content) !== bound.destSha256) {
    throw new Error(`${bound.destPath} changed since this proposal was made, so nothing was inserted. Ask the agent again so the place is chosen in the text as it stands.`)
  }
  await assertLiveBasis(ws, bound.destPath, source.content, bound.mode === 'put-back')
  if (bound.mode === 'put-back') {
    if (!holder || !currentScratchpadHolders(ws.root).has(holder)) {
      throw new Error(`Open ${bound.destPath} in WriteFlex, then accept again. Put back needs the document open in an editor so its place is held there; nothing was written and the cutting stays in the Scratchpad.`)
    }
  }
  // Accept alone imports an external candidate's asset (ticket 05): only now, after the
  // destination and its live owner were revalidated above, are the selected checked bytes
  // copied — exclusively, to the planned destination, bound to the shown source version.
  // The copied file then joins the rendered-resource proof checked in the commit tick.
  let commitResources: RenderedResourceProof[] = bound.resources ?? []
  let createdImport: Awaited<ReturnType<ScratchpadExternalSources['importForInsert']>>['created'] = null
  if (bound.externalImport) {
    const imported = await external.importForInsert(ws, store, item, bound.destPath, bound.externalImport)
    if (imported.markdown !== bound.markdown) {
      // The writer inserted this candidate directly since the proposal, so its copy stands
      // under a different name than the reviewed one: never silently substitute it.
      throw new Error('That file was copied into the document under a different name since this proposal was made, so nothing was inserted. Ask the agent again to see it as it stands.')
    }
    createdImport = imported.created
    if (!bound.externalImport.reuse) commitResources = [...commitResources, { path: bound.externalImport.path, sha256: bound.externalImport.sha256 }]
    await assertRenderedResources(ws.root, commitResources)
  }
  const useId = `u_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
  // The put-back receipt is derived from the bound bytes BEFORE anything is written: a bound
  // with no exact fragment span refuses here, never after the document landed.
  let placement: ScratchPlacementReceipt | undefined
  if (bound.mode === 'put-back') {
    if (!bound.fragment) throw new Error('That proposal carries no exact place for its fragment, so nothing was written.')
    const editorNext = editorTextOf(bound.nextContent)
    const from = editorTextOf(bound.nextContent.slice(0, bound.fragment.from)).length
    const to = from + editorTextOf(bound.markdown).length
    if (editorNext.slice(from, to) !== editorTextOf(bound.markdown)) throw new Error('That proposal carries no exact place for its fragment, so nothing was written.')
    placement = { itemId: bound.itemId, useId, path: bound.destPath, markdown: editorTextOf(bound.markdown), from, to }
  }
  const written: import('./workspace').OperationWrite[] = []
  let saved: Awaited<ReturnType<Workspace['saveFileOverRead']>>
  try {
    saved = await ws.recordingOperationWrites(written, async () => {
      const result = await ws.saveFileOverRead(bound.destPath, bound.nextContent, source.content, {
        expect: { fingerprint: fingerprintOfRead(source) },
        // In the tick of the commit, after every await above: the rendered bytes must still be
        // the reviewed ones, or the document write itself is refused.
        beforeCommit: () => assertRenderedResourcesSync(ws.root, commitResources),
      })
      if (bound.mode !== 'put-back') {
        // The required use record, through the store's checked writer against the reviewed
        // payload. A copy is historical (no editor anchor claims its place); candidate retained.
        await store.recordAgentUse(bound.itemId, {
          useId, path: bound.destPath, mode: bound.mode,
          expectedMarkdown: item.markdown,
        })
      }
      return result
    })
  } catch (error) {
    const own = written.filter((write) => write.path === bound.destPath)
    if (own.length === 0 && !createdImport) throw error
    let message = error instanceof Error ? error.message : String(error)
    let documentRestored = own.length === 0
    if (own.length > 0) {
      const outcome = await rollBackOperationWrites(ws, own)
      documentRestored = outcome.restored.includes(bound.destPath) && outcome.changed.length === 0 && outcome.failed.length === 0
      message = rollbackMessage(message, outcome)
    }
    if (createdImport && item.external && bound.externalImport) {
      const createdImportPath = createdImport.path
      // The asset this accept created takes part in the same conditional rollback: removed
      // only while it still holds exactly the imported bytes, and unrecorded only while the
      // record still points at this copy. When either refuses, the copy stays — named, with
      // its provenance on the item — and the message says so instead of claiming a clean undo.
      const removed = documentRestored && await external.removeCreatedImport(ws, item.external, createdImport)
      const unrecorded = removed ? await store.clearExternalImport(bound.itemId, createdImportPath, bound.externalImport.sha256).catch(() => false) : false
      message += removed
        ? unrecorded
          ? ` The copied file ${createdImportPath} was removed again.`
          : ` The copied file ${createdImportPath} was removed again, but its Scratchpad record could not be cleared.`
        : ` The file was copied into ${createdImportPath} and is recorded on the Scratchpad item; it was kept because a complete rollback could not be confirmed.`
    }
    throw new Error(message)
  }
  // Put back records NO placed use here (R1): a live window existing is not a placement. Main
  // returns the typed receipt above; the accepting window's editor creates the explicit anchor
  // on the same transaction that takes this text, and the established anchor-sync then records
  // the use under that window's main-derived holder. Undo of that transaction removes anchor
  // and record together; Redo restores both. Without the anchor the cutting simply stays a
  // candidate — the words are in the document, unclaimed.
  const text = bound.verb === 'scratchpad.cite' ? `Cited ${bound.label} in ${bound.destPath}.`
    : bound.verb === 'scratchpad.link' ? `Inserted a link to ${bound.label} in ${bound.destPath}.`
    : bound.verb === 'scratchpad.insert_quote' ? `Inserted a quote from ${bound.label} in ${bound.destPath}, with its citation.`
    : bound.mode === 'put-back' ? `Inserted the cutting “${bound.label}” in ${bound.destPath}.`
    : bound.externalImport ? `Copied “${bound.label}” into ${bound.externalImport.path} and inserted it in ${bound.destPath}. The source is recorded on the item, which stays in the Scratchpad.`
    : `Inserted a copy of “${bound.label}” in ${bound.destPath}. The item stays in the Scratchpad.`
  return { text, file: saved, ...(placement ? { placement } : {}) }
}
