export type CompleteJsonl = Readonly<{ bytes: Buffer; repaired: boolean }>;

/**
 * Returns the complete JSONL prefix shared by safety-journal open, refresh,
 * and cold Recorder reads. A complete header is mandatory; only an
 * unterminated tail after that header is discardable.
 */
export function completeExecutionJournalJsonl(bytes: Buffer): CompleteJsonl {
  const firstNewline = bytes.indexOf(0x0a);
  if (firstNewline < 0) throw new Error("Execution journal header is torn or missing.");
  if (bytes.at(-1) === 0x0a) return { bytes, repaired: false };
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < firstNewline) throw new Error("Execution journal header is torn.");
  return { bytes: bytes.subarray(0, lastNewline + 1), repaired: true };
}
