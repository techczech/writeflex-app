// Electron-free injectable transport entry for tests, non-Electron tooling, and custom preloads.
import { createBridleTransportWithIpc } from "./bridge-transport.ts";
import type { IpcRendererLike } from "./preload-auth.ts";

export { createAuthTransport } from "./preload-auth.ts";
export type { IpcRendererLike } from "./preload-auth.ts";
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

export function createBridleTransport(
  namespace: string,
  ipc: IpcRendererLike,
  options?: import("./bridge-contract.ts").BridleTransportOptions,
) {
  return createBridleTransportWithIpc(namespace, ipc, options);
}
