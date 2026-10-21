// Your own address as drawn (sharing ticket 05; locked frames `setup` b, `setup-problem` 3b,
// `settings`), and the Sharing page's "copy again" text. Drawn from props; nothing reaches the bridge.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SharingSetup } from '../../src/renderer/src/components/sharing/SharingSetup'
import { SharingSettingsPanel } from '../../src/renderer/src/components/settings/SharingSettingsPanel'
import { copyAgainText } from '../../src/renderer/src/components/sharing/sharing-page-model'
import { OWN_LACKS_DNS, ownCheckingText, ownLapsedText, ownNotAttachedText, ownUnconfirmedText, type SharingSetupStatus } from '../../src/shared/sharing-setup'
import type { ShareLinkView } from '../../src/shared/sharing-links'

const none = (): void => {}
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ').trim()
const step = (html: string, name: string): string => html.split(`data-step="${name}">`)[1]!.split(/<div class="shr-step[^"]*" data-step=|<\/section>/)[0]!
const panel = (html: string, name: string): string => html.split(`data-panel="${name}"`)[1]!.replace(/^[^>]*>/, '').split('data-panel=')[0]!

const CLOUDFLARE = 'https://writeflex-sharing.example.workers.dev'
const checked: SharingSetupStatus = {
  ready: false, storageUnavailable: false, token: { stored: true, acceptedAt: new Date(2026, 9, 15, 14, 21).getTime(), problem: null },
  accounts: [{ id: 'acc1', name: 'Dominik Lukes · personal account', workers: true, address: CLOUDFLARE }],
  account: { id: 'acc1', name: 'Dominik Lukes · personal account' }, address: null,
  interrupted: false, accountLocked: false, removalPending: false, service: null, setUpAt: null, ownAddress: null, ownAddressesLeft: [], linksAddress: null,
}
const ready: SharingSetupStatus = {
  ...checked, ready: true, address: CLOUDFLARE, linksAddress: CLOUDFLARE, setUpAt: checked.token.acceptedAt, service: { installedBuild: 3, appBuild: 3, compare: 'current' },
}
const attached: SharingSetupStatus = {
  ...ready, linksAddress: 'https://drafts.writeflex.app',
  ownAddress: { hostname: 'drafts.writeflex.app', name: 'drafts', domain: 'writeflex.app', state: 'attached', earlier: [] },
}
const page = (initial: Parameters<typeof SharingSetup>[0]['initial']) =>
  renderToStaticMarkup(<SharingSetup pieceName="What a reading list is for" onBack={none} onFlash={none} onOpenSettings={none} initial={initial} />)
const settings = (status: SharingSetupStatus, domains = ['lukes.example', 'writeflex.app']) =>
  renderToStaticMarkup(<SharingSettingsPanel onFlash={none} initialStatus={status} initialDomains={domains} />)

test('frame setup b: step 3, the account and your own address as a name in front of a domain on that account', () => {
  const off = page({ status: checked })
  expect(text(step(off, 'account'))).toContain('Choose the account and an address Now')
  expect(text(step(off, 'account'))).toContain('Off Use your own address optional')
  expect(step(off, 'account')).not.toContain('Name in front')

  const html = page({ status: checked, draft: { on: true, name: 'drafts', domain: 'writeflex.app' }, domains: ['writeflex.app'] })
  const three = step(html, 'account')
  expect(text(three)).toContain('On Use your own address optional Name in front + Domain on this account writeflex.app Set up sharing ⌘↵ Back')
  expect(three).toContain('value="drafts"')
  expect(three).toContain('<option value="writeflex.app" selected="">writeflex.app</option>')
  expect(text(html)).toContain('Your links will read drafts.writeflex.app/…')
})

test('frame setup-problem 3b: the domain cannot be attached; the reason, and Use the Cloudflare address, Replace token, Try again', () => {
  const html = page({ status: ready, draft: { on: true, name: 'drafts', domain: 'writeflex.app' }, domains: ['writeflex.app'], addressFailure: { problem: OWN_LACKS_DNS('writeflex.app') } })
  const three = step(html, 'account')
  expect(text(three)).toContain('Choose the account and an address Address not attached')
  expect(text(three)).toContain('writeflex.app cannot be attached. Your token cannot change DNS for this domain; it lacks “Zone · DNS · Edit”. Replace the token with one that has it, or carry on with the address Cloudflare gives your account and add your own address later in Settings. Use the Cloudflare address Replace token Try again')
  expect(three).toMatch(/class="shr-inp err"><input aria-labelledby="shr-own-name"/)
  // Sharing is set up: no second Set up sharing; links read the Cloudflare address.
  expect(text(three)).not.toContain('Set up sharing ⌘↵')
  expect(text(html)).toContain('Your links will read writeflex-sharing.example.workers.dev/…')
})

test('frame settings: your own address, attached, with the earlier address still opening; Change address and Remove own address', () => {
  const html = settings(attached)
  const own = text(panel(html, 'own-address'))
  expect(own).toStartWith('Your own address Attached drafts + writeflex.app Links sent on the earlier address still open. Change address Remove own address <div')
  // Drawn between the account and the service, as in the frame.
  expect(html.indexOf('data-panel="account"')).toBeLessThan(html.indexOf('data-panel="own-address"'))
  expect(html.indexOf('data-panel="own-address"')).toBeLessThan(html.indexOf('data-panel="service"'))
  expect(text(panel(html, 'now'))).toContain('Address writeflex-sharing.example.workers.dev Links read drafts.writeflex.app')
})

