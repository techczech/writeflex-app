import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// @bridle/react ships TWO barrels; consumers must alias the components barrel
// (components.ts) — the package "exports" points at the slim index, which lacks
// AuthFlow/BRIDLE_CSS (same wiring as Paddock's config).
const bridleReactPackage = realpathSync(resolve(__dirname, 'node_modules/@bridle/react'))
const bridleReact = resolve(bridleReactPackage, 'src/components.ts')
const bridleDir = resolve(bridleReactPackage, '..')

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { outDir: 'out/main' } },
  preload: { plugins: [externalizeDepsPlugin()], build: { outDir: 'out/preload' } },
  renderer: {
    plugins: [react()],
    build: { outDir: 'out/renderer' },
    // dedupe: the bridle packages are file-linked into node_modules with per-file
    // symlinks, so their react imports would otherwise resolve to bridle's OWN
    // react copy — two React instances in one bundle = hooks dispatcher crash.
    resolve: { alias: { '@bridle/react': bridleReact }, dedupe: ['react', 'react-dom', '@codemirror/state'] },
    // Dev server must be allowed to read the aliased bridle sources outside the repo root.
    server: { fs: { allow: ['.', bridleDir] } }
  }
})
