import type {
  ApprovalRequest,
  Proposal,
  ProposalPreview,
  TurnReceipt,
} from "@bridle/core";
import { createElement as h, type CSSProperties, type ReactNode } from "react";
import { cardFace } from "./card-face.ts";
import { CHAT_KIT_CSS } from "./chat-kit.ts";
import { TRACE_CSS } from "./trace.ts";
import { MARKDOWN_CSS } from "./markdown.ts";
import type { AuthFlowController, TranscriptRow } from "./hooks.ts";

export { cardFace } from "./card-face.ts";
export { ChatKit, CHAT_KIT_CSS } from "./chat-kit.ts";
export type { ChatKitAgent, ChatKitProps, ChatKitReasoning, ChatKitThread } from "./chat-kit.ts";
export { Trace, TRACE_CSS } from "./trace.ts";
export type { TraceGate, TraceProps, TraceRisk, TraceStep, TraceTurn } from "./trace.ts";
export { Markdown, MARKDOWN_CSS } from "./markdown.ts";
export type { MarkdownProps } from "./markdown.ts";
export {
  useApprovals,
  useAuthFlow,
  useBridleEvents,
  useProposals,
  useTranscript,
  useTurnReceipts,
} from "./hooks.ts";
export type {
  AuthFlowState,
  AuthFlowController,
  AuthInputRequest,
  BridleEventFilter,
  GroupProgress,
  TranscriptRow,
} from "./hooks.ts";

export const BRIDLE_CSS = `
.bridle-card{font:14px/1.45 system-ui,sans-serif;border:1px solid #d7d9de;border-radius:10px;padding:14px;background:#fff;color:#202124}
.bridle-card[data-tone="caution"]{border-color:#c88a18;background:#fffaf0}.bridle-card[data-tone="danger"]{border-color:#b42318;background:#fff6f5}
.bridle-badges{display:flex;gap:6px;flex-wrap:wrap}.bridle-badge{border:1px solid currentColor;border-radius:999px;padding:2px 7px;font-size:12px}
.bridle-actions{display:flex;align-items:center;gap:9px;margin-top:14px}.bridle-action{appearance:none;min-height:38px;padding:8px 14px;border:1px solid transparent;border-radius:8px;font:inherit;font-weight:700;letter-spacing:.01em;cursor:pointer;box-shadow:0 1px 2px rgba(16,24,40,.12);transition:filter .15s ease,transform .15s ease,box-shadow .15s ease}.bridle-action:hover{filter:brightness(.96)}.bridle-action:active{transform:translateY(1px);box-shadow:none}.bridle-action:focus-visible{outline:3px solid rgba(46,144,250,.32);outline-offset:2px}.bridle-action:disabled{cursor:not-allowed;opacity:.55}.bridle-preview{margin-top:10px;border-top:1px solid #e4e6ea;padding-top:10px}
.bridle-diff{display:grid;grid-template-columns:1fr 1fr;gap:8px}.bridle-diff pre,.bridle-invocation{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6f8;padding:10px;border-radius:6px}
.bridle-stale{color:#8a3b12;font-weight:600}.bridle-transcript{display:grid;gap:8px}.bridle-receipt{font-size:12px;color:#4d5156;border-top:1px solid #d7d9de;padding-top:7px}
${CHAT_KIT_CSS}
${TRACE_CSS}
${MARKDOWN_CSS}
`;

type BaseProps = { headless?: boolean };
const className = (headless: boolean | undefined, value: string) => headless ? undefined : value;

