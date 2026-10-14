import { Type } from "typebox";
import type { Capability } from "../types.ts";
import type { RecorderQueries } from "./query.ts";

export const RECORDER_TOOL_DESCRIPTIONS = {
  turns: "Returns page N of recorded turn summaries. Follow nextPage when present and cite entryIds in answers.",
  contextAt: "Returns page N of the reconstructed model context and the envelope in force. Follow nextPage when present and cite entryIds in answers.",
  search: "Returns page N of case-insensitive substring matches over inline record payloads and blob previews. Follow nextPage when present and cite entryIds in answers.",
  egress: "Returns page N of recorded egress plus destination groups. Follow nextPage when present and cite entryIds in answers.",
  tree: "Returns page N of a session tree. Follow nextPage when present and cite entryIds in answers.",
} as const;

const Page = Type.Optional(Type.Integer({ minimum: 1, description: "One-based page number" }));
const Continuation = Type.Optional(Type.String({ description: "Opaque continuation token from the preceding response" }));
const Range = {
  from: Type.Optional(Type.Number({ description: "Inclusive Unix timestamp in milliseconds" })),
  to: Type.Optional(Type.Number({ description: "Inclusive Unix timestamp in milliseconds" })),
  page: Page,
  continuation: Continuation,
  groupContinuation: Continuation,
};

export function createRecorderCapabilities(recorder: RecorderQueries): Capability[] {
  return [
    {
      name: "recorder.turns", risk: "read", description: RECORDER_TOOL_DESCRIPTIONS.turns,
      parameters: Type.Object({ sessionId: Type.Optional(Type.String()), ...Range }),
      execute: async (input: { sessionId?: string; from?: number; to?: number; page?: number; continuation?: string; groupContinuation?: string }) => json(await recorder.turns(input)),
    },
    {
      name: "recorder.context_at", risk: "read", description: RECORDER_TOOL_DESCRIPTIONS.contextAt,
      parameters: Type.Object({ sessionId: Type.String(), entryId: Type.String(), page: Page, continuation: Continuation }),
      execute: async (input: { sessionId: string; entryId: string; page?: number; continuation?: string }) => json(await recorder.contextAt(input.sessionId, input.entryId, input.page, input.continuation)),
    },
    {
      name: "recorder.search", risk: "read", description: RECORDER_TOOL_DESCRIPTIONS.search,
      parameters: Type.Object({ query: Type.String({ minLength: 1 }), ...Range }),
      execute: async (input: { query: string; from?: number; to?: number; page?: number; continuation?: string; groupContinuation?: string }) => {
        const { query, ...filter } = input;
        return json(await recorder.searchRecord(query, filter));
      },
    },
    {
      name: "recorder.egress", risk: "read", description: RECORDER_TOOL_DESCRIPTIONS.egress,
      parameters: Type.Object(Range),
      execute: async (input: { from?: number; to?: number; page?: number; continuation?: string; groupContinuation?: string }) => json(await recorder.egress(input)),
    },
    {
      name: "recorder.tree", risk: "read", description: RECORDER_TOOL_DESCRIPTIONS.tree,
      parameters: Type.Object({ sessionId: Type.String(), page: Page, continuation: Continuation }),
      execute: async (input: { sessionId: string; page?: number; continuation?: string }) => json(await recorder.tree(input.sessionId, input.page, input.continuation)),
    },
  ];
}

function json(value: unknown): { text: string } {
  return { text: JSON.stringify(value) };
}
