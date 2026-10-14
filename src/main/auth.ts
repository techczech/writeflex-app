import { AuthFlowBroker, registerAuthIpc, type AuthBrokerIo, type IpcMainLike } from '@bridle/electron/main'
import type { BridleAuth } from '@bridle/core'

/**
 * WriteFlex's provider lanes (moved here from the deleted bespoke auth-broker.ts):
 * openai-codex = the "ChatGPT" OAuth lane; zai + anthropic = API-key lanes. The
 * framework broker derives oauth/apikey capability per provider from the catalogue.
 */
export const WRITEFLEX_AUTH_PROVIDERS = ['openai-codex', 'anthropic', 'zai'] as const

/**
 * One app-wide broker on the shared bridle.auth:* channels (D1 in the migration
 * spec): auth state is global, so interactive login events broadcast to every
 * window rather than routing to the requester the old per-window broker map did.
 */
export function registerWriteFlexAuth(
  ipcMain: IpcMainLike,
  auth: BridleAuth,
  io: AuthBrokerIo
): { broker: AuthFlowBroker; dispose: () => void } {
  const broker = new AuthFlowBroker(auth, io, { include: [...WRITEFLEX_AUTH_PROVIDERS] })
  const dispose = registerAuthIpc(ipcMain, broker)
  return { broker, dispose }
}
