import { TASK_GROUPS } from './groups'
import { CliError, type Behaviour, type Operation } from './operation'
import { ERROR_CODES, ERROR_OUTCOME, OUTCOMES, OUTCOME_LINES, OUTCOME_MEANINGS, type Outcome } from './outcome'
import { EXAMPLES } from './operation-examples'
import { REQUEST_OPERATIONS } from './request-format'
// Order matters: the app's readers must load before its writers. plan-agent-reads and
// agent-note-create import each other through the verbs, and loading the note writer first leaves a
// constant unset when the reader needs it.
import { READ_OPERATIONS } from './read-operations'
import { CREATE_OPERATIONS } from './create-operations'
import { EXPORT_OPERATIONS } from './export-operation'
import { ORGANISE_OPERATIONS } from './organise-operations'
import { VERSION_OPERATIONS } from './version-operations'
import { REVIEW_OPERATIONS } from './review-operations'

export const BEHAVIOUR_LABELS: Record<Behaviour, string> = { direct: 'direct', 'shown-first': 'shown first', asks: 'asks' }

/**
 * The outcomes an operation can return, by how it is carried out: a change shown first is filed and
 * waits; one the app can carry out may also be sent and unconfirmed or unverified; the rest are done or
 * refused. Every operation can be given bad arguments and can meet an unexpected error.
 */
export function outcomesOf(op: Operation): Outcome[] {
  const requestable = (REQUEST_OPERATIONS as readonly string[]).includes(op.name)
  const out: Outcome[] =
    op.behaviour === 'shown-first' ? ['filed', 'refused', 'needs-writer', 'sent-not-confirmed', 'not-verified']
    : op.name === 'save-version' ? ['done', 'refused', 'needs-writer', 'sent-not-confirmed', 'not-verified']
    : requestable ? ['done', 'refused', 'sent-not-confirmed', 'not-verified']
    : ['done', 'refused']
  return [...out, 'usage', 'failed']
}

const usageLine = (op: Operation): string =>
  [op.name, ...op.args.map((a) => {
    const shown = a.positional ? `<${a.name}>` : `--${a.name}${a.type === 'boolean' ? '' : ` <${a.type}>`}`
    return a.required ? shown : `[${shown}]`
  })].join(' ')

export function describeText(op: Operation): string {
  const args = op.args.map((a) => `  ${a.positional ? a.name : `--${a.name}`}  (${a.type}${a.required ? ', required' : ''})  ${a.description}`)
  const example = EXAMPLES[op.name]
  return [
    `writeflex ${usageLine(op)}`, '', op.summary, ...(op.details ? ['', op.details] : []),
    `Group: ${op.group}. Behaviour: ${BEHAVIOUR_LABELS[op.behaviour]}.`,
    `Outcomes: ${outcomesOf(op).join(', ')}.`,
    ...(args.length ? ['', 'Arguments:', ...args] : []),
    ...(example ? ['', 'Example:', `  ${example}`] : []),
  ].join('\n')
}

