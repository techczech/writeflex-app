// Shared by the Worker and main; no Electron or runtime-specific imports.
export function stripPersonCharacters(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').trim()
}
export function validPersonEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && stripPersonCharacters(value) === value && /^[^\s@\x00-\x1f\x7f<>?,:;\\]+@[^\s@\x00-\x1f\x7f<>?,:;\\]+\.[^\s@\x00-\x1f\x7f<>?,:;\\]+$/.test(value)
}
