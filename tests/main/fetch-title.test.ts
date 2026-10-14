import { test, expect } from 'bun:test'
import { extractTitle, fetchLinkTitle, validateRedirectTarget } from '../../src/main/fetch-title'

test('extractTitle reads <title>, collapses whitespace, decodes basic entities', () => {
  expect(extractTitle('<html><head><title>\n  A &amp; B &#8212; C  </title></head></html>')).toBe('A & B — C')
  expect(extractTitle('<title lang="en">Attr title</title>')).toBe('Attr title')
})

test('extractTitle falls back to og:title, else null', () => {
  expect(extractTitle('<meta property="og:title" content="OG Title">')).toBe('OG Title')
  expect(extractTitle('<p>no title</p>')).toBeNull()
  expect(extractTitle('<title></title>')).toBeNull()
})

test('extractTitle caps length at 200', () => {
  const long = `<title>${'x'.repeat(300)}</title>`
  expect(extractTitle(long)!.length).toBe(200)
})

test('fetchLinkTitle rejects non-http(s) schemes without throwing', async () => {
  expect(await fetchLinkTitle('file:///etc/passwd')).toBeNull()
  expect(await fetchLinkTitle('not a url')).toBeNull()
})

test('extractTitle never throws on out-of-range numeric entities', () => {
  expect(extractTitle('<title>&#xFFFFFFFF; ok</title>')).toBe('� ok')
  expect(extractTitle('<title>&#4294967295;</title>')).toBe('�')
})

test('fetchLinkTitle refuses loopback, private, link-local, and .local hosts', async () => {
  for (const url of [
    'http://localhost/x', 'http://127.0.0.1:8080/', 'http://10.0.0.5/', 'http://192.168.1.1/',
    'http://172.16.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://printer.local/'
  ]) {
    expect(await fetchLinkTitle(url)).toBeNull()
  }
})

test('redirect targets are re-validated per hop', () => {
  const base = new URL('https://example.com/a')
  expect(validateRedirectTarget('https://ok.example.org/b', base)!.hostname).toBe('ok.example.org')
  expect(validateRedirectTarget('/relative', base)!.pathname).toBe('/relative')
  expect(validateRedirectTarget('http://169.254.169.254/latest', base)).toBeNull()
  expect(validateRedirectTarget('//127.0.0.1/x', base)).toBeNull()
  expect(validateRedirectTarget('ftp://x.io/', base)).toBeNull()
  expect(validateRedirectTarget('%%%not-a-url', base)).toBeNull()
})
