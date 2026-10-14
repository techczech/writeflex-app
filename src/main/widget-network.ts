/**
 * What the browser itself refuses a widget, beyond its frame's sandbox and policy
 * (interactive-widgets-in-documents, ticket 02, security fix round). Each of these closes a route the
 * widget's Content-Security-Policy does not cover:
 *
 *   - DNS prefetch (`<link rel=dns-prefetch>`, and the automatic kind): the browser resolves the name
 *     whatever the policy says, and a name can carry data out. Off for the whole app with Blink's
 *     `dnsPrefetchingEnabled` setting (`x-dns-prefetch-control` does not stop an explicit link).
 *   - Hyperlink auditing (`<a ping>`): off with Blink's `hyperlinkAuditingEnabled` setting.
 *   - WebRTC over UDP (STUN, TURN over UDP, host candidates): the window's WebRTC IP policy
 *     `disable_non_proxied_udp`. WriteFlex itself uses no WebRTC.
 *   - Permission prompts and grants (notifications, and every other permission): Electron grants every
 *     request by default; a request or check from a frame that is not the window's top frame and not of
 *     the app's own origin is refused.
 *
 * WebRTC over TCP (TURN over TCP and TLS) is NOT closed here: no Electron or Chromium setting reachable
 * from an iframe's window refuses it without also cutting the app's own remote loads. The agent script
 * removes the WebRTC constructors from the widget and from every frame it can reach (widget-agent-source)
 * and main refuses every navigation inside a widget's frames (navigation.ts), which together keep a
 * widget from running WebRTC in practice; see the ticket's security notes for the remaining risk.
 */

/** Blink settings for every renderer of the app (a `--blink-settings` value). */
export const WIDGET_BLINK_SETTINGS = 'dnsPrefetchingEnabled=false,hyperlinkAuditingEnabled=false'

/** WebRTC may use UDP only through a proxy; WriteFlex configures none, so it uses no UDP at all. */
export const WIDGET_WEBRTC_IP_POLICY = 'disable_non_proxied_udp' as const

type CommandLineLike = { appendSwitch(name: string, value?: string): void; getSwitchValue(name: string): string }

/** Before `ready`. Keeps any Blink settings already given and adds ours. */
export function applyWidgetNetworkSwitches(commandLine: CommandLineLike): void {
  const existing = commandLine.getSwitchValue('blink-settings').trim()
  commandLine.appendSwitch('blink-settings', existing ? `${existing},${WIDGET_BLINK_SETTINGS}` : WIDGET_BLINK_SETTINGS)
}

/** The origin of a URL as a permission request names it; '' when there is none (opaque, about:, data:). */
function originOf(raw: string | undefined): string {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol === 'file:') return 'file://'
    return url.origin === 'null' ? '' : url.origin
  } catch {
    return ''
  }
}

export type FramePermissionRequest = {
  isMainFrame: boolean
  /** The requesting frame's origin, as Electron reports it ('' or 'null' when opaque). */
  requestingOrigin?: string
  requestingUrl?: string
  /** The app shell's own URL (file:// in a build, the dev server in development). */
  shellURL: string
}

/**
 * Whether a permission request or check may go to Electron's default (which grants it). The window's
 * top frame keeps today's behaviour. Any other frame is refused unless it is of the shell's own origin
 * (the Reading Room's reader frames are); a widget's frame has an opaque origin and is always refused.
 */
export function decideFramePermission(request: FramePermissionRequest): 'default' | 'deny' {
  if (request.isMainFrame) return 'default'
  const shell = originOf(request.shellURL)
  const fromOrigin = request.requestingOrigin && request.requestingOrigin !== 'null' ? originOf(request.requestingOrigin) || request.requestingOrigin : ''
  const origin = fromOrigin || originOf(request.requestingUrl)
  if (!origin || !shell) return 'deny'
  return origin === shell ? 'default' : 'deny'
}

type PermissionDetails = { isMainFrame: boolean; requestingUrl?: string; securityOrigin?: string }
type SessionLike = {
  setPermissionRequestHandler(handler: ((webContents: unknown, permission: string, callback: (granted: boolean) => void, details: PermissionDetails) => void) | null): void
  setPermissionCheckHandler(handler: ((webContents: unknown, permission: string, requestingOrigin: string, details: PermissionDetails) => boolean) | null): void
}
type WebContentsLike = { session: SessionLike; setWebRTCIPHandlingPolicy(policy: typeof WIDGET_WEBRTC_IP_POLICY): void }

/** Per window: the WebRTC IP policy and the permission handlers of its session. */
export function applyWidgetNetworkPolicy(webContents: WebContentsLike, shellURL: string, onDenied?: (permission: string, url: string) => void): void {
  webContents.setWebRTCIPHandlingPolicy(WIDGET_WEBRTC_IP_POLICY)
  webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const decision = decideFramePermission({ isMainFrame: details.isMainFrame, requestingOrigin: details.securityOrigin, requestingUrl: details.requestingUrl, shellURL })
    if (decision === 'deny') { onDenied?.(permission, details.requestingUrl ?? ''); callback(false); return }
    callback(true) // Electron's default when no handler is set
  })
  webContents.session.setPermissionCheckHandler((_contents, _permission, requestingOrigin, details) =>
    decideFramePermission({ isMainFrame: details.isMainFrame, requestingOrigin: requestingOrigin || details.securityOrigin, requestingUrl: details.requestingUrl, shellURL }) === 'default')
}
