// Main-process + preload entry: the auth broker and the IPC wiring.
export { AuthFlowBroker } from "./broker.ts";
export type { AuthBrokerIo, AuthBrokerOptions } from "./broker.ts";
export { registerAuthIpc } from "./ipc.ts";
export { registerBridleIpc, bridleChannels } from "./ipc.ts";
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
  BridleWindow,
  IpcMainLike,
  RegisterBridleIpcOptions,
  WebContentsLike,
} from "./ipc.ts";
export { AUTH_CHANNELS } from "./contract.ts";
export type { AuthProviderEntry, AuthTransport, AuthUiEvent } from "./contract.ts";
