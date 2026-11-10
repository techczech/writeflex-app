// Finding agents on this computer (read-only). Statting folders only: nothing is spawned, no file's
// contents are read, no network. Every disk question is time-bounded, so a hung network or cloud
// folder cannot hold the caller; a stat that has not come back counts as "not there".
// No Electron import; no app specifics.
import { readdir, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { AGENT_TABLE, type AgentDef, type PathContext } from '../../shared/agent-skill/agents.ts'

export interface StatResult { isFile: boolean; isDirectory: boolean; executable: boolean }
export interface Probe {
  stat(path: string): Promise<StatResult | null>
  list(path: string): Promise<string[]>
}

export function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    work.then((v) => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

export function nodeProbe(timeoutMs = 1500): Probe {
  return {
    stat: (path) => bounded(stat(path).then((s) => ({ isFile: s.isFile(), isDirectory: s.isDirectory(), executable: (s.mode & 0o111) !== 0 }), () => null), timeoutMs, null),
    list: (path) => bounded(readdir(path).catch(() => [] as string[]), timeoutMs, [] as string[])
  }
}

export interface DetectContext extends PathContext { platform: NodeJS.Platform; probe: Probe }
export interface Found { found: boolean; by: string | null }

/** The folders a program is looked for in: PATH, and the places a GUI app's thin PATH leaves out. */
export function searchDirs(ctx: Pick<DetectContext, 'platform' | 'home' | 'env'>): string[] {
  const fromPath = (ctx.env.PATH ?? '').split(delimiter).filter(Boolean)
  const extra = ctx.platform === 'win32' ? [] : [
    ...(ctx.platform === 'darwin' ? ['/opt/homebrew/bin'] : []), '/usr/local/bin', '/usr/bin',
    join(ctx.home, '.local', 'bin'), join(ctx.home, '.npm-global', 'bin'), join(ctx.home, '.bun', 'bin')
  ]
  return [...new Set([...fromPath, ...extra])]
}

async function hasProgram(names: readonly string[], ctx: DetectContext): Promise<string | null> {
  const suffixes = ctx.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  const candidates: string[] = []
  for (const dir of searchDirs(ctx)) for (const name of names) for (const suffix of suffixes) candidates.push(join(dir, name + suffix))
  const hits = await Promise.all(candidates.map(async (p) => {
    const s = await ctx.probe.stat(p)
    return s && s.isFile && (ctx.platform === 'win32' || s.executable) ? p : null
  }))
  return hits.find((h) => h !== null) ?? null
}

async function hasApp(patterns: readonly RegExp[], ctx: DetectContext): Promise<string | null> {
  if (ctx.platform !== 'darwin' || patterns.length === 0) return null
  for (const dir of ['/Applications', join(ctx.home, 'Applications')]) {
    const names = await ctx.probe.list(dir)
    const hit = names.find((n) => patterns.some((p) => p.test(n)))
    if (hit) return join(dir, hit)
  }
  return null
}

export async function detectAgent(def: AgentDef, ctx: DetectContext): Promise<Found> {
  const [program, app, folders] = await Promise.all([
    def.binaries.length ? hasProgram(def.binaries, ctx) : Promise.resolve(null),
    hasApp(def.apps, ctx),
    Promise.all(def.configFolders(ctx).map(async (f) => ((await ctx.probe.stat(f))?.isDirectory ? f : null)))
  ])
  const by = program ?? app ?? folders.find((f) => f !== null) ?? null
  return { found: by !== null, by }
}

export async function detectAll(ctx: DetectContext, table: readonly AgentDef[] = AGENT_TABLE): Promise<Map<string, Found>> {
  const entries = await Promise.all(table.map(async (d) => [d.id, await detectAgent(d, ctx)] as const))
  return new Map(entries)
}
