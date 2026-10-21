// The set-up page and Settings › Sharing as drawn (sharing ticket 02; locked frames `setup`,
// `setup-problem`, `problems`, `settings`). Drawn from props; nothing here reaches the preload bridge.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SharingSetup } from '../../src/renderer/src/components/sharing/SharingSetup'
import { SharingSettingsPanel } from '../../src/renderer/src/components/settings/SharingSettingsPanel'
import { problemRows, setupSteps } from '../../src/renderer/src/components/sharing/sharing-view-model'
import { REMOVAL_PENDING, NO_WORKERS_ACCOUNT, SAVED_TOKEN_REJECTED, TOKEN_REJECTED, type SharingSetupStatus } from '../../src/shared/sharing-setup'

const none = (): void => {}
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
/** One step's markup: from its opening tag to the next step, or the end of the steps column. */
const step = (html: string, name: string): string => html.split(`data-step="${name}">`)[1]!.split(/<div class="shr-step[^"]*" data-step=|<\/section>/)[0]!

const fresh: SharingSetupStatus = {
  ready: false, storageUnavailable: false, token: { stored: false, acceptedAt: null, problem: null }, accounts: [], account: null, address: null,
  interrupted: false, accountLocked: false, removalPending: false, service: null, setUpAt: null, ownAddress: null, ownAddressesLeft: [], linksAddress: null,
}
const checked: SharingSetupStatus = {
  ...fresh,
  token: { stored: true, acceptedAt: new Date(2026, 9, 15, 14, 21).getTime(), problem: null },
  accounts: [
    { id: 'acc1', name: 'Example author · personal account', workers: true, address: 'https://writeflex-sharing.example.workers.dev' },
    { id: 'acc2', name: 'Department', workers: false, address: null },
  ],
  account: { id: 'acc1', name: 'Example author · personal account' },
}
const ready: SharingSetupStatus = {
  ...checked, ready: true, address: 'https://writeflex-sharing.example.workers.dev', setUpAt: checked.token.acceptedAt,
  service: { installedBuild: 1, appBuild: 1, compare: 'current' },
}
const page = (initial: Parameters<typeof SharingSetup>[0]['initial']) =>
  renderToStaticMarkup(<SharingSetup pieceName="What a reading list is for" onBack={none} onFlash={none} onOpenSettings={none} initial={initial} />)

test('frame setup a: steps 1 and 2 now, step 3 waiting; the permission list; the token never shown', () => {
  const html = page({ status: fresh })
  expect(text(html)).toContain('Set up sharing First time only · What a reading list is for')
  expect(text(step(html, 'token'))).toContain('Make a Cloudflare token Now Make a token in Cloudflare with these permissions. Cloudflare opens in your browser.')
  expect(text(step(html, 'token'))).toContain('Account · Workers Scripts · installs the sharing service Edit Account · Account Settings · finds your account Read Zone · Workers Routes · own address only Edit Zone · DNS · own address only Edit')
  expect(text(step(html, 'token'))).toContain('Open Cloudflare ⌘↵ Copy the list')
  expect(step(html, 'paste')).toContain('type="password"')
  expect(step(html, 'paste')).toContain('placeholder="Paste the token here"')
  expect(text(step(html, 'account'))).toBe('3 Choose the account and an address Waiting for step 2')
  expect(text(html)).toContain('Your links will read writeflex-sharing.<your-account>.workers.dev/…')
  expect(text(html)).toContain('Before you make a link Nothing Your token Stays in the macOS Keychain Installed on Cloudflare A small sharing service')
})

test('frame setup b: steps 1 and 2 done with the time, step 3 with the account; an account the token cannot use is shown but not offered', () => {
  // shortTime shows the bare time only for a day that is today; freeze "now" on the accepted day.
  const originalNow = Date.now
  Date.now = () => new Date(2026, 9, 15, 16, 0).getTime()
  try {
    const html = page({ status: checked })
    expect(text(step(html, 'token'))).toBe('Make a Cloudflare token · permissions listed Show list')
    expect(text(step(html, 'paste'))).toBe('Paste the token · Token accepted at 14:21 Change token')
    expect(step(html, 'account')).toContain('<option value="acc1" selected="">Example author · personal account</option>')
    expect(step(html, 'account')).toContain('<option value="acc2" disabled="">Department (the token cannot install here)</option>')
    expect(text(step(html, 'account'))).toContain('Set up sharing ⌘↵ Back')
    expect(text(html)).toContain('Your links will read writeflex-sharing.example.workers.dev/…')
  } finally {
    Date.now = originalNow
  }
})

