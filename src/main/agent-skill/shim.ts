// The command-line shim: a small shell script, `~/.local/bin/<command>`, that finds the app by bundle
// identifier at run time (so moving or updating the app does not break it) and runs the app's own binary
// with the arguments it was given. Modelled on WriteFlex's marker-guarded installer: installing again is
// harmless, an older shim of ours is replaced, a file of that name without our marker is never touched.
// Nothing the script runs is looked up on PATH (absolute /usr/libexec/PlistBuddy, /usr/bin/mdfind).
// macOS and other Unix only; Windows reports `unsupported`. No Electron import; no app specifics.
import { randomBytes } from 'node:crypto'
import { chmod, link as hardLink, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, join, relative, sep } from 'node:path'
import type { CliRow } from '../../shared/agent-skill/types.ts'

export interface ShimSpec {
  /** The command the person and the agent type: `talkweaver`. */
  command: string
  appName: string
  bundleId: string
  /**
   * Path inside the app bundle of a Node script the command runs: the app's own binary is then started in Node
   * mode (ELECTRON_RUN_AS_NODE=1) on that script (WriteFlex's command line). Absent: the binary itself runs with the arguments.
   */
  nodeEntry?: string
  /** Say on standard error which copy runs when it is found outside both Applications folders (WriteFlex's shim does). */
  announceElsewhere?: boolean
}

/** Second line of every shim we write; an existing file without it is not ours to replace. */
export const shimMarker = (spec: ShimSpec): string => `# ${spec.command} command-line shim (installed by ${spec.appName})`

const SAFE = /^[A-Za-z0-9._-]+$/
const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

export interface ShimLookup {
  /** Test seams: the two folders searched first, a stand-in for Spotlight, and the folder suffix. */
  preferredDirs?: [string, string]
  finder?: string
  bundleSuffix?: string
}

export const WHICH_APP_FLAG = '--which-app'

export function generateShim(spec: ShimSpec, lookup: ShimLookup = {}): string {
  if (!SAFE.test(spec.command) || !/^[A-Za-z0-9.-]+$/.test(spec.bundleId)) throw new Error('A command name and bundle identifier are letters, digits and . _ -')
  const first = lookup.preferredDirs ? shellQuote(lookup.preferredDirs[0]) : `'/Applications'`
  const second = lookup.preferredDirs ? shellQuote(lookup.preferredDirs[1]) : '"$HOME/Applications"'
  const finder = lookup.finder ?? `/usr/bin/mdfind "kMDItemCFBundleIdentifier == '$BUNDLE_ID'"`
  const suffix = lookup.bundleSuffix ?? '.app'
  if (!/^\.[A-Za-z0-9-]+$/.test(suffix)) throw new Error('A bundle suffix is a dot and letters, digits or hyphens.')
  if (spec.nodeEntry !== undefined && (!/^[A-Za-z0-9._/-]+$/.test(spec.nodeEntry) || spec.nodeEntry.split('/').includes('..') || spec.nodeEntry.startsWith('/'))) throw new Error('A node entry is a relative path of letters, digits and . _ - /')
  const name = shellQuote(spec.appName).slice(1, -1)
  const announce = spec.announceElsewhere
    ? `if [ "$first_count" -eq 0 ] && [ "$second_count" -eq 0 ]; then
  echo "${spec.command}: using the copy of ${name} at $app (none is installed in $PREFERRED_FIRST or $PREFERRED_SECOND)." >&2
fi
`
    : ''
  const run = spec.nodeEntry === undefined
    ? 'exec "$app/Contents/MacOS/$exe" "$@"'
    : `ELECTRON_RUN_AS_NODE=1 exec "$app/Contents/MacOS/$exe" "$app/${spec.nodeEntry}" "$@"`
  return `#!/bin/sh
${shimMarker(spec)}
BUNDLE_ID='${spec.bundleId}'
PREFERRED_FIRST=${first}
PREFERRED_SECOND=${second}
first=""; first_count=0
second=""; second_count=0
elsewhere=""; elsewhere_count=0
seen="
"
consider() {
  [ -d "$1" ] || return 0
  case "$1" in */.Trash/*|*/.Trashes/*) return 0 ;; esac
  case "$seen" in *"
$1
"*) return 0 ;; esac
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null)" = "$BUNDLE_ID" ] || return 0
  seen="$seen$1
"
  case "$1" in
    "$PREFERRED_FIRST"/*) first="$first$1
"; first_count=$((first_count + 1)) ;;
    "$PREFERRED_SECOND"/*) second="$second$1
"; second_count=$((second_count + 1)) ;;
    *) elsewhere="$elsewhere$1
"; elsewhere_count=$((elsewhere_count + 1)) ;;
  esac
}
for candidate in "$PREFERRED_FIRST"/*${suffix} "$PREFERRED_SECOND"/*${suffix}; do consider "$candidate"; done
found=$(${finder} 2>/dev/null)
IFS='
'
set -f
for candidate in $found; do consider "$candidate"; done
set +f
unset IFS
if [ "$first_count" -gt 0 ]; then
  copies="$first"; count=$first_count; where="in $PREFERRED_FIRST"
elif [ "$second_count" -gt 0 ]; then
  copies="$second"; count=$second_count; where="in $PREFERRED_SECOND"
elif [ "$elsewhere_count" -gt 0 ]; then
  copies="$elsewhere"; count=$elsewhere_count; where="outside $PREFERRED_FIRST and $PREFERRED_SECOND"
else
  echo "${spec.command}: cannot find ${name} ($BUNDLE_ID). Install or open the app once, then try again." >&2
  exit 127
fi
if [ "$count" -gt 1 ]; then
  echo "${spec.command}: several copies of ${name} ($BUNDLE_ID) exist $where, so none was run. Keep one in $PREFERRED_FIRST and remove the others. The copies:" >&2
  printf '%s' "$copies" >&2
  exit 126
fi
app="\${copies%?}"
${announce}if [ "$#" -eq 1 ] && [ "$1" = '${WHICH_APP_FLAG}' ]; then
  printf '%s\\n' "$app"
  exit 0
fi
exe=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null)
[ -n "$exe" ] || { echo "${spec.command}: $app has no executable name." >&2; exit 127; }
${run}
`
}

