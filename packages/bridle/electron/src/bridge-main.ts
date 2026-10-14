import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type {
  Bridle,
  BridleEvent,
  ContextItem,
  ProposalFilter,
} from "@bridle/core";
import { AuthFlowBroker } from "./broker.ts";
import {
  bridleChannels,
  type BridleBridgeEvent,
  type BridleEventFrame,
} from "./bridge-contract.ts";
import type { IpcMainLike, WebContentsLike } from "./ipc.ts";
import { toRendererValue } from "./serialization.ts";

export type BridleWindow = () => WebContentsLike | null | undefined;

export type RegisterBridleIpcOptions = {
  namespace?: string;
  windows: readonly BridleWindow[];
  /** Defaults to Electron's process-global `ipcMain`; injectable for deterministic tests. */
  ipcMain?: IpcMainLike;
  /** Defaults to Electron's `shell.openExternal`; injectable for deterministic tests. */
  openExternal?: (url: string) => void | Promise<void>;
  eventFilter?: (event: BridleEvent, target: WebContentsLike) => boolean;
  /** Resolves the sender's main frame. Renderer IPC from sub-frames and webviews is rejected. */
  mainFrameFor?: (target: WebContentsLike) => unknown;
  /** Reject IPC events without senderFrame metadata. Defaults to false for Electron-compatible shims. */
  requireSenderFrame?: boolean;
  replayLimit?: number;
  authProviders?: string[];
  /**
   * Sharing one Harness across namespaces is unsafe by default: an unroutable response in one
   * namespace can force-deny an approval owned by another. Enable only for a deliberately shared UI.
   */
  allowSharedInstance?: boolean;
};

type ElectronMainApi = {
  ipcMain: IpcMainLike;
  shell: { openExternal(url: string): Promise<unknown> };
};

function electronMainApi(): ElectronMainApi {
  const loaded = createRequire(import.meta.url)("electron") as ElectronMainApi | string;
  if (typeof loaded === "string" || !loaded.ipcMain || !loaded.shell) {
    throw new Error("@bridle/electron main APIs must run inside Electron or receive ipcMain and openExternal options.");
  }
  return loaded;
}

function namespaceValue(value: string | undefined): string {
  const namespace = value ?? "bridle";
  if (!/^[A-Za-z0-9._-]+$/.test(namespace)) throw new Error("Bridle IPC namespace must contain only letters, numbers, dots, underscores, or hyphens.");
  return namespace;
}

function requiredString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`Bridle IPC received an invalid ${label}.`);
  return value;
}

function eventCursor(value: unknown): { epoch?: string; fromSeq: number; supplied: boolean } {
  if (value === undefined) return { fromSeq: 0, supplied: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bridle IPC received an invalid event subscription cursor.");
  }
  const cursor = value as Record<string, unknown>;
  if (!Number.isSafeInteger(cursor.fromSeq) || (cursor.fromSeq as number) < 0) {
    throw new Error("Bridle IPC received an invalid event sequence number.");
  }
  if (cursor.epoch !== undefined && (typeof cursor.epoch !== "string" || cursor.epoch.length === 0)) {
    throw new Error("Bridle IPC received an invalid event epoch.");
  }
  return {
    fromSeq: cursor.fromSeq as number,
    supplied: true,
    ...(cursor.epoch ? { epoch: cursor.epoch as string } : {}),
  };
}

function contextItems(value: unknown): ContextItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Bridle IPC received invalid prompt context.");
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error("Bridle IPC received invalid prompt context.");
    const record = item as Record<string, unknown>;
    if (record.kind !== "text" && record.kind !== "file" && record.kind !== "image") throw new Error("Bridle IPC received invalid prompt context kind.");
    requiredString(record.label, "prompt context label");
    if (record.transcript !== "hidden" && record.transcript !== "visible") throw new Error("Bridle IPC received invalid prompt context transcript visibility.");
    if (record.content !== undefined && typeof record.content !== "string") throw new Error("Bridle IPC received invalid prompt context content.");
    if (record.path !== undefined && typeof record.path !== "string") throw new Error("Bridle IPC received invalid prompt context path.");
    if (record.raw !== undefined && typeof record.raw !== "boolean") throw new Error("Bridle IPC received invalid prompt context raw flag.");
  }
  return value as ContextItem[];
}

