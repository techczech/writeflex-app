import { parseFrontmatterEntries, serialiseFrontmatterEntries, type FmEntry } from '../../../../shared/object-markup'
import type { MountedEditor } from './shell'

export function mountFrontmatterEditor(source: string): MountedEditor {
  const entries = parseFrontmatterEntries(source)
  const root = document.createElement('div'); root.className = 'fme'

  const render = (): void => {
    root.replaceChildren()
    entries.forEach((entry, index) => {
      const row = document.createElement('div'); row.className = `fme-row${entry.kind === 'raw' ? ' raw' : ''}`
      if (entry.kind === 'raw') {
        const label = document.createElement('span'); label.className = 'fme-raw-label'; label.textContent = 'raw — edit in Markup'
        const sourceLine = document.createElement('pre'); sourceLine.textContent = entry.lines
        row.append(label, sourceLine); root.appendChild(row); return
      }
      const key = document.createElement('input'); key.className = 'fme-key'; key.value = entry.key; key.setAttribute('aria-label', entry.key ? `Key ${entry.key}` : `Metadata key ${index + 1}`)
      const valueLabels: HTMLElement[] = []
      // Labels TRACK the key as it is typed — a fresh "+ key" row must immediately announce
      // "Value for <key>" for keyboard/AT users (C3 review find).
      key.addEventListener('input', () => {
        entry.key = key.value
        key.setAttribute('aria-label', key.value ? `Key ${key.value}` : `Metadata key ${index + 1}`)
        for (const el of valueLabels) el.setAttribute('aria-label', el.getAttribute('aria-label')!.replace(/ (?:to|for) .*$/, ` ${el.classList.contains('fme-chip-input') ? 'to' : 'for'} ${key.value}`))
      })
      const value = document.createElement('div'); value.className = 'fme-value'
      if (entry.kind === 'scalar') {
        const input = document.createElement('input'); input.value = entry.value; input.setAttribute('aria-label', `Value for ${entry.key}`)
        valueLabels.push(input)
        input.addEventListener('input', () => { entry.value = input.value }); value.appendChild(input)
      } else {
        const chips = document.createElement('div'); chips.className = 'fme-chips'
        entry.values.forEach((item, itemIndex) => {
          const chip = document.createElement('span'); chip.className = 'chip'; chip.append(document.createTextNode(item))
          const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${item}`)
          remove.addEventListener('click', () => { entry.values.splice(itemIndex, 1); render() }); chip.appendChild(remove); chips.appendChild(chip)
        })
        const input = document.createElement('input'); input.className = 'fme-chip-input'; input.setAttribute('aria-label', `Add value to ${entry.key}`)
        valueLabels.push(input)
        const append = (): void => { const item = input.value.trim().replace(/,$/, '').trim(); if (!item) return; entry.values.push(item); render(); queueMicrotask(() => root.querySelectorAll<HTMLInputElement>('.fme-chip-input')[index]?.focus()) }
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); append() } })
        chips.appendChild(input); value.appendChild(chips)
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'fme-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `Delete ${entry.key}`)
      remove.addEventListener('click', () => { entries.splice(index, 1); render() })
      row.append(key, value, remove); root.appendChild(row)
    })
    const add = document.createElement('button'); add.type = 'button'; add.className = 'fme-add'; add.textContent = '+ key'
    add.addEventListener('click', () => { entries.push({ kind: 'scalar', key: '', value: '' }); render(); queueMicrotask(() => root.querySelectorAll<HTMLInputElement>('.fme-key')[entries.length - 1]?.focus()) })
    root.appendChild(add)
  }
  render()
  return { element: root, serialise: () => serialiseFrontmatterEntries(entries as FmEntry[]), focus: () => (root.querySelector<HTMLInputElement>('[aria-label="Value for title"]') ?? root.querySelector<HTMLInputElement>('input,button'))?.focus() }
}
