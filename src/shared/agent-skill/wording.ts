// The words of the agent-skill offer and Settings card. The title and text are the owner's
// (2026-10-30, references/agent-skill.md); only the app's name and the feature sentence are passed in.
// Pure; erasable TypeScript only.
import type { AgentRow, CliRow } from './types.ts'

export interface Wording {
  appName: string
  /** "create and edit your presentations" */
  features: string
  /** The sentence offered to try once connected, for one agent's name. */
  tryExample?: (agent: string) => string
}

export const skillWording = ({ appName, features, tryExample }: Wording) => ({
  tryExample: (agent: string) => (tryExample ? tryExample(agent) : `Ask ${agent} to ${features}.`),
  title: `Give your agents skills to use ${appName}`,
  text: `This will install a skill that tells your agent how to do things with ${appName}. You will be able to ask your agent to ${features}.`,
  install: 'Install skill',
  notNow: 'Not now',
  foundLine: 'Found on this computer',
  whatThisDoes: 'What this does',
  noneFoundTitle: 'No agents found on this computer',
  noneFound: (names: string[]) => `${appName} looks for ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} when it starts. If you install one later, it will be offered here and in the status bar.`,
  refreshNote: `Installed copies are updated with each ${appName} update.`,
  laterTitle: (names: string[]) => `${appName} found ${joinNames(names)}.`,
  laterText: (names: string[]) => `Install the skill? You will be able to ask ${joinNames(names)} to ${features}.`,
  laterMark: (names: string[]) => `${appName} found ${joinNames(names)} · Install skill?`,
  viaLine: (name: string, through: string[]) => `${name} uses ${joinNames(through)}, so it comes along with them.`,
  disclosure: (rows: Array<{ name: string; folder: string }>, command: string, viaNotes: string[]) =>
    [`${appName} adds a small set of instructions for each agent you tick, so the agent knows how to use ${appName}. It writes these folders and nothing else:`,
     ...rows.map((r) => `${r.folder} for ${r.name}`),
     `It also adds a command-line tool, ${command}, which the agents run to work with ${appName}.${viaNotes.length ? ` ${viaNotes.join(' ')}` : ''}`,
     `Installed copies are updated with each ${appName} update. You can remove them at any time in Settings.`],
  doneTitle: 'Your agents are connected',
  doneLead: `These agents can now work with ${appName}:`,
  tryHeading: 'Try this in one of your agents',
  done: 'Done'
})

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** One status line and one detail for a Settings row. */
export function rowWords(row: AgentRow): { status: string; detail: string } {
  switch (row.state) {
    case 'installed': return { status: 'Installed', detail: row.newer ? `Version ${row.version}, newer than this copy of the app, kept` : `Version ${row.version ?? ''}`.trim() }
    case 'not-installed': return { status: 'Not installed', detail: row.reason ?? 'Found on this computer' }
    case 'separate': return { status: 'Installed separately', detail: `Version ${row.version ?? ''}`.trim() }
    case 'kept': return { status: 'Kept as it is', detail: row.reason ?? 'Already has its own version' }
    case 'changed': return { status: 'Changed', detail: row.reason ?? 'You have changed this copy. It is left as it is.' }
    case 'shared': return { status: 'Installed', detail: row.reason ?? '' }
    case 'via': return { status: 'Comes along', detail: row.reason ?? '' }
    case 'failed': return { status: 'Not installed', detail: row.reason ?? 'The folder could not be written.' }
    case 'not-found': return { status: 'Not found', detail: 'Not on this computer' }
  }
}

/** The command-line tool is part of an install: installed, or not available on this system at all. */
export const cliAcceptable = (cli: CliRow): boolean => cli.state === 'installed' || cli.state === 'unsupported'

/** The one line about the command-line tool; when it is blocked, says the skill is installed and why the tool is not. */
export function cliWords(cli: CliRow, skillInstalled: boolean): string {
  if (cliAcceptable(cli) || cli.state === 'not-installed') return cli.message
  return skillInstalled ? `The skill is installed, but the command-line tool is blocked: ${cli.message}` : cli.message
}
