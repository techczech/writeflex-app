import type { Adapter, EgressClass, RunContext, TransportClass } from "./types.ts";

export interface PassthroughAdapterOptions {
  id: string;
  transport: TransportClass;
  egress: EgressClass;
  tasks: string[];
  handler: (taskId: string, input: unknown, ctx: RunContext) => unknown | Promise<unknown>;
  available?: boolean;
}

// A minimal in-memory Adapter for tests and local development. Not a real provider.
export function makePassthroughAdapter(opts: PassthroughAdapterOptions): Adapter {
  return {
    id: opts.id,
    transport: opts.transport,
    egress: opts.egress,
    tasks: opts.tasks,
    isAvailable: () => opts.available ?? true,
    execute: (taskId, input, ctx) => Promise.resolve(opts.handler(taskId, input, ctx)),
  };
}
