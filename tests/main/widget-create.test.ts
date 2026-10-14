import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability, CapabilityContext } from '@bridle/core'
import { buildWriteFlexManifest } from '../../src/main/capabilities'
import { CAPABILITY_PERMISSION_KEYS, capabilityEnabled, writeflexApprovalPolicy } from '../../src/main/verbs/verb-support'
import { ChangeStore, isChangeJournalPath, newFilePartOf } from '../../src/main/changes'
import { checkWidgetHtml, isWidgetFileName, planWidgetFile, undoWidgetFile, widgetFileName, widgetFileSha256, WIDGET_CREATE_MAX_BYTES, writeWidgetFile } from '../../src/main/widget-create'
import { SavedButNotReadBack, Workspace } from '../../src/main/workspace'

// Interactive widgets, ticket 07: the agent makes a widget. The write is the thing under test.

const PAGE = '<!doctype html><html><head><title>Pace</title><style>b{color:red}</style></head><body><b id="o">0</b><script>document.getElementById("o").textContent="1"</script></body></html>'
let root: string
let outside: string
let ws: Workspace
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'wf-widget-create-')))
  outside = await realpath(await mkdtemp(join(tmpdir(), 'wf-widget-create-out-')))
  await mkdir(join(root, 'essays'), { recursive: true })
  await writeFile(join(root, 'essays/doc.md'), 'Intro.\n\nMore.\n')
  ws = new Workspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const ctx: CapabilityContext = {
  trigger: { id: 't', source: 'user', trust: 'interactive' },
  sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {},
}
/** The review surface's answer at accept time. These tests are about the write, so by default the writer HAS been shown the file. */
const shownToWriter = { widgetFileShown: async () => true }
const verb = (name: string, options: { workspace?: Workspace; isEnabled?: (name: string) => boolean; services?: Parameters<typeof buildWriteFlexManifest>[2] } = {}): Capability => {
  const cap = buildWriteFlexManifest(options.workspace ?? ws, options.isEnabled, options.services ?? shownToWriter).capabilities.find((c): c is Capability => c.name === name)
  if (!cap) throw new Error(`missing ${name}`)
  return cap
}
const write = (document: string, planned: string, html: string) => writeWidgetFile(root, document, planned, html, widgetFileSha256(html), () => true)
const input = (extra: Record<string, unknown> = {}) => ({ path: 'essays/doc.md', fileName: 'pace.html', html: PAGE, title: 'Pace', ...extra })
const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false)

// ---- the instructions the agent receives -------------------------------------------------------

test('the agent\'s instructions carry the widget rules', () => {
  const preamble = buildWriteFlexManifest(ws).systemPromptPreamble ?? ''
  for (const needle of [
    'A widget is an interactive HTML page',
    '[Simulation: assets/compound-interest.html]',
    'one line of its own',
    'one self-contained HTML file inside the Workspace',
    'inline CSS and JavaScript',
    'no network of any kind',
    'data: and blob: URLs only',
    'widgets.list', 'widgets.create', 'widgets.insert', 'widgets.remove',
    'are proposals: the writer accepts or discards them',
    'the block sizes to its content, so keep it compact',
    'clicks into the widget',
    'Esc',
    'calculator, chart, simulation or any interactive X',
  ]) expect(preamble, needle).toContain(needle)
})

test('widgets.create is described to the agent, is agent-visible, and is gated by the create-files switch', () => {
  const create = verb('widgets.create')
  expect(create.risk).toBe('write')
  expect(create.description).toContain('[Simulation: assets/<file>]')
  expect(create.description).toContain('discarding writes nothing')
  expect(create.description).toContain('shown the new file')
  // It makes a file and edits the document, so either switch being off turns it off.
  expect(CAPABILITY_PERMISSION_KEYS['widgets.create']).toEqual(['permissions.createFiles', 'permissions.proseEdits'])
  expect(capabilityEnabled('widgets.create', () => undefined)).toBe(true)
  expect(capabilityEnabled('widgets.create', (key) => key === 'permissions.createFiles' ? false : undefined)).toBe(false)
  expect(capabilityEnabled('widgets.create', (key) => key === 'permissions.proseEdits' ? false : undefined)).toBe(false)
})

test('nothing the agent is told claims the text check keeps a widget offline: the sealed frame does', () => {
  const texts = [buildWriteFlexManifest(ws).systemPromptPreamble ?? '', verb('widgets.create').description]
  for (const text of texts) {
    expect(text).toContain('sealed')
    expect(text).toContain('the obvious cases')
    expect(text).not.toContain('a page that needs the network is refused')
  }
})

