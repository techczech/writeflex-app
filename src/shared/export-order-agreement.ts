/**
 * Whether a Folio's export follows its running order (spec-folio-room-data-model § 8 D-ORD-3): the answer main computes
 * (`exportOrderAgreement`, folio-order-assessment.ts) and the line the export sheet and the Share page show for it.
 * Pure; nothing here touches a file.
 *
 * The running order is the Index Note's; export and sharing read the manifest. A crash between the two writes of a
 * Plan change (`commitPlanDocuments`), or a Start this part whose clean-up failed, can leave them out of step. The
 * line names it and offers the manifest-only repair (`alignManifestWithPlan`) or Export anyway (manifest order).
 */
import type { PlanPartKey } from './folio-running-order'

export type ExportOrderAgreement =
  | { kind: 'agree' }
  | { kind: 'no-manifest' }
  | { kind: 'unreadable' }
  | {
      kind: 'disagree'
      /** Set when the two orders differ on the files both list: each order restricted to those files. */
      orderDiffers?: { index: string[]; manifest: string[] }
      /** Written running-order parts the manifest does not list: export and sharing leave them out. */
      notInExport: string[]
      /** Manifest entries no running-order line names (shown under Not in the outline already). */
      notInRunningOrder: string[]
    }

/**
 * What the sheet read, passed back to the repair as `expected`: the running order and whether a manifest file was
 * there. The repair is refused unless both are still so, so a manifest deleted (or created) since the read is never
 * silently recreated (or overwritten).
 */
export type ExportOrderExpected = { parts: PlanPartKey[]; manifestExists: boolean }

/**
 * What main answers to the sheets' read: the agreement, what it was computed from (the repair's `expected`), and the
 * Plan's own manifest message for `unreadable` (plan.ts `MANIFEST_NOT_READABLE`).
 */
export type ExportOrderCheck = { agreement: ExportOrderAgreement; expected: ExportOrderExpected; unreadableMessage: string }

/**
 * What main answers to Make export follow the running order. `pieces`: how many pieces export writes now.
 * `notInRunningOrder`: set when this repair created the manifest and it lists files the running order does not
 * (kept in export, after the written parts; folio room review S-2).
 */
export type ExportOrderRepairResult =
  | { ok: true; changed: boolean; pieces: number; notInRunningOrder?: string[] }
  | { ok: false; message: string }

export const EXPORT_ORDER_DIFFERS = 'The export order does not match the running order'
export const EXPORT_ORDER_REPAIR = 'Make export follow the running order'
export const EXPORT_ANYWAY = 'Export anyway'
/** Said when the repair is refused because either document changed after the line was computed. */
export const EXPORT_ORDER_CHANGED = 'The running order changed while the export order was being repaired. Check it again.'
/** Said after the repair. */
export const EXPORT_ORDER_REPAIRED = 'Export and sharing now follow the running order.'

export const partsNotInExport = (count: number): string => `${count === 1 ? '1 part is' : `${count} parts are`} not in the export`

/** Whether the out-of-step line shows: a different order on the common files, or written parts the export leaves out. */
export function exportOrderNeedsRepair(agreement: ExportOrderAgreement): boolean {
  return agreement.kind === 'disagree' && (agreement.orderDiffers !== undefined || agreement.notInExport.length > 0)
}

/**
 * The line's sentences, or null when no line shows. The order sentence comes first when both apply. `notInRunningOrder`
 * alone shows nothing new; `unreadable` is the Plan's own manifest message and has no repair; `no-manifest` is the
 * Index-only banner of § 12, which the room shows (not these sheets).
 */
export function exportOrderLine(agreement: ExportOrderAgreement, unreadableMessage: string): { lines: string[]; repair: boolean } | null {
  if (agreement.kind === 'unreadable') return { lines: [unreadableMessage], repair: false }
  if (!exportOrderNeedsRepair(agreement) || agreement.kind !== 'disagree') return null
  const lines: string[] = []
  if (agreement.orderDiffers) lines.push(EXPORT_ORDER_DIFFERS)
  if (agreement.notInExport.length) lines.push(partsNotInExport(agreement.notInExport.length))
  return { lines, repair: true }
}
