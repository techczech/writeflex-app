/** Trusted WriteFlex helper entry; completion is certified only through proved host paths. */
import { main, runCli } from '@app-patterns/vault-sync/helper/host'
import { credentialMode, receiveHostBridge } from './github-credentials'
import { completionTarget, writeCompletion, type CompletionTarget } from './github-auth-receipts'
import { fileURLToPath } from 'node:url'
import { WRITEFLEX_PROJECTIONS } from './projections'
const args = process.argv.slice(2)
let receipt: CompletionTarget | undefined
if (args[0] === '--github-exposure') {
  const encoded = args[1]
  if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) process.exit(2)
  try { receipt = completionTarget(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))) } catch { process.exit(2) }
  args.splice(0, 2)
}
const certify = () => { if (receipt) { try { writeCompletion(receipt) } catch { /* no proof means debt remains */ } } }
if (args[0] === 'credential') {
  process.exit(await credentialMode(args.length === 2 ? args[1]! : 'invalid'))
} else if (args[0] === '--github-credentials') {
  let bridge: Awaited<ReturnType<typeof receiveHostBridge>>
  try { bridge = await receiveHostBridge(process.execPath, fileURLToPath(import.meta.url)) }
  catch { certify(); process.stderr.write('GitHub credential bridge refused\n'); process.exit(2) }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => bridge.close())
  try {
    const command = args[1]
    const code = await main(args.slice(1), {
      // H calls this only after its original registry/census confirms containment.
      exit(code): never { bridge.close(); certify(); process.exit(code) },
    }, { projections: WRITEFLEX_PROJECTIONS, hostCredentials: bridge.hostCredentials, signal: bridge.signal, maxRuntimeMs: bridge.maxRuntimeMs })
    bridge.close()
    // These H paths return only after registry end or foreground contained settlement.
    if (['preview', 'enable', 'disable', 'run'].includes(command!)) certify()
    process.exit(code)
  } catch { bridge.close(); process.stderr.write('GitHub helper work outcome uncertain\n'); process.exit(2) }
} else {
  runCli(args, { projections: WRITEFLEX_PROJECTIONS })
}
