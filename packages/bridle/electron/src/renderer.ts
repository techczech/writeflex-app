// Renderer entry: the IPC-backed AuthFlowController hook for @bridle/react's AuthFlow.
export { useIpcAuthFlow, authStateForEvent } from "./controller.ts";
export {
  BridleProvider,
  createBridleRendererAdapter,
  useApprovals,
  useAuthFlow,
  useBridleLane,
  useBridgeError,
  useProposals,
  useTranscript,
  useTurnReceipts,
} from "./renderer-provider.ts";
export type {
  BridleProviderProps,
  BridleRendererAdapter,
  BridleRendererAdapterOptions,
} from "./renderer-provider.ts";
export type {
  ApprovalResponseResult,
  BridleBridgeEvent,
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
