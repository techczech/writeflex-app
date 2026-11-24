// The Settings window's own bridge (preload/settings.ts → window.writeflexSettings), for WriteFlex's
// custom pages. Types only: the renderer page and the preload share them.
import type { SettingsChangeEntry } from './index'
import type { AuthTransport } from '@bridle/electron'

export type SettingsModelChoice = { provider: string; id: string; name: string }
export type SettingsCountedCollection = { root: string; dir: string; name: string; pieces: number }

export type WriteFlexSettingsApi = {
  /** Sign-in flows (bridle.auth:*): signing in, out and saving a key are answered only for this window. */
  auth: AuthTransport
  onContextChanged(listener: () => void): () => void
  menuFocus(plain: boolean): Promise<void>
  getStarted(): Promise<{ removed: boolean; canRestore: boolean }>
  restoreExample(): Promise<{ ok: boolean; message?: string }>
  gitSync(id:string,value:{enabled?:boolean;wait?:number}):Promise<{ok:boolean}>
  /** Whether Git can run without Apple's install dialog; `install` opens the installer, `check` asks again. */
  gitTools(action:'status'|'install'|'check'):Promise<{present:boolean}>
  context(): Promise<{ root: string | null }>
  /** The models this Mac can use (`models`), every model WriteFlex knows (`catalogue`), and the defaults. */
  models: () => Promise<{ models: SettingsModelChoice[]; catalogue: SettingsModelChoice[]; defaults: { model: { provider: string; id: string }; thinking: string } }>
  countedChanges(): Promise<(SettingsChangeEntry & { index: number })[]>
  resetCounted(change: { index: number; key: string; at: number }): Promise<SettingsCountedCollection[]>
  countedCollections: () => Promise<SettingsCountedCollection[]>
  /** Stops a Collection counting toward the Diary (the Collection's own file changes, as in the main window). */
  uncount: (root: string, dir: string) => Promise<SettingsCountedCollection[]>
  installCommandLineTool: () => Promise<{ ok: boolean; message: string }>
  /** Runs one of a few app commands in the main window (configure the action bar, open the Guide, restore the example). */
  runInMainWindow: (id: 'view.configureActionBar' | 'guide.open' | 'example.restore') => Promise<void>
}
