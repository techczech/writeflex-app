/** Project a public bridge value to the same plain-data form Electron structured cloning delivers. */
export function toRendererValue<T>(value: T): T {
  return structuredClone(value);
}
