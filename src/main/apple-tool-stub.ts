/**
 * Apple's developer-tool stubs live in `/usr/bin` (git, xcrun and the rest). Without the Command Line Tools, running
 * one opens the system install dialog; a real Git never lives there on macOS. Pass a path with links resolved.
 * Dependency-free: the backup helper bundles it.
 */
export function isAppleToolStub(realPath: string): boolean {
  return realPath.startsWith('/usr/bin/')
}