test('the text check is an early refusal, not the wall: a page that assembles its address at run time passes it', () => {
  // review finding bypass. Accepted on purpose: inside the sealed frame the call fails, so the widget is merely broken.
  const assembled = '<title>x</title><script>window["fe"+"tch"]("ht"+"tps:"+"/"+"/example.com/x")</script>'
  expect(checkWidgetHtml(assembled, 'x')).toEqual({ ok: true, html: assembled })
})

test('the policy stages widgets.create even for an interactive trigger', async () => {
  const interactive = { id: 't', source: 'user' as const, trust: 'interactive' as const }
  expect(await writeflexApprovalPolicy()({ capability: { name: 'widgets.create', risk: 'write' }, input: {}, trigger: interactive })).toBe('stage')
})

// ---- the no-network check ----------------------------------------------------------------------

test('a page that needs the network or another file is refused with a sentence, never stripped', () => {
  const bad = [
    '<title>x</title><script src="https://cdn.example.com/lib.js"></script>',
    '<title>x</title><link rel="stylesheet" href="//fonts.example.com/a.css">',
    '<title>x</title><img src="photo.png">',
    '<title>x</title><style>@import url(style.css);</style>',
    '<title>x</title><style>body{background:url(//x.example/a.png)}</style>',
    '<title>x</title><style>body{background:url(bg.png)}</style>',
    '<title>x</title><script>fetch("data.json")</script>',
    '<title>x</title><script>new XMLHttpRequest()</script>',
    '<title>x</title><script>new WebSocket("wss://a.b")</script>',
    '<title>x</title><script>const m = await import("./m.js")</script>',
    '<title>x</title><script type="module">import { a } from "./a.js"</script>',
    '<title>x</title><script>var u = "//cdn.example.com/x"</script>',
    '<title>x</title><script>navigator.sendBeacon("/x")</script>',
  ]
  for (const html of bad) {
    const checked = checkWidgetHtml(html, 'x')
    expect(checked.ok, html).toBe(false)
    if (!checked.ok) expect(checked.message, html).toMatch(/^The widget/)
  }
})

test('inline pages pass: data: and blob: URLs, SVG xmlns declarations, in-page anchors', () => {
  const ok = '<title>x</title><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg><img src="data:image/png;base64,AAAA"><a href="#top">top</a><style>i{background:url("data:image/svg+xml,%3Csvg%3E")}</style>'
  expect(checkWidgetHtml(ok, 'x')).toEqual({ ok: true, html: ok })
})

test('a page without a <title> gets the given title, escaped, in the head; none at all is refused', () => {
  const withHead = checkWidgetHtml('<html><head><meta charset="utf-8"></head><body>hi</body></html>', 'A < B & C')
  expect(withHead).toMatchObject({ ok: true })
  if (withHead.ok) expect(withHead.html).toContain('<head><title>A &lt; B &amp; C</title><meta')
  const bare = checkWidgetHtml('<button>go</button>', 'Go')
  if (bare.ok) expect(bare.html).toContain('<title>Go</title>'); else throw new Error('refused')
  expect(checkWidgetHtml('<button>go</button>', '  ').ok).toBe(false)
})

test('oversize content is refused at the cap', () => {
  const big = `<title>x</title>${'a'.repeat(WIDGET_CREATE_MAX_BYTES)}`
  const refused = checkWidgetHtml(big, 'x')
  expect(refused.ok).toBe(false)
  expect(checkWidgetHtml(`<title>x</title>${'a'.repeat(WIDGET_CREATE_MAX_BYTES - 100)}`, 'x').ok).toBe(true)
})

// ---- names and the plan (read-only) ------------------------------------------------------------

test('names are cleaned to a plain base name; only .html is accepted', () => {
  expect(widgetFileName('../../etc/Pace Calc!.html')).toEqual({ ok: true, name: 'pace-calc.html' })
  expect(widgetFileName('/abs/olute/x.HTM')).toEqual({ ok: true, name: 'x.html' })
  expect(widgetFileName('..\\..\\win.html')).toEqual({ ok: true, name: 'win.html' })
  expect(widgetFileName('...html')).toEqual({ ok: true, name: 'widget.html' })
  expect(widgetFileName('Ünïcödé — name.html')).toEqual({ ok: true, name: 'unicode-name.html' })
  for (const bad of ['pace.js', 'pace', 'pace.html.exe', '', '   ', 'a\0b.html', 42]) expect(widgetFileName(bad).ok, String(bad)).toBe(false)
})

