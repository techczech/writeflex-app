/**
 * What main's link repair wrote to one document, for the renderer holding that document's buffer
 * (renderer/src/app/repair-in-buffer.ts): the sha256 of the text the repair replaced and of the text it wrote.
 * The renderer takes the repair's text as the buffer's new basis only when its basis is exactly `before` and the
 * file it reads is exactly `written`; any other bytes are another writer's, asked about with the changed-on-disk
 * banner as usual.
 */
import { sha256OfText } from './preserve-receipt'

export type RepairReceipt = { path: string; before: string; written: string }

export async function repairReceipt(path: string, before: string, written: string): Promise<RepairReceipt> {
  return { path, before: await sha256OfText(before), written: await sha256OfText(written) }
}

const HEX = /^[0-9a-f]{64}$/

/** The receipts in `value` (an IPC answer), or none when it is not a list of well-formed receipts. */
export function repairReceiptsOf(value: unknown, isPath: (path: unknown) => boolean): RepairReceipt[] {
  if (!Array.isArray(value)) return []
  const valid = value.every((item) => item && typeof item === 'object'
    && isPath((item as RepairReceipt).path) && HEX.test(String((item as RepairReceipt).before)) && HEX.test(String((item as RepairReceipt).written)))
  return valid ? value.map(({ path, before, written }: RepairReceipt) => ({ path, before, written })) : []
}
