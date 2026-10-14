import { ArrowUp, Check, ChevronDown, FlaskConical, MessageSquare, Plus } from "lucide-react";
import {
  createElement as h,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type ChatKitReasoning = "minimal" | "low" | "medium" | "high";

export type ChatKitThread = {
  id: string;
  title: string;
  updatedAt: number;
  turnCount: number;
};

export type ChatKitAgent = {
  models: Array<{ id: string; label: string }>;
  model: string;
  reasoning: ChatKitReasoning;
  onModel: (id: string) => void;
  onReasoning: (level: ChatKitReasoning) => void;
  live?: boolean;
  providerLabel?: string;
  mock?: boolean;                   // deterministic/scripted run — show "Mock", never a live model
};

export type ChatKitProps = {
  threads: ChatKitThread[];
  activeThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  children: ReactNode;
  onSend: (text: string) => void;
  busy?: boolean;
  error?: string | null;
  agent: ChatKitAgent;
  threadsMode?: "dropdown";
  usageSlot?: ReactNode;
};

export const CHAT_KIT_CSS = `
.bridle-chat-kit{display:flex;min-width:0;min-height:0;height:100%;flex-direction:column;background:#fff;color:#202124;font:14px/1.45 system-ui,sans-serif}
.bridle-chat-header{position:relative;display:flex;min-height:48px;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #e2e4e9;background:#fff}
.bridle-chat-thread-trigger,.bridle-chat-new,.bridle-chat-agent-trigger,.bridle-chat-thread-row,.bridle-chat-model-row,.bridle-chat-reasoning button,.bridle-chat-send{appearance:none;border:0;font:inherit;cursor:pointer}
.bridle-chat-thread-trigger{display:flex;min-width:0;max-width:70%;align-items:center;gap:7px;padding:6px 7px;border-radius:8px;background:transparent;color:#202124;font-weight:650;text-align:left}
.bridle-chat-thread-trigger:hover,.bridle-chat-thread-trigger[aria-expanded="true"]{background:#f3f4f6}.bridle-chat-thread-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bridle-chat-new{display:flex;align-items:center;gap:4px;margin-left:auto;padding:6px 9px;border:1px solid #d7d9de;border-radius:8px;background:#fff;color:#30343b;font-size:12px;font-weight:650}.bridle-chat-new:hover{background:#f6f7f8}
.bridle-chat-popover{position:absolute;z-index:20;border:1px solid #d7d9de;border-radius:11px;background:#fff;box-shadow:0 10px 28px rgba(20,24,32,.14)}
.bridle-chat-threads{top:42px;left:12px;width:min(340px,calc(100% - 24px));padding:5px}
.bridle-chat-thread-row{display:flex;width:100%;align-items:center;gap:8px;padding:8px;border-radius:8px;background:transparent;color:#30343b;text-align:left}.bridle-chat-thread-row:hover,.bridle-chat-thread-row[data-active="true"]{background:#f3f4f6}
.bridle-chat-thread-copy{display:grid;min-width:0;flex:1}.bridle-chat-thread-copy strong{overflow:hidden;font-size:12.5px;text-overflow:ellipsis;white-space:nowrap}.bridle-chat-thread-copy small{color:#737983;font-size:10.5px}.bridle-chat-thread-new{border-top:1px solid #eceef1;border-radius:0 0 8px 8px;color:#2563eb;font-weight:650}
.bridle-chat-messages{min-height:0;flex:1;overflow:auto}.bridle-chat-usage{flex:0 0 auto}
.bridle-chat-pending{display:flex;justify-content:flex-end;padding:6px 2px}.bridle-chat-pending-you{max-width:80%;padding:8px 12px;border-radius:15px 15px 4px 15px;background:#eef2ff;color:#1e293b;font-size:13.5px;white-space:pre-wrap;word-break:break-word;opacity:.85}
.bridle-chat-thinking{display:flex;align-items:center;gap:7px;padding:6px 6px 10px;color:#737983;font-size:12.5px}.bridle-chat-thinking-dots{display:inline-flex;gap:3px}.bridle-chat-thinking-dot{width:5px;height:5px;border-radius:999px;background:#9aa3b2;animation:bridle-chat-bounce 1.2s infinite ease-in-out}.bridle-chat-thinking-dot:nth-child(2){animation-delay:.15s}.bridle-chat-thinking-dot:nth-child(3){animation-delay:.3s}
@keyframes bridle-chat-bounce{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){.bridle-chat-thinking-dot{animation:none;opacity:.6}}
.bridle-chat-composer-wrap{position:relative;flex:0 0 auto;padding:8px 12px 12px}.bridle-chat-error{margin:0 2px 7px;color:#b42318;font-size:12px}
.bridle-chat-composer{display:grid;gap:8px;padding:9px 10px 8px;border:1px solid #cfd3da;border-radius:17px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.06);transition:border-color .15s ease,box-shadow .15s ease}.bridle-chat-composer:focus-within{border-color:#9aa3b2;box-shadow:0 0 0 3px rgba(37,99,235,.09)}
.bridle-chat-composer textarea{box-sizing:border-box;width:100%;min-height:24px;max-height:150px;resize:none;overflow-y:hidden;border:0;outline:0;background:transparent;color:#202124;font:14px/1.45 system-ui,sans-serif}.bridle-chat-composer textarea::placeholder{color:#8a9099}
.bridle-chat-composer-bar{position:relative;display:flex;min-height:30px;align-items:center;gap:8px}
.bridle-chat-agent-mock{display:inline-flex;align-items:center;gap:5px;padding:5px 9px;border-radius:8px;font-size:11.5px;font-weight:700;color:#6b4fb8;
  background:repeating-linear-gradient(-45deg,#faf6ff,#faf6ff 7px,#f2ebff 7px,#f2ebff 14px);border:1px solid #e4d9fb}
.bridle-chat-agent-trigger{display:flex;min-width:0;align-items:center;gap:5px;padding:5px 7px;border-radius:8px;background:#f3f4f6;color:#343941;font-size:11.5px;font-weight:650}.bridle-chat-agent-trigger:hover,.bridle-chat-agent-trigger[aria-expanded="true"]{background:#e9ebef}.bridle-chat-live{width:6px;height:6px;border-radius:999px;background:#20a464;box-shadow:0 0 0 2px #dff4e9}.bridle-chat-agent-reasoning{color:#767d87;font-weight:500}
.bridle-chat-agent-popover{bottom:36px;left:0;width:min(330px,calc(100vw - 48px));padding:8px}.bridle-chat-popover-label{margin:2px 5px 5px;color:#737983;font-size:10px;font-weight:750;letter-spacing:.07em;text-transform:uppercase}
.bridle-chat-model-row{display:flex;width:100%;align-items:center;gap:8px;padding:7px 8px;border-radius:7px;background:transparent;color:#30343b;text-align:left}.bridle-chat-model-row:hover,.bridle-chat-model-row[data-active="true"]{background:#f3f4f6}.bridle-chat-model-row span{flex:1;font-size:12px;font-weight:620}
.bridle-chat-reasoning{display:grid;grid-template-columns:repeat(4,1fr);gap:2px;padding:2px;border:1px solid #e0e3e8;border-radius:8px;background:#f6f7f8}.bridle-chat-reasoning button{padding:5px 4px;border-radius:6px;background:transparent;color:#666d77;font-size:10.5px}.bridle-chat-reasoning button[aria-pressed="true"]{background:#fff;color:#202124;font-weight:700;box-shadow:0 1px 2px rgba(16,24,40,.1)}
.bridle-chat-send{display:grid;width:30px;height:30px;place-items:center;margin-left:auto;border-radius:999px;background:#2563eb;color:#fff;transition:background .15s ease,transform .15s ease}.bridle-chat-send:hover:not(:disabled){background:#1d4ed8}.bridle-chat-send:active:not(:disabled){transform:translateY(1px)}.bridle-chat-send:disabled{cursor:not-allowed;background:#e1e4e9;color:#9399a2}
.bridle-chat-kit button:focus-visible{outline:3px solid rgba(37,99,235,.24);outline-offset:2px}
`;

const iconProps = { size: 15, strokeWidth: 2 } as const;
const reasoningLevels: ChatKitReasoning[] = ["minimal", "low", "medium", "high"];
const label = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

export function ChatKit({
  threads,
  activeThreadId,
  onSelectThread,
  onNewThread,
  children,
  onSend,
  busy = false,
  error = null,
  agent,
  threadsMode = "dropdown",
  usageSlot,
}: ChatKitProps): ReactNode {
  const [draft, setDraft] = useState("");
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  // Optimistic echo: the just-sent message is shown immediately as a pending
  // bubble so the user sees their prompt without waiting for the round-trip.
  // It clears once the turn settles (busy → false), by which point the real
  // transcript row the consumer renders has arrived.
  const [pending, setPending] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!busy) setPending(null); }, [busy]);
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;
  const activeModel = agent.models.find((model) => model.id === agent.model);
  const canSend = draft.trim().length > 0 && !busy;

  const resize = (textarea: HTMLTextAreaElement): void => {
    textarea.style.height = "auto";
    const height = Math.min(textarea.scrollHeight, 150);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > 150 ? "auto" : "hidden";
  };

  const changeDraft = (event: FormEvent<HTMLTextAreaElement>): void => {
    setDraft(event.currentTarget.value);
    resize(event.currentTarget);
  };

  const send = (): void => {
    if (!canSend) return;
    const text = draft.trim();
    onSend(text);
    setPending(text);
    setDraft("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.overflowY = "hidden";
    }
  };

  const composerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter") return;
    // Enter sends; Shift+Enter inserts a newline. Ignore Enter while an IME is
    // mid-composition so committing a candidate never fires a send.
    if (event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const closeMenus = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    setThreadsOpen(false);
    setAgentOpen(false);
  };

  return h("section", { className: "bridle-chat-kit", "aria-label": "Agent chat", onKeyDown: closeMenus },
    h("header", { className: "bridle-chat-header" },
      h("button", {
        type: "button",
        className: "bridle-chat-thread-trigger",
        "aria-expanded": threadsOpen,
        "aria-haspopup": "menu",
        onClick: () => { setThreadsOpen((open) => !open); setAgentOpen(false); },
      },
      h(MessageSquare, iconProps),
      h("span", { className: "bridle-chat-thread-title" }, activeThread?.title ?? "New chat"),
      h(ChevronDown, iconProps)),
      threadsMode === "dropdown" && threadsOpen
        ? h("div", { className: "bridle-chat-popover bridle-chat-threads", role: "menu", "aria-label": "Threads" },
          ...threads.map((thread) => h("button", {
            type: "button",
            role: "menuitem",
            className: "bridle-chat-thread-row",
            "data-active": thread.id === activeThreadId,
            key: thread.id,
            onClick: () => { onSelectThread(thread.id); setThreadsOpen(false); },
          },
          thread.id === activeThreadId ? h(MessageSquare, iconProps) : h("span", { style: { width: 15 } }),
          h("span", { className: "bridle-chat-thread-copy" },
            h("strong", null, thread.title),
            h("small", null, `${thread.turnCount} ${thread.turnCount === 1 ? "turn" : "turns"}`)))),
          h("button", {
            type: "button",
            role: "menuitem",
            className: "bridle-chat-thread-row bridle-chat-thread-new",
            onClick: () => { onNewThread(); setThreadsOpen(false); },
          }, h(Plus, iconProps), h("span", { className: "bridle-chat-thread-copy" }, h("strong", null, "New thread"))))
        : null,
      h("button", { type: "button", className: "bridle-chat-new", onClick: onNewThread }, h(Plus, iconProps), "New")),
    h("div", { className: "bridle-chat-messages" },
      children,
      pending ? h("div", { className: "bridle-chat-pending" },
        h("div", { className: "bridle-chat-pending-you" }, pending)) : null,
      busy ? h("div", { className: "bridle-chat-thinking", role: "status", "aria-live": "polite" },
        h("span", { className: "bridle-chat-thinking-dots", "aria-hidden": true },
          h("span", { className: "bridle-chat-thinking-dot" }),
          h("span", { className: "bridle-chat-thinking-dot" }),
          h("span", { className: "bridle-chat-thinking-dot" })),
        h("span", null, "Working…")) : null),
    usageSlot ? h("div", { className: "bridle-chat-usage" }, usageSlot) : null,
    h("div", { className: "bridle-chat-composer-wrap" },
      error ? h("p", { className: "bridle-chat-error", role: "alert" }, error) : null,
      h("div", { className: "bridle-chat-composer" },
        h("textarea", {
          ref: textareaRef,
          value: draft,
          rows: 1,
          "aria-label": "Message the agent",
          placeholder: "Message the agent…",
          onInput: changeDraft,
          onKeyDown: composerKeyDown,
        }),
        h("div", { className: "bridle-chat-composer-bar" },
          // Deterministic run: a scripted preset produced the output, so the
          // composer must read "Mock" — never a live model name or reasoning level.
          agent.mock
            ? h("span", { className: "bridle-chat-agent-mock", title: "Deterministic run — a scripted preset, not a live model" },
                h(FlaskConical, { size: 13 }), "Mock",
                h("span", { className: "bridle-chat-agent-reasoning" }, "· scripted"))
            : h("button", {
                type: "button",
                className: "bridle-chat-agent-trigger",
                "aria-expanded": agentOpen,
                "aria-haspopup": "dialog",
                onClick: () => { setAgentOpen((open) => !open); setThreadsOpen(false); },
              },
              agent.live ? h("span", { className: "bridle-chat-live", "aria-label": "Live" }) : null,
              activeModel?.label ?? agent.model,
              h("span", { className: "bridle-chat-agent-reasoning" }, `· ${label(agent.reasoning)}`),
              h(ChevronDown, { size: 13, strokeWidth: 2 })),
          !agent.mock && agentOpen ? h("div", { className: "bridle-chat-popover bridle-chat-agent-popover", role: "dialog", "aria-label": "Agent model and reasoning" },
            h("p", { className: "bridle-chat-popover-label" }, agent.providerLabel ?? "Model"),
            ...agent.models.map((model) => h("button", {
              type: "button",
              className: "bridle-chat-model-row",
              "data-active": model.id === agent.model,
              key: model.id,
              onClick: () => agent.onModel(model.id),
            }, h("span", null, model.label), model.id === agent.model ? h(Check, iconProps) : null)),
            h("p", { className: "bridle-chat-popover-label" }, "Reasoning"),
            h("div", { className: "bridle-chat-reasoning", role: "group", "aria-label": "Reasoning level" },
              ...reasoningLevels.map((level) => h("button", {
                type: "button",
                "aria-pressed": level === agent.reasoning,
                key: level,
                onClick: () => agent.onReasoning(level),
              }, label(level))))) : null,
          h("button", {
            type: "button",
            className: "bridle-chat-send",
            "aria-label": "Send message",
            title: "Send (↵ · Shift+↵ for newline)",
            disabled: !canSend,
            onClick: send,
          }, h(ArrowUp, { size: 17, strokeWidth: 2.3 }))))));
}
