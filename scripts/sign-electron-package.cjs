'use strict'

const { createRequire } = require('node:module')
const { relative } = require('node:path')
const builderRequire = createRequire(require.resolve('app-builder-lib'))
const { sign } = builderRequire('./codeSign/macCodeSign.js')

module.exports = async options => {
  return sign({
    ...options,
    optionsForFile(file) {
      const policy = options.optionsForFile(file)
      // Electron's executable app bundles need JIT. Framework code, native modules and
      // the jitless backup process get an empty dictionary instead of the inherited JIT plist.
      const electronApp = file === options.app ||
        /^Contents\/Frameworks\/[^/]+ Helper(?: \([^)]+\))?\.app$/.test(relative(options.app, file))
      return electronApp ? policy : { ...policy, entitlements: [] }
    },
  })
}
