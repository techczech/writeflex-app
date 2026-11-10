import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { publishReaderMain, ReaderPublicationRecoveryError } from './reader-main-publication'
import { buildReaderHost } from './prepare-reader-host'

/** Owned by electron-vite's existing main watcher; each restart consumes an immutable generation. */
export function readerHostDevelopment(project: string): Plugin {
  const selector = resolve(project, 'src/main/reading-room-host-directory.ts')
  const generations = new Set<string>()
  let directory: string
  let mainStage: string
  let written = false
  let mainOutput: string
  let publicationBlocked: ReaderPublicationRecoveryError | undefined
  return {
    name: 'writeflex-reader-development',
    enforce: 'pre',
    // Vite prepares outDir before buildStart, including on a failed nested host build.
    config() { return { build: { emptyOutDir: false } } },
    configResolved(config) {
      const watchers = config.plugins.filter(plugin => plugin.name === 'vite:electron-watcher')
      const watcher = watchers[0]
      const close = watcher?.closeBundle
      if (watchers.length !== 1 || typeof close !== 'function' || !config.build.watch) {
        throw new Error('Reader development requires the installed Electron main watcher callback.')
      }
      mainOutput = resolve(config.root, config.build.outDir)
      // Installed electron-vite treats every closeBundle as success. Rollup also calls it
      // after buildStart/buildEnd failure; only a completed disk write admits that callback.
      watcher.closeBundle = function (error?: unknown) {
        if (error || !written) return
        written = false
        return close.call(this)
      }
    },
    async buildStart() {
      written = false
      const parent = resolve(project, 'out/reader-host-dev')
      mkdirSync(parent, { recursive: true })
      mainStage = mkdtempSync(resolve(parent, 'main-'))
      generations.add(mainStage)
      const next = mkdtempSync(resolve(parent, 'generation-'))
      generations.add(next)
      // Never replace files underneath a live map. Publish this directory only after validation.
      let inputs: string[]
      try {
        inputs = await buildReaderHost(next, project)
      } catch (error) {
        // A first failed build has no prior successful watch set. Retain Rollup's
        // actual failure inputs so correcting the refused source can recover.
        const failure = error as { watchFiles?: string[]; id?: string }
        for (const input of failure.watchFiles ?? []) this.addWatchFile(input)
        if (failure.id) this.addWatchFile(failure.id)
        throw error
      }
      for (const input of inputs) this.addWatchFile(input)
      directory = next
    },
    outputOptions(options) {
      if (options.file || !options.dir) throw new Error('Reader development requires main directory output.')
      return { ...options, dir: mainStage }
    },
    buildEnd(error) { if (error) written = false },
    renderError() { written = false },
    // Sequential/post runs after other output hooks. Vite closes successful bundles
    // only after result.write resolves; output errors never admit the callback.
    writeBundle: { order: 'post', sequential: true, handler() {
      if (publicationBlocked) throw publicationBlocked
      try { generations.add(publishReaderMain(mainStage, mainOutput)) }
      catch (error) {
        if (error instanceof ReaderPublicationRecoveryError) publicationBlocked = error
        // Rollup observes writeBundle errors. Installed Vite ignores close() rejections.
        throw error
      }
      written = true
    } },
    shouldTransformCachedModule({ id }) { return id === selector },
    transform(_code, id) {
      if (id !== selector) return
      if (!directory) throw new Error('Development reader generation is not ready.')
      return { code: `export function readerHostDirectory() { return ${JSON.stringify(directory)} }`, map: null }
    },
    closeWatcher() {
      // A failed rollback retains the old main AND its referenced host generations.
      if (publicationBlocked) return
      for (const directory of generations) rmSync(directory, { recursive: true, force: true })
      generations.clear()
    },
  }
}
