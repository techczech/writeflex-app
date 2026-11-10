// The verb inventory (design element 11) for the built-in agent skill: every verb an external agent can call, as data.
// The skill's generated references/commands.md is built from it, and tests/main/agent-skill-coverage.ts
// (scripts/test-agent-skill-coverage.mjs) fails, naming the verb, when one is not described in the hand-written skill
// (or listed with a reason in resources/agent-skill/not-in-skill.txt). A verb added, changed or removed is not finished
// until the skill says so: that is part of the feature, in the same change.
//
// The verbs are read from the command line's own operation table (cli/table.ts), so the list cannot drift from the
// parsers; `agent` comes from the route's own table (agent-skill/cli.ts). The in-process verbs of the app's own
// agent (src/main/verbs/, resources/skills) have no external route: an outside agent cannot call them, so they are not
// in this inventory.
//
// No Electron import (bun runs it as it is; the operation table is Electron-free by design).
import { AGENT_ROUTE_VERBS } from './agent-skill/cli.ts'
import { BEHAVIOUR_LABELS, buildOperationTable } from './cli/table'
import { TASK_GROUPS } from './cli/groups'
import type { Operation } from './cli/operation'

export interface VerbEntry {
  /** `search`, `replace` (the command line) or `agent install` (the agent route). */
  verb: string
  args: string
  summary: string
  group: string
  behaviour: string
}

const argsOf = (op: Operation): string =>
  op.args.map((a) => {
    const shown = a.positional ? `<${a.name}>` : `--${a.name}${a.type === 'boolean' ? '' : ` <${a.type}>`}`
    return a.required ? shown : `[${shown}]`
  }).join(' ')

export const CLI_VERBS: readonly VerbEntry[] = [
  ...buildOperationTable().map((op): VerbEntry => ({ verb: op.name, args: argsOf(op), summary: op.summary, group: op.group, behaviour: BEHAVIOUR_LABELS[op.behaviour] })),
  ...AGENT_ROUTE_VERBS.map((v): VerbEntry => ({ verb: v.verb, args: v.args, summary: v.summary, group: 'Connect agents', behaviour: 'direct' }))
]

export const VERB_INVENTORY: readonly VerbEntry[] = CLI_VERBS

/**
 * references/commands.md, generated from the inventory at build. `omitted` is the verbs listed in resources/agent-skill/not-in-skill.txt:
 * a verb left out of the hand-written skill on purpose (it needs a tool a stranger's computer does not have) is left out here too.
 */
export function commandsReference(omitted: ReadonlySet<string> = new Set()): string {
  const table = (rows: readonly VerbEntry[]): string[] => ['| Command | Arguments | Behaviour | What it does |', '|---|---|---|---|', ...rows.map((v) => `| \`writeflex ${v.verb}\` | ${v.args ? `\`${v.args}\`` : ''} | ${v.behaviour} | ${v.summary} |`), '']
  const sections = [...TASK_GROUPS, 'Connect agents'].flatMap((group) => {
    const rows = CLI_VERBS.filter((v) => v.group === group && !omitted.has(v.verb))
    return rows.length ? [`## ${group}`, '', ...table(rows)] : []
  })
  return [
    '# Commands (generated)',
    '',
    'Generated from the app\'s operation table at build. Do not edit. How to use them: [command line](cli.md).',
    '',
    'Behaviour: direct runs at once; shown first files the change for the writer to accept in WriteFlex and changes nothing; asks needs `--confirm`.',
    'Global options, before the operation name: `--root <folder>`, `--json`, `--source <who>`. `writeflex describe <operation>` prints one operation in full.',
    '',
    ...sections
  ].join('\n')
}
