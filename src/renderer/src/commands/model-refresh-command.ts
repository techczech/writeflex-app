/**
 * "Refresh models" (fix 04, Requirement: when the provider updates its models, WriteFlex's
 * list is out of date). Palette-only and keyless, like the theme commands. Bridle does the work
 * (a forced `refreshModels`); this only reports the result through the status-bar flash.
 */
import type { ModelRefreshResult } from '../../../shared/model-refresh'
import { describeModelRefresh, lastCheckedLine } from '../../../shared/model-refresh'

export const REFRESH_MODELS_COMMAND = {
  id: 'agent.refreshModels',
  label: 'Refresh models',
  keywords: ['models', 'model list', 'update', 'new models', 'provider', 'catalogue', 'check'],
} as const

/** Runs the refresh and flashes "Refreshing models…", then the result with its last-checked time. */
export async function runRefreshModelsCommand(
  refresh: () => Promise<ModelRefreshResult>,
  flash: (message: string) => void,
  now: () => number = Date.now,
): Promise<void> {
  flash('Refreshing models…')
  try {
    const result = await refresh()
    // A reused check already says "Checked just now"; the last-checked suffix would repeat it.
    flash(result.reused ? describeModelRefresh(result) : `${describeModelRefresh(result)} · ${lastCheckedLine(result.checked, now())}`)
  } catch (error: unknown) {
    flash(`Couldn't refresh models: ${error instanceof Error ? error.message : String(error)}`)
  }
}
