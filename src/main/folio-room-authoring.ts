import { undoSectionRole } from './folio-section-role'
import { writeEvidence, undoEvidence, attachEvidence } from './folio-evidence'
import { createHash } from 'node:crypto'
import { findFlags } from '../shared/markdown/flags'
import type { FolioWorkspace } from './folio-workspace'
import { locatePlanPart, materialisePart, readFolioPlan, setFolioLabels, setPartLine, PlanWrittenButNotReRead, type PlanCommitReceipt, type PlanWriteOptions } from './plan'
import { binFolderToShow, isBinUndoToken, removePartsToBin, restoreFromBin, undoBinChange } from './folio-bin'
import { binRemovalMessage } from '../shared/folio-bin'
import { withPlanLock } from './plan-lock'
import { indexNotePath } from './folio'
import { recordAdd, undoRecordedAdd } from './folio-add-undo'
import { setCollectionPieceStatus } from './collection'
import { normaliseCollectionStatus } from '../shared/collection-status'
import { planCardRefusal } from '../shared/folio-running-order'
import { withoutAbsolutePaths } from '../shared/plain-error-text'
import type { RoomAuthoringRequest, RoomAuthoringResult } from '../shared/folio-room-authoring'

/** What `writeRoomAuthoring` is given besides the request: the Plan write options and, for Show bin in Finder, how a folder is opened. */
export type RoomAuthoringOptions = PlanWriteOptions & { revealFolder?: (absolute: string) => Promise<void> }

/**
 * One guarded room action; Undo records the exact two Folio documents, never a renderer-supplied replacement.
 * Removal moves written parts' files into the Folio bin (folio-bin.ts); its Undo, Restore and Show bin in Finder are here too.
 * Each action reads the Plan once (spec folio-workspace § 5): only Start, status and Clear flag read it before their write.
 */