function proposalFilter(value: unknown): ProposalFilter | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bridle IPC received an invalid Proposal filter.");
  const allowed = new Set(["lane", "status", "kind", "groupId", "capability", "sessionId", "turnId"]);
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.has(key) || typeof entry !== "string") throw new Error("Bridle IPC received an invalid Proposal filter.");
    if (key === "status" && !["proposed", "adopted", "rejected", "stale", "superseded"].includes(entry)) {
      throw new Error("Bridle IPC received an invalid Proposal filter.");
    }
    if (key === "kind" && entry !== "change" && entry !== "action") {
      throw new Error("Bridle IPC received an invalid Proposal filter.");
    }
    if (key === "lane" && entry !== "live" && entry !== "mock" && entry !== "legacy") {
      throw new Error("Bridle IPC received an invalid Proposal filter.");
    }
    if (key !== "status" && key !== "kind" && entry.length === 0) {
      throw new Error("Bridle IPC received an invalid Proposal filter.");
    }
  }
  return value as ProposalFilter;
}

function alive(window: WebContentsLike | null | undefined): window is WebContentsLike {
  return Boolean(window && !window.isDestroyed?.());
}

function isApprovalSurfaceEvent(event: BridleBridgeEvent): boolean {
  return event.type === "approval_requested" || event.type === "approval_settled";
}

function coreEvent(event: BridleBridgeEvent): BridleEvent | undefined {
  return "synthetic" in event ? undefined : event;
}

const activeRegistrations = new WeakMap<Bridle, number>();
// Three consecutive failures distinguish a transient send race from a window that cannot recover.
const MAX_CONSECUTIVE_EVENT_SEND_FAILURES = 3;

/**
 * Registers one Harness behind an explicit Electron window registry. Invoke calls are accepted
 * only from each WebContents' main frame; sub-frame and webview senders are outside the boundary.
 */
