/**
 * Git without Apple's install dialog. On a Mac without the Command Line Tools (or Xcode) `/usr/bin/git` is a stub:
 * running it, even `git --version`, opens the system dialog offering to install them. `xcode-select -p` names the
 * active developer folder without that dialog. WriteFlex then runs the real Git inside that folder, not the stub,
 * and checks the file is still there before every launch: if the tools are removed while the app runs, the launch
 * fails quietly and no dialog can open. The folder is asked once per session.
 * Electron-free.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { runBounded } from './bounded-child'
import { isAppleToolStub } from './apple-tool-stub'

/** @internal Test seams: another `xcode-select`, another platform. */
export const developerToolsSeams: { command: string; platform: NodeJS.Platform } = { command: '/usr/bin/xcode-select', platform: process.platform }

export { isAppleToolStub }

let folder: Promise<string | null> | null = null

async function ask(): Promise<string | null> {
  const run = await runBounded(developerToolsSeams.command, ['-p'], { timeoutMs: 5000 })
  if (run.kind !== 'exited' || run.code !== 0) return null
  const answer = run.stdout.trim()
  return answer.startsWith('/') ? answer : null
}

function executable(path: string): boolean {
  try { const st = statSync(path); return st.isFile() && (st.mode & 0o111) !== 0 } catch { return false }
}

/**
 * The Git to run, by its concrete path inside the active developer folder, or null when there is none. Checked on
 * disk at every call. Other systems have no stub and keep the fixed path.
 */
export async function systemGit(): Promise<string | null> {
  if (developerToolsSeams.platform !== 'darwin') return '/usr/bin/git'
  folder ??= ask().catch(() => null)
  const active = await folder
  if (!active) return null
  const git = join(active, 'usr', 'bin', 'git')
  if (executable(git) && !isAppleToolStub(git)) return git
  // The tools went away while the app ran: missing until the person checks again.
  folder = Promise.resolve(null)
  return null
}

export async function developerToolsPresent(): Promise<boolean> {
  return (await systemGit()) !== null
}

/** Forget the session's answer and ask again. */
export function recheckDeveloperTools(): Promise<boolean> {
  folder = null
  return developerToolsPresent()
}