export async function writeRoomAuthoring(ws: FolioWorkspace, request: RoomAuthoringRequest, options: RoomAuthoringOptions = {}): Promise<RoomAuthoringResult> {
  if (request.op === 'undo' && request.token.startsWith('sr:')) {
    const answer = await undoSectionRole(ws, ws.folioDir, request.token, options.beforeIndexWrite)
    return answer.ok ? { ok: true, token: null, message: answer.message, paths: answer.paths } : { ok: false, message: answer.message }
  }
  if (request.op === 'remove') {
    const answer = await removePartsToBin(ws, request.indices, request.expected, options)
    if (!answer.ok) return answer
    const removed = answer.removed.map((part) => ({ title: part.title, path: part.path }))
    const paths = [...(answer.indexPath ? [answer.indexPath] : []), answer.manifestPath, ...answer.binned.map((file) => file.path)]
    return { ok: true, token: answer.token, message: binRemovalMessage(removed, answer.binned), removed, binned: answer.binned, paths }
  }
  if (request.op === 'undo' && isBinUndoToken(request.token)) {
    const answer = await undoBinChange(ws, request.token, options)
    return answer.ok ? { ok: true, token: null, message: 'Undone.', paths: answer.paths } : { ok: false, message: answer.message }
  }
  if (request.op === 'restore') {
    const answer = await restoreFromBin(ws, request.id, options)
    if (!answer.ok) return answer
    const manifest = ws.folioDir === '' ? '_report-structure.json' : `${ws.folioDir}/_report-structure.json`
    return { ok: true, token: answer.token, message: answer.message, path: answer.path, paths: [answer.path, indexNotePath(ws, ws.folioDir), manifest] }
  }
  if (request.op === 'showBin') {
    // Opening only: the real, pinned bin folder (no link on the way, not in a nested Folio). Nothing is written or deleted.
    let folder: string | null
    try { folder = binFolderToShow(ws, ws.folioDir) } catch { return { ok: false, message: 'The Folio bin is not a plain folder of this Folio, so it was not opened.' } }
    if (!folder) return { ok: false, message: 'The Folio bin is empty: there is no bin folder to show.' }
    if (!options.revealFolder) return { ok: false, message: 'The Folio bin cannot be shown here.' }
    try { await options.revealFolder(folder) } catch { return { ok: false, message: 'Finder could not open the Folio bin.' } }
    return { ok: true, token: null, message: 'Opened the Folio bin in Finder.' }
  }
  if (request.op === 'attachEvidence') {
    const answer = await attachEvidence(ws, request.part, request.source, { session: request.session, expectedOwner: request.stateKey, beforeWrite: options.beforeIndexWrite })
    return answer.ok ? { ...answer, ok: true } : { ...answer, ok: false }
  }
  if (request.op === 'evidence') {
    const answer = await writeEvidence(ws, request.ops, { session: request.session, expectedOwner: request.stateKey, beforeWrite: options.beforeIndexWrite })
    return answer.ok ? { ...answer, ok: true } : { ...answer, ok: false }
  }
  if (request.op === 'undo' && request.token.startsWith('ev:')) {
    const answer = await undoEvidence(ws, request.token, { session: request.session ?? 'undo', beforeWrite: options.beforeIndexWrite })
    return answer.ok ? { ...answer, ok: true } : { ...answer, ok: false }
  }
  return withPlanLock(ws, ws.folioDir, async () => {
    let committedToken: string | null = null
    let committedPaths: string[] | null = null
    const capture = (receipt: PlanCommitReceipt): void => {
      const { index, manifest } = receipt
      committedPaths = [index.path, manifest.path]
      const documents = (side: 'before' | 'after') => ({ indexPath: index.path, manifestPath: manifest.path, texts: new Map([[index.path, index[side]], [manifest.path, manifest[side]]]) })
      committedToken = recordAdd(ws, ws.folioDir, documents('before'), documents('after'))
      options.onCommit?.(receipt)
    }
    try {
      const dir = ws.folioDir
      if (request.op === 'undo') {
        const answer = await undoRecordedAdd(ws, dir, request.token, options)
        return answer.ok ? { ok: true, token: null, message: 'Undone.' } : { ok: false, message: answer.message }
      }
      if (request.op === 'start' || request.op === 'status' || request.op === 'clearFlag') {
        const plan = await readFolioPlan(ws, dir)
        if (!plan) throw new Error('That folder is no longer a Folio.')
        const check = (fresh: typeof plan): void => {
          const refusal = planCardRefusal(fresh.parts, request.index, request.expected)
          if (refusal) throw new Error(refusal)
        }
        check(plan)
        if (request.op === 'start') {
          const result = await materialisePart(ws, dir, request.index, { ...options, verifyPlan: check })
          return { ok: true, token: null, message: `Started ‘${request.expected.title}’ as ${result.path}.`, path: result.path }
        }
        const path = plan.parts[request.index].path
        if (!path) throw new Error('Start this part before changing its status.')
        if (request.op === 'clearFlag') {
          const read = await ws.readFile(path)
          if (createHash('sha256').update(read.content).digest('hex') !== request.fingerprint) throw new Error('That part changed. The flags have been refreshed; nothing was cleared.')
          const flag = findFlags(read.content).find(flag => flag.from === request.from)
          if (!flag) throw new Error('That flag is no longer here.')
          const next = read.content.slice(0, flag.from) + read.content.slice(flag.wordsFrom, flag.wordsTo) + read.content.slice(flag.to)
          await options.beforeIndexWrite?.(path)
          await ws.saveFileOver(path, next, { kind: 'disk', text: read.content })
          return { ok: true, token: null, message: 'Cleared the flag; its words are kept.', path }
        }
        const status = normaliseCollectionStatus(request.status)
        await options.beforeIndexWrite?.(path)
        const fresh = await readFolioPlan(ws, dir)
        if (!fresh) throw new Error('This folder is no longer a Folio.')
        check(fresh)
        await setCollectionPieceStatus(ws, dir, path, status)
        return { ok: true, token: null, message: `Set ‘${request.expected.title}’ to ${status}.`, path }
      }
      const writeOptions = { ...options, onCommit: capture }
      if (request.op === 'locate') await locatePlanPart(ws, dir, request.index, request.path, request.expected, writeOptions)
      else if (request.op === 'line') await setPartLine(ws, dir, request.index, request.change, request.expected, writeOptions)
      else await setFolioLabels(ws, dir, request.change, request.basis, writeOptions)
      const token = committedToken
      return { ok: true, token, message: request.op === 'labels' ? 'Updated the Folio’s labels.' : 'Updated the part.', ...(committedPaths ? { paths: committedPaths } : {}) }
    } catch (error) {
      if (error instanceof PlanWrittenButNotReRead) return { ok: true, token: committedToken, message: error.message }
      return { ok: false, message: withoutAbsolutePaths(error instanceof Error ? error.message : String(error), ws.root) }
    }
  })
}
