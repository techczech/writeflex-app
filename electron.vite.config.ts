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
  let outDir: string
  return {
    name: 'writeflex-settings-preload',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir) },
    apply: 'build',
    async closeBundle() {
      for (const name of ['settings']) await viteBuild({
        configFile: false,
        logLevel: 'warn',
        build: {
          outDir,
          emptyOutDir: false,
          minify: false,
          lib: { entry: resolve(__dirname, 'src/preload/' + name + '.ts'), formats: ['cjs'], fileName: () => name + '.js' },
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
    // Bootstrap imports the fixed headless command entry before loading the desktop app.
    build: {
      ...(command === 'serve' ? { watch: {} } : {}),
      outDir: 'out/main',
      rollupOptions: {
        input: {
          bootstrap: resolve(__dirname, 'src/main/bootstrap.ts'),
          index: resolve(__dirname, 'src/main/index.ts'),
          'writeflex-cli': resolve(__dirname, 'src/main/writeflex-cli.ts'),
        }
      }
    }
  },
  preload: {
    plugins: [settingsPreload()],
    build: {
      outDir: 'out/preload',
      externalizeDeps: false,
      lib: { entry: resolve(__dirname, 'src/preload/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
    },
  },
  renderer: {
    plugins: [react(), {
      name: 'writeflex-renderer-policy',
      apply: 'build',
      transformIndexHtml(_html, context) {
        if (!context.filename.endsWith('/index.html')) return
        return [{
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: wf-asset: https:; font-src 'self' data:; media-src 'self' blob: wf-asset:; connect-src 'self'; frame-src wf-reader: wf-widget:; base-uri 'none'; form-action 'none'",
          },
          injectTo: 'head-prepend',
        }]
      },
    }],
    build: { outDir: 'out/renderer', manifest: true, rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html'), 'reader-host': resolve(__dirname, 'src/renderer/reader-host.html'), settings: resolve(__dirname, 'src/renderer/settings.html') } } },
    // Keep a single React and CodeMirror state instance across vendored packages.
    resolve: { dedupe: ['react', 'react-dom', '@codemirror/state'] }
  }
}))
