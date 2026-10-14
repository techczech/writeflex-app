import { AdapterRegistry, createModelAccess, TaskRegistry } from "@bridle/model-access";
import type { Adapter, ManifestGrants, ModelAccess, RoutingConfig } from "@bridle/model-access";
import { registerCognitionTasks } from "./tasks.ts";

export interface CognitionOptions {
  adapters: Adapter[];
  config?: RoutingConfig;
  grants?: ManifestGrants;
}

export function createCognition(opts: CognitionOptions): ModelAccess {
  const tasks = new TaskRegistry();
  registerCognitionTasks(tasks);

  const adapters = new AdapterRegistry();
  for (const adapter of opts.adapters) adapters.register(adapter);

  return createModelAccess({
    tasks,
    adapters,
    config: opts.config,
    grants: opts.grants,
  });
}
