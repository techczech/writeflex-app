import { createHash } from "node:crypto";

function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Execution inputs must contain only finite JSON numbers.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`Execution inputs must be JSON-safe; found ${typeof value}.`);
  if (ancestors.has(value)) throw new TypeError("Execution inputs must be JSON-safe; cyclic values are not supported.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, ancestors)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Execution inputs must contain only JSON objects and arrays.");
    }
    const entries = Object.keys(value as Record<string, unknown>).sort().map((key) => {
      const nested = (value as Record<string, unknown>)[key];
      if (nested === undefined) throw new TypeError("Execution inputs must not contain undefined values.");
      return `${JSON.stringify(key)}:${canonical(nested, ancestors)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function fingerprintRequest(capability: string, input: unknown): string {
  return createHash("sha256").update(canonical({ capability, input }, new Set())).digest("hex");
}
