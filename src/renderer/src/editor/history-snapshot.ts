import { ChangeSet, StateEffect, Transaction, type ChangeDesc, type StateEffectType, type Text } from '@codemirror/state'

/**
 * Undo/redo snapshots of position-bearing state (the writer-review ledger), kept exact by CodeMirror's
 * own history changes — never by comparing document texts.
 *
 * A snapshot is taken for a transaction `tr` and restores the state `tr.startState` held. Its value is
 * in the coordinates of the document the undo returns to; `inverse` is `tr.changes.invertedDesc`,
 * running from the document after `tr` (the history event's "current" document) to that target.
 *
 * @codemirror/commands calls an effect's `map` from exactly two places, told apart by the mapping's
 * type and asserted by length (length alone is ambiguous when a transaction keeps the length):
 *
 * (a) mapEvent (index.js:462-469), for a change that is not an undo step (a disk reconcile). The
 *     mapping is a plain ChangeDesc from the event's current document. As mapEvent does for
 *     startSelection, it is rebased over the inverse (`mapping.mapDesc(inverse, true)`: target → new
 *     target) to map the value, and the inverse is carried forward (`inverse.mapDesc(mapping)`).
 * (b) addChanges (index.js:491), when CodeMirror joins this transaction's event onto the previous one
 *     (typing within newGroupDelay). The mapping is the previous event's inverse ChangeSet, from this
 *     snapshot's target to the joined event's target. The exact value for the joined event is the
 *     PREVIOUS event's snapshot value (the state before the whole group), used when that snapshot's
 *     inverse is exactly the mapping. Otherwise the value is mapped by the caller's untracked rule.
 *
 * After a join CodeMirror keeps the older effects of the event, unmapped and no longer describing it.
 * The YOUNGEST snapshot effect of a transaction is therefore the one that counts (`pick`); older ones
 * are inert, and `map` drops them silently when a later reconcile no longer fits them. `map` never
 * throws and never reports: whether a snapshot fits is checked once, on the one that is restored.
 *
 * A snapshot restores only what its step touched (`touchedIds`, computed by the caller when the
 * snapshot is taken): records of those ids come back from the snapshot, and every other live record
 * stays as it is. An undo therefore never overwrites a record its own step did not change, however
 * many reconciles or absorbed undos came between.
 *
 * All bookkeeping is branch-safe: editor states are values and may be updated more than once (a
 * scratch resolution, a cached tab), so nothing here mutates shared knowledge about a snapshot. The
 * previous snapshot is re-derived from the document chain of the branch being extended.
 */
/** `touchedIds`: the records the snapshot's step (or joined group of steps) changed. */
export type HistorySnapshot<I> = {
  readonly value: readonly I[]
  readonly inverse: ChangeDesc
  readonly touchedIds: ReadonlySet<string>
}

export type HistorySnapshots<I> = {
  readonly effect: StateEffectType<HistorySnapshot<I>>
  /** The snapshot effect to return from invertedEffects for `tr`: `value` is tr.startState's ledger,
   *  `touchedIds` the records `tr` changed. */
  snapshot(value: readonly I[], tr: Transaction, touchedIds: ReadonlySet<string>): StateEffect<HistorySnapshot<I>>
  /** Call for every transaction: records a non-history change so later snapshots can follow it. */
  note(tr: Transaction): void
  /** The snapshot a transaction restores: its youngest snapshot effect, if any. */
  pick(tr: Transaction): HistorySnapshot<I> | null
  /**
   * Split a restore, in `tr.newDoc` coordinates: `keep` the live records (already carried through
   * `tr`) the step did not touch, and `restored` the snapshot's records it did. Null (reported) when
   * the snapshot does not fit `tr`; the caller then keeps all live records.
   */
  restore(snapshot: HistorySnapshot<I>, tr: Transaction, live: readonly I[]): { keep: I[]; restored: I[] } | null
}

function sameDesc(a: ChangeDesc, b: ChangeDesc): boolean {
  return a.length === b.length &&
    a.newLength === b.newLength &&
    JSON.stringify(a.toJSON()) === JSON.stringify(b.toJSON())
}

