const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const intrinsicByteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!
/** Exact local byte-view brand, with no property lookup through caller data. Structured cloning
 * produces this prototype; subclasses and shadowed intrinsic properties are refused. */
export function readerByteLength(value: unknown): number | null {
  try {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Uint8Array.prototype) return null
    for (const key of ['byteLength', 'length', 'buffer', 'byteOffset', Symbol.toStringTag]) {
      if (Object.getOwnPropertyDescriptor(value, key)) return null
    }
    const length: number = intrinsicByteLength.call(value)
    return length <= 256 * 1024 * 1024 ? length : null
  } catch { return null }
}
