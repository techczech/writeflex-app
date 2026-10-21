import { realpathSync, statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { processScoutEnvironment, resolveScoutBinary, runScout, type ScoutEnvironment, type ScoutRunOptions } from './scout'
import { CAPTURE_KINDS, type CaptureKind } from '../shared/research-capture'
import { folioContaining } from './folio-place'
import { assertRelativeWorkspacePath, type Workspace } from './workspace'
import { classifyDocumentPath } from './document-path'
import { WritesPausedError } from './collection-write-gate'

/**
 * "Capture to research": the one main-process verb behind the palette sheet, the agent capability
 * `research.capture` and the `writeflex capture` command. It never writes a file itself: it spawns
 * `scout capture … --by app:writeflex --json -` (the body on standard input) and reports what scout
 * printed. Scout names the file, copies any artefact, appends the manifest line and rebuilds the index
 * of the corpus that holds the project.
 *
 * A project is a Piece's folder, or the Folio folder when the Piece is in a Folio; the research folder
 * is `<project>/research/` (a support folder, so it stays out of the piece list).
 */

export { CAPTURE_KINDS, type CaptureKind } from '../shared/research-capture'

export type CaptureInput = {
  /** Absolute folder: the open Piece's folder, or the Folio folder. */
  projectDir: string
  title: string
  kind: CaptureKind
  prompt?: string
  /** `scout:<passage id>`, a URL or `file:<path>`, as scout takes them; one `--source` each. */
  sources?: string[]
  artefact?: string
  body: string
  /** When given, the project's REAL path must lie inside this folder's real path, or nothing is captured. */
  withinRoot?: string
  /**
   * When given with `artefact`, a relative artefact is read against this folder, and the artefact's REAL path must be a
   * regular file inside this folder's real path, not hidden, or nothing is captured. The real path (never the string
   * given) is what scout is given. Without it the artefact is passed through as given.
   */
  artefactWithin?: string
}

/** What scout reported. `file` is absolute. */
export type CaptureSuccess = { ok: true; file: string; corpus: string | null; indexed: boolean }

export type CaptureErrorCode = 'invalid' | 'scout-missing' | 'not-a-directory' | 'capture-failed' | 'unreadable-output' | 'writes-paused'
/**
 * `message` is a plain sentence chosen by the class of failure and never carries scout's own text.
 * `detail` is that text (stderr, an error message), for the log in main only: `captureInWorkspace` strips it
 * before anything is returned to the window, the agent or the command line.
 */
export type CaptureFailure = { ok: false; code: CaptureErrorCode; message: string; detail?: string }
export type CaptureResult = CaptureSuccess | CaptureFailure

/**
 * `afterValidated` (a test seam) runs between the project being judged and the last look before scout is spawned.
 * `beforeSpawn` is the last step before the spawn, after the final canonical-path check: it throws to refuse
 * (the write gate, then the command line's owner-lock check).
 */
export type CaptureSeams = { afterValidated?: () => Promise<void>; beforeSpawn?: () => void | Promise<void> }

const CAPTURE_TIMEOUT_MS = 30_000
const TIMED_OUT = 'Filing the capture took too long and was stopped, so it may not have been filed.'
const fail = (code: CaptureErrorCode, message: string, detail?: string): CaptureFailure => ({ ok: false, code, message, ...(detail ? { detail } : {}) })

const insideFolder = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`)

/**
 * The first top-level JSON object in scout's output: a brace-balanced scan from the first `{` (strings and escapes
 * respected). Only when that finds no balanced object is the whole output tried as JSON. Anything after is ignored.
 */
export function firstJsonObject(stdout: string): Record<string, unknown> | null {
  const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const start = stdout.indexOf('{')
  if (start >= 0) {
    let depth = 0
    let inString = false
    for (let index = start; index < stdout.length; index += 1) {
      const char = stdout[index]
      if (inString) {
        if (char === '\\') index += 1
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === '{') depth += 1
      else if (char === '}' && (depth -= 1) === 0) {
        try {
          const value: unknown = JSON.parse(stdout.slice(start, index + 1))
          if (isObject(value)) return value
        } catch { /* not JSON: fall back below */ }
        break
      }
    }
  }
  try {
    const whole: unknown = JSON.parse(stdout)
    if (isObject(whole)) return whole
  } catch { /* none */ }
  return null
}

/** The class of a scout failure, from its own words; the sentence for the writer never contains them. */
function failureSentence(stderr: string): string {
  if (/read-only|permission denied|not writable|EACCES|EROFS|EPERM/i.test(stderr)) return 'The research folder is not writable, so nothing was captured.'
  return 'Scout could not file this capture, so nothing was captured.'
}

/** `--flag value`; the `--flag=value` form when the value begins with a dash, so it is never read as another flag. */
function valueFlag(flag: string, value: string): string[] {
  return value.startsWith('-') ? [`${flag}=${value}`] : [flag, value]
}

/** The argv after the binary name. Exported so the order the contract fixes is checked in one place. */
export function captureArgv(input: CaptureInput): string[] {
  return [
    'capture',
    ...valueFlag('--project', input.projectDir),
    ...valueFlag('--kind', input.kind),
    ...valueFlag('--title', input.title),
    ...(input.prompt?.trim() ? valueFlag('--prompt', input.prompt) : []),
    ...(input.sources ?? []).filter((source) => source.trim() !== '').flatMap((source) => valueFlag('--source', source)),
    ...(input.artefact?.trim() ? valueFlag('--artefact', input.artefact) : []),
    '--by', 'app:writeflex',
    '--json',
    '-',
  ]
}

function statSyncIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export async function captureResearch(
  input: CaptureInput,
  env: ScoutEnvironment = processScoutEnvironment(),
  options: ScoutRunOptions = {},
  seams: CaptureSeams = {},
): Promise<CaptureResult> {
  if (!(CAPTURE_KINDS as readonly string[]).includes(input.kind)) return fail('invalid', `“${String(input.kind)}” is not a kind of research. Use one of: ${CAPTURE_KINDS.join(', ')}.`)
  if (typeof input.title !== 'string' || input.title.trim() === '') return fail('invalid', 'Give the capture a title.')
  if (typeof input.body !== 'string') return fail('invalid', 'The capture has no text.')
  const notFound = fail('not-a-directory', 'The folder this belongs to could not be found, so nothing was captured.')
  if (typeof input.projectDir !== 'string' || !isAbsolute(input.projectDir)) return notFound
  // The project is judged by its canonical path, and that path (never the string given) is what scout is given.
  const canonicalProject = async (): Promise<string | CaptureFailure> => {
    let real: string
    try { real = await realpath(input.projectDir) } catch { return notFound }
    if (!isDirectory(real)) return notFound
    if (input.withinRoot !== undefined) {
      let realRoot: string
      try { realRoot = await realpath(input.withinRoot) } catch { return notFound }
      if (!insideFolder(real, realRoot)) return fail('not-a-directory', 'The folder this belongs to is not inside this Workspace, so nothing was captured.')
    }
    return real
  }
  const checked = await canonicalProject()
  if (typeof checked !== 'string') return checked
  // The artefact is judged by its canonical path too, the same way as the project; null when none is given.
  const canonicalArtefact = async (): Promise<string | CaptureFailure | null> => {
    if (input.artefact === undefined || input.artefact.trim() === '' || input.artefactWithin === undefined) return null
    const refused = fail('invalid', `The artefact ${input.artefact} is not a file in this Workspace, so nothing was captured.`)
    try {
      const real = await realpath(resolve(input.artefactWithin, input.artefact))
      const realRoot = await realpath(input.artefactWithin)
      if (!statSyncIsFile(real) || !insideFolder(real, realRoot) || classifyDocumentPath(realRoot, realRoot, relative(realRoot, real), 'file') !== 'document') return refused
      return real
    } catch {
      return refused
    }
  }
  const artefactChecked = await canonicalArtefact()
  if (artefactChecked !== null && typeof artefactChecked !== 'string') return artefactChecked
  const binary = resolveScoutBinary(env)
  if (!binary) return fail('scout-missing', 'Capturing to research needs the scout command-line tool, and it is not installed. Nothing was captured.')
  await seams.afterValidated?.()
  // The last look before spawning: the folder must still be the same real folder, inside the Workspace.
  const again = await canonicalProject()
  if (again !== checked) return typeof again === 'string' ? fail('not-a-directory', 'The folder changed while the capture was being prepared, so nothing was captured.') : again
  const artefactAgain = await canonicalArtefact()
  if (artefactAgain !== null && typeof artefactAgain !== 'string') return artefactAgain
  if (artefactAgain !== artefactChecked) return fail('invalid', 'The artefact changed while the capture was being prepared, so nothing was captured.')
  const project = checked
  // The one ordered sequence before the spawn: the canonical checks above, then the gate and owner lock; nothing awaited in between.
  await seams.beforeSpawn?.()
  let outcome
  try {
    outcome = await runScout(binary, captureArgv({ ...input, projectDir: project, ...(artefactChecked !== null ? { artefact: artefactChecked } : {}) }), { timeoutMs: CAPTURE_TIMEOUT_MS, timeoutMessage: TIMED_OUT, ...options, input: input.body })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return text === TIMED_OUT || text === options.timeoutMessage ? fail('capture-failed', TIMED_OUT) : fail('capture-failed', 'Scout could not be run, so nothing was captured.', text)
  }
  const stderr = outcome.stderr.trim() || undefined
  if (outcome.code !== 0) return fail('capture-failed', failureSentence(outcome.stderr), stderr ?? `exit code ${outcome.code}`)
  const record = firstJsonObject(outcome.stdout)
  if (!record) return fail('unreadable-output', 'Scout filed the capture but its answer could not be read, so the file is not shown.', stderr)
  if (typeof record.file !== 'string' || record.file === '') {
    return fail('unreadable-output', 'Scout filed the capture but did not say where, so the file is not shown.', stderr)
  }
  return {
    ok: true,
    file: isAbsolute(record.file) ? record.file : resolve(project, record.file),
    corpus: typeof record.corpus === 'string' ? record.corpus : null,
    indexed: record.indexed === true,
  }
}

/**
 * The project folder for a Workspace-relative path. A folder is its own project (a Folio folder, a Folder
 * Piece); a file belongs to the Folio it is in, else to its own folder. Throws for a path outside the
 * Workspace or one that does not exist.
 */
export async function captureProjectFor(workspace: Workspace, path: string): Promise<{ dir: string; absolute: string; folio: boolean }> {
  if (path !== '') assertRelativeWorkspacePath(path)
  const absolute = path === '' ? workspace.root : workspace.absolute(path)
  const refuseUnlessVisible = (kind: 'file' | 'folder'): void => {
    if (path === '') return
    const verdict = workspace.classifyPath(path, kind)
    if (verdict === 'outside') throw new Error(`${path} is outside the Workspace.`)
    if (verdict === 'hidden') throw new Error(`${path} is in a folder the app keeps for itself, so nothing can be captured there.`)
  }
  if (isDirectory(absolute)) {
    refuseUnlessVisible('folder')
    return { dir: path, absolute, folio: false }
  }
  refuseUnlessVisible('file')
  if (!statSyncIsFile(absolute)) throw new Error(`${path} does not exist.`)
  const folio = await folioContaining(workspace, path)
  if (folio) return { dir: folio.dir, absolute: folio.dir === '' ? workspace.root : workspace.absolute(folio.dir), folio: true }
  const slash = path.lastIndexOf('/')
  const dir = slash < 0 ? '' : path.slice(0, slash)
  return { dir, absolute: dir === '' ? workspace.root : workspace.absolute(dir), folio: false }
}

export type WorkspaceCaptureInput = Omit<CaptureInput, 'projectDir' | 'withinRoot'> & {
  /** Workspace-relative: the open Piece's file, or a folder (the Folio folder, a Folder Piece). */
  project: string
}
export type WorkspaceCaptureResult = (Omit<CaptureSuccess, 'file'> & { file: string; project: string }) | CaptureFailure

export type WorkspaceCaptureHooks = {
  seams?: CaptureSeams
  /** Told the Workspace-relative paths scout wrote (the new file and the folder's manifest), so the caller can register them as touched. */
  wrote?: (paths: string[]) => void
  /** Runs last before scout is spawned (after the write gate); throws to refuse. The command line asks the owner lock here. */
  beforeSpawn?: () => void | Promise<void>
}

/**
 * The verb as the app calls it (the sheet, the agent capability and the command line all come here): asks the
 * Collection write gate first and again inside the Workspace's write turn, resolves the project inside the
 * Workspace, and reports the filed path Workspace-relative. A refusal by the gate is a `writes-paused` failure
 * carrying the gate's own sentence; scout is not spawned. Scout's own text is logged and never returned.
 */
export async function captureInWorkspace(
  workspace: Workspace,
  input: WorkspaceCaptureInput,
  env?: ScoutEnvironment,
  options?: ScoutRunOptions,
  hooks: WorkspaceCaptureHooks = {},
): Promise<WorkspaceCaptureResult> {
  try {
    workspace.assertWritable()
    return await workspace.exclusiveAll(async () => {
      workspace.assertWritable() // asked again inside the turn: it may have waited
      return captureUnderGate(workspace, input, env, options, hooks)
    })
  } catch (error) {
    if (error instanceof WritesPausedError) return fail('writes-paused', error.message)
    throw error
  }
}

async function captureUnderGate(
  workspace: Workspace,
  input: WorkspaceCaptureInput,
  env: ScoutEnvironment | undefined,
  options: ScoutRunOptions | undefined,
  hooks: WorkspaceCaptureHooks,
): Promise<WorkspaceCaptureResult> {
  let project
  try {
    project = await captureProjectFor(workspace, input.project)
  } catch (error) {
    return fail('not-a-directory', error instanceof Error ? error.message : String(error))
  }
  const { project: _project, artefact, ...rest } = input
  // An artefact is copied INTO the research folder, so it may only be a visible file of this Workspace: a capture
  // (from the agent or the command line) can never pull a file from elsewhere on the disk into it. captureResearch
  // judges its real path (artefactWithin) here and again at the last look before the spawn, as it does the project.
  if (artefact?.trim()) {
    if (artefact.trim() === '-') return fail('invalid', 'An artefact must be a file in this Workspace, so nothing was captured.')
    const given = isAbsolute(artefact) ? relative(workspace.root, artefact) : artefact
    const verdict = workspace.classifyPath(given, 'file')
    if (verdict === 'outside' || verdict === 'hidden' || !statSyncIsFile(workspace.absolute(given))) {
      return fail('invalid', `The artefact ${artefact} is not a file in this Workspace, so nothing was captured.`)
    }
  }
  const result = await captureResearch(
    { ...rest, projectDir: project.absolute, withinRoot: workspace.root, ...(artefact?.trim() ? { artefact, artefactWithin: workspace.root } : {}) },
    env, options,
    {
      ...hooks.seams,
      beforeSpawn: async () => {
        await hooks.seams?.beforeSpawn?.()
        workspace.assertWritable() // the gate, immediately before the spawn
        await hooks.beforeSpawn?.()
      },
    },
  )
  if (!result.ok) {
    if (result.detail) console.warn(`[research-capture] ${result.code}: ${result.detail}`)
    const { detail: _detail, ...plain } = result
    return plain
  }
  const inside = relativeToWorkspace(workspace, result.file)
  const file = inside ?? result.file
  if (inside !== null) {
    const slash = inside.lastIndexOf('/')
    hooks.wrote?.([inside, `${slash < 0 ? '' : `${inside.slice(0, slash)}/`}_manifest.jsonl`])
  }
  return { ...result, file, project: project.dir }
}

/** `file` relative to the Workspace root (as typed, or in its canonical spelling), or null when it is not inside. */
function relativeToWorkspace(workspace: Workspace, file: string): string | null {
  const roots = [workspace.root]
  try { roots.push(realpathSync(workspace.root)) } catch { /* the root is gone: the typed one stands */ }
  for (const root of roots) {
    const inside = relative(root, file)
    if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) return inside.split('\\').join('/')
  }
  return null
}
