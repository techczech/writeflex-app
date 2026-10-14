/** Electron-only preload entry. Consumer preload bundlers must externalise Electron. */
import { ipcRenderer } from "electron";
import { createBridleTransport as createInjectableBridleTransport } from "./transport.ts";
import { createAuthTransport as createInjectableAuthTransport } from "./preload-auth.ts";
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
export { AUTH_CHANNELS } from "./contract.ts";
export type { AuthProviderEntry, AuthTransport, AuthUiEvent } from "./contract.ts";

export function createAuthTransport() {
  return createInjectableAuthTransport(ipcRenderer);
}

export function createBridleTransport(
  namespace = "bridle",
  options?: import("./bridge-contract.ts").BridleTransportOptions,
) {
  return createInjectableBridleTransport(namespace, ipcRenderer, options);
}