export interface ShimOptions {
  spec: ShimSpec; home: string; platform: NodeJS.Platform; pathEnv?: string; dir?: string; lookup?: ShimLookup
  /** Test seam: runs after the new command is staged and before it is put in place. */
  beforeCommit?: () => Promise<void> | void
  /** Test seam: runs after the last look at the destination, right before the commit. */
  afterCheck?: () => Promise<void> | void
}

const targetOf = (o: ShimOptions): { dir: string; path: string } => {
  const dir = o.dir ?? join(o.home, '.local', 'bin')
  return { dir, path: join(dir, o.spec.command) }
}

const row = (o: ShimOptions, state: CliRow['state'], message: string, onPath: boolean): CliRow =>
  ({ command: o.spec.command, state, path: targetOf(o).path, onPath, message })

/**
 * The first link on the way to the command's folder: the folder itself and every parent below HOME (the
 * folder alone when it is outside HOME). A command is never written through a link.
 */
async function linkOnTheWay(o: ShimOptions): Promise<string | null> {
  const { dir } = targetOf(o)
  const rel = relative(o.home, dir)
  const inside = rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep)
  const chain: string[] = []
  if (inside) { let cur = o.home; for (const part of rel.split(sep)) { cur = join(cur, part); chain.push(cur) } } else chain.push(dir)
  for (const p of chain) {
    try { if ((await lstat(p)).isSymbolicLink()) return p } catch { return null /* nothing further exists yet */ }
  }
  return null
}

const blocked = (o: ShimOptions, via: string, onPath: boolean): CliRow =>
  row(o, 'blocked', `${via} is a link, so the command-line tool was not written there. Make it a real folder, or add ${o.spec.command} yourself.`, onPath)

async function readExisting(path: string): Promise<{ text: string | null; link: boolean }> {
  try {
    const s = await lstat(path)
    if (s.isSymbolicLink() || !s.isFile()) return { text: null, link: true }
    return { text: await readFile(path, 'utf8'), link: false }
  } catch { return { text: null, link: false } }
}

export async function shimStatus(o: ShimOptions): Promise<CliRow> {
  const { dir, path } = targetOf(o)
  const onPath = (o.pathEnv ?? '').split(delimiter).includes(dir)
  if (o.platform === 'win32') return row(o, 'unsupported', 'The command-line tool is not available on Windows yet.', false)
  const via = await linkOnTheWay(o)
  if (via) return blocked(o, via, onPath)
  const { text, link } = await readExisting(path)
  if (link) return row(o, 'kept', `${path} is not ours, so it was left alone.`, onPath)
  if (text === null) return row(o, 'not-installed', 'The command-line tool is not installed.', onPath)
  if (!text.includes(shimMarker(o.spec))) return row(o, 'kept', `${path} already exists and was not installed by ${o.spec.appName}, so it was left alone.`, onPath)
  return row(o, 'installed', `The command-line tool is installed at ${path}.`, onPath)
}

/**
 * Write the shim. Identical content is left untouched; an older shim of ours is replaced; a file or link of
 * that name that is not ours is never written to. A failed write is a state, not an exception.
 */