const safetyCardStyle = (tone: "calm" | "caution" | "danger"): CSSProperties => ({
  display: "block",
  font: "14px/1.45 system-ui, sans-serif",
  border: `1px solid ${tone === "danger" ? "#b42318" : tone === "caution" ? "#c88a18" : "#d7d9de"}`,
  borderRadius: 10,
  padding: 14,
  backgroundColor: tone === "danger" ? "#fff6f5" : tone === "caution" ? "#fffaf0" : "#ffffff",
  color: "#202124",
});
const safetyBadgeStyle: CSSProperties = {
  display: "inline-block", border: "1px solid currentColor", borderRadius: 999, padding: "2px 7px", fontSize: 12,
};
const safetyPreviewStyle: CSSProperties = {
  display: "block", marginTop: 10, borderTop: "1px solid #e4e6ea", paddingTop: 10,
};
const safetyActionStyle = (
  tone: "calm" | "caution" | "danger",
  action: "adopt" | "reject",
): CSSProperties => {
  const base: CSSProperties = {
    appearance: "none",
    minHeight: 38,
    padding: "8px 14px",
    border: "1px solid transparent",
    borderRadius: 8,
    font: "inherit",
    letterSpacing: ".01em",
    cursor: "pointer",
    boxShadow: "0 1px 2px rgba(16, 24, 40, .12)",
  };
  if (action === "reject") {
    return {
      ...base,
      backgroundColor: "#fff1f0",
      borderColor: "#f0b8b2",
      color: "#b42318",
      fontWeight: 700,
    };
  }
  if (tone === "calm") {
    return { ...base, backgroundColor: "#18794e", borderColor: "#146c43", color: "#ffffff", fontWeight: 700 };
  }
  if (tone === "caution") {
    return { ...base, backgroundColor: "#a15c00", borderColor: "#8a4e00", color: "#ffffff", fontWeight: 750 };
  }
  return {
    ...base,
    backgroundColor: "#b42318",
    borderColor: "#8f1c13",
    color: "#ffffff",
    fontWeight: 800,
    boxShadow: "0 0 0 2px #ffd7d2, 0 1px 2px rgba(16, 24, 40, .16)",
  };
};

export type DiffViewProps = BaseProps & { preview: Extract<ProposalPreview, { kind: "text-diff" }> };
export function DiffView({ preview, headless }: DiffViewProps) {
  return h("section", { className: className(headless, "bridle-preview"), "data-bridle-trusted-chrome": "preview" },
    preview.stale ? h("p", { role: "alert", className: className(headless, "bridle-stale") }, "The files changed since this action was prepared, so this preview may be out of date. Re-run the request to refresh it.") : null,
    h("div", { className: className(headless, "bridle-diff") },
      h("div", null, h("strong", null, "Before"), h("pre", null, preview.before)),
      h("div", null, h("strong", null, "After"), h("pre", null, preview.after)),
    ),
  );
}

function Preview({ preview }: { preview: ProposalPreview }) {
  if (preview.kind === "text-diff") return h("section", { className: "bridle-preview", style: safetyPreviewStyle, "data-bridle-trusted-chrome": "preview" },
    preview.stale ? h("p", { role: "alert", style: { color: "#8a3b12", fontWeight: 600 } }, "The files changed since this action was prepared, so this preview may be out of date. Re-run the request to refresh it.") : null,
    h("div", { className: "bridle-diff" },
      h("div", null, h("strong", null, "Before"), h("pre", null, preview.before)),
      h("div", null, h("strong", null, "After"), h("pre", null, preview.after)),
    ),
  );
  if (preview.kind === "file-ops") return h("section", { className: "bridle-preview", style: safetyPreviewStyle, "data-bridle-trusted-chrome": "preview" },
    preview.stale ? h("p", { role: "alert", style: { color: "#8a3b12", fontWeight: 600 } }, "The files changed since this action was prepared, so this preview may be out of date. Re-run the request to refresh it.") : null,
    preview.inferred ? h("p", null, "File operations inferred from current state.") : null,
    h("ul", null, ...preview.ops.map((operation) => h("li", { key: `${operation.op}:${operation.path}` }, `${operation.op}: ${operation.path}${operation.toPath ? ` → ${operation.toPath}` : ""}`))),
  );
  return h("section", { className: "bridle-preview", style: safetyPreviewStyle, "data-bridle-trusted-chrome": "preview" },
    preview.stale ? h("p", { role: "alert", style: { color: "#8a3b12", fontWeight: 600 } }, "The files changed since this action was prepared, so this preview may be out of date. Re-run the request to refresh it.") : null,
    h("p", null, preview.description),
    h("pre", { className: "bridle-invocation" }, JSON.stringify(preview.input, null, 2)),
    !preview.reversible ? h("p", { style: { display: "block", color: "#8a3b12", fontWeight: 700 } }, "This action cannot be automatically reversed.") : null,
  );
}

