/**
 * Text piped to the command with `--stdin`: read ONCE, before the Collection's owner lock is taken or
 * a request is filed, and never more than a fixed amount of it. A pipe that never ends, or one that
 * carries more than any document, would otherwise be collected whole in memory while the command
 * held the lock and kept WriteFlex and every other `writeflex` command out.
 */
import { CliError } from './operation'

/** The most text `--stdin` takes. Larger than any request the app accepts (4 MiB) and than the review limits. */
export const MAX_STDIN_BYTES = 16 * 1024 * 1024

export const stdinTooLarge = (max: number = MAX_STDIN_BYTES): CliError =>
  new CliError(`The text piped in with --stdin is larger than the command line takes (${Math.floor(max / (1024 * 1024))} MiB, ${max} bytes). It was not read further and nothing was changed.`)

/** Everything `stream` carries, as text; refused as soon as it is known to exceed `max` bytes, with no more of it read. */
export async function readCapped(stream: AsyncIterable<Uint8Array | string>, max: number = MAX_STDIN_BYTES): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > max) throw stdinTooLarge(max)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