test('one function makes the final name: a numbered name fits the length limit and the writer accepts it as it stands', async () => {
  const long = `${'a'.repeat(60)}.html` // review finding: a 60-character stem, then a collision
  const first = widgetFileName(long)
  const second = widgetFileName(long, 2)
  const twelfth = widgetFileName(long, 12)
  if (!first.ok || !second.ok || !twelfth.ok) throw new Error('refused')
  expect(first.name).toBe(`${'a'.repeat(60)}.html`)
  expect(second.name).toBe(`${'a'.repeat(58)}-2.html`)
  expect(twelfth.name).toBe(`${'a'.repeat(57)}-12.html`)
  for (const name of [first.name, second.name, twelfth.name]) expect(isWidgetFileName(name), name).toBe(true)
  // Shortening never leaves a hyphen dangling before the number.
  expect(widgetFileName(`${'a'.repeat(57)}-bcd.html`, 2)).toEqual({ ok: true, name: `${'a'.repeat(57)}-2.html` })
  for (const bad of ['Bad Name.html', 'a--b.html', '-a.html', 'a-.html', 'a.htm', '.html', `${'a'.repeat(61)}.html`, 'a/b.html', '../a.html']) expect(isWidgetFileName(bad), bad).toBe(false)

  // The whole route: the first widget takes the long name, the second is planned AND written under the numbered one.
  expect((await verb('widgets.create').execute(input({ fileName: long }), ctx)).isError).toBeFalsy()
  const plan = await planWidgetFile(root, 'essays/doc.md', long)
  expect(plan).toEqual({ ok: true, path: `essays/assets/${second.name}`, rawPath: `assets/${second.name}` })
  const again = await verb('widgets.create').execute(input({ fileName: long }), ctx)
  expect(again.isError, again.text).toBeFalsy()
  expect((await readdir(join(root, 'essays/assets'))).sort()).toEqual([first.name, second.name].sort())
})

test('the plan names assets/ beside the document, picks a numbered free name, and writes nothing', async () => {
  const first = await planWidgetFile(root, 'essays/doc.md', 'pace.html')
  expect(first).toEqual({ ok: true, path: 'essays/assets/pace.html', rawPath: 'assets/pace.html' })
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
  await mkdir(join(root, 'essays/assets'))
  await writeFile(join(root, 'essays/assets/pace.html'), 'mine')
  await writeFile(join(root, 'essays/assets/pace-2.html'), 'mine too')
  expect(await planWidgetFile(root, 'essays/doc.md', 'pace.html')).toEqual({ ok: true, path: 'essays/assets/pace-3.html', rawPath: 'assets/pace-3.html' })
  await writeFile(join(root, 'top.md'), 'x')
  expect(await planWidgetFile(root, 'top.md', 'pace.html')).toEqual({ ok: true, path: 'assets/pace.html', rawPath: 'assets/pace.html' })
})

test('a widget goes only beside a Markdown document in a visible folder: not .git, not .writeflex, not a non-document', async () => {
  await mkdir(join(root, '.git/hooks'), { recursive: true })
  await writeFile(join(root, '.git/config'), '[core]\n')
  await writeFile(join(root, '.git/notes.md'), 'x')
  await writeFile(join(root, 'essays/data.json'), '{}')
  for (const document of ['.git/config', '.git/notes.md', 'essays/data.json', 'essays/missing.md', 'essays']) {
    const plan = await planWidgetFile(root, document, 'pace.html')
    expect(plan.ok, document).toBe(false)
    expect((await write(document, `${document.split('/').slice(0, -1).join('/')}/assets/pace.html`, PAGE)).ok, document).toBe(false)
    const result = await verb('widgets.create').execute(input({ path: document }), ctx)
    expect(result.isError, document).toBe(true)
  }
  expect(await exists(join(root, '.git/assets'))).toBe(false)
  expect(await readFile(join(root, '.git/config'), 'utf8')).toBe('[core]\n')
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
})

// ---- the write ---------------------------------------------------------------------------------

test('the write creates assets/ if missing and lands exactly at the planned path', async () => {
  const plan = await planWidgetFile(root, 'essays/doc.md', 'pace.html')
  if (!plan.ok) throw new Error(plan.message)
  expect(await write('essays/doc.md', plan.path, PAGE)).toMatchObject({ ok: true, created: { path: 'essays/assets/pace.html', madeFolder: true } })
  expect(await readFile(join(root, 'essays/assets/pace.html'), 'utf8')).toBe(PAGE)
  expect((await readdir(join(root, 'essays/assets')))).toEqual(['pace.html'])
})