export type ProposalCardProps = {
  proposal: Proposal;
  preview: ProposalPreview;
  onAdopt?: (id: string) => void | Promise<void>;
  onReject?: (id: string) => void | Promise<void>;
};

export function ProposalCard({ proposal, preview, onAdopt, onReject }: ProposalCardProps) {
  const risk = preview.kind === "invocation" ? preview.risk : proposal.risk;
  const egress = preview.kind === "invocation" ? preview.egress : "none";
  const face = cardFace(proposal.kind, risk, egress);
  return h("article", {
    className: "bridle-card", style: safetyCardStyle(face.tone), "data-tone": face.tone,
    "data-bridle-trusted-chrome": "proposal-card",
  },
  h("h3", null, proposal.title),
  h("div", { className: "bridle-badges", style: { display: "flex", gap: 6, flexWrap: "wrap" }, "aria-label": "Proposal safety details" },
    ...face.badges.map((badge) => h("span", { className: "bridle-badge", style: safetyBadgeStyle, key: badge }, badge)),
  ),
  h(Preview, { preview }),
  ...(proposal.supplements ?? []).map((supplement, index) => h("aside", { key: index },
    h("strong", null, supplement.source === "host-rendered" ? "Host-rendered supplement" : "Agent-authored supplement"),
    h("p", null, supplement.markdown),
  )),
  proposal.status === "proposed" ? h("div", { className: "bridle-actions", style: { display: "flex", alignItems: "center", gap: 9, marginTop: 14 } },
    h("button", {
      type: "button",
      className: "bridle-action bridle-action-adopt",
      style: safetyActionStyle(face.tone, "adopt"),
      "data-action-tone": face.tone,
      onClick: () => onAdopt?.(proposal.id),
    }, "Adopt Proposal"),
    h("button", {
      type: "button",
      className: "bridle-action bridle-action-reject",
      style: safetyActionStyle(face.tone, "reject"),
      "data-action-tone": face.tone,
      onClick: () => onReject?.(proposal.id),
    }, "Reject Proposal"),
  ) : h("p", null, `Status: ${proposal.status}`));
}

export type ProposalListItem = Omit<ProposalCardProps, "onAdopt" | "onReject">;
export function ProposalList({ items, onAdopt, onReject }: {
  items: ProposalListItem[];
  onAdopt?: ProposalCardProps["onAdopt"];
  onReject?: ProposalCardProps["onReject"];
}) {
  return h("div", { "data-bridle-trusted-chrome": "proposal-list" },
    ...items.map((item) => h(ProposalCard, { ...item, onAdopt, onReject, key: item.proposal.id })),
  );
}

