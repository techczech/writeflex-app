import { Type } from "typebox";
import type { Task } from "@bridle/model-access";
import { TaskRegistry } from "@bridle/model-access";

export const TRANSCRIBE_TASK: Task = {
  id: "transcribe",
  version: "1",
  input: Type.Object({
    audioPath: Type.String(),
    outputPath: Type.String(),
    format: Type.Optional(Type.Union([Type.Literal("txt"), Type.Literal("srt"), Type.Literal("json")])),
    language: Type.Optional(Type.String()),
  }),
  output: Type.Object({
    transcriptPath: Type.String(),
    format: Type.Union([Type.Literal("txt"), Type.Literal("srt"), Type.Literal("json")]),
  }),
};

export const PERCEPTION_TASKS: readonly Task[] = [TRANSCRIBE_TASK];

export function registerPerceptionTasks(registry: TaskRegistry): void {
  for (const task of PERCEPTION_TASKS) registry.define(task);
}
