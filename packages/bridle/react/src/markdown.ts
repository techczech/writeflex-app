import { createElement as h, type ReactNode } from "react";

/**
 * A small, dependency-free Markdown renderer for agent output.
 *
 * It emits React nodes only — never raw HTML, no dangerouslySetInnerHTML — so
 * agent-authored text cannot inject markup. It covers headings, paragraphs,
 * emphasis, strikethrough, inline code, safe links and autolinks, fenced code
 * blocks with copy controls, blockquotes, horizontal rules, nested ordinary and
 * task lists, and GitHub-flavoured pipe tables. Unrecognised or incomplete input
 * renders as text; incomplete fences render the code received so far.
 *
 * Hosts can theme the renderer by setting these custom properties on the
 * component or an ancestor:
 * --bridle-md-text (inherit)
 * --bridle-md-link (#2563eb)
 * --bridle-md-inline-code-background (#f2f3f5)
 * --bridle-md-inline-code-border (#e6e8ec)
 * --bridle-md-inline-code-text (inherit)
 * --bridle-md-code-background (#0f1524)
 * --bridle-md-code-text (#e7ecf5)
 * --bridle-md-code-meta-text (#b8c1d1)
 * --bridle-md-code-control-border (#3b455a)
 * --bridle-md-code-control-background (transparent)
 * --bridle-md-code-control-text (#e7ecf5)
 * --bridle-md-table-border (#d6dae2)
 * --bridle-md-table-header-background (#f2f3f5)
 * --bridle-md-table-text (inherit)
 * --bridle-md-blockquote-border (#d6dae2)
 * --bridle-md-blockquote-text (#586074)
 * --bridle-md-rule (#e4e7ec)
 * --bridle-md-task-accent (#2563eb)
 */

export const MARKDOWN_CSS = `
.bridle-md{font:inherit;color:var(--bridle-md-text,inherit);overflow-wrap:anywhere}
.bridle-md>*:first-child{margin-top:0}
.bridle-md>*:last-child{margin-bottom:0}
.bridle-md p{margin:0 0 8px}
.bridle-md h1,.bridle-md h2,.bridle-md h3,.bridle-md h4{margin:12px 0 6px;font-weight:700;line-height:1.3}
.bridle-md h1{font-size:1.28em}.bridle-md h2{font-size:1.18em}.bridle-md h3{font-size:1.08em}.bridle-md h4{font-size:1em}
.bridle-md ul,.bridle-md ol{margin:0 0 8px;padding-left:22px}
.bridle-md li{margin:2px 0}
.bridle-md li>ul,.bridle-md li>ol{margin:2px 0}
.bridle-md a{color:var(--bridle-md-link,#2563eb);text-decoration:underline;text-underline-offset:2px}
.bridle-md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;color:var(--bridle-md-inline-code-text,inherit);background:var(--bridle-md-inline-code-background,#f2f3f5);border:1px solid var(--bridle-md-inline-code-border,#e6e8ec);border-radius:5px;padding:1px 5px}
.bridle-md-code-block{margin:0 0 8px;border-radius:9px;overflow:hidden;background:var(--bridle-md-code-background,#0f1524);color:var(--bridle-md-code-text,#e7ecf5)}
.bridle-md-code-toolbar{display:flex;min-height:32px;align-items:center;justify-content:space-between;gap:12px;padding:5px 8px 4px 13px;color:var(--bridle-md-code-meta-text,#b8c1d1)}
.bridle-md-code-language{font:600 .72em/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}
.bridle-md-code-copy{appearance:none;padding:3px 8px;border:1px solid var(--bridle-md-code-control-border,#3b455a);border-radius:5px;background:var(--bridle-md-code-control-background,transparent);color:var(--bridle-md-code-control-text,#e7ecf5);font:600 .72em/1.4 system-ui,sans-serif;cursor:pointer}
.bridle-md-code-copy:focus-visible{outline:2px solid var(--bridle-md-link,#2563eb);outline-offset:2px}
.bridle-md pre{margin:0;padding:11px 13px;background:var(--bridle-md-code-background,#0f1524);color:var(--bridle-md-code-text,#e7ecf5);overflow-x:auto}
.bridle-md pre code{font-size:.86em;background:none;border:0;padding:0;color:inherit}
.bridle-md-table-wrap{max-width:100%;margin:0 0 8px;overflow-x:auto}
.bridle-md table{width:100%;border-collapse:collapse;color:var(--bridle-md-table-text,inherit)}
.bridle-md th,.bridle-md td{padding:6px 9px;border:1px solid var(--bridle-md-table-border,#d6dae2);vertical-align:top;text-align:left}
.bridle-md th{background:var(--bridle-md-table-header-background,#f2f3f5);font-weight:700}
.bridle-md-task-item{list-style:none;margin-left:-20px}
.bridle-md-task-item>input{margin:0 7px 0 0;accent-color:var(--bridle-md-task-accent,#2563eb);opacity:1}
.bridle-md blockquote{margin:0 0 8px;padding:2px 12px;border-left:3px solid var(--bridle-md-blockquote-border,#d6dae2);color:var(--bridle-md-blockquote-text,#586074)}
.bridle-md hr{border:0;border-top:1px solid var(--bridle-md-rule,#e4e7ec);margin:12px 0}
`;

