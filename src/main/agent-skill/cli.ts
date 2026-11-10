// `<app> agent status|install|remove [--agent <id>]... [--json]`: the agent's path to the same service
// the Settings card calls (service.ts), recorded in the same changelog (as the agent). No Electron import.
//
// `install` and `remove` cover only the agents named in the call (`--agent <id>`, repeatable): no agent is
// ever added by default, and there is no force flag: a link, an unmarked folder, an edited copy and a newer
// copy are kept exactly as in Settings (Replace is a Settings action).
// Exit codes: 0 done, 1 something was not done (the report says what), 2 usage error (nothing was done).
import { agentIds } from '../../shared/agent-skill/agents.ts'
import type { ActionReport, StatusReport } from '../../shared/agent-skill/types.ts'
import { cliWords, rowWords } from '../../shared/agent-skill/wording.ts'
import type { AgentSkills } from './service.ts'

/** The verbs of the route, for the app's verb inventory (the skill must describe each one). */
export const AGENT_ROUTE_VERBS: ReadonlyArray<{ verb: string; args: string; summary: string }> = [
  { verb: 'agent status', args: '[--agent <id>] [--json]', summary: 'Lists the agents found on this computer, whether the skill is installed for each, its version and why a copy was kept.' },
  { verb: 'agent install', args: '--agent <id> [--agent <id>...] [--json]', summary: 'Installs the skill (and the command-line tool) for the named agents only. Keeps links, unmarked folders, edited copies and newer copies.' },
  { verb: 'agent remove', args: '--agent <id> [--agent <id>...] [--json]', summary: 'Removes the skill from the named agents, only where the app installed it and it is unedited.' }
]

export interface AgentCliIO { stdout(text: string): void; stderr(text: string): void }

export const AGENT_USAGE: readonly string[] = [
  'Usage: <app> agent <command> [--json]',
  '',
  ...AGENT_ROUTE_VERBS.map((v) => `  ${v.verb.replace('agent ', '').padEnd(8)} ${v.args}`),
  '',
  `Agent ids: ${agentIds().join(', ')}.`,
  'Exit codes: 0 done, 1 something was not done (the report says what), 2 usage error.'
]

type Parsed = { ok: true; command: 'status' | 'install' | 'remove' | 'help'; ids: string[]; json: boolean } | { ok: false; error: string; json: boolean }

export function parseAgentArgs(args: readonly string[]): Parsed {
  let json = false
  const ids: string[] = []
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') json = true
    else if (a === '--agent') {
      const v = args[++i]
      if (!v || v.startsWith('--')) return { ok: false, error: '--agent needs an agent id.', json }
      if (!agentIds().includes(v)) return { ok: false, error: `Unknown agent. Use one of: ${agentIds().join(', ')}.`, json }
      if (!ids.includes(v)) ids.push(v)
    } else if (a.startsWith('--')) return { ok: false, error: 'Unknown option.', json }
    else rest.push(a)
  }
  const command = rest[0] ?? 'help'
  if (rest.length > 1) return { ok: false, error: 'Too many arguments.', json }
  if (command === 'help') return { ok: true, command, ids, json }
  if (command !== 'status' && command !== 'install' && command !== 'remove') return { ok: false, error: 'Unknown command. Run "agent help" for the list.', json }
  if (command !== 'status' && ids.length === 0) return { ok: false, error: `${command} covers only the agents you name: add --agent <id> for each one.`, json }
  return { ok: true, command, ids, json }
}

const statusLines = (s: StatusReport, only: readonly string[]): string[] => {
  const rows = s.agents.filter((r) => (only.length ? only.includes(r.id) : r.found || r.state !== 'not-found'))
  const lines = rows.map((r) => { const w = rowWords(r); return `${r.id.padEnd(12)} ${w.status}${w.detail ? ` — ${w.detail}` : ''}` })
  if (!rows.length) lines.push('No agents found on this computer.')
  lines.push(`command      ${cliWords(s.cli, s.agents.some((r) => r.state === 'installed' || r.state === 'shared'))}`)
  return lines
}

export async function runAgentCli(args: readonly string[], service: AgentSkills, io: AgentCliIO, asAgent = 'an agent', format = 'agent/1'): Promise<number> {
  const p = parseAgentArgs(args)
  if (!p.ok) {
    if (p.json) io.stdout(`${JSON.stringify({ format, ok: false, error: p.error })}\n`)
    else io.stderr(`${p.error}\n`)
    return 2
  }
  if (p.command === 'help') { io.stdout(`${AGENT_USAGE.join('\n')}\n`); return 0 }
  const who = { kind: 'agent' as const, name: asAgent }
  try {
    if (p.command === 'status') {
      const s = await service.status()
      if (p.json) io.stdout(`${JSON.stringify({ format, command: 'status', ok: true, ...s, agents: p.ids.length ? s.agents.filter((r) => p.ids.includes(r.id)) : s.agents })}\n`)
      else io.stdout(`${statusLines(s, p.ids).join('\n')}\n`)
      return 0
    }
    const r: ActionReport = p.command === 'install' ? await service.install(p.ids, { who }) : await service.remove(p.ids, { who })
    if (p.json) io.stdout(`${JSON.stringify({ format, command: p.command, ...r })}\n`)
    else {
      io.stdout(`${[...r.rows.map((x) => `${x.id.padEnd(12)} ${x.result} — ${x.message}`), ...(r.cli ? [`command      ${cliWords(r.cli, r.rows.some((x) => ['installed', 'updated', 'unchanged'].includes(x.result)))}`] : [])].join('\n')}\n`)
    }
    return r.ok ? 0 : 1
  } catch {
    if (p.json) io.stdout(`${JSON.stringify({ format, ok: false, error: 'The command could not run.' })}\n`)
    else io.stderr('The command could not run.\n')
    return 1
  }
}
