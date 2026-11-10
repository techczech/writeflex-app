// Where the agent skill feature keeps its own state: a folder of small files, so changes to different agents never share a file.
//   agents/<id>.json  one agent's record; only a change to that agent writes it
//   app.json          app-wide values (onboarded, the version at the last refresh)
//   history.jsonl     one change per line, appended
// Each JSON file is replaced whole by writing a temporary file and renaming it over the old one, so a
// reader sees the old file or the new one, never half of one. A history line is added with one append
// of a complete line. Two windows or the command line changing different agents touch different files.
// A missing or damaged file reads as absent; reading never throws and never stops startup.
// An agent id reaches a path only if it is one of the ids this store was made with.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSkillState, ChangeNote, LastResult } from '../../shared/agent-skill/types.ts'

export type AgentRecord = AgentSkillState['agents'][string]
export type AppRecord = Pick<AgentSkillState, 'format' | 'appVersion' | 'onboarded'>

export interface StateStore {
  /** The app-wide record, or null until one has been stored (that is how a first launch is told from a later one). */
  readApp(): AppRecord | null
  /** Changes only the fields given; the file is read again just before it is replaced. */
  writeApp(patch: Partial<Pick<AppRecord, 'appVersion' | 'onboarded'>>): void
  /** Consent (agents/<id>.json) and the last result (agents/<id>.result.json) merged; null when neither is stored. */
  readAgent(id: string): AgentRecord | null
  /** Writes consent only (choice, offered): install, remove, decline and the offer answers. Never the result. */
  writeAgent(id: string, record: Pick<AgentRecord, 'choice' | 'offered'>): void
  /** Writes the last result only: the one file the launch refresh writes for an agent. */
  writeResult(id: string, result: LastResult): void
  /** Changes in the order they were made; a damaged line is skipped. */
  readChanges(): ChangeNote[]
  /** True when the whole line was written. Never throws: a history that cannot be written is not a failure of the change. */
  appendChange(note: ChangeNote): boolean
}

const ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/
let counter = 0

function replaceJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${counter++}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`)
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const own = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined)

function cleanLast(v: unknown): LastResult | null {
  if (!isObject(v)) return null
  const ok = own(v, 'ok'); const at = own(v, 'at'); const message = own(v, 'message')
  return typeof ok === 'boolean' && typeof at === 'number' && typeof message === 'string' ? { ok, at, message } : null
}

function cleanAgent(v: unknown): AgentRecord | null {
  if (!isObject(v)) return null
  const choice = own(v, 'choice')
  return {
    choice: choice === 'connected' || choice === 'declined' || choice === 'removed' ? choice : null,
    offered: own(v, 'offered') === true,
    lastResult: cleanLast(own(v, 'lastResult'))
  }
}

function cleanApp(v: unknown): AppRecord | null {
  if (!isObject(v) || own(v, 'format') !== 1) return null
  const version = own(v, 'appVersion')
  return { format: 1, appVersion: typeof version === 'string' ? version : null, onboarded: own(v, 'onboarded') === true }
}

function cleanChange(v: unknown): ChangeNote | null {
  if (!isObject(v)) return null
  const at = own(v, 'at'); const who = own(v, 'who'); const action = own(v, 'action'); const agent = own(v, 'agent'); const result = own(v, 'result'); const version = own(v, 'version')
  if (typeof at !== 'number' || !isObject(who) || typeof action !== 'string' || typeof agent !== 'string' || typeof result !== 'string') return null
  return { at, who: who as ChangeNote['who'], action: action as ChangeNote['action'], agent, result: result as ChangeNote['result'], version: typeof version === 'string' ? version : null }
}

/** `write` is a test seam for a short write. */
export function createFileStateStore(dir: string, agentIds: readonly string[], io: { write?: typeof writeSync } = {}): StateStore {
  const writeBytes = io.write ?? writeSync
  const known = new Set(agentIds)
  const appFile = join(dir, 'app.json')
  const historyFile = join(dir, 'history.jsonl')
  /** Null for any id that is not in the table: such an id never becomes part of a path. */
  const agentFile = (id: unknown): string | null => (typeof id === 'string' && known.has(id) && ID_SHAPE.test(id) ? join(dir, 'agents', `${id}.json`) : null)

  const resultFile = (id: string): string => join(dir, 'agents', `${id}.result.json`)

  return {
    readApp: () => cleanApp(readJson(appFile)),
    writeApp(patch) {
      const now = cleanApp(readJson(appFile)) ?? { format: 1 as const, appVersion: null, onboarded: false }
      replaceJson(appFile, { ...now, ...patch })
    },
    readAgent(id) {
      const f = agentFile(id)
      if (!f) return null
      const consent = cleanAgent(readJson(f))
      const result = cleanLast(readJson(resultFile(id)))
      if (!consent && !result) return null
      return { choice: consent?.choice ?? null, offered: consent?.offered ?? false, lastResult: result }
    },
    writeAgent(id, record) {
      const f = agentFile(id)
      if (!f) throw new Error('Not an agent id.')
      replaceJson(f, { choice: record.choice, offered: record.offered })
    },
    writeResult(id, result) {
      const f = agentFile(id)
      if (!f) throw new Error('Not an agent id.')
      replaceJson(resultFile(id), result)
    },
    readChanges() {
      let text: string
      try { text = readFileSync(historyFile, 'utf8') } catch { return [] }
      const out: ChangeNote[] = []
      for (const line of text.split('\n')) {
        if (!line) continue
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { continue }
        const c = cleanChange(parsed)
        if (c) out.push(c)
      }
      return out
    },
    appendChange(note) {
      let fd: number | null = null
      try {
        mkdirSync(dir, { recursive: true })
        fd = openSync(historyFile, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT, 0o644)
        // A tail left without its newline (an earlier short write or a crash) is closed first, so the fragment
        // stays alone on a line that readers skip and this entry is whole.
        const size = fstatSync(fd).size
        let prefix = ''
        if (size > 0) { const b = Buffer.alloc(1); readSync(fd, b, 0, 1, size - 1); if (b[0] !== 0x0a) prefix = '\n' }
        const line = Buffer.from(`${prefix}${JSON.stringify(note)}\n`)
        return writeBytes(fd, line, 0, line.length) === line.length
      } catch { return false } finally { if (fd !== null) try { closeSync(fd) } catch { /* closed */ } }
    }
  }
}
