export function houseIndexName(folderName: string): string {
  return `_INDEX-${folderName}.md`;
}

export function houseLogName(folderName: string): string {
  return `_LOG-${folderName}.md`;
}

export function resolveIndexFile(entries: string[], folderName: string): string | null {
  const house = houseIndexName(folderName);
  if (entries.includes(house)) return house;
  return entries.includes("index.md") ? "index.md" : null;
}

export function resolveLogFile(entries: string[], folderName: string): string | null {
  const house = houseLogName(folderName);
  if (entries.includes(house)) return house;
  return entries.includes("log.md") ? "log.md" : null;
}

export function isReservedFile(fileName: string): boolean {
  return fileName === "index.md" || fileName === "log.md" || /^_INDEX-.+\.md$/.test(fileName) || /^_LOG-.+\.md$/.test(fileName);
}
