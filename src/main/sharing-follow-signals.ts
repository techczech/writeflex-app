// Publishing follows the piece when the COMMAND LINE moves it or sends it to the Trash with the
// Collection closed in WriteFlex (sharing ticket 04; orchestrator ruling round 1, R-F; Fable ruling after
// Sol round 3, rules 1 to 6). The app is not there to be told, so the command line leaves a signal in the
// app's application data, beside the settings file whose links it touches, and the app takes it at its
// next start, on wake, and whenever one is left while it runs. With the Collection open in WriteFlex the
// app carries the command out itself and tells its publisher in the same turn (request-executor.ts
// `sharing`), so no signal is left.
//
//   S1 one signal per link the change touches, left only for links in that settings file (the command
//      line reads the settings file, never writes it). It names the Collection, the link (its share id),
//      where the link was (`from`) and its generation then (the record's counter, bumped on every move,
//      undo and Turn on), and the move or the Trash. Never a token, never document text. Its file is
//      `<shareId>.<generation, 10 digits>.<nonce>.json`, written whole under a temporary name and renamed
//      in, so the app never reads half of one.
//   S2 the command line runs one at a time per Collection (its owner lock, cli/write-access.ts
//      `withOwnerLock`) and leaves a signal only after its move or undo is committed, or its Trash is
//      seen gone. It lists the signals still waiting BEFORE it reads the settings file, and takes the
//      links as those signals leave them, each link's signals in generation order, chaining only
//      consecutive generations: so a move made after another with the app closed names where the first
//      one left the link, and a signal the app takes between the two reads is already in the settings.
//   S3 the app takes the signals of each link in generation order (two files for one generation: the
//      first in name order; the second is stale). Links are independent. For each signal, against its
//      link's record (sharing-publisher.ts `applySignal`): at that generation and at `from`, it is
//      applied, its change saved first (R-F), then the file removed; at an earlier generation, at that
//      generation for another place, for a link that ended or is not there: stale, removed and reported;
//      at a later generation: held, with every later one of that link, until the one before it lands. A
//      change that could not be saved keeps this signal and every later one of that link for the next
//      look. A file removed after its change was saved and found again is stale (its generation is past).
//      Not a signal at all (too large, not JSON, a path that climbs out, a name that is not its body):
//      removed and reported.
//   S4 at start, after the first take and the start's look at every share (R-D): a signal still held is
//      removed and reported; its link stands on what the look found.
//
// Residual (ruling): the command line's owner lock taken over while it was suspended after its rename and
// before its signal. Its late signal moves the link to a place the file has since left; the look (R-D)
// then says "Piece not found", with Follow to when the file is found. Never a removal.
//
// Trust: a signal file is trusted only as far as the user's own account, as settings.json beside it is.
// Any process running as this user can write either; the checks above make a stale or replayed signal
// harmless, not a planted one. Nothing outside this Mac's account can reach the folder.
//
// No Electron import.
import { lstatSync, mkdirSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { endedByTrash, followMove } from './sharing-follow'
import { normaliseRoot } from './root-resolution'
import { readRecords, relativePathOk } from './sharing-share-record'
import type { ShareSignal } from './sharing-publisher'

export const FOLLOW_SIGNALS_FOLDER = 'sharing-follow-signals'
const MAX_SIGNAL_BYTES = 64 * 1024
const MAX_SIGNALS = 2000
const MAX_SETTINGS_BYTES = 16 * 1024 * 1024
/** S1: a generation fits the file name's ten digits. */
const MAX_GENERATION = 9_999_999_999

export type FollowMove = { from: string; to: string }
/** What a command-line operation finished in a Collection (before it is made into one signal per link). */
export type FollowChange = { root: string; moved: FollowMove[]; trashed: string[] }
export type FollowSignal = ShareSignal

const SIGNAL_NAME = /^([A-Za-z0-9]{8,64})\.(\d{10})\.([0-9a-f]{16})\.json$/
/** S1: the file a signal is left in. */
export const signalName = (signal: Pick<ShareSignal, 'shareId' | 'generation'>, nonce = randomBytes(8).toString('hex')): string =>
  `${signal.shareId}.${String(signal.generation).padStart(10, '0')}.${nonce}.json`

/** S3: a signal as the app may act on it, or null. */
export function readSignal(text: string): FollowSignal | null {
  try {
    const p = JSON.parse(text) as Record<string, unknown>
    if (p?.version !== 3) return null
    if (typeof p.root !== 'string' || !isAbsolute(p.root) || p.root.includes('\0')) return null
    if (typeof p.shareId !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(p.shareId)) return null
    if (!relativePathOk(p.from) && p.from !== '') return null
    if (!Number.isSafeInteger(p.generation) || (p.generation as number) < 0 || (p.generation as number) > MAX_GENERATION) return null
    const base = { root: p.root, shareId: p.shareId, from: p.from as string, generation: p.generation as number }
    if (p.trashed === true && p.move === undefined) return { ...base, trashed: true }
    const move = p.move as { from?: unknown; to?: unknown } | null
    if (p.trashed === undefined && move && typeof move === 'object' && relativePathOk(move.from) && relativePathOk(move.to)) return { ...base, move: { from: move.from, to: move.to } }
    return null
  } catch { return null }
}

/** S3: the file is named for the link and generation its body names. */
const namedFor = (name: string, signal: FollowSignal): boolean => {
  const match = SIGNAL_NAME.exec(name)
  return match !== null && match[1] === signal.shareId && Number.parseInt(match[2], 10) === signal.generation
}

/** S2, S3: each link's signals in generation order, then name order. */
const inOrder = <T extends { name: string; signal: FollowSignal }>(entries: T[]): T[] =>
  [...entries].sort((a, b) => a.signal.generation - b.signal.generation || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

/** Written whole under a temporary name and renamed in. */
async function writeWhole(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.${Date.now()}-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, text, { flag: 'wx' })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** S2: the signals left and not yet taken in `folder`, each link's in generation order. */
function waitingSignals(folder: string): FollowSignal[] {
  try {
    const entries = readdirSync(folder).filter((name) => SIGNAL_NAME.test(name)).sort().slice(0, MAX_SIGNALS).flatMap((name) => {
      try {
        const stat = lstatSync(join(folder, name))
        const signal = stat.isFile() && stat.size <= MAX_SIGNAL_BYTES ? readSignal(readFileSync(join(folder, name), 'utf8')) : null
        return signal && namedFor(name, signal) ? [{ name, signal }] : []
      } catch { return [] }
    })
    return inOrder(entries).map((entry) => entry.signal)
  } catch { return [] }
}

type LinkPlace = { shareId: string; root: string; path: string; generation: number; kind: 'piece' | 'folio'; partKeys: Record<string, string>; parts: Array<{ path: string; title: string; missing: boolean }> }

/**
 * S1, S2: the signals `change` makes for the links in one settings file: each link as the app will hold
 * it once it has taken the signals still waiting (listed before the settings are read).
 */
export function signalsFor(settingsFile: string, change: FollowChange): ShareSignal[] {
  const waiting = waitingSignals(join(dirname(settingsFile), FOLLOW_SIGNALS_FOLDER))
  return project(settingsFile, change, waiting)
}

/** S1: the settings file has a link not ended in the Collection `root`. */
function hasLinksIn(settingsFile: string, root: string): boolean {
  try {
    if (lstatSync(settingsFile).size > MAX_SETTINGS_BYTES) return false
    const wanted = normaliseRoot(root)
    return readRecords((JSON.parse(readFileSync(settingsFile, 'utf8')) as { sharingLinks?: unknown }).sharingLinks)
      .some((record) => !record.ended && normaliseRoot(record.root) === wanted)
  } catch { return false }
}

/** S2: `waiting` in generation order per link; a signal moves its link only from its own place and generation, so only consecutive generations chain. */
function project(settingsFile: string, change: FollowChange, waiting: readonly FollowSignal[]): ShareSignal[] {
  try {
    if (lstatSync(settingsFile).size > MAX_SETTINGS_BYTES) return []
    const root = normaliseRoot(change.root)
    const links = new Map<string, LinkPlace>()
    for (const record of readRecords((JSON.parse(readFileSync(settingsFile, 'utf8')) as { sharingLinks?: unknown }).sharingLinks)) {
      if (!record.ended && normaliseRoot(record.root) === root) links.set(record.shareId, { ...record, root })
    }
    const apply = (signal: ShareSignal): void => {
      const link = links.get(signal.shareId)
      if (!link || link.path !== signal.from || link.generation !== signal.generation || normaliseRoot(signal.root) !== root) return
      if ('trashed' in signal) { links.delete(signal.shareId); return }
      const next = followMove(link, root, signal.move.from, signal.move.to)
      if (next) links.set(signal.shareId, { ...next, generation: link.generation + 1 })
    }
    for (const signal of waiting) apply(signal)
    const made: ShareSignal[] = []
    for (const move of change.moved) {
      for (const link of [...links.values()]) {
        if (!followMove(link, root, move.from, move.to)) continue
        const signal: ShareSignal = { root: change.root, shareId: link.shareId, from: link.path, generation: link.generation, move: { from: move.from, to: move.to } }
        made.push(signal)
        apply({ ...signal, root })
      }
    }
    for (const link of [...links.values()]) {
      if (!endedByTrash(link, root, change.trashed)) continue
      made.push({ root: change.root, shareId: link.shareId, from: link.path, generation: link.generation, trashed: true })
      links.delete(link.shareId)
    }
    return made.filter((signal) => signal.generation <= MAX_GENERATION)
  } catch { return [] }
}

/**
 * The command line, after a move or a Trash it made itself, holding the Collection's owner lock (S1, S2).
 * Never throws: a signal that cannot be left is said in the returned line, and the move or the Trash stands.
 */
export async function leaveFollowSignal(settingsFiles: readonly string[], change: FollowChange): Promise<string | null> {
  let failed = false
  for (const file of settingsFiles) {
    // No link of this app's in the Collection: nothing written.
    if (!hasLinksIn(file, change.root)) continue
    const folder = join(dirname(file), FOLLOW_SIGNALS_FOLDER)
    try {
      await mkdir(folder, { recursive: true })
      for (const signal of signalsFor(file, change)) {
        await writeWhole(join(folder, signalName(signal)), JSON.stringify({ version: 3, ...signal }))
      }
    } catch { failed = true }
  }
  return failed ? 'WriteFlex could not be told about a shared piece this changed: open the Sharing page for it in WriteFlex to check its link.' : null
}

/** S3, as the publisher answers for one signal. */
export type SignalOutcome = 'applied' | 'stale' | 'held' | 'failed'
/** What a take removed without applying: never the link's id, a path or a token. */
export type SignalReport = { why: 'stale' | 'not-a-signal' | 'held-dropped'; generation: number | null }
export type TakeOptions = { dropHeld?: boolean; report?: (entry: SignalReport) => void }

/**
 * The app (S3): every signal left in `appData`. Answers how many were applied. `dropHeld` (S4): a signal
 * still held is removed and reported.
 */
export async function takeFollowSignals(appData: string, act: (signal: FollowSignal) => SignalOutcome | Promise<SignalOutcome>, options: TakeOptions = {}): Promise<number> {
  const folder = join(appData, FOLLOW_SIGNALS_FOLDER)
  const report = (entry: SignalReport): void => { try { options.report?.(entry) } catch { /* a report that failed changes nothing */ } }
  let names: string[]
  try {
    if (!(await lstat(folder)).isDirectory()) return 0
    names = (await readdir(folder)).filter((name) => SIGNAL_NAME.test(name)).sort().slice(0, MAX_SIGNALS)
  } catch { return 0 }
  const remove = async (name: string): Promise<void> => { await rm(join(folder, name), { force: true }).catch(() => {}) }
  const links = new Map<string, Array<{ name: string; signal: FollowSignal }>>()
  for (const name of names) {
    let signal: FollowSignal | null = null
    try {
      const stat = await lstat(join(folder, name))
      signal = stat.isFile() && stat.size <= MAX_SIGNAL_BYTES ? readSignal(await readFile(join(folder, name), 'utf8')) : null
    } catch { signal = null }
    if (!signal || !namedFor(name, signal)) { await remove(name); report({ why: 'not-a-signal', generation: null }); continue }
    links.set(signal.shareId, [...(links.get(signal.shareId) ?? []), { name, signal }])
  }
  let taken = 0
  for (const entries of links.values()) {
    const ordered = inOrder(entries)
    let done: number | null = null
    for (const [at, { name, signal }] of ordered.entries()) {
      // Rule 6: a second file for a generation already taken is stale.
      if (signal.generation === done) { await remove(name); report({ why: 'stale', generation: signal.generation }); continue }
      let outcome: SignalOutcome
      try { outcome = await act(signal) } catch { outcome = 'failed' }
      // R-F: not saved: this signal and every later one of this link wait for the next look.
      if (outcome === 'failed') break
      if (outcome === 'held') {
        // S4: at start, after the look, a signal still held (and every later one of its link) goes.
        if (options.dropHeld) {
          for (const later of ordered.slice(at)) { await remove(later.name); report({ why: 'held-dropped', generation: later.signal.generation }) }
        }
        break
      }
      done = signal.generation
      if (outcome === 'applied') taken += 1
      // Applied: its change is saved, so the file goes (a file that stays is stale at the next look).
      await remove(name)
      if (outcome === 'stale') report({ why: 'stale', generation: signal.generation })
    }
  }
  return taken
}

type FollowingPublisher = {
  applySignal(signal: ShareSignal): SignalOutcome
}

/** The app: tell the publisher what `signal` says (S3). */
export function applyFollowSignal(publisher: FollowingPublisher, signal: FollowSignal): SignalOutcome {
  return publisher.applySignal(signal)
}

/**
 * The app: take the signals now, and again whenever one is left while the app runs (S3). Takes never
 * overlap; a signal left during a take is taken by the next one.
 */
export function watchFollowSignals(appData: string, act: (signal: FollowSignal) => SignalOutcome | Promise<SignalOutcome>, options: { report?: (entry: SignalReport) => void } = {}): { take(options?: { dropHeld?: boolean }): Promise<number>; dispose(): void } {
  let running: Promise<number> = Promise.resolve(0)
  let taking = false
  let again = false
  let dropHeld = false
  const take = (asked: { dropHeld?: boolean } = {}): Promise<number> => {
    if (asked.dropHeld) dropHeld = true
    if (taking) { again = true; return running }
    taking = true
    running = (async () => {
      let taken = 0
      do {
        again = false
        const drop = dropHeld
        dropHeld = false
        taken += await takeFollowSignals(appData, act, { dropHeld: drop, ...(options.report ? { report: options.report } : {}) })
      } while (again)
      return taken
    })().finally(() => { taking = false })
    return running
  }
  let watcher: FSWatcher | null = null
  try {
    const folder = join(appData, FOLLOW_SIGNALS_FOLDER)
    mkdirSync(folder, { recursive: true })
    watcher = watch(folder, (_event, name) => { if (typeof name === 'string' && SIGNAL_NAME.test(name)) void take() })
    ;(watcher as { unref?: () => void }).unref?.()
  } catch { /* taken at the next start and on wake */ }
  return { take, dispose: () => { watcher?.close(); watcher = null } }
}

/** S4, at start: the signals taken, every share looked at (R-D), then any signal still held removed and reported. */
export async function takeAtStart(signals: { take(options?: { dropHeld?: boolean }): Promise<number> }, look: () => Promise<void>): Promise<void> {
  await signals.take().catch(() => 0)
  await look().catch(() => {})
  await signals.take({ dropHeld: true }).catch(() => 0)
}