export async function installShim(o: ShimOptions): Promise<CliRow> {
  const { dir, path } = targetOf(o)
  const onPath = (o.pathEnv ?? '').split(delimiter).includes(dir)
  if (o.platform === 'win32') return row(o, 'unsupported', 'The command-line tool is not available on Windows yet.', false)
  try {
    const wanted = generateShim(o.spec, o.lookup)
    const via = await linkOnTheWay(o)
    if (via) return blocked(o, via, onPath)
    const { text, link } = await readExisting(path)
    if (link) return row(o, 'kept', `${path} is a link or not a plain file, so it was left alone.`, onPath)
    if (text !== null && !text.includes(shimMarker(o.spec))) return row(o, 'kept', `${path} already exists and was not installed by ${o.spec.appName}, so it was left alone.`, onPath)
    const note = onPath ? '' : ` ${dir} is not on your PATH yet; add it to use "${o.spec.command}" from any folder.`
    if (text === wanted) return row(o, 'installed', `The command-line tool is already installed at ${path}.${note}`, onPath)
    await mkdir(dir, { recursive: true })
    const after = await linkOnTheWay(o)
    if (after) return blocked(o, after, onPath)
    const dirStat = await stat(dir)
    // Path-based cleanup is only safe while the folder is the one it was at the start.
    const held = async (): Promise<boolean> => {
      try {
        const s = await lstat(dir)
        return !s.isSymbolicLink() && s.dev === dirStat.dev && s.ino === dirStat.ino && (await linkOnTheWay(o)) === null
      } catch { return false }
    }
    const left: string[] = []
    const tidy = async (item: string): Promise<void> => { if (await held()) await rm(item, { force: true }).catch(() => {}); else left.push(item) }
    const leftNote = (): string => (left.length ? ` A temporary file was left at ${left.join(', ')}.` : '')
    const staged = join(dir, `.${o.spec.command}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
    let outcome: CliRow | null = null
    try {
      await writeFile(staged, wanted, { mode: 0o755, flag: 'wx' })
      await chmod(staged, 0o755)
      await o.beforeCommit?.()
      // Look again at the last moment: a command put there since the first look is not ours to overwrite.
      const gate = await linkOnTheWay(o)
      if (gate) outcome = blocked(o, gate, onPath)
      else if (!(await held())) outcome = row(o, 'blocked', `${dir} changed while the command-line tool was being installed, so nothing was written.`, onPath)
      else {
        const again = await readExisting(path)
        if (again.link) outcome = row(o, 'kept', `${path} is a link or not a plain file, so it was left alone.`, onPath)
        else if (again.text !== text) outcome = row(o, 'kept', `${path} changed while the command-line tool was being installed, so it was left alone.`, onPath)
      }
      if (!outcome) {
        await o.afterCheck?.()
        if (!(await held())) outcome = row(o, 'blocked', `${dir} changed while the command-line tool was being installed, so nothing was written.`, onPath)
      }
      if (!outcome && text === null) {
        // Nothing there: a hard link fails if anything appears first, where rename() would replace it.
        try { await hardLink(staged, path) } catch (e) {
          if ((e as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw e
          outcome = row(o, 'kept', `${path} appeared while the command-line tool was being installed, so it was left alone.`, onPath)
        }
      } else if (!outcome) {
        // Never a replacing rename: move the old one aside, check what actually moved, then link the new one in.
        const aside = join(dir, `.${o.spec.command}.old-${process.pid}-${randomBytes(4).toString('hex')}`)
        await rename(path, aside)
        const moved = await readExisting(aside)
        if (moved.link || moved.text === null || !moved.text.includes(shimMarker(o.spec))) {
          try { await hardLink(aside, path); await tidy(aside); outcome = row(o, 'blocked', `${path} changed while the command-line tool was being installed, so it was left alone.`, onPath) } catch {
            left.push(aside)
            outcome = row(o, 'blocked', `${path} changed while the command-line tool was being installed. The file that was there is at ${aside}.`, onPath)
          }
        } else {
          try { await hardLink(staged, path); await tidy(aside) } catch (e) {
            if ((e as NodeJS.ErrnoException | null)?.code !== 'EEXIST') {
              try { await hardLink(aside, path); await tidy(aside) } catch { left.push(aside) }
              throw e
            }
            // Something new appeared in the gap: keep it, and put our old one back only if the place is free.
            try { await hardLink(aside, path); await tidy(aside) } catch { left.push(aside) }
            outcome = row(o, 'blocked', `${path} appeared while the command-line tool was being installed, so it was left alone.`, onPath)
          }
        }
      }
    } finally { await tidy(staged) }
    if (outcome) return left.length ? { ...outcome, message: outcome.message + leftNote() } : outcome
    return row(o, 'installed', `Installed the command-line tool at ${path}.${note}`, onPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return row(o, 'failed', code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? `The command-line tool could not be written to ${dir}: that folder is read-only.` : `The command-line tool could not be installed.`, onPath)
  }
}

/** Replace the shim only when it is ours and differs (refresh on update); never creates one. */
export async function refreshShim(o: ShimOptions): Promise<CliRow | null> {
  const status = await shimStatus(o)
  return status.state === 'installed' ? installShim(o) : null
}
