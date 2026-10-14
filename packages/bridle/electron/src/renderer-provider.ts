import type { ApprovalRequest, Bridle, BridleEvent, BridleLane, ProposalFilter } from "@bridle/core";
import {
  useProposals as useReactProposals,
  useTranscript as useReactTranscript,
  useTurnReceipts as useReactTurnReceipts,
} from "@bridle/react";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ApprovalResponseResult,
  BridleBridgeEvent,
  BridleEventCursor,
  BridleEventFrame,
  BridleTransport,
} from "./bridge-contract.ts";
import { useIpcAuthFlow } from "./controller.ts";

export type BridleRendererAdapter = Pick<Bridle, "proposals"> & {
  readonly lane: BridleLane;
  events: {
    subscribe(listener: (event: BridleBridgeEvent) => void): () => void;
  };
  approvals: {
    pending(): ApprovalRequest[];
    respond(id: string, approved: boolean): Promise<ApprovalResponseResult>;
  };
  onGap(listener: (gap: Extract<BridleEventFrame, { kind: "gap" }>) => void): () => void;
  onReset(listener: (reset: Extract<BridleEventFrame, { kind: "reset" }>) => void): () => void;
};

export type BridleRendererAdapterOptions = { eventCursor?: BridleEventCursor };

export async function createBridleRendererAdapter(
  transport: BridleTransport,
  options: BridleRendererAdapterOptions = {},
): Promise<BridleRendererAdapter> {
  const [initialPending, lane] = await Promise.all([
    transport.approvals.pending(),
    transport.lane(),
  ]);
  let pending = initialPending;
  const gapListeners = new Set<(gap: Extract<BridleEventFrame, { kind: "gap" }>) => void>();
  const resetListeners = new Set<(reset: Extract<BridleEventFrame, { kind: "reset" }>) => void>();
  const gapTail: Array<Extract<BridleEventFrame, { kind: "gap" }>> = [];
  const resetTail: Array<Extract<BridleEventFrame, { kind: "reset" }>> = [];
  const deliveredGapIds = new WeakMap<(gap: Extract<BridleEventFrame, { kind: "gap" }>) => void, Set<string>>();
  const deliveredResetIds = new WeakMap<(reset: Extract<BridleEventFrame, { kind: "reset" }>) => void, Set<string>>();
  const bridgeEventListeners = new Set<(event: BridleBridgeEvent) => void>();
  let unsubscribeTransportEvents: (() => void) | null = null;
  const bridgeError = (message: string): BridleEvent => ({
    id: `bridge-error:${crypto.randomUUID()}`,
    timestamp: Date.now(),
    type: "turn_error",
    turnId: "bridge",
    message,
    recoverable: true,
  });
  const releaseTransportEvents = (): void => {
    if (bridgeEventListeners.size || gapListeners.size || resetListeners.size || !unsubscribeTransportEvents) return;
    unsubscribeTransportEvents();
    unsubscribeTransportEvents = null;
  };
  const ensureTransportEvents = (): void => {
    if (unsubscribeTransportEvents) return;
    unsubscribeTransportEvents = transport.events.subscribe((frame) => {
      if (frame.kind === "gap") {
        gapTail.push(frame);
        if (gapTail.length > 16) gapTail.shift();
        const gapId = `${frame.epoch}:${frame.fromSeq}:${frame.toSeq}:${frame.reason}`;
        for (const gapListener of gapListeners) {
          const delivered = deliveredGapIds.get(gapListener) ?? new Set<string>();
          if (!delivered.has(gapId)) gapListener(frame);
          delivered.add(gapId);
          deliveredGapIds.set(gapListener, delivered);
        }
        const marker: BridleEvent = {
          id: `bridge-gap:${frame.epoch}:${frame.fromSeq}:${frame.toSeq}`,
          timestamp: Date.now(),
          type: "turn_error",
          turnId: `bridge:${frame.epoch}`,
          message: `The renderer detected an event history gap (${frame.reason}, ${frame.fromSeq}-${frame.toSeq}).`,
          recoverable: true,
        };
        for (const listener of bridgeEventListeners) listener(marker);
        return;
      }
      if (frame.kind === "reset") {
        resetTail.push(frame);
        if (resetTail.length > 16) resetTail.shift();
        const resetId = `${frame.epoch}:${frame.fromSeq}:${frame.toSeq}:${frame.reason}`;
        for (const resetListener of resetListeners) {
          const delivered = deliveredResetIds.get(resetListener) ?? new Set<string>();
          if (!delivered.has(resetId)) resetListener(frame);
          delivered.add(resetId);
          deliveredResetIds.set(resetListener, delivered);
        }
        return;
      }
      if (frame.kind === "error" || frame.kind === "disconnect") {
        const detail = frame.kind === "error" ? frame.message : "The main process disconnected this event subscriber after repeated delivery failures.";
        const surfaced = bridgeError(detail);
        for (const listener of bridgeEventListeners) listener(surfaced);
        return;
      }
      const event = frame.event;
      if (event.type === "approval_requested") {
        pending = [...pending.filter((request) => request.id !== event.request.id), event.request];
      }
      if (event.type === "approval_settled") {
        pending = pending.filter((request) => request.id !== event.requestId);
      }
      for (const listener of bridgeEventListeners) listener(event);
    }, options.eventCursor);
  };
  const events = {
    subscribe(listener: (event: BridleBridgeEvent) => void): () => void {
      bridgeEventListeners.add(listener);
      ensureTransportEvents();
      return () => {
        bridgeEventListeners.delete(listener);
        releaseTransportEvents();
      };
    },
  };
  const proposals = {
    list: transport.proposals.list,
    async get(id: string) {
      return (await transport.proposals.list()).find((proposal) => proposal.id === id);
    },
    adopt: transport.proposals.adopt,
    reject: (id: string) => transport.proposals.reject(id),
    settleAsHost: () => Promise.reject(new Error("Host settlement is not part of the renderer bridge.")),
    adoptGroup: transport.proposals.adoptGroup,
    dismissAll: transport.proposals.dismissAll,
    preview: transport.proposals.preview,
    subscribe: transport.proposals.subscribe,
  };
  return {
    lane,
    events,
    onGap(listener) {
      gapListeners.add(listener);
      const delivered = deliveredGapIds.get(listener) ?? new Set<string>();
      for (const gap of gapTail) {
        const gapId = `${gap.epoch}:${gap.fromSeq}:${gap.toSeq}:${gap.reason}`;
        if (!delivered.has(gapId)) listener(gap);
        delivered.add(gapId);
      }
      deliveredGapIds.set(listener, delivered);
      ensureTransportEvents();
      return () => {
        gapListeners.delete(listener);
        releaseTransportEvents();
      };
    },
    onReset(listener) {
      resetListeners.add(listener);
      const delivered = deliveredResetIds.get(listener) ?? new Set<string>();
      for (const reset of resetTail) {
        const resetId = `${reset.epoch}:${reset.fromSeq}:${reset.toSeq}:${reset.reason}`;
        if (!delivered.has(resetId)) listener(reset);
        delivered.add(resetId);
      }
      deliveredResetIds.set(listener, delivered);
      ensureTransportEvents();
      return () => {
        resetListeners.delete(listener);
        releaseTransportEvents();
      };
    },
    approvals: {
      pending: () => pending,
      async respond(id: string, approved: boolean) {
        if (!pending.some((request) => request.id === id)) return { outcome: "unknown-id" } as const;
        try {
          const result = await transport.approvals.respond(id, approved);
          if (result.outcome !== "unknown") pending = pending.filter((request) => request.id !== id);
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const surfaced = bridgeError(`The approval response could not be delivered: ${message}`);
          for (const eventListener of bridgeEventListeners) eventListener(surfaced);
          return { outcome: "unknown", retryable: true, reason: "transport-error" } as const;
        }
      },
    } as BridleRendererAdapter["approvals"],
    proposals: proposals as Bridle["proposals"],
  };
}

