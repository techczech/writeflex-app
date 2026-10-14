export type NavigationDecision = 'allow' | 'external' | 'refuse'

function documentURL(raw: string): URL | null {
  try {
    const url = new URL(raw)
    url.hash = ''
    url.search = ''
    return url
  } catch {
    return null
  }
}

/** Classifies a browser navigation without importing Electron. The shell is one document; its
 * hash and query are still in-page changes, while every sibling resource is refused. */
export function decideNavigation(shellURL: string, targetURL: string): NavigationDecision {
  const target = documentURL(targetURL)
  if (!target) return 'refuse'
  if (target.protocol === 'http:' || target.protocol === 'https:') {
    const shell = documentURL(shellURL)
    if (shell && target.href === shell.href) return 'allow'
    return 'external'
  }
  const shell = documentURL(shellURL)
  return shell && target.href === shell.href ? 'allow' : 'refuse'
}

export function navigationRefusalReason(targetURL: string): string {
  try {
    const protocol = new URL(targetURL).protocol || 'unknown'
    return `Navigation target uses ${protocol} and is not the WriteFlex shell.`
  } catch {
    return 'Navigation target is not a valid URL.'
  }
}

/** Who started a navigation, as main can see it: the window's top frame, a frame with an opaque origin
 *  (a widget, or a frame a widget made), another frame inside the window, or no frame at all. */
export type NavigationInitiator = 'top' | 'opaque' | 'other' | 'none'

export type FrameNavigation = {
  isMainFrame: boolean
  isSameDocument: boolean
  initiator: NavigationInitiator
  /** The navigating frame's current origin is opaque (a widget's frame). */
  frameOpaque: boolean
  /** The navigating frame sits inside a frame with an opaque origin (a frame a widget made). */
  parentOpaque?: boolean
  url: string
}

/**
 * Whether a navigation may go ahead at all, before the shell policy (decideNavigation) is asked
 * (interactive-widgets-in-documents, ticket 02). The top window is moved only by itself or by the
 * app: a navigation of it that a frame inside it started is refused, whatever the address. A widget's
 * frame (opaque origin) is loaded only by the window's top frame (its srcdoc): any navigation a widget
 * starts, of its own frame or of a frame it made, is refused, whatever the address (a document of the
 * widget's making would run scripts the agent never saw), and so is any navigation of a frame inside a
 * widget. Only a move within the same document goes ahead.
 */
export function decideFrameNavigation(navigation: FrameNavigation): 'continue' | 'refuse' {
  if (navigation.isMainFrame) return navigation.initiator === 'top' || navigation.initiator === 'none' ? 'continue' : 'refuse'
  if (navigation.isSameDocument) return 'continue'
  if (navigation.parentOpaque || navigation.initiator === 'opaque') return 'refuse'
  if (navigation.initiator === 'top') return 'continue'
  return navigation.frameOpaque ? 'refuse' : 'continue'
}
