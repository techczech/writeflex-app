import { normaliseTableMarkup, parseTable, serialiseTable, type TableModel } from '../../../../shared/object-markup'
import { TABLE_COMMAND_LABELS } from '../../commands/table-command-labels'
export { normaliseTableMarkup, parseTable, repairTable, serialiseTable, type TableAlignment, type TableModel } from '../../../../shared/object-markup'

export function parseTablePaste(text: string): string[][] {
  const parsed = parseTable(text)
  if (parsed) return parsed.cells
  return text.replace(/\r/g, '').split('\n').map((row) => row.split('\t'))
}

export function moveColumn(table: TableModel, column: number, delta: -1 | 1): TableModel {
  const target = column + delta
  if (target < 0 || target >= table.alignments.length) return table
  const cells = table.cells.map((row) => { const next = [...row]; [next[column], next[target]] = [next[target], next[column]]; return next })
  const alignments = [...table.alignments]; [alignments[column], alignments[target]] = [alignments[target], alignments[column]]
  return { cells, alignments }
}
export function moveRow(table: TableModel, row: number, delta: -1 | 1): TableModel {
  const target = row + delta
  if (row === 0 || target < 1 || target >= table.cells.length) return table
  const cells = table.cells.map((item) => [...item]); [cells[row], cells[target]] = [cells[target], cells[row]]
  return { ...table, cells }
}

