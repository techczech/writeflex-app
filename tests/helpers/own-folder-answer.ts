/**
 * For tests of Create and insert that are not about the own-folder sheet: the sheet's answer that keeps the
 * document's folder as it is (every document in it chosen, so the folder itself becomes the Folio and nothing
 * moves), with the fingerprint of the plan the sheet would show, when the folder needs the sheet at all. The
 * engine refuses a create without an answer in such a folder.
 */
import { createStandardWidget, type CreateWidgetRequest, type StandardWidgetUndoDesk } from '../../src/main/standard-widgets/operations'
import type { BuildOptions } from '../../src/main/standard-widgets/build'
import { readOwnFolderFacts } from '../../src/main/standard-widgets/own-folder'
import type { Workspace } from '../../src/main/workspace'
import { initialOwnFolderChoice, planFingerprint, planOwnFolder, type OwnFolderChoice } from '../../src/shared/own-folder-plan'

export async function inPlaceAnswer(ws: Workspace, request: Pick<CreateWidgetRequest, 'documentPath' | 'sourceFile' | 'name'>): Promise<OwnFolderChoice | undefined> {
  const answer = await readOwnFolderFacts(ws, { documentPath: request.documentPath, sourceFile: request.sourceFile, name: request.name })
  if (!answer.ok || !answer.needed) return undefined
  const choice: OwnFolderChoice = { ...initialOwnFolderChoice(answer.facts), mode: 'several', checked: [...answer.facts.documents] }
  return { ...choice, fingerprint: planFingerprint(planOwnFolder(answer.facts, choice)) }
}

/** createStandardWidget with the in-place answer (above) when the folder needs one. */
export async function createInPlace(ws: Workspace, desk: StandardWidgetUndoDesk, request: CreateWidgetRequest, options?: BuildOptions) {
  const placement = request.placement ?? await inPlaceAnswer(ws, request)
  return createStandardWidget(ws, desk, { ...request, ...(placement ? { placement } : {}) }, options)
}
