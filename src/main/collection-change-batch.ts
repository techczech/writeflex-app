/** Per-window notification batches. Files still write individually; their refresh is sent once. */
export class CollectionChangeBatches<Key extends object> {
  private readonly active = new WeakMap<Key, { paths: Set<string>; dispose: () => void }>()

  begin(key: Key, dispose: () => void = () => {}): void {
    if (this.active.has(key)) throw new Error('Another collection change is still running.')
    this.active.set(key, { paths: new Set(), dispose })
  }

  collect(key: Key, paths: readonly string[]): boolean {
    const batch = this.active.get(key)
    if (!batch) return false
    for (const path of paths) batch.paths.add(path)
    return true
  }

  finish(key: Key): string[] | null {
    const batch = this.active.get(key)
    if (!batch) return null
    this.active.delete(key)
    batch.dispose()
    return [...batch.paths]
  }
}
