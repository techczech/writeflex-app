/** Name restrictions shared by the Files sidebar and the writers in main. */
export function fileNameProblem(name: string): string | null {
  if (/[:*?"<>|]/.test(name)) return 'A name cannot contain : * ? " < > | — OneDrive and Windows cannot store them.'
  if (name.endsWith(' ') || name.endsWith('.')) return 'A name cannot end with a space or a full stop.'
  return null
}
