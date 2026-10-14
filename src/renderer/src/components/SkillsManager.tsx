import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Skill, SkillLoadError } from '@bridle/core'
import {
  AlertTriangle,
  Check,
  FileText,
  MessageSquare,
  Pencil,
  Search,
  X,
} from 'lucide-react'
import type { SkillMeta } from '../../../preload'
import {
  ScopeIcon,
  orderSkills,
  scopeChipsForTools,
  skillDisplayName,
  skillDisplayNameFor,
  skillIcon,
} from './AgentSkillSurfaces'

type SkillsManagerProps = {
  skills: SkillMeta[]
  errors: SkillLoadError[]
  initialName?: string
  /** Allows the first paint to be complete when the selected skill is already known. */
  initialSkill?: Skill | null
  onRegistryChanged: (result: { skills: SkillMeta[]; errors: SkillLoadError[] }) => void
  onClose: () => void
}

type Selection = { kind: 'skill'; name: string } | { kind: 'error'; source: string }
type Proposal = { current: string; proposed: string }
type DiffLine = { kind: 'equal' | 'added' | 'removed'; text: string }

export function filterSkills(skills: readonly SkillMeta[], query: string): SkillMeta[] {
  const needle = query.trim().toLocaleLowerCase()
  const ordered = orderSkills(skills)
  if (!needle) return ordered
  return ordered.filter((skill) => `${skillDisplayName(skill)} ${skill.description}`.toLocaleLowerCase().includes(needle))
}

export function skillSourceTail(source: string, name?: string): string {
  const normalised = source.replace(/\\/g, '/')
  const skillsIndex = normalised.lastIndexOf('/skills/')
  if (skillsIndex >= 0) return normalised.slice(skillsIndex + 1)
  return name ? `skills/${name}/SKILL.md` : normalised.split('/').slice(-3).join('/')
}

export function activeSkillForPath(
  skills: readonly SkillMeta[],
  workspaceRoot: string | null | undefined,
  activePath: string | null,
): SkillMeta | null {
  if (!workspaceRoot || !activePath) return null
  // macOS exposes these system directories through aliases, while Workspace roots use realpath.
  // Compare the two spellings without exposing filesystem access to the renderer. Keep the full
  // remaining path: a matching skill name in a different directory is not provenance.
  const normalise = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')
    .replace(/^\/private\/(var|tmp|etc)(?=\/|$)/, '/$1')
  const activeSource = `${normalise(workspaceRoot)}/${normalise(activePath).replace(/^\/+/, '')}`
  return skills.find((skill) => normalise(skill.source) === activeSource) ?? null
}

function splitDiffLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** A deterministic line LCS is enough for SKILL.md: the proposal must expose every removed and
 * added instruction, while unchanged lines stay quiet. */
export function buildSkillLineDiff(current: string, proposed: string): DiffLine[] {
  const before = splitDiffLines(current)
  const after = splitDiffLines(proposed)
  const lengths = Array.from({ length: before.length + 1 }, () => Array<number>(after.length + 1).fill(0))
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = before[left] === after[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1])
    }
  }
  const out: DiffLine[] = []
  let left = 0
  let right = 0
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      out.push({ kind: 'equal', text: before[left] })
      left += 1
      right += 1
    } else if (left < before.length && (right >= after.length || lengths[left + 1][right] >= lengths[left][right + 1])) {
      out.push({ kind: 'removed', text: before[left] })
      left += 1
    } else {
      out.push({ kind: 'added', text: after[right] })
      right += 1
    }
  }
  return out
}

