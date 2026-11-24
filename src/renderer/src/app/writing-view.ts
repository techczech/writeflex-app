import type { SettingValue } from '../../../preload'
import { FIXED_LINE_DEFAULT, FIXED_LINE_SETTING, normaliseFixedLine } from '../editor/fixed-line'
import { normaliseFocusMode, normaliseLeadStyle, type FocusMode, type LeadStyle } from '../editor/focus-modes'
import {
  applyLineOverlaySetting,
  DEFAULT_LINE_OVERLAY,
  LINE_OVERLAY_SETTINGS,
  resolveExclusive,
  type LineFollow,
  type LineOverlayConfig,
} from '../editor/line-overlay'
import { normaliseEditorViewMode, type EditorViewMode } from '../editor/view-mode'

type WritingViewPreferences = {
  typewriterOn: boolean
  fixedLine: number
  viewMode: EditorViewMode
  focusMode: FocusMode
  leadStyle: LeadStyle
  lineOverlay: LineOverlayConfig
}

export const DEFAULT_WRITING_VIEW: WritingViewPreferences = {
  typewriterOn: false,
  fixedLine: FIXED_LINE_DEFAULT,
  viewMode: 'clean',
  focusMode: '',
  leadStyle: 'contrast',
  lineOverlay: DEFAULT_LINE_OVERLAY,
}

export function applyWritingViewSetting(
  current: WritingViewPreferences,
  key: string,
  value: SettingValue | null,
  source: 'setting' | 'command' = 'setting',
): WritingViewPreferences | null {
  switch (key) {
    case 'editor.typewriter': return { ...current, typewriterOn: value === true }
    case FIXED_LINE_SETTING: return { ...current, fixedLine: normaliseFixedLine(value) }
    case 'editor.viewMode': return { ...current, viewMode: normaliseEditorViewMode(value) }
    case 'editor.focusMode': return { ...current, focusMode: normaliseFocusMode(value) }
    case 'editor.leadStyle': return { ...current, leadStyle: normaliseLeadStyle(value) }
  }

  const overlay = applyLineOverlaySetting(current.lineOverlay, key, value)
  if (!overlay) return null
  // Stored conflicts resolve to line focus in either order. A direct command can select the ruler.
  const prefersRuler = key === LINE_OVERLAY_SETTINGS.rulerOn
    && (source === 'command' || (value === true && !current.lineOverlay.lineFocus.on))
  return { ...current, lineOverlay: resolveExclusive(overlay, prefersRuler ? 'ruler' : 'lineFocus') }
}

export function toggleOverlayFollow(
  { lineOverlay: { lineFocus, ruler } }: WritingViewPreferences,
  follow: Extract<LineFollow, 'by-hand' | 'typewriter'>,
): typeof follow | 'cursor' {
  const active = lineFocus.on || !ruler.on ? lineFocus : ruler
  return active.follow === follow ? 'cursor' : follow
}

const ZOOM_STEPS = {
  proseSize: ['17', '19', '21'],
  lineWidth: ['narrow', 'medium', 'wide'],
}

export function stepWritingViewZoom(
  axis: keyof typeof ZOOM_STEPS,
  value: SettingValue | undefined,
  direction: 1 | -1,
): string {
  const steps = ZOOM_STEPS[axis]
  const index = steps.indexOf(String(value))
  // The untouched prose size is 18.5px, but the keyboard ladder starts at its middle ('19').
  return steps[Math.min(Math.max((index === -1 ? 1 : index) + direction, 0), steps.length - 1)]
}
