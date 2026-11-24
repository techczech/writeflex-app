'use strict'

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { copyFile, mkdir, readFile, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { Arch } = require('builder-util')

// Official runtime and signed SHASUMS at https://nodejs.org/en/blog/release/v26.13.1/.
const version = '26.13.1'
const hashes = {
  'darwin-arm64': 'aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735',
  'darwin-x64': '82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f',
  'win-x64': 'e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7',
  'win-arm64': '181ebe431b90787113a9e4fc80d38ce86d37888a353a0386de44d2872e48cb97',
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

exports.beforePack = async context => {
  const { electronPlatformName: platform, packager, arch } = context
  const windows = platform === 'win32'
  const artifact = `${windows ? 'win' : platform}-${Arch[arch]}`
  const expected = hashes[artifact]
  if (!expected || platform !== process.platform || Arch[arch] !== process.arch) {
    throw new Error(`The standalone backup helper needs a matching macOS or Windows build host for ${artifact}`)
  }

  const cache = join(packager.projectDir, 'node_modules/.cache/writeflex/backup-runtime', artifact)
  const stage = join(packager.projectDir, 'node_modules/.cache/writeflex/backup-native', `${windows ? 'win' : 'mac'}-${Arch[arch]}`)
  await Promise.all([mkdir(cache, { recursive: true }), mkdir(stage, { recursive: true })])
  const distribution = `node-v${version}-${artifact}`
  const archiveName = `${distribution}.${windows ? 'zip' : 'tar.gz'}`
  const archive = join(cache, archiveName)
  let bytes = await readFile(archive).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!bytes) {
    const response = await fetch(`https://nodejs.org/dist/v${version}/${archiveName}`, {
      redirect: 'error', signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`Download failed for ${archiveName}: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
    if (hash(bytes) !== expected) throw new Error(`Invalid Node archive digest: ${archiveName}`)
    await writeFile(archive, bytes)
  } else if (hash(bytes) !== expected) {
    throw new Error(`Invalid cached Node archive digest: ${archive}`)
  }

  const nodeMember = distribution + (windows ? '/node.exe' : '/bin/node')
  const licenseMember = distribution + '/LICENSE'
  execFileSync(windows ? 'tar.exe' : '/usr/bin/tar', ['-xf', archive, '-C', cache, nodeMember, licenseMember], { stdio: 'inherit' })
  const config = join(cache, 'sea.json')
  const output = join(stage, `writeflex-backup-helper${windows ? '.exe' : ''}`)
  await writeFile(config, JSON.stringify({
    main: resolve(packager.projectDir, 'out/backup-helper/writeflex-backup-helper.js'),
    mainFormat: 'module',
    output,
    disableExperimentalSEAWarning: true,
    execArgv: ['--jitless'],
    execArgvExtension: 'none',
  }))
  const node = join(cache, nodeMember)
  // Never inherit build-process options into the input runtime.
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  execFileSync(node, ['--build-sea=' + config], { env, stdio: 'inherit' })
  if (!windows) execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' })
  await copyFile(join(cache, licenseMember), join(stage, 'NODE-LICENSE'))
}
