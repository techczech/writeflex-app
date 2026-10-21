import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, CircleAlert, FileCode, FileCog, FileJson, FileSpreadsheet, FileText, Folder, FolderInput, FolderOpen, FolderPlus, Info, Link2, MoveRight, Undo2 } from 'lucide-react'
import { initialOwnFolderChoice, planFingerprint, planOwnFolder, type OwnFolderChoice, type OwnFolderFacts, type TreeRow } from '../../../shared/own-folder-plan'

/**
 * The sheet shown after Create and insert when the document is in no Folio (locked drawing
 * docs/design/2026-10-20-folio-on-widget-insert/mockup-folio-on-widget-insert.html; contracts §14 C5). Nothing is
 * written until the main button: it hands the writer's choice to the engine, which carries out the same plan
 * (shared/own-folder-plan.ts) the sheet draws. Cancel and Esc close it with nothing changed.
 *
 * One addition to the drawing (Dominik, 2026-10-20): when documents move and the widget reads a data file, a small
 * choice asks whether the data file is copied into the widget's folder (the default) or moved with the documents.
 */
export type OwnFolderSheetProps = {
  facts: OwnFolderFacts
  busy?: boolean
  /** Shown at the top: why the sheet is shown again (the folder changed since it was last drawn). */
  notice?: string
  onCancel: () => void
  onConfirm: (choice: OwnFolderChoice) => void
}

const ROW_ICON: Record<TreeRow['kind'], typeof FileText> = { folder: Folder, doc: FileText, data: FileSpreadsheet, json: FileJson, html: FileCode, recipe: FileCog }

function Tree(props: { rows: TreeRow[]; testId: string }): JSX.Element {
  return (
    <div className="fs-tree" data-testid={props.testId}>
      {props.rows.map((row, index) => {
        const Icon = row.kind === 'folder' && row.open ? FolderOpen : ROW_ICON[row.kind]
        return (
          <div key={`${index}-${row.name}`} className={`fs-node${row.kind === 'folder' ? ' is-folder' : ''}${row.tag ? ` ${row.tag}` : ''}${row.dim ? ' dim' : ''}${row.pending ? ' pending' : ''}`} style={{ paddingLeft: 6 + row.depth * 16 }} data-row={row.name}>
            <span className="ord">{row.order ?? ''}</span>
            <Icon className="icon" aria-hidden="true" />
            <span className="fn">{row.name}</span>
            {row.note && <span className="what">{row.note}</span>}
            {row.tag && <span className={`fs-tag ${row.tag}`}>{row.tag}</span>}
          </div>
        )
      })}
    </div>
  )
}

