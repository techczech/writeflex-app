import { sanitiseSvg } from '../../../../shared/sanitise-svg'

export function mountSvgEditor(source: string): import('./shell').MountedEditor {
  const root = document.createElement('div'); root.className = 'oe-svg'
  const area = document.createElement('textarea'); area.value = source; area.spellcheck = false; area.setAttribute('aria-label', 'SVG source')
  const preview = document.createElement('div'); preview.className = 'oe-svg-preview'
  const error = document.createElement('div'); error.className = 'lp-render-error'; error.hidden = true
  const render = (): void => {
    const result = sanitiseSvg(area.value)
    if ('error' in result) {
      preview.replaceChildren()
      error.textContent = result.error
      error.hidden = false
      return
    }
    preview.innerHTML = result.svg
    error.textContent = ''
    error.hidden = true
  }
  area.addEventListener('input', render)
  root.append(area, preview, error)
  render()
  return { element: root, serialise: () => area.value, focus: () => area.focus() }
}
