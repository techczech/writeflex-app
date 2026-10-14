// What a widget's frame is and what goes into its document (interactive-widgets ticket 02). The lead
// cases are ported from TalkWeaver's embed-frame tests at 6ec8102f.
import { expect, test } from 'bun:test'
import {
  assertWidgetSandbox,
  WIDGET_PAGE_POLICY,
  WIDGET_POLICY_META,
  WIDGET_SANDBOX,
  widgetDocumentLead,
  widgetFrameAttributes,
  widgetHasOwnBase,
  widgetLeadPosition,
  widgetPageTitle,
  withWidgetLead,
} from '../../src/shared/widget-document'
import { WIDGET_AGENT_SOURCE } from '../../src/shared/widget-agent-source'

test('the sandbox is exactly allow-scripts allow-forms, and the guard throws on anything else', () => {
  expect(WIDGET_SANDBOX.join(' ')).toBe('allow-scripts allow-forms')
  expect(Object.isFrozen(WIDGET_SANDBOX)).toBe(true)
  expect(() => assertWidgetSandbox('allow-scripts allow-forms')).not.toThrow()
  expect(() => assertWidgetSandbox(['allow-scripts', 'allow-forms'])).not.toThrow()
  for (const bad of [
    'allow-scripts allow-forms allow-same-origin',
    'allow-same-origin allow-scripts allow-forms',
    'allow-scripts allow-forms ALLOW-SAME-ORIGIN',
    'allow-scripts allow-forms allow-top-navigation',
    'allow-scripts allow-forms allow-popups',
    'allow-scripts allow-forms allow-downloads',
    'allow-scripts',
    '',
  ]) expect(() => assertWidgetSandbox(bad), bad).toThrow(/exactly allow-scripts allow-forms/)
  expect(() => assertWidgetSandbox(null)).toThrow()
  expect(() => assertWidgetSandbox(undefined)).toThrow()
})

test('the frame carries the sandbox, credentialless and no referrer, and no src', () => {
  const attributes = new Map(widgetFrameAttributes())
  expect(attributes.get('sandbox')).toBe('allow-scripts allow-forms')
  expect(attributes.has('credentialless')).toBe(true)
  expect(attributes.get('referrerpolicy')).toBe('no-referrer')
  expect(attributes.get('allow')).toContain("camera 'none'")
  expect(attributes.has('src')).toBe(false)
  expect(attributes.has('srcdoc')).toBe(false) // given only after the frame is sealed and activated
  expect(widgetFrameAttributes()[0][0]).toBe('sandbox') // set first
})

test('the policy refuses the network: no http, https, ws, file or self; data: and blob: only', () => {
  const directives = new Map(WIDGET_PAGE_POLICY.split(';').map((part) => { const [name, ...values] = part.trim().split(/\s+/); return [name, values] }))
  expect(directives.get('default-src')!.sort()).toEqual(["'unsafe-eval'", "'unsafe-inline'", 'blob:', 'data:'].sort())
  expect(directives.get('form-action')).toEqual(["'none'"])
  for (const scheme of ['http:', 'https:', 'ws:', 'wss:', 'file:', "'self'", '*', 'wf-asset:']) expect(WIDGET_PAGE_POLICY).not.toContain(scheme)
  // No directive that would widen what default-src allows.
  for (const name of directives.keys()) expect(['default-src', 'form-action']).toContain(name)
  expect(WIDGET_POLICY_META).toBe(`<meta http-equiv="Content-Security-Policy" content="${WIDGET_PAGE_POLICY}">`)
})

test('the agent can be inlined as it is', () => {
  expect(/<\/script/i.test(WIDGET_AGENT_SOURCE)).toBe(false)
  expect(WIDGET_AGENT_SOURCE.includes('<!--')).toBe(false)
  expect(() => new Function(WIDGET_AGENT_SOURCE)).not.toThrow()
  const lead = widgetDocumentLead()
  expect(lead.startsWith(WIDGET_POLICY_META)).toBe(true)
  expect(lead).toContain('<meta name="referrer" content="no-referrer">')
  expect(lead).toContain('<base href="about:srcdoc">')
  expect(widgetDocumentLead({ ownBase: true })).not.toContain('<base')
})