test('settings: no own address yet: the Cloudflare address, the fields and Use your own address', () => {
  const own = text(panel(settings(ready), 'own-address'))
  expect(own).toContain('Your own address Not used Links use the address Cloudflare gives your account, writeflex-sharing.example.workers.dev.')
  expect(own).toContain('Name in front + Domain on this account lukes.example writeflex.app Use your own address')
})

test('settings: waiting for Cloudflare, and lapsed: what readers get and Check again', () => {
  const waiting = text(panel(settings({ ...attached, linksAddress: CLOUDFLARE, ownAddress: { ...attached.ownAddress!, state: 'waiting' } }), 'own-address'))
  expect(waiting).toContain('Waiting for Cloudflare')
  expect(waiting).toContain('Cloudflare is still preparing it')
  expect(waiting).toContain('Check again Change address Remove own address')
  const lapsed = text(panel(settings({ ...attached, linksAddress: CLOUDFLARE, ownAddress: { ...attached.ownAddress!, state: 'lapsed' } }), 'own-address'))
  expect(lapsed).toContain(`Not answering drafts + writeflex.app ${text(ownLapsedText('drafts.writeflex.app'))}`)
  expect(lapsed).toContain('Check again Change address Remove own address')
})

test('settings: not attached (the attach got no clear answer): Address not attached, why, and Try again instead of Check again', () => {
  const pending = settings({ ...attached, linksAddress: CLOUDFLARE, ownAddress: { ...attached.ownAddress!, state: 'not-attached' } })
  const own = text(panel(pending, 'own-address'))
  expect(own).toContain(`Address not attached drafts + writeflex.app ${ownNotAttachedText('drafts.writeflex.app')}`)
  expect(own).not.toContain('Cloudflare is still preparing it')
  expect(own).not.toContain('is attached.')
  expect(own).toContain('Try again Change address Remove own address')
  expect(own).not.toContain('Check again')
  expect(text(panel(pending, 'now'))).not.toContain('Links read')
})

test('settings: not confirmed with Cloudflare within the day: the address as configured, never as the address links read (review round 2)', () => {
  const checking = settings({ ...attached, linksAddress: CLOUDFLARE, ownAddress: { ...attached.ownAddress!, state: 'checking' } })
  const own = text(panel(checking, 'own-address'))
  expect(own).toContain(`Checking… drafts + writeflex.app ${ownCheckingText('drafts.writeflex.app')}`)
  expect(own).toContain('Check again Change address Remove own address')
  expect(own).not.toContain('Replace token')
  // Links read the Cloudflare address: the own address is not offered as the address links use.
  expect(text(panel(checking, 'now'))).not.toContain('Links read')
  expect(text(panel(checking, 'now'))).toContain('Address writeflex-sharing.example.workers.dev')

  const unconfirmed = settings({ ...attached, linksAddress: CLOUDFLARE, ownAddress: { ...attached.ownAddress!, state: 'unconfirmed' } })
  const said = text(panel(unconfirmed, 'own-address'))
  expect(said).toContain(`Not confirmed drafts + writeflex.app ${ownUnconfirmedText('drafts.writeflex.app')}`)
  expect(ownUnconfirmedText('drafts.writeflex.app')).toStartWith('WriteFlex could not confirm drafts.writeflex.app with Cloudflare. New links use the address Cloudflare gives your account until it can.')
  expect(said).toContain('Check again Replace token Change address Remove own address')
  expect(text(panel(unconfirmed, 'now'))).not.toContain('Links read')
})

test('settings: a Remove own address that did not finish: the address left, Finish removing (review round 1, finding 4)', () => {
  const own = text(panel(settings({ ...ready, ownAddressesLeft: ['drafts.writeflex.app'] }), 'own-address'))
  expect(own).toContain('Your own address Not used')
  expect(own).toContain('Not removed yet: drafts.writeflex.app. New links do not use it. Finish removing')
  expect(text(panel(settings(ready), 'own-address'))).not.toContain('Finish removing')
})

test('copy again: the links that are on, on the Cloudflare address; one link alone, several with their names', () => {
  const link = (shareId: string, name: string | null, on = true): ShareLinkView => ({
    shareId, name, address: `${CLOUDFLARE}/s/${shareId}`, cloudflareAddress: `${CLOUDFLARE}/s/${shareId}`, comments: true, notes: 'private', on,
    madeAt: new Date(2026, 9, 13).getTime(), publishedAt: null, publishedSavedAt: null, problem: null, publishing: false, note: null,
  })
  expect(copyAgainText([link('aaaaaaaa11', 'Marta'), link('bbbbbbbb22', null, false)])).toBe(`${CLOUDFLARE}/s/aaaaaaaa11`)
  expect(copyAgainText([link('aaaaaaaa11', 'Marta'), link('cccccccc33', null)])).toBe(`Marta: ${CLOUDFLARE}/s/aaaaaaaa11\nPrivate comments · 13 Oct: ${CLOUDFLARE}/s/cccccccc33`)
  expect(copyAgainText([])).toBe('')
})