type BridleProviderValue = {
  adapter: BridleRendererAdapter;
  transport: BridleTransport;
  error: string | null;
};

const BridleRendererContext = createContext<BridleProviderValue | null>(null);

export type BridleProviderProps = {
  transport: BridleTransport;
  children: ReactNode;
  fallback?: ReactNode;
  onGap?: (gap: Extract<BridleEventFrame, { kind: "gap" }>) => void;
  onReset?: (reset: Extract<BridleEventFrame, { kind: "reset" }>) => void;
  /** Cursor persisted by the Host App and used on the Provider's first event handshake. */
  eventCursor?: BridleEventCursor;
  onError?: (message: string) => void;
};

/** Supplies all official trust-surface hooks from one preload transport. */
export function BridleProvider({ transport, children, fallback = null, onGap, onReset, eventCursor, onError }: BridleProviderProps) {
  const [value, setValue] = useState<BridleProviderValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onGapRef = useRef(onGap);
  const onResetRef = useRef(onReset);
  const onErrorRef = useRef(onError);
  useEffect(() => { onGapRef.current = onGap; }, [onGap]);
  useEffect(() => { onResetRef.current = onReset; }, [onReset]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => {
    let live = true;
    void createBridleRendererAdapter(transport, { eventCursor }).then((adapter) => {
      if (live) setValue({ adapter, transport, error: null });
    });
    return () => { live = false; };
  }, [transport, eventCursor?.epoch, eventCursor?.seq]);
  useEffect(() => value ? value.adapter.onGap((gap) => onGapRef.current?.(gap)) : undefined, [value]);
  useEffect(() => value ? value.adapter.onReset((reset) => onResetRef.current?.(reset)) : undefined, [value]);
  useEffect(() => value ? value.adapter.events.subscribe((event) => {
    if (event.type !== "turn_error" || event.turnId !== "bridge") return;
    setError(event.message);
    onErrorRef.current?.(event.message);
  }) : undefined, [value]);
  const contextValue = value ? { ...value, error } : null;
  return value
    ? createElement(BridleRendererContext.Provider, { value: contextValue }, children)
    : createElement(BridleRendererContext.Provider, { value: null }, fallback);
}

