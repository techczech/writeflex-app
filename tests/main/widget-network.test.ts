// What the browser itself refuses a widget (interactive-widgets ticket 02, security fix round): Blink
// settings for DNS prefetch and hyperlink auditing, the WebRTC IP policy, and permissions for frames
// that are not the app's own. The e2e gate set (widget-sealed-frame.spec.ts) proves each route closed.
import { expect, test } from 'bun:test'
import { applyWidgetNetworkPolicy, applyWidgetNetworkSwitches, decideFramePermission, WIDGET_BLINK_SETTINGS } from '../../src/main/widget-network'

const shellURL = 'file:///Applications/WriteFlex.app/Contents/Resources/app.asar/out/renderer/index.html'

test('Blink settings: no DNS prefetch and no hyperlink auditing, added to any settings already given', () => {
  expect(WIDGET_BLINK_SETTINGS.split(',').sort()).toEqual(['dnsPrefetchingEnabled=false', 'hyperlinkAuditingEnabled=false'])
  const switches = new Map<string, string>()
  const commandLine = { appendSwitch: (name: string, value = '') => { switches.set(name, value) }, getSwitchValue: (name: string) => switches.get(name) ?? '' }
  applyWidgetNetworkSwitches(commandLine)
  expect(switches.get('blink-settings')).toBe(WIDGET_BLINK_SETTINGS)
  switches.set('blink-settings', 'imagesEnabled=true')
  applyWidgetNetworkSwitches(commandLine)
  expect(switches.get('blink-settings')).toBe(`imagesEnabled=true,${WIDGET_BLINK_SETTINGS}`)
})

test('permissions: the top frame keeps the default; a widget frame (opaque) is always refused', () => {
  expect(decideFramePermission({ isMainFrame: true, shellURL })).toBe('default')
  expect(decideFramePermission({ isMainFrame: true, requestingUrl: 'about:srcdoc', shellURL })).toBe('default')
  for (const request of [
    { requestingUrl: 'about:srcdoc' },
    { requestingOrigin: 'null', requestingUrl: 'about:srcdoc' },
    { requestingOrigin: '' },
    { requestingUrl: 'data:text/html,x' },
    { requestingUrl: 'blob:null/1234' },
    { requestingOrigin: 'https://example.com', requestingUrl: 'https://example.com/' },
    {},
  ]) expect(decideFramePermission({ isMainFrame: false, shellURL, ...request }), JSON.stringify(request)).toBe('deny')
  // A frame of the app's own origin (the Reading Room's reader frames) keeps the default.
  expect(decideFramePermission({ isMainFrame: false, requestingOrigin: 'file://', requestingUrl: 'about:srcdoc', shellURL })).toBe('default')
  expect(decideFramePermission({ isMainFrame: false, requestingUrl: 'file:///Applications/WriteFlex.app/x.html', shellURL })).toBe('default')
  // In development the shell is the dev server.
  expect(decideFramePermission({ isMainFrame: false, requestingOrigin: 'http://localhost:5173', shellURL: 'http://localhost:5173/' })).toBe('default')
  expect(decideFramePermission({ isMainFrame: false, requestingOrigin: 'http://localhost:5174', shellURL: 'http://localhost:5173/' })).toBe('deny')
})

test('per window: the WebRTC IP policy, and handlers that refuse a widget and keep the top frame', () => {
  let policy = ''
  let request: ((contents: unknown, permission: string, callback: (granted: boolean) => void, details: { isMainFrame: boolean; requestingUrl?: string; securityOrigin?: string }) => void) | null = null
  let check: ((contents: unknown, permission: string, origin: string, details: { isMainFrame: boolean; requestingUrl?: string }) => boolean) | null = null
  const denied: string[] = []
  applyWidgetNetworkPolicy({
    setWebRTCIPHandlingPolicy: (value) => { policy = value },
    session: { setPermissionRequestHandler: (handler) => { request = handler }, setPermissionCheckHandler: (handler) => { check = handler } },
  }, shellURL, (permission) => denied.push(permission))
  expect(policy).toBe('disable_non_proxied_udp')
  const answers: boolean[] = []
  request!(null, 'notifications', (granted) => answers.push(granted), { isMainFrame: false, requestingUrl: 'about:srcdoc' })
  request!(null, 'clipboard-read', (granted) => answers.push(granted), { isMainFrame: true, requestingUrl: shellURL })
  expect(answers).toEqual([false, true])
  expect(denied).toEqual(['notifications'])
  expect(check!(null, 'notifications', '', { isMainFrame: false, requestingUrl: 'about:srcdoc' })).toBe(false)
  expect(check!(null, 'notifications', 'file://', { isMainFrame: true })).toBe(true)
})
