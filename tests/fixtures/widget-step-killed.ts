/**
 * A widget step that moves documents, killed part-way (tests/main/standard-widgets-own-folder.test.ts, "a crash"):
 * run in a child process over `root`, it carries out the create request in `request` (JSON) and kills itself
 * (SIGKILL, so no rollback runs) at `stopAt`: `copy:<n>` just after the n-th file is copied to its new place,
 * `before-removing:1` when all but the removal of the old names is done (links elsewhere carried included), or
 * `removed:<n>` just after the n-th old name is removed (the step's last part).
 */
import { createStandardWidget, operationSeams, StandardWidgetUndoDesk, type CreateWidgetRequest } from '../../src/main/standard-widgets/operations'
import { Workspace } from '../../src/main/workspace'

const [root, stopAt, request] = process.argv.slice(2)
const [kind, count] = stopAt.split(':')
let seen = 0
const stop = (): void => { seen += 1; if (seen === Number(count)) process.kill(process.pid, 'SIGKILL') }
if (kind === 'copy') operationSeams.afterMoveWrite = stop
else if (kind === 'before-removing') operationSeams.beforeRemovingOriginals = stop
else operationSeams.afterOriginalRemoved = stop
const result = await createStandardWidget(new Workspace(root), new StandardWidgetUndoDesk(), JSON.parse(request) as CreateWidgetRequest)
process.stdout.write(`not stopped: ${JSON.stringify(result)}\n`)
