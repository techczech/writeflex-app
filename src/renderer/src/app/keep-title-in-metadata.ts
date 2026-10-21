/**
 * Margin card ▸ More ▸ "No heading in the text" on a part-title proposal. The proposal is declined first, then
 * the part's heading choice (`heading: none`) is written by the Plan's guarded path. If the decline fails,
 * nothing is written, so a `# Title` proposal never stays pending on a `heading: none` part. If the write is
 * refused (the file changed), the proposal is reopened and the refusal is said plainly.
 */

export type KeepTitleSteps = {
  decline: (id: string) => Promise<boolean>
  writeHeadingNone: (path: string) => Promise<unknown>
  reopen: (id: string, message: string) => Promise<void>
  /** The plain refusal message for a failed write. */
  refusal: (error: unknown) => string
}

export async function keepTitleInMetadataOnlySteps(change: { id: string; path: string }, steps: KeepTitleSteps): Promise<'kept' | 'not-declined' | 'refused'> {
  if (!await steps.decline(change.id)) return 'not-declined'
  try {
    await steps.writeHeadingNone(change.path)
  } catch (error) {
    await steps.reopen(change.id, steps.refusal(error))
    return 'refused'
  }
  return 'kept'
}

/** Shown when a proposal could not be closed (declined) and nothing was changed. */
export const CLOSE_REFUSED_MESSAGE = 'WriteFlex could not close that proposal, so nothing was changed.'
