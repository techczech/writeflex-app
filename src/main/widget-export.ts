/** Export reads exactly the widget files named by the document, through the same descriptor-checked
 * containment boundary as the editor. Sealing remains in the shared HTML emitter. */
import type { Workspace } from './workspace'
import { readWidgetFile } from './widget-file'
import { scanWidgets } from '../shared/markdown/widgets'
import type { WidgetHtmlPolicy } from '../shared/markdown/to-html'

export async function loadExportWidgets(workspace: Workspace, source: string, documentPath: string): Promise<WidgetHtmlPolicy> {
  const pages = new Map<string, string>()
  for (const widget of scanWidgets(source)) {
    if (widget.refusal || pages.has(widget.path)) continue
    const read = await readWidgetFile(workspace.root, documentPath, widget.path)
    if (read.ok) pages.set(widget.path, read.bytes.toString('utf8'))
  }
  return { resolve: (path) => pages.get(path) ?? null }
}