const joinNames = (names: string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

export function OwnFolderSheet({ facts, busy = false, notice, onCancel, onConfirm }: OwnFolderSheetProps): JSX.Element {
  const [choice, setChoice] = useState<OwnFolderChoice>(() => initialOwnFolderChoice(facts))
  const plan = useMemo(() => planOwnFolder(facts, choice), [facts, choice])
  const nameInput = useRef<HTMLInputElement | null>(null)
  const sheet = useRef<HTMLElement | null>(null)
  const focusAfter = useRef<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onCancel])
  useEffect(() => { sheet.current?.querySelector<HTMLInputElement>('input[name="fs-mode"]:checked')?.focus() }, [])
  useEffect(() => {
    if (focusAfter.current === null) return
    const again = sheet.current?.querySelector<HTMLButtonElement>(focusAfter.current)
    focusAfter.current = null
    if (again && !again.disabled) again.focus()
  })

  const included = plan.documents
  const set = (patch: Partial<OwnFolderChoice>): void => setChoice((current) => ({ ...current, ...patch }))
  const swap = (name: string, dir: -1 | 1): void => {
    const position = included.indexOf(name)
    const other = included[position + dir]
    if (other === undefined) return
    const order = [...plan.listOrder]
    const a = order.indexOf(name)
    const b = order.indexOf(other)
    order[a] = other
    order[b] = name
    focusAfter.current = `[data-${dir < 0 ? 'up' : 'down'}="${CSS.escape(name)}"]`
    set({ order })
  }
  const n = included.length
  const others = facts.documents
  const listOrder = plan.listOrder
  // The answer carries the fingerprint of the very plan drawn here: the engine refuses it over a folder that changed.
  const go = (): void => {
    if (!plan.ready || busy) return
    const answer = { ...choice, order: listOrder }
    onConfirm({ ...answer, fingerprint: planFingerprint(planOwnFolder(facts, answer)) })
  }

  return (
    <div className="overlay open fs-scrim" data-testid="own-folder-sheet-scrim">
      <section ref={sheet} className="sheet fs-sheet" role="dialog" aria-modal="true" aria-labelledby="fs-title" data-testid="own-folder-sheet">
        <header>
          <div><FolderInput className="icon" aria-hidden="true" /><h2 id="fs-title" data-testid="own-folder-title">{plan.title}</h2></div>
          <span className="fs-nothing-yet">Nothing on disk has changed yet</span>
        </header>
        {notice && <div className="fs-changed" role="status" data-testid="own-folder-changed"><CircleAlert className="icon" aria-hidden="true" /><span>{notice}</span></div>}
        <div className="fs-body">
          <div className="fs-left">
            <p className="fs-lead">
              The <b>{facts.widgetTitle}</b> widget keeps its data and display files in a folder called <b>visualisations</b>.{' '}
              {plan.inPlace
                ? <>You have chosen every document in <b>{facts.folderLabel}</b>, so nothing moves: the new files are added beside your documents.</>
                : <>To keep them apart from the rest of <b>{facts.folderLabel}</b>, {n === 1 ? <><b>{facts.document}</b> moves</> : <>the {n} chosen documents move</>} into a new folder there, with the widget.</>}
            </p>
            <fieldset className="fs-choices">
              <legend className="fs-h">Which documents belong in it?</legend>
              <div className={`fs-choice${choice.mode === 'one' ? ' on' : ''}`}>
                <label>
                  <input type="radio" name="fs-mode" value="one" checked={choice.mode === 'one'} onChange={() => set({ mode: 'one' })} data-testid="own-folder-just-this" />
                  <b>Just this document</b>
                  <span>Only {facts.document} moves.{others.length > 0 ? ` ${joinNames(others)} ${others.length === 1 ? 'stays' : 'stay'} where ${others.length === 1 ? 'it is' : 'they are'}.` : ''}</span>
                </label>
              </div>
              <div className={`fs-choice${choice.mode === 'several' ? ' on' : ''}`}>
                <label>
                  <input type="radio" name="fs-mode" value="several" checked={choice.mode === 'several'} onChange={() => set({ mode: 'several' })} data-testid="own-folder-several" />
                  <b>Other documents here belong with it</b>
                  <span>Tick the documents that form one piece of work with {facts.document}. They move together.</span>
                </label>
                {choice.mode === 'several' && (
                  <div className="fs-docs" role="list" aria-label={`Documents in ${facts.folderLabel}`} data-testid="own-folder-documents">
                    {listOrder.map((name) => {
                      const on = included.includes(name)
                      const position = included.indexOf(name)
                      const self = name === facts.document
                      return (
                        <div key={name} className={`fs-doc${on ? '' : ' off'}`} role="listitem" data-doc-row={name}>
                          <input type="checkbox" checked={on} disabled={self} aria-label={self ? `${name} always goes` : `Move ${name} with it`} data-doc={name}
                            onChange={(event) => set({ checked: event.target.checked ? [...choice.checked, name] : choice.checked.filter((item) => item !== name) })} />
                          <span className="num">{on ? position + 1 : ''}</span>
                          <span className="nm"><FileText className="icon" aria-hidden="true" /><span>{name}</span>{!self && !on && <small>stays where it is</small>}</span>
                          <span className="mv">{on && (
                            <>
                              <button type="button" data-up={name} disabled={position === 0} aria-label={`Move ${name} earlier in the reading order`} title="Earlier in the reading order" onClick={() => swap(name, -1)}><ArrowUp className="icon" aria-hidden="true" /></button>
                              <button type="button" data-down={name} disabled={position === n - 1} aria-label={`Move ${name} later in the reading order`} title="Later in the reading order" onClick={() => swap(name, 1)}><ArrowDown className="icon" aria-hidden="true" /></button>
                            </>
                          )}</span>
                        </div>
                      )
                    })}
                    <div className="fs-doc-hint">{others.length === 0 ? `There are no other documents in ${facts.folderLabel}.` : 'Ticked documents are read in the numbered order. Use the arrows to change it.'}</div>
                  </div>
                )}
              </div>
            </fieldset>
            {plan.inPlace ? (
              <div className="fs-inplace" data-testid="own-folder-in-place"><Info className="icon" aria-hidden="true" /><div><b>{facts.folderLabel}</b> stays where it is and keeps its name. No document moves. The files marked <span className="fs-tag new">new</span> on the right are added to it.</div></div>
            ) : (
              <div className="fs-name">
                <label htmlFor="fs-name-input">Name of the new folder</label>
                <input id="fs-name-input" ref={nameInput} value={choice.name} spellCheck={false} data-testid="own-folder-name"
                  aria-invalid={plan.nameProblem ? 'true' : undefined} aria-describedby={plan.nameProblem ? 'fs-name-error' : undefined}
                  onChange={(event) => set({ name: event.target.value })} />
                {plan.nameProblem ? (
                  <div className="fs-error" id="fs-name-error" role="alert" data-testid="own-folder-name-error">
                    <CircleAlert className="icon" aria-hidden="true" />
                    <div>{plan.nameProblem.text}{plan.nameProblem.suggest && <><br /><button type="button" className="control" data-testid="own-folder-use-suggestion" onClick={() => { set({ name: plan.nameProblem!.suggest! }); nameInput.current?.focus() }}>Use “{plan.nameProblem.suggest}”</button></>}</div>
                  </div>
                ) : <div className="muted">Made inside {facts.folderLabel}. You can rename it later in the Files list.</div>}
              </div>
            )}
            {plan.dataFile.asked && (
              <fieldset className="fs-choices fs-data" data-testid="own-folder-data-file">
                <legend className="fs-h">The widget's data file, {facts.source?.split('/').at(-1)}</legend>
                <div className={`fs-choice fs-choice-small${choice.dataFile === 'copy' ? ' on' : ''}`}>
                  <label><input type="radio" name="fs-data" value="copy" checked={choice.dataFile === 'copy'} onChange={() => set({ dataFile: 'copy' })} data-testid="own-folder-data-copy" /><b>Copy it into the widget's folder (the original stays)</b></label>
                </div>
                <div className={`fs-choice fs-choice-small${choice.dataFile === 'move' ? ' on' : ''}`}>
                  <label><input type="radio" name="fs-data" value="move" checked={choice.dataFile === 'move'} onChange={() => set({ dataFile: 'move' })} data-testid="own-folder-data-move" /><b>Move it with the documents</b></label>
                </div>
              </fieldset>
            )}
            <p className="fs-folio-word">WriteFlex calls a folder of documents read in order a Folio. There is nothing else to set up.</p>
          </div>
          <div className="fs-right">
            <div className="fs-disk-head"><h3>What happens on disk</h3><div className="fs-legend"><span className="fs-tag moves">moves</span><span className="fs-tag new">new</span><span className="fs-tag copy">copy</span></div></div>
            <div className="fs-cols">
              <div className="fs-col"><h4>Now</h4><Tree rows={plan.before} testId="own-folder-before" /></div>
              <div className="fs-arrow"><MoveRight className="icon" aria-hidden="true" /></div>
              <div className="fs-col"><h4>After {plan.inPlace ? 'Insert widget' : 'Move and insert'}</h4><Tree rows={plan.after} testId="own-folder-after" /></div>
            </div>
            <p className="fs-order-note" data-testid="own-folder-order-note">{plan.documents.map((name, i) => <span key={name}>{i > 0 ? ' · ' : ''}<b>{i + 1}</b> {name}</span>)}{plan.orderTail}</p>
          </div>
        </div>
        <footer>
          <div className="fs-notes">
            <div><Undo2 className="icon" aria-hidden="true" /><span>One Undo (⌘Z) puts every file back where it was and removes the widget.</span></div>
            <div><Link2 className="icon" aria-hidden="true" /><span>{plan.linkNote}</span></div>
          </div>
          <div>
            <button type="button" className="control" data-testid="own-folder-cancel" disabled={busy} onClick={onCancel}>Cancel</button>
            <button type="button" className="control primary" data-testid="own-folder-go" disabled={!plan.ready || busy} onClick={go}>
              {plan.inPlace ? <Check className="icon" aria-hidden="true" /> : <FolderPlus className="icon" aria-hidden="true" />}{plan.primary}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
