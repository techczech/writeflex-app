// Bridle 0.2.0 does not export its CLI parser, chord parser or formatters. Keep this app adapter's
// mutation output compatible with that public CLI; parity tests compare text, JSON and exit codes.
import { formatValue, LIMITS, type ChangeEntry, type ImportPreview, type Schema } from '@app-patterns/settings'
import { DEFAULT_AGENT, EXIT } from '@app-patterns/settings/node'

export const USAGE = `Usage:
  list [--section <id>]
  get <key>
  set <key> <value>
  reset <key> | --section <id> | --all --yes
  rebind <command> <shortcut>        (shortcut: "cmd+shift+l", "⌘⇧L", or "none")
  reset-shortcut <command> | --all --yes
  changes [--limit <n>]
  export <file>
  import <file> [--yes]
  undo-import --last | <batch>
Options for every command: --json, --agent <name> (or BRIDLE_AGENT)`
const VALUE_FLAGS = new Set(['section', 'limit', 'agent'])
const BOOL_FLAGS = new Set(['all', 'yes', 'last', 'json'])
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const escapeControl = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
export const esc = (text: unknown): string => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, escapeControl)
export const safe = (text: string): string => text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, escapeControl)

export class CliExit {
  constructor(readonly code: number, readonly message: string, readonly json?: object) {}
}

type Parsed = { verb: string | undefined; args: string[]; flags: Map<string, string | boolean>; json: boolean; error?: CliExit }
/** Tokenisation alone is permissive: an unowned verb goes to Bridle with its argv untouched. */
export function tokenize(argv: string[]): Parsed {
  const args: string[] = []
  const flags = new Map<string, string | boolean>()
  let rest = false
  let error: CliExit | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (rest || !token.startsWith('--')) { args.push(token); continue }
    if (token === '--') { rest = true; continue }
    const eq = token.indexOf('=')
    const name = token.slice(2, eq < 0 ? undefined : eq)
    if (VALUE_FLAGS.has(name)) {
      const value = eq >= 0 ? token.slice(eq + 1) : argv[++i]
      if (value === undefined) error ??= new CliExit(EXIT.badInput, `--${name} needs a value`)
      else flags.set(name, value)
    } else if (BOOL_FLAGS.has(name) && eq < 0) flags.set(name, true)
    else error ??= new CliExit(EXIT.badInput, /^--[a-z-]{1,20}$/.test(token) ? `Unknown option ${token}\n${USAGE}` : `Unknown option\n${USAGE}`)
  }
  return { verb: args.shift(), args, flags, json: flags.get('json') === true, error }
}

const SPECS: Record<string, { args: [number, number]; flags: string[] }> = {
  rebind: { args: [2, 2], flags: [] },
  'reset-shortcut': { args: [0, 1], flags: ['all', 'yes'] },
  reset: { args: [0, 1], flags: ['section', 'all', 'yes'] },
  import: { args: [1, 1], flags: ['yes'] },
  'undo-import': { args: [0, 1], flags: ['last'] },
}
export function validateMutation(parsed: Parsed): void {
  if (parsed.error) throw parsed.error
  const { verb, args, flags } = parsed
  const spec = SPECS[verb!]
  if (args.length < spec.args[0] || args.length > spec.args[1]) throw new CliExit(EXIT.badInput, USAGE)
  for (const name of flags.keys()) {
    if (name !== 'json' && name !== 'agent' && !spec.flags.includes(name)) throw new CliExit(EXIT.badInput, `--${name} does not go with ${verb}\n${USAGE}`)
  }
}

export function agentName(flag: string | boolean | undefined, env: Record<string, string | undefined>): string {
  const name = (typeof flag === 'string' ? flag : env['BRIDLE_AGENT'] ?? '').trim()
  if (!name) return DEFAULT_AGENT
  if (CONTROL.test(name)) throw new CliExit(EXIT.badInput, 'The agent name cannot hold control characters')
  if (name.length > LIMITS.name) throw new CliExit(EXIT.badInput, `The agent name can be at most ${LIMITS.name} characters`)
  return name
}
export const exitFor = (code: string): number => ['unwritten', 'closed', 'too-large', 'refused'].includes(code) ? EXIT.failed : code === 'locked' ? EXIT.locked : EXIT.badInput

