import type { Capability } from "./types.ts";

/** Resolve the app's argument-level approval requirement; errors fail closed. */
export async function callAsks<TInput>(capability: Capability<TInput>, input: TInput): Promise<boolean> {
  if (typeof capability.asks === "function") return Boolean(await capability.asks(input));
  return Boolean(capability.asks);
}
