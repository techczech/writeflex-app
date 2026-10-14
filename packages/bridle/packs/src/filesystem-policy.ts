export const PACK_HASH_EXCLUDED_NAMES = new Set([".git", ".DS_Store"]);

export function isPackHashExcludedName(name: string): boolean {
  return PACK_HASH_EXCLUDED_NAMES.has(name);
}

export function isPackHashExcludedPath(path: string): boolean {
  return path.split(/[\\/]/).some(isPackHashExcludedName);
}
