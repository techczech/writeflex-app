import { Type } from "typebox";
import type { Task } from "@bridle/model-access";
import { TaskRegistry } from "@bridle/model-access";

export const SUMMARISE_TASK: Task = {
  id: "summarise",
  version: "1",
  input: Type.Object({ text: Type.String(), maxWords: Type.Optional(Type.Integer({ minimum: 1 })) }),
  output: Type.Object({ summary: Type.String() }),
};

export const TRANSLATE_TASK: Task = {
  id: "translate",
  version: "1",
  input: Type.Object({ text: Type.String(), targetLanguage: Type.String() }),
  output: Type.Object({ text: Type.String() }),
};

export const CLASSIFY_TASK: Task = {
  id: "classify",
  version: "1",
  input: Type.Object({ text: Type.String(), labels: Type.Array(Type.String(), { minItems: 1 }) }),
  output: Type.Object({ label: Type.String(), confidence: Type.Optional(Type.Number()) }),
};

export const EXTRACT_TASK: Task = {
  id: "extract",
  version: "1",
  input: Type.Object({ text: Type.String(), instructions: Type.String() }),
  output: Type.Object({ data: Type.Unknown() }),
};

export const EMBED_TEXT_TASK: Task = {
  id: "embed-text",
  version: "1",
  input: Type.Object({ text: Type.String() }),
  output: Type.Object({ embedding: Type.Array(Type.Number()) }),
};

export const COGNITION_TASKS: readonly Task[] = [
  SUMMARISE_TASK,
  TRANSLATE_TASK,
  CLASSIFY_TASK,
  EXTRACT_TASK,
  EMBED_TEXT_TASK,
];

export function registerCognitionTasks(registry: TaskRegistry): void {
  for (const task of COGNITION_TASKS) registry.define(task);
}
