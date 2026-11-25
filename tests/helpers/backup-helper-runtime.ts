import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { GIT_CANDIDATES } from '../../src/main/backup-helper/enrolment'
import { isAppleToolStub } from '../../src/main/apple-tool-stub'

export const helperEntry = resolve(import.meta.dir, '../../out/backup-helper/writeflex-backup-helper.js')

export function findBackupGit(): string | undefined {
  return [...GIT_CANDIDATES, Bun.which('git')].find((path): path is string => {
    if (!path) return false
    try {
      accessSync(path, constants.X_OK)
      return !isAppleToolStub(realpathSync(path))
    } catch {
      return false
    }
  })
}

/** Give the built helper a private install layout for the credential bridge's real path checks. */
export function stageHelperRuntime(fixture: string, node: string) {
  const runtime = join(fixture, 'runtime')
  const bin = join(runtime, 'bin')
  const actual = realpathSync(node)
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  const executable = join(bin, 'node')
  copyFileSync(actual, executable, constants.COPYFILE_FICLONE)
  chmodSync(executable, 0o700)

  // Homebrew Node may link its own library relative to the executable.
  const sourceLib = resolve(dirname(actual), '../lib')
  const nodeLibraries = existsSync(sourceLib) ? readdirSync(sourceLib).filter(name => /^libnode\.[\d.]+\.dylib$/.test(name)) : []
  if (nodeLibraries.length) {
    const lib = join(runtime, 'lib')
    mkdirSync(lib, { mode: 0o700 })
    for (const name of nodeLibraries) copyFileSync(join(sourceLib, name), join(lib, name), constants.COPYFILE_FICLONE)
  }
  const entry = join(runtime, 'writeflex-backup-helper.mjs')
  copyFileSync(helperEntry, entry)
  chmodSync(entry, 0o600)
  return { executable, entry }
}
