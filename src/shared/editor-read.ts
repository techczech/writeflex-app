/** Only a confirmed missing entry can authorise the removed-file choices. */
export type EditorReadResult =
  | { kind: 'read'; content: string }
  | { kind: 'missing' }
  | { kind: 'unavailable' }
  | { kind: 'stale' }
