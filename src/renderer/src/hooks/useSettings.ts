import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsChangeEntry, SettingsRecord, SettingValue } from '../../../preload'

export type UseSettings = {
  /** The stored values (unset keys absent — the surface's default applies). */
  values: SettingsRecord
  /** The settings changelog, newest first (the Changelog section renders this). */
  changelog: SettingsChangeEntry[]
  /**
   * Set a key: persists through `settings:set`, records a changelog entry (unless `log: false` —
   * live-surface tweaks like ⌘T that are not "changes made in Settings"), and fires the applier so
   * the effect lands immediately. `value: null` UNSETS the key — the local value is deleted (so it
   * reads as untouched again) and the applier removes its effect (the ⌥⌘0 reset path).
   */
  set: (key: string, value: SettingValue | null, label: string, opts?: { log?: boolean }) => void
  /**
   * Reset a changelog entry (the per-entry Reset): the store reverts the value and marks the entry
   * spent; the applier re-fires with the reverted-to value (null = the default), so the effect —
   * theme, typewriter chip, editor vars — genuinely follows the log row. The mockup's semantics:
   * no mirror entry; the row dims with a ` · reset` marker.
   */
  revert: (index: number) => void
  /** Re-read values and changelog after a main-owned setting action (for example a Counted mark). */
  refresh: () => void
}

/**
 * The window's settings state (Task 17). One instance lives in App; `apply` is App's effect
 * applier — called once per stored key on hydrate (boot-time theme/editor application) and again
 * after every set/revert. Appliers must be idempotent; main-side-effect keys (permissions,
 * snapshots) simply have no applier case.
 */
export function useSettings(apply: (key: string, value: SettingValue | null) => void, onError?: (error: unknown) => void): UseSettings {
  const [values, setValues] = useState<SettingsRecord>({})
  // A mirror of `values` a subscription can read without re-subscribing on every change.
  const valuesRef = useRef<SettingsRecord>({})
  valuesRef.current = values
  const [changelog, setChangelog] = useState<SettingsChangeEntry[]>([])
  // The applier routes through a ref so this hook's callbacks stay stable while App re-renders.
  const applyRef = useRef(apply)
  applyRef.current = apply

  const refresh = useCallback(() => {
    let cancelled = false
    void Promise.all([window.writeflex.getSettings(), window.writeflex.getSettingsChangelog()])
      .then(([record, log]) => {
        if (cancelled) return
        setValues(record)
        setChangelog(log)
        // Boot-time application: every persisted choice takes effect on this window now.
        for (const [key, value] of Object.entries(record)) applyRef.current(key, value)
      })
      .catch(() => {
        /* settings are convenience state — a failed pull leaves every surface on its default */
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => refresh(), [refresh])

  // A setting is app-level state, so a write in ANOTHER window is a write here (ADR-0040: the action
  // bar is one global boolean — two windows must never disagree). The window that made the change
  // has already applied it optimistically; appliers are idempotent, so hearing it again is free.
  useEffect(
    () =>
      window.writeflex.onSettingChanged(({ key, value }) => {
        const current = valuesRef.current[key] ?? null
        if (current === value) return // our own write echoing back, or a no-op set elsewhere
        setValues((prev) => {
          if (value === null) {
            const next = { ...prev }
            delete next[key]
            return next
          }
          return { ...prev, [key]: value }
        })
        applyRef.current(key, value)
      }),
    [],
  )

  const set = useCallback((key: string, value: SettingValue | null, label: string, opts?: { log?: boolean }) => {
    // Optimistic local update + immediate effect; the invoke's reply reconciles the changelog.
    // A null value UNSETS the key — delete it locally (mirroring revert) so it reads as untouched,
    // then the applier drops the effect back to the surface's default.
    setValues((prev) => {
      if (value === null) {
        const next = { ...prev }
        delete next[key]
        return next
      }
      return { ...prev, [key]: value }
    })
    applyRef.current(key, value)
    window.writeflex
      .setSetting(key, value, label, opts)
      .then(({ changelog: log }) => setChangelog(log))
      .catch(() => {
        /* a failed persist keeps the live effect for this session; the next boot re-reads disk */
      })
  }, [])

  const revert = useCallback((index: number) => {
    void window.writeflex
      .revertSetting(index)
      .then(({ entry, changelog: log }) => {
        setChangelog(log)
        if (!entry) return // spent or out-of-range: the refreshed log already shows the truth
        setValues((prev) => {
          const next = { ...prev }
          if (entry.old === null) delete next[entry.key]
          else next[entry.key] = entry.old
          return next
        })
        // Re-fire the effect with the reverted-to value — the honest half of Reset.
        applyRef.current(entry.key, entry.old)
      })
      .catch((error: unknown) => onError?.(error))
  }, [onError])

  return { values, changelog, set, revert, refresh: () => { void refresh() } }
}
