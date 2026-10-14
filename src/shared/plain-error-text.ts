/**
 * Error text on its way to the screen: no absolute path. A path under the open workspace becomes
 * workspace-relative; any other absolute path becomes "a file". Node's file errors quote the path, so
 * quoted paths (which may hold spaces) are handled first, then bare ones.
 */
export function withoutAbsolutePaths(message: string, workspaceRoot?: string): string {
  let text = message
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/[\\/]+$/, '')
    if (root) {
      text = text.split(`${root}/`).join('').split(`${root}\\`).join('').split(root).join('the workspace folder')
    }
  }
  return text
    .replace(/(['"])(?:\/|[A-Za-z]:\\)[^'"]*\1/g, 'a file')
    .replace(/(^|[\s(=:,])(?:\/(?:[^\s/'"(),;:]+\/)+[^\s'"(),;:]*|[A-Za-z]:\\[^\s'"(),;]+)/g, '$1a file')
}
