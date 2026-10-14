import type {
  AdoptGroupResult,
  ApprovalRequest,
  BridleLane,
  Proposal,
  ProposalFilter,
  ProposalPreview,
  ProposalSettlementResult,
  TurnReceipt,
} from "@bridle/core";
import {
  bridleChannels,
  type ApprovalResponseResult,
  type BridleEventCursor,
  type BridleEventFrame,
  type BridleTransport,
  type BridleTransportOptions,
} from "./bridge-contract.ts";
import type { AuthProviderEntry, AuthUiEvent } from "./contract.ts";
import type { IpcRendererLike } from "./preload-auth.ts";

const DEFAULT_APPROVAL_RESPONSE_TIMEOUT_MS = 5_000;

export function createBridleTransportWithIpc(
  namespace: string,
  ipc: IpcRendererLike,
  options: BridleTransportOptions = {},
): BridleTransport {
  const channels = bridleChannels(namespace);
  const approvalResponseTimeoutMs = options.approvalResponseTimeoutMs ?? DEFAULT_APPROVAL_RESPONSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(approvalResponseTimeoutMs) || approvalResponseTimeoutMs < 1) {
    throw new Error("approvalResponseTimeoutMs must be a positive integer.");
  }
  const eventListeners = new Set<(frame: BridleEventFrame) => void>();
  const receivedFrames: BridleEventFrame[] = [];
  const proposalListeners = new Set<(proposals: Proposal[]) => void>();
  const authListeners = new Set<(event: AuthUiEvent) => void>();
  let eventHandler: ((event: unknown, payload: BridleEventFrame) => void) | null = null;
  let proposalHandler: ((event: unknown, payload: Proposal[]) => void) | null = null;
  let authHandler: ((event: unknown, payload: AuthUiEvent) => void) | null = null;
  let lastCursor: BridleEventCursor = { epoch: "unknown", seq: 0 };

  const dispatchEventFrame = (payload: BridleEventFrame): void => {
    if (payload.kind !== "error" && receivedFrames.length) {
      const previous = receivedFrames.at(-1);
      if (previous && previous.kind !== "error" && previous.epoch !== payload.epoch) receivedFrames.length = 0;
    }
    if (payload.kind === "reset") {
      receivedFrames.length = 0;
      lastCursor = { epoch: payload.epoch, seq: 0 };
    } else if (payload.kind === "event") {
      lastCursor = { epoch: payload.epoch, seq: payload.seq };
    } else if (payload.kind === "gap") {
      lastCursor = { epoch: payload.epoch, seq: Math.max(lastCursor.seq, payload.toSeq) };
    }
    receivedFrames.push(payload);
    if (receivedFrames.length > 512) receivedFrames.splice(0, receivedFrames.length - 512);
    for (const listener of eventListeners) listener(payload);
  };

  const subscriptionError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    dispatchEventFrame({ kind: "error", message: `The event subscription failed: ${message}`, recoverable: true });
  };

  const ensureEventHandler = (cursor?: BridleEventCursor | number): void => {
    if (eventHandler) return;
    eventHandler = (_event, payload) => dispatchEventFrame(payload);
    ipc.on(channels.event, eventHandler);
    const requested = typeof cursor === "number"
      ? { epoch: "unknown", seq: cursor }
      : cursor ?? lastCursor;
    if (cursor !== undefined) lastCursor = requested;
    const handshake = cursor === undefined && requested.epoch === "unknown" && requested.seq === 0
      ? undefined
      : { fromSeq: requested.seq, epoch: requested.epoch };
    void ipc.invoke(channels.eventSubscribe, handshake).catch(subscriptionError);
  };
  const ensureProposalHandler = (): void => {
    if (proposalHandler) return;
    proposalHandler = (_event, payload) => {
      for (const listener of proposalListeners) listener(payload);
    };
    ipc.on(channels.proposalsChanged, proposalHandler);
    void ipc.invoke(channels.proposalsSubscribe).catch(subscriptionError);
  };
  const ensureAuthHandler = (): void => {
    if (authHandler) return;
    authHandler = (_event, payload) => {
      for (const listener of authListeners) listener(payload);
    };
    ipc.on(channels.auth.event, authHandler);
  };

  return {
    lane: () => ipc.invoke(channels.lane) as Promise<BridleLane>,
    prompt: (text, context) => ipc.invoke(channels.prompt, { text, ...(context ? { context } : {}) }) as Promise<TurnReceipt>,
    abort: (turnId) => ipc.invoke(channels.abort, turnId) as Promise<boolean>,
    events: {
      subscribe(listener, cursor) {
        eventListeners.add(listener);
        if (eventHandler) {
          const lastSeen = typeof cursor === "number" ? cursor : cursor?.seq ?? 0;
          const requestedEpoch = typeof cursor === "number" ? "unknown" : cursor?.epoch;
          for (const frame of receivedFrames) {
            if (frame.kind === "error" || frame.kind === "disconnect") {
              listener(frame);
              continue;
            }
            if (requestedEpoch && frame.epoch !== requestedEpoch) listener(frame);
            else if (frame.kind === "event" ? frame.seq > lastSeen : frame.toSeq > lastSeen) listener(frame);
          }
        }
        ensureEventHandler(cursor);
        return () => {
          eventListeners.delete(listener);
          if (eventListeners.size || !eventHandler) return;
          ipc.removeListener(channels.event, eventHandler);
          eventHandler = null;
          receivedFrames.length = 0;
          void ipc.invoke(channels.eventUnsubscribe).catch(subscriptionError);
        };
      },
    },
    approvals: {
      pending: () => ipc.invoke(channels.approvalsPending) as Promise<ApprovalRequest[]>,
      async respond(id, approved) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<ApprovalResponseResult>((resolve) => {
          timer = setTimeout(() => resolve({ outcome: "unknown", retryable: true, reason: "timeout" }), approvalResponseTimeoutMs);
        });
        try {
          return await Promise.race([
            ipc.invoke(channels.approvalsRespond, { id, approved }) as Promise<ApprovalResponseResult>,
            timeout,
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
    },
    proposals: {
      list: (filter?: ProposalFilter) => ipc.invoke(channels.proposalsList, filter) as Promise<Proposal[]>,
      preview: (id) => ipc.invoke(channels.proposalsPreview, id) as Promise<ProposalPreview>,
      adopt: (id) => ipc.invoke(channels.proposalsAdopt, id) as Promise<Proposal>,
      reject: (id) => ipc.invoke(channels.proposalsReject, id) as Promise<ProposalSettlementResult>,
      adoptGroup: (groupId) => ipc.invoke(channels.proposalsAdoptGroup, groupId) as Promise<AdoptGroupResult>,
      dismissAll: (filter?: ProposalFilter) => ipc.invoke(channels.proposalsDismissAll, filter) as Promise<ProposalSettlementResult[]>,
      subscribe(listener) {
        proposalListeners.add(listener);
        ensureProposalHandler();
        return () => {
          proposalListeners.delete(listener);
          if (proposalListeners.size || !proposalHandler) return;
          ipc.removeListener(channels.proposalsChanged, proposalHandler);
          proposalHandler = null;
          void ipc.invoke(channels.proposalsUnsubscribe).catch(subscriptionError);
        };
      },
    },
    auth: {
      providers: () => ipc.invoke(channels.auth.providers) as Promise<AuthProviderEntry[]>,
      login: (providerId, method) => ipc.invoke(channels.auth.login, { providerId, method }) as Promise<void>,
      cancel: () => ipc.invoke(channels.auth.cancel) as Promise<void>,
      respond: (requestId, value) => ipc.invoke(channels.auth.respond, { requestId, value }) as Promise<boolean>,
      setApiKey: (providerId, key) => ipc.invoke(channels.auth.setApiKey, { providerId, key }) as Promise<AuthProviderEntry[]>,
      logout: (providerId) => ipc.invoke(channels.auth.logout, providerId) as Promise<AuthProviderEntry[]>,
      subscribe(listener) {
        authListeners.add(listener);
        ensureAuthHandler();
        return () => {
          authListeners.delete(listener);
          if (authListeners.size || !authHandler) return;
          ipc.removeListener(channels.auth.event, authHandler);
          authHandler = null;
        };
      },
    },
  };
}