export function historySnapshots<I>(opts: {
  kind: string
  idOf: (item: I) => string
  /** The caller's untracked mapping rule — the same one its live field applies. Must not report. */
  mapValue: (value: readonly I[], changes: ChangeDesc) => I[]
  report: (message: string) => void
}): HistorySnapshots<I> {
  // Per transaction, keyed by its own new document (unique to that transaction):
  const takenFor = new WeakMap<Text, HistorySnapshot<I>>() // the snapshot it took
  const joinedFor = new WeakMap<Text, HistorySnapshot<I>>() // what that snapshot became on a join
  const previousOf = new WeakMap<HistorySnapshot<I>, HistorySnapshot<I>>()
  const newDocOf = new WeakMap<HistorySnapshot<I>, Text>()
  // A non-history change's new document → where it came from and how.
  const carried = new WeakMap<Text, { from: Text; changes: ChangeDesc }>()

  const rebase = (snapshot: HistorySnapshot<I>, mapping: ChangeDesc): HistorySnapshot<I> => ({
    value: opts.mapValue(snapshot.value, mapping.mapDesc(snapshot.inverse, true)),
    inverse: snapshot.inverse.mapDesc(mapping),
    touchedIds: snapshot.touchedIds,
  })

  /** The top event's youngest snapshot as this branch's history holds it when `doc` is current. */
  const previousFor = (doc: Text): HistorySnapshot<I> | undefined => {
    const reconciles: ChangeDesc[] = []
    let at = doc
    for (let link = carried.get(at); link; link = carried.get(at)) {
      reconciles.unshift(link.changes)
      at = link.from
    }
    let snapshot = joinedFor.get(at) ?? takenFor.get(at)
    for (const changes of reconciles) {
      if (!snapshot || changes.length !== snapshot.inverse.length) return undefined
      snapshot = rebase(snapshot, changes)
    }
    return snapshot
  }

  const map = (snapshot: HistorySnapshot<I>, mapping: ChangeDesc): HistorySnapshot<I> | undefined => {
    try {
      if (!(mapping instanceof ChangeSet)) {
        return mapping.length === snapshot.inverse.length ? rebase(snapshot, mapping) : undefined
      }
      if (mapping.length !== snapshot.inverse.newLength) return undefined
      const previous = previousOf.get(snapshot)
      const inverse = snapshot.inverse.composeDesc(mapping)
      // The joined event touched what any of its steps touched.
      const touchedIds = new Set([...snapshot.touchedIds, ...(previous?.touchedIds ?? [])])
      const joined: HistorySnapshot<I> = previous && sameDesc(previous.inverse, mapping.desc)
        ? { value: previous.value, inverse, touchedIds }
        : { value: opts.mapValue(snapshot.value, mapping), inverse, touchedIds }
      const doc = newDocOf.get(snapshot)
      if (doc) joinedFor.set(doc, joined)
      return joined
    } catch {
      return undefined
    }
  }

  const effect = StateEffect.define<HistorySnapshot<I>>({ map })

  return {
    effect,
    snapshot(value, tr, touchedIds) {
      const taken: HistorySnapshot<I> = { value, inverse: tr.changes.invertedDesc, touchedIds }
      const previous = previousFor(tr.startState.doc)
      if (previous) previousOf.set(taken, previous)
      // An effect-only step (a fold that changes no text) shares the live document object: it must not
      // overwrite that document's bookkeeping, which belongs to the step that produced it.
      if (tr.docChanged) {
        takenFor.set(tr.newDoc, taken)
        joinedFor.delete(tr.newDoc)
        newDocOf.set(taken, tr.newDoc)
      }
      return effect.of(taken)
    },
    note(tr) {
      if (tr.docChanged && tr.annotation(Transaction.addToHistory) === false) {
        carried.set(tr.newDoc, { from: tr.startState.doc, changes: tr.changes.desc })
      }
    },
    pick(tr) {
      const found = tr.effects.find((candidate) => candidate.is(effect))
      return found ? (found.value as HistorySnapshot<I>) : null
    },
    restore(snapshot, tr, live) {
      if (snapshot.inverse.newLength === tr.newDoc.length) {
        const touched = snapshot.touchedIds
        return {
          keep: live.filter((item) => !touched.has(opts.idOf(item))),
          restored: snapshot.value.filter((item) => touched.has(opts.idOf(item))),
        }
      }
      opts.report(`[WriteFlex] Ignored a ${opts.kind} undo snapshot for a ${snapshot.inverse.newLength}-character document; the undo produced ${tr.newDoc.length}.`)
      return null
    },
  }
}
