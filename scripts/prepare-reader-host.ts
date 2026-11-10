import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { createReaderResources } from '../src/main/reading-room-resources'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Dev's renderer server emits no manifest. Prepare only the restricted host before Electron starts. */
export async function prepareReaderHost(outDir = resolve(project, 'out/renderer')): Promise<void> {
  await buildReaderHost(outDir)
}

/** Build only the reader closure and return Vite's complete watched input set. */
export async function buildReaderHost(outDir: string, projectRoot = project): Promise<string[]> {
  let inputs: string[] = []
  await build({
    configFile: false,
    root: resolve(projectRoot, 'src/renderer'),
    plugins: [{ name: 'writeflex-reader-inputs', buildEnd() { inputs = this.getWatchFiles() } }],
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      manifest: true,
      rollupOptions: { input: resolve(projectRoot, 'src/renderer/reader-host.html') },
    },
  })
  const readerEntry = realpathSync(resolve(projectRoot, 'node_modules/@readflex/reader-embed/vendor/reader/reader.html'))
  const resources = createReaderResources(dirname(dirname(readerEntry)), outDir)
  if (resources.assets.has('index.html')) throw new Error('Development reader includes the editor entry.')
  return inputs
}

if (import.meta.main) await prepareReaderHost()
