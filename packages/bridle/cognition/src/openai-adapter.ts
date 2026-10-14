import type { Adapter, EgressClass, RunContext, TransportClass } from "@bridle/model-access";

const CHAT_TASKS = ["summarise", "translate", "classify", "extract"] as const;
type ChatTaskId = (typeof CHAT_TASKS)[number];

export interface OpenAiAdapterOptions {
  id: string;
  baseURL: string;
  model: string;
  apiKey?: string;
  tasks?: string[];
  fetchImpl?: typeof fetch;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export function makeOpenAiCompatibleAdapter(opts: OpenAiAdapterOptions): Adapter {
  const egress = egressForBaseUrl(opts.baseURL);
  const transport: TransportClass = egress === "loopback" ? "local-server" : "cloud";
  const tasks = normaliseTasks(opts.tasks);
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return {
    id: opts.id,
    transport,
    egress,
    tasks,
    async execute(taskId: string, input: unknown, ctx: RunContext) {
      if (!isChatTask(taskId)) throw new Error(`OpenAI-compatible adapter does not serve task: ${taskId}`);

      const response = await requestCompletion({
        baseURL: opts.baseURL,
        model: opts.model,
        apiKey: opts.apiKey,
        taskId,
        input,
        signal: ctx.signal,
        fetchImpl,
      });
      return parseCompletion(taskId, response, input);
    },
  };
}

export function egressForBaseUrl(baseURL: string): EgressClass {
  const url = new URL(baseURL);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1" ? "loopback" : "remote";
}

export function buildMessages(taskId: string, input: unknown): ChatMessage[] {
  if (taskId === "summarise") {
    const data = input as { text: string; maxWords?: number };
    const limit = data.maxWords === undefined ? "" : ` in no more than ${data.maxWords} words`;
    return [
      { role: "system", content: `Summarise faithfully${limit}.` },
      { role: "user", content: data.text },
    ];
  }
  if (taskId === "translate") {
    const data = input as { text: string; targetLanguage: string };
    return [
      { role: "system", content: `Translate into ${data.targetLanguage}, output only the translation.` },
      { role: "user", content: data.text },
    ];
  }
  if (taskId === "classify") {
    const data = input as { text: string; labels: string[] };
    return [
      { role: "system", content: `Choose exactly one label from: ${data.labels.join(", ")}; reply with the label only.` },
      { role: "user", content: data.text },
    ];
  }
  if (taskId === "extract") {
    const data = input as { text: string; instructions: string };
    return [
      { role: "system", content: `${data.instructions}. Reply with JSON only.` },
      { role: "user", content: data.text },
    ];
  }
  throw new Error(`OpenAI-compatible adapter does not serve task: ${taskId}`);
}

export function parseCompletion(taskId: string, content: string, input: unknown): unknown {
  const trimmed = content.trim();
  if (taskId === "summarise") return { summary: trimmed };
  if (taskId === "translate") return { text: trimmed };
  if (taskId === "classify") {
    const data = input as { labels: string[] };
    if (!data.labels.includes(trimmed)) {
      throw new Error(`Classify completion returned label outside allowed labels: ${trimmed}`);
    }
    return { label: trimmed };
  }
  if (taskId === "extract") {
    try {
      return { data: JSON.parse(trimmed) };
    } catch (error) {
      throw new Error(`Extract completion returned invalid JSON: ${errorMessage(error)}`);
    }
  }
  throw new Error(`OpenAI-compatible adapter does not serve task: ${taskId}`);
}

function normaliseTasks(tasks: string[] | undefined): string[] {
  const selected = tasks ?? [...CHAT_TASKS];
  for (const task of selected) {
    if (!isChatTask(task)) throw new Error(`OpenAI-compatible adapter does not serve task: ${task}`);
  }
  return selected;
}

function isChatTask(taskId: string): taskId is ChatTaskId {
  return CHAT_TASKS.some((task) => task === taskId);
}

async function requestCompletion(opts: {
  baseURL: string;
  model: string;
  apiKey?: string;
  taskId: ChatTaskId;
  input: unknown;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: buildMessages(opts.taskId, opts.input),
    temperature: 0,
  };
  if (opts.taskId === "extract") body.response_format = { type: "json_object" };

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  let response: Response;
  try {
    response = await opts.fetchImpl(chatCompletionsUrl(opts.baseURL), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (error) {
    throw new Error(`OpenAI-compatible chat request failed: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`OpenAI-compatible chat request failed with status ${response.status}: ${truncate(bodyText)}`);
  }

  return completionContent(await response.json());
}

function chatCompletionsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/u, "")}/chat/completions`;
}

function completionContent(value: unknown): string {
  if (
    typeof value === "object"
    && value !== null
    && "choices" in value
    && Array.isArray(value.choices)
  ) {
    const first = value.choices[0] as unknown;
    if (
      typeof first === "object"
      && first !== null
      && "message" in first
      && typeof first.message === "object"
      && first.message !== null
      && "content" in first.message
      && typeof first.message.content === "string"
    ) {
      return first.message.content;
    }
  }
  throw new Error("OpenAI-compatible chat response did not include choices[0].message.content.");
}

function truncate(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
