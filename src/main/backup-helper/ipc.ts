/**
 * The backup-helper bridge's channels. The control channels (status, Sync now) take no argument: the
 * window is the sender and its folder is main's own state, so the renderer names no vault, path, socket
 * or command. A call that carries anything is refused before the service sees it.
 *
 * The receipt channels (receipt-service.ts) take exactly one checked argument naming documents by the
 * renderer's own path, epoch and generation (or, for `lifetime`, the folder it shows); the owner, the
 * lifetime token and the vault are main's. Only the window's top frame
 * is answered: a call from any other frame is refused.
 */
import { BACKUP_ENROLMENT_CHANNELS, checkEarlierInput, checkEnableInput } from '../../shared/backup-enrolment'
import { BACKUP_HELPER_CHANNELS, BACKUP_RECEIPT_CHANNELS } from '../../shared/backup-helper'
import type { BackupEnrolment } from './enrolment'
import type { BackupReceiptService } from './receipt-service'
import type { BackupHelperService } from './service'

type Registrar = { handle: (channel: string, listener: (event: { sender: { id: number } }, ...args: unknown[]) => unknown) => void }

const refused = { state: 'refused' as const, reason: 'unexpected-arguments' as const }

export function registerBackupHelperIpc(ipc: Registrar, service: BackupHelperService): void {
  ipc.handle(BACKUP_HELPER_CHANNELS.status, (event, ...args) => (args.length ? refused : service.status(event.sender.id)))
  ipc.handle(BACKUP_HELPER_CHANNELS.syncNow, (event, ...args) => (args.length ? refused : service.syncNow(event.sender.id)))
}

type FrameEvent = { sender: { id: number; mainFrame?: unknown }; senderFrame?: unknown }

/** True only for a call from the sender's own top frame (both known and the same object). */
const fromMainFrame = (event: FrameEvent): boolean => event.senderFrame != null && event.senderFrame === event.sender.mainFrame

export function registerBackupReceiptIpc(ipc: Registrar, service: BackupReceiptService): void {
  ipc.handle(BACKUP_RECEIPT_CHANNELS.lifetime, (event, ...args) => service.lifetime({ id: event.sender.id, mainFrame: fromMainFrame(event as FrameEvent) }, args))
  ipc.handle(BACKUP_RECEIPT_CHANNELS.reportEdit, (event, ...args) => service.reportEdit({ id: event.sender.id, mainFrame: fromMainFrame(event as FrameEvent) }, args))
  ipc.handle(BACKUP_RECEIPT_CHANNELS.status, (event, ...args) => service.status({ id: event.sender.id, mainFrame: fromMainFrame(event as FrameEvent) }, args))
}

const notFromMainFrame = { ok: false as const, reason: 'Backup settings can only be changed from the app window.' }

/**
 * Enrolment channels (enrolment.ts): every call is about the sending window's own folder. Only `enable`
 * takes an argument, exactly `{ previewId, confirmPublic }` (the id main issued with this window's preview);
 * anything else, or a call from another frame, is refused before the enrolment sees it.
 */
export function registerBackupEnrolmentIpc(ipc: Registrar, enrolment: BackupEnrolment): void {
  ipc.handle(BACKUP_ENROLMENT_CHANNELS.status, (event, ...args) => (args.length || !fromMainFrame(event as FrameEvent) ? { state: 'unavailable', reason: 'unexpected request' } : enrolment.status(event.sender.id)))
  ipc.handle(BACKUP_ENROLMENT_CHANNELS.preview, (event, ...args) => (args.length || !fromMainFrame(event as FrameEvent) ? { state: 'refused', folder: null, reason: 'unexpected request', prerequisites: [] } : enrolment.preview(event.sender.id)))
  ipc.handle(BACKUP_ENROLMENT_CHANNELS.enable, async (event, ...args) => {
    const input = checkEnableInput(args)
    if (!input || !fromMainFrame(event as FrameEvent)) return { ...notFromMainFrame, status: await enrolment.status(event.sender.id) }
    return enrolment.enable(event.sender.id, input)
  })
  ipc.handle(BACKUP_ENROLMENT_CHANNELS.confirmEarlier, async (event, ...args) => {
    const input = checkEarlierInput(args)
    if (!input || !fromMainFrame(event as FrameEvent)) return { ...notFromMainFrame, status: await enrolment.status(event.sender.id) }
    return enrolment.confirmEarlier(event.sender.id, input)
  })
  ipc.handle(BACKUP_ENROLMENT_CHANNELS.disable, async (event, ...args) => {
    if (args.length || !fromMainFrame(event as FrameEvent)) return { ...notFromMainFrame, status: await enrolment.status(event.sender.id) }
    return enrolment.disable(event.sender.id)
  })
}