export function ApprovalCard({ request, onResolve }: {
  request: ApprovalRequest;
  onResolve: (id: string, approved: boolean) => void;
}) {
  const tone = request.risk === "destructive" ? "danger" : "caution";
  return h("article", { className: "bridle-card", style: safetyCardStyle(tone), "data-tone": tone, "data-bridle-trusted-chrome": "approval-card" },
    h("h3", null, request.capabilityName),
    h("span", { className: "bridle-badge", style: safetyBadgeStyle }, request.risk.charAt(0).toUpperCase() + request.risk.slice(1)),
    h("pre", { className: "bridle-invocation", style: { display: "block", whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, JSON.stringify(request.input, null, 2)),
    request.preview ? h("p", null, request.preview) : null,
    h("div", { className: "bridle-actions", style: { display: "flex", gap: 8, marginTop: 12 } },
      h("button", { type: "button", onClick: () => onResolve(request.id, true) }, "Allow"),
      h("button", { type: "button", onClick: () => onResolve(request.id, false) }, "Deny"),
    ),
  );
}

export function TurnReceiptFooter({ receipt }: { receipt: TurnReceipt }) {
  const parts = [
    `${receipt.filesRead.length} read`, `${receipt.filesWritten.length} written`,
    `${receipt.callsDenied} denied`, `${receipt.callsStaged} staged`,
    `${receipt.usage.input + receipt.usage.output} tokens`,
    `${receipt.usage.cacheRead} cache read`, `${receipt.egress.providerId}/${receipt.egress.modelId}`,
  ];
  return h("footer", {
    className: "bridle-receipt",
    style: { display: "block", fontSize: 12, color: "#4d5156", borderTop: "1px solid #d7d9de", paddingTop: 7 },
    "data-bridle-trusted-chrome": "turn-receipt",
  }, parts.join(" · "));
}

export function Transcript({ rows, headless }: BaseProps & { rows: TranscriptRow[] }) {
  const rendered: ReactNode[] = rows.map((row, index) => {
    if (row.kind === "turn") return h("p", { key: index }, row.prompt);
    if (row.kind === "message") return h("p", { key: index, "aria-busy": row.streaming }, row.text);
    if (row.kind === "tool") return h("p", { key: index }, `${row.capability}: ${row.status}${row.message ? ` — ${row.message}` : ""}`);
    if (row.kind === "error") return h("p", { key: index, role: "alert" }, row.message);
    return h(TurnReceiptFooter, { key: index, receipt: row.receipt });
  });
  return h("section", { className: className(headless, "bridle-transcript"), "aria-label": "Transcript" }, ...rendered);
}

export function AuthFlow({ flow, headless }: BaseProps & { flow: AuthFlowController }) {
  const { state } = flow;
  let body: ReactNode = h("p", null, "Choose a provider to sign in.");
  if (state.phase === "auth-url") body = h("p", null, state.instructions ?? `Continue sign-in at ${state.url}`);
  if (state.phase === "device-code") body = h("p", null, `Enter ${state.userCode} at ${state.verificationUri}`);
  if (state.phase === "progress") body = h("p", null, state.message);
  if (state.phase === "complete") body = h("p", null, "Sign-in complete.");
  if (state.phase === "error") body = h("p", { role: "alert" }, state.message);
  if (state.phase === "input") body = h("form", { onSubmit: (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    flow.respond(state.request.requestId, String(new FormData(form).get("value") ?? ""));
  } },
  h("label", null, state.request.message ?? "Enter a value", h("input", { name: "value", placeholder: state.request.placeholder })),
  h("button", { type: "submit" }, "Continue"));
  const providers = flow.providers.map((provider) => h("section", { key: provider.id },
    h("h3", null, provider.label),
    provider.configured
      ? h("button", { type: "button", onClick: () => flow.logout(provider.id) }, "Sign out")
      : null,
    !provider.configured && provider.authLanes.includes("oauth")
      ? h("button", { type: "button", onClick: () => { void flow.login(provider.id); } }, "Sign in")
      : null,
    !provider.configured && provider.authLanes.includes("apikey")
      ? h("form", { onSubmit: (event: SubmitEvent) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        flow.setApiKey(provider.id, String(new FormData(form).get("apiKey") ?? ""));
      } },
      h("label", null, `${provider.label} API key`, h("input", { name: "apiKey", type: "password", autoComplete: "off" })),
      h("button", { type: "submit" }, "Save API key"))
      : null,
  ));
  return h("section", { className: className(headless, "bridle-card"), "data-bridle-trusted-chrome": "auth-flow" }, ...providers, body);
}
