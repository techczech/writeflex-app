import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { build as viteBuild, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readerHostDevelopment } from './scripts/reader-host-development'

const releaseVersion = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version as string
if (!existsSync(resolve(__dirname, 'resources/whats-new', `${releaseVersion}.md`))) throw new Error(`Missing bundled What’s new notes for ${releaseVersion}`)

// The shared-settings packages are bundled (not left as node_modules files): they are vendored tarballs,
// and the Settings window is sandboxed, so its preload cannot require packages at all.
const BUNDLED = ['@app-patterns/commands', '@app-patterns/settings', '@app-patterns/settings-electron', '@app-patterns/settings-react']

// The Settings window's preload is sandboxed: it may require nothing but electron, so it is one CommonJS
// file, built as its own bundle after the main preload (as a second input rollup would share chunks with
// index.ts that the sandbox cannot load).
function settingsPreload(): Plugin {
  return {
    name: 'writeflex-settings-preload',
    apply: 'build',
    async closeBundle() {
      await viteBuild({
        configFile: false,
        logLevel: 'warn',
        build: {
          outDir: resolve(__dirname, 'out/preload'),
          emptyOutDir: false,
          minify: false,
          lib: { entry: resolve(__dirname, 'src/preload/settings.ts'), formats: ['cjs'], fileName: () => 'settings.js' },
          rollupOptions: { external: ['electron'] }
        }
      })
    }
  }
}


export default defineConfig(({ command }) => ({
  main: {
    // @app-patterns/vault-sync is bundled, not shipped: main uses its reviewed socket client and read-only history validation;
    // bundling leaves the helper's server and backup engine out of the app (_TASK-LOG/2026-10-25-vault-sync-bridge.md).
    plugins: [externalizeDepsPlugin({ exclude: ['@app-patterns/vault-sync', ...BUNDLED] }), ...(command === 'serve' ? [readerHostDevelopment(__dirname)] : [])],
    // The update-test flavour's switch (src/main/update-test-build.ts): false here, so its branches are dead code in
    // every production bundle. Only electron.vite.update-test.config.ts sets it true.
    define: { __WF_UPDATE_TEST__: 'false' },
    // writeflex-cli.js is the command line the installed `writeflex` shim runs in Node mode
    // (ELECTRON_RUN_AS_NODE=1), as TodoScout's refresh-cli does. It must import nothing from Electron.
    build: {
      ...(command === 'serve' ? { watch: {} } : {}),
      outDir: 'out/main',
      rollupOptions: { input: { bootstrap: resolve(__dirname, 'src/main/bootstrap.ts'), index: resolve(__dirname, 'src/main/index.ts'), 'writeflex-cli': resolve(__dirname, 'src/main/writeflex-cli.ts') } }
    }
  },
  preload: { plugins: [externalizeDepsPlugin({ exclude: BUNDLED }), settingsPreload()], build: { outDir: 'out/preload' } },
  renderer: {
    plugins: [react()],
    build: { outDir: 'out/renderer', manifest: true, rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html'), 'reader-host': resolve(__dirname, 'src/renderer/reader-host.html'), settings: resolve(__dirname, 'src/renderer/settings.html') } } },
    // Keep a single React and CodeMirror state instance across vendored packages.
    resolve: { dedupe: ['react', 'react-dom', '@codemirror/state'] }
  }
}))
