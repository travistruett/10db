import { z } from 'zod';

/** A repo MCP server's name: it ends up in tool names (`mcp__<name>__*`), on cards and in flags. */
export const McpServerName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1 to 64 letters, digits, "_" or "-"');
