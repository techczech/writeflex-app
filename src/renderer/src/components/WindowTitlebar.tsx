import type { CSSProperties, ComponentPropsWithoutRef } from 'react'
import { TRAFFIC_LIGHT_INSET } from '../../../shared/window-chrome'
import './window-titlebar.css'

export function WindowTitlebar({ className, style, ...props }: ComponentPropsWithoutRef<'div'>): JSX.Element {
  const inset = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? TRAFFIC_LIGHT_INSET : 12
  return <div {...props} className={`window-titlebar ${className ?? ''}`} style={{ ...style, '--window-controls-inset': `${inset}px` } as CSSProperties} />
}
