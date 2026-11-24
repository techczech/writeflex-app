import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { EXPERIMENTAL_GIT_SYNC_KEY } from '../../src/shared/git-sync-settings'
import { EPUB_EXPORT_AVAILABLE } from '../../src/shared/epub-feature'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const preloadDir = join(repo, 'src', 'preload')
const sharedDir = join(repo, 'src', 'shared') + sep

// Isolate the Electron module mock and keep startup, SQLite and settings in a throwaway profile.
// Boot index.ts, the same module loaded by bootstrap.ts, so new registrations are picked up.
const probe = String.raw`
  import { mock } from 'bun:test'
  import { EventEmitter } from 'node:events'
  import { createBunSqliteDriver } from '@readflex/sqlite-driver/bun'
  import { electronMainStandIn } from './tests/helpers/electron-main-stand-in.ts'

  const handles = new Set()
  const ipcMain = Object.assign(new EventEmitter(), {
    handle(channel) {
      if (handles.has(channel)) throw new Error('Duplicate IPC handler: ' + channel)
      handles.add(channel)
    },
    removeHandler(channel) { handles.delete(channel) },
  })
  const exposed = new Map()
  const dependencyInvokes = new Set()
  const ipcRenderer = Object.assign(new EventEmitter(), {
    async invoke(channel) {
      dependencyInvokes.add(channel)
      return { ok: true }
    },
  })
  const profile = process.env.WRITEFLEX_E2E_USER_DATA
  let ready
  const app = Object.assign(new EventEmitter(), {
    commandLine: { appendSwitch() {}, getSwitchValue: () => '' },
    getPath: () => profile,
    setPath() {},
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient() {},
    whenReady: () => ({ then(start) { ready = Promise.resolve().then(start); return ready } }),
  })
  const noop = () => {}
  // Satisfy the start screen's existing-window check without constructing a window.
  const openWindow = { isDestroyed: () => true }
  mock.module('electron', () => ({
    ...electronMainStandIn,
    app, clipboard: {}, dialog: {}, ipcMain, ipcRenderer, shell: {}, webUtils: {},
    BrowserWindow: class extends electronMainStandIn.BrowserWindow {
      static getAllWindows() { return [openWindow] }
    },
    contextBridge: { exposeInMainWorld: (name, api) => exposed.set(name, api) },
    Menu: { getApplicationMenu: () => null, buildFromTemplate: () => ({}), setApplicationMenu: noop },
    powerMonitor: new EventEmitter(),
    protocol: { registerSchemesAsPrivileged: noop, handle: noop },
    safeStorage: { isEncryptionAvailable: () => false },
    session: { defaultSession: { protocol: { handle: noop }, webRequest: { onBeforeRequest: noop } } },
  }))
  mock.module('@readflex/sqlite-driver/node', () => ({ createNodeSqliteDriver: createBunSqliteDriver }))
  // The bundled reader assets have their own build tests. Only their lookup is stubbed here.
  const readerResources = await import('./src/main/reading-room-resources.ts')
  mock.module('./src/main/reading-room-resources.ts', () => ({
    ...readerResources,
    createReaderResources: () => ({ assets: new Map() }),
  }))

  await import('./src/main/index.ts')
  if (!ready) throw new Error('Main IPC bootstrap did not reach app.whenReady()')
  await ready

  // Settings and Auth invoke via vendored bridge factories. Record the bridge calls against
  // the same stand-in without executing any main handler.
  await import('./src/preload/settings.ts')
  for (const api of [exposed.get('bridleSettings'), exposed.get('writeflexSettings').auth]) {
    for (const [key, method] of Object.entries(api)) {
      if (key === 'rebindMany') await method([])
      else if (key !== 'subscribe' && !key.startsWith('on')) await method('ipc-parity')
    }
  }

  await Bun.write(Bun.stdout, 'IPC_PARITY ' + JSON.stringify({ handles: [...handles], dependencyInvokes: [...dependencyInvokes] }) + '\n')
  process.exit(0)
`

