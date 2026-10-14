import { randomUUID } from "node:crypto";
import type { ApprovalRequest, ToolRisk } from "./types.ts";

type PendingEntry = {
  request: ApprovalRequest;
  settle: (outcome: "approved" | "denied") => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * ADR-0004: a needs-approval tool call suspends on a pending promise while the
 * host app shows the approval card; timeout resolves to denied.
 */
export class ApprovalBroker {
  #pending = new Map<string, PendingEntry>();
  #timeoutMs: number;
  #onRequest?: (req: ApprovalRequest) => void;
  #onSettle?: (req: ApprovalRequest, outcome: "approved" | "denied") => void;

  constructor(opts?: {
    timeoutMs?: number;
    onRequest?: (req: ApprovalRequest) => void;
    onSettle?: (req: ApprovalRequest, outcome: "approved" | "denied") => void;
  }) {
    this.#timeoutMs = opts?.timeoutMs ?? 120_000;
    this.#onRequest = opts?.onRequest;
    this.#onSettle = opts?.onSettle;
  }

  request(req: { capabilityName: string; risk: ToolRisk; input: unknown; preview?: string }): Promise<"approved" | "denied"> {
    const request: ApprovalRequest = { id: randomUUID(), requestedAt: Date.now(), ...req };
    return new Promise((resolvePromise) => {
      const settle = (outcome: "approved" | "denied") => {
        const entry = this.#pending.get(request.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.#pending.delete(request.id);
        this.#onSettle?.(request, outcome);
        resolvePromise(outcome);
      };
      const timer = setTimeout(() => settle("denied"), this.#timeoutMs);
      this.#pending.set(request.id, { request, settle, timer });
      this.#onRequest?.(request);
    });
  }

  resolve(id: string, approved: boolean): boolean {
    const entry = this.#pending.get(id);
    if (!entry) return false;
    entry.settle(approved ? "approved" : "denied");
    return true;
  }

  pending(): ApprovalRequest[] {
    return [...this.#pending.values()].map((entry) => entry.request);
  }
}
