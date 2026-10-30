import type {
  ApprovalRequest,
  AdoptGroupResult,
  Bridle,
  BridleEvent,
  OAuthLoginCallbacks,
  Proposal,
  ProposalFilter,
  TurnReceipt,
} from "@bridle/core";
import { listProviders } from "@bridle/core/providers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type BridleEventFilter = (event: BridleEvent) => boolean;

export function useBridleEvents(bridle: Bridle, filter?: BridleEventFilter): BridleEvent[] {
  const [events, setEvents] = useState<BridleEvent[]>([]);
  useEffect(() => bridle.events.subscribe((event) => {
    if (!filter || filter(event)) setEvents((current) => [...current, event]);
  }), [bridle, filter]);
  return events;
}

export type TranscriptRow =
  | { kind: "turn"; turnId: string; prompt: string }
  | { kind: "message"; turnId: string; text: string; streaming: boolean }
  | { kind: "tool"; turnId: string; toolCallId: string; capability: string; risk: "read" | "write" | "sync" | "destructive"; status: "running" | "ok" | "error" | "denied" | "staged"; inputPreview: string; message?: string }
  | { kind: "receipt"; turnId: string; receipt: TurnReceipt }
  | { kind: "error"; turnId: string; message: string; recoverable: boolean };

function foldTranscript(rows: TranscriptRow[], event: BridleEvent): TranscriptRow[] {
  if (event.type === "turn_start") return [...rows, { kind: "turn", turnId: event.turnId, prompt: event.promptPreview }];
  if (event.type === "assistant_delta") {
    const index = rows.findIndex((row) => row.kind === "message" && row.turnId === event.turnId && row.streaming);
    if (index === -1) return [...rows, { kind: "message", turnId: event.turnId, text: event.text, streaming: true }];
    return rows.map((row, rowIndex) => rowIndex === index && row.kind === "message" ? { ...row, text: row.text + event.text } : row);
  }
  if (event.type === "assistant_message") {
    return [...rows.filter((row) => !(row.kind === "message" && row.turnId === event.turnId && row.streaming)), {
      kind: "message", turnId: event.turnId, text: event.text, streaming: false,
    }];
  }
  if (event.type === "tool_start") return [...rows, {
    kind: "tool", turnId: event.turnId, toolCallId: event.toolCallId, capability: event.capability,
    risk: event.risk, status: "running", inputPreview: event.inputPreview,
  }];
  if (event.type === "tool_end") return rows.map((row) => row.kind === "tool" && row.toolCallId === event.toolCallId
    ? { ...row, status: event.result, ...(event.message ? { message: event.message } : {}) } : row);
  if (event.type === "turn_end") return [...rows, { kind: "receipt", turnId: event.turnId, receipt: event.receipt }];
  if (event.type === "turn_error") return [...rows, {
    kind: "error", turnId: event.turnId, message: event.message, recoverable: event.recoverable,
  }];
  return rows;
}

export function useTranscript(bridle: Bridle): TranscriptRow[] {
  const [rows, setRows] = useState<TranscriptRow[]>([]);
  useEffect(() => bridle.events.subscribe((event) => setRows((current) => foldTranscript(current, event))), [bridle]);
  return rows;
}

export type GroupProgress = {
  groupId: string;
  state: "idle" | "adopting" | "complete" | "stopped" | "error";
  adopted: string[];
  outcomes: AdoptGroupResult["outcomes"];
  stopped?: AdoptGroupResult["stopped"];
};

export function useProposals(bridle: Bridle, filter?: ProposalFilter) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupProgress, setGroupProgress] = useState<GroupProgress | null>(null);
  const applyFilter = useCallback((items: Proposal[]) => items.filter((proposal) => !filter
    || Object.entries(filter).every(([key, value]) => proposal[key as keyof Proposal] === value)), [filter]);
  useEffect(() => {
    let live = true;
    void bridle.proposals.list(filter).then((items) => {
      if (live) { setProposals(items); setLoading(false); }
    });
    const unsubscribe = bridle.proposals.subscribe((items) => {
      if (live) { setProposals(applyFilter(items)); setLoading(false); }
    });
    return () => { live = false; unsubscribe(); };
  }, [bridle, filter, applyFilter]);

  return useMemo(() => ({
    proposals,
    loading,
    groupProgress,
    adopt: (id: string) => bridle.proposals.adopt(id),
    reject: (id: string) => bridle.proposals.reject(id),
    dismissAll: () => bridle.proposals.dismissAll(filter),
    async adoptGroup(groupId: string) {
      setGroupProgress({ groupId, state: "adopting", adopted: [], outcomes: [] });
      try {
        const result = await bridle.proposals.adoptGroup(groupId);
        setGroupProgress({
          groupId, state: result.stopped ? "stopped" : "complete", adopted: result.adopted,
          outcomes: result.outcomes,
          ...(result.stopped ? { stopped: result.stopped } : {}),
        });
        return result;
      } catch (error) {
        setGroupProgress({ groupId, state: "error", adopted: [], outcomes: [] });
        throw error;
      }
    },
  }), [bridle, filter, groupProgress, loading, proposals]);
}

