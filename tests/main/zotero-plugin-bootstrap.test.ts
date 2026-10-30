/**
 * The plugin as Zotero runs it: the built `bootstrap.js` (bridge logic bundled in) evaluated in a bare
 * script context holding only what Zotero's plugin sandbox provides (`plugins.js`: `Zotero`,
 * `IOUtils`, `PathUtils`, `crypto`, `TextEncoder`, the reason constants). Nothing is loaded at run time, so the
 * `jar:file:` subscript problem cannot arise. Fakes only; no Zotero runs.
 */
import { describe, expect, test } from 'bun:test'
import { webcrypto } from 'node:crypto'
import { createContext, runInContext } from 'node:vm'
import { bundledBootstrap, xpiEntries } from '../../scripts/build-zotero-plugin'
import { answerIsSigned, memoryZotero, plugin, signRequest } from '../helpers/fake-zotero-plugin'

const REASONS = { ADDON_DISABLE: 4, ADDON_DOWNGRADE: 8, ADDON_ENABLE: 3, ADDON_INSTALL: 5, ADDON_UNINSTALL: 6, ADDON_UPGRADE: 7, APP_SHUTDOWN: 2, APP_STARTUP: 1 }

type Endpoint = new () => { init(request: unknown): Promise<[number, Record<string, string> | string, string]>; supportedDataTypes: string[] }

function sandbox() {
  const prefs = new Map<string, unknown>()
  const files = new Map<string, { body: string; mode?: number }>()
  const directories = new Map<string, number>()
  const endpoints: Record<string, Endpoint> = {}
  const zotero = memoryZotero()
  const Zotero = {
    ...zotero.Z,
    DataDirectory: { dir: '/fake/Zotero' },
    initializationPromise: Promise.resolve(),
    logError: (error: unknown) => { throw error },
    Prefs: {
      clear: (name: string) => prefs.delete(name),
      get: (name: string) => (name === 'httpServer.port' ? 23120 : prefs.get(name)),
      set: (name: string, value: unknown) => prefs.set(name, value),
    },
    Server: { Endpoints: endpoints },
    version: '9.0',
  }
  const IOUtils = {
    makeDirectory: async (path: string, options: { permissions: number }) => { directories.set(path, options.permissions) },
    remove: async (path: string) => { files.delete(path) },
    setPermissions: async (path: string, mode: number) => {
      if (files.has(path)) files.get(path)!.mode = mode
      else directories.set(path, mode)
    },
    writeUTF8: async (path: string, body: string) => { files.set(path, { body }) },
  }
  const PathUtils = { join: (...parts: string[]) => parts.join('/') }
  // The globals `plugins.js` gives a plugin sandbox that this plugin uses (`wantGlobalProperties` and the assigned ones).
  const scope = createContext({ crypto: webcrypto, IOUtils, PathUtils, TextDecoder, TextEncoder, Zotero, ...REASONS })
  runInContext(bundledBootstrap(), scope, { filename: 'bootstrap.js' })
  const call = (name: string, ...args: unknown[]) => runInContext(name, scope)(...args) as Promise<void> | void
  return { call, directories, endpoints, files, prefs, scope, zotero }
}