test('frame setup-problem: token rejected at step 2 with its reason, fix and the two buttons', () => {
  const html = page({ status: fresh, tokenFailure: { problem: TOKEN_REJECTED } })
  const paste = text(step(html, 'paste'))
  expect(paste).toContain('Paste the token Token rejected')
  expect(paste).toContain(`${TOKEN_REJECTED.reason} ${TOKEN_REJECTED.fix} Open Cloudflare Show the permission list`)
  expect(step(html, 'paste')).toContain('shr-inp mono err')
})

test('a missing permission at step 3 says which, and offers Try again and Replace token', () => {
  const html = page({ status: checked, setupFailure: { problem: NO_WORKERS_ACCOUNT, details: 'Uploading the sharing service: Cloudflare answered 403 (error 10000).' } })
  expect(text(step(html, 'account'))).toContain('The token is missing the permission “Account · Workers Scripts · Edit”. Open the token in Cloudflare, add that permission, save it, and paste it again. Details Uploading the sharing service: Cloudflare answered 403 (error 10000). Try again Replace token')
})

test('set up: no steps; problem rows at the top of the right column, only those that apply, in the drawn order', () => {
  expect(setupSteps(ready, false)).toEqual({ token: 'done', paste: 'done', account: 'cur' })
  expect(problemRows(ready)).toEqual([])
  const troubled: SharingSetupStatus = { ...ready, token: { ...ready.token, problem: SAVED_TOKEN_REJECTED }, service: { installedBuild: 1, appBuild: 2, compare: 'update' } }
  expect(problemRows(troubled).map((row) => row.kind)).toEqual(['token-rejected', 'service-out-of-date'])
  const html = page({ status: troubled })
  expect(text(html)).toContain('Sharing Set up on this Mac · What a reading list is for')
  expect(html).not.toContain('data-step="paste"')
  const right = text(html.split('<aside class="shr-right">')[1]!)
  expect(right.indexOf('Token rejected')).toBeLessThan(right.indexOf('Sharing service out of date'))
  expect(right).toContain(`${SAVED_TOKEN_REJECTED.reason} Paste a new token Open Cloudflare`)
  expect(right).toContain('Your account runs sharing service build 1; this WriteFlex carries build 2. Links keep working while it updates. Update sharing service')
})

