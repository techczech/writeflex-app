// The reader page's notes: the rules for the notes column, cards, composers, stacks, the view
// switch and the offline mark, on the page's own colour tokens. The dark values apply when the
// reader's system is dark. Below 1100 px the page shows notes under the passage; at phone width
// the export's narrow rules in reader-page.ts apply.
export const NOTES_STYLES = `.rp{--teal:#0f766e;--teal-ink:#0b5a54;--teal-bg:#effaf7;--note-hl:#f4d777;--note-line:#e2c46c;--note-bg:#fffdf4;--note-ink:#65501c;--edit-hl:#ebe6ff;--edit-under:#8178cf;--edit-line:#c4bdef;--edit-bg:#faf8ff;--edit-ink:#453c84;--del-ink:#8f2f3a;--del-bg:#fbe9eb;--ins-ink:#2f2770;--ins-bg:#ebe6ff;--sel:#bcd8ff;--st-open:#1f5fae;--st-ok:#166534;--st-no:#9f1239;--st-fail:#9a3412;--st-unsent:#475569;--st-changed:#8a6512;--shadow:0 1px 2px rgba(24,32,42,.06)}
@media (prefers-color-scheme:dark){.rp{--teal:#3fb8a9;--teal-ink:#7fd6ca;--teal-bg:#12302d;--note-hl:#6b5716;--note-line:#7d6a2c;--note-bg:#221f14;--note-ink:#e6cf8a;--edit-hl:#352e63;--edit-under:#9d94ea;--edit-line:#4c4590;--edit-bg:#1e1c30;--edit-ink:#c9c2ff;--del-ink:#f2a7b0;--del-bg:#3d1f25;--ins-ink:#d9d3ff;--ins-bg:#352e63;--sel:#2c4f7c;--st-open:#8ab8f0;--st-ok:#7fd19b;--st-no:#f29aab;--st-fail:#f0a873;--st-unsent:#a9b5c4;--st-changed:#e3c46a;--shadow:none}.rp .btn.primary{color:#0b1f1d}}
.rp kbd{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--line-strong);border-bottom-width:2px;border-radius:4px;padding:2px 5px;background:var(--kbd-bg);color:var(--ink)}
.rbar .spacer{flex:1}
.offline{display:inline-flex;align-items:center;gap:6px;padding:3px 10px 3px 8px;border:1px solid var(--line-strong);border-radius:999px;color:var(--ink);background:var(--paper)}
.viewswitch{display:inline-flex;align-items:center;gap:8px;color:var(--muted)}
.seg{display:inline-flex;border:1px solid var(--line-strong);border-radius:999px;overflow:hidden;background:var(--panel)}
.seg button{display:inline-flex;align-items:center;gap:6px;border:0;background:none;color:var(--ink);font:inherit;font-size:12.5px;font-weight:600;padding:5px 12px;cursor:pointer}
.seg button+button{border-left:1px solid var(--line-strong)}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--panel)}
.rp.notes .rbody{justify-content:center}
.rp.notes .content{width:620px;margin:0}
.rp.notes[data-view="under"] .content{width:660px;margin:0 auto}
.notes-col{position:relative;flex:none;width:360px;margin-left:56px;padding-top:40px;font-size:13.5px;line-height:1.45}
.rp[data-view="under"] .notes-col{display:none}
.rp.folio.notes .rbody{justify-content:flex-start}
.rp.folio.notes .content{width:560px;margin-left:48px}
.rp.folio.notes .notes-col{width:320px;margin-left:40px}
.rp.folio.notes[data-view="under"] .content{margin-right:auto}
.leaders{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.leaders path{fill:none;stroke:var(--line-strong);stroke-width:1}
.leaders circle{fill:var(--line-strong)}
mark.wf-hl{color:inherit;background:none;border-radius:3px;padding:.06em 0}
.hl-note{background:linear-gradient(transparent 35%,var(--note-hl) 35%)!important}
.hl-edit{background:var(--edit-hl)!important;box-shadow:inset 0 -2px 0 var(--edit-under)}
.hl-sel{background:var(--sel)!important}
mark.is-linked{outline:2px solid var(--ink);outline-offset:1px}
sup.mn{font-size:11px;font-weight:750;color:var(--ink);margin-left:2px;line-height:0}
.nitem{position:absolute;left:0;right:0}
.card{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--note-line);border-radius:9px;box-shadow:var(--shadow);font-size:13.5px;line-height:1.45;color:var(--ink)}
.card.k-edit{border-left-color:var(--edit-under)}
.card.is-linked{border-color:var(--line-strong);box-shadow:0 0 0 2px var(--line-strong)}
.card-full{padding:10px 12px 12px}
.c-head{display:flex;align-items:center;gap:7px;line-height:1.3}
.num{display:inline-grid;place-items:center;min-width:21px;height:21px;padding:0 5px;border-radius:11px;background:var(--ink);color:var(--panel);font-size:11.5px;font-weight:750;flex:none}
.who{font-weight:700;overflow-wrap:anywhere}
.c-head .who{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c-head .num,.c-head .kind,.c-head .foldbtn{flex:none}
.role{flex:none;font-size:11px;font-weight:600;border:1px solid var(--line-strong);border-radius:4px;padding:0 5px;color:var(--muted);line-height:16px}
.role.r-author{border-color:var(--ink);color:var(--ink)}
.kind{display:inline-flex;align-items:center;gap:5px;color:var(--muted);font-size:12.5px;white-space:nowrap}
.foldbtn{margin-left:auto;border:0;background:none;color:var(--muted);padding:3px;border-radius:5px;cursor:pointer;display:inline-flex}
.foldbtn:hover{background:var(--paper);color:var(--ink)}
.c-status{display:flex;flex-wrap:wrap;align-items:center;gap:3px 12px;margin:6px 0 0 28px;font-size:12.5px}
.st{display:inline-flex;align-items:center;gap:5px;font-weight:650}
.st-open{color:var(--st-open)}.st-accepted,.st-done{color:var(--st-ok)}.st-declined{color:var(--st-no)}.st-failed{color:var(--st-fail)}.st-unsent{color:var(--st-unsent)}.st-changed{color:var(--st-changed)}
.when{color:var(--muted);font-size:12px}
.c-body{margin:7px 0 0 28px;white-space:pre-wrap;overflow-wrap:anywhere}
.c-diff{margin:7px 0 0 28px;font-size:14px;line-height:1.55;overflow-wrap:anywhere}
.written{margin:8px 0 0 28px;padding:6px 9px;border:1px dashed var(--note-line);border-radius:6px;background:var(--note-bg);font-size:12.5px;color:var(--note-ink)}
.written q{display:block;color:var(--ink);font-size:13.5px;quotes:"\\201C" "\\201D"}
.lab{display:block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:2px}
.notice{display:flex;gap:7px;margin:8px 0 0 28px;font-size:12.5px;color:var(--muted)}
.notice .ic{margin-top:2px}
.rp del{text-decoration:line-through;text-decoration-thickness:1.5px;color:var(--del-ink);background:var(--del-bg);border-radius:2px;padding:0 1px}
.rp ins{text-decoration:underline;text-decoration-thickness:1.5px;text-underline-offset:2px;color:var(--ins-ink);background:var(--ins-bg);font-weight:650;border-radius:2px;padding:0 1px}
.c-thread{list-style:none;margin:10px 0 0 28px;padding:0;display:grid;gap:8px}
.t-entry{padding:7px 0 0 10px;border-left:2px solid var(--line-strong);border-top:1px solid var(--line)}
.t-entry.by-author{border-left:3px solid var(--ink)}
.t-entry .notice,.t-entry .c-diff{margin-left:0}
.t-head{display:flex;flex-wrap:wrap;align-items:center;gap:3px 7px;font-size:12.5px;line-height:1.3}
.t-head .ic{color:var(--muted)}
.t-head .who{font-weight:700}
.t-body{margin:3px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.c-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0 28px}
.fold-line{display:none;width:100%;align-items:center;gap:7px;border:0;background:none;color:var(--ink);font:inherit;font-size:13px;line-height:1.3;padding:8px 10px;text-align:left;cursor:pointer;border-radius:8px}
.fold-line:hover{background:var(--paper)}
.fold-line .ic{color:var(--muted)}
.fl-sum{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto}
.fl-sum b{font-weight:700}
.fl-sum .ic{margin:0 5px 0 6px;color:var(--muted)}
.fl-st{flex:none;display:inline-flex;gap:8px}
.fl-rep{display:inline-flex;align-items:center;gap:2px;margin-left:4px;color:var(--muted)}
.fl-sum .fl-rep .ic{margin:0}
.card.is-folded .card-full{display:none}
.card.is-folded .fold-line{display:flex}
.stack{background:var(--panel);border:1px solid var(--line-strong);border-radius:9px;box-shadow:var(--shadow);overflow:hidden}
.stack-head{display:flex;align-items:center;gap:7px;padding:8px 11px;background:var(--paper);border-bottom:1px solid var(--line);font-size:13px;font-weight:650}
.stack-head .ic{color:var(--muted)}
.stack-head .hint{margin-left:auto;font-weight:400;color:var(--muted);font-size:12px}
.stack .nitem{position:static}
.stack .card{border:0;border-left:4px solid var(--note-line);border-radius:0;box-shadow:none}
.stack .card.k-edit{border-left-color:var(--edit-under)}
.stack .nitem+.nitem{border-top:1px solid var(--line)}
.stack .fold-line{border-radius:0}
.notes-head{border:1px solid var(--line);border-radius:9px;background:var(--panel);padding:10px 12px;display:grid;gap:5px;font-size:12.5px;color:var(--muted);line-height:1.4}
.nh-t{display:flex;align-items:center;gap:8px;color:var(--ink);font-size:14px}
.count{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:10px;padding:0 7px}
.nh-r{display:flex;align-items:flex-start;gap:7px}
.nh-r .ic{margin-top:1px}
.nh-r a{color:var(--ink);text-decoration:underline;margin-left:4px;cursor:pointer}
.nh-r b{color:var(--ink);overflow-wrap:anywhere}
.nh-empty{color:var(--ink)}
.rp[data-view="under"] .notes-head{margin:0 0 26px;font-size:12.5px;line-height:1.4}
.under{margin:-.4em 0 1.4em 24px;display:grid;gap:10px;font-size:13.5px;line-height:1.45}
.under .nitem{position:static}
.btn{display:inline-flex;align-items:center;gap:7px;padding:6px 13px;border:1px solid var(--line-strong);border-radius:999px;background:var(--panel);color:var(--ink);font:inherit;font-size:13px;font-weight:600;cursor:pointer;line-height:1.3}
.btn kbd{margin-left:2px}
.btn:disabled{opacity:.55;cursor:default}
.btn.primary{background:var(--teal);border-color:var(--teal);color:#fff}
.btn.primary kbd{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.4);color:#fff}
.btn.b-note{border-color:var(--note-line);background:var(--note-bg);color:var(--note-ink)}
.btn.b-edit{border-color:var(--edit-line);background:var(--edit-bg);color:var(--edit-ink)}
.btn.ghost{font-weight:500}
.comp{background:var(--panel);border:1.5px solid var(--line-strong);border-radius:9px;padding:11px 12px 12px;box-shadow:0 6px 18px rgba(24,32,42,.08);font-size:13.5px;line-height:1.45;color:var(--ink)}
.comp.k-note{border-left:4px solid var(--note-line)}
.comp.k-edit{border-left:4px solid var(--edit-under)}
.ch{display:flex;align-items:center;gap:7px;font-size:14px;margin:0 0 8px}
.cq{margin:0 0 10px;padding:5px 10px;border-left:3px solid var(--line-strong);background:var(--paper);border-radius:0 5px 5px 0}
.cq q{font-size:13.5px;quotes:"\\201C" "\\201D"}
.comp textarea,.comp input{display:block;width:100%;font:inherit;font-size:13.5px;line-height:1.45;padding:7px 9px;border:1px solid var(--line-strong);border-radius:6px;background:var(--panel);color:var(--ink);resize:vertical}
.comp textarea:focus,.comp input:focus{outline:2px solid var(--teal);outline-offset:1px}
.dif-lab{margin-top:10px}
.difbox{margin:8px 0 0;padding:7px 9px;border:1px solid var(--edit-line);border-radius:6px;background:var(--edit-bg);font-size:14px;line-height:1.55;overflow-wrap:anywhere}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.acts.col{flex-direction:column}
.acts.col .btn{justify-content:flex-start}
.acts.col .btn kbd{margin-left:auto}
.esc{margin:9px 0 0;font-size:12px;color:var(--muted)}
.refuse{display:flex;gap:8px;margin:10px 0 0;padding:8px 10px;border:1.5px solid var(--st-fail);border-radius:6px;background:var(--note-bg);color:var(--ink);font-size:13px}
.refuse .ic{color:var(--st-fail);margin-top:2px}
@media (max-width:1099px){.rp.notes .viewswitch{display:none}.rp.notes .rbody{display:block}.rp.notes .content,.rp.notes[data-view="under"] .content{width:auto;max-width:660px;margin:0 auto;padding:0 18px}.rp.folio.notes .content{margin:0 auto}}
@media (max-width:720px){.rp.notes .content,.rp.notes[data-view="under"] .content{margin:0 18px;padding:0}.under{margin-left:0}.rp kbd{display:none}}`
