import type { ReaderHostWindow } from '@readflex/reader-embed'

type SnapshotView = {
  _isDynamicThemeSupported: boolean
  _iframe: { srcdoc: string }
  _iframeWindow?: unknown
  initialized?: boolean
  initializedPromise: Promise<unknown>
}
type SnapshotReader = {
  _type: string
  _primaryView: SnapshotView
  _secondaryView?: SnapshotView
  _createView(...args: unknown[]): SnapshotView
}
const refused = () => new Error('Snapshot static theme adapter refused an unsupported reader shape.')

function selectStaticTheme(value: unknown, expectedClass?: Function): Function {
  const view = value as SnapshotView | null
  const prototype = view && Object.getPrototypeOf(view)
  const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
  const flag = view && Object.getOwnPropertyDescriptor(view, '_isDynamicThemeSupported')
  if (!view || typeof constructor !== 'function' || constructor.name !== 'snapshot_view_SnapshotView'
    || (expectedClass && constructor !== expectedClass) || !flag || flag.value !== true || !flag.writable
    || view._iframeWindow !== undefined || view.initialized || view._iframe?.srcdoc !== ''
    || typeof view.initializedPromise?.then !== 'function'
    || !['_getSrcDoc', '_handleIFrameLoaded', '_updateColorScheme'].every(name =>
      typeof Object.getOwnPropertyDescriptor(prototype, name)?.value === 'function')) throw refused()
  view._isDynamicThemeSupported = false
  return constructor
}

/** Pinned SnapshotView yields in _initialize before assigning srcdoc or handling iframe load.
 * Select its existing static CSS branch synchronously on that instance, never its prototype.
 * A later split view is constructed by the same reader factory and needs the same selection.
 */
export function installSnapshotStaticTheme(win: ReaderHostWindow): void {
  const createReader = win.createReader
  if (typeof createReader !== 'function' || win._reader) throw refused()
  win.createReader = function (options) {
    if (this !== win) throw refused()
    const result = createReader.call(win, options)
    if (options.type !== 'snapshot') return result
    const reader = result as unknown as SnapshotReader
    if (!reader || reader._type !== 'snapshot' || typeof reader._createView !== 'function'
      || reader._secondaryView || Object.hasOwn(reader, '_createView')) throw refused()
    const snapshotClass = selectStaticTheme(reader._primaryView)
    const createView = reader._createView
    Object.defineProperty(reader, '_createView', { configurable: true, writable: true,
      value: function (this: SnapshotReader, ...args: unknown[]) {
        if (this !== reader) throw refused()
        const view = createView.apply(reader, args)
        selectStaticTheme(view, snapshotClass)
        return view
      } })
    return result
  }
}
