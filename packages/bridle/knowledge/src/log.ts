import { houseLogName } from "./naming.ts";

function renderSection(date: string, entries: string[]): string {
  return [`## ${date}`, ...entries.map((entry) => `- ${entry}`)].join("\n");
}

export function renderLogAppend(existing: string | null, folderName: string, date: string, entries: string[]): { path: string; content: string } {
  const title = `# ${houseLogName(folderName).replace(/\.md$/, "")}`;
  const section = renderSection(date, entries);
  const path = houseLogName(folderName);

  if (!existing) return { path, content: `${title}\n\n${section}\n` };

  const heading = `## ${date}`;
  const start = existing.indexOf(heading);
  if (start === -1) {
    const rest = existing.startsWith(`${title}\n\n`) ? existing.slice(`${title}\n\n`.length) : existing;
    return { path, content: `${title}\n\n${section}\n\n${rest}` };
  }

  const insertAt = existing.indexOf("\n", start);
  if (insertAt === -1) return { path, content: `${existing}\n${entries.map((entry) => `- ${entry}`).join("\n")}\n` };
  const additions = entries.map((entry) => `- ${entry}`).join("\n");
  return { path, content: `${existing.slice(0, insertAt + 1)}${additions}\n${existing.slice(insertAt + 1)}` };
}
