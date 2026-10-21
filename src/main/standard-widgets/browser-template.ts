/**
 * The record browser template, version 1 (contracts §3 `browser`, §9). Records in, one self-contained HTML page
 * out: search, a group filter, a list with keyboard selection, the selected record's full detail, previous and
 * next, and an optional all-records list view. The page carries only the mapped fields and ids.
 *
 * Deterministic: the page is a function of the recipe's display settings, the records and this template's
 * source. No timestamps, random ids or locale formatting. The data travels as JSON inside
 * `<script type="application/json">`, escaped for that context; Markdown detail is pre-rendered by the app's
 * own safe renderer (raw HTML shown as text, local links reduced to their words, images left out), so the
 * runtime puts nothing on the page that the build did not already make safe. Titles and groups are set as
 * text, never markup.
 *
 * The page needs nothing outside itself: no network, no other file. It runs in the sealed widget frame
 * (ADR-0044) exactly like any other widget; the frame adds its own policy and agent.
 */
import { createHash } from 'node:crypto'
import { toHtml } from '../../shared/markdown/to-html'
import { isRecipeMap, type RecipeMap } from './recipe'
import type { RecordSet } from './adapters'

export const BROWSER_TEMPLATE_VERSION = 1

export type BrowserRecord = { id: string; title: string; group: string | null; detail: string; search: string }
/** `initialView`: the recipe's `initial.view`, the view the page opens in (one of `views`; else the first view). */
export type BrowserPage = { title: string; views: string[]; initialView?: string | null; groupLabel: string | null; records: BrowserRecord[] }

const STYLE = `
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#5f6368;--line:#d9d9de;--panel:#f6f6f8;--accent:#2457c5;--sel:#e3ebfb}
@media (prefers-color-scheme:dark){:root{--fg:#ececf0;--muted:#a3a3ad;--line:#3a3a42;--panel:#1f1f24;--accent:#8fb0ff;--sel:#26324d}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--fg);background:transparent}
.wf-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 0 10px}
.wf-bar input,.wf-bar select,.wf-bar button,.wf-nav button,.wf-empty button{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
.wf-bar input{flex:1 1 200px;min-width:0}
.wf-count{color:var(--muted);font-size:13px;margin-left:auto}
.wf-views button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
.wf-browser{display:grid;grid-template-columns:minmax(180px,1fr) 2fr;gap:12px;align-items:start}
@media (max-width:560px){.wf-browser{grid-template-columns:1fr}}
.wf-list{list-style:none;margin:0;padding:4px;border:1px solid var(--line);border-radius:8px;max-height:420px;overflow:auto}
.wf-list:focus{outline:2px solid var(--accent);outline-offset:1px}
.wf-list li{padding:6px 8px;border-radius:6px;cursor:pointer}
.wf-list li[aria-selected=true]{background:var(--sel)}
.wf-group{display:block;color:var(--muted);font-size:12px}
.wf-detail{border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-height:120px;overflow-wrap:anywhere}
.wf-detail h2,.wf-all h2{font-size:17px;margin:0 0 6px}
.wf-nav{display:flex;gap:8px;margin-top:10px}
.wf-all article{border-bottom:1px solid var(--line);padding:10px 0}
.wf-empty{color:var(--muted);padding:12px 0}
table{border-collapse:collapse}td,th{border:1px solid var(--line);padding:2px 6px}
`