test('the write refuses traversal, an absolute path, and any place that is not assets/ beside the document', async () => {
  for (const planned of ['../escape.html', 'essays/../../escape.html', '/etc/escape.html', join(outside, 'escape.html'), 'essays/escape.html', 'essays/assets/sub/escape.html', 'essays/assets/Bad Name.html', 'other/assets/x.html', 'essays/assets/../assets/x.html', 'essays//assets/x.html', 'essays/assets/x.html\0', 'essays/assets/x.html ', 'essays/assets/x.html.', 'essays/assets/X.html']) {
    const result = await write('essays/doc.md', planned, PAGE)
    expect(result.ok, planned).toBe(false)
  }
  expect(await exists(join(outside, 'escape.html'))).toBe(false)
  expect(await exists(join(root, 'escape.html'))).toBe(false)
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
})

test('a file name carrying traversal is cleaned to a name inside assets/', async () => {
  const plan = await planWidgetFile(root, 'essays/doc.md', '../../../escape.html')
  expect(plan).toEqual({ ok: true, path: 'essays/assets/escape.html', rawPath: 'assets/escape.html' })
})

// review finding blocking 1: links are REFUSED, not resolved and contained. Each case is refused by the plan, the write and the verb.
const refusedEverywhere = async (document: string, planned: string): Promise<void> => {
  const plan = await planWidgetFile(root, document, 'pace.html')
  expect(plan.ok, `plan ${document}`).toBe(false)
  const written = await write(document, planned, PAGE)
  expect(written.ok, `write ${document}`).toBe(false)
  const create = verb('widgets.create') as Capability & { validateStage?: (i: unknown) => Promise<{ decision: string; reason?: { message: string } }> }
  const staged = await create.validateStage!(input({ path: document }))
  expect(staged.decision, `stage ${document}`).toBe('deny')
  expect(staged.reason?.message ?? '').not.toContain(root)
  const result = await create.execute(input({ path: document }), ctx)
  expect(result.isError, `verb ${document}`).toBe(true)
  expect(result.text).not.toContain(root)
}

test('a symlinked assets/ is refused even when it stays inside the workspace; nothing lands at its target', async () => {
  await mkdir(join(root, 'shared'))
  await symlink('../shared', join(root, 'essays/assets')) // review finding input: essays/assets -> ../shared
  await refusedEverywhere('essays/doc.md', 'essays/assets/pace.html')
  expect(await readdir(join(root, 'shared'))).toEqual([])
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n')
})

test('a symlinked assets/ that leads outside the workspace is refused', async () => {
  await symlink(outside, join(root, 'essays/assets'))
  await refusedEverywhere('essays/doc.md', 'essays/assets/pace.html')
  expect(await readdir(outside)).toEqual([])
})

test('a document reached through a symlinked folder is refused, inside the workspace or out, at any depth', async () => {
  await mkdir(join(root, 'real/deep'), { recursive: true })
  await writeFile(join(root, 'real/doc.md'), 'Real.\n')
  await writeFile(join(root, 'real/deep/doc.md'), 'Deep.\n')
  await symlink(join(root, 'real'), join(root, 'linked')) // review finding input: linked -> real
  await refusedEverywhere('linked/doc.md', 'linked/assets/pace.html')
  await refusedEverywhere('linked/deep/doc.md', 'linked/deep/assets/pace.html')
  expect(await exists(join(root, 'real/assets'))).toBe(false)
  expect(await exists(join(root, 'real/deep/assets'))).toBe(false)
  expect(await readFile(join(root, 'real/doc.md'), 'utf8')).toBe('Real.\n')

  await writeFile(join(outside, 'doc.md'), 'x')
  await symlink(outside, join(root, 'out'))
  const plan = await planWidgetFile(root, 'out/doc.md', 'pace.html')
  expect(plan.ok).toBe(false)
  expect((await write('out/doc.md', 'out/assets/pace.html', PAGE)).ok).toBe(false)
  expect(await readdir(outside)).toEqual(['doc.md'])
})

test('a symlinked document is refused: it is neither read into a proposal nor replaced by the save', async () => {
  await writeFile(join(root, 'real.md'), 'Real.\n')
  await symlink('../real.md', join(root, 'essays/link.md'))
  await refusedEverywhere('essays/link.md', 'essays/assets/pace.html')
  expect((await lstat(join(root, 'essays/link.md'))).isSymbolicLink()).toBe(true)
  expect(await readFile(join(root, 'real.md'), 'utf8')).toBe('Real.\n')
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
})

