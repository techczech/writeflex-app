// The agents an app can give its skill to, as data in one module (contract: agent-skill.md, "Agents and
// folders"). Agent folders move: re-check every row against the agent's own docs at each release
// (DOCS_CHECKED says when that was last done). Nothing here is specific to one app.
// Pure; erasable TypeScript only.

export interface PathContext {
  home: string
  env: Readonly<Record<string, string | undefined>>
}

export interface AgentDef {
  id: string
  name: string
  /** Programs looked for on PATH and in the places a GUI app's thin PATH leaves out. */
  binaries: readonly string[]
  /** Desktop app names (macOS, in /Applications and ~/Applications). */
  apps: readonly RegExp[]
  /** Folders whose presence counts as the agent being there. */
  configFolders(ctx: PathContext): string[]
  /** The agent's skills folder, or null when it has none of its own. */
  skillsDir(ctx: PathContext): string | null
  /** Agents whose skills folder this one also reads: when that copy is there, this one gets none of its own. */
  alsoReads?: readonly string[]
  /** An agent that runs through others (T3 Code): named in the offer, nothing written for it. */
  via?: readonly string[]
}

const join = (...parts: string[]): string => parts.join('/').replace(/\/{2,}/g, '/')

export const DOCS_CHECKED = '2026-10-30'

export const AGENT_TABLE: readonly AgentDef[] = [
  {
    id: 'claude-code', name: 'Claude Code',
    binaries: ['claude'], apps: [],
    configFolders: ({ home, env }) => [env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')],
    skillsDir: ({ home, env }) => join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), 'skills')
  },
  {
    id: 'codex', name: 'Codex',
    binaries: ['codex'], apps: [/^Codex\.app$/i],
    configFolders: ({ home }) => [join(home, '.codex')],
    skillsDir: ({ home }) => join(home, '.agents', 'skills')
  },
  {
    id: 'gemini-cli', name: 'Gemini CLI',
    binaries: ['gemini'], apps: [],
    configFolders: () => [],
    skillsDir: ({ home }) => join(home, '.gemini', 'skills'),
    alsoReads: ['codex']
  },
  {
    id: 'antigravity', name: 'Antigravity',
    binaries: [], apps: [/^Antigravity\.app$/i],
    configFolders: () => [],
    skillsDir: ({ home }) => join(home, '.gemini', 'antigravity', 'skills')
  },
  {
    id: 't3-code', name: 'T3 Code',
    binaries: [], apps: [/^T3[ -]?Code.*\.app$/i],
    configFolders: () => [],
    skillsDir: () => null,
    via: ['claude-code', 'codex']
  }
]

export const agentById = (id: string): AgentDef | undefined => AGENT_TABLE.find((a) => a.id === id)
export const agentIds = (): string[] => AGENT_TABLE.map((a) => a.id)
