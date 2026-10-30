// A Scratchpad fragment drawn as formatted text (cards and the big preview). Derived only: the stored
// Markdown stays the payload. The app's own emitter escapes every character and checks every URL;
// relative pictures resolve from the fragment's ORIGIN folder to the app's asset protocol, remote
// pictures are not fetched (their words are kept), and the result is sanitised once more with
// DOMPurify, without the emitter's clipboard-oriented inline styles, so the panel's theme applies.
import DOMPurify from 'dompurify'
import { toHtml } from '../../../shared/markdown/to-html'

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|[/#?]|\\)/i

/** A relative picture's workspace path, read from `originPath`'s folder; null when it leaves the folder. */
export function pictureFromOrigin(src: string, originPath: string): string | null {
  if (src === '' || ABSOLUTE.test(src)) return null
  let decoded: string
  try { decoded = decodeURIComponent(src.split(/[?#]/)[0]) } catch { return null }
  const parts = originPath.split('/').slice(0, -1)
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') { if (parts.length === 0) return null; parts.pop() } else parts.push(segment)
  }
  return parts.length ? parts.join('/') : null
}

export function fragmentHtml(markdown: string, options: { originPath: string; assetBaseUrl: string | null }): string {
  const { html } = toHtml(markdown, {
    images: {
      workspaceAssetBase: options.assetBaseUrl ?? undefined,
      resolve: (src) => {
        const path = options.assetBaseUrl ? pictureFromOrigin(src, options.originPath) : null
        return path && options.assetBaseUrl ? `${options.assetBaseUrl.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}` : null
      },
    },
    widgets: 'text',
  })
  if (typeof DOMPurify.sanitize !== 'function') return html // a DOM-less test run; the emitter already escaped
  return DOMPurify.sanitize(html, { FORBID_ATTR: ['style'], ADD_URI_SAFE_ATTR: ['src'], FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'] })
}
