import { randomUUID } from "node:crypto";
import type { ApprovalRequest, ToolRisk } from "./types.ts";

export type ApprovalOutcome = "approved" | "denied" | "cancelled";
export type ApprovalResolution = { resolved: true } | { resolved: false; reason: "aborted" | "already-settled" | "unknown-request" };
type RequestInput = { capabilityName: string; risk: ToolRisk; input: unknown; preview?: string; turnId?: string; signal?: AbortSignal };
type PendingEntry = { request: ApprovalRequest; settle: (outcome: ApprovalOutcome) => void };
type BrokerOptions = {
  timeoutMs?: number;
  onRequest?: (req: ApprovalRequest) => void;
  onSettle?: (req: ApprovalRequest, outcome: ApprovalOutcome) => void;
  onObserverError?: (req: ApprovalRequest, stage: "onRequest" | "onSettle") => void;
  onRefused?: (req: ApprovalRequest | undefined, reason: Exclude<ApprovalResolution, { resolved: true }>["reason"], history?: { id: string; turnId: string }) => void;
};

/** Pause-and-resume approvals. Cancellation and observer failures always settle the waiter. */
export class ApprovalBroker {
  #pending = new Map<string, PendingEntry>();
  #settled = new Map<string, { request: ApprovalRequest; outcome: ApprovalOutcome }>();
  #cancelledTurns = new Set<string>();
  #history = new Map<string, { turnId: string; aborted: boolean }>();
  constructor(private readonly options: BrokerOptions = {}) {}

  #observerError(request: ApprovalRequest, stage: "onRequest" | "onSettle"): void {
    try { this.options.onObserverError?.(request, stage); } catch { /* Observers cannot strand a waiter. */ }
  }

  request({ signal, ...req }: RequestInput): Promise<ApprovalOutcome> {
    const request: ApprovalRequest = { id: randomUUID(), requestedAt: Date.now(), ...req };
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => settle("cancelled");
      const settle = (outcome: ApprovalOutcome) => {
        if (!this.#pending.delete(request.id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.#settled.set(request.id, { request, outcome });
        // Resolve before calling host code: even a throwing observer cannot lose this promise.
        resolve(outcome);
        try { this.options.onSettle?.(request, outcome); }
        catch { this.#observerError(request, "onSettle"); }
      };
      this.#pending.set(request.id, { request, settle });
      if (signal?.aborted || (request.turnId && this.#cancelledTurns.has(request.turnId))) {
        settle("cancelled");
        return;
      }
      timer = setTimeout(() => settle("denied"), this.options.timeoutMs ?? 120_000);
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.options.onRequest?.(request); }
      catch { this.#observerError(request, "onRequest"); settle("denied"); }
    });
  }

  cancelTurn(turnId: string): void {
    this.#cancelledTurns.add(turnId);
    for (const entry of this.#pending.values()) {
      if (entry.request.turnId === turnId) entry.settle("cancelled");
    }
  }

  finishTurn(turnId: string): void {
    const aborted = this.#cancelledTurns.delete(turnId);
    for (const [id, settled] of this.#settled) if (settled.request.turnId === turnId) {
      this.#history.set(id, { turnId, aborted: aborted || settled.outcome === "cancelled" });
      this.#settled.delete(id);
    }
    while (this.#history.size > 1_000) this.#history.delete(this.#history.keys().next().value!);
  }

  resolveDetailed(id: string, approved: boolean): ApprovalResolution {
    const entry = this.#pending.get(id);
    if (entry) { entry.settle(approved ? "approved" : "denied"); return { resolved: true }; }
    const previous = this.#settled.get(id);
    const history = this.#history.get(id);
    const reason = previous?.outcome === "cancelled" || history?.aborted ? "aborted" : previous ? "already-settled" : "unknown-request";
    try { this.options.onRefused?.(previous?.request, reason, history ? { id, turnId: history.turnId } : undefined); } catch { /* Refusal stays refused. */ }
    return { resolved: false, reason };
  }

  resolve(id: string, approved: boolean): boolean { return this.resolveDetailed(id, approved).resolved; }
  pending(): ApprovalRequest[] { return [...this.#pending.values()].map((entry) => entry.request); }
}
