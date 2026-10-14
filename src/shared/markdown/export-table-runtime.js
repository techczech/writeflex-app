/* Tables in an exported HTML file: column types, number alignment, and for large tables search,
   three-state sorting and one filter per column. Lifted from the locked design
   (docs/design/export-tables-sort-filter-search/locked-export-table-runtime.js, 2026-10-13) and
   emitted once, as an inline classic script after the document body, when the page holds at least
   one table region (a div with the class wf-table-region).

   The table's content is untrusted: a cell may have been pasted from anywhere. So this script
   - puts text into the page only with textContent and DOM methods, never by parsing a string as HTML
     (the two icons are built element by element);
   - never builds a regular expression, a selector or an option value from cell text;
   - has no network request, no storage, no code built from a string, no inline event attribute and
     no message listener;
   - reads and changes only tables that sit directly in a .wf-table-region of this document. A widget's
     tables are in another document (an iframe) and are never reached. */
(() => {
  'use strict'
  const CONTROLS_ABOVE_ROWS = 8 // a table with 8 body rows or fewer gets formatting only
  // A table wider than this gets formatting only: its controls would be one sort button and one filter per
  // column, and a pasted table can be 20,000 columns wide.
  const CONTROLS_MAX_COLUMNS = 200
  const PICK_LIST_MAX_VALUES = 8
  const ANNOUNCE_DELAY_MS = 400
  // No number or date in a recognised format is longer than this; a longer cell is text without being parsed.
  const TYPED_CELL_MAX_LENGTH = 40
  const TEXT = {
    search: 'Search this table',
    searchNamed: (caption) => `Search: ${caption}`,
    clear: 'Clear filters',
    rows: (total) => `${total} ${total === 1 ? 'row' : 'rows'}`,
    rowsOf: (shown, total) => `${shown} of ${total} rows`,
    ofRows: (total) => ` of ${total} rows`,
    noMatch: 'No rows match.',
    contains: 'Contains…',
    min: 'Min',
    max: 'Max',
    all: 'All',
    anyMonth: 'Any month',
    empty: '(empty)',
    filterContains: (column) => `Filter ${column}: contains`,
    filterMin: (column) => `Filter ${column}: minimum`,
    filterMax: (column) => `Filter ${column}: maximum`,
    filterPick: (column) => `Filter ${column}`,
    sortBy: (column) => `Sort by ${column}`,
    sorted: (column, direction) => `Sorted by ${column}, ${direction}.`,
    unsorted: 'Original order.',
    column: (n) => `Column ${n}`,
    region: 'Table',
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const DOTS = ['#0f766e', '#4f5fd0', '#b97d10', '#a14b8f', '#2f7fb8', '#7a8a2a', '#c2553d', '#5b6472']
  const SVG = 'http://www.w3.org/2000/svg'
  const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

  const clean = (text) => text.replace(/\s+/g, ' ').trim()
  /** Lower case, accents removed: "Česky" matches "cesky". */
  const fold = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag)
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
    if (text !== undefined) node.textContent = text
    return node
  }
  /** Move every child of one node into another, one at a time: a spread (append(...childNodes)) passes one
   *  argument per child and overflows the stack on a cell with a great many of them. */
  function moveChildren(from, to) {
    while (from.firstChild) to.append(from.firstChild)
  }
  function icon(attrs, shapes) {
    const node = document.createElementNS(SVG, 'svg')
    node.setAttribute('aria-hidden', 'true')
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
    for (const [tag, shapeAttrs] of shapes) {
      const shape = document.createElementNS(SVG, tag)
      for (const [name, value] of Object.entries(shapeAttrs)) shape.setAttribute(name, value)
      node.append(shape)
    }
    return node
  }
  const sortIcon = () => icon({ viewBox: '0 0 11 13' }, [['path', { class: 'wf-up', d: 'M5.5 0 11 5.2H0z' }], ['path', { class: 'wf-down', d: 'M5.5 13 0 7.8h11z' }]])
  const searchIcon = () => icon({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [['circle', { cx: '11', cy: '11', r: '7' }], ['path', { d: 'm21 21-4.3-4.3' }]])

  /* ---- reading a cell ---- */
  /** A number, or null, by the rule of the spec. Before the digits: a leading minus (- or −) and one currency symbol
   *  (£ $ € ¥) before or after the minus. In the digits: thousands separators (a comma or a space of any kind between
   *  groups of three digits) and a decimal point. After them: a % or a currency symbol, with at most ONE space before
   *  it (ordinary, no-break U+00A0 or narrow no-break U+202F), as percentages are written in Czech and under ISO:
   *  "40 %" and "40 €" are numbers. No space is allowed after a leading sign or symbol: "- 40" and "£ 40" are text.
   *  Every repeated group in the pattern consumes a fixed number of characters, and the one optional space can only
   *  be followed by the closing symbol, so it cannot backtrack badly. */
  function parseNumber(text) {
    if (text.length > TYPED_CELL_MAX_LENGTH) return null
    const match = /^([-−])?[£$€¥]?([-−])?(\d{1,3}(?:[,\s]\d{3})+|\d+)(\.\d+)?(?:[ \u00A0\u202F]?[%£$€¥])?$/.exec(text)
    if (!match || (match[1] && match[2])) return null
    const value = Number(match[3].replace(/[,\s]/g, '') + (match[4] ?? ''))
    return match[1] || match[2] ? -value : value
  }
  const monthNumber = (name) => {
    const lower = name.toLowerCase()
    const index = MONTHS.indexOf(lower.slice(0, 3))
    return index >= 0 && (lower.length === 3 || FULL_MONTHS[index] === lower || (index === 8 && lower === 'sept')) ? index + 1 : 0
  }
  const validDay = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate()
  /** The recognised date formats, tried in this order. A column is a date column only when every
   *  non-empty cell reads as a real date under ONE of them. Each returns [year, month, day] or null. */
  const DATE_FORMATS = [
    (t) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t); return m ? [+m[1], +m[2], +m[3]] : null }, // 2026-01-11
    (t) => { const m = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/.exec(t); return m ? [+m[3], monthNumber(m[2]), +m[1]] : null }, // 11 Jan 2026, 11 January 2026
    (t) => { const m = /^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/.exec(t); return m ? [+m[3], monthNumber(m[1]), +m[2]] : null }, // Jan 11, 2026
    (t) => { const m = /^([A-Za-z]{3,9})\.? (\d{4})$/.exec(t); return m ? [+m[2], monthNumber(m[1]), 1] : null }, // Jan 2026
    // 11/01/2026, 11.1.2026: day first. A column holding 01/13/2026 has no month 13, so it is text.
    (t) => { const m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(t); return m ? [+m[3], +m[2], +m[1]] : null },
  ]

  /** Decide one column's type from its non-empty cell texts, in this order: number, date, pick, text. */
  function columnType(texts) {
    const filled = texts.filter((text) => text !== '')
    if (filled.length === 0) return { type: 'text' }
    if (filled.every((text) => parseNumber(text) !== null)) return { type: 'number', value: parseNumber }
    for (const read of DATE_FORMATS) {
      const date = (text) => {
        if (text.length > TYPED_CELL_MAX_LENGTH) return null
        const parts = read(text)
        return parts && validDay(parts[0], parts[1], parts[2]) ? parts : null
      }
      if (filled.every((text) => date(text) !== null)) {
        return { type: 'date', value: (text) => { const [y, m, d] = date(text); return y * 10000 + m * 100 + d } }
      }
    }
    // stops counting at the ninth distinct value, so a long all-distinct column is cheap
    const distinct = new Set()
    for (const text of filled) {
      distinct.add(text)
      if (distinct.size > PICK_LIST_MAX_VALUES) return { type: 'text' }
    }
    if (distinct.size < filled.length) return { type: 'pick', values: [...distinct].sort((a, b) => a.localeCompare(b)) }
    return { type: 'text' }
  }

  /* ---- which tables, and how much each gets ---- */
  function shape(table) {
    const merged = table.querySelector('[colspan]:not([colspan="1"]),[rowspan]:not([rowspan="1"])') !== null
    const head = table.tHead && table.tHead.rows.length === 1 ? table.tHead.rows[0] : null
    const bodyRows = [...table.tBodies].flatMap((body) => [...body.rows])
    const width = head ? head.cells.length : bodyRows[0] ? bodyRows[0].cells.length : 0
    const rectangular = width > 0 && bodyRows.every((row) => row.cells.length === width)
    const nested = table.querySelector('table') !== null
    return {
      head, bodyRows, width,
      // column types and number alignment need unambiguous columns
      columns: !merged && !nested && rectangular && (table.tHead === null || head !== null),
      // controls need all of: one header row, no merged cells, one body, no footer, more than 8 rows, at most 200 columns
      controls: !merged && !nested && rectangular && head !== null && table.tBodies.length === 1 && table.tFoot === null && bodyRows.length > CONTROLS_ABOVE_ROWS && width <= CONTROLS_MAX_COLUMNS,
    }
  }

  function enhance(region) {
    const table = region.querySelector(':scope > table')
    if (!table || region.closest('.wf-export-widget')) return
    region.classList.add('wf-js')
    const s = shape(table)
    watchWidth(region, table)
    if (!s.columns) return

    const rows = s.bodyRows.map((tr, index) => ({ tr, index, shown: true, texts: [...tr.cells].map((cell) => clean(cell.textContent)), values: [], folded: [], haystack: null }))
    const columns = Array.from({ length: s.width }, (_, j) => {
      const column = { j, ...columnType(rows.map((row) => row.texts[j])) }
      const header = s.head ? s.head.cells[j] : null
      column.name = (header && clean(header.textContent)) || TEXT.column(j + 1)
      column.header = header
      column.hasEmpty = rows.some((row) => row.texts[j] === '')
      for (const row of rows) row.values[j] = row.texts[j] === '' || !column.value ? null : column.value(row.texts[j])
      return column
    })
    for (const column of columns) {
      const cls = column.type === 'number' ? 'wf-num' : column.type === 'date' ? 'wf-date' : ''
      if (column.type === 'number' && column.header) column.header.classList.add('wf-num')
      // Pills are drawn only in a table that has controls (decision of 2026-10-13); a small table keeps plain text.
      const pills = column.type === 'pick' && s.controls
      if (!cls && !pills) continue
      for (const row of rows) {
        const cell = row.tr.cells[column.j]
        if (cls) cell.classList.add(cls)
        if (pills && row.texts[column.j] !== '') {
          const pill = el('span', { class: 'wf-pill' })
          pill.style.setProperty('--wf-dot', DOTS[column.values.indexOf(row.texts[column.j]) % DOTS.length])
          moveChildren(cell, pill)
          cell.append(pill)
        }
      }
    }
    if (s.controls) addControls(region, table, rows, columns)
  }

  /** A table wider than its column scrolls inside its own region; one that fits lets its header stick to the window. */
  function watchWidth(region, table) {
    const measure = () => {
      const wide = table.offsetWidth > region.clientWidth + 1
      region.classList.toggle('wf-wide', wide)
      if (wide) {
        const caption = table.caption ? clean(table.caption.textContent) : ''
        region.tabIndex = 0
        region.setAttribute('role', 'region')
        region.setAttribute('aria-label', caption || TEXT.region)
      } else {
        region.removeAttribute('tabindex'); region.removeAttribute('role'); region.removeAttribute('aria-label')
      }
    }
    measure()
    if ('ResizeObserver' in window) new ResizeObserver(measure).observe(region)
    else window.addEventListener('resize', measure)
  }

  function addControls(region, table, rows, columns) {
    const body = table.tBodies[0]
    const state = { query: '', sort: null, filters: columns.map(() => null) } // filters[j]: null = off
    region.classList.add('wf-controls')

    /* the line above: caption (when the table has one), search, count, clear */
    const captionText = table.caption ? clean(table.caption.textContent) : ''
    const bar = el('div', { class: 'wf-table-bar' })
    if (captionText) {
      bar.append(el('span', { class: 'wf-cap', 'aria-hidden': 'true' }, captionText))
      table.caption.classList.add('wf-vh') // still the table's accessible name; the bar shows it
    }
    const tools = el('div', { class: 'wf-tools' })
    const searchBox = el('label', { class: 'wf-search' })
    const search = el('input', { type: 'search', placeholder: TEXT.search, autocomplete: 'off', spellcheck: 'false', 'aria-label': captionText ? TEXT.searchNamed(captionText) : TEXT.search })
    searchBox.append(searchIcon(), search)
    const count = el('span', { class: 'wf-count' })
    const clear = el('button', { type: 'button', class: 'wf-clear', hidden: '' }, TEXT.clear)
    const live = el('div', { class: 'wf-vh', role: 'status', 'aria-live': 'polite' })
    tools.append(searchBox, count, clear)
    bar.append(tools, live)
    region.before(bar)

    /* sortable headers */
    for (const column of columns) {
      const th = column.header
      const button = el('button', { type: 'button', class: 'wf-sort' })
      th.classList.add('wf-sortable')
      th.setAttribute('aria-sort', 'none')
      if (th.querySelector('a,button,input,select,textarea')) {
        th.classList.add('wf-split') // a link in the header stays a link; the button is the arrows alone
        button.setAttribute('aria-label', TEXT.sortBy(column.name))
        button.append(sortIcon())
      } else {
        const label = el('span')
        // an empty header has no words to name the button by, so it is named "Sort by Column 3"
        if (clean(th.textContent) === '') button.setAttribute('aria-label', TEXT.sortBy(column.name))
        moveChildren(th, label)
        button.append(label, sortIcon())
      }
      th.append(button)
      button.addEventListener('click', () => {
        const current = state.sort && state.sort.j === column.j ? state.sort.direction : null
        state.sort = current === null ? { j: column.j, direction: 'ascending' } : current === 'ascending' ? { j: column.j, direction: 'descending' } : null
        refresh(state.sort ? TEXT.sorted(column.name, state.sort.direction) : TEXT.unsorted)
      })
    }

    /* the filter row: one control per column, typed to the column */
    const filterRow = el('tr', { class: 'wf-filters' })
    const resets = []
    for (const column of columns) {
      const j = column.j
      const td = el('td')
      const box = el('div', { class: 'wf-fcell' })
      const set = (filter) => { state.filters[j] = filter; box.classList.toggle('wf-on', filter !== null); refresh() }
      if (column.type === 'number') {
        box.classList.add('wf-range')
        td.classList.add('wf-num')
        const min = el('input', { type: 'text', inputmode: 'decimal', placeholder: TEXT.min, 'aria-label': TEXT.filterMin(column.name) })
        const max = el('input', { type: 'text', inputmode: 'decimal', placeholder: TEXT.max, 'aria-label': TEXT.filterMax(column.name) })
        const read = (input) => {
          const text = clean(input.value)
          const value = text === '' ? null : parseNumber(text)
          if (text !== '' && value === null) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid')
          return value // text that is not a number is ignored, and the field is marked
        }
        const update = () => { const lo = read(min), hi = read(max); set(lo === null && hi === null ? null : (row) => row.values[j] !== null && (lo === null || row.values[j] >= lo) && (hi === null || row.values[j] <= hi)) }
        min.addEventListener('input', update); max.addEventListener('input', update)
        box.append(min, el('span', { class: 'wf-dash', 'aria-hidden': 'true' }, '–'), max)
        resets.push(() => { min.value = ''; max.value = ''; min.removeAttribute('aria-invalid'); max.removeAttribute('aria-invalid') })
      } else if (column.type === 'date' || column.type === 'pick') {
        // The chosen option is read by its position, never by a value made from cell text.
        const select = el('select', { 'aria-label': TEXT.filterPick(column.name) })
        const choices = [null]
        const offer = (label, filter) => { select.append(el('option', {}, label)); choices.push(filter) }
        select.append(el('option', {}, column.type === 'date' ? TEXT.anyMonth : TEXT.all))
        if (column.type === 'date') {
          const months = [...new Set(rows.map((row) => row.values[j]).filter((value) => value !== null).map((value) => Math.floor(value / 100)))].sort((a, b) => a - b)
          for (const month of months) offer(`${MONTH_LABELS[month % 100 - 1]} ${Math.floor(month / 100)}`, (row) => row.values[j] !== null && Math.floor(row.values[j] / 100) === month)
        } else {
          for (const value of column.values) offer(value, (row) => row.texts[j] === value)
        }
        if (column.hasEmpty) offer(TEXT.empty, (row) => row.texts[j] === '')
        select.addEventListener('change', () => set(choices[select.selectedIndex] ?? null))
        box.append(select)
        resets.push(() => { select.selectedIndex = 0 })
      } else {
        const input = el('input', { type: 'text', class: 'wf-text', placeholder: TEXT.contains, autocomplete: 'off', spellcheck: 'false', 'aria-label': TEXT.filterContains(column.name) })
        input.addEventListener('input', () => {
          const needle = fold(clean(input.value))
          set(needle === '' ? null : (row) => (row.folded[j] ??= fold(row.texts[j])).includes(needle))
        })
        box.append(input)
        resets.push(() => { input.value = '' })
      }
      td.append(box)
      filterRow.append(td)
    }
    table.tHead.append(filterRow)

    /* no row matches */
    const noMatch = el('tr', { class: 'wf-nomatch', hidden: '' })
    const noMatchCell = el('td', { colspan: String(columns.length) })
    const noMatchClear = el('button', { type: 'button', class: 'wf-clear' }, TEXT.clear)
    noMatchCell.append(el('b', {}, TEXT.noMatch), noMatchClear)
    noMatch.append(noMatchCell)
    body.append(noMatch)

    search.addEventListener('input', () => { state.query = clean(search.value); refresh() })
    search.addEventListener('keydown', (event) => { if (event.key === 'Escape' && search.value !== '') { event.preventDefault(); search.value = ''; state.query = ''; refresh() } })
    /** Empties the search and every filter. The sort stays as it is. */
    const clearAll = () => {
      state.query = ''; search.value = ''
      state.filters.fill(null)
      for (const reset of resets) reset()
      for (const box of filterRow.querySelectorAll('.wf-on')) box.classList.remove('wf-on')
      refresh()
      search.focus()
    }
    clear.addEventListener('click', clearAll)
    noMatchClear.addEventListener('click', clearAll)

    /** Empty cells sort last in both directions; equal cells keep the original order. */
    function compare(a, b) {
      const { j, direction } = state.sort
      const emptyA = a.texts[j] === '', emptyB = b.texts[j] === ''
      if (emptyA || emptyB) return emptyA && emptyB ? a.index - b.index : emptyA ? 1 : -1
      const order = columns[j].value ? a.values[j] - b.values[j] : COLLATOR.compare(a.texts[j], b.texts[j])
      return (direction === 'ascending' ? order : -order) || a.index - b.index
    }
    /** Search is a plain substring test per typed word; no pattern is ever built from what was typed. */
    function matches(row, words) {
      if (words.length) {
        const haystack = (row.haystack ??= fold(row.texts.join(' ')))
        for (const word of words) if (!haystack.includes(word)) return false
      }
      for (let j = 0; j < state.filters.length; j += 1) {
        const filter = state.filters[j]
        if (filter !== null && !filter(row)) return false
      }
      return true
    }
    let announceTimer = 0
    let lastShown = rows.length
    let placedOrder = '' // the order the rows are in now; they are moved only when the sort changes
    function refresh(message) {
      const wantedOrder = state.sort ? `${state.sort.j} ${state.sort.direction}` : ''
      if (wantedOrder !== placedOrder) {
        const ordered = state.sort ? [...rows].sort(compare) : rows
        const moved = document.createDocumentFragment()
        for (const row of ordered) moved.append(row.tr)
        body.insertBefore(moved, noMatch)
        placedOrder = wantedOrder
      }
      const words = state.query === '' ? [] : fold(state.query).split(' ').filter((word) => word !== '')
      let shown = 0
      for (const row of rows) {
        const keep = matches(row, words)
        if (keep !== row.shown) { row.tr.hidden = !keep; row.shown = keep }
        if (keep) shown += 1
      }
      const active = state.query !== '' || state.filters.some((filter) => filter !== null)
      noMatch.hidden = shown > 0
      clear.hidden = !active
      count.textContent = ''
      if (active) count.append(el('b', {}, String(shown)), TEXT.ofRows(rows.length)); else count.textContent = TEXT.rows(rows.length)
      for (const column of columns) column.header.setAttribute('aria-sort', state.sort && state.sort.j === column.j ? state.sort.direction : 'none')
      // announce politely, once typing has paused, and only when there is something new to say
      if (message === undefined && shown === lastShown) return
      lastShown = shown
      window.clearTimeout(announceTimer)
      announceTimer = window.setTimeout(() => {
        const rowsText = shown === 0 ? TEXT.noMatch : active ? TEXT.rowsOf(shown, rows.length) : TEXT.rows(rows.length)
        live.textContent = message ? `${message} ${rowsText}` : rowsText
      }, ANNOUNCE_DELAY_MS)
    }
    refresh()
    window.clearTimeout(announceTimer) // nothing is announced on load
  }

  for (const region of document.querySelectorAll('.wf-table-region')) {
    try { enhance(region) } catch { /* a table this script cannot read stays a plain formatted table */ }
  }
})()
