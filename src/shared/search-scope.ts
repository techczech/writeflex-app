const EXCLUDED_TOP_LEVEL_DIRECTORIES = new Set(['cache', 'indexes'])

/** Whether a workspace-relative POSIX path belongs in content and by-name search surfaces. */
export function isPathInSearchScope(path: string): boolean {
  const topLevel = path.split('/', 1)[0]
  return !EXCLUDED_TOP_LEVEL_DIRECTORIES.has(topLevel)
}
