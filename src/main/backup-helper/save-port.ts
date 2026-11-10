/**
 * The seam file:save (ipc.ts) reaches the editor receipts through: main sets it once at start
 * (index.ts). Unset, or with the disabled trial, every save is exactly as before: no receipt.
 */
import type { MainSaveReceipt } from './receipt-service'

export type SaveReceiptPort = {
  beginSave(senderId: number, root: string, path: string, meta: unknown): Promise<MainSaveReceipt | null>
}

const NONE: SaveReceiptPort = { beginSave: async () => null }
let port: SaveReceiptPort = NONE

export function setSaveReceiptPort(next: SaveReceiptPort | null): void {
  port = next ?? NONE
}

export function saveReceiptPort(): SaveReceiptPort {
  return port
}
