import { existsSync } from 'node:fs'

// These tests launch Playwright's default headless channel, whose binary is
// installed independently of the full Chromium returned by chromium.executablePath().
const { registry } = require('playwright-core/lib/coreBundle').registry
const headlessShell = registry.findExecutable('chromium-headless-shell').executablePath()
export const missingChromium = headlessShell && existsSync(headlessShell)
  ? undefined
  : 'Playwright chromium-headless-shell is missing (run bunx playwright install chromium-headless-shell)'
