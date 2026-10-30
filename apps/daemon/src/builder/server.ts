import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  BUILDER_INSTRUCTIONS,
  BuilderToolName,
  builderToolList,
  DomainError,
  refusalText,
} from '@10db/contracts';
import { z } from 'zod';
import type { Logger } from '../log';
import { createBuilderTools, type BuilderServices } from './tools';

export interface BuilderMcpDeps {
  readonly services: BuilderServices;
  readonly log: Logger;
}

const ToolName = z.enum(BuilderToolName);

function errorText(error: unknown, deps: BuilderMcpDeps, tool: string): string {
  if (error instanceof DomainError) return error.message;
  // The words the desktop shows for the API's 400, so a refusal reads the same in both.
  if (error instanceof z.ZodError) return refusalText(error.issues);
  deps.log.error({ err: error, tool }, 'builder mcp tool failed');
  return `The ${tool} call failed inside 10db and was not completed. Try again; if it keeps failing, tell the builder.`;
}

/**
 * Stateless streamable-HTTP MCP endpoint for the builder's own clients. The API guards it with the
 * UI token before it gets here. The tool handlers sit on the SDK's server so 10db parses the
 * input itself: no SDK validation text reaches the client.
 */
export function createBuilderMcpHandler(deps: BuilderMcpDeps): (req: Request) => Promise<Response> {
  const tools = createBuilderTools(deps.services);
  return async (req) => {
    const mcp = new McpServer(
      { name: '10db-builder', version: '0.1.0' },
      { capabilities: { tools: {} }, instructions: BUILDER_INSTRUCTIONS },
    );
    mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: builderToolList() }));
    mcp.server.setRequestHandler(CallToolRequestSchema, (request) => {
      const { name, arguments: args } = request.params;
      const tool = ToolName.safeParse(name);
      if (!tool.success)
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        };
      try {
        const output = tools[tool.data](args ?? {});
        return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: errorText(error, deps, name) }],
        };
      }
    });
    // No sessionIdGenerator means stateless mode; passing `undefined` explicitly fails exactOptionalPropertyTypes.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await mcp.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void mcp.close();
    }
  };
}
