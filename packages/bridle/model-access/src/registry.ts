import Schema from "typebox/schema";
import type { Adapter, Task } from "./types.ts";

interface CompiledTask {
  task: Task;
  checkInput: (value: unknown) => boolean;
  checkOutput: (value: unknown) => boolean;
}

export class TaskRegistry {
  private tasks = new Map<string, CompiledTask>();

  define(task: Task): void {
    if (this.tasks.has(task.id)) throw new Error(`Task already defined: ${task.id}`);
    const inputV = Schema.Compile(task.input);
    const outputV = Schema.Compile(task.output);
    this.tasks.set(task.id, {
      task,
      checkInput: (value) => inputV.Check(value),
      checkOutput: (value) => outputV.Check(value),
    });
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)?.task;
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  checkInput(id: string, value: unknown): boolean {
    const entry = this.tasks.get(id);
    if (!entry) throw new Error(`Unknown task: ${id}`);
    return entry.checkInput(value);
  }

  checkOutput(id: string, value: unknown): boolean {
    const entry = this.tasks.get(id);
    if (!entry) throw new Error(`Unknown task: ${id}`);
    return entry.checkOutput(value);
  }
}

export class AdapterRegistry {
  private adapters = new Map<string, Adapter>();

  register(adapter: Adapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): Adapter | undefined {
    return this.adapters.get(id);
  }

  forTask(taskId: string): Adapter[] {
    return [...this.adapters.values()].filter((a) => a.tasks.includes(taskId));
  }
}