export function SkillEditProposal({
  current,
  proposed,
  applying,
  onApply,
  onDiscard,
}: {
  current: string
  proposed: string
  applying: boolean
  onApply: () => void
  onDiscard: () => void
}): JSX.Element {
  const lines = buildSkillLineDiff(current, proposed)
  return (
    <div className="skill-edit-proposal">
      <div className="skill-manager-label">Proposed change to SKILL.md</div>
      <div className="skill-diff" role="region" aria-label="Proposed SKILL.md changes">
        {lines.map((line, index) => (
          <div className={`skill-diff-line ${line.kind}`} key={`${index}:${line.kind}`}>
            <span aria-hidden="true">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>{' '}{line.text || ' '}
          </div>
        ))}
      </div>
      <div className="skill-manager-actions">
        <button type="button" className="ghost primary" disabled={applying} onClick={onApply}>
          <Check className="icon sm" aria-hidden="true" />{applying ? 'Applying…' : 'Apply'}
        </button>
        <button type="button" className="ghost" disabled={applying} onClick={onDiscard}>Discard</button>
        <small>applies on the skill's next run</small>
      </div>
    </div>
  )
}

export function SkillProvenanceBelt({ skill }: { skill: SkillMeta | null }): JSX.Element | null {
  if (!skill) return null
  const Icon = skillIcon(skill.icon)
  return (
    <div className="skill-provenance-belt" role="status">
      <Icon className="icon sm" aria-hidden="true" />
      <span>This file defines the <strong>{skillDisplayName(skill)}</strong> skill · changes apply on its next run</span>
      <span className="gap" />
      <span className="skill-source-chip" title={skill.source}>{skillSourceTail(skill.source, skill.name)}</span>
    </div>
  )
}

function humanSkillEditReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/could not propose|parseable fence|rephras/i.test(message)) return 'The agent could not propose a change. Try rephrasing.'
  if (/auth|sign[ -]?in|provider|model|api[ -]?key|credential/i.test(message)) {
    return 'No working model is available. Check Account & Model in Settings.'
  }
  return 'The request did not finish. Try again.'
}