async function recordedChannels(gitSyncEnabled: boolean): Promise<{ handles: string[]; dependencyInvokes: string[] }> {
  const profile = await mkdtemp(join(tmpdir(), 'wf-ipc-parity-'))
  try {
    const sourceHome = join(profile, 'external-sources')
    await mkdir(sourceHome)
    if (gitSyncEnabled) {
      await writeFile(join(profile, 'settings.json'), JSON.stringify({ values: { [EXPERIMENTAL_GIT_SYNC_KEY]: true } }))
    }
    const child = Bun.spawn([process.execPath, '-e', probe], {
      cwd: repo,
      env: {
        HOME: profile,
        TMPDIR: profile,
        WRITEFLEX_E2E: '1',
        WRITEFLEX_E2E_USER_DATA: profile,
        WRITEFLEX_E2E_SOURCE_HOME: sourceHome,
        WRITEFLEX_E2E_ZOTERO_DIRECTORY: profile,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 5_000,
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`IPC registration probe exited ${code}:\n${stderr}`)
    const result = stdout.split('\n').find(line => line.startsWith('IPC_PARITY '))
    if (!result) throw new Error('IPC registration probe produced no channel inventory.')
    return JSON.parse(result.slice('IPC_PARITY '.length))
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}

async function preloadInvocations(file: string): Promise<string[]> {
  const path = join(preloadDir, file)
  const source = ts.createSourceFile(file, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const imports = new Map<string, { path: string; exported: string }>()
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue
    const bindings = node.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const specifier of bindings.elements) {
      imports.set(specifier.name.text, { path: node.moduleSpecifier.text, exported: (specifier.propertyName ?? specifier.name).text })
    }
  }
  const calls: ts.Expression[] = []
  function collect(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const property = ts.isPropertyAccessExpression(callee) ? callee.name
        : ts.isElementAccessExpression(callee) ? callee.argumentExpression : null
      if (property && (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) && property.text === 'invoke') {
        if (!node.arguments[0]) throw new Error('Missing IPC channel in ' + file + ': ' + node.getText())
        calls.push(node.arguments[0])
      }
    }
    ts.forEachChild(node, collect)
  }
  collect(source)
  async function channels(expression: ts.Expression): Promise<string[]> {
    if (ts.isStringLiteralLike(expression)) return [expression.text]
    if (ts.isConditionalExpression(expression)) return [
      ...await channels(expression.whenTrue), ...await channels(expression.whenFalse),
    ]
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const binding = imports.get(expression.expression.text)
      if (binding?.path.startsWith('.')) {
        const resolved = Bun.resolveSync(binding.path, dirname(path))
        if (resolved.startsWith(sharedDir)) {
          const constants = await import(resolved)
          const channel: unknown = constants[binding.exported]?.[expression.name.text]
          if (typeof channel === 'string') return [channel]
        }
      }
    }
    const { line } = source.getLineAndCharacterOfPosition(expression.getStart())
    throw new Error(`Cannot resolve IPC channel in ${file}:${line + 1}: ${expression.getText()}`)
  }
  return (await Promise.all(calls.map(channels))).flat()
}

// Protocol handlers such as wf-asset and wf-reader are outside the ipcMain.handle inventory.
const mainOnly: Record<string, string> = {
  'scratchpad:get': 'Existing orphan. Remove the single-item handler in a follow-up after confirming it has no other client.',
}
const preloadOnly: Record<string, string> = {}

test('preload invokes and main IPC handlers have matching channels', async () => {
  const preloadFiles = (await readdir(preloadDir, { recursive: true })).filter(file => file.endsWith('.ts'))
  const [registered, withoutGitSync, sourceInvokes] = await Promise.all([
    recordedChannels(true), recordedChannels(false), Promise.all(preloadFiles.map(preloadInvocations)),
  ])
  const main = new Set(registered.handles)
  const preload = new Set([...sourceInvokes.flat(), ...registered.dependencyInvokes])
  const epubChannels = EPUB_EXPORT_AVAILABLE ? ['cancel', 'open', 'prepare', 'release', 'reveal', 'save'] : []
  for (const channels of [preload, main]) {
    expect([...channels].filter(channel => channel.startsWith('folio-epub:')).sort())
      .toEqual(epubChannels.map(action => 'folio-epub:' + action))
  }
  const difference = (from: Set<string>, to: Set<string>) => [...from].filter(channel => !to.has(channel)).sort()
  const off = new Set(withoutGitSync.handles)
  expect(difference(main, off)).toEqual(['git-sync:buffers'])
  expect(difference(off, main)).toEqual([])
  console.info('[ipc-parity] %d invoke channels, %d main registrations', preload.size, main.size)
  expect({ mainOnly: difference(main, preload), preloadOnly: difference(preload, main) }).toEqual({
    mainOnly: Object.keys(mainOnly).sort(),
    preloadOnly: Object.keys(preloadOnly).sort(),
  })
}, 7_000)
