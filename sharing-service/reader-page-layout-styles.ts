// Shared Folio layout. Keep the article and notes as siblings for passage anchoring.
export const LAYOUT_STYLES = `
html:has(.rp.folio[data-layout="folio"]){scroll-padding-top:76px}
.rp.folio[data-layout="folio"]{--head:#203146;--blue:#1f6feb;--teal:#0f766e;background:linear-gradient(180deg,rgba(31,111,235,.07),transparent 380px),var(--paper);font-size:17px;line-height:1.7}
@media(prefers-color-scheme:dark){.rp.folio[data-layout="folio"]{--head:#dbe6f3;--blue:#8ab8f0;--teal:#3fb8a9}}
.rp.folio[data-layout="folio"] .rbar{position:sticky;top:0;z-index:40;min-height:56px;flex-wrap:nowrap;padding:10px 20px;gap:14px}
.rp.folio[data-layout="folio"] .crumb{display:flex;gap:8px;flex:1;white-space:nowrap;overflow:hidden}
.rp.folio[data-layout="folio"] .crumb b,.rp.folio[data-layout="folio"] .current-section{overflow:hidden;text-overflow:ellipsis}
.rp.folio[data-layout="folio"] .crumb b{color:var(--ink)}
.rp.folio[data-layout="folio"] .current-section{color:var(--nav-active-ink);font-weight:650}
.rp.folio[data-layout="folio"] .bar-meta{display:flex;gap:16px;font-size:12px}
.rp.folio[data-layout="folio"] .contents-button,.rp.folio[data-layout="folio"] .close-contents,.rp.folio[data-layout="folio"] .contents-scrim{display:none}
.rp.folio[data-layout="folio"] .rbody{display:grid;grid-template-columns:292px minmax(0,1fr);align-items:start;padding-bottom:0}
.rp.folio[data-layout="folio"].notes .rbody{grid-template-columns:292px minmax(0,1fr) 336px}
.rp.folio[data-layout="folio"] .hero{grid-column:2/-1;grid-row:1;padding:64px 56px 44px;margin:0;border-bottom:1px solid var(--line)}
.rp.folio[data-layout="folio"] .hero h1{max-width:900px;font-size:clamp(40px,5vw,56px);line-height:1.06}
.rp.folio[data-layout="folio"] .meta-row{margin-top:26px}
.rp.folio[data-layout="folio"] .content,.rp.folio[data-layout="folio"].notes .content,.rp.folio[data-layout="folio"].notes[data-view="under"] .content{grid-column:2;grid-row:2;width:100%;max-width:790px;margin:0;padding:36px 40px 120px 56px}
.rp.folio[data-layout="folio"] .sidebar{grid-column:1;grid-row:1/3;position:sticky;top:56px;align-self:start;width:292px;height:calc(100vh - 56px);overflow-y:auto;padding:24px 14px 40px 18px;background:var(--panel)}
.rp.folio[data-layout="folio"] .sidebar-inner{position:static}
.rp.folio[data-layout="folio"] .sidebar-title{font-size:15px;margin:0 8px 4px}
.rp.folio[data-layout="folio"] .sidebar-author,.rp.folio[data-layout="folio"] .sidebar-meta{margin:0 8px 18px;color:var(--muted);font-size:12px}
.rp.folio[data-layout="folio"] .sidebar-meta{display:none}
.rp.folio[data-layout="folio"] .nav-part{margin:0 0 2px}
.rp.folio[data-layout="folio"] .nav-part summary{display:flex;align-items:start;list-style:none}
.rp.folio[data-layout="folio"] .nav-part summary::-webkit-details-marker{display:none}
.rp.folio[data-layout="folio"] .nav-part summary::before{content:'›';width:26px;flex:none;text-align:center;cursor:pointer;line-height:32px}
.rp.folio[data-layout="folio"] .nav-part[open]>summary::before{transform:rotate(90deg)}
.rp.folio[data-layout="folio"] .nav-link{border-left:3px solid transparent;padding:6px 9px;line-height:1.3}
.rp.folio[data-layout="folio"] .nav-link.piece-link{font-size:15px;font-weight:700;flex:1;color:var(--ink)}
.rp.folio[data-layout="folio"] .nav-sections{margin:2px 0 8px 13px;padding-left:10px;border-left:1px solid var(--line)}
.rp.folio[data-layout="folio"] .nav-link.level-2,.rp.folio[data-layout="folio"] .nav-link.level-3{padding-left:9px;font-size:13.5px;color:var(--nav-ink)}
.rp.folio[data-layout="folio"] .nav-link.level-4{font-size:12.5px;color:var(--nav-sub);margin-left:12px}
.rp.folio[data-layout="folio"] .nav-subsections{display:none}
.rp.folio[data-layout="folio"] .nav-section.is-current>.nav-subsections{display:block}
.rp.folio[data-layout="folio"] .nav-link.active{border-left-color:var(--blue);background:var(--nav-active-bg);color:var(--nav-active-ink);font-weight:650}
.rp.folio[data-layout="folio"] .wf-bundle-section-title{font-size:38px;line-height:1.15;letter-spacing:-.02em;margin:0 0 .7em}
.rp.folio[data-layout="folio"] .wf-bundle-section-title::before{content:'';display:block;width:44px;height:4px;border-radius:2px;background:var(--blue);margin-bottom:18px}
.rp.folio[data-layout="folio"] .wf-bundle-section+.wf-bundle-section{margin-top:72px;padding-top:56px}
.rp.folio[data-layout="folio"] h2.wf-heading{font-family:Georgia,"Times New Roman",serif;font-size:30px;font-weight:720;line-height:1.25;color:var(--head)}
.rp.folio[data-layout="folio"] h3.wf-heading{margin:2.1em 0 .55em;padding-top:.7em;border-top:1px solid var(--line);font-size:26px;font-weight:720;line-height:1.25;color:var(--head)}
.rp.folio[data-layout="folio"] h4.wf-heading{margin:1.8em 0 .45em;font-size:20px;font-weight:650;line-height:1.3;color:var(--head)}
.rp.folio[data-layout="folio"] h5.wf-heading,.rp.folio[data-layout="folio"] h6.wf-heading{margin:1.6em 0 .35em;font-size:13px;font-weight:780;line-height:1.35;letter-spacing:.08em;text-transform:uppercase;color:var(--teal)}
.rp.folio[data-layout="folio"] .wf-paragraph{margin:0 0 1.05em}
.rp.folio[data-layout="folio"] .wf-list{padding-left:1.5em}
.rp.folio[data-layout="folio"] .wf-item::marker{color:var(--teal)}
.rp.folio[data-layout="folio"].notes .notes-col{grid-column:3;grid-row:2;width:336px;margin:0;padding:36px 28px 0 8px;align-self:stretch}
.rp.folio[data-layout="folio"] .notes-head{position:static;border:0;border-top:3px solid var(--ink);border-radius:0;background:transparent;padding:12px 0 0;gap:7px}
.rp.folio[data-layout="folio"] .nh-t{font-size:15px}
.rp.folio[data-layout="folio"] .nh-empty{color:var(--muted)}
@media(min-width:861px) and (max-width:1199px){.rp.folio[data-layout="folio"] .rbody,.rp.folio[data-layout="folio"].notes .rbody{grid-template-columns:272px minmax(0,1fr)}.rp.folio[data-layout="folio"] .sidebar{width:272px}}
@media(max-width:1199px){.rp.folio[data-layout="folio"].notes .notes-col{display:none}.rp.folio[data-layout="folio"].notes[data-view="under"] .content{width:100%;max-width:790px;margin:0;padding:36px 40px 120px 56px}.rp.folio[data-layout="folio"][data-view="under"] .notes-head{position:static}}
@media(max-width:860px){
html:has(.rp.folio[data-layout="folio"]){scroll-padding-top:68px}
.rp.folio[data-layout="folio"] .rbar{height:56px;padding:8px 14px;font-size:12.5px}
.rp.folio[data-layout="folio"] .bar-meta{display:none}
.rp.folio[data-layout="folio"] .crumb b,.rp.folio[data-layout="folio"] .crumb .sep{display:none}
.rp.folio[data-layout="folio"] .contents-button,.rp.folio[data-layout="folio"] .close-contents{display:inline-flex;border:1px solid var(--line-strong);border-radius:999px;background:var(--panel);color:var(--ink);font:inherit;padding:6px 12px;cursor:pointer}
.rp.folio[data-layout="folio"] .rbody,.rp.folio[data-layout="folio"].notes .rbody{display:block}
.rp.folio[data-layout="folio"] .hero{padding:34px 22px 28px}
.rp.folio[data-layout="folio"] .hero h1{font-size:38px}
.rp.folio[data-layout="folio"] .content,.rp.folio[data-layout="folio"].notes .content,.rp.folio[data-layout="folio"].notes[data-view="under"] .content{width:100%;max-width:none;margin:0;padding:28px 22px 80px}
.rp.folio[data-layout="folio"] .sidebar{position:static;display:block;width:100%;height:auto;border-right:0}
.rp.folio[data-layout="folio"].nav-ready .sidebar{display:block;position:fixed;top:56px;bottom:0;left:0;width:min(330px,88vw);height:calc(100vh - 56px);z-index:60;transform:translateX(-100%);visibility:hidden;transition:transform .15s}
.rp.folio[data-layout="folio"].nav-ready.nav-open .sidebar{transform:translateX(0);visibility:visible}
.rp.folio[data-layout="folio"] .close-contents{float:right;margin-bottom:18px}
.rp.folio[data-layout="folio"] .sidebar-title{clear:both}
.rp.folio[data-layout="folio"] .sidebar-meta{display:block}
.rp.folio[data-layout="folio"].nav-open .contents-scrim{display:block;position:fixed;inset:56px 0 0;border:0;background:rgba(24,32,42,.3);z-index:50}
.rp.folio[data-layout="folio"] h3.wf-heading{font-size:23px}
.rp.folio[data-layout="folio"] h4.wf-heading{font-size:19px}
.rp.folio[data-layout="folio"] .wf-bundle-section-title{font-size:31px}
}
@media(prefers-reduced-motion:reduce){html:has(.rp.folio[data-layout="folio"]){scroll-behavior:auto}.rp.folio[data-layout="folio"].nav-ready .sidebar{transition:none}}
`