test('the write never overwrites an existing file, a planted link at the name included', async () => {
  await mkdir(join(root, 'essays/assets'))
  await writeFile(join(root, 'essays/assets/pace.html'), 'mine')
  const clash = await write('essays/doc.md', 'essays/assets/pace.html', PAGE)
  expect(clash.ok).toBe(false)
  expect(await readFile(join(root, 'essays/assets/pace.html'), 'utf8')).toBe('mine')
  await symlink(join(outside, 'victim.html'), join(root, 'essays/assets/planted.html'))
  expect((await write('essays/doc.md', 'essays/assets/planted.html', PAGE)).ok).toBe(false)
  expect(await exists(join(outside, 'victim.html'))).toBe(false)
  // The plan treats the planted link as a taken name rather than following it.
  expect(await planWidgetFile(root, 'essays/doc.md', 'planted.html')).toMatchObject({ ok: true, path: 'essays/assets/planted-2.html' })
})

test('the write refuses a non-html name and a page over the cap', async () => {
  expect((await write('essays/doc.md', 'essays/assets/pace.js', PAGE)).ok).toBe(false)
  expect((await write('essays/doc.md', 'essays/assets/pace.html', `<title>x</title>${'a'.repeat(WIDGET_CREATE_MAX_BYTES)}`)).ok).toBe(false)
  expect(await exists(join(root, 'essays/assets/pace.html'))).toBe(false)
})

test('the write takes the page verbatim: bytes that do not hash to what was shown, or a page not in final form, are refused', async () => {
  const other = PAGE.replace('"1"', '"2"')
  expect((await writeWidgetFile(root, 'essays/doc.md', 'essays/assets/pace.html', other, widgetFileSha256(PAGE), () => true)).ok).toBe(false)
  expect((await write('essays/doc.md', 'essays/assets/pace.html', '<button>no title yet</button>')).ok).toBe(false)
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
})

test('undo removes only the file that was written, and says so when what is there now is something else', async () => {
  const written = await write('essays/doc.md', 'essays/assets/pace.html', PAGE)
  if (!written.ok) throw new Error(written.message)
  await rm(join(root, 'essays/assets/pace.html'))
  await writeFile(join(root, 'essays/assets/pace.html'), 'the writer put this here')
  const undone = await undoWidgetFile(root, written.created)
  expect(undone.removed).toBe(false)
  expect(await readFile(join(root, 'essays/assets/pace.html'), 'utf8')).toBe('the writer put this here')
})

// ---- the verb ----------------------------------------------------------------------------------

test('proposing writes nothing: validateStage, preview and touchedPaths leave the disk alone', async () => {
  const create = verb('widgets.create') as Capability & { validateStage?: (i: unknown) => Promise<{ decision: string }>; touchedPaths?: (i: unknown) => Promise<string[]> }
  expect((await create.validateStage!(input())).decision).toBe('pass')
  expect(await create.touchedPaths!(input())).toEqual([join(root, 'essays/doc.md'), join(root, 'essays/assets/pace.html')])
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n')
})

test('accepting (running) the verb writes the file and the line together', async () => {
  const result = await verb('widgets.create').execute(input(), ctx)
  expect(result.isError).toBeFalsy()
  expect(await readFile(join(root, 'essays/assets/pace.html'), 'utf8')).toBe(PAGE)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n\n[Simulation: assets/pace.html]\n')
})

test('a second widget with the same name gets a numbered suffix and the first is untouched', async () => {
  await verb('widgets.create').execute(input(), ctx)
  const second = await verb('widgets.create').execute(input({ html: PAGE.replace('Pace', 'Pace two'), title: 'Pace two' }), ctx)
  expect(second.isError).toBeFalsy()
  expect(await readFile(join(root, 'essays/assets/pace.html'), 'utf8')).toBe(PAGE)
  expect(await readFile(join(root, 'essays/assets/pace-2.html'), 'utf8')).toContain('Pace two')
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n\n[Simulation: assets/pace.html]\n\n[Simulation: assets/pace-2.html]\n')
})

test('the verb writes the declared path, and refuses if that name was taken after the proposal', async () => {
  const declared = [join(root, 'essays/doc.md'), join(root, 'essays/assets/pace.html')]
  await mkdir(join(root, 'essays/assets'))
  await writeFile(join(root, 'essays/assets/pace.html'), 'appeared since')
  const result = await verb('widgets.create').execute(input(), { ...ctx, resolvedTouchedPaths: declared })
  expect(result.isError).toBe(true)
  expect(await readFile(join(root, 'essays/assets/pace.html'), 'utf8')).toBe('appeared since')
  expect(await readdir(join(root, 'essays/assets'))).toEqual(['pace.html'])
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n')
})

