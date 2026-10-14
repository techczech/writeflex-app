type DiscardResult = { settlementWarning?: string }

export async function reviseSuggestionWithWarning(input: {
  suggestionId: string
  note: string
  discard: (id: string) => Promise<DiscardResult>
  prompt: (text: string) => void
  flash: (text: string) => void
}): Promise<void> {
  let warning: string | undefined
  try {
    warning = (await input.discard(input.suggestionId)).settlementWarning
  } catch {
    // The suggestion may already have settled elsewhere; the writer's revision note still goes.
  }
  input.prompt(`Revise your suggestion: ${input.note}`)
  input.flash(warning
    ? `Change rejected, but its Agent note failed: ${warning}`
    : 'Sent back to the agent with your note')
}
