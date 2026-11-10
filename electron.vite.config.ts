import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readerHostDevelopment } from './scripts/reader-host-development'

const releaseVersion = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version as string
if (!existsSync(resolve(__dirname, 'resources/whats-new', `${releaseVersion}.md`))) throw new Error(`Missing bundled What’s new notes for ${releaseVersion}`)

export default defineConfig(({ command }) => ({
  main: {
    // @app-patterns/vault-sync is bundled, not shipped: main uses its reviewed socket client and read-only history validation;
    // bundling leaves the helper's server and backup engine out of the app (_TASK-LOG/2026-10-25-vault-sync-bridge.md).
    plugins: [externalizeDepsPlugin({ exclude: ['@app-patterns/vault-sync'] }), ...(command === 'serve' ? [readerHostDevelopment(__dirname)] : [])],
    // writeflex-cli.js is the command line the installed `writeflex` shim runs in Node mode
    // (ELECTRON_RUN_AS_NODE=1), as TodoScout's refresh-cli does. It must import nothing from Electron.
    build: {
      ...(command === 'serve' ? { watch: {} } : {}),
      outDir: 'out/main',
      rollupOptions: { input: { bootstrap: resolve(__dirname, 'src/main/bootstrap.ts'), index: resolve(__dirname, 'src/main/index.ts'), 'writeflex-cli': resolve(__dirname, 'src/main/writeflex-cli.ts') } }
    }
  },
  preload: { plugins: [externalizeDepsPlugin()], build: { outDir: 'out/preload' } },
  renderer: {
    plugins: [react()],
    build: { outDir: 'out/renderer', manifest: true, rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html'), 'reader-host': resolve(__dirname, 'src/renderer/reader-host.html') } } },
    // Keep a single React and CodeMirror state instance across vendored packages.
    resolve: { dedupe: ['react', 'react-dom', '@codemirror/state'] }
  }
}))
