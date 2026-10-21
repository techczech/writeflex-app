// Sharing's IPC (ticket 02): the set-up steps, Settings › Sharing (with ticket 05's own address) and nothing else. The window sends a
// pasted token ONCE, on `sharing:check-token`; nothing the main process answers ever holds it (every
// answer is a SharingSetupStatus, see src/shared/sharing-setup.ts). The decisions are all in
// sharing-setup.ts; this file only routes, and builds that module's ports for the running app.
//
// No Electron import: index.ts passes `ipcMain`, the user-data folder, `shell.openExternal` and the
// test for WriteFlex's own windows.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cloudflareApiBase, loopbackOrigin } from './cloudflare-api'
import { readSharingServiceFiles } from './sharing-service-bundle'
import { createSharingSetup, type SharingSetup } from './sharing-setup'
import { createRemovalConfirmations } from './sharing-removal'
import { sharingServiceUpdated } from './sharing-reader-notes-run'
import type { SecretsStore } from './secrets-store'
import type { SharingRecord } from './sharing-record'
import { CLOUDFLARE_TOKENS_PAGE, REMOVE_NOT_CONFIRMED, type AttachAddressRequest, type SharingRemovalQuestion, type SharingRemoveRequest, type SharingResult } from '../shared/sharing-setup'

type Registrar = { handle: (channel: string, listener: (event: { sender: { id: number } }, input?: unknown) => unknown) => void }

export const SHARING_CHANNELS = [
  'sharing:status', 'sharing:check-token', 'sharing:check-saved-token', 'sharing:choose-account', 'sharing:set-up',
  'sharing:removal-confirmation', 'sharing:remove', 'sharing:open-cloudflare',
  'sharing:domains', 'sharing:attach-address', 'sharing:remove-address',
] as const

export { REMOVAL_CONFIRMATION_MS } from './sharing-removal'

export type SharingIpcOptions = {
  openExternal: (url: string) => void
  /** True for a renderer that is one of WriteFlex's own windows (state.ts `stateForSender`). */
  isAppWindow: (senderId: number) => boolean
  now?: () => number
  random?: (bytes: number) => Buffer
  /** The address links use may have changed (ticket 05): tell the windows. */
  changed?: () => void
}

/**
 * Every channel answers only WriteFlex's own windows (a top frame: index.ts applyMainFrameOnly).
 * `sharing:remove` deletes the service from the account, so it also needs a confirmation main issued
 * when the question was shown (sharing-removal.ts, rule R3): single-use, for the window that asked,
 * recent, and bound to the removal the question named. `sharing:removal-confirmation` issues one for
 * "Remove sharing from …?" (and Retry); a removal that stops to ask "Remove it anyway?" answers with
 * the confirmation for that question, bound to the service as it was just found. Nothing a window
 * sends can widen what a confirmation may delete. Two are held, a plain one and a "Remove it anyway"
 * one, each replaced only by a new one of its kind; any call to remove uses up both, right or wrong.
 */
