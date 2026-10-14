// Shared entry: the IPC contract + types, safe to import from either process.
export { AUTH_CHANNELS } from "./contract.ts";
export type { AuthProviderEntry, AuthTransport, AuthUiEvent } from "./contract.ts";
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