export function useApprovals(bridle: Bridle) {
  const [pending, setPending] = useState<ApprovalRequest[]>(() => bridle.approvals.pending());
  useEffect(() => bridle.events.subscribe((event) => {
    if (event.type === "approval_requested") setPending((current) => [...current.filter((item) => item.id !== event.request.id), event.request]);
    if (event.type === "approval_settled") setPending((current) => current.filter((item) => item.id !== event.requestId));
  }), [bridle]);
  return {
    pending,
    resolve(id: string, approved: boolean) {
      const resolved = bridle.approvals.resolve(id, approved);
      if (resolved) setPending((current) => current.filter((item) => item.id !== id));
      return resolved;
    },
  };
}

export function useTurnReceipts(bridle: Bridle): TurnReceipt[] {
  const events = useBridleEvents(bridle, useCallback((event) => event.type === "turn_end", []));
  return events.flatMap((event) => event.type === "turn_end" ? [event.receipt] : []);
}

export type AuthInputRequest = {
  requestId: string;
  inputKind: "prompt" | "select" | "manual-code";
  message?: string;
  placeholder?: string;
  options?: { id: string; label: string }[];
};

export type AuthFlowState =
  | { phase: "idle" }
  | { phase: "authorising"; providerId: string }
  | { phase: "auth-url"; providerId: string; url: string; instructions?: string }
  | { phase: "device-code"; providerId: string; userCode: string; verificationUri: string }
  | { phase: "input"; providerId: string; request: AuthInputRequest }
  | { phase: "progress"; providerId: string; message: string }
  | { phase: "complete"; providerId: string }
  | { phase: "error"; providerId: string; message: string };

export function useAuthFlow(bridle: Bridle, openExternal: (url: string) => void = () => {}) {
  const [state, setState] = useState<AuthFlowState>({ phase: "idle" });
  const [revision, setRevision] = useState(0);
  const pending = useRef(new Map<string, (value: string | undefined) => void>());
  const providers = useMemo(() => listProviders().map((provider) => ({
    ...provider, ...bridle.auth.status(provider.id),
  })), [bridle, revision]);
  const request = useCallback((providerId: string, inputKind: AuthInputRequest["inputKind"], extra: Omit<AuthInputRequest, "requestId" | "inputKind"> = {}) =>
    new Promise<string | undefined>((resolve) => {
      const value: AuthInputRequest = { requestId: crypto.randomUUID(), inputKind, ...extra };
      pending.current.set(value.requestId, resolve);
      setState({ phase: "input", providerId, request: value });
    }), []);

  return {
    state,
    providers,
    async login(providerId: string) {
      setState({ phase: "authorising", providerId });
      const callbacks: OAuthLoginCallbacks = {
        onAuth(info) {
          openExternal(info.url);
          setState({ phase: "auth-url", providerId, url: info.url, ...(info.instructions ? { instructions: info.instructions } : {}) });
        },
        onDeviceCode(info) { setState({ phase: "device-code", providerId, userCode: info.userCode, verificationUri: info.verificationUri }); },
        onProgress(message) { setState({ phase: "progress", providerId, message }); },
        onPrompt: async (prompt) => await request(providerId, "prompt", { message: prompt.message, placeholder: prompt.placeholder }) ?? "",
        onSelect: (prompt) => request(providerId, "select", { message: prompt.message, options: prompt.options }),
        onManualCodeInput: async () => await request(providerId, "manual-code", { message: "Paste the redirect URL or authorisation code" }) ?? "",
      };
      try {
        await bridle.auth.login(providerId, callbacks);
        setRevision((value) => value + 1);
        setState({ phase: "complete", providerId });
      } catch (error) {
        setState({ phase: "error", providerId, message: error instanceof Error ? error.message : String(error) });
      } finally {
        pending.current.forEach((resolve) => resolve(undefined));
        pending.current.clear();
      }
    },
    respond(requestId: string, value: string | undefined) {
      const resolve = pending.current.get(requestId);
      if (!resolve) return false;
      pending.current.delete(requestId);
      resolve(value);
      return true;
    },
    setApiKey(providerId: string, key: string) {
      const trimmed = key.trim();
      if (!trimmed) throw new Error("API key is required.");
      bridle.auth.setApiKey(providerId, trimmed);
      setRevision((value) => value + 1);
      setState({ phase: "complete", providerId });
    },
    logout(providerId: string) {
      bridle.auth.logout(providerId);
      setRevision((value) => value + 1);
      setState({ phase: "idle" });
    },
  };
}

export type AuthFlowController = ReturnType<typeof useAuthFlow>;
