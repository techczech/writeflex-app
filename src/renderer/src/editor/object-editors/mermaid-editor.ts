export type MermaidType = 'flowchart-right' | 'flowchart-down' | 'sequence' | 'state' | 'pie'
const SKELETONS: Record<MermaidType, string> = {
  'flowchart-right': 'flowchart LR\n  A --> B',
  'flowchart-down': 'flowchart TD\n  A --> B',
  sequence: 'sequenceDiagram\n  Alice->>Bob: Hello',
  state: 'stateDiagram-v2\n  [*] --> Ready',
  pie: 'pie\n  "A" : 50\n  "B" : 50',
}
export function mermaidSkeleton(type: MermaidType): string { return SKELETONS[type] }
export function mermaidType(source: string): MermaidType | null {
  const first = source.trimStart().split('\n')[0]?.trim() ?? ''
  if (/^flowchart\s+LR\b/i.test(first)) return 'flowchart-right'
  if (/^flowchart\s+TD\b/i.test(first)) return 'flowchart-down'
  if (/^sequenceDiagram\b/i.test(first)) return 'sequence'
  if (/^stateDiagram-v2\b/i.test(first)) return 'state'
  if (/^pie\b/i.test(first)) return 'pie'
  return null
}

export const MERMAID_TYPES: Array<{ id: MermaidType; label: string }> = [
  { id: 'flowchart-right', label: 'Flowchart →' }, { id: 'flowchart-down', label: 'Flowchart ↓' },
  { id: 'sequence', label: 'Sequence' }, { id: 'state', label: 'State' }, { id: 'pie', label: 'Pie' },
]

export function mountMermaidEditor(source: string): import('./shell').MountedEditor {
  const root = document.createElement('div'); root.className = 'oe-mermaid'
  const controls = document.createElement('div'); controls.className = 'oe-mermaid-controls'
  const select = document.createElement('select'); select.className = 'typesel'; select.setAttribute('aria-label', 'Diagram type')
  MERMAID_TYPES.forEach(({ id, label }) => { const option = document.createElement('option'); option.value = id; option.textContent = label; select.append(option) })
  const area = document.createElement('textarea'); area.value = source; area.spellcheck = false
  const preview = document.createElement('div'); preview.className = 'oe-mermaid-preview'
  const error = document.createElement('div'); error.className = 'lp-render-error'; error.hidden = true
  let timer: ReturnType<typeof setTimeout> | null = null, lastGood = ''
  const detected = mermaidType(source); if (detected) select.value = detected
  const pristine = !source.trim() || MERMAID_TYPES.some(({ id }) => source.trim() === mermaidSkeleton(id))
  if (!pristine) { select.disabled = true; select.title = 'type is set by the markup' }
  const render = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void import('mermaid').then(async ({ default: mermaid }) => {
      try { const { svg } = await mermaid.render(`oe-mermaid-${crypto.randomUUID()}`, area.value); lastGood = svg; preview.innerHTML = svg; error.hidden = true }
      catch (reason) { if (lastGood) preview.innerHTML = lastGood; error.textContent = reason instanceof Error ? reason.message : String(reason); error.hidden = false }
    }).catch((reason) => { error.textContent = String(reason); error.hidden = false }), 300)
  }
  select.addEventListener('change', () => { area.value = mermaidSkeleton(select.value as MermaidType); render() })
  area.addEventListener('input', render); controls.append(select); root.append(controls, area, preview, error); render()
  return { element: root, serialise: () => area.value, focus: () => area.focus() }
}
