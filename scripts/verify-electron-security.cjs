'use strict'

const { execFileSync, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { closeSync, openSync, readFileSync, readSync, readdirSync } = require('node:fs')
const { createRequire } = require('node:module')
const { dirname, join, relative, resolve } = require('node:path')

const builderRequire = createRequire(require.resolve('app-builder-lib'))
const { FuseV1Options, FuseVersion, getCurrentFuseWire } = builderRequire('@electron/fuses')
const { getRawHeader } = builderRequire('@electron/asar')

const fuses = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
}
const machoMagic = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'])
const jit = 'com.apple.security.cs.allow-jit'
const team = 'M7H45AGG8A'

function* machoFiles(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* machoFiles(path)
    if (!entry.isFile()) continue
    const file = openSync(path, 'r')
    const prefix = Buffer.alloc(4)
    try {
      if (readSync(file, prefix, 0, 4, 0) !== 4) continue
    } finally {
      closeSync(file)
    }
    if (machoMagic.has(prefix.toString('hex'))) yield path
  }
}

function readPlist(path, input) {
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', path], { input, encoding: 'utf8' }))
}

function codesignDetails(path) {
  // codesign sends the description to stderr. Capture both streams without printing them.
  const result = spawnSync('/usr/bin/codesign', ['-dvv', path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`cannot describe signature: ${path}`)
  return result.stderr
}

function verifyBackupExecutable(resources, suffix = '') {
  const path = join(resources, 'backup-helper', 'writeflex-backup-helper' + suffix)
  const seal = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1'
  if (!readFileSync(path).includes(seal)) throw new Error(`backup helper is not a standalone Node executable: ${path}`)
  return path
}

function verifyMac(app, { fusesOnly, adhoc }) {
  const contents = join(app, 'Contents')
  const backup = verifyBackupExecutable(join(contents, 'Resources'))
  const info = readPlist(join(contents, 'Info.plist'))
  const asar = join(contents, 'Resources/app.asar')
  const embedded = info.ElectronAsarIntegrity?.['Resources/app.asar']
  const hash = createHash('sha256').update(getRawHeader(asar).headerString).digest('hex')
  if (embedded?.algorithm !== 'SHA256' || embedded.hash !== hash) throw new Error('missing or incorrect embedded app.asar integrity hash')
  if (fusesOnly) {
    console.log('PASS app.asar integrity header (unsigned package stage)')
    return
  }

  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  const main = join(contents, 'MacOS', info.CFBundleExecutable)
  const files = [...machoFiles(contents)]
  if (!files.includes(backup)) throw new Error('backup executable missing from the Mach-O inventory')
  if (!files.includes(main)) throw new Error('main executable missing from the Mach-O inventory')
  const renderers = files.filter(file => /\/Frameworks\/[^/]+ \(Renderer\)\.app\/Contents\/MacOS\//.test(file))
  if (renderers.length !== 1) throw new Error('expected one Electron renderer helper')
  for (const file of files) {
    const label = relative(app, file)
    const details = codesignDetails(file)
    const expectedSignature = adhoc ? /^Signature=adhoc$/m : new RegExp(`^TeamIdentifier=${team}$`, 'm')
    if (!expectedSignature.test(details)) throw new Error(`unexpected code signature: ${label}`)
    const type = execFileSync('/usr/bin/file', ['-b', file], { encoding: 'utf8' })
    const executable = /\bexecutable\b/.test(type)
    const hardened = /^CodeDirectory .*flags=.*\bruntime\b/m.test(details)
    if (executable && hardened !== !adhoc) {
      throw new Error(`unexpected hardened runtime state: ${label}`)
    }
    const xml = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', file], { encoding: 'utf8' })
    const values = xml.trim() ? readPlist('-', xml) : {}
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`invalid entitlement dictionary: ${label}`)
    const electronHelper = /\/Frameworks\/[^/]+ Helper(?: \([^)]+\))?\.app\/Contents\/MacOS\//.test(file)
    for (const [name, value] of Object.entries(values)) {
      if (name !== jit || value !== true || (file !== main && !electronHelper)) {
        throw new Error(`unexpected entitlement ${name} on ${label}`)
      }
    }
    if ((file === main || renderers.includes(file)) && values[jit] !== true) {
      throw new Error(`missing JIT entitlement on ${label}`)
    }
  }
  const proof = adhoc ? 'ad-hoc signatures and entitlements' : `team ${team} signatures, hardened runtime and entitlements`
  console.log(`PASS app.asar and ${files.length} Mach-O files: ${proof}`)
}

async function verify(path, options = {}) {
  const wire = await getCurrentFuseWire(path)
  if (wire.version !== FuseVersion.V1) throw new Error(`unsupported fuse schema ${wire.version}`)
  for (const [name, enabled] of Object.entries(fuses)) {
    if (wire[FuseV1Options[name]] !== (enabled ? 49 : 48)) throw new Error(`unexpected fuse state: ${name}`)
    console.log(`${name}: ${enabled ? 'enabled' : 'disabled'}`)
  }
  if (path.endsWith('.app')) verifyMac(path, options)
  else if (!path.endsWith('.exe')) throw new Error('expected a macOS .app or Windows .exe')
  else {
    verifyBackupExecutable(join(dirname(path), 'resources'), '.exe')
    console.log('PASS Windows fuse policy and standalone backup helper')
  }
}

exports.verify = verify

exports.afterSign = async context => {
  if (context.electronPlatformName === 'darwin') {
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
    // electron-builder can emit afterSign for its ad-hoc signature even when directory staging
    // explicitly disables Developer ID discovery. Installer targets always require the release team.
    const unsignedDirectory = context.targets.length === 0 &&
      (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'false' || context.packager.platformSpecificBuildOptions.identity === null) &&
      /^Signature=adhoc$/m.test(codesignDetails(app))
    await verify(app, { fusesOnly: unsignedDirectory })
  }
}

if (require.main === module) {
  const [app, flag, ...remaining] = process.argv.slice(2)
  if (!app || app.startsWith('--') || remaining.length || (flag && !['--fuses-only', '--adhoc'].includes(flag))) {
    console.error('Usage: node scripts/verify-electron-security.cjs <app bundle | exe> [--fuses-only | --adhoc]')
    process.exitCode = 2
  } else {
    verify(resolve(app), { fusesOnly: flag === '--fuses-only', adhoc: flag === '--adhoc' }).catch(error => {
      console.error(`Electron package verification failed: ${error.message}`)
      process.exitCode = 1
    })
  }
}
