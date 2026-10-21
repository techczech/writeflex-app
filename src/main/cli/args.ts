import { CliError, type ArgSpec, type Operation, type OutputMode, type ParsedArgs } from './operation'

export type Invocation = {
  root?: string
  /** The global `--source`, given before the operation name. */
  source?: string
  output: OutputMode
  /** No operation named: show help. */
  operation: Operation | null
  args: ParsedArgs
}

function coerce(spec: ArgSpec, raw: string): string | number {
  if (spec.type === 'integer') {
    if (!/^-?\d+$/.test(raw)) throw new CliError(`--${spec.name} needs a whole number, not "${raw}".`, 'usage')
    return Number(raw)
  }
  return raw
}

/**
 * `writeflex [--root dir] [--json] <operation> [words] [--arg value | --arg=value] [-- words]`. Global
 * flags may appear anywhere before `--`. Bare words fill the operation's positional arguments in order.
 * Unknown flags, missing required arguments and extra words are usage errors, never guessed at.
 *
 * `--` ENDS THE OPTIONS. Every token after it is a bare word whatever it begins with, so a file named
 * `--json` or `--root=x` (a name an agent did not choose) can be passed as the path it is and never
 * becomes a flag. A positional argument is given once: as a bare word or by its name, never both, so
 * a named flag can never silently replace the path a bare word gave.
 */
export function parseInvocation(argv: string[], table: Operation[]): Invocation {
  let root: string | undefined
  let source: string | undefined
  let output: OutputMode = 'text'
  let helpFlag = false
  const words: string[] = []
  const flags: Array<[string, string | true]> = []
  let literal = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (literal) words.push(token)
    else if (token === '--') literal = true
    else if (token === '--json') output = 'json'
    else if (token === '--help' || token === '-h') helpFlag = true
    else if (token === '--root' || token.startsWith('--root=')) {
      const value = token.includes('=') ? token.slice(7) : argv[++i]
      if (!value) throw new CliError('--root needs a folder.', 'usage')
      root = value
    } else if (words.length === 0 && (token === '--source' || token.startsWith('--source='))) {
      // Before the operation name it is global; after it, it is the operation's own argument.
      const value = token.includes('=') ? token.slice(9) : argv[++i]
      if (!value) throw new CliError('--source needs a value: who is asking, for example claude-code or codex.', 'usage')
      source = value
    } else if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=')
      if (eq > 0) flags.push([token.slice(2, eq), token.slice(eq + 1)])
      else {
        const spec = flagSpec(table, words[0], token.slice(2))
        // A boolean flag takes no value; anything else takes the next word.
        if (spec?.type === 'boolean') flags.push([token.slice(2), true])
        else if (i + 1 >= argv.length) flags.push([token.slice(2), true])
        else flags.push([token.slice(2), argv[++i]])
      }
    } else words.push(token)
  }
  if (words.length === 0) return { ...(root ? { root } : {}), ...(source ? { source } : {}), output, operation: null, args: {} }
  const operation = table.find((op) => op.name === words[0])
  if (!operation) throw new CliError(`Unknown operation "${words[0]}". Run "writeflex help" to list them.`, 'usage')
  if (helpFlag) return { ...(root ? { root } : {}), ...(source ? { source } : {}), output, operation: table.find((op) => op.name === 'describe') ?? null, args: { operation: operation.name } }

  const args: ParsedArgs = {}
  const positionals = operation.args.filter((a) => a.positional)
  const bare = words.slice(1)
  if (bare.length > positionals.length) throw new CliError(`${operation.name} takes ${positionals.length} bare argument${positionals.length === 1 ? '' : 's'}; got "${bare[positionals.length]}" extra.`, 'usage')
  positionals.forEach((spec, i) => { if (bare[i] !== undefined) args[spec.name] = coerce(spec, bare[i]) })
  for (const [name, value] of flags) {
    const spec = operation.args.find((a) => a.name === name)
    if (!spec) throw new CliError(`${operation.name} has no argument --${name}.`, 'usage')
    if (spec.positional && args[name] !== undefined) throw new CliError(`${operation.name} was given <${name}> twice (as a bare word and as --${name}, or as --${name} twice). Give it once.`, 'usage')
    if (spec.type === 'boolean') args[name] = value === true || value === 'true'
    else if (value === true) throw new CliError(`--${name} needs a value.`, 'usage')
    else args[name] = coerce(spec, value)
  }
  for (const spec of operation.args) {
    if (spec.required && args[spec.name] === undefined) throw new CliError(`${operation.name} needs ${spec.positional ? `<${spec.name}>` : `--${spec.name}`}.`, 'usage')
  }
  return { ...(root ? { root } : {}), ...(source ? { source } : {}), output, operation, args }
}

function flagSpec(table: Operation[], operation: string | undefined, name: string): ArgSpec | undefined {
  return table.find((op) => op.name === operation)?.args.find((a) => a.name === name)
}

/** Whether `--json` is among the options (the tokens before a `--`): how an error is printed when the arguments cannot be parsed at all. */
export function asksForJson(argv: string[]): boolean {
  const end = argv.indexOf('--')
  return (end === -1 ? argv : argv.slice(0, end)).includes('--json')
}
