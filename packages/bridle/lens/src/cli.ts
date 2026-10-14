#!/usr/bin/env node
import { openRecorder, RecorderIntegrityError } from "@bridle/core";

export interface CliIo { stdout(text: string): void; stderr(text: string): void }
const defaultIo: CliIo = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const [appDataDir, command, ...rest] = argv;
  if (!appDataDir || !command) return badArgs(io);
  const pretty = rest.includes("--pretty");
  const args = rest.filter((arg) => arg !== "--pretty");
  const pageArg = args.find((arg) => arg.startsWith("--page="));
  const page = pageArg ? Number(pageArg.slice(7)) : undefined;
  const positional = args.filter((arg) => !arg.startsWith("--page="));
  try {
    const recorder = await openRecorder(appDataDir);
    let result: unknown;
    switch (command) {
      case "turns": result = await recorder.turns({ ...(page ? { page } : {}) }); break;
      case "context":
        if (!positional[0] || !positional[1]) return badArgs(io);
        result = await recorder.contextAt(positional[0], positional[1], page);
        break;
      case "search":
        if (!positional[0]) return badArgs(io);
        result = await recorder.searchRecord(positional[0], { ...(page ? { page } : {}) });
        break;
      case "egress": result = await recorder.egress({ ...(page ? { page } : {}) }); break;
      case "costs": result = await recorder.costs({ ...(page ? { page } : {}) }); break;
      case "tree":
        if (!positional[0]) return badArgs(io);
        result = await recorder.tree(positional[0], page);
        break;
      case "export":
        if (!positional[0] || !positional[1]) return badArgs(io);
        result = { path: await recorder.exportHtml(positional[0], positional[1]) };
        break;
      default: return badArgs(io);
    }
    io.stdout(pretty ? prettyPrint(result) : `${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof RecorderIntegrityError ? 2 : 3;
  }
}

function prettyPrint(value: unknown): string {
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: unknown[] }).items.map((item) => {
      if (!item || typeof item !== "object") return String(item);
      const record = item as Record<string, unknown>;
      return [record.turnId, record.entryId, record.promptPreview, record.destination, record.model, record.costUsd]
        .filter((part) => part !== undefined).join("\t");
    }).join("\n") + "\n";
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function badArgs(io: CliIo): 3 {
  io.stderr("Usage: bridle-lens <appDataDir> turns|context|search|egress|costs|tree|export [args] [--page=N] [--pretty]\n");
  return 3;
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
