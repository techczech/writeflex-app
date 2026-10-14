#!/usr/bin/env node
import { createRecorderCapabilities, openRecorder } from "@bridle/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export async function createLensMcpServer(appDataDir: string): Promise<Server> {
  const recorder = await openRecorder(appDataDir);
  const capabilities = createRecorderCapabilities(recorder);
  const server = new Server({ name: "bridle-lens", version: "0.1.1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: capabilities.map((capability) => ({
      name: capability.name, description: capability.description,
      inputSchema: capability.parameters as { type: "object"; properties?: Record<string, unknown> },
      annotations: { readOnlyHint: true },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const capability = capabilities.find((candidate) => candidate.name === request.params.name);
    if (!capability) return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
    try {
      const result = await capability.execute(request.params.arguments ?? {}, {
        trigger: { id: "mcp", source: "user", trust: "interactive" },
        sessionId: "bridle-lens-mcp", audit() {},
      });
      return { content: [{ type: "text", text: result.text }], isError: Boolean(result.isError) };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  return server;
}

if (import.meta.main) {
  const appDataDir = process.argv[2];
  if (!appDataDir) {
    process.stderr.write("Usage: bridle-lens-mcp <appDataDir>\n");
    process.exitCode = 3;
  } else {
    const server = await createLensMcpServer(appDataDir);
    await server.connect(new StdioServerTransport());
  }
}
