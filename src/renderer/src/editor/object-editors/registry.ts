import { eolOf, layoutOf } from '../../../../shared/markdown/frontmatter-edit'
import type { MetadataPanelOptions } from './frontmatter-editor'
import type { LivePreviewBlock, LivePreviewKind } from '../live-preview'
import { mountMarkmapEditor } from './markmap-editor'
import { mountMermaidEditor } from './mermaid-editor'
import { mountMarkupEditor } from './markup-editor'
import { mountShell, type ObjectEditorApi } from './shell'
import { mountTableEditor, normaliseTableMarkup, parseTable } from './table-editor'
import { mountFrontmatterEditor } from './frontmatter-editor'
import { mountSvgEditor } from './svg-editor'

export type ObjectEditorRegistration = { kind: LivePreviewKind; label: string; markupOnly?: boolean }
export const objectEditorRegistry: ObjectEditorRegistration[] = [
  { kind: 'frontmatter', label: 'Metadata' }, { kind: 'table', label: 'Table' }, { kind: 'mermaid', label: 'Mermaid' }, { kind: 'markmap', label: 'Mind map' }, { kind: 'query', label: 'Query' }, { kind: 'svg', label: 'SVG' }, { kind: 'code', label: 'Code', markupOnly: true },
]

export function innerSource(block: LivePreviewBlock): string {
  if (block.kind === 'frontmatter') {
    const layout = layoutOf(block.source)
    return layout ? block.source.slice(layout.openEnd, layout.closeStart).replace(/\r?\n$/, '') : block.source
  }
  return block.kind === 'table' ? block.source.trimEnd() : block.source.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '')
}
export function serialiseBlock(block: LivePreviewBlock, inner: string): string {
  if (block.kind === 'frontmatter') {
    const eol = block.source.includes('\r\n') ? '\r\n' : '\n'
    const layout = layoutOf(block.source)
    const opening = layout ? block.source.slice(0, layout.openEnd) : `---${eol}`
    const closing = layout ? block.source.slice(layout.closeStart, layout.end).replace(/\r?\n$/, '') : '---'
    return `${opening}${inner}${eol}${closing}`
  }
  if (block.kind === 'table') return inner
  return `\`\`\`${block.language ?? ''}\n${inner.replace(/\n+$/, '')}\n\`\`\``
}

/** Preserve the source block's final-newline shape while replacing only that block. */
export function objectEditorReplacement(block: LivePreviewBlock, inner: string): string {
  return `${serialiseBlock(block, inner)}${block.source.endsWith('\r\n') ? '\r\n' : block.source.endsWith('\n') ? '\n' : ''}`
}

export function mountObjectEditor(block: LivePreviewBlock, api: ObjectEditorApi, metadataOptions: MetadataPanelOptions = {}): HTMLElement | null {
  if (block.kind === 'image') return null
  const inner = innerSource(block)
  const markup = mountMarkupEditor(inner)
  if (block.kind === 'frontmatter') {
    metadataOptions = { ...metadataOptions, lineEnding: eolOf(block.source) }
    return mountShell({ kind: 'Metadata', editor: mountFrontmatterEditor(inner, metadataOptions), markup, editorLabel: 'Metadata', markupLabel: 'Edit as Markup', parseEditor: (text) => mountFrontmatterEditor(text, metadataOptions), foot: 'Changes join the document when you finish · ⌘↵ done', api })
  }
  if (block.kind === 'code') return mountShell({ kind: block.language || 'Code', editor: markup, foot: '⌘↵ done · fences are protected', api })
  if (block.kind === 'table') return mountShell({ kind: 'Table', editor: mountTableEditor(inner), markup, parseEditor: (source) => { const fixed = normaliseTableMarkup(source); return fixed && parseTable(fixed) ? mountTableEditor(fixed) : null }, normaliseSource: normaliseTableMarkup, notParsedNote: 'This text is not a table: it needs a header row and a separator row such as | --- | --- |. Your text is kept; fix it here and press Done again.', foot: '↵ newline in cell · ⇥ next cell · esc browse · ⌘↵ done', api })
  if (block.kind === 'markmap') return mountShell({ kind: 'Mind map', editor: mountMarkmapEditor(inner), editorLabel: 'Outline', markup, parseEditor: mountMarkmapEditor, foot: '↵ sibling · ⇥ indent · ⇧⇥ outdent · ⌥↑↓ move subtree · ⌘↵ done', api })
  if (block.kind === 'query') return mountShell({ kind: 'Query', editor: markup, foot: 'status · tags · folder · sort · limit · ⌘↵ done', api })
  if (block.kind === 'svg') return mountShell({ kind: 'SVG', editor: mountSvgEditor(inner), foot: 'live preview · ⌘↵ done', api })
  return mountShell({ kind: 'Mermaid', editor: mountMermaidEditor(inner), markup, primaryTab: 'markup', editorDisabledTitle: 'arrives with the visual editor', foot: 'live preview · ⌘↵ done', api })
}
