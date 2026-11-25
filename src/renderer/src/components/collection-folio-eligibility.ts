import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { MANIFEST_NAME } from '../../../shared/folio-constants'
import { canStartFolioOutline, surfaceForFolder } from '../../../shared/folio-surface'

async function readFolioEligibility(dir: string) {
  const api = window.writeflex
  const manifestPath = [dir, MANIFEST_NAME].filter(Boolean).join('/')
  const [folio, manifestExists, declaration, parent, outline] = await Promise.all([
    api.readFolio(dir).catch(() => null),
    api.readFile(manifestPath).then(() => true, () => false),
    api.readFolioDeclaration(dir).catch(() => null),
    api.readFolioDir(dir).catch(() => undefined),
    api.plan.read(dir).then(
      plan => ({ plan, error: null }),
      (error: unknown) => ({ plan: null, error: error instanceof Error ? error.message : 'The Folio outline could not be read.' }),
    ),
  ])
  return { folio, manifestExists, declaration, parent, outline }
}

type FolderScope = { dir: string; generation: number }
type EligibilityRead = {
  scope: FolderScope
  generation: number
  pending: boolean
  result: Awaited<ReturnType<typeof readFolioEligibility>> | null
}

/** CollectionView is mounted per workspace. Within it, each folder and reload own their answers. */
export function useCollectionFolioEligibility(dir: string, openPlanRequested: boolean) {
  const mounted = useRef<FolderScope | null>(null)
  const [state, setState] = useState<EligibilityRead | null>(null)
  useLayoutEffect(() => {
    mounted.current = { dir, generation: 0 }
    setState(null)
    return () => { mounted.current = null }
  }, [dir])

  const read = useCallback(() => {
    const scope = mounted.current
    if (scope?.dir !== dir) return
    const generation = ++scope.generation
    // Keep the same folder's rendered room mounted while the new read completes.
    setState(previous => ({
      scope, generation, pending: true, result: previous?.scope === scope ? previous.result : null,
    }))
    void readFolioEligibility(dir).then(result => {
      if (mounted.current === scope && scope.generation === generation) {
        setState({ scope, generation, pending: false, result })
      }
    })
  }, [dir])

  const current = state?.scope.dir === dir ? state : null
  // A command can arrive in the same turn as a change notice, before React commits pending.
  const isCurrent = useCallback(() => current !== null && !current.pending &&
    mounted.current === current.scope && current.scope.generation === current.generation, [current])

  const result = current?.result
  const folio = result?.folio ?? null
  const folioParent = result?.parent
  const isFolio = folio !== null || result?.declaration?.isFolio === true
  const manifestUnreadable = folio === null && (result?.manifestExists === true || result?.declaration?.manifest === true)
  const repairNeeded = result?.declaration?.repairNeeded === true
  const plan = result?.outline.plan ?? null
  const planError = result?.outline.error ?? null
  const showPlan = !repairNeeded && (openPlanRequested || isFolio || manifestUnreadable || (plan?.parts.length ?? 0) > 0)
  const surface = result ? surfaceForFolder({ showPlan, roomEligible: !manifestUnreadable && plan !== null }) : 'loading'
  const planCommandError = planError ?? (manifestUnreadable
    ? 'Cannot write an unreadable Folio manifest. Fix or move it before editing the outline; nothing else was changed.'
    : null)
  const canMakeFolio = current?.pending === false && result?.declaration != null && canStartFolioOutline(folioParent, isFolio)
  const canStartOutline = canMakeFolio && !showPlan && !repairNeeded && planCommandError === null

  return { read, isCurrent, surface, folio, folioParent, isFolio, manifestUnreadable, repairNeeded, planError, planCommandError, canMakeFolio, canStartOutline }
}
