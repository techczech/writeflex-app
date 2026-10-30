import { Type } from "typebox";
import type { Capability } from "./types.ts";

export type ToolSearchOptions = {
  threshold?: number;
  /** Canonical names added to the general content tools in the starting set. */
  startingTools?: readonly string[];
};

/** A per-session catalogue. Enabling changes availability, never policy or skill scope. */
export function createToolDiscovery(capabilities: readonly Capability[], options: ToolSearchOptions = {}) {
  const threshold = options.threshold ?? 24;
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error("Tool search threshold must be a positive integer.");
  const byName = new Map(capabilities.map((capability) => [capability.name, capability]));
  const starting = [...capabilities.filter((capability) => capability.name.startsWith("content.")).map((capability) => capability.name),
    ...(options.startingTools ?? [])];
  for (const name of starting) if (!byName.has(name)) throw new Error(`Unknown starting tool: ${name}`);
  const active = new Set<string>();
  let changed: (() => void) | undefined;
  const discovery = capabilities.length > threshold;
  const reset = () => {
    active.clear();
    for (const name of discovery ? starting : byName.keys()) active.add(name);
    if (discovery) { active.add("tools.search"); active.add("tools.enable"); }
    changed?.();
  };
  const tools: Capability[] = discovery ? [
    {
      name: "tools.search", description: "Search available tools by name or description; then use tools_enable with their canonical names.",
      risk: "read", parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      execute: async ({ query, limit = 20 }: { query: string; limit?: number }) => {
        if (typeof query !== "string" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid tool search query or limit.");
        const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
        const matches = capabilities.filter((capability) => words.every((word) =>
          `${capability.name} ${capability.description}`.toLowerCase().includes(word)))
          .slice(0, limit).map(({ name, description }) => ({ name, description }));
        return { text: JSON.stringify(matches), details: matches };
      },
    },
    {
      name: "tools.enable", description: "Enable discovered canonical tool names for the rest of this turn. Each call still follows its normal approval policy.",
      risk: "read", parameters: Type.Object({ names: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }) }),
      execute: async ({ names }: { names: string[] }, ctx) => {
        if (!Array.isArray(names) || names.length < 1 || names.length > 100) throw new Error("Provide between 1 and 100 tool names.");
        for (const name of names) if (!byName.has(name)) throw new Error(`Unknown tool: ${name}`);
        ctx.audit({ type: "tools.enabled", capability: "tools.enable", metadata: { names: [...names] } });
        for (const name of names) active.add(name);
        changed?.();
        return { text: `Enabled: ${names.join(", ")}`, details: { names } };
      },
    },
  ] : [];
  if (discovery && tools.some((tool) => byName.has(tool.name))) throw new Error("Tool search reserves tools.search and tools.enable.");
  const all = [...capabilities, ...tools];
  reset();
  return {
    enabled: discovery,
    capabilities: all,
    visible: () => all.filter((capability) => active.has(capability.name)),
    reset,
    onChange(callback: () => void) { changed = callback; },
  };
}

/** Internal Pi seam shared by live and scripted sessions. */
export function bindToolDiscovery(
  session: { setActiveToolsByName(names: string[]): void; prompt: (...args: any[]) => Promise<any> },
  discovery: ReturnType<typeof createToolDiscovery>,
  wire: (name: string) => string,
): void {
  const apply = () => session.setActiveToolsByName(discovery.visible().map((capability) => wire(capability.name)));
  discovery.onChange(apply);
  apply();
  const prompt = session.prompt.bind(session);
  session.prompt = async (...args) => {
    discovery.reset();
    return prompt(...args);
  };
}
