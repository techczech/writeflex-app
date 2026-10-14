function lines(text: string): string[] { return text.replace(/\r/g, '').split('\n') }
function depth(line: string): number { return Math.floor((/^\s*/.exec(line)?.[0].length ?? 0) / 2) }
function subtreeEnd(items: string[], index: number): number {
  const base = depth(items[index] ?? '')
  let end = index + 1
  while (end < items.length && depth(items[end]) > base) end += 1
  return end
}
export function newSibling(text: string, index: number): { text: string; index: number } {
  const items = lines(text), at = index + 1
  // Inherit the FOLLOWING line's depth when it is deeper: ↵ below a parent creates a CHILD of that
  // node instead of a root-level line that silently adopts the parent's existing children (walk ask
  // 2026-07-12: "no way to go back up and add a child node to an intermediate node").
  const own = depth(items[index] ?? '')
  const next = at < items.length ? depth(items[at]) : own
  const prefix = '  '.repeat(Math.max(own, next))
  items.splice(at, 0, `${prefix}- `)
  return { text: items.join('\n'), index: at }
}
export function indentNode(text: string, index: number): string {
  const items = lines(text); if (index <= 0) return text
  const end = subtreeEnd(items, index), currentDepth = depth(items[index]), targetDepth = Math.min(currentDepth + 1, depth(items[index - 1]) + 1)
  const shift = targetDepth - currentDepth; if (!shift) return text
  items.splice(index, end - index, ...items.slice(index, end).map((line) => `${'  '.repeat(Math.max(0, depth(line) + shift))}${line.trimStart()}`)); return items.join('\n')
}
export function outdentNode(text: string, index: number): string {
  const items = lines(text); if (!/^\s{2}/.test(items[index] ?? '')) return text
  const end = subtreeEnd(items, index); items.splice(index, end - index, ...items.slice(index, end).map((line) => line.slice(2))); return items.join('\n')
}
export function moveNode(text: string, index: number, delta: -1 | 1): string {
  const items = lines(text), end = subtreeEnd(items, index), block = items.slice(index, end), base = depth(items[index] ?? '')
  if (delta < 0) {
    let previous = index - 1; while (previous >= 0 && depth(items[previous]) > base) previous -= 1
    if (previous < 0 || depth(items[previous]) !== base) return text
    items.splice(index, block.length); items.splice(previous, 0, ...block)
  } else {
    let next = end; while (next < items.length && depth(items[next]) > base) next += 1
    if (next >= items.length || depth(items[next]) !== base) return text
    const nextEnd = subtreeEnd(items, next), nextBlock = items.slice(next, nextEnd)
    items.splice(index, nextEnd - index, ...nextBlock, ...block)
  }
  return items.join('\n')
}

export function mountMarkmapEditor(source: string): import('./shell').MountedEditor {
  let value = source, active = 0
  const root = document.createElement('div'); root.className = 'oe-outline'
  const render = (): void => {
    root.replaceChildren()
    lines(value).forEach((line, index) => {
      const row = document.createElement('div'); row.className = 'oe-node'; row.style.setProperty('--depth', String(depth(line)))
      const dot = document.createElement('span'); dot.className = 'oe-node-dot'; dot.textContent = '•'
      const input = document.createElement('input'); input.value = line.replace(/^\s*-\s?/, ''); input.dataset.node = String(index)
      input.addEventListener('focus', () => { active = index })
      input.addEventListener('input', () => { const all = lines(value); all[index] = `${'  '.repeat(depth(all[index]))}- ${input.value}`; value = all.join('\n') })
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); const result = newSibling(value, index); value = result.text; active = result.index; render(); focus() }
        else if (event.key === 'Tab') { event.preventDefault(); value = event.shiftKey ? outdentNode(value, index) : indentNode(value, index); render(); focus() }
        else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); const delta = event.key === 'ArrowUp' ? -1 : 1; value = moveNode(value, index, delta); active = Math.max(0, Math.min(lines(value).length - 1, index + delta)); render(); focus() }
        else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault(); active = Math.max(0, Math.min(lines(value).length - 1, index + (event.key === 'ArrowUp' ? -1 : 1))); focus()
        }
      })
      row.append(dot, input); root.append(row)
    })
  }
  const focus = (): void => root.querySelector<HTMLInputElement>(`input[data-node="${active}"]`)?.focus()
  render(); return { element: root, serialise: () => value, focus }
}
