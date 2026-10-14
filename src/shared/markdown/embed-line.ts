/**
 * The embed line rule: `[Simulation: <path>]` alone on its line is a widget (ticket 01);
 * `[Embed: …]` alone on a line is recognised and carries the `web-address` refusal, because only
 * local files are supported and a pasted TalkWeaver line must never be silent. This is the ONE
 * place a line is classified; the model (model.ts) is the one place blocks are.
 */
export type EmbedLine = { path: string; refusal?: 'web-address' }

const EMBED_LINE = /^[ \t]*\[[ \t]*(simulation|embed)[ \t]*:[ \t]*(.*?)[ \t]*\][ \t]*$/i

/** Read ONE line as an embed line, or null when it is anything else (including trailing words). */
export function embedLine(line: string): EmbedLine | null {
  const match = EMBED_LINE.exec(line)
  if (!match || match[2] === '') return null
  return match[1].toLowerCase() === 'embed' ? { path: match[2], refusal: 'web-address' } : { path: match[2] }
}
