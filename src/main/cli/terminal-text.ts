/**
 * How the command line prints text it does not control: a file name in the Collection, a reason, a
 * reply from the app, a document's words quoted in a message.
 *
 * A terminal obeys bytes: an escape sequence can clear the screen, move the cursor over a line already
 * printed or set the window title, and a carriage return rewrites the line it is on. So "refused"
 * could be made to read "applied". Such characters must not reach a terminal raw.
 *
 * They are SHOWN, never removed. Removing hides things: two different file names print the same, the
 * plain text and the JSON disagree about a name, and nobody can tell what was there. The rule:
 *
 *  - a hidden character (a control character other than newline and tab, DEL, a C1 control, a line
 *    or paragraph separator, a bidirectional control, a byte-order mark, one of the three Unicode
 *    noncharacters this file uses as marks) is printed as `\u{hex}`, its code point in lower-case hex;
 *  - a literal backslash that stands directly before `u{` is printed as `\u{5c}`, so `\u{` in the
 *    output is always an escape and never text;
 *  - nothing else changes.
 * So the printed form is unambiguous: two different strings never print the same, and replacing every
 * `\u{hex}` by its character (`unshow`) gives back exactly the string, which is the string `--json`
 * carries. JSON output is not shown this way: it is written with those characters as JSON's own
 * `\uXXXX` escapes (`escapeForJson`), so it parses to the true value and prints nothing raw.
 *
 * Newline and tab are the structure of what an operation prints (one row per line), so they stay.
 * Inside a NAME they are not structure: a name with a newline in it would print as two rows. An
 * operation that prints a name on a line of its own wraps it with `inLine`, and there newline and tab
 * are shown as `\u{a}` and `\u{9}` too. (The marks are noncharacters; a name that contains one is
 * handled, and shown.)
 *
 * A string cut to a length ends with a marker that says how many characters were cut.
 */

const OPEN = '\ufdd0'
const CLOSE = '\ufdd1'
const MARK_ESCAPE = '\ufdd2'
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\ufdd0-\ufdd2]/g
const HIDDEN_IN_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\ufdd0-\ufdd2]/g
const RAW_IN_JSON = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\ufdd0-\ufdd2]/g
const MARKED = /\ufdd0([^\ufdd0\ufdd1]*)\ufdd1/g
const BACKSLASH_BEFORE_ESCAPE = /\\(?=u\{)/g

const escape = (character: string): string => `\\u{${character.codePointAt(0)!.toString(16)}}`
const show = (text: string, hidden: RegExp): string => text.replace(BACKSLASH_BEFORE_ESCAPE, '\\u{5c}').replace(hidden, escape)

/** Mark `name` as a name printed within one line: `showText` will show a newline or tab in it too. */
export function inLine(name: string): string {
  return `${OPEN}${name.replace(/[\ufdd0-\ufdd2]/g, (mark) => `${MARK_ESCAPE}${'abc'[mark.charCodeAt(0) - 0xfdd0]}`)}${CLOSE}`
}

/** `text` as it is printed in plain text: every hidden character shown (see the top of this file). */
export function showText(text: string): string {
  let shown = ''
  let from = 0
  for (const match of text.matchAll(MARKED)) {
    const name = match[1].replace(/\ufdd2([abc])/g, (_all, letter: string) => String.fromCharCode(0xfdd0 + 'abc'.indexOf(letter)))
    shown += show(text.slice(from, match.index), HIDDEN) + show(name, HIDDEN_IN_NAME)
    from = match.index + match[0].length
  }
  return shown + show(text.slice(from), HIDDEN)
}

/** The string a shown name stands for: every `\u{hex}` replaced by its character. The inverse of showing a name. */
export function unshow(shown: string): string {
  return shown.replace(/\\u\{([0-9a-f]{1,6})\}/g, (_all, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
}

/** `text` cut to `max` characters, ending in a marker that says how many were cut. */
export function capped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters not shown]` : text
}

/** A short piece of outside text quoted inside a message: on one line, cut to `max` with the marker, in double quotes. */
export function quoted(value: unknown, max = 120): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  return `"${inLine(text.slice(0, max))}"${text.length > max ? ` [cut: ${text.length - max} more characters not shown]` : ''}`
}

/**
 * A serialised JSON document with no raw control character left in it. `JSON.stringify` already
 * writes the C0 controls as `\uXXXX`; this does the same for DEL, the C1 controls and the Unicode
 * display controls. The document parses to exactly the same value: a file name stays the name it is.
 */
export function escapeForJson(serialised: string): string {
  return serialised.replace(RAW_IN_JSON, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
