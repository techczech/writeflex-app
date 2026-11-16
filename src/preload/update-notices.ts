import { ipcRenderer } from 'electron'
import type { WhatsNewItem } from '@app-patterns/updates'
import type { UpdateSnapshot } from '../shared/update-checker'

export const updateNoticesApi = {
  updates: {
    setProtected: (active: boolean): Promise<void> => ipcRenderer.invoke('updates:protected', active),
    /** What this window holds that a restart would cost (ADR-0054): two flags, nothing else. */
    setHolds: (holds: { unsaved: boolean; diskChoice: boolean }): Promise<void> => ipcRenderer.invoke('updates:holds', { unsaved: holds.unsaved === true, diskChoice: holds.diskChoice === true }),
    get: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:get'),
    /** Check for Updates…: always checks (a Store copy and a development run answer without a request). */
    check: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:check'),
    skip: (version: string): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:skip', version),
    stopSkipping: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:stop-skipping'),
    notNow: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:not-now'),
    /** Update (ADR-0054): download the offered version for this computer, check it, then restart (or wait to). Takes
     *  only the version the person saw: main starts nothing when the offer is now another one. */
    update: (version: string): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:update', typeof version === 'string' ? version : ''),
    /** Stop a download in progress, or one waiting for a restart; the file is deleted. Takes nothing. */
    cancel: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:cancel'),
    /** Restart to finish updating: only when nothing holds it back. Takes nothing. */
    restart: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:restart'),
    download: (): Promise<boolean> => ipcRenderer.invoke('updates:download'),
    openNotes: (version: string): Promise<boolean> => ipcRenderer.invoke('updates:open-notes', version),
    openStore: (): Promise<boolean> => ipcRenderer.invoke('updates:open-store'),
    /** The notes shipped for the running version, or null. */
    whatsNew: (): Promise<{ version: string; from: string | null; items: WhatsNewItem[] } | null> => ipcRenderer.invoke('updates:whats-new'),
    dismissWhatsNew: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:dismiss-whats-new'),
    onChange: (cb: (snapshot: UpdateSnapshot) => void): (() => void) => {
      const listener = (_e: unknown, snapshot: UpdateSnapshot): void => cb(snapshot)
      ipcRenderer.on('updates:changed', listener)
      return () => ipcRenderer.removeListener('updates:changed', listener)
    },
    /** The answer of a Check for Updates… that waited for protected writing to end. */
    onAnswer: (cb: (snapshot: UpdateSnapshot) => void): (() => void) => {
      const listener = (_e: unknown, snapshot: UpdateSnapshot): void => cb(snapshot)
      ipcRenderer.on('updates:answered', listener)
      return () => ipcRenderer.removeListener('updates:answered', listener)
    }
  },
}
