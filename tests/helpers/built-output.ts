import { test, type TestOptions } from 'bun:test'
import { constants, accessSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')

export function missingBuild(relative: string): string | undefined {
  if (!existsSync(resolve(ROOT, relative))) return `run bun run build (${relative} is missing)`
}

export function findGitleaks(): string | undefined {
  return Bun.which('gitleaks') ?? ['/opt/homebrew/bin/gitleaks', '/usr/local/bin/gitleaks'].find((path) => {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  })
}

/** Name the missing prerequisite in the Bun console and JUnit reports. */
export function testRequiring(reason: string | undefined) {
  return (label: string, run: () => void | Promise<unknown>, options?: number | TestOptions) => {
    test.skipIf(reason !== undefined)(reason ? `${label} [requires: ${reason}]` : label, run, options)
  }
}

export const missingGitleaks = findGitleaks() ? undefined : 'gitleaks executable is missing'
export const testWithGitleaks = testRequiring(missingGitleaks)
