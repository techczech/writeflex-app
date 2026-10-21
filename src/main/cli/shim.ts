/**
 * The installed `writeflex` shim: a small shell script that finds WriteFlex by bundle identifier at run
 * time, so moving or updating the app does not break it, and runs the app's own binary in Node mode on
 * the bundled command-line entry. `generateShim` states which copy it runs when there are several. No Electron dependency; the Settings button reaches this through one
 * IPC handler.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { resolveAppVariant } from '../app-variant'

export const STABLE_BUNDLE_ID = 'net.dominiklukes.writeflex'
export const BETA_BUNDLE_ID = 'net.dominiklukes.writeflex.beta'
/** Second line of every shim we write; an existing file without it is not ours to replace. */
export const SHIM_MARKER = '# writeflex command-line shim (installed by WriteFlex)'

export function bundleIdentifierFor(packageMetadata: unknown): string {
  return resolveAppVariant(packageMetadata).versionLabelSuffix === ' beta' ? BETA_BUNDLE_ID : STABLE_BUNDLE_ID
}

const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/** Test seams for the app lookup; production callers pass nothing. */
export type ShimLookup = {
  /** The two folders searched first, in order of preference (absolute paths). */
  preferredDirs?: [string, string]
  /** Shell command printing one candidate bundle path per line, in place of Spotlight. Every program in it is named by absolute path. */
  finder?: string
  /** The suffix of a candidate's folder name in the two preferred folders, in place of `.app`: a
   *  test's stand-in folders are then not app bundles to the system, and none is ever made or run. */
  bundleSuffix?: string
}

/** The one argument that makes the shim say which copy of the app it would run, and run nothing. */
export const WHICH_APP_FLAG = '--which-app'

/**
 * The script text. `bundleId` is the only app identity in it; no install path appears.
 *
 * Which copy runs, since several bundles can carry the identifier (preview builds in Documents, a
 * copy in Downloads): one in /Applications, else one in ~/Applications; both are looked in directly,
 * so this works with Spotlight off. A copy anywhere else is used only when Spotlight knows exactly
 * one and neither Applications folder has any, and is then named on standard error. Wherever the
 * choice falls, more than one copy there is refused and listed (exit 126) rather than guessed at. A
 * candidate counts only if its own Info.plist carries the identifier (Spotlight's index can be
 * stale); copies in a Trash never count.
 *
 * FINDING THE APP AND RUNNING IT ARE TWO STEPS. `writeflex --which-app` (that argument alone) does
 * the first and prints the bundle it chose, one line on standard output, and runs nothing. It is how
 * a person checks which copy the command belongs to, and how the selection is tested without any app
 * being made or started.
 *
 * NOTHING THE SCRIPT RUNS IS LOOKED UP ON `PATH`. Every external program is named by its absolute
 * path: `/bin/sh` (the interpreter line), `/usr/libexec/PlistBuddy` (reads a bundle's identifier and
 * its executable's name), `/usr/bin/mdfind` (Spotlight), and the app's own executable inside the
 * bundle chosen. Everything else it uses (`echo`, `printf`, `[`, `case`, `exec`, `exit`) is built
 * into the shell. A `PATH` with a writable folder ahead of `/usr/bin` therefore changes nothing.
 */
export function generateShim(bundleId: string, lookup: ShimLookup = {}): string {
  const first = lookup.preferredDirs ? shellQuote(lookup.preferredDirs[0]) : `'/Applications'`
  const second = lookup.preferredDirs ? shellQuote(lookup.preferredDirs[1]) : '"$HOME/Applications"'
  const finder = lookup.finder ?? `/usr/bin/mdfind "kMDItemCFBundleIdentifier == '$BUNDLE_ID'"`
  const suffix = lookup.bundleSuffix ?? '.app'
  if (!/^\.[A-Za-z0-9-]+$/.test(suffix)) throw new Error('A bundle suffix is a dot and letters, digits or hyphens.')
  return `#!/bin/sh
${SHIM_MARKER}
BUNDLE_ID='${bundleId}'
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
# The two Applications folders are looked in directly; Spotlight adds every other copy it knows.
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
  echo "writeflex: cannot find WriteFlex ($BUNDLE_ID). Install or open the app once, then try again." >&2
  exit 127
fi
if [ "$count" -gt 1 ]; then
  echo "writeflex: several copies of WriteFlex ($BUNDLE_ID) exist $where, so none was run. Keep one in $PREFERRED_FIRST and remove the others. The copies:" >&2
  printf '%s' "$copies" >&2
  exit 126
fi
app="\${copies%?}"
if [ "$first_count" -eq 0 ] && [ "$second_count" -eq 0 ]; then
  echo "writeflex: using the copy of WriteFlex at $app (none is installed in $PREFERRED_FIRST or $PREFERRED_SECOND)." >&2
fi
# Asked only which copy it would run: say so and run nothing.
if [ "$#" -eq 1 ] && [ "$1" = '${WHICH_APP_FLAG}' ]; then
  printf '%s\\n' "$app"
  exit 0
fi
exe=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null)
[ -n "$exe" ] || { echo "writeflex: $app has no executable name." >&2; exit 127; }
ELECTRON_RUN_AS_NODE=1 exec "$app/Contents/MacOS/$exe" "$app/Contents/Resources/app.asar/out/main/writeflex-cli.js" "$@"
`
}

export type InstallResult =
  | { ok: true; path: string; changed: boolean; onPath: boolean; message: string }
  | { ok: false; message: string }

/**
 * Write the shim to `<dir>/writeflex` (default `~/.local/bin`, which needs no administrator rights).
 * Installing again is harmless: identical content is left untouched and reported as already installed;
 * an older shim of ours is replaced; a file of that name that is not ours is never overwritten.
 */
export async function installShim(opts: { bundleId: string; dir?: string; pathEnv?: string }): Promise<InstallResult> {
  const dir = opts.dir ?? join(homedir(), '.local', 'bin')
  const target = join(dir, 'writeflex')
  const wanted = generateShim(opts.bundleId)
  try {
    const existing = await readFile(target, 'utf8').catch(() => null)
    if (existing !== null && !existing.includes(SHIM_MARKER)) {
      return { ok: false, message: `${target} already exists and was not installed by WriteFlex, so it was left alone.` }
    }
    const onPath = (opts.pathEnv ?? process.env.PATH ?? '').split(delimiter).includes(dir)
    const note = onPath ? '' : ` ${dir} is not on your PATH yet; add it to use "writeflex" from any folder.`
    if (existing === wanted) return { ok: true, path: target, changed: false, onPath, message: `The command-line tool is already installed at ${target}.${note}` }
    await mkdir(dir, { recursive: true })
    const staged = `${target}.${process.pid}.tmp`
    await writeFile(staged, wanted, { mode: 0o755 })
    await chmod(staged, 0o755)
    await rename(staged, target)
    return { ok: true, path: target, changed: true, onPath, message: `Installed the command-line tool at ${target}.${note}` }
  } catch (error) {
    return { ok: false, message: `Could not install the command-line tool: ${error instanceof Error ? error.message : String(error)}` }
  }
}