export function SkillsManager({
  skills,
  errors,
  initialName,
  initialSkill = null,
  onRegistryChanged,
  onClose,
}: SkillsManagerProps): JSX.Element {
  const firstName = skills.some((skill) => skill.name === initialName) ? initialName as string : orderSkills(skills)[0]?.name
  const [selection, setSelection] = useState<Selection | null>(() => firstName
    ? { kind: 'skill', name: firstName }
    : errors[0] ? { kind: 'error', source: errors[0].source } : null)
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<Skill | null>(() => initialSkill?.name === firstName ? initialSkill : null)
  const [detailLoading, setDetailLoading] = useState(detail === null && selection?.kind === 'skill')
  const [mode, setMode] = useState<'view' | 'ask'>('view')
  const [request, setRequest] = useState('')
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [proposing, setProposing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [actionError, setActionError] = useState('')
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const filterRef = useRef<HTMLInputElement | null>(null)

  const selectedMeta = selection?.kind === 'skill'
    ? skills.find((skill) => skill.name === selection.name) ?? null
    : null
  const selectedError = selection?.kind === 'error'
    ? errors.find((error) => error.source === selection.source) ?? null
    : null
  const visibleSkills = useMemo(() => filterSkills(skills, query), [query, skills])

  useEffect(() => { filterRef.current?.focus() }, [])

  useEffect(() => {
    if (selection?.kind !== 'skill') {
      setDetail(null)
      setDetailLoading(false)
      return
    }
    if (detail?.name === selection.name) return
    let cancelled = false
    setDetailLoading(true)
    setActionError('')
    void window.writeflex.skills.get(selection.name).then((result) => {
      if (cancelled) return
      setDetail(result.skill)
      if (!result.skill) setActionError(`${skillDisplayNameFor(selection.name, skills)} could not be read.`)
    }).catch(() => {
      if (!cancelled) setActionError(`${skillDisplayNameFor(selection.name, skills)} could not be read.`)
    }).finally(() => {
      if (!cancelled) setDetailLoading(false)
    })
    return () => { cancelled = true }
  }, [detail?.name, selection])

  const selectSkill = useCallback((name: string) => {
    setSelection({ kind: 'skill', name })
    setDetail((current) => current?.name === name ? current : null)
    setMode('view')
    setProposal(null)
    setRequest('')
    setActionError('')
  }, [])

  const submitRequest = useCallback(async () => {
    if (!selectedMeta || !request.trim() || proposing) return
    setProposing(true)
    setProposal(null)
    setActionError('')
    try {
      setProposal(await window.writeflex.skills.proposeEdit(selectedMeta.name, request.trim()))
    } catch (error) {
      setActionError(`${skillDisplayName(selectedMeta)}'s editor could not run — ${humanSkillEditReason(error)}`)
    } finally {
      setProposing(false)
    }
  }, [proposing, request, selectedMeta])

  const applyProposal = useCallback(async () => {
    if (!selectedMeta || !proposal || applying) return
    setApplying(true)
    setActionError('')
    try {
      await window.writeflex.skills.applyEdit(selectedMeta.name, proposal.proposed)
      const [nextDetail, nextRegistry] = await Promise.all([
        window.writeflex.skills.get(selectedMeta.name),
        window.writeflex.skills.list(),
      ])
      setDetail(nextDetail.skill)
      onRegistryChanged(nextRegistry)
      setMode('view')
      setProposal(null)
      setRequest('')
    } catch (error) {
      setActionError(`${skillDisplayName(selectedMeta)} could not be updated — ${humanSkillEditReason(error)}`)
    } finally {
      setApplying(false)
    }
  }, [applying, onRegistryChanged, proposal, selectedMeta])

  const editByHand = useCallback(async () => {
    if (!selectedMeta) return
    setActionError('')
    try {
      await window.writeflex.skills.openForEditing(selectedMeta.name)
      onClose()
    } catch (error) {
      setActionError(`${skillDisplayName(selectedMeta)} could not be opened — ${humanSkillEditReason(error)}`)
    }
  }, [onClose, selectedMeta])

  function onDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('input, button')).filter(
      (element) => element.offsetParent !== null && !element.hasAttribute('disabled'),
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault()
      first.focus()
    }
  }

  const HeaderIcon = selectedMeta ? skillIcon(selectedMeta.icon) : selectedError ? AlertTriangle : FileText
  const title = selectedMeta ? skillDisplayName(selectedMeta) : selectedError ? 'Skill could not load' : 'Skills'
  const source = selectedMeta?.source ?? selectedError?.source ?? ''

  return (
    <div
      ref={dialogRef}
      className="overlay open"
      role="dialog"
      aria-modal="true"
      aria-label="Manage skills"
      tabIndex={-1}
      onKeyDown={onDialogKeyDown}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="sheet skills-manager-sheet">
        <header className="skills-manager-head">
          <HeaderIcon className={`icon${selectedError ? ' amber' : ''}`} aria-hidden="true" />
          <strong>{title}</strong>
          {source && <span className="skill-source-chip" title={source}>{skillSourceTail(source, selectedMeta?.name)}</span>}
          <span className="gap" />
          <button type="button" className="icon-button" onClick={onClose} title="Close skills manager (Esc)" aria-label="Close skills manager">
            <X className="icon sm" aria-hidden="true" />
          </button>
        </header>
        <div className="skills-manager-body">
          <nav className="skills-manager-list" aria-label="Skills">
            <div className="skills-filter">
              <Search className="icon sm" aria-hidden="true" />
              <input
                ref={filterRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter…"
                aria-label="Filter skills"
              />
            </div>
            <div className="skills-manager-rows" role="listbox" aria-label="Available skills">
              {visibleSkills.map((skill) => {
                const Icon = skillIcon(skill.icon)
                const active = selection?.kind === 'skill' && selection.name === skill.name
                return (
                  <button
                    type="button"
                    className="skills-manager-row"
                    aria-selected={active}
                    role="option"
                    key={skill.name}
                    onClick={() => selectSkill(skill.name)}
                    title={`${skillDisplayName(skill)} — ${skill.description}`}
                  >
                    <Icon className="icon sm" aria-hidden="true" />
                    <span>{skillDisplayName(skill)}</span>
                  </button>
                )
              })}
              {visibleSkills.length === 0 && <p className="skills-manager-empty">No skills match “{query}”.</p>}
            </div>
            {errors.length > 0 && (
              <div className="skills-manager-errors" aria-label="Skills that could not load">
                {errors.map((error) => (
                  <button
                    type="button"
                    className="skills-manager-row error"
                    aria-selected={selection?.kind === 'error' && selection.source === error.source}
                    role="option"
                    key={`${error.source}:${error.message}`}
                    onClick={() => { setSelection({ kind: 'error', source: error.source }); setMode('view'); setActionError('') }}
                    title={`${error.source}: ${error.message}`}
                  >
                    <AlertTriangle className="icon sm" aria-hidden="true" />
                    <span>{error.message}</span>
                  </button>
                ))}
              </div>
            )}
          </nav>
          <section className="skills-manager-detail" aria-live="polite">
            {selectedError ? (
              <div className="skill-load-detail">
                <AlertTriangle className="icon amber" aria-hidden="true" />
                <h2>This skill could not load</h2>
                <p>{selectedError.message}</p>
                <code title={selectedError.source}>{selectedError.source}</code>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void window.writeflex.showItem(selectedError.source).catch(() => setActionError('The skill file could not be revealed in Finder.'))}
                >Reveal in Finder</button>
              </div>
            ) : selectedMeta && (detail || detailLoading) ? (
              <>
                {detailLoading && !detail ? <div className="skills-manager-loading">Reading SKILL.md…</div> : null}
                {detail && mode === 'view' && (
                  <>
                    <div className="skill-manager-label">What it does</div>
                    <p className="skill-manager-description">{detail.description}</p>
                    <div className="skill-manager-label">Tools it may use</div>
                    <div className="skill-scope-chips manager">
                      {scopeChipsForTools(detail.tools, { input: detail.input }).map((chip) => (
                        <span className="skill-scope-chip" key={chip.kind}><ScopeIcon kind={chip.kind} />{chip.label}</span>
                      ))}
                    </div>
                    <div className="skill-manager-label">Instructions</div>
                    <pre className="skill-instructions">{detail.instructions}</pre>
                    <div className="skill-manager-actions view-actions">
                      <button type="button" className="ghost" onClick={() => { setMode('ask'); setActionError('') }}>
                        <MessageSquare className="icon sm" aria-hidden="true" />Ask the agent to change it
                      </button>
                      <button type="button" className="ghost" onClick={() => void editByHand()}>
                        <Pencil className="icon sm" aria-hidden="true" />Edit by hand
                      </button>
                    </div>
                    <p className="skill-file-note">A skill is a file. Edits apply the next time the skill runs.</p>
                  </>
                )}
                {detail && mode === 'ask' && (
                  <>
                    <form className="skill-edit-console" onSubmit={(event) => { event.preventDefault(); void submitRequest() }}>
                      <MessageSquare className="icon sm" aria-hidden="true" />
                      <input
                        autoFocus
                        value={request}
                        onChange={(event) => setRequest(event.target.value)}
                        placeholder={`What should ${skillDisplayName(detail)} do differently?`}
                        aria-label={`What should ${skillDisplayName(detail)} do differently?`}
                        disabled={proposing}
                      />
                      {proposing && <span className="skills-manager-working">thinking…</span>}
                    </form>
                    {proposal && (
                      <SkillEditProposal
                        current={proposal.current}
                        proposed={proposal.proposed}
                        applying={applying}
                        onApply={() => void applyProposal()}
                        onDiscard={() => { setMode('view'); setProposal(null); setRequest(''); setActionError('') }}
                      />
                    )}
                    {!proposal && !proposing && <p className="skill-edit-hint">Press ↵ to ask for a visible change to this file.</p>}
                  </>
                )}
              </>
            ) : (
              <div className="skills-manager-loading">No skill selected.</div>
            )}
            {actionError && <div className="skills-manager-action-error" role="status">{actionError}</div>}
          </section>
        </div>
      </div>
    </div>
  )
}
