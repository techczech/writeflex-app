import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { APP_UNDO_KIND, HANDLED_KIND, JOURNAL_KIND, UNDELIVERED_KIND, recordsDir } from '../../src/main/collection-records'
import { runCli, type CliEnv } from '../../src/main/cli/run'
import type { WriteEnv } from '../../src/main/cli/write-access'
import { MANIFEST_NAME } from '../../src/main/folio'

/**
 * A temporary Collection for the command line's write tests, and a way to run the command against it.
 * Nothing here touches the real Trash, the real home folder or a real Collection: the Trash mover is a
 * rename into a second temporary folder, the root is always passed with `--root`, and the app's
 * application-data folder (reply keys, the undo journal, the app's records) is a third temporary
 * folder, passed to every run of the command.
 *
 * Once disposed, a fixture refuses to be used: a test body still running after its time ran out stops
 * at its next step and cannot act on a folder that is gone.
 */
export type WriteFixture = {
  root: string
  /** Where the fake Trash mover puts things. */
  trashed: string
  /** A stand-in for the app's reply-key folder (reply-key.ts): every run of the command reads keys here, never in the real home folder. */
  keys: string
  /** A stand-in for the app's application-data folder: `keys` is inside it, and so are the records kept outside the Collection (collection-records.ts). */
  appData: string
  /** Where the other variant of the app (the beta) would keep its own; not made until a test makes it. */
  otherAppData: string
  /** Where the undo journal, the handled-request records and the undelivered answers for this Collection are, under `appData`. */
  journalDir: string
  handledDir: string
  undeliveredDir: string
  /** The names in the command line's own undo journal, sorted; none when the folder is not there. */
  journalNames: () => Promise<string[]>
  /** The app's own undo journal (changes it made on request), and the names in it. */
  appUndoDir: string
  appUndoNames: () => Promise<string[]>
  write: (rel: string, content: string | Uint8Array) => Promise<void>
  read: (rel: string) => Promise<string>
  bytes: (rel: string) => Promise<Buffer>
  /** Every file under the Collection (owner lock aside), path -> base64 bytes. With `journal`, also the undo journal's files, as `@journal/<name>`. */
  snapshot: (opts?: { journal?: boolean }) => Promise<Record<string, string>>
  cli: (argv: string[], env?: { write?: WriteEnv; stdin?: string | (() => Promise<string>); cwd?: string; /** The environment variables the command reads (WRITEFLEX_SOURCE); none by default, never the process's own. */ environ?: Record<string, string | undefined> }) => Promise<CliRun>
  dispose: () => Promise<void>
}
export type CliRun = { code: number; out: string; err: string; json: { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } } }

/** What a document created from the command line holds: the text given, under its provenance line (cli/agent-created-hook.ts). */
export const createdBy = (text: string, label = 'Outside agent'): string => `---\ncreated-by: ${label}\n---\n\n${text}`

export const YORK = '---\ntitle: York talk\nstatus: draft\n---\n# York\n\nIntro about assessment.\n'
export const NOTES = '# Notes\n\nSee [[york]] for the talk, and [[york|the York one]] again.\n'
export const INTRO = '# Intro\n\nThis leads into [[york]].\n'
export const MANIFEST = `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'intro.md', role: 'section' }, { path: 'york.md', role: 'section' }] }, null, 2)}\n`

async function walk(root: string, dir: string, out: Record<string, string>): Promise<void> {
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (rel === '.writeflex/owner.lock') continue
    if (entry.isDirectory()) await walk(root, rel, out)
    else if (entry.isFile()) out[rel] = (await readFile(join(root, rel))).toString('base64')
    else out[rel] = '<link>'
  }
}

export async function writeFixture(): Promise<WriteFixture> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-write-')))
  const trashed = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-trash-')))
  // Laid out as the real one is: the release app's folder, with room for the beta's beside it.
  const support = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-appdata-')))
  const appData = join(support, 'writeflex-desktop')
  const otherAppData = join(support, 'writeflex-desktop-beta')
  await mkdir(appData, { mode: 0o700 })
  const keys = join(appData, 'collection-keys')
  const journalDir = recordsDir(appData, root, JOURNAL_KIND)
  const journalNames = async (): Promise<string[]> => (await readdir(journalDir).catch(() => [] as string[])).sort()
  let disposed = false
  const live = (): void => { if (disposed) throw new Error('This fixture was disposed: the test it belonged to has ended.') }
  const write = async (rel: string, content: string | Uint8Array): Promise<void> => {
    live()
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), content)
  }
  await write('talks/york.md', YORK)
  await write('talks/intro.md', INTRO)
  await write(`talks/${MANIFEST_NAME}`, MANIFEST)
  await write('notes.md', NOTES)
  // The app's own stores, which no command-line write may touch.
  await write('.writeflex/versions.jsonl', '{"version":"fixture"}\n')
  await write('.writeflex/changes.jsonl', '{"change":"fixture"}\n')
  await write('.bridle/journal.jsonl', '{"bridle":"fixture"}\n')
  const fakeTrash = async (absolute: string): Promise<void> => { await rename(absolute, join(trashed, basename(absolute))) }
  return {
    root, trashed, keys, appData, otherAppData, journalDir, journalNames, write,
    appUndoDir: recordsDir(appData, root, APP_UNDO_KIND), appUndoNames: async () => (await readdir(recordsDir(appData, root, APP_UNDO_KIND)).catch(() => [] as string[])).sort(),
    handledDir: recordsDir(appData, root, HANDLED_KIND), undeliveredDir: recordsDir(appData, root, UNDELIVERED_KIND),
    read: async (rel) => { live(); return readFile(join(root, rel), 'utf8') },
    bytes: async (rel) => { live(); return readFile(join(root, rel)) },
    snapshot: async (opts = {}) => {
      live()
      const out: Record<string, string> = {}
      await walk(root, '', out)
      if (opts.journal) for (const name of await journalNames()) out[`@journal/${name}`] = (await readFile(join(journalDir, name))).toString('base64')
      return out
    },
    cli: async (argv, env = {}) => {
      live()
      let out = ''
      let err = ''
      const cliEnv: CliEnv = {
        cwd: env.cwd ?? tmpdir(), stdout: (t) => { out += t }, stderr: (t) => { err += t }, openUrl: async () => {},
        stdin: typeof env.stdin === 'function' ? env.stdin : async () => (env.stdin as string | undefined) ?? '',
        write: { trash: fakeTrash, keyFolders: [keys], appDataFolders: [appData, otherAppData], ...env.write },
        environ: env.environ ?? {},
      }
      const code = await runCli(['--root', root, '--json', ...argv], cliEnv)
      return { code, out, err, json: JSON.parse(out) as CliRun['json'] }
    },
    dispose: async () => {
      disposed = true
      await rm(root, { recursive: true, force: true })
      await rm(trashed, { recursive: true, force: true })
      await rm(support, { recursive: true, force: true })
    },
  }
}