// Plain ES2017, no modules, nothing fetched. `D` is the data; every write to the page is textContent except
// the detail, which the build rendered through the app's safe Markdown path.
const RUNTIME = `
(function(){
var D=JSON.parse(document.getElementById('wf-widget-data').textContent);
var R=D.records,q='',g='',view=D.views.indexOf(D.initial)>=0?D.initial:D.views[0],sel=0;
var $=function(id){return document.getElementById(id)};
var search=$('wf-search'),group=$('wf-group-filter'),count=$('wf-count'),list=$('wf-list'),detail=$('wf-detail'),all=$('wf-all');
var browser=$('wf-browser'),empty=$('wf-empty');
function shown(){var t=q.toLowerCase();return R.filter(function(r){return (!g||r.group===g)&&(!t||r.search.toLowerCase().indexOf(t)>=0)})}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function fill(box,r){box.textContent='';var h=el('h2',null,r.title);box.appendChild(h);if(r.group){box.appendChild(el('span','wf-group',r.group))}var body=el('div','wf-body');body.innerHTML=r.detail;box.appendChild(body)}
function render(){
  var s=shown();if(sel>=s.length)sel=s.length-1;if(sel<0)sel=0;
  count.textContent=s.length===R.length?(R.length+(R.length===1?' record':' records')):(s.length+' of '+R.length);
  empty.hidden=s.length>0;browser.hidden=view!=='browser'||s.length===0;all.hidden=view!=='list'||s.length===0;
  list.textContent='';
  s.forEach(function(r,i){var li=el('li',null,null);li.id='wf-r-'+i;li.setAttribute('role','option');li.setAttribute('aria-selected',i===sel?'true':'false');li.appendChild(el('span',null,r.title));if(r.group)li.appendChild(el('span','wf-group',r.group));li.addEventListener('click',function(){sel=i;render();list.focus()});list.appendChild(li)});
  if(s.length){list.setAttribute('aria-activedescendant','wf-r-'+sel);fill(detail,s[sel]);var cur=$('wf-r-'+sel);if(cur&&cur.scrollIntoView)cur.scrollIntoView({block:'nearest'})}else{list.removeAttribute('aria-activedescendant');detail.textContent=''}
  $('wf-prev').disabled=sel<=0;$('wf-next').disabled=sel>=s.length-1;
  if(view==='list'){all.textContent='';s.forEach(function(r){var a=el('article',null,null);fill(a,r);all.appendChild(a)})}
  var vb=document.querySelectorAll('[data-wf-view]');for(var i=0;i<vb.length;i++){vb[i].setAttribute('aria-pressed',vb[i].getAttribute('data-wf-view')===view?'true':'false')}
}
function move(to){var n=shown().length;if(!n)return;sel=Math.max(0,Math.min(n-1,to));render()}
search.addEventListener('input',function(){q=search.value;sel=0;render()});
if(group)group.addEventListener('change',function(){g=group.value;sel=0;render()});
list.addEventListener('keydown',function(e){var k=e.key;if(k==='ArrowDown'){move(sel+1)}else if(k==='ArrowUp'){move(sel-1)}else if(k==='Home'){move(0)}else if(k==='End'){move(1e9)}else{return}e.preventDefault()});
$('wf-prev').addEventListener('click',function(){move(sel-1)});$('wf-next').addEventListener('click',function(){move(sel+1)});
$('wf-reset').addEventListener('click',function(){q='';g='';search.value='';if(group)group.value='';sel=0;render();search.focus()});
var vb=document.querySelectorAll('[data-wf-view]');for(var i=0;i<vb.length;i++){vb[i].addEventListener('click',function(e){view=e.currentTarget.getAttribute('data-wf-view');render()})}
render();
})();
`

const SKELETON_VERSION = 'browser/1'
/** The hash of everything this template contributes to a page, recorded in each build receipt. */
export const BROWSER_TEMPLATE_SHA256 = createHash('sha256').update(`${SKELETON_VERSION}\n${STYLE}\n${RUNTIME}`).digest('hex')

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/** JSON for a `<script type="application/json">`: no `<`, `>`, `&`, U+2028 or U+2029 survives as itself (§2). */
export const scriptJson = (value: unknown): string => JSON.stringify(value)
  .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

/** A destination a reader of the exported page could follow; every other link is reduced to its words. */
const EXTERNAL = /^(?:https?:|mailto:)/i
/** Markdown detail as the app renders it for export: raw HTML escaped, local links as text, no images. */
export function detailHtml(markdown: string): string {
  if (markdown === '') return ''
  return toHtml(markdown, { links: 'external-only', linkTarget: (href) => EXTERNAL.test(href) ? href : null, images: 'omit' }).html
}

const textOf = (value: string | null | undefined): string => value ?? ''

