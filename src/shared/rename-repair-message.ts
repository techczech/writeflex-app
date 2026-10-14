/** Every issue kind a rename repair can report. The preload boundary validates against this same list,
 *  so a kind added here can never be refused at the bridge after the file has already moved. */
export const RENAME_REPAIR_ISSUE_KINDS = ['reference', 'file', 'reason', 'outcome', 'preserved', 'available'] as const

export type RenameRepairDisplayIssue = {
  kind: typeof RENAME_REPAIR_ISSUE_KINDS[number]
  text: string
}

export type RenameRepairDisplay = {
  writtenPaths: string[]
  issues: RenameRepairDisplayIssue[]
}

/** Format the complete user-facing account for a rename-repair result. */
export function formatRenameRepairMessage(success: string, repair: RenameRepairDisplay): string {
  if (!repair.issues.length) return success
  const references = repair.issues.filter((issue) => issue.kind === 'reference')
  const referenceCounts = new Map<string, number>()
  for (const { text } of references) referenceCounts.set(text, (referenceCounts.get(text) ?? 0) + 1)
  const namedReferences = [...referenceCounts].map(([text, count]) => count > 1 ? `${text} (×${count})` : text)
  const files = repair.issues.filter((issue) => issue.kind === 'file').map((issue) => issue.text)
  const reasons = repair.issues.filter((issue) => issue.kind === 'reason').map((issue) => issue.text)
  const outcomes = repair.issues.filter((issue) => issue.kind === 'outcome').map((issue) => issue.text)
  const preserved = repair.issues.filter((issue) => issue.kind === 'preserved').map((issue) => issue.text)
  const available = repair.issues.filter((issue) => issue.kind === 'available').map((issue) => issue.text)
  const appliedAndUnreverted = repair.writtenPaths.length > 0 && files.length > 0
    && reasons.some((reason) => reason.includes('Rollback also failed'))
  const repairDetails = [...files, ...reasons]
  const warning = references.length || repairDetails.length
    ? `Warning: the rename succeeded, but WriteFlex could not repair ${references.length} ${references.length === 1 ? 'reference' : 'references'}`
      + `${references.length ? `: ${namedReferences.join('; ')}` : ''}.`
      + `${repairDetails.length ? ` Repair details: ${repairDetails.join('; ')}` : ''}`
      + `${appliedAndUnreverted
        ? ` ${repair.writtenPaths.length === 1 ? `The repair to ${repair.writtenPaths[0]} was` : `Repairs to ${repair.writtenPaths.join('; ')} were`} applied and could not be undone, so the workspace is part-way through an abandoned change. ${files.length === 1 ? `The stale file is ${files[0]}.` : `The stale files are ${files.join('; ')}.`}`
        : ''}`
    : ''
  const outcomeNotice = outcomes.length
    ? `Completed repair ${outcomes.length === 1 ? 'action' : 'actions'}: ${outcomes.join('; ')}`
    : ''
  const preservedNotice = preserved.length
    ? `Preserved plan ${preserved.length === 1 ? 'line' : 'lines'}: ${preserved.join('; ')}`
    : ''
  const availableNotice = available.length
    ? `Available ${available.length === 1 ? 'action' : 'actions'}: ${available.join('; ')}`
    : ''
  const repairMessage = [warning, outcomeNotice, preservedNotice, availableNotice].filter(Boolean).join(' ')
  return success ? `${success}. ${repairMessage}` : repairMessage
}
