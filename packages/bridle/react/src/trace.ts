import { AlertTriangle, ArrowRight, ChevronRight, Eye, FlaskConical, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { createElement as h, useState, type ReactNode } from "react";
import { Markdown } from "./markdown.ts";

/**
 * The Trace surface (Bridle ADR-0027) — the minimal, in-app inspector tier.
 * An inline fold under an agent turn that expands into a step-timeline
 * (thought -> tool -> tool -> answered). Shows only what the record proves:
 * reasoning verbatim, tool steps with their gate outcome, the answer. Reads
 * render calm (no gate badge). "full record ->" escalates to the maximal tier
 * (BridleScout / an app's forensic inspector). The user-facing control is
 * labelled "Show agent's work"; "Trace" stays the internal name.
 */

export type TraceRisk = "read" | "write" | "sync" | "destructive" | (string & {});
export type TraceGate = "staged" | "approved" | "denied" | "ran" | "staging" | "error";

export type TraceStep = {
  toolCallId: string;
  capability: string;               // e.g. "pack.file_tools.move_file"
  risk: TraceRisk;
  paths?: readonly string[];        // ["invoice.pdf", "pdfs/invoice.pdf"] -> "a -> b"
  gate?: TraceGate;                 // gate outcome; omitted for reads (they render calm)
  running?: boolean;                // currently executing (live)
};

export type TraceTurn = {
  turnId: string;
  execution?: {
    model?: string;
    provider?: string;
    reasoning?: string;             // "high"
    authOk?: boolean;
    mock?: boolean;                 // deterministic run — a mock preset, no live model
  };
  reasoning?: string | null;        // the turn's thinking summary, verbatim
  steps?: readonly TraceStep[];
  answer?: string | null;           // final assistant text, or the error message
  isError?: boolean;
  durationMs?: number;
};

export type TraceProps = {
  turn: TraceTurn;
  live?: boolean;
  defaultOpen?: boolean;
  onOpenScout?: (turnId: string) => void;
};

export const TRACE_CSS = `
.bridle-trace{margin-top:9px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;overflow:hidden;
  font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c2024;transition:border-color .15s}
.bridle-trace-open{border-color:#dfe3ea}
.bridle-trace-sum{display:flex;align-items:center;gap:9px;padding:0;background:#fcfcfd}
.bridle-trace-open .bridle-trace-sum{background:#fcfcfd}
.bridle-trace-live .bridle-trace-sum{background:#fbfaff}
.bridle-trace-toggle{flex:1;min-width:0;display:flex;align-items:center;gap:9px;padding:10px 4px 10px 12px;
  appearance:none;border:0;background:transparent;font:inherit;color:#3b4250;cursor:pointer;text-align:left}
.bridle-trace-toggle:hover{background:#f7f8fa}
.bridle-trace-chev{color:#9aa1ab;display:inline-flex;transition:transform .18s}
.bridle-trace-open .bridle-trace-chev{transform:rotate(90deg)}
.bridle-trace-lead{display:inline-flex;align-items:center;gap:6px;font-weight:650;color:#2b3038}
.bridle-trace-lead .bridle-trace-spark{color:#7c6df0;display:inline-flex}
.bridle-trace-meta{color:#6b7280;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bridle-trace-scout{flex:none;display:inline-flex;align-items:center;gap:4px;margin:0 10px;padding:4px 6px;
  appearance:none;border:0;background:transparent;color:#2563eb;font:inherit;font-size:12px;font-weight:600;cursor:pointer;border-radius:6px}
.bridle-trace-scout:hover{background:#eef2ff;text-decoration:underline}
.bridle-trace-body{border-top:1px solid #eef0f3}
.bridle-trace-exec{display:flex;flex-wrap:wrap;align-items:center;gap:4px 9px;padding:10px 14px;font-size:11.5px;
  color:#6b7280;border-bottom:1px solid #eef0f3;background:linear-gradient(#fff,#fcfcfd)}
.bridle-trace-exec b{color:#374151;font-weight:650}.bridle-trace-exec .bridle-trace-authok{color:#1f8a4c;font-weight:650}
.bridle-trace-exec-mock{background:repeating-linear-gradient(-45deg,#faf6ff,#faf6ff 9px,#f4edff 9px,#f4edff 18px);color:#6b4fb8}
.bridle-trace-mock{display:inline-flex;align-items:center;gap:4px;font-weight:700;color:#6b4fb8}
.bridle-trace-timeline{padding:4px 16px 12px}
.bridle-trace-node{position:relative;padding:11px 0 11px 27px}
.bridle-trace-node::before{content:"";position:absolute;left:7px;top:25px;bottom:-4px;width:2px;background:#e4e7ec}
.bridle-trace-node:last-child::before{display:none}
.bridle-trace-pin{position:absolute;left:0;top:12px;width:16px;height:16px;border-radius:50%;display:grid;place-items:center;
  background:#fff;border:2px solid #e4e7ec;color:#9aa1ab}
.bridle-trace-node-think .bridle-trace-pin{border-color:#cdc6f6;color:#7c6df0}
.bridle-trace-node-write .bridle-trace-pin{border-color:#e6cfb2;color:#8a4b12}
.bridle-trace-node-read .bridle-trace-pin{border-color:#bfe0da;color:#0f6e63}
.bridle-trace-node-answer .bridle-trace-pin{border-color:#bfe3cb;color:#1f8a4c}
.bridle-trace-node-error .bridle-trace-pin{border-color:#f0b8b2;color:#b42318}
.bridle-trace-node-running .bridle-trace-pin{border-color:#c9d2ff;color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}
.bridle-trace-h{font-size:12.5px;font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bridle-trace-cap{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.bridle-trace-body-text{font-size:13px;color:#454b53;margin-top:3px;white-space:pre-wrap;overflow-wrap:anywhere}
.bridle-trace-paths{display:flex;align-items:center;gap:8px;margin-top:5px;flex-wrap:wrap}
.bridle-trace-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#6b7280;overflow-wrap:anywhere}
.bridle-trace-arrow{color:#9aa1ab;display:inline-flex}
.bridle-trace-kick{font-size:10.5px;color:#9aa1ab;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.bridle-trace-muted{padding:12px 14px;font-size:12.5px;color:#9aa1ab}
.bridle-trace-badge{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:650;padding:2px 8px;border-radius:999px;white-space:nowrap}
.bridle-trace-badge-write{color:#8a4b12;background:#fdf2e6}
.bridle-trace-badge-read{color:#0f6e63;background:#e7f4f1}
.bridle-trace-badge-staged{color:#5a44c9;background:#efeafe}
.bridle-trace-badge-ok{color:#1f8a4c;background:#e7f5ec}
.bridle-trace-badge-denied{color:#b42318;background:#fff1f0}
.bridle-trace-pulse{width:7px;height:7px;border-radius:50%;background:#7c6df0;animation:bridle-trace-pulse 1.3s infinite;display:inline-block}
@keyframes bridle-trace-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.bridle-trace-dots{display:inline-flex;gap:3px;margin-left:5px;vertical-align:middle}
.bridle-trace-dots i{width:4px;height:4px;border-radius:50%;background:#7c6df0;animation:bridle-trace-bounce 1.2s infinite;display:inline-block}
.bridle-trace-dots i:nth-child(2){animation-delay:.15s}.bridle-trace-dots i:nth-child(3){animation-delay:.3s}
@keyframes bridle-trace-bounce{0%,60%,100%{opacity:.3}30%{opacity:1}}
.bridle-trace button:focus-visible{outline:3px solid rgba(37,99,235,.24);outline-offset:2px}
@media (prefers-reduced-motion:reduce){.bridle-trace-pulse,.bridle-trace-dots i{animation:none;opacity:.7}}
`;

const shortCapability = (name: string): string => name.split(".").at(-1) ?? name;
const isRead = (risk: TraceRisk): boolean => risk === "read";

const GATE_LABEL: Record<TraceGate, string> = {
  staged: "staged", approved: "approved", denied: "denied", ran: "ran", staging: "staging…", error: "error",
};
const GATE_TONE: Record<TraceGate, string> = {
  staged: "staged", approved: "ok", denied: "denied", ran: "ok", staging: "staged", error: "denied",
};

function digest(turn: TraceTurn): string {
  const parts: string[] = [];
  if (turn.reasoning) parts.push("thought");
  const steps = turn.steps ?? [];
  const staged = steps.filter((step) => step.gate === "staged").length;
  const reads = steps.filter((step) => isRead(step.risk)).length;
  if (staged > 0) parts.push(`${staged} staged`);
  else if (reads > 0 && reads === steps.length) parts.push(`read ${reads}`);
  else if (steps.length > 0) parts.push(`${steps.length} step${steps.length === 1 ? "" : "s"}`);
  if (turn.isError) parts.push("error");
  else if (turn.answer) parts.push("answered");
  return parts.join(" · ");
}

function execLine(turn: TraceTurn, live: boolean): ReactNode {
  const bits: ReactNode[] = [];
  const push = (node: ReactNode) => bits.push(h("span", { key: bits.length }, node));
  const stepCount = turn.steps?.length ?? 0;
  if (turn.execution?.mock) {
    // Deterministic run: never present a model, provider, or reasoning level —
    // nothing here was produced by a live model.
    push(h("span", { className: "bridle-trace-mock" }, h(FlaskConical, { size: 12 }), " Mock preset"));
    push("· no live model");
    if (stepCount > 0) push(`· ${stepCount} step${stepCount === 1 ? "" : "s"}`);
    return h("div", { className: "bridle-trace-exec bridle-trace-exec-mock" }, ...bits);
  }
  if (turn.execution?.model) push(h("b", null, turn.execution.model));
  if (turn.execution?.provider) push(`· ${turn.execution.provider}`);
  if (turn.execution?.reasoning) push(h("span", null, "· reasoning ", h("b", null, turn.execution.reasoning)));
  if (turn.execution?.authOk) push(h("span", null, "· ", h("span", { className: "bridle-trace-authok" }, "auth ok")));
  if (stepCount > 0) push(`· ${stepCount} step${stepCount === 1 ? "" : "s"}`);
  if (live) push("· running…");
  else if (typeof turn.durationMs === "number") push(`· ${(turn.durationMs / 1000).toFixed(1)}s`);
  if (bits.length === 0) return null;
  return h("div", { className: "bridle-trace-exec" }, ...bits);
}

function badge(tone: string, label: string, icon?: ReactNode): ReactNode {
  return h("span", { className: `bridle-trace-badge bridle-trace-badge-${tone}` }, icon ?? null, label);
}

function stepNode(step: TraceStep): ReactNode {
  const read = isRead(step.risk);
  const heading: ReactNode[] = [h("span", { key: "cap", className: "bridle-trace-cap" }, shortCapability(step.capability))];
  if (read) heading.push(badge("read", "READ", h(Eye, { size: 12 })));
  else heading.push(badge("write", "WRITE", h(Wrench, { size: 11 })));
  if (step.running) heading.push(h("span", { key: "kick", className: "bridle-trace-kick" }, "staging…"));
  else if (step.gate && !read) heading.push(badge(GATE_TONE[step.gate], GATE_LABEL[step.gate], h(ShieldCheck, { size: 11 })));
  const paths = step.paths ?? [];
  return h("div", { key: step.toolCallId, className: `bridle-trace-node bridle-trace-node-${read ? "read" : "write"}${step.running ? " bridle-trace-node-running" : ""}` },
    h("span", { className: "bridle-trace-pin" }, h(read ? Eye : Wrench, { size: 9 })),
    h("div", { className: "bridle-trace-h" }, ...heading),
    paths.length > 0
      ? h("div", { className: "bridle-trace-paths" },
        ...paths.flatMap((path, index) => index === 0
          ? [h("span", { key: path + index, className: "bridle-trace-path" }, path)]
          : [h("span", { key: `arrow${index}`, className: "bridle-trace-arrow" }, h(ArrowRight, { size: 13 })),
             h("span", { key: path + index, className: "bridle-trace-path" }, path)]))
      : null);
}

function timeline(turn: TraceTurn): ReactNode {
  const nodes: ReactNode[] = [];
  if (turn.reasoning) {
    nodes.push(h("div", { key: "think", className: "bridle-trace-node bridle-trace-node-think" },
      h("span", { className: "bridle-trace-pin" }, h(Sparkles, { size: 9 })),
      h("div", { className: "bridle-trace-h" }, "Thought"),
      h("div", { className: "bridle-trace-body-text" }, turn.reasoning)));
  }
  for (const step of turn.steps ?? []) nodes.push(stepNode(step));
  if (turn.answer != null && turn.answer !== "") {
    const kind = turn.isError ? "error" : "answer";
    nodes.push(h("div", { key: "answer", className: `bridle-trace-node bridle-trace-node-${kind}` },
      h("span", { className: "bridle-trace-pin" }, h(turn.isError ? AlertTriangle : ShieldCheck, { size: 9 })),
      h("div", { className: "bridle-trace-h" }, turn.isError ? "Failed" : "Answered"),
      // Errors are a single human-readable line; a real answer is formatted Markdown.
      turn.isError
        ? h("div", { className: "bridle-trace-body-text" }, turn.answer)
        : h("div", { className: "bridle-trace-body-text" }, h(Markdown, { text: turn.answer }))));
  }
  if (nodes.length === 0) return h("div", { className: "bridle-trace-muted" }, "No recorded activity for this turn.");
  return h("div", { className: "bridle-trace-timeline" }, ...nodes);
}

export function Trace({ turn, live = false, defaultOpen, onOpenScout }: TraceProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen ?? live);
  const label = open ? "Hide agent's work" : "Show agent's work";
  const meta = digest(turn);
  return h("div", { className: `bridle-trace${open ? " bridle-trace-open" : ""}${live ? " bridle-trace-live" : ""}` },
    h("div", { className: "bridle-trace-sum" },
      h("button", {
        type: "button",
        className: "bridle-trace-toggle",
        "aria-expanded": open,
        onClick: () => setOpen((value) => !value),
      },
        h("span", { className: "bridle-trace-chev" }, h(ChevronRight, { size: 15 })),
        h("span", { className: "bridle-trace-lead" },
          live ? h("span", { className: "bridle-trace-pulse", "aria-hidden": true }) : h("span", { className: "bridle-trace-spark" }, h(Sparkles, { size: 14 })),
          h("span", { className: "bridle-trace-label" }, label)),
        live
          ? h("span", { className: "bridle-trace-meta" }, "working", h("span", { className: "bridle-trace-dots", "aria-hidden": true }, h("i"), h("i"), h("i")))
          : meta ? h("span", { className: "bridle-trace-meta" }, `· ${meta}`) : null),
      onOpenScout
        ? h("button", {
            type: "button",
            className: "bridle-trace-scout",
            onClick: () => onOpenScout(turn.turnId),
          }, "full record ", h(ArrowRight, { size: 13 }))
        : null),
    open ? h("div", { className: "bridle-trace-body" }, execLine(turn, live), timeline(turn)) : null);
}
