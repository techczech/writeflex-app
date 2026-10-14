import type { TSchema } from "typebox";
import type { PackRunEvent } from "@bridle/contract";

export type TransportClass = "pack" | "local-server" | "cloud";
export type EgressClass = "none" | "loopback" | "remote";

export interface Task {
  id: string;
  version: string;
  input: TSchema;
  output: TSchema;
}

export interface RunContext {
  signal?: AbortSignal;
  onEvent?: (event: PackRunEvent) => void;
}

export interface Adapter {
  id: string;
  transport: TransportClass;
  egress: EgressClass;
  tasks: string[];
  isAvailable?(): boolean | Promise<boolean>;
  execute(taskId: string, input: unknown, ctx: RunContext): Promise<unknown>;
}

export interface EgressGrant {
  taskId: string;
  adapterId: string;
}

export interface ManifestGrants {
  granted: EgressGrant[];
  autoGrantLoopback?: boolean;
}

export interface RoutingConfig {
  routes?: Record<string, string[]>;
}

export type ModelAccessErrorKind =
  | "unknown-task"
  | "input-invalid"
  | "output-invalid"
  | "no-adapter"
  | "egress-denied"
  | "adapter-error";

export interface ModelAccessError {
  kind: ModelAccessErrorKind;
  detail: string;
  remedy?: string;
}

export type ModelAccessResult =
  | { ok: true; taskId: string; adapterId: string; egress: EgressClass; output: unknown }
  | { ok: false; taskId: string; error: ModelAccessError };