const MOD_ORDER = ['⌘', '⌃', '⌥', '⇧']
const MOD_WORDS: Record<string, string> = { cmd: '⌘', command: '⌘', meta: '⌘', super: '⌘', '⌘': '⌘', ctrl: '⌃', control: '⌃', '⌃': '⌃', alt: '⌥', opt: '⌥', option: '⌥', '⌥': '⌥', shift: '⇧', '⇧': '⇧' }
const KEY_WORDS: Record<string, string> = { enter: '↵', return: '↵', esc: 'Esc', escape: 'Esc', tab: '⇥', space: 'Space', up: '↑', down: '↓', left: '←', right: '→', backspace: '⌫', delete: '⌦', del: '⌦', comma: ',', period: '.', slash: '/', plus: '+', minus: '-' }
function keyOf(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  return KEY_WORDS[text.toLowerCase()] ?? (/^f([1-9]|1\d|2[0-4])$/i.test(text) || [...text].length === 1 ? text.toUpperCase() : text)
}
export function parseChordArg(raw: string): { ok: true; chord: string } | { ok: false; error: string } {
  const text = raw.trim()
  if (!text || text.toLowerCase() === 'none') return { ok: true, chord: '' }
  const mods = new Set<string>()
  let key: string | null
  if (text.length > 1 && text.includes('+')) {
    const parts = text.split('+')
    const last = parts.at(-1) === '' && parts.at(-2) === '' ? '+' : parts.pop()!
    if (last === '+') parts.splice(-2, 2)
    for (const part of parts) {
      const modifier = MOD_WORDS[part.trim().toLowerCase()]
      if (!modifier) return { ok: false, error: `"${part.trim().slice(0, 20)}" is not a modifier; use cmd, ctrl, alt or shift` }
      mods.add(modifier)
    }
    key = last === '+' ? '+' : keyOf(last)
  } else {
    let rest = text
    while (rest.length > 0 && MOD_ORDER.includes(rest[0])) { mods.add(rest[0]); rest = rest.slice(1) }
    key = keyOf(rest)
  }
  return key ? { ok: true, chord: MOD_ORDER.filter((mod) => mods.has(mod)).join('') + key } : { ok: false, error: 'A shortcut needs a key after its modifiers' }
}
function whoText(entry: ChangeEntry): string {
  const who = entry.who
  switch (who.kind) {
    case 'you': return 'you'
    case 'agent': return `agent ${esc(who.name)}`
    case 'app-update': return `app update ${esc(who.version)}`
    case 'import': return `import of ${esc(who.file)}${who.by?.kind === 'agent' ? ` by agent ${esc(who.by.name)}` : ''}`
    case 'reset': return `reset${who.by?.kind === 'agent' ? ` by agent ${esc(who.by.name)}` : ''}`
  }
}
export function entryLine(entry: ChangeEntry, schema: Schema): string {
  const def = entry.key !== undefined ? schema.def(entry.key) : undefined
  const val = (value: ChangeEntry['to']) => esc(entry.commandId !== undefined ? value === '' ? 'None' : value === null ? '—' : String(value) : formatValue(def, value))
  const at = Number.isFinite(entry.at) && Math.abs(entry.at) <= 8640000000000000 ? new Date(entry.at).toISOString() : '?'
  return `${at}  ${esc(entry.key ?? `shortcut ${entry.commandId}`)}  ${val(entry.from)} → ${val(entry.to)}  by ${whoText(entry)}${entry.batch ? `  batch ${esc(entry.batch)}` : ''}${entry.note ? ` (${esc(entry.note)})` : ''}`
}
export function previewText(preview: ImportPreview, schema: Schema): string {
  const lines: string[] = []
  const source = preview.source
  if (source) lines.push(`From ${[source.exportedFrom, source.appVersion && `version ${source.appVersion}`, source.exportedAt].filter(Boolean).map(esc).join(', ') || 'an export file'}`)
  lines.push(`${preview.changes.length} to change, ${preview.skipped.length} skipped, ${preview.alreadyMatch} already match`)
  for (const change of preview.changes) {
    lines.push(change.key !== undefined
      ? `  ${esc(change.key)}: ${esc(formatValue(schema.def(change.key), change.from))} → ${esc(formatValue(schema.def(change.key), change.to))}`
      : `  shortcut ${esc(change.commandId)}: ${esc(change.from || 'None')} → ${esc(change.to || 'None')}`)
  }
  for (const skipped of preview.skipped) lines.push(`  skipped ${esc(skipped.key ?? `shortcut ${skipped.commandId}`)}: ${esc(skipped.reason)}`)
  return lines.join('\n')
}
