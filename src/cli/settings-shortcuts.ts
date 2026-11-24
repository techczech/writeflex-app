// App-owned command mutations reconcile migrated keys in the same locked write as the shared key.
import { basename, resolve } from 'node:path'
import { batchOf, changedFromDefault, lastImportBatch, LIMITS, type ChangeEntry } from '@app-patterns/settings'
import { EXIT, readBoundedFile, MAX_FILE_BYTES, type SettingsCliIO, type LockOptions, type StoreResult } from '@app-patterns/settings/node'
import { APP_KEYS_SETTING, parseOverrideJson } from '../shared/keymap-overrides'
import { SharedSettingsStore } from '../main/shared-settings-store'
import { storeOptions } from '../main/settings-migration'
import { registry } from '../shared/bridle-commands'
import { schema } from '../shared/settings-schema'
import { agentName, CliExit, entryLine, esc, exitFor, parseChordArg, previewText, safe, tokenize, USAGE, validateMutation } from './settings-cli-compat'

export async function runShortcutMutation(argv: string[], io: SettingsCliIO, dir: string, version: string, lock?: LockOptions): Promise<number | undefined> {
  const parsed = tokenize(argv)
  const { verb, args, flags, json } = parsed
  if (!['rebind', 'reset-shortcut', 'import', 'undo-import', 'reset'].includes(verb ?? '')) return undefined
  if (verb === 'reset' && flags.get('all') !== true && flags.get('section') === undefined && args[0] !== APP_KEYS_SETTING) return undefined
  const fail = (exit: number, error: string, extra = {}): number => {
    if (json) io.stdout(JSON.stringify({ ok: false, exit, error, ...extra }) + '\n')
    else (exit === EXIT.confirm ? io.stdout : io.stderr)(safe(error) + '\n')
    return exit
  }
  const out = (text: string, data: object): void => io.stdout((json ? JSON.stringify(data) : safe(text)) + '\n')
  const changesOut = (entries: ChangeEntry[], data = {}): void => out(entries.length ? entries.map((entry) => entryLine(entry, schema)).join('\n') : 'Nothing changed; it already had that value', { ok: true, changed: entries.length > 0, entries, ...data })
  const storeFail = (result: Extract<StoreResult, { ok: false }>) => fail(exitFor(result.code), result.error, { code: result.code })
  const needCommand = (id: string): void => {
    if (!registry.isCommandId(id) || schema.def(id)) throw new CliExit(EXIT.badInput, `There is no command "${id.slice(0, LIMITS.id)}"`, { code: 'unknown-command' })
  }
  let store: SharedSettingsStore | undefined
  try {
    validateMutation(parsed)
    const name = agentName(flags.get('agent'), io.env ?? process.env)
    store = new SharedSettingsStore({
      ...storeOptions(dir, version), ...(lock ? { lock } : {}), who: { kind: 'agent', name }, watch: false,
      ...(io.now ? { now: io.now } : {}), ...(io.newId ? { newId: io.newId } : {}), log: (line) => io.stderr(esc(line) + '\n'),
    })
    await store.ready
    const problem = store.problem()
    if (problem) return fail(EXIT.failed, problem.error, { code: 'refused', problem: problem.code })
    if (verb === 'rebind') {
      needCommand(args[0])
      const chord = parseChordArg(args[1])
      if (!chord.ok) throw new CliExit(EXIT.badInput, `${args[0]}: ${chord.error}`, { code: 'invalid-chord' })
      const result = await store.rebind(args[0], chord.chord)
      if (!result.ok) return storeFail(result)
      changesOut(result.entries)
    } else if (verb === 'reset-shortcut') {
      const id = args[0]
      const all = flags.get('all') === true
      if ((id !== undefined) === all) throw new CliExit(EXIT.badInput, USAGE)
      if (id !== undefined) {
        if (flags.get('yes') !== undefined) throw new CliExit(EXIT.badInput, `--yes goes with reset-shortcut --all\n${USAGE}`)
        needCommand(id)
        const result = await store.reset({ commandId: id })
        if (!result.ok) return storeFail(result)
        changesOut(result.entries)
      } else {
        const state = store.view()
        const count = new Set([...Object.keys(state.keys), ...Object.keys(parseOverrideJson(state.settings[APP_KEYS_SETTING]))]).size
        if (flags.get('yes') !== true) {
          if (count === 0) { out('Nothing to reset: every shortcut has its default', { ok: true, changed: false, entries: [], count: 0 }); return EXIT.ok }
          return fail(EXIT.confirm, `This puts ${count} shortcut${count === 1 ? '' : 's'} back to ${count === 1 ? 'its default' : 'their defaults'}. Run again with --yes to do it.`, { needsConfirmation: true, count })
        }
        const result = await store.resetShortcuts()
        if (!result.ok) return storeFail(result)
        changesOut(result.entries, result.batch ? { batch: result.batch } : {})
      }
    } else if (verb === 'reset') {
      const key = args[0]
      const section = flags.get('section')
      const all = flags.get('all') === true
      if ([key !== undefined, section !== undefined, all].filter(Boolean).length !== 1) throw new CliExit(EXIT.badInput, USAGE)
      if (key !== undefined) {
        const result = await store.reset(key)
        if (!result.ok) return storeFail(result)
        changesOut(result.entries)
      } else if (typeof section === 'string') {
        const result = await store.resetSection(section)
        if (!result.ok) return storeFail(result)
        changesOut(result.entries, result.batch ? { batch: result.batch } : {})
      } else {
        const count = changedFromDefault(store.view(), schema).count
        if (flags.get('yes') !== true) {
          if (count === 0) { out('Nothing to reset: every setting and shortcut has its default', { ok: true, changed: false, entries: [], count: 0 }); return EXIT.ok }
          return fail(EXIT.confirm, `This puts ${count} setting${count === 1 ? '' : 's'} and shortcuts back to their defaults. Run again with --yes to do it.`, { needsConfirmation: true, count })
        }
        const result = await store.resetAll()
        if (!result.ok) return storeFail(result)
        changesOut(result.entries, result.batch ? { batch: result.batch } : {})
      }
    } else if (verb === 'import') {
      const path = resolve(io.cwd ?? process.cwd(), args[0])
      const file = await readBoundedFile(path, MAX_FILE_BYTES)
      if (file.kind !== 'ok') throw new CliExit(EXIT.badInput, file.kind === 'missing' ? `There is no file ${path}` : file.kind === 'too-large' ? `${path} is too large to be a settings export` : `${path} cannot be read`)
      const preview = store.previewImport(file.text)
      if (preview.refused) return fail(EXIT.badInput, preview.refused.message, { code: 'refused', refused: preview.refused })
      if (!preview.changes.length) { out(`${previewText(preview, schema)}\nNothing to import.`, { ok: true, applied: false, preview }); return EXIT.ok }
      if (flags.get('yes') !== true) {
        if (json) io.stdout(JSON.stringify({ ok: false, exit: EXIT.confirm, needsConfirmation: true, preview }) + '\n')
        else io.stdout(`${safe(previewText(preview, schema))}\nRun again with --yes to import.\n`)
        return EXIT.confirm
      }
      const result = await store.applyImport(preview, { file: basename(path) })
      if (!result.ok) return storeFail(result)
      out(`Imported: ${result.entries.length} change${result.entries.length === 1 ? '' : 's'}${result.batch ? ` (batch ${esc(result.batch)}; undo with "undo-import --last")` : ''}`, { ok: true, applied: true, ...(result.batch ? { batch: result.batch } : {}), entries: result.entries, skipped: preview.skipped })
    } else {
      const last = flags.get('last') === true
      const id = args[0]
      if (last === (id !== undefined)) throw new CliExit(EXIT.badInput, USAGE)
      const batch = last ? lastImportBatch(store.view()) : id
      if (!batch) throw new CliExit(EXIT.badInput, 'There is no import to undo', { code: 'not-found' })
      const info = batchOf(store.view(), batch)
      if (!info) throw new CliExit(EXIT.badInput, 'That batch is no longer in the list of changes', { code: 'not-found' })
      if (!info.import) throw new CliExit(EXIT.badInput, 'That batch is not an import', { code: 'not-found' })
      const result = await store.undoBatch(batch)
      if (!result.ok) return fail(exitFor(result.code), result.error, { code: result.code, ...(result.skipped ? { skipped: result.skipped } : {}) })
      const skippedText = result.skipped.map((entry) => `  kept ${esc(entry.key ?? `shortcut ${entry.commandId}`)}: ${esc(entry.reason)}`).join('\n')
      out(`${result.entries.map((entry) => entryLine(entry, schema)).join('\n')}${skippedText ? `\n${skippedText}` : ''}`, { ok: true, ...(result.batch ? { batch: result.batch } : {}), entries: result.entries, skipped: result.skipped })
    }
    return EXIT.ok
  } catch (error) {
    if (error instanceof CliExit) return fail(error.code, error.message, error.json)
    return fail(EXIT.failed, `Settings could not be changed: ${error instanceof Error ? error.message.slice(0, 300) : 'unexpected error'}`)
  } finally {
    await store?.close()
  }
}
