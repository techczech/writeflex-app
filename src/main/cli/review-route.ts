/**
 * Where a shown-first request goes once the command line has checked it (specification sections 4
 * and 5). The command line writes ONE request file into `.writeflex/inbox/` and nothing else: no
 * document, no journal entry, and never the review ledger, which is the app's store.
 *
 *  - WriteFlex has the Collection open (the owner lock names a live app): the request is sent as any
 *    other is (request-route.ts) and the command line waits for the app's signed reply, which says the
 *    change is in the review dock, or that the app refused it and closed it with the reason. With a
 *    lock and no usable reply key nothing is sent ("could not be verified"). With no reply inside the
 *    wait the result is "sent, not confirmed": the request stays, and the app adds it when it looks.
 *  - No app has it open: the request is left in the inbox. It does not expire (only direct requests
 *    do): the app adds it to the review dock when the Collection is next opened.
 *
 * Either way the app checks the request again from scratch when it adds it. What the command line
 * found is told to the caller and to nobody else.
 */
import type { Operation, OperationResult, ParsedArgs } from './operation'
import { fileRequest, sendToApp, type RequestSurroundings } from './request-route'
import { OUTSIDE_AUTHORS, declaredSource } from './review-format'

export type ReviewFiling = { result: OperationResult; via: 'app' | 'inbox'; confirmed: boolean }

export async function fileForReview(
  root: string, route: 'app' | 'direct', operation: Operation, args: ParsedArgs, proposed: { path: string; changes: number }, surroundings: RequestSurroundings,
): Promise<ReviewFiling> {
  if (route === 'app') {
    const sent = await sendToApp(root, operation, args, surroundings)
    return { result: sent.result, via: 'app', confirmed: sent.confirmed }
  }
  const id = await fileRequest(root, operation, args, surroundings)
  const source = declaredSource(args.source)
  return {
    via: 'inbox', confirmed: true,
    result: {
      outcome: 'filed',
      data: { shown: 'when-opened', request: id, path: proposed.path, changes: proposed.changes, source, checked: 'saved-on-disk' },
      text: [
        `${operation.name} on ${proposed.path} is filed as request ${id}, to be shown as from ${OUTSIDE_AUTHORS[source].name}. WriteFlex does not have this Collection open.`,
        'It was checked against the document as saved on disk; WriteFlex checks it again when it adds it, and closes it with the reason if it no longer fits.',
        `Take it back before then with: writeflex withdraw ${id}`,
      ].join('\n'),
    },
  }
}
