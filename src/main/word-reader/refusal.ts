import type { WordRefusal, WordRefusalCode } from './types'

/** The plain sentences. None repeats anything taken from the file. */
const MESSAGES: Record<WordRefusalCode, string> = {
  'not-a-word-file': 'This is not a Word (.docx) file, so WriteFlex cannot read it.',
  'old-word-format': 'This is an older Word format (.doc). Open it in Word, save it as a .docx file, and try again.',
  'macro-enabled': 'This Word file can run macros, so WriteFlex will not open it. Save a copy as a plain .docx file in Word and try that one.',
  'password-protected': 'This file is protected with a password, so WriteFlex cannot read it. Remove the password in Word and try again.',
  'too-large': 'This file is too large for WriteFlex to read safely.',
  'too-many-parts': 'This file holds far more parts than a Word document does, so WriteFlex will not open it.',
  'zip-bomb': 'This file unpacks to far more than it should, so WriteFlex will not open it.',
  'unsafe-part-name': 'This file names a part with an unsafe path, so WriteFlex will not open it.',
  'xml-not-allowed': 'This file contains instructions that could pull in other files or inflate its own text, so WriteFlex will not open it.',
  'output-too-large': 'This file would turn into far more text than it holds, for example by repeating very long link addresses, so WriteFlex will not open it.',
  damaged: 'This Word file looks damaged, so WriteFlex cannot read it. Open and save it in Word, then try again.'
}

export function refusal(code: WordRefusalCode): WordRefusal {
  return { ok: false, code, message: MESSAGES[code] }
}

/** Thrown inside the reader and turned into a refusal at its edge, so no partial reading escapes. */
export class WordRefusalError extends Error {
  constructor(readonly code: WordRefusalCode) {
    super(MESSAGES[code])
  }
}
