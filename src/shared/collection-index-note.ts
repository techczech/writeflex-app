/** The canonical Index Note for a non-root folder listed by the workspace (a relative POSIX path). */
export function collectionIndexNotePath(folder: string): string {
  const name = folder.slice(folder.lastIndexOf('/') + 1)
  return `${folder}/_${name}_INDEX.md`
}
