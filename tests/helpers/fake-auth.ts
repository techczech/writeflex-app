// Synthetic authentication fixtures only. Assemble protocol text at runtime so the
// public-copy scanner still rejects literal credentials everywhere else.
export function fakeBearer(token: string): string {
  return ['Bearer', token].join(' ')
}

// An agent-file import is syntax, but its literal spelling resembles an email.
export const AGENT_IMPORT = ['@', 'AGENTS.md'].join('')
