// Journal text made safe to show. A planted journal line is someone else's text,
// so every path, id and name taken from the journal passes through `shown` before
// it reaches a message, an event, a log or a terminal. Internal: absent from the barrel.
import { createHash } from "node:crypto";

/** Longest shown form of a path in a list (`restored`, `notRestored`, `refusals`,
 *  operation records, the restore event). A restore refuses any journal path longer
 *  than this, so a path it reports as restored is always given whole. */
export const PATH_SHOWN_LIMIT = 1024;

/** Longest shown form of one path, id or name inside a sentence. */
export const MESSAGE_SHOWN_LIMIT = 200;

/** Control characters, line and paragraph separators, and characters that do not show. */
export const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Default_Ignorable_Code_Point}/u;
const UNSHOWABLE_ALL = new RegExp(UNSHOWABLE.source, "gu");

/**
 * `value` as text of at most `limit` characters with no control character and no
 * character that does not show (each is replaced by `?`). A text that was changed
 * in either way ends in `~` and eight hex digits of the SHA-256 of the original,
 * and a cut text keeps its beginning and its end, so two long names with the same
 * beginning, or two names that differ only in a replaced character, stay different.
 */
export function shown(value: unknown, limit: number = MESSAGE_SHOWN_LIMIT): string {
  if (typeof value !== "string") return "(not text)";
  const plain = value.replace(UNSHOWABLE_ALL, "?");
  if (plain === value && plain.length <= limit) return value;
  const mark = `~${createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
  if (plain.length + mark.length <= limit) return `${plain}${mark}`;
  const room = Math.max(limit - mark.length - 1, 2);
  const tail = Math.floor(room / 3);
  return `${plain.slice(0, room - tail)}…${plain.slice(plain.length - tail)}${mark}`;
}
