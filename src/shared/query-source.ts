export type ProjectionQuerySourceInput = {
  dir: string
  status: string
}

function serialiseFilterValue(value: string): string {
  return /[,\"]/.test(value) ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value
}

export function serialiseQueryValues(values: string[]): string {
  return values.map(serialiseFilterValue).join(', ')
}

/** Portable source for a Rail group or Board column. Query Objects evaluate from the Workspace root,
 * so a nested Collection contributes its folder line while the root deliberately does not. */
export function projectionQuerySource(input: ProjectionQuerySourceInput): string {
  const lines: string[] = []
  if (input.dir) lines.push(`folder: ${input.dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')}`)
  lines.push(`status: ${serialiseQueryValues([input.status])}`)
  return lines.join('\n')
}