// --- inline parsing -------------------------------------------------------

type InlineRule = {
  re: RegExp;
  node: (match: RegExpExecArray, key: number) => ReactNode;
};

const safeAnchor = (key: number, href: string, content: ReactNode): ReactNode => (
  h("a", { key, href, target: "_blank", rel: "noreferrer noopener" }, content)
);

const INLINE: readonly InlineRule[] = [
  { re: /`([^`]+)`/, node: (match, key) => h("code", { key }, match[1]) },
  { re: /~~([^~]+)~~/, node: (match, key) => h("del", { key }, match[1]) },
  { re: /\*\*([^*]+)\*\*|__([^_]+)__/, node: (match, key) => h("strong", { key }, match[1] ?? match[2]) },
  { re: /\*([^*]+)\*|(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/, node: (match, key) => h("em", { key }, match[1] ?? match[2]) },
  {
    re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/,
    node: (match, key) => safeAnchor(key, match[2] ?? "", match[1]),
  },
  {
    re: /https?:\/\/[^\s<>()]*[^\s<>().,!?;:]/,
    node: (match, key) => safeAnchor(key, match[0], match[0]),
  },
];

/** Parse inline spans into safe React nodes. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest.length > 0) {
    let best: { index: number; length: number; node: ReactNode } | null = null;
    for (const rule of INLINE) {
      const match = rule.re.exec(rest);
      if (match && (best === null || match.index < best.index)) {
        best = { index: match.index, length: match[0].length, node: rule.node(match, key) };
      }
    }
    if (!best) { out.push(rest); break; }
    if (best.index > 0) out.push(rest.slice(0, best.index));
    out.push(best.node);
    key += 1;
    rest = rest.slice(best.index + best.length);
  }
  return out;
}

// --- block parsing --------------------------------------------------------

type TaskState = { checked: boolean };
type ListItem = { indent: number; ordered: boolean; text: string; task?: TaskState };
type TableAlignment = "left" | "center" | "right" | undefined;

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

function renderList(items: ListItem[], start: number, indent: number, key: number): { node: ReactNode; next: number } {
  const ordered = items[start]?.ordered ?? false;
  const children: ReactNode[] = [];
  let i = start;
  while (i < items.length) {
    const item = items[i];
    if (!item || item.indent < indent) break;
    if (item.indent > indent) { i += 1; continue; }
    const liChildren: ReactNode[] = item.task
      ? [
          h("input", {
            key: "task",
            type: "checkbox",
            checked: item.task.checked,
            disabled: true,
            readOnly: true,
            tabIndex: -1,
            "aria-label": item.task.checked ? "Completed task" : "Incomplete task",
          }),
          h("span", { key: "text" }, ...inline(item.text)),
        ]
      : [...inline(item.text)];
    let next = i + 1;
    const nextItem = items[next];
    if (nextItem && nextItem.indent > indent) {
      const nested = renderList(items, next, nextItem.indent, children.length);
      liChildren.push(nested.node);
      next = nested.next;
    }
    children.push(h("li", { key: children.length, ...(item.task ? { className: "bridle-md-task-item" } : {}) }, ...liChildren));
    i = next;
  }
  return { node: h(ordered ? "ol" : "ul", { key }, ...children), next: i };
}

function splitTableRow(line: string): string[] | null {
  let source = line.trim();
  if (!source.includes("|")) return null;
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let codeDelimiter = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "\\" && source[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (source[index + run] === "`") run += 1;
      codeDelimiter = codeDelimiter === 0 ? run : codeDelimiter === run ? 0 : codeDelimiter;
      cell += "`".repeat(run);
      index += run - 1;
      continue;
    }
    if (character === "|" && codeDelimiter === 0) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function tableAlignment(cell: string): TableAlignment | null {
  if (!/^:?-{3,}:?$/.test(cell)) return null;
  if (cell.startsWith(":") && cell.endsWith(":")) return "center";
  if (cell.endsWith(":")) return "right";
  if (cell.startsWith(":")) return "left";
  return undefined;
}