test('a declared path outside assets/ beside the document, or more than one declared file, writes nothing', async () => {
  for (const extra of [[join(root, 'essays/evil.html')], [join(root, 'assets/pace.html')], [join(root, 'essays/assets/pace.html'), join(root, 'essays/assets/other.html')], [join(root, 'essays/assets/Pace.html')]]) {
    const result = await verb('widgets.create').execute(input(), { ...ctx, resolvedTouchedPaths: [join(root, 'essays/doc.md'), ...extra] })
    expect(result.isError, extra.join(',')).toBe(true)
    expect(result.text).not.toContain(root)
  }
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
  expect(await exists(join(root, 'assets'))).toBe(false)
  expect(await exists(join(root, 'essays/evil.html'))).toBe(false)
})

test('a refused page, an outside document or a bad name proposes and writes nothing', async () => {
  const create = verb('widgets.create') as Capability & { validateStage?: (i: unknown) => Promise<{ decision: string }> }
  const cases = [
    input({ html: '<title>x</title><script src="https://cdn.example.com/a.js"></script>' }),
    input({ fileName: 'pace.js' }),
    input({ path: '../outside.md' }),
    input({ path: join(outside, 'doc.md') }),
    input({ path: 'essays/doc.md\0' }),
  ]
  for (const bad of cases) {
    expect((await create.validateStage!(bad)).decision).toBe('deny')
    expect((await create.execute(bad, ctx)).isError).toBe(true)
  }
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n')
})

test('a document edit that cannot be placed is refused before any file is written', async () => {
  const create = verb('widgets.create')
  const result = await create.execute(input({ position: 5 }), ctx) // no widget 5: refused before any write
  expect(result.isError).toBe(true)
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
})

// ---- what the writer was shown, and the permission, at the moment of the write -------------------

test('the verb writes nothing unless the review surface confirms the writer was shown this file, path and hash', async () => {
  const asked: unknown[] = []
  const notShown = verb('widgets.create', { services: { widgetFileShown: async (file) => { asked.push(file); return false } } })
  const refused = await notShown.execute(input(), ctx)
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('was not shown for review')
  expect(asked).toEqual([{ documentPath: 'essays/doc.md', path: 'essays/assets/pace.html', sha256: widgetFileSha256(PAGE) }])
  // No review surface at all (the service is absent): the same refusal, never a write.
  expect((await verb('widgets.create', { services: {} }).execute(input(), ctx)).isError).toBe(true)
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n')
})

test('the permission is read where the verb runs: switched off after the proposal, the accept writes nothing', async () => {
  for (const key of ['permissions.createFiles', 'permissions.proseEdits']) {
    const settings: Record<string, unknown> = {}
    const isEnabled = (name: string): boolean => capabilityEnabled(name, (k) => settings[k])
    const create = verb('widgets.create', { isEnabled }) as Capability & { validateStage?: (i: unknown) => Promise<{ decision: string }> }
    expect((await create.validateStage!(input())).decision).toBe('pass') // proposed while allowed
    settings[key] = false // the writer turns the switch off before accepting
    expect(await writeflexApprovalPolicy(isEnabled)({ capability: { name: 'widgets.create', risk: 'write' }, input: input(), trigger: ctx.trigger })).toBe('deny')
    const result = await create.execute(input(), ctx)
    expect(result.isError, key).toBe(true)
    expect(result.text).toContain('switched off')
    expect(await exists(join(root, 'essays/assets'))).toBe(false)
    expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n')
  }
})

test('the permission is read again at the write itself: switched off while the accept is in flight, nothing is written', async () => {
  let allowed = true
  const create = verb('widgets.create', {
    isEnabled: () => allowed,
    // The review check is the last await before the write; the switch goes off during it.
    services: { widgetFileShown: async () => { allowed = false; return true } },
  })
  const result = await create.execute(input(), ctx)
  expect(result.isError).toBe(true)
  expect(result.text).toContain('switched off')
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n')
})

test('the writer reads the permission in the tick it creates the file: off there, not even assets/ is made', async () => {
  let reads = 0
  const refused = await writeWidgetFile(root, 'essays/doc.md', 'essays/assets/pace.html', PAGE, widgetFileSha256(PAGE), () => { reads += 1; return false })
  expect(refused).toMatchObject({ ok: false })
  if (!refused.ok) expect(refused.message).toContain('switched off')
  expect(reads).toBe(1)
  expect(await exists(join(root, 'essays/assets'))).toBe(false)
})

