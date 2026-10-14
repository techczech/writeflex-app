import type { AuthFlowBroker } from "./broker.ts";
import { AUTH_CHANNELS } from "./contract.ts";
export { createAuthTransport } from "./preload-auth.ts";
export type { IpcRendererLike } from "./preload-auth.ts";

/** Minimal shape of Electron's `ipcMain` — kept structural so @bridle/electron needs no electron dependency. */
export type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
};

/** The renderer identity and send surface used by Electron's `event.sender`. */
export type WebContentsLike = {
  readonly id: number;
  readonly mainFrame?: unknown;
  isDestroyed?(): boolean;
  send(channel: string, payload: unknown): void;
};

/**
 * Register the standard auth:* request/response handlers on an ipcMain, routed to a broker.
 * The interactive event stream (AUTH_CHANNELS.event) is emitted by the broker's `io.emit`, which
 * the host wires to the target `webContents.send`. Returns a disposer that removes the handlers.
 */
export function registerAuthIpc(ipc: IpcMainLike, broker: AuthFlowBroker): () => void {
  ipc.handle(AUTH_CHANNELS.providers, () => broker.providers());
  ipc.handle(AUTH_CHANNELS.login, (_event, input: { providerId: string; method?: string }) => broker.login(input.providerId, { method: input.method }));
  ipc.handle(AUTH_CHANNELS.cancel, () => broker.cancel());
  ipc.handle(AUTH_CHANNELS.respond, (_event, input: { requestId: string; value: string | undefined }) => broker.respond(input.requestId, input.value));
  ipc.handle(AUTH_CHANNELS.setApiKey, (_event, input: { providerId: string; key: string }) => broker.setApiKey(input.providerId, input.key));
  ipc.handle(AUTH_CHANNELS.logout, (_event, providerId: string) => broker.logout(providerId));
  return () => {
    for (const channel of [AUTH_CHANNELS.providers, AUTH_CHANNELS.login, AUTH_CHANNELS.cancel, AUTH_CHANNELS.respond, AUTH_CHANNELS.setApiKey, AUTH_CHANNELS.logout]) {
      ipc.removeHandler(channel);
    }
  };
}

export { registerBridleIpc } from "./bridge-main.ts";
export type { BridleWindow, RegisterBridleIpcOptions } from "./bridge-main.ts";
export { createBridleTransportWithIpc } from "./bridge-transport.ts";
export { bridleChannels } from "./bridge-contract.ts";
export type {
  ApprovalResponseResult,
  BridleBridgeEvent,
  BridleChannels,
  BridleEventCursor,
  BridleEventFrame,
  BridleEventGapReason,
  BridleEventResetReason,
  BridleTransport,
  BridleTransportOptions,
  SyntheticApprovalSettlementEvent,
} from "./bridge-contract.ts";
export { toRendererValue } from "./serialization.ts";
