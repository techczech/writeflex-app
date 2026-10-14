/** Additive fields on Pi's persisted user message; content remains provider evidence. */
export type UserContextSplit = {
  userText: string;
  hiddenContext: string;
  visibleContext: string;
};

export type TranscriptOptions = { includeHidden?: boolean };

/** Legacy messages have no split: preserve their original content without guessing. */
export function projectUserContext<T extends { role?: unknown; content?: unknown }>(
  message: T,
  options: TranscriptOptions = {},
): T {
  const value = message as T & Partial<UserContextSplit>;
  if (value.role !== "user" || typeof value.userText !== "string") return message;
  const { userText, hiddenContext, visibleContext, ...rest } = value;
  return {
    ...rest,
    content: userText + (typeof visibleContext === "string" && visibleContext ? `\n\n${visibleContext}` : ""),
    ...(options.includeHidden && typeof hiddenContext === "string" && hiddenContext ? { hiddenContext } : {}),
  } as unknown as T;
}
