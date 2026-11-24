import { readFileSync, realpathSync } from 'node:fs'
import { isAppleToolStub } from '../main/apple-tool-stub'

/**
 * The Git the package would run for this command, checked first. Never Apple's `/usr/bin` stub (without the Command
 * Line Tools it opens the install dialog), also through a link, and never a lookup on PATH: a configuration without
 * `tools.git` (version 1) is refused. WriteFlex writes only version 2. An unreadable configuration or a missing tool is
 * left for the package to report.
 */
export function gitRefusal(argv: readonly string[]): string | null {
  const at = argv.findIndex(a => a === '--config' || a.startsWith('--config='))
  const file = at < 0 ? undefined : argv[at] === '--config' ? argv[at + 1] : argv[at]!.slice('--config='.length)
  if (!file) return null
  let config: { tools?: { git?: unknown } }
  try { config = JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  const git = config?.tools?.git
  if (typeof git !== 'string') return 'Backup needs a configuration that names its Git program.'
  let real: string
  try { real = realpathSync(git) } catch { return null }
  return isAppleToolStub(real) ? `Backup will not run ${git}: it is Apple's Command Line Tools stub. Install the Command Line Tools or Git, then try again.` : null
}