export function registerBridleIpc(
  bridle: Bridle,
  options: RegisterBridleIpcOptions,
): { dispose(): void } {
  const namespace = namespaceValue(options.namespace);
  const channels = bridleChannels(namespace);
  const ipcMain = options.ipcMain ?? electronMainApi().ipcMain;
  const openExternal = options.openExternal ?? ((url: string) => { void electronMainApi().shell.openExternal(url); });
  const replayLimit = options.replayLimit ?? 512;
  if (!Number.isSafeInteger(replayLimit) || replayLimit < 1) throw new Error("Bridle IPC replayLimit must be a positive integer.");
  if ((activeRegistrations.get(bridle) ?? 0) > 0 && !options.allowSharedInstance) {
    throw new Error("This Bridle instance is already registered. Pass allowSharedInstance: true only when cross-namespace force-deny behaviour is intentional.");
  }

  const eventSubscribers = new Map<number, {
    lastDeliveredSeq: number;
    consecutiveFailures: number;
    pendingDeliveryGaps: Array<{ fromSeq: number; toSeq: number }>;
  }>();
  const proposalSubscribers = new Set<number>();
  const approvalOwners = new Map<string, { turnId: string }>();
  const tail: Array<Extract<BridleEventFrame, { kind: "event" }>> = [];
  const epoch = randomUUID();
  let sequence = 0;
  let promptInFlight = false;
  let authOwner: number | null = null;
  let authInFlight = false;

  const liveWindows = (): WebContentsLike[] => options.windows.flatMap((getWindow) => {
    try {
      const target = getWindow();
      return alive(target) ? [target] : [];
    } catch {
      return [];
    }
  });
  const senderWindow = (event: unknown): WebContentsLike => {
    const ipcEvent = event as { sender?: WebContentsLike; senderFrame?: unknown };
    const sender = ipcEvent.sender;
    const target = sender && liveWindows().find((window) => window.id === sender.id);
    if (!target) throw new Error("Bridle IPC rejected a sender outside its explicit window registry.");
    if (options.requireSenderFrame && ipcEvent.senderFrame === undefined) {
      throw new Error("Bridle IPC requires senderFrame metadata for main-frame validation.");
    }
    if (ipcEvent.senderFrame !== undefined) {
      const mainFrame = options.mainFrameFor?.(target) ?? target.mainFrame;
      if (mainFrame === undefined || ipcEvent.senderFrame !== mainFrame) {
        throw new Error("Bridle IPC rejected a sender outside the WebContents main frame.");
      }
    }
    return target;
  };
  const send = (target: WebContentsLike, channel: string, payload: unknown): void => {
    if (alive(target)) target.send(channel, toRendererValue(payload));
  };
  const registeredWindows = (): Array<WebContentsLike> => options.windows.flatMap((getWindow) => {
    try {
      const target = getWindow();
      return target ? [target] : [];
    } catch {
      return [];
    }
  });
  const deliverEvent = (
    target: WebContentsLike,
    frame: Extract<BridleEventFrame, { kind: "event" }>,
  ): void => {
    const subscriber = eventSubscribers.get(target.id);
    if (!subscriber) return;
    if (target.isDestroyed?.()) {
      eventSubscribers.delete(target.id);
      return;
    }
    const filterableEvent = coreEvent(frame.event);
    if (filterableEvent && !isApprovalSurfaceEvent(filterableEvent) && options.eventFilter && !options.eventFilter(filterableEvent, target)) {
      if (subscriber.lastDeliveredSeq < frame.seq - 1) {
        subscriber.pendingDeliveryGaps.push({
          fromSeq: subscriber.lastDeliveredSeq + 1,
          toSeq: frame.seq - 1,
        });
      }
      subscriber.lastDeliveredSeq = frame.seq;
      return;
    }
    try {
      while (subscriber.pendingDeliveryGaps.length) {
        const pendingGap = subscriber.pendingDeliveryGaps[0]!;
        send(target, channels.event, {
          kind: "gap",
          epoch,
          ...pendingGap,
          reason: "delivery-failed",
        } satisfies BridleEventFrame);
        subscriber.pendingDeliveryGaps.shift();
      }
      const missedEnd = frame.seq - 1;
      if (subscriber.lastDeliveredSeq < missedEnd) {
        send(target, channels.event, {
          kind: "gap",
          epoch,
          fromSeq: subscriber.lastDeliveredSeq + 1,
          toSeq: missedEnd,
          reason: "delivery-failed",
        } satisfies BridleEventFrame);
        subscriber.lastDeliveredSeq = missedEnd;
      }
      send(target, channels.event, frame);
      subscriber.lastDeliveredSeq = frame.seq;
      subscriber.consecutiveFailures = 0;
    } catch {
      subscriber.consecutiveFailures += 1;
      if (subscriber.consecutiveFailures < MAX_CONSECUTIVE_EVENT_SEND_FAILURES) return;
      try {
        target.send(channels.event, toRendererValue({
          kind: "disconnect",
          epoch,
          reason: "delivery-failed",
          lastDeliveredSeq: subscriber.lastDeliveredSeq,
        } satisfies BridleEventFrame));
      } catch {
        // Best effort only: a persistently failing target may reject the disconnect frame too.
      }
      eventSubscribers.delete(target.id);
    }
  };
  const publishEvent = (event: BridleBridgeEvent): void => {
    const frame = { kind: "event", epoch, seq: ++sequence, event: toRendererValue(event) } as const;
    tail.push(frame);
    if (tail.length > replayLimit) tail.shift();
    for (const target of registeredWindows()) deliverEvent(target, frame);
  };
  const emitSyntheticApprovalSettlement = (id: string, approved = false): void => {
    approvalOwners.delete(id);
    publishEvent({
      id: `bridge-approval-settled:${id}:${randomUUID()}`,
      timestamp: Date.now(),
      type: "approval_settled",
      turnId: null,
      requestId: id,
      decision: approved ? "allow" : "deny",
      synthetic: true,
    });
  };
  const reconcileApprovalOwners = (): {
    requests: ReturnType<Bridle["approvals"]["pending"]>;
    pending: Set<string>;
    expired: Set<string>;
  } => {
    const requests = bridle.approvals.pending();
    const pending = new Set(requests.map((request) => request.id));
    const expired = new Set<string>();
    for (const id of approvalOwners.keys()) {
      if (pending.has(id)) continue;
      expired.add(id);
      emitSyntheticApprovalSettlement(id);
    }
    return { requests, pending, expired };
  };

  const authBroker = new AuthFlowBroker(bridle.auth, {
    openExternal: (url) => { void openExternal(url); },
    emit: (payload) => {
      const target = authOwner === null ? undefined : liveWindows().find((window) => window.id === authOwner);
      if (target) send(target, channels.auth.event, payload);
    },
  }, options.authProviders ? { include: options.authProviders } : {});

  const unsubscribeEvents = bridle.events.subscribe((event) => {
    // Ownership must exist before any renderer can observe and answer the request.
    if (event.type === "approval_requested") approvalOwners.set(event.request.id, { turnId: event.turnId });
    if (event.type === "approval_settled") approvalOwners.delete(event.requestId);
    publishEvent(event);
  });

  const unsubscribeProposals = bridle.proposals.subscribe((proposals) => {
    for (const target of liveWindows()) {
      if (!proposalSubscribers.has(target.id)) continue;
      try {
        send(target, channels.proposalsChanged, proposals);
      } catch {
        proposalSubscribers.delete(target.id);
      }
    }
  });

  const handle = (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, listener);
  };

  handle(channels.prompt, async (event, input) => {
    senderWindow(event);
    if (!input || typeof input !== "object") throw new Error("Bridle IPC received an invalid prompt request.");
    const value = input as Record<string, unknown>;
    const text = requiredString(value.text, "prompt text", true);
    const context = contextItems(value.context);
    if (promptInFlight) throw new Error(`A prompt is already in flight for Bridle namespace '${namespace}'.`);
    promptInFlight = true;
    try {
      const result = await bridle.prompt(text, context ? { context } : undefined);
      return toRendererValue(result.receipt);
    } finally {
      promptInFlight = false;
    }
  });
  handle(channels.abort, (event, turnId) => {
    senderWindow(event);
    return bridle.abort(requiredString(turnId, "turn id"));
  });
  handle(channels.lane, (event) => {
    senderWindow(event);
    return bridle.lane;
  });
  handle(channels.eventSubscribe, (event, cursorValue) => {
    const target = senderWindow(event);
    const cursor = eventCursor(cursorValue);
    const fromSeq = cursor.fromSeq;
    eventSubscribers.set(target.id, {
      lastDeliveredSeq: fromSeq,
      consecutiveFailures: 0,
      pendingDeliveryGaps: [],
    });
    const oldest = tail[0]?.seq;
    const resetReason = cursor.supplied && cursor.epoch !== epoch
      ? "epoch-reset"
      : fromSeq > sequence ? "sequence-reset" : undefined;
    if (resetReason) {
      eventSubscribers.get(target.id)!.lastDeliveredSeq = 0;
      send(target, channels.event, {
        kind: "reset", epoch, fromSeq: oldest ?? 0, toSeq: sequence, reason: resetReason,
      } satisfies BridleEventFrame);
    } else if (oldest !== undefined && fromSeq + 1 < oldest) {
      send(target, channels.event, {
        kind: "gap", epoch, fromSeq: fromSeq + 1, toSeq: oldest - 1, reason: "tail-truncated",
      } satisfies BridleEventFrame);
      eventSubscribers.get(target.id)!.lastDeliveredSeq = oldest - 1;
    }
    for (const frame of tail) {
      if (!resetReason && frame.seq <= fromSeq) continue;
      const filterableEvent = coreEvent(frame.event);
      if (filterableEvent && !isApprovalSurfaceEvent(filterableEvent) && options.eventFilter && !options.eventFilter(filterableEvent, target)) {
        const subscriber = eventSubscribers.get(target.id);
        if (subscriber) subscriber.lastDeliveredSeq = frame.seq;
        continue;
      }
      send(target, channels.event, frame);
      const subscriber = eventSubscribers.get(target.id);
      if (subscriber) subscriber.lastDeliveredSeq = frame.seq;
    }
    return { lane: bridle.lane };
  });
  handle(channels.eventUnsubscribe, (event) => {
    eventSubscribers.delete(senderWindow(event).id);
  });
  handle(channels.approvalsPending, (event) => {
    senderWindow(event);
    const { requests } = reconcileApprovalOwners();
    for (const request of requests) {
      if (!approvalOwners.has(request.id)) approvalOwners.set(request.id, { turnId: "bridge" });
    }
    return toRendererValue(requests);
  });
  handle(channels.approvalsRespond, (event, input) => {
    senderWindow(event);
    if (!input || typeof input !== "object") throw new Error("Bridle IPC received an invalid approval response.");
    const value = input as Record<string, unknown>;
    const id = requiredString(value.id, "approval id");
    if (typeof value.approved !== "boolean") throw new Error("Bridle IPC received an invalid approval decision.");
    const { pending, expired } = reconcileApprovalOwners();
    if (expired.has(id)) return { outcome: "expired" } as const;
    const owner = approvalOwners.get(id);
    if (!owner) {
      if (!pending.has(id)) return { outcome: "unknown-id" } as const;
      bridle.approvals.resolve(id, false);
      if (approvalOwners.has(id)) emitSyntheticApprovalSettlement(id, false);
      return { outcome: "refused", decision: "denied" } as const;
    }
    const settled = bridle.approvals.resolve(id, value.approved);
    if (!settled) {
      reconcileApprovalOwners();
      return { outcome: "expired" } as const;
    }
    if (approvalOwners.has(id)) emitSyntheticApprovalSettlement(id, value.approved);
    return { outcome: "settled", decision: value.approved ? "approved" : "denied" } as const;
  });

  handle(channels.proposalsList, (event, filter) => { senderWindow(event); return bridle.proposals.list(proposalFilter(filter)).then(toRendererValue); });
  handle(channels.proposalsPreview, (event, id) => { senderWindow(event); return bridle.proposals.preview(requiredString(id, "Proposal id")).then(toRendererValue); });
  handle(channels.proposalsAdopt, (event, id) => { senderWindow(event); return bridle.proposals.adopt(requiredString(id, "Proposal id")).then(toRendererValue); });
  handle(channels.proposalsReject, (event, id) => { senderWindow(event); return bridle.proposals.reject(requiredString(id, "Proposal id")).then(toRendererValue); });
  handle(channels.proposalsAdoptGroup, (event, groupId) => { senderWindow(event); return bridle.proposals.adoptGroup(requiredString(groupId, "Proposal group id")).then(toRendererValue); });
  handle(channels.proposalsDismissAll, (event, filter) => { senderWindow(event); return bridle.proposals.dismissAll(proposalFilter(filter)).then(toRendererValue); });
  handle(channels.proposalsSubscribe, (event) => { proposalSubscribers.add(senderWindow(event).id); });
  handle(channels.proposalsUnsubscribe, (event) => { proposalSubscribers.delete(senderWindow(event).id); });

  handle(channels.auth.providers, (event) => { senderWindow(event); return toRendererValue(authBroker.providers()); });
  handle(channels.auth.login, async (event, input) => {
    const target = senderWindow(event);
    if (!input || typeof input !== "object") throw new Error("Bridle IPC received an invalid auth login request.");
    const value = input as Record<string, unknown>;
    const providerId = requiredString(value.providerId, "auth provider id");
    const method = value.method === undefined ? undefined : requiredString(value.method, "auth login method");
    if (authInFlight) throw new Error(`An authentication flow is already in flight for Bridle namespace '${namespace}'.`);
    authInFlight = true;
    authOwner = target.id;
    try {
      await authBroker.login(providerId, method ? { method } : undefined);
    } finally {
      authInFlight = false;
      authOwner = null;
    }
  });
  handle(channels.auth.cancel, (event) => { senderWindow(event); authBroker.cancel(); });
  handle(channels.auth.respond, (event, input) => {
    senderWindow(event);
    if (!input || typeof input !== "object") throw new Error("Bridle IPC received an invalid auth response.");
    const value = input as Record<string, unknown>;
    const requestId = requiredString(value.requestId, "auth request id");
    if (value.value !== undefined && typeof value.value !== "string") throw new Error("Bridle IPC received an invalid auth response value.");
    return authBroker.respond(requestId, value.value as string | undefined);
  });
  handle(channels.auth.setApiKey, (event, input) => {
    senderWindow(event);
    if (!input || typeof input !== "object") throw new Error("Bridle IPC received an invalid API-key request.");
    const value = input as Record<string, unknown>;
    return toRendererValue(authBroker.setApiKey(requiredString(value.providerId, "auth provider id"), requiredString(value.key, "API key", true)));
  });
  handle(channels.auth.logout, (event, providerId) => { senderWindow(event); return toRendererValue(authBroker.logout(requiredString(providerId, "auth provider id"))); });

  const handlerChannels = [
    channels.prompt, channels.abort, channels.lane, channels.eventSubscribe, channels.eventUnsubscribe,
    channels.approvalsPending, channels.approvalsRespond, channels.proposalsList,
    channels.proposalsPreview, channels.proposalsAdopt, channels.proposalsReject,
    channels.proposalsAdoptGroup, channels.proposalsDismissAll,
    channels.proposalsSubscribe, channels.proposalsUnsubscribe, channels.auth.providers,
    channels.auth.login, channels.auth.cancel, channels.auth.respond, channels.auth.setApiKey,
    channels.auth.logout,
  ];

  let disposed = false;
  activeRegistrations.set(bridle, (activeRegistrations.get(bridle) ?? 0) + 1);
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      authBroker.cancel();
      for (const id of [...approvalOwners.keys()]) {
        bridle.approvals.resolve(id, false);
        if (approvalOwners.has(id)) emitSyntheticApprovalSettlement(id, false);
      }
      unsubscribeEvents();
      unsubscribeProposals();
      approvalOwners.clear();
      eventSubscribers.clear();
      proposalSubscribers.clear();
      for (const channel of handlerChannels) ipcMain.removeHandler(channel);
      const registrations = activeRegistrations.get(bridle) ?? 1;
      if (registrations <= 1) activeRegistrations.delete(bridle);
      else activeRegistrations.set(bridle, registrations - 1);
    },
  };
}
