// Package entry (package.json "main"). Imports only Electron, Node built-ins and the pure bootstrap
// core, then loads the real main bundle dynamically so a load failure is handled here and never
// reaches Electron's own error dialog.
import { writeSync } from 'node:fs'
import { app, crashReporter, dialog } from 'electron'
import { enterUpdateTestHarness, installSmokeDialogGuard, installSmokeFatalHandlers, isSmokeMode, loadMain, type BootstrapDependencies } from './bootstrap-core'

declare const __WF_UPDATE_TEST__: boolean | undefined
// The unpublished update-test flavour only (src/main/update-test-build.ts): the production build defines the flag
// false, so this is dead code there. It enters the hidden harness before anything reads the environment, also when
// Squirrel.Mac relaunches the flavour after an install with none of the driver's environment.
if (typeof __WF_UPDATE_TEST__ === 'boolean' && __WF_UPDATE_TEST__) {
  enterUpdateTestHarness(process.env, process.execPath)
  // Before the crash reporter below: its folder follows userData, which must never be the default one.
  app.setPath('userData', process.env.WRITEFLEX_E2E_USER_DATA!)
}

const smoke = isSmokeMode(process.env)
// First action in automated mode (smoke or e2e): Chromium's mock keychain, so the macOS Keychain is never reached
// (a missing or locked keychain raises a system dialog on the person's screen).
if (smoke) app.commandLine.appendSwitch('use-mock-keychain')

const dependencies: BootstrapDependencies = {
  env: process.env,
  exit: (code) => app.exit(code),
  importer: () => import(/* @vite-ignore */ new URL('./index.js', import.meta.url).href),
  isPackaged: app.isPackaged,
  showErrorBox: (title, content) => dialog.showErrorBox(title, content),
  writeStderr: (text) => { writeSync(2, text) },
}

installSmokeFatalHandlers(process, dependencies)
if (smoke) {
  app.dock?.hide()
  // A native crash in the main process must not raise the macOS crash dialog.
  crashReporter.start({ uploadToServer: false, ignoreSystemCrashHandler: true })
  installSmokeDialogGuard(dialog as unknown as Record<string, unknown>, dependencies)
}
// Top-level await (this file is ESM): Electron waits for it before emitting 'ready', so index.js
// registers its schemes before the app is ready.
await loadMain(dependencies)