/** Operations under the approved task-group names, in the approved order; empty groups are left out. */
export function helpText(table: Operation[]): string {
  const width = Math.max(...table.map((op) => op.name.length)) + 2
  const behaviourWidth = Math.max(...Object.values(BEHAVIOUR_LABELS).map((label) => label.length)) + 2
  const sections = TASK_GROUPS.flatMap((group) => {
    const inGroup = table.filter((op) => op.group === group)
    return inGroup.length === 0 ? [] : [[group, ...inGroup.map((op) => `  ${op.name.padEnd(width)}${BEHAVIOUR_LABELS[op.behaviour].padEnd(behaviourWidth)}${op.summary}`)].join('\n')]
  })
  return [
    'writeflex [--root <folder>] [--json] [--source <who>] <operation> [arguments] [-- paths]',
    '',
    ...sections.flatMap((s) => [s, '']),
    'Behaviour: direct runs at once; shown first files the change for the writer to accept in WriteFlex and changes nothing; asks needs --confirm.',
    'writeflex describe <operation> explains one operation. --root defaults to the Collection found by walking up from the current folder.',
    "--source (before the operation name, or WRITEFLEX_SOURCE in the environment) says who is asking, for operations shown first and for create: claude-code or codex. An operation's own --source wins, then the flag, then the variable.",
    'Paths are exact: nothing is trimmed, so a name with a space before or after it is a different file. Put -- before a path that may begin with a dash: every word after -- is a path, never an option.',
    'read prints a document exactly when its output is piped or under --json; straight to a terminal, control characters in it are shown as \\u{hex}. --stdin takes at most 16 MiB.',
    `Every --json document carries "outcome": ${OUTCOMES.join(', ')}. A change shown first has outcome "filed" and is NOT applied. A write result begins with one fixed line, one of: ${OUTCOMES.map((o) => OUTCOME_LINES[o]).join(' ')}`,
    'Names: in plain text a hidden character in a name is shown as \\u{hex} (and a backslash before u{ as \\u{5c}); --json carries the exact name. A path argument is always taken literally, never decoded.',
  ].join('\n')
}

export function describeData(op: Operation): unknown {
  return {
    name: op.name, group: op.group, summary: op.summary, ...(op.details ? { details: op.details } : {}),
    behaviour: op.behaviour, outcomes: outcomesOf(op), args: op.args, ...(EXAMPLES[op.name] ? { example: EXAMPLES[op.name] } : {}),
  }
}

/** The full table: the read and write operations, plus help and describe, which read the table itself. */
export function buildOperationTable(): Operation[] {
  const table: Operation[] = [...READ_OPERATIONS, ...VERSION_OPERATIONS, ...CREATE_OPERATIONS, ...ORGANISE_OPERATIONS, ...REVIEW_OPERATIONS, ...EXPORT_OPERATIONS]
  table.push(
    {
      name: 'help', group: 'Work with the agent', behaviour: 'direct',
      summary: 'List the operations, grouped by task.', args: [],
      run: async () => ({
        data: { groups: TASK_GROUPS.flatMap((group) => {
          const operations = table.filter((op) => op.group === group).map((op) => ({ name: op.name, summary: op.summary, behaviour: op.behaviour, outcomes: outcomesOf(op), args: op.args }))
          return operations.length ? [{ group, operations }] : []
        }),
        outcomes: OUTCOMES.map((outcome) => ({ outcome, line: OUTCOME_LINES[outcome], meaning: OUTCOME_MEANINGS[outcome] })),
        errorCodes: ERROR_CODES.map((code) => ({ code, outcome: ERROR_OUTCOME[code] })),
        globalOptions: [
          { name: 'root', description: 'The Collection folder. Default: found by walking up from the current folder.' },
          { name: 'json', description: 'One JSON document on stdout, for errors too.' },
          { name: 'source', description: "Who is asking, for operations shown first and for create (which records it in the new document): claude-code or codex. Before the operation name, or WRITEFLEX_SOURCE in the environment; the operation's own --source wins, then this flag, then the variable." },
          { name: '', description: 'Written --. Ends the options: every word after it is a path or bare word, whatever it begins with.' },
        ] },
        text: helpText(table),
        verbatim: true, // the command line's own words, which spell out the escape notation
      }),
    },
    {
      name: 'describe', group: 'Work with the agent', behaviour: 'direct',
      summary: 'Describe one operation: its group, behaviour, outcomes, arguments and an example.',
      args: [{ name: 'operation', type: 'string', required: true, positional: true, description: 'Operation name.' }],
      run: async (_ctx, args) => {
        const op = table.find((candidate) => candidate.name === args.operation)
        if (!op) throw new CliError(`No operation named "${String(args.operation)}". Run "writeflex help" to list them.`, 'usage')
        return { data: describeData(op), text: describeText(op) }
      },
    },
  )
  return table
}