export function mountTableEditor(source: string): import('./shell').MountedEditor {
  let model = parseTable(source) ?? { cells: [['']], alignments: ['left'] }
  let browse = false, current = { row: 0, column: 0 }
  const host = document.createElement('div'); host.className = 'tge-wrap'
  const controller = new AbortController()
  const sizeTextareas = (): void => host.querySelectorAll<HTMLTextAreaElement>('.tge textarea').forEach((area) => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px` })
  const resizeObserver = new ResizeObserver(sizeTextareas)
  const closeMenu = (): void => host.querySelector('.fm-menu')?.remove()
  document.addEventListener('mousedown', (event) => {
    const target = event.target as HTMLElement
    if (!target.closest('.fm-menu') && !target.closest('.colmenu')) closeMenu()
  }, { capture: true, signal: controller.signal })
  const openColumnMenu = (anchor: HTMLButtonElement, column: number): void => {
    closeMenu()
    const menu = document.createElement('div'); menu.className = 'fm-menu col-actions'; menu.role = 'menu'; menu.tabIndex = -1
    const choices = [['left', TABLE_COMMAND_LABELS.alignLeft], ['center', TABLE_COMMAND_LABELS.alignCentre], ['right', TABLE_COMMAND_LABELS.alignRight], ['insert-left', TABLE_COMMAND_LABELS.insertLeft], ['insert-right', TABLE_COMMAND_LABELS.insertRight], ['delete', TABLE_COMMAND_LABELS.delete]]
    choices.forEach(([action, label], index) => {
      if (index === 3 || index === 5) menu.append(document.createElement('hr'))
      const item = document.createElement('button'); item.type = 'button'; item.className = `fm-item${action === 'delete' ? ' danger' : ''}`; item.role = 'menuitem'; item.textContent = label
      item.addEventListener('click', () => { closeMenu(); columnAction(column, action) }); menu.append(item)
    })
    const rect = anchor.getBoundingClientRect(); menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 208, rect.right - 200))}px`; menu.style.top = `${rect.bottom + 4}px`
    menu.addEventListener('keydown', (event) => {
      event.stopPropagation()
      const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')], current = items.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(); anchor.focus() }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus() }
    })
    host.append(menu); menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }
  const render = (): void => {
    closeMenu()
    host.replaceChildren()
    const table = document.createElement('table'); table.className = 'tge'
    model.cells.forEach((row, rowIndex) => {
      const tr = table.insertRow()
      row.forEach((value, columnIndex) => {
        const td = rowIndex === 0 ? document.createElement('th') : document.createElement('td')
        const area = document.createElement('textarea'); area.rows = 1; area.value = value; area.dataset.row = String(rowIndex); area.dataset.column = String(columnIndex)
        if (browse && rowIndex === current.row && columnIndex === current.column) { td.classList.add('sel'); area.tabIndex = -1 }
        area.addEventListener('focus', () => { current = { row: rowIndex, column: columnIndex }; browse = false })
        area.addEventListener('input', () => { model.cells[rowIndex][columnIndex] = area.value; sizeTextareas() })
        area.addEventListener('paste', (event) => {
          const text = event.clipboardData?.getData('text/plain') ?? ''; if (!text.includes('\t') && !parseTable(text)) return
          event.preventDefault(); const pasted = parseTablePaste(text)
          const rows = Math.max(model.cells.length, rowIndex + pasted.length), cols = Math.max(model.alignments.length, columnIndex + Math.max(...pasted.map((item) => item.length)))
          while (model.cells.length < rows) model.cells.push(Array(model.alignments.length).fill(''))
          while (model.alignments.length < cols) { model.alignments.push('left'); model.cells.forEach((item) => item.push('')) }
          pasted.forEach((pasteRow, r) => pasteRow.forEach((cellValue, c) => { model.cells[rowIndex + r][columnIndex + c] = cellValue }))
          render(); focusCell(rowIndex, columnIndex)
        })
        area.addEventListener('keydown', (event) => onCellKey(event, rowIndex, columnIndex))
        td.append(area)
        if (rowIndex === 0) {
          const menu = document.createElement('button'); menu.type = 'button'; menu.className = 'colmenu'; menu.textContent = '▾'; menu.setAttribute('aria-label', `Column ${columnIndex + 1} menu`)
          menu.addEventListener('click', () => openColumnMenu(menu, columnIndex)); td.append(menu)
        }
        tr.append(td)
      })
    })
    host.append(table); queueMicrotask(sizeTextareas)
    const add = document.createElement('div'); add.className = 'addbar'
    const row = document.createElement('button'); row.textContent = '+ row'; row.onclick = () => { model.cells.push(Array(model.alignments.length).fill('')); render(); focusCell(model.cells.length - 1, 0) }
    const column = document.createElement('button'); column.textContent = '+ column'; column.onclick = () => { model.alignments.push('left'); model.cells.forEach((item) => item.push('')); render(); focusCell(0, model.alignments.length - 1) }
    add.append(row, column); host.append(add)
  }
  const focusCell = (row: number, column: number): void => host.querySelector<HTMLTextAreaElement>(`textarea[data-row="${row}"][data-column="${column}"]`)?.focus()
  const columnAction = (column: number, action: string): void => {
    if (action === 'left' || action === 'center' || action === 'right') model.alignments[column] = action
    else if (action === 'insert-left' || action === 'insert-right') { const at = column + (action === 'insert-right' ? 1 : 0); model.alignments.splice(at, 0, 'left'); model.cells.forEach((row) => row.splice(at, 0, '')) }
    else if (action === 'delete' && model.alignments.length > 1 && confirm('Delete this column?')) { model.alignments.splice(column, 1); model.cells.forEach((row) => row.splice(column, 1)) }
    render()
  }
  const onCellKey = (event: KeyboardEvent, row: number, column: number): void => {
    const modMove = event.shiftKey && event.metaKey
    if (modMove && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); const delta = event.key === 'ArrowLeft' ? -1 : 1; model = moveColumn(model, column, delta); current.column = Math.max(0, Math.min(model.alignments.length - 1, column + delta)); render(); focusCell(row, current.column); return }
    if (modMove && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); const delta = event.key === 'ArrowUp' ? -1 : 1; model = moveRow(model, row, delta); current.row = Math.max(0, Math.min(model.cells.length - 1, row + delta)); render(); focusCell(current.row, column); return }
    if (event.key === 'Tab') { event.preventDefault(); let index = row * model.alignments.length + column + (event.shiftKey ? -1 : 1); if (index >= model.cells.length * model.alignments.length) { model.cells.push(Array(model.alignments.length).fill('')); render() } index = Math.max(0, index); focusCell(Math.floor(index / model.alignments.length), index % model.alignments.length) }
  }
  const enterBrowse = (): boolean => { if (browse) return false; browse = true; render(); host.focus(); return true }
  host.tabIndex = 0
  resizeObserver.observe(host)
  host.addEventListener('keydown', (event) => {
    if (!browse) return
    const delta = event.key === 'ArrowLeft' ? [0, -1] : event.key === 'ArrowRight' ? [0, 1] : event.key === 'ArrowUp' ? [-1, 0] : event.key === 'ArrowDown' ? [1, 0] : null
    if (delta) { event.preventDefault(); current = { row: Math.max(0, Math.min(model.cells.length - 1, current.row + delta[0])), column: Math.max(0, Math.min(model.alignments.length - 1, current.column + delta[1])) }; render(); host.focus() }
    else if (event.key === 'Enter' || (event.key.length === 1 && !event.metaKey && !event.ctrlKey)) { event.preventDefault(); browse = false; render(); focusCell(current.row, current.column); if (event.key.length === 1) document.execCommand('insertText', false, event.key) }
  })
  render()
  return { element: host, serialise: () => serialiseTable(model), focus: () => focusCell(0, 0), onEscape: enterBrowse, destroy: () => { resizeObserver.disconnect(); controller.abort() } }
}
