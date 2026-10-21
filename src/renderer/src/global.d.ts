import type { WriteFlexApi } from '../../preload'
declare global {
  interface Window {
    writeflex: WriteFlexApi
    /** Present only under WRITEFLEX_E2E=1. */
    __writeflexE2E?: {
      throwRendererError(): void
      /** Writes made from the page's record of unsaved text (unsaved-text.ts) fail until set back. */
      setRecoveryWrites?(behaviour: 'normal' | 'fail'): void
      setEditorSelection?(position: number, head?: number): void
      editorDoc?(): string
      editorSelection?(): { from: number; to: number; domFocused: boolean } | null
      outboxAutomaticSyncAttempts?(): number
      resetOutboxAutomaticSyncAttempts?(): void
      setStatusBarEvents?(waiting: number, rejected: number): void
      /** `hold-redo`: a suggestion redo's calls to main wait for `releaseSlowSave`; saves are not held.
       *  `hold-move`: a rename's, move's or duplicate's call to main waits likewise, after the flush.
       *  `hold-accept`: an accept's call to main waits likewise, inside the owner's route (the queue held).
       *  `hold-export`: an export waits likewise once its destination is chosen, before its final check. */
      setSaveBehaviour?(behaviour: 'normal' | 'slow' | 'fail' | 'hold-redo' | 'hold-move' | 'hold-accept' | 'hold-export'): void
      releaseSlowSave?(): void
      /** Every save the document owner has sent to main (file:save), in order: path and text. */
      savesSent?(): Array<{ path: string; content: string }>
      collectionQueryCount?(): number
      resetCollectionQueryCount?(): void
      /** Put the keyboard back in the editor at its current selection (EditorView.focus()). */
      focusEditor?(): void
      /** Widgets without the editor block (ticket 02 gate set): see widgets/widget-e2e-mount.ts. */
      mountWidget?(input: { documentPath: string; rawPath: string; height?: number }): Promise<{ ok: true; id: number; title: string } | { ok: false; reason: string }>
      widgetState?(id: number): { engaged: boolean; stopped: boolean; mounted: boolean }
      engageWidget?(id: number): void
      disengageWidget?(id: number): void
      disposeWidget?(id: number): void
      setWidgetFocusRule?(on: boolean): void
    }
  }
}
export {}
