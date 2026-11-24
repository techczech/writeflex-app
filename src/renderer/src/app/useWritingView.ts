import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import type { SettingValue } from '../../../preload'
import type { EditorHandle } from '../components/EditorPane'
import { FIXED_LINE_PRESETS, FIXED_LINE_PRESET_LABELS, FIXED_LINE_SETTING } from '../editor/fixed-line'
import { effectiveFocusMode, FOCUS_CHIP_NAMES, type FocusMode, type LeadStyle } from '../editor/focus-modes'
import { LINE_OVERLAY_SETTINGS, normaliseRulerOpacity, RULER_OPACITY_STEP, type LineFocusSize, type RulerCovers } from '../editor/line-overlay'
import type { EditorViewMode } from '../editor/view-mode'
import { useSettings } from '../hooks/useSettings'
import { applyWritingViewSetting, DEFAULT_WRITING_VIEW, stepWritingViewZoom, toggleOverlayFollow } from './writing-view'

const LINE_WIDTH_PX: Record<string, string> = { narrow: '540px', medium: '660px', wide: '780px' }
const LINE_WIDTH_LABEL: Record<string, string> = { narrow: 'Narrow', medium: 'Medium', wide: 'Wide' }

type Options = {
  editorRef: RefObject<EditorHandle | null>
  speaking: boolean
  flash: (message: string) => void
  applySetting: (key: string, value: SettingValue | null) => void
  reportSettingsError: (error: unknown) => void
}

