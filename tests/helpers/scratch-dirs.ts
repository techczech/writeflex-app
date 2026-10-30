import { afterAll } from 'bun:test'
import { rmSync } from 'node:fs'

/**
 * Register a scratch folder made with mkdtemp. Cached-helper consumers register cleanUpScratch
 * in their own file scope; test files run serially and do not share live fixtures across files.
 * Belt and braces next to the per-run TMPDIR root (tests/helpers/test-temp-root.ts), so a file run
 * outside the configured runner still leaves nothing behind.
 */
const made = new Set<string>()
export function trackScratch<T extends string>(path: T): T {
  made.add(path)
  return path
}
export function cleanUpScratch(): void {
  const start = performance.now()
  const count = made.size
  try {
    for (const path of made) rmSync(path, { recursive: true, force: true })
    made.clear()
  } finally { console.info(`[test-temp] tracked cleanup: ${count} paths, ${Math.round(performance.now() - start)} ms`) }
}

// Retain first-import cleanup for callers that also dispose their own fixtures explicitly.
afterAll(cleanUpScratch)
