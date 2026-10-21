// Build step: compile the sharing service once, here in the repository, into sharing-service-dist/,
// which ships in the app's resources and is what the app uploads. Then check what was
// written, so the build fails on a missing, empty or mismatched bundle (scripts/lib/sharing-service-dist.ts).
//
//   bun scripts/build-sharing-service.ts [--out <folder>]     default: sharing-service-dist/ in the repository
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSharingServiceDist, checkSharingServiceDist } from './lib/sharing-service-dist.ts'

const repo = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))))
const at = process.argv.indexOf('--out')
const outDir = at > 0 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : join(repo, 'sharing-service-dist')
try {
  const manifest = buildSharingServiceDist({ repo, outDir })
  const problems = checkSharingServiceDist({ repo, distDir: outDir })
  if (problems.length) throw new Error(problems.join('\n'))
  const bundle = manifest.files[manifest.mainModule]
  console.log(`sharing-service-dist: sharing service build ${manifest.build} compiled with esbuild ${manifest.compilerVersion} → ${outDir} (${manifest.mainModule}, ${bundle.bytes} bytes, sha256 ${bundle.sha256})`)
} catch (error) {
  console.error(`sharing-service-dist: the sharing service could not be built.\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
