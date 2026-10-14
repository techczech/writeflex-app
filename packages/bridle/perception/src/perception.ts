import { AdapterRegistry, createModelAccess, TaskRegistry } from "@bridle/model-access";
import type { Adapter, ManifestGrants, ModelAccess, RoutingConfig } from "@bridle/model-access";
import { registerPerceptionTasks } from "./tasks.ts";

export interface PerceptionOptions {
  adapters: Adapter[];
  config?: RoutingConfig;
  grants?: ManifestGrants;
}

export function createPerception(opts: PerceptionOptions): ModelAccess {
  const tasks = new TaskRegistry();
  registerPerceptionTasks(tasks);

  const adapters = new AdapterRegistry();
  for (const adapter of opts.adapters) adapters.register(adapter);

  return createModelAccess({
    tasks,
    adapters,
    config: opts.config,
    grants: opts.grants,
  });
}