// review finding round 2, finding 2: a switch turned off DURING the accept. `lookedUp` marks the review lookup having
// returned; from then on the verb reads the permission exactly twice, once in the tick of each write. `offFrom`
// says from which of those reads the switch is off, i.e. during which stretch of awaits it was turned off.
for (const key of ['permissions.createFiles', 'permissions.proseEdits']) {
  for (const [offFrom, when] of [[1, 'after the review lookup, while the place is being validated'], [2, 'after the widget file was written, before the document save'], [3, 'after the document\'s temp file was written, at its commit']] as const) {
    test(`${key} switched off ${when}: the document is never written and no widget file is left`, async () => {
      let lookedUp = false
      let whole = 0 // whole permission reads made after the lookup returned
      const isEnabled = (name: string): boolean => {
        const read = lookedUp && name === 'widgets.create' ? (whole += 1) : 0
        return capabilityEnabled(name, (k) => k === key && read >= offFrom ? false : undefined)
      }
      const create = verb('widgets.create', { isEnabled, services: { widgetFileShown: async () => { lookedUp = true; return true } } })
      const result = await create.execute(input(), ctx)
      expect(result.isError).toBe(true)
      expect(result.text).toContain('switched off')
      expect(whole).toBe(offFrom) // refused at exactly that read
      expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n')
      expect(await exists(join(root, 'essays/assets'))).toBe(false) // never made, or made and taken back out
      if (offFrom >= 2) expect(result.text).toContain('was removed again')
      expect(await readdir(join(root, 'essays'))).toEqual(['doc.md']) // no temp file left beside the document
    })
  }
}

test('a save refused at its commit point leaves the document as it was and no temp file; allowed, it commits', async () => {
  // review finding round 3, finding 1: the check runs after the temp file is written, in the tick of the rename.
  let seenAtCheck = ''
  const refused = await ws.saveFile('essays/doc.md', 'New text.\n', { beforeCommit: () => {
    seenAtCheck = readFileSync(join(root, 'essays/doc.md'), 'utf8') // the temp exists by now; the document is still the old one
    throw new Error('switched off')
  } }).then(() => null, (error: unknown) => error as Error)
  expect(refused?.message).toBe('switched off')
  expect(seenAtCheck).toBe('Intro.\n\nMore.\n')
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n')
  expect(await readdir(join(root, 'essays'))).toEqual(['doc.md'])
  let checks = 0
  await ws.saveFile('essays/doc.md', 'New text.\n', { beforeCommit: () => { checks += 1 } })
  expect(checks).toBe(1)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('New text.\n')
  expect(await readdir(join(root, 'essays'))).toEqual(['doc.md'])
})

test('the editor save refuses the Change journal, however the path is spelled', () => {
  for (const path of ['.writeflex/changes.jsonl', './.writeflex/changes.jsonl', '.writeflex//changes.jsonl', '.WriteFlex/Changes.JSONL', 'essays/../.writeflex/changes.jsonl', '.writeflex\\changes.jsonl']) expect(isChangeJournalPath(path), path).toBe(true)
  for (const path of ['essays/doc.md', '.writeflex/rescue/x.md', 'changes.jsonl']) expect(isChangeJournalPath(path), path).toBe(false)
})

test('widgets.insert and widgets.remove are stopped the same way when prose edits are switched off before the accept', async () => {
  await mkdir(join(root, 'essays/assets'))
  await writeFile(join(root, 'essays/assets/b.html'), PAGE)
  const settings: Record<string, unknown> = {}
  const isEnabled = (name: string): boolean => capabilityEnabled(name, (k) => settings[k])
  const insert = verb('widgets.insert', { isEnabled })
  const remove = verb('widgets.remove', { isEnabled })
  settings['permissions.proseEdits'] = false
  expect((await insert.execute({ path: 'essays/doc.md', file: 'essays/assets/b.html', position: 'end' }, ctx)).isError).toBe(true)
  expect((await remove.execute({ path: 'essays/doc.md', ordinal: 1 }, ctx)).isError).toBe(true)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n')
})

// ---- accept-time failures: what is left on disk, and what the result says ------------------------

