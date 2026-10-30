import type { EvidenceTransfer } from './folio-evidence-transfer'
import type { EvidenceOp } from './folio-evidence'
import type { PlanCardKey } from './folio-running-order'
import type { PlanLineChange } from './plan-line-edit'
export type LabelChange = { op: 'add'; name: string } | { op: 'rename'; slug: string; name: string } | { op: 'delete'; slug: string }
export type RoomAuthoringRequest =
  | { op: 'attachEvidence'; part: string; source: EvidenceTransfer; session: string; stateKey: string }
  | { op: 'evidence'; ops: EvidenceOp[]; session: string; stateKey: string }
  | { op: 'line'; index: number; expected: PlanCardKey; change: PlanLineChange }
  | { op: 'labels'; change: LabelChange; basis: string | null }
  | { op: 'locate'; index: number; expected: PlanCardKey; path: string }
  | { op: 'start'; index: number; expected: PlanCardKey }
  | { op: 'status'; index: number; expected: PlanCardKey; status: string }
  | { op: 'remove'; indices: number[]; expected: PlanCardKey[] }
  | { op: 'clearFlag'; index: number; expected: PlanCardKey; from: number; fingerprint: string }
  | { op: 'undo'; token: string; session?: string }
  /** Restore one Folio bin item (its id as the room lists it). */
  | { op: 'restore'; id: string }
  /** Open the Folio bin's folder in Finder (opening only: the app never deletes; the owner empties the bin there, I-1). */
  | { op: 'showBin' }
/**
 * `paths`: every file the write changed (the Index Note, the manifest, part files moved into or out of the bin), for
 * the one refresh main sends. `removed` and `binned`: a removal's parts and the files now in the bin, for the toast.
 */
export type RoomAuthoringResult =
  | { ok: true; token: string | null; message: string; path?: string; paths?: string[]; removed?: Array<{ title: string; path: string | null }>; binned?: Array<{ path: string; name: string }> }
  | { ok: false; message: string }