/** The browser's records from a tabular record set: only the mapped title, detail, group and search fields. */
export function browserRecords(recipe: RecipeMap, set: RecordSet): BrowserRecord[] {
  const mapping = isRecipeMap(recipe.mapping) ? recipe.mapping : {}
  const field = (key: string): string | null => typeof mapping[key] === 'string' ? mapping[key] as string : null
  const titleField = field('title')
  const detailField = field('detail')
  const groupField = field('group')
  const searchFields = Array.isArray(mapping.search) && mapping.search.every((item) => typeof item === 'string')
    ? mapping.search as string[]
    : [titleField, detailField, groupField].filter((item): item is string => item !== null)
  const value = (values: Record<string, string | null>, key: string | null): string | null => key !== null && Object.hasOwn(values, key) ? values[key] : null
  return set.records.map((record, index) => {
    const group = value(record.values, groupField)
    return {
      id: record.id === '' ? `record-${index + 1}` : record.id,
      title: textOf(value(record.values, titleField)),
      group: group === null || group === '' ? null : group,
      detail: detailHtml(textOf(value(record.values, detailField))),
      search: searchFields.map((key) => textOf(value(record.values, key))).join('\n'),
    }
  })
}

/** The filter's own "every group" option: "All groups", or, when a group is itself called that, a wording no
 *  group uses, so the option is never mistaken for a group. */
export function allGroupsLabel(groups: readonly string[]): string {
  const taken = new Set(groups.map((group) => group.trim().toLowerCase()))
  for (const label of ['All groups', 'Every group', 'Show all groups']) if (!taken.has(label.toLowerCase())) return label
  let n = 2
  while (taken.has(`all groups (${n})`)) n += 1
  return `All groups (${n})`
}

/** The page. Same arguments, same bytes. */
export function renderBrowserPage(page: BrowserPage): string {
  const groups = [...new Set(page.records.map((record) => record.group).filter((group): group is string => group !== null))]
  const views = page.views.length > 0 ? page.views : ['browser']
  const viewLabel: Record<string, string> = { browser: 'Browse', list: 'All records' }
  const initial = page.initialView && views.includes(page.initialView) ? page.initialView : views[0]
  const data = scriptJson({ v: 1, views, initial, records: page.records })
  const groupFilter = groups.length === 0 ? '' : `<select id="wf-group-filter" aria-label="${escapeHtml(page.groupLabel ?? 'Group')}"><option value="">${escapeHtml(allGroupsLabel(groups))}</option>${groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join('')}</select>`
  const switcher = views.length < 2 ? '' : `<span class="wf-views" role="group" aria-label="View">${views.map((view) => `<button type="button" data-wf-view="${escapeHtml(view)}" aria-pressed="false">${escapeHtml(viewLabel[view] ?? view)}</button>`).join('')}</span>`
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(page.title)}</title>`,
    `<meta name="generator" content="WriteFlex standard widget ${SKELETON_VERSION}">`,
    `<style>${STYLE}</style></head><body>`,
    `<div class="wf-bar"><input id="wf-search" type="search" aria-label="Search ${escapeHtml(page.title)}" placeholder="Search">${groupFilter}${switcher}<span id="wf-count" class="wf-count" aria-live="polite"></span></div>`,
    '<div id="wf-browser" class="wf-browser"><ul id="wf-list" class="wf-list" role="listbox" tabindex="0" aria-label="Records"></ul>',
    '<section><div id="wf-detail" class="wf-detail" aria-live="polite"></div><div class="wf-nav"><button id="wf-prev" type="button">Previous</button><button id="wf-next" type="button">Next</button></div></section></div>',
    '<div id="wf-all" class="wf-all" hidden></div>',
    '<div id="wf-empty" class="wf-empty" hidden><p>No records match.</p><button id="wf-reset" type="button">Clear search and filter</button></div>',
    `<script type="application/json" id="wf-widget-data">${data}</script>`,
    `<script>${RUNTIME}</script>`,
    '</body></html>',
    '',
  ].join('\n')
}