function useProviderValue(): BridleProviderValue {
  const value = useContext(BridleRendererContext);
  if (!value) throw new Error("Bridle renderer hooks must be used inside BridleProvider after its transport is ready.");
  return value;
}

export function useProposals(filter?: ProposalFilter) {
  return useReactProposals(useProviderValue().adapter as unknown as Bridle, filter);
}

/**
 * Bridge approval hook. Unlike `@bridle/react`'s boolean `resolve`, this hook exposes only
 * `respond`, which returns the full `ApprovalResponseResult` needed for retry and expiry UI.
 */
export function useApprovals() {
  const { adapter } = useProviderValue();
  const [pending, setPending] = useState(() => adapter.approvals.pending());
  const [settled, setSettled] = useState<Array<{ id: string; status: "approved" | "denied" | "expired" | "unknown" }>>([]);
  useEffect(() => adapter.events.subscribe((event) => {
    if (event.type === "approval_requested") {
      setPending((current) => [...current.filter((item) => item.id !== event.request.id), event.request]);
    }
    if (event.type === "approval_settled") {
      setPending((current) => current.filter((item) => item.id !== event.requestId));
      setSettled((current) => [
        ...current.filter((item) => item.id !== event.requestId),
        { id: event.requestId, status: event.decision === "allow" ? "approved" : "denied" },
      ]);
    }
  }), [adapter]);
  return {
    pending,
    settled,
    async respond(id: string, approved: boolean) {
      const result = await adapter.approvals.respond(id, approved);
      if (result.outcome !== "unknown") {
        setPending((current) => current.filter((item) => item.id !== id));
        const status = result.outcome === "settled"
          ? result.decision
          : result.outcome === "refused" ? "denied"
            : result.outcome === "expired" ? "expired" : "unknown";
        setSettled((current) => [...current.filter((item) => item.id !== id), { id, status }]);
      }
      return result;
    },
  };
}

export function useTranscript() {
  return useReactTranscript(useProviderValue().adapter as unknown as Bridle);
}

export function useTurnReceipts() {
  return useReactTurnReceipts(useProviderValue().adapter as unknown as Bridle);
}

export function useAuthFlow(options: { defaultProviderId?: string } = {}) {
  return useIpcAuthFlow(useProviderValue().transport.auth, options);
}

export function useBridgeError(): string | null {
  return useProviderValue().error;
}

/** The sealed lane is available as soon as the Provider finishes its startup handshake. */
export function useBridleLane(): BridleLane {
  return useProviderValue().adapter.lane;
}