describe('the built plugin', () => {
  test('the xpi holds the manifest and one self-contained bootstrap.js', () => {
    const names = xpiEntries().map((entry) => entry.name)
    expect(names).toEqual(['manifest.json', 'bootstrap.js'])
    const source = bundledBootstrap()
    expect(source).not.toContain('loadSubScript')
    expect(source).toContain('var WriteFlexZotero')
  })

  test('install makes a fresh key; an upgrade or a restart keeps the old one', async () => {
    const plugin = sandbox()
    plugin.prefs.set('extensions.writeflex.token', 'c'.repeat(64))
    await plugin.call('install', {}, REASONS.ADDON_UPGRADE)
    expect(plugin.prefs.get('extensions.writeflex.token')).toBe('c'.repeat(64))
    await plugin.call('install', {}, REASONS.ADDON_INSTALL)
    const fresh = plugin.prefs.get('extensions.writeflex.token') as string
    expect(fresh).toMatch(/^[0-9a-f]{64}$/)
    expect(fresh).not.toBe('c'.repeat(64))
  })

  test('startup registers the three endpoints and writes an owner-only bridge file; a signed ping is answered and signed', async () => {
    const zoteroPlugin = sandbox()
    await zoteroPlugin.call('startup', { id: 'writeflex@example.com', rootURI: 'jar:file:///x.xpi!/', version: '1.0.0' }, REASONS.APP_STARTUP)
    expect(Object.keys(zoteroPlugin.endpoints).sort()).toEqual(['/writeflex/annotations', '/writeflex/annotations/read', '/writeflex/ping'])
    const bridge = zoteroPlugin.files.get('/fake/Zotero/writeflex/bridge.json')!
    expect(bridge.mode).toBe(0o600)
    expect(zoteroPlugin.directories.get('/fake/Zotero/writeflex')).toBe(0o700)
    const written = JSON.parse(bridge.body)
    expect(written).toMatchObject({ pluginVersion: '1.0.0', port: 23120, protocol: plugin.PROTOCOL })
    expect(written.token).toBe(zoteroPlugin.prefs.get('extensions.writeflex.token'))

    const Ping = zoteroPlugin.endpoints['/writeflex/ping']!
    expect(new Ping().supportedDataTypes).toEqual(['text/plain'])
    const { headers, nonce } = signRequest(written.token, 'GET', '/writeflex/ping', '')
    const answer = await new Ping().init({ headers, method: 'GET' })
    expect(answer[0]).toBe(200)
    expect(answerIsSigned(written.token, nonce, answer)).toBe(true)
    // Each start makes a new session id, handed out in the signed ping; writes must carry it.
    const session = JSON.parse(answer[2]).sessionId as string
    expect(session).toMatch(/^[0-9a-f]{32}$/)
    // The same request again: refused, the nonce is remembered across requests.
    expect((await new Ping().init({ headers, method: 'GET' }))[0]).toBe(403)

    zoteroPlugin.zotero.put({ key: 'PDFKEY22', kind: 'pdf', libraryID: 1 })
    const body = JSON.stringify({
      itemKey: 'MARKKEY2', libraryId: 1, operation: 'create', parentItemKey: 'PDFKEY22', protocol: plugin.PROTOCOL,
      payload: { color: '#ffd400', comment: null, pageLabel: '1', position: '{"pageIndex":0,"rects":[]}', sortIndex: '00000|000001|00001', text: 'x', type: 'highlight' },
    })
    const signed = signRequest(written.token, 'POST', '/writeflex/annotations', body, { session })
    const Annotations = zoteroPlugin.endpoints['/writeflex/annotations']!
    const created = await new Annotations().init({ data: body, headers: signed.headers, method: 'POST' })
    expect(JSON.parse(created[2])).toEqual({ itemKey: 'MARKKEY2', kind: 'confirmed' })
    expect(answerIsSigned(written.token, signed.nonce, created)).toBe(true)
    const readBody = JSON.stringify({ libraryId: 1, parentItemKey: 'PDFKEY22', protocol: plugin.PROTOCOL })
    const readSigned = signRequest(written.token, 'POST', '/writeflex/annotations/read', readBody, { session })
    const Read = zoteroPlugin.endpoints['/writeflex/annotations/read']!
    const read = await new Read().init({ data: readBody, headers: readSigned.headers, method: 'POST' })
    expect(read[0]).toBe(200)
    expect(answerIsSigned(written.token, readSigned.nonce, read)).toBe(true)
    expect(JSON.parse(read[2]).annotations.map((row: { key: string }) => row.key)).toEqual(['MARKKEY2'])

    // A restart makes a new session: the old one is refused, signed.
    await zoteroPlugin.call('shutdown', {}, REASONS.APP_SHUTDOWN)
    await zoteroPlugin.call('startup', { id: 'writeflex@example.com', rootURI: 'jar:file:///x.xpi!/', version: '1.0.0' }, REASONS.APP_STARTUP)
    const stale = signRequest(written.token, 'POST', '/writeflex/annotations/read', readBody, { session })
    const refused = await new (zoteroPlugin.endpoints['/writeflex/annotations/read']!)().init({ data: readBody, headers: stale.headers, method: 'POST' })
    expect(refused[0]).toBe(401)
    expect(answerIsSigned(written.token, stale.nonce, refused)).toBe(true)
    expect(JSON.parse(refused[2]).sessionId).not.toBe(session)

    await zoteroPlugin.call('shutdown', {}, REASONS.APP_SHUTDOWN)
    expect(Object.keys(zoteroPlugin.endpoints)).toEqual([])
  })

  test('uninstall removes the key and the bridge file; an upgrade does not', async () => {
    const zoteroPlugin = sandbox()
    await zoteroPlugin.call('startup', { version: '1.0.0' }, REASONS.APP_STARTUP)
    await zoteroPlugin.call('uninstall', {}, REASONS.ADDON_UPGRADE)
    expect(zoteroPlugin.files.size).toBe(1)
    await zoteroPlugin.call('uninstall', {}, REASONS.ADDON_UNINSTALL)
    expect(zoteroPlugin.files.size).toBe(0)
    expect(zoteroPlugin.prefs.has('extensions.writeflex.token')).toBe(false)
  })
})