export function useWritingView({ editorRef, speaking, flash, applySetting, reportSettingsError }: Options) {
  const [preferences, setPreferenceState] = useState(DEFAULT_WRITING_VIEW)
  const preferencesRef = useRef(DEFAULT_WRITING_VIEW)
  const setPreferences = useCallback((next: typeof DEFAULT_WRITING_VIEW) => {
    // Hydration and commands can apply several keys before React renders.
    preferencesRef.current = next
    setPreferenceState(next)
  }, [])
  const { typewriterOn, fixedLine, viewMode, focusMode, leadStyle, lineOverlay } = preferences
  const setFixedLine = useCallback((fraction: number) => {
    setPreferences({ ...preferencesRef.current, fixedLine: fraction })
  }, [setPreferences])
  const [distractionFree, setDistractionFree] = useState(false)
  const [dfControlsVisible, setDfControlsVisible] = useState(false)

  const settings = useSettings((key, value) => {
    const next = applyWritingViewSetting(preferencesRef.current, key, value)
    if (next) {
      if (key === 'editor.typewriter') editorRef.current?.setTypewriter(next.typewriterOn)
      if (key === 'editor.viewMode') editorRef.current?.setViewMode(next.viewMode)
      setPreferences(next)
      return
    }
    if (key === 'editor.lineWidth') {
      if (value === null) document.documentElement.style.removeProperty('--prose-measure')
      else document.documentElement.style.setProperty('--prose-measure', LINE_WIDTH_PX[String(value)] ?? '660px')
      return
    }
    if (key === 'editor.proseSize') {
      if (value === null) document.documentElement.style.removeProperty('--prose-size')
      else document.documentElement.style.setProperty('--prose-size', `${String(value)}px`)
      return
    }
    applySetting(key, value)
  }, reportSettingsError)
  const { set: setSetting, values: settingValues } = settings

  const toggleTypewriter = useCallback(() => {
    const on = editorRef.current?.toggleTypewriter() ?? false
    setPreferences({ ...preferencesRef.current, typewriterOn: on })
    flash(on ? 'Typewriter on' : 'Typewriter off')
    // Persist the live choice so a relaunch keeps it — but SILENTLY (log:false): the changelog
    // documents changes made in Settings; ⌘T is a live-surface tweak, not one of those.
    setSetting('editor.typewriter', on, 'Typewriter mode', { log: false })
  }, [editorRef, flash, setPreferences, setSetting])

  // The fixed line from the palette: the three presets write the same setting as Settings → Editor.
  const chooseFixedLine = useCallback((preset: keyof typeof FIXED_LINE_PRESETS) => {
    setSetting(FIXED_LINE_SETTING, FIXED_LINE_PRESETS[preset], 'Fixed line position', { log: false })
    flash(`Fixed line: ${FIXED_LINE_PRESET_LABELS[preset].toLowerCase()}`)
  }, [flash, setSetting])
  const commitFixedLine = useCallback((fraction: number) => {
    setSetting(FIXED_LINE_SETTING, fraction, 'Fixed line position', { log: false })
  }, [setSetting])

  // Apply a focus mode exactly (the picker's semantics) and persist it silently (the ⌘T rule:
  // live-surface tweaks are not "changes made in Settings"). Both routes — picker and direct
  // commands — land here, so they stay in sync by construction.
  const chooseFocusMode = useCallback((mode: FocusMode) => {
    setPreferences({ ...preferencesRef.current, focusMode: mode })
    flash(mode === '' ? 'Focus off' : `Focus: ${FOCUS_CHIP_NAMES[mode]}`)
    setSetting('editor.focusMode', mode, 'Focus mode', { log: false })
  }, [flash, setPreferences, setSetting])

  // Direct mode commands toggle: re-invoking the active mode = Off (ADR-0028).
  const toggleFocusMode = useCallback((mode: Exclude<FocusMode, ''>) => {
    chooseFocusMode(preferencesRef.current.focusMode === mode ? '' : mode)
  }, [chooseFocusMode])

  // Picking a lead-in style also selects Anchored and keeps the picker open.
  const chooseAnchoredStyle = useCallback((style: LeadStyle) => {
    setPreferences({ ...preferencesRef.current, leadStyle: style })
    setSetting('editor.leadStyle', style, 'Anchored lead-in style', { log: false })
    if (preferencesRef.current.focusMode !== 'anchored') chooseFocusMode('anchored')
  }, [chooseFocusMode, setPreferences, setSetting])

  // Line focus and Ruler: one silent write per choice (the same rule as the focus modes).
  const chooseLineOverlay = useCallback((key: string, value: boolean | string | number, label: string) => {
    const next = applyWritingViewSetting(preferencesRef.current, key, value, 'command')
    if (next) setPreferences(next)
    setSetting(key, value, label, { log: false })
  }, [setPreferences, setSetting])
  // The two overlays are mutually exclusive: switching one on writes the other off.
  const switchOverlayOn = useCallback((which: 'lineFocus' | 'ruler') => {
    const { lineFocus, ruler } = preferencesRef.current.lineOverlay
    if (which === 'lineFocus') {
      if (ruler.on) chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerOn, false, 'Ruler')
      if (!lineFocus.on) chooseLineOverlay(LINE_OVERLAY_SETTINGS.lineFocusOn, true, 'Line focus')
    } else {
      if (lineFocus.on) chooseLineOverlay(LINE_OVERLAY_SETTINGS.lineFocusOn, false, 'Line focus')
      if (!ruler.on) chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerOn, true, 'Ruler')
    }
  }, [chooseLineOverlay])
  const toggleLineFocus = useCallback(() => {
    if (preferencesRef.current.lineOverlay.lineFocus.on) {
      chooseLineOverlay(LINE_OVERLAY_SETTINGS.lineFocusOn, false, 'Line focus')
      flash('Line focus off')
    } else {
      switchOverlayOn('lineFocus')
      flash('Line focus on')
    }
  }, [chooseLineOverlay, flash, switchOverlayOn])
  const toggleRuler = useCallback(() => {
    if (preferencesRef.current.lineOverlay.ruler.on) {
      chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerOn, false, 'Ruler')
      flash('Ruler off')
    } else {
      switchOverlayOn('ruler')
      flash('Ruler on')
    }
  }, [chooseLineOverlay, flash, switchOverlayOn])
  // The picker's switch rows route through here too, so the picker, the palette and the chips agree.
  const chooseLineFocusSize = useCallback((size: LineFocusSize) => {
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.lineFocusSize, size, 'Line focus size')
    switchOverlayOn('lineFocus')
    flash(`Line focus: ${size} ${size === 1 ? 'line' : 'lines'}`)
  }, [chooseLineOverlay, flash, switchOverlayOn])
  const chooseRulerCovers = useCallback((covers: RulerCovers) => {
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerCovers, covers, 'Ruler covers')
    switchOverlayOn('ruler')
    flash(`Ruler: ${covers === 'thin' ? 'thin rule' : covers === 'below' ? 'all below' : covers === '1' ? '1 line' : `${covers} lines`}`)
  }, [chooseLineOverlay, flash, switchOverlayOn])
  const nudgeRulerOpacity = useCallback((direction: 1 | -1) => {
    const opacity = normaliseRulerOpacity(preferencesRef.current.lineOverlay.ruler.opacity + direction * 2 * RULER_OPACITY_STEP)
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerOpacity, opacity, 'Ruler opacity')
    switchOverlayOn('ruler')
    flash(`Ruler opacity: ${opacity}%`)
  }, [chooseLineOverlay, flash, switchOverlayOn])
  // By hand is only ever an explicit choice (picker pill or this command); the command toggles it for
  // both overlays and returns them to Cursor.
  const toggleOverlayFollowByHand = useCallback(() => {
    const next = toggleOverlayFollow(preferencesRef.current, 'by-hand')
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.lineFocusFollow, next, 'Line focus follow')
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerFollow, next, 'Ruler follow')
    flash(next === 'by-hand' ? 'Line focus / Ruler: follow by hand' : 'Line focus / Ruler: follow cursor')
  }, [chooseLineOverlay, flash])
  // Typewriter follow is toggled the same way: the band stays on the typewriter line, the text moves through it.
  const toggleOverlayFollowTypewriter = useCallback(() => {
    const next = toggleOverlayFollow(preferencesRef.current, 'typewriter')
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.lineFocusFollow, next, 'Line focus follow')
    chooseLineOverlay(LINE_OVERLAY_SETTINGS.rulerFollow, next, 'Ruler follow')
    flash(next === 'typewriter' ? 'Line focus / Ruler: follow typewriter' : 'Line focus / Ruler: follow cursor')
  }, [chooseLineOverlay, flash])

  // The editor's declarative focus prop (one object identity per mode/style pair).
  const focusForEditor = useMemo(
    () => ({ mode: effectiveFocusMode(focusMode, speaking), leadStyle }),
    [focusMode, leadStyle, speaking],
  )

  const selectViewMode = useCallback((mode: EditorViewMode) => {
    if (distractionFree && mode !== 'clean') setDistractionFree(false)
    setSetting('editor.viewMode', mode, 'View mode', { log: false })
    flash(mode === 'clean' ? 'View: Clean' : mode === 'markup' ? 'View: Show markup' : 'View: Show raw')
  }, [distractionFree, flash, setSetting])

  const toggleDistractionFree = useCallback(() => {
    setDistractionFree((active) => {
      if (!active) selectViewMode('clean')
      setDfControlsVisible(false)
      return !active
    })
  }, [selectViewMode])

  // Prose zoom (Task 17, the locked View keys): ⌘+/⌘− step the prose size through 17/19/21,
  // ⌥⌘+/⌥⌘− step the line width, ⌥⌘0 resets both. Steps persist silently (the ⌘T rule) and flash.
  // From the untouched/reset default (locked 18.5px, which the Settings select shows as "19"), the
  // ladder treats the position as index-1 ('19'): the first ⌘+ → 21, the first ⌘− → 17 — each step
  // visibly changes the displayed size, matching the "19" the select already shows.
  const stepProseSize = useCallback(
    (direction: 1 | -1) => {
      const next = stepWritingViewZoom('proseSize', settingValues['editor.proseSize'], direction)
      setSetting('editor.proseSize', next, 'Prose size', { log: false })
      flash(`Prose size ${next}`)
    },
    [settingValues, setSetting, flash],
  )
  const stepLineWidth = useCallback(
    (direction: 1 | -1) => {
      const next = stepWritingViewZoom('lineWidth', settingValues['editor.lineWidth'], direction)
      setSetting('editor.lineWidth', next, 'Line width', { log: false })
      flash(`Line width ${LINE_WIDTH_LABEL[next]}`)
    },
    [settingValues, setSetting, flash],
  )
  const resetProseZoom = useCallback(() => {
    // Genuinely UNSET both keys (null) — reset means "back to the locked default" (18.5px / 660px),
    // consistent with the changelog's per-entry Reset, not a concrete 19/medium the ladder would
    // then treat as an explicit choice. Silent (log:false): key-driven tweaks never touch the log.
    setSetting('editor.proseSize', null, 'Prose size', { log: false })
    setSetting('editor.lineWidth', null, 'Line width', { log: false })
    flash('Prose zoom reset')
  }, [setSetting, flash])

  return {
    settings, typewriterOn, toggleTypewriter, fixedLine, setFixedLine, chooseFixedLine, commitFixedLine,
    viewMode, selectViewMode, distractionFree, setDistractionFree, toggleDistractionFree,
    dfControlsVisible, setDfControlsVisible, focusMode, leadStyle, focusForEditor,
    chooseFocusMode, toggleFocusMode, chooseAnchoredStyle, lineOverlay, chooseLineOverlay,
    toggleLineFocus, toggleRuler, chooseLineFocusSize, chooseRulerCovers, nudgeRulerOpacity,
    toggleOverlayFollowByHand, toggleOverlayFollowTypewriter, stepProseSize, stepLineWidth, resetProseZoom,
  }
}
