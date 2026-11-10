// Run the real fs.watch smoke in Node, the runtime used by Electron main. Bun 1.3.14
// coalesces the incoming temporary-file event and drops its immediate rename to vault.json.
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as settle } from 'node:timers/promises'
import { watchVaultFile } from '../../src/main/vault-watcher.ts'

const root = await mkdtemp(join(tmpdir(), 'wf-native-vault-'))
let touched = 0
const watch = watchVaultFile(root, () => { touched += 1 }, { debounceMs: 20 })
try {
  await mkdir(join(root, '.writeflex'))
  await settle(300)
  const afterFolder = touched
  await writeFile(join(root, '.writeflex', '.incoming.tmp'), '{"name":"A"}')
  await rename(join(root, '.writeflex', '.incoming.tmp'), join(root, '.writeflex', 'vault.json'))
  await settle(300)
  const afterRename = touched
  await writeFile(join(root, '.writeflex', 'vault.json'), '{"name":"B"}')
  await settle(300)
  console.log(JSON.stringify({ afterFolder, afterRename, afterRewrite: touched }))
} finally {
  watch.dispose()
  await rm(root, { recursive: true, force: true })
}