test('frame settings: account and token, the service and Update, Remove sharing with its consequence', () => {
  const html = renderToStaticMarkup(<SharingSettingsPanel onFlash={none} initialStatus={{ ...ready, service: { installedBuild: 1, appBuild: 2, compare: 'update' } }} />)
  const panel = (name: string) => text(html.split(`data-panel="${name}">`)[1]!.split(/<div class="shr-panel[^"]*" data-panel=|<div class="shr-settings-col">/)[0]!)
  expect(panel('account')).toContain('Cloudflare account Token accepted Account Example author · personal account Token Kept in the macOS Keychain')
  expect(panel('account')).toContain('Replace token Check token')
  expect(panel('service')).toContain('Sharing service Update available Installed on your account Build 1 Offered by this WriteFlex Build 2 Update sharing service Your links keep working while it updates.')
  expect(panel('remove')).toBe('Remove sharing from this account Deletes the sharing service and everything in it from your Cloudflare account. Every link stops working and comments not yet collected are lost. Your pieces on this Mac are not touched. Remove sharing from this account')
  expect(panel('now')).toContain('State Running Address writeflex-sharing.example.workers.dev')

  const notSetUp = text(renderToStaticMarkup(<SharingSettingsPanel onFlash={none} onOpenSetup={none} initialStatus={fresh} />))
  expect(notSetUp).toContain('Sharing is not set up on this Mac')
  expect(notSetUp).toContain('Set up sharing')
  const interrupted = text(renderToStaticMarkup(<SharingSettingsPanel onFlash={none} onOpenSetup={none} initialStatus={{ ...checked, interrupted: true }} />))
  expect(interrupted).toContain('Set-up did not finish Carry on where it stopped; nothing is sent twice. Carry on setting up')
})

test('a removal that did not finish: Settings shows it with Retry, never "not set up"; the steps page points there', () => {
  const pending: SharingSetupStatus = { ...fresh, removalPending: true, account: { id: 'acc1', name: 'Example author · personal account' }, token: { stored: true, acceptedAt: null, problem: null } }
  const settings = text(renderToStaticMarkup(<SharingSettingsPanel onFlash={none} onOpenSetup={none} initialStatus={pending} />))
  expect(settings).toContain(`Removing sharing did not finish ${REMOVAL_PENDING.reason} Replace token Check token Retry`)
  expect(settings).not.toContain('Sharing is not set up on this Mac')
  const steps = page({ status: pending })
  expect(text(steps)).toContain(`${REMOVAL_PENDING.reason} ${REMOVAL_PENDING.fix} Settings › Sharing`)
  expect(steps).not.toContain('data-step="paste"')
})

test('a removal that did not finish: the token row above Retry, open without a working token, closed (Replace token) with one', () => {
  const account = { id: 'acc1', name: 'Example author · personal account' }
  const pending = (token: SharingSetupStatus['token']): string =>
    renderToStaticMarkup(<SharingSettingsPanel onFlash={none} onOpenSetup={none} initialStatus={{ ...fresh, removalPending: true, account, token }} />)
  for (const [name, token] of [
    ['a rejected saved token', { stored: true, acceptedAt: null, problem: SAVED_TOKEN_REJECTED }],
    ['no stored token', { stored: false, acceptedAt: null, problem: null }],
  ] as const) {
    const html = pending(token)
    expect([name, html.includes('placeholder="Paste the new token here"')]).toEqual([name, true])
    const words = text(html)
    expect(words).toContain('Retry needs a working Cloudflare token.')
    expect(words).toContain('Replace token')
    expect(words.indexOf('Retry needs a working Cloudflare token.')).toBeLessThan(words.lastIndexOf('Retry'))
    expect(html.indexOf('Paste the new token here')).toBeLessThan(html.lastIndexOf('Retry'))
    expect(words.endsWith('Retry')).toBe(true)
    if (token.problem) expect(words).toContain(SAVED_TOKEN_REJECTED.reason)
  }
  const good = pending({ stored: true, acceptedAt: null, problem: null })
  expect(good).not.toContain('placeholder="Paste the new token here"')
  expect(text(good)).not.toContain('Retry needs a working Cloudflare token.')
  expect(text(good)).toContain('Retry')
  // A saved token that may still lack a permission when Retry is pressed: Replace token is offered all the same.
  expect(text(good)).toContain('Replace token Check token')
  expect(text(good).indexOf('Replace token')).toBeLessThan(text(good).lastIndexOf('Retry'))
  // The set-up page's box still points to Settings.
  const steps = page({ status: { ...fresh, removalPending: true, account, token: { stored: false, acceptedAt: null, problem: null } } })
  expect(text(steps)).toContain(`${REMOVAL_PENDING.reason} ${REMOVAL_PENDING.fix} Settings › Sharing`)
  expect(steps).not.toContain('Paste the new token here')
})

test('an interrupted set-up that wrote on its account: the account cannot be changed, and the page says how to finish', () => {
  const html = page({ status: { ...checked, interrupted: true, accountLocked: true } })
  expect(step(html, 'account')).toMatch(/<select[^>]*disabled=""/)
  expect(text(step(html, 'account'))).toContain('Press Set up sharing to finish on Example author · personal account. To use another account, remove sharing from Example author · personal account in Settings › Sharing first.')
  expect(page({ status: { ...checked, interrupted: true } })).not.toMatch(/<select[^>]*disabled=""/)
})
