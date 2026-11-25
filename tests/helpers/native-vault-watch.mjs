// Run the vault watcher over real file changes in Node, the runtime used by Electron main.
// Opt into the app's FSEvents transport alongside the shared-folder differential on a live Mac.
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchVaultFile } from '../../src/main/vault-watcher.ts'
import { waitForWatch, watchTestTarget } from './watch-test-target.mjs'

const root = await mkdtemp(join(tmpdir(), 'wf-native-vault-'))
let touched = 0
const native = process.env.WRITEFLEX_NATIVE_WATCH_TESTS === '1'
const watch = watchVaultFile(root, () => { touched += 1 }, {
  debounceMs: 20,
  ...(native ? {} : { watch: (folder, listener) => folder === root
    ? watchTestTarget(folder, '.writeflex', listener, true)
    : watchTestTarget(folder, 'vault.json', listener) }),
})
try {
  await mkdir(join(root, '.writeflex'))
  await waitForWatch(() => touched > 0, '.writeflex arrival')
  const afterFolder = touched
  await writeFile(join(root, '.writeflex', '.incoming.tmp'), '{"name":"A"}')
  await rename(join(root, '.writeflex', '.incoming.tmp'), join(root, '.writeflex', 'vault.json'))
  await waitForWatch(() => touched > afterFolder, 'atomic vault.json replacement')
  const afterRename = touched
  await writeFile(join(root, '.writeflex', 'vault.json'), '{"name":"Rewritten"}')
  await waitForWatch(() => touched > afterRename, 'vault.json rewrite')
  console.log(JSON.stringify({ afterFolder, afterRename, afterRewrite: touched }))
} finally {
  watch.dispose()
  await rm(root, { recursive: true, force: true })
}
