import { CliError, type OperationContext, type OperationResult, type ParsedArgs } from './operation'
import type { WriteAccess } from './write-access'

/** The write access of an operation declared `writes`; its absence is a wiring fault, never a user's. */
export function writeAccess(ctx: OperationContext): WriteAccess {
  if (!ctx.write) throw new CliError('This operation changes the Collection and was run without the owner lock.', 'failed')
  return ctx.write
}

/** Text given as `--<name> "..."` or piped in with `--stdin`; one of them, never both. */
export async function textArgument(ctx: OperationContext, args: ParsedArgs, name: string, required: boolean): Promise<string> {
  const given = args[name]
  if (given !== undefined && args.stdin === true) throw new CliError(`Give --${name} or --stdin, not both.`, 'usage')
  if (args.stdin === true) return ctx.stdin()
  if (given === undefined && required) throw new CliError(`Give the text with --${name} "..." or pipe it in with --stdin.`, 'usage')
  return given === undefined ? '' : String(given)
}

/**
 * The result of a direct change (top-level outcome `done`; a refusal is an error). `undo` is the
 * journal entry that puts it back, or null when the change made only new files or went to the Trash.
 */
export function applied(text: string, data: Record<string, unknown>, undo: string | null = null): OperationResult {
  return {
    data: { ...data, undo },
    text: undo ? `${text}\nUndo with: writeflex undo ${undo}` : text,
  }
}

export const STDIN_ARG = { name: 'stdin', type: 'boolean', description: 'Read the text from standard input.' } as const
