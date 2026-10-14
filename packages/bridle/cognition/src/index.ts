export const COGNITION_PACKAGE = "@bridle/cognition";
export * from "./tasks.ts";
export { makeOpenAiCompatibleAdapter, egressForBaseUrl, buildMessages, parseCompletion, type OpenAiAdapterOptions } from "./openai-adapter.ts";
export { createCognition, type CognitionOptions } from "./cognition.ts";
