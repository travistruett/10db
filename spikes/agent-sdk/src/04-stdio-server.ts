// A minimal stdio MCP server for spike 4's pass-through probe. Node runs this file directly (type stripping).
// It appends one JSON line to the file named by its first argument when it starts, and one per tool call, so the
// probe can tell whether a call reached the server and which environment keys Claude Code started it with.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const hits = process.argv[2] ?? 'stdio-hits.log';
const record = (line: Record<string, unknown>): void => {
  appendFileSync(hits, `${JSON.stringify(line)}\n`);
};

// Keys only, never values: the session env holds the builder's login.
record({
  event: 'start',
  path: Boolean(process.env['PATH']),
  marker: process.env['SPIKE_MARKER'] ?? null,
  sentinel: process.env['SPIKE_SESSION_SENTINEL'] ?? null,
  envKeys: Object.keys(process.env).sort(),
});
const mcp = new McpServer({ name: 'repostdio', version: '0.0.0' });
mcp.registerTool('echo', { description: 'Echoes the text back.', inputSchema: { text: z.string() } }, ({ text }) => {
  record({ event: 'call', text });
  return { content: [{ type: 'text', text: `ECHO-OK ${text}` }] };
});
await mcp.connect(new StdioServerTransport());
