import { useSyncExternalStore } from 'react'
import { EVIDENCE_DRAG_MIME, parseEvidenceTransfer, type EvidenceTransfer } from '../../shared/folio-evidence-transfer'
import type { FolioRoomModel } from '../../shared/folio-room'
export type EvidenceAttachmentTarget = { owner: string; part: string; attach: (source: EvidenceTransfer) => Promise<boolean> }
let target: EvidenceAttachmentTarget | null = null
const listeners = new Set<() => void>()
const changed = () => { for (const listener of listeners) listener() }
export function registerEvidenceAttachmentTarget(next: EvidenceAttachmentTarget): () => void {
  target = next; changed()
  return () => { if (target?.owner === next.owner) { target = null; changed() } }
}
export function useEvidenceAttachmentTarget(): EvidenceAttachmentTarget | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => target, () => null)
}
export function setEvidenceDrag(data: DataTransfer, source: EvidenceTransfer): void { data.setData(EVIDENCE_DRAG_MIME, JSON.stringify(source)); data.effectAllowed = 'copy' }
const PATH_TYPES = ['application/x-writeflex-source', 'application/x-writeflex-file', 'text/writeflex-tab']
export function isEvidenceDrag(data: DataTransfer): boolean { return [EVIDENCE_DRAG_MIME, ...PATH_TYPES, 'text/uri-list'].some(type => data.types.includes(type)) }
export function evidenceFromDrag(data: DataTransfer, model: FolioRoomModel): EvidenceTransfer | null {
  const custom = data.getData(EVIDENCE_DRAG_MIME)
  if (custom) return parseEvidenceTransfer(custom)
  for (const type of PATH_TYPES) {
    const path = data.getData(type)
    if (!path) continue
    const choice = model.evidence?.candidates.find(candidate => candidate.path === path)
    if (choice?.kind === 'note') return { kind: 'note', title: choice.title }
    return { kind: 'file', path }
  }
  const uri = data.getData('text/uri-list').split(/\r?\n/).find(line => line && !line.startsWith('#'))
  if (uri?.startsWith('zotero://select/')) return parseEvidenceTransfer(JSON.stringify({ kind: 'zotero', itemTarget: uri, label: 'Zotero item' }))
  return null
}