test('the lead goes after the doctype, past comments, a BOM and an XML prolog; else at the start', () => {
  expect(widgetLeadPosition('<!doctype html><p>x')).toBe('<!doctype html>'.length)
  expect(widgetLeadPosition('<!DOCTYPE html>\n<html>')).toBe('<!DOCTYPE html>'.length)
  expect(widgetLeadPosition('<p>no doctype</p>')).toBe(0)
  expect(widgetLeadPosition('')).toBe(0)
  const commented = '<!-- note -->\n<!doctype html><p>'
  expect(widgetLeadPosition(commented)).toBe(commented.indexOf('<p>'))
  const prolog = '<?xml version="1.0"?>\n<!DOCTYPE html><html>'
  expect(widgetLeadPosition(prolog)).toBe(prolog.indexOf('<html>'))
  const bom = '﻿<!doctype html><body>'
  expect(widgetLeadPosition(bom)).toBe(bom.indexOf('<body>'))
  // A script before anything is page content: the lead goes in front of it.
  expect(widgetLeadPosition('<script>steal()</script><!doctype html>')).toBe(0)
  // An unterminated comment swallows the rest: nothing after it can run before the lead.
  expect(widgetLeadPosition('<!-- open <!doctype html>')).toBe(0)
})

test('withWidgetLead: nothing the author wrote comes before the policy', () => {
  const page = '<!doctype html><html><head><script>window.ran = 1</script></head><body></body></html>'
  const out = withWidgetLead(page)
  expect(out.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true)
  expect(out.indexOf('<script>window.ran')).toBeGreaterThan(out.indexOf('Content-Security-Policy'))
  expect(out.endsWith(page.slice('<!doctype html>'.length))).toBe(true)
  // A page with its own <base href> keeps it and is not given ours.
  expect(withWidgetLead('<base href="https://example.com/"><p>')).not.toContain('about:srcdoc')
})

test('own base: only a real <base> element with an href', () => {
  expect(widgetHasOwnBase('<base href="x/">')).toBe(true)
  expect(widgetHasOwnBase('<BASE HREF=x>')).toBe(true)
  expect(widgetHasOwnBase('<base target="_blank">')).toBe(false)
  expect(widgetHasOwnBase('<!-- <base href="x"> -->')).toBe(false)
  expect(widgetHasOwnBase('<script>"<base href=x>"</script>')).toBe(false)
  expect(widgetHasOwnBase('<textarea><base href=x></textarea>')).toBe(false)
  expect(widgetHasOwnBase('<svg><base href=x></svg>')).toBe(false)
})

test('the page title: the first real <title>, decoded, collapsed, 80 characters at most', () => {
  expect(widgetPageTitle('<title>Orbit &amp; gravity</title>')).toBe('Orbit & gravity')
  expect(widgetPageTitle('<title>  two\n  lines </title>')).toBe('two lines')
  expect(widgetPageTitle('<title>&#x41;&#66;&lt;</title>')).toBe('AB<')
  expect(widgetPageTitle('<!-- <title>no</title> --><title>yes</title>')).toBe('yes')
  expect(widgetPageTitle('<svg><title>icon</title></svg>')).toBe('')
  expect(widgetPageTitle('<p>none</p>')).toBe('')
  expect(Array.from(widgetPageTitle(`<title>${'x'.repeat(200)}</title>`)).length).toBe(80)
  expect(widgetPageTitle('<title><b>bold</b> text</title>')).toBe('bold text')
})

import { withoutDeclarativeShadow } from '../../src/shared/widget-document'

test('no declarative shadow tree survives: every spelling of shadowrootmode is made inert', () => {
  for (const markup of ['<template shadowrootmode="closed"><iframe></iframe></template>', '<TEMPLATE ShadowRootMode=open>', '<template shadowrootmode>']) {
    const out = withoutDeclarativeShadow(markup)
    expect(/(^|[^-])shadowrootmode/i.test(out.replace(/data-wf-inert-shadowrootmode/gi, ''))).toBe(false)
    expect(out).toMatch(/data-wf-inert-shadowrootmode/i)
  }
  expect(withWidgetLead('<template shadowrootmode="closed"><iframe srcdoc="x"></iframe></template>')).not.toMatch(/ shadowrootmode=/i)
  expect(withoutDeclarativeShadow('<p>plain</p>')).toBe('<p>plain</p>')
})
