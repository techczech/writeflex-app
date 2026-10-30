import { Type, type TSchema } from "typebox";
import { assertWireNamesUnique, isToolRisk } from "./manifest.ts";
import type { Capability, CapabilityResult, CapabilityContext, ToolRisk } from "./types.ts";

/** Apps map their registry onto this shape. Risk must be explicit on the command
 * or in defaultRisk. Write/destructive commands must supply touchedPaths; the
 * manifest independently enforces that snapshot contract. Parameters must have
 * one object root (TypeBox or plain JSON schema), without root unions. */
export type CommandDefinition<TInput = any> = Pick<Capability<TInput>,
  "asks" | "touchedPaths" | "renderUndo" | "preview" | "renderChange" | "renderOps" | "proposalKind" | "egress"
> & {
  id: string;
  title: string;
  description?: string;
  parameters?: TSchema | Record<string, unknown>;
  risk?: ToolRisk;
  run(input: TInput, ctx: CapabilityContext): unknown | Promise<unknown>;
};

export type GeneratedToolsOptions = {
  withhold?: (command: CommandDefinition) => boolean;
  /** Explicit classification for commands without their own risk. No implicit default. */
  defaultRisk?: ToolRisk;
};

export function generateCapabilities(commands: readonly CommandDefinition[], options: GeneratedToolsOptions = {}): Capability[] {
  const selected = commands.filter((command) => !options.withhold?.(command));
  const unclassified = selected.filter((command) => command.risk === undefined && options.defaultRisk === undefined);
  if (unclassified.length) throw new Error(`Command risk is required (or supply defaultRisk): ${unclassified.map((command) => command.id).join(", ")}.`);
  if (options.defaultRisk !== undefined && !isToolRisk(options.defaultRisk)) {
    throw new Error(`Invalid defaultRisk for commands: ${selected.map((command) => command.id).join(", ")}. Use read, write, sync or destructive.`);
  }
  const seen = new Set<string>();
  const capabilities = selected.map((command): Capability => {
    const name = command.id.toLowerCase();
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(name)) {
      throw new Error(`Invalid command id "${command.id}": use dotted identifiers starting with a letter.`);
    }
    if (seen.has(name)) throw new Error(`Duplicate generated capability name "${name}" from command id "${command.id}".`);
    seen.add(name);
    if (command.risk !== undefined && !isToolRisk(command.risk)) throw new Error(`Command "${command.id}" has invalid risk; expected read, write, sync or destructive.`);
    const risk = (command.risk ?? options.defaultRisk)!;
    if ((risk === "write" || risk === "destructive") && typeof command.touchedPaths !== "function") {
      throw new Error(`Command "${command.id}" requires touchedPaths for ${risk} execution.`);
    }
    const parameters = command.parameters === undefined ? Type.Object({}) : command.parameters;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)
      || !("type" in parameters) || parameters.type !== "object" || "anyOf" in parameters || "oneOf" in parameters) {
      throw new Error(`Command "${command.id}" parameters must have one object schema root without anyOf/oneOf.`);
    }
    return {
      name, label: command.title, description: command.description ?? command.title,
      parameters: parameters as TSchema,
      risk,
      asks: command.asks, touchedPaths: command.touchedPaths, renderUndo: command.renderUndo,
      preview: command.preview, renderChange: command.renderChange, renderOps: command.renderOps,
      proposalKind: command.proposalKind, egress: command.egress,
      execute: async (input, ctx) => {
        const result = await command.run(input, ctx);
        if (result && typeof result === "object" && "text" in result && typeof result.text === "string") {
          return result as CapabilityResult;
        }
        return { text: typeof result === "string" ? result : JSON.stringify(result) ?? "Done.", details: result };
      },
    };
  });
  assertWireNamesUnique(capabilities.map((capability) => capability.name));
  return capabilities;
}