/** A workspace whose document save fails BEFORE anything is written, optionally doing something first. */
class SaveFails extends Workspace {
  constructor(path: string, private readonly before: () => Promise<void> = async () => {}) { super(path) }
  override async saveFile(): Promise<never> {
    await this.before()
    throw new Error(`ENOSPC: no space left on device, write '${join(this.root, 'essays/doc.md')}'`)
  }
}

test('a document save that fails takes the widget file back out, and the result says the document was not changed', async () => {
  const result = await verb('widgets.create', { workspace: new SaveFails(root) }).execute(input(), ctx)
  expect(result.isError).toBe(true)
  expect(result.text).toContain('The document was not changed, and the new widget file essays/assets/pace.html was removed again.')
  expect(result.text).not.toContain(root) // the fs error's absolute path does not reach the agent
  expect(await exists(join(root, 'essays/assets'))).toBe(false) // the folder made for it goes too
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n')
})

test('a rollback that fails is never silent: the result names the orphan file', async () => {
  // review finding blocking 2: the save fails, and assets/ stops allowing removals before the rollback runs.
  const assets = join(root, 'essays/assets')
  try {
    const result = await verb('widgets.create', { workspace: new SaveFails(root, () => chmod(assets, 0o555)) }).execute(input(), ctx)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('The document was not changed, but the new widget file essays/assets/pace.html could not be removed')
    expect(result.text).toContain('It is still in the Workspace with no line pointing to it')
    expect(result.text).not.toContain(root)
    expect(await readFile(join(assets, 'pace.html'), 'utf8')).toBe(PAGE) // the orphan the result names
    expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n')
  } finally {
    await chmod(assets, 0o755).catch(() => undefined)
  }
})

/** A workspace whose save commits and whose read-back then fails (workspace.ts saveFile reads after the atomic write). */
class ReadBackFails extends Workspace {
  #saving = false
  override async saveFile(...args: Parameters<Workspace['saveFile']>): ReturnType<Workspace['saveFile']> {
    this.#saving = true
    try { return await super.saveFile(...args) } finally { this.#saving = false }
  }
  override async readFile(path: string): ReturnType<Workspace['readFile']> {
    if (this.#saving) throw new Error('post-save read failed')
    return super.readFile(path)
  }
}

test('a save that committed and then failed to read back is told apart from a failed save', async () => {
  const failing = new ReadBackFails(root)
  const thrown = await failing.saveFile('essays/doc.md', 'New text.\n').then(() => null, (error: unknown) => error)
  expect(thrown).toBeInstanceOf(SavedButNotReadBack)
  expect((thrown as SavedButNotReadBack).path).toBe('essays/doc.md')
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('New text.\n')
})

test('a failure after the document was saved keeps the widget the document now refers to, and says what happened', async () => {
  // review finding blocking 3: the old code treated this as an unsaved document and deleted the referenced widget.
  const result = await verb('widgets.create', { workspace: new ReadBackFails(root) }).execute(input(), ctx)
  expect(await readFile(join(root, 'essays/doc.md'), 'utf8')).toBe('Intro.\n\nMore.\n\n[Simulation: assets/pace.html]\n')
  expect(await readFile(join(root, 'essays/assets/pace.html'), 'utf8')).toBe(PAGE)
  expect(result.isError).toBeFalsy() // both writes landed: the proposal was carried out
  expect(result.text).toContain('Both were written and kept')
  expect(result.text).toContain('could not be read back')
})

// ---- the new-file part of a Change -------------------------------------------------------------

test('a Change carries the new file only through the agent door, and a part whose content was altered is not a part', async () => {
  const store = new ChangeStore(ws)
  const base = { path: 'essays/doc.md', provenance: 'agent' as const, editClass: 'content' as const, category: 'other', summary: 's', oldText: 'a', newText: 'b', isCorrection: false }
  const part = { path: 'essays/assets/pace.html', content: PAGE, sha256: widgetFileSha256(PAGE) }
  const withFile = await store.addWithNewFile(base, part)
  expect(newFilePartOf(await store.get(withFile.id))).toEqual(part)
  // The general door (the renderer's changes:add reaches this one) cannot attach a file.
  const plain = await store.add({ ...base, newFile: part } as typeof base)
  expect(newFilePartOf(await store.get(plain.id))).toBeUndefined()
  // Content edited in the journal no longer matches its hash: it is not accepted as what was shown.
  const journal = join(root, '.writeflex/changes.jsonl')
  await writeFile(journal, (await readFile(journal, 'utf8')).replace('textContent=\\"1\\"', 'textContent=\\"2\\"'))
  expect(newFilePartOf(await store.get(withFile.id))).toBeUndefined()
})