export function registerSharingIpc(ipc: Registrar, setup: SharingSetup, options: SharingIpcOptions): void {
  const confirmations = createRemovalConfirmations({ now: options.now, random: options.random })
  const handle = (channel: (typeof SHARING_CHANNELS)[number], listener: (event: { sender: { id: number } }, input?: unknown) => unknown): void => {
    ipc.handle(channel, (event, input) => {
      if (!options.isAppWindow(event.sender.id)) throw new Error('Not a WriteFlex window.')
      return listener(event, input)
    })
  }
  // Ticket 08: a service Settings finds installed and not older than this WriteFlex (updated from another
  // Mac, say) lifts the pause on replies held back for an older one.
  handle('sharing:status', async (_event, input) => {
    const askService = (input as { askService?: unknown } | undefined)?.askService === true
    const status = await setup.status({ askService })
    if (askService && status.service && status.service.installedBuild !== null && status.service.compare !== 'update') sharingServiceUpdated()
    return status
  })
  handle('sharing:check-token', (_event, token) => setup.checkToken(token))
  handle('sharing:check-saved-token', () => setup.checkSavedToken())
  handle('sharing:choose-account', (_event, accountId) => setup.chooseAccount(accountId))
  // Ticket 08: once the service is set up or updated, replies held back for an older service go again.
  handle('sharing:set-up', async () => {
    const result = await setup.setUp()
    if (result.ok) sharingServiceUpdated()
    return result
  })
  handle('sharing:removal-confirmation', (event): SharingRemovalQuestion => {
    const target = setup.removalTarget()
    if (!target) return { confirmation: null }
    return { confirmation: confirmations.issue(event.sender.id, target), accountName: target.accountName, retry: target.operation === 'retry' }
  })
  handle('sharing:remove', async (event, input): Promise<SharingResult> => {
    const request = input as Partial<SharingRemoveRequest> | null | undefined
    const target = confirmations.take(request && typeof request === 'object' ? request.confirmation : undefined, event.sender.id)
    if (!target) return { ok: false, status: await setup.status(), problem: REMOVE_NOT_CONFIRMED }
    const { ask, ...result } = await setup.remove(target)
    if (ask && !result.ok) return { ...result, removeAnyway: true, anywayConfirmation: confirmations.issue(event.sender.id, ask) }
    return result
  })
  handle('sharing:open-cloudflare', () => { options.openExternal(CLOUDFLARE_TOKENS_PAGE) })
  // Ticket 05, your own address. The name and domain a window sends are untrusted: sharing-own-address.ts
  // checks their shape (O1) and that the domain is on the service's account (O2) before any change.
  // Answers are statuses and domain names, never the token. `changed` tells every window the address
  // links use may have changed (the Sharing page reloads its links).
  handle('sharing:domains', () => setup.domains())
  handle('sharing:attach-address', async (_event, input) => {
    const request = input as Partial<AttachAddressRequest> | null | undefined
    const result = await setup.attachAddress(request && typeof request === 'object' ? request.name : undefined, request && typeof request === 'object' ? request.domain : undefined)
    options.changed?.()
    return result
  })
  handle('sharing:remove-address', async () => {
    const result = await setup.removeAddress()
    options.changed?.()
    return result
  })
}

export type SharingAppContext = {
  secrets: SecretsStore
  record: { read(): SharingRecord | null; write(record: SharingRecord | null): boolean }
  /** The folder holding the shipped sharing-service-dist (resources when packaged, the repository otherwise). */
  distDir: string
  packaged: boolean
  env: NodeJS.ProcessEnv
}

/**
 * The set-up for the running app. Test stand-ins (an unpackaged app started with WRITEFLEX_E2E=1):
 * WRITEFLEX_E2E_CLOUDFLARE_API, a loopback `http://127.0.0.1:<port>/client/v4`, and
 * WRITEFLEX_E2E_SHARING_SERVICE, a loopback origin that stands in for the service's address. A
 * packaged build ignores both.
 */
export function openSharingSetup(context: SharingAppContext): SharingSetup {
  const e2e = !context.packaged && context.env.WRITEFLEX_E2E === '1'
  const standInService = e2e ? loopbackOrigin(context.env.WRITEFLEX_E2E_SHARING_SERVICE) : null
  return createSharingSetup({
    secrets: context.secrets,
    record: context.record,
    shipped: () => readSharingServiceFiles((name) => {
      try { return new Uint8Array(readFileSync(join(context.distDir, name))) } catch { return null }
    }),
    fetch: (input, init) => fetch(input, init),
    apiBase: () => cloudflareApiBase({ packaged: context.packaged, e2e, override: context.env.WRITEFLEX_E2E_CLOUDFLARE_API }),
    serviceFetch: (input, init) => fetch(input, init),
    ...(standInService ? { serviceBase: () => standInService } : {}),
  })
}
