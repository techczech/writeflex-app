/**
 * House rule R11: one confirm card for every destructive or replacing action that has no Undo.
 * What a card says: the item, what is replaced or where it goes, how to get it back, and the one red verb.
 * The renderer draws it (components/ConfirmCard.tsx); main asks for it through the same spec when a
 * handler needs the writer's word (main/confirm-ask.ts), so there is no native message box.
 */
export type ConfirmSpec = {
  /** A question that names the item: "Restore “Draft 2” as the current document?" */
  title: string
  /** What is replaced, or where the item goes. */
  detail: string
  /** How to get it back ("Your current text is kept as a version first."). */
  recover: string
  /** The red verb on the right: "Restore", "Delete column". */
  confirmLabel: string
  cancelLabel?: string
  /** Calm blue for a replace that loses nothing; the default is red. */
  tone?: 'danger' | 'neutral'
}
