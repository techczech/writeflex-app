// Barrel exports for @bridle/model-access.
export const MODEL_ACCESS_PACKAGE = "@bridle/model-access";
export * from "./types.ts";
export { TaskRegistry, AdapterRegistry } from "./registry.ts";
export { isEgressGranted } from "./egress.ts";
export { route, type RouteOutcome } from "./routing.ts";
export {
  createModelAccess,
  type LedgerEntry,
  type LedgerMediaReference,
  type LedgerRecorder,
  type ModelAccess,
  type ModelAccessOptions,
} from "./engine.ts";
export { makePassthroughAdapter, type PassthroughAdapterOptions } from "./passthrough.ts";