function renderTable(lines: readonly string[], start: number, key: number): { node: ReactNode; next: number } | null {
  const header = splitTableRow(lines[start] ?? "");
  const separator = splitTableRow(lines[start + 1] ?? "");
  if (!header || !separator || header.length !== separator.length) return null;
  const alignments = separator.map(tableAlignment);
  if (alignments.some((alignment) => alignment === null)) return null;

  const rows: string[][] = [];
  let next = start + 2;
  while (next < lines.length && (lines[next] ?? "").trim() !== "") {
    const row = splitTableRow(lines[next] ?? "");
    if (!row || row.length !== header.length) break;
    rows.push(row);
    next += 1;
  }

  const cellStyle = (index: number): { textAlign: Exclude<TableAlignment, undefined> } | undefined => {
    const textAlign = alignments[index];
    return textAlign ? { textAlign } : undefined;
  };
  const table = h("table", { key: "table" },
    h("thead", null,
      h("tr", null, ...header.map((cell, index) => h("th", { key: index, style: cellStyle(index) }, ...inline(cell))))),
    h("tbody", null, ...rows.map((row, rowIndex) => h("tr", { key: rowIndex },
      ...row.map((cell, cellIndex) => h("td", { key: cellIndex, style: cellStyle(cellIndex) }, ...inline(cell)))))));
  return { node: h("div", { key, className: "bridle-md-table-wrap" }, table), next };
}

function copyCode(source: string): void {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
  void navigator.clipboard.writeText(source);
}

function renderCodeBlock(source: string, language: string, key: number): ReactNode {
  return h("div", { key, className: "bridle-md-code-block" },
    h("div", { className: "bridle-md-code-toolbar" },
      language ? h("span", { className: "bridle-md-code-language" }, language) : h("span", { "aria-hidden": true }),
      h("button", {
        type: "button",
        className: "bridle-md-code-copy",
        "aria-label": "Copy code",
        onClick: () => copyCode(source),
      }, "Copy")),
    h("pre", null, h("code", { ...(language ? { "data-language": language } : {}) }, source)));
}

/** Parse a Markdown document into block-level React nodes. */
function blocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const push = (node: ReactNode) => out.push(node);

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") { i += 1; continue; }

    const fence = /^```[ \t]*([^\s`]*)[^\n]*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```[ \t]*$/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      push(renderCodeBlock(code.join("\n"), fence[1] ?? "", out.length));
      continue;
    }

    const table = renderTable(lines, i, out.length);
    if (table) {
      push(table.node);
      i = table.next;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(4, (heading[1] ?? "#").length);
      push(h(`h${level}`, { key: out.length }, ...inline(heading[2] ?? "")));
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { push(h("hr", { key: out.length })); i += 1; continue; }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i += 1;
      }
      push(h("blockquote", { key: out.length }, ...inline(quote.join(" "))));
      continue;
    }

    const firstItem = LIST_RE.exec(line);
    if (firstItem) {
      const items: ListItem[] = [];
      let match: RegExpExecArray | null = firstItem;
      while (match) {
        const rawText = match[3] ?? "";
        const task = TASK_RE.exec(rawText);
        items.push({
          indent: (match[1] ?? "").length,
          ordered: /\d/.test(match[2] ?? "-"),
          text: task?.[2] ?? rawText,
          ...(task ? { task: { checked: task[1]?.toLocaleLowerCase() === "x" } } : {}),
        });
        i += 1;
        match = i < lines.length ? LIST_RE.exec(lines[i] ?? "") : null;
      }
      push(renderList(items, 0, items[0]?.indent ?? 0, out.length).node);
      continue;
    }

    const paragraph: string[] = [];
    let paragraphLine = lines[i];
    while (
      paragraphLine !== undefined && paragraphLine.trim() !== "" &&
      !HEADING_RE.test(paragraphLine) && !LIST_RE.test(paragraphLine) &&
      !/^```/.test(paragraphLine) && !/^>\s?/.test(paragraphLine)
    ) {
      paragraph.push(paragraphLine);
      i += 1;
      paragraphLine = lines[i];
    }
    push(h("p", { key: out.length }, ...inline(paragraph.join(" "))));
  }
  return out;
}

export type MarkdownProps = { text: string; className?: string };

/** Render agent-authored Markdown text as safe, formatted React nodes. */
export function Markdown({ text, className }: MarkdownProps): ReactNode {
  return h("div", { className: className ? `bridle-md ${className}` : "bridle-md" }, ...blocks(text ?? ""));
}
