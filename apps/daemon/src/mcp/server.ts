import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { DomainError, McpToolInputs, McpToolName } from '@10db/contracts';
import { getLiveSessionByTokenHash } from '@10db/db';
import { z } from 'zod';
import { GitTrustError } from '../git';
import { ParkedError } from '../inbox';
import { hashToken } from './tokens';
import { ClaimWaits } from './claim-wait';
import { createToolHandlers, TOOL_DESCRIPTIONS, type McpDeps } from './tools';

function errorText(error: unknown, deps: McpDeps, tool: string, args: unknown): string {
  // The card stays open; its answer reaches the next session's prompt, so a retry would open a second card.
  if (error instanceof ParkedError)
    return '10db parked this session until the builder answers. Do not ask again: the answer arrives in the prompt of the session that resumes this work. End your turn now.';
  if (error instanceof DomainError) return error.message;
  // The builder already has a card about it, and only the builder can put the checkout right.
  if (error instanceof GitTrustError)
    return `${error.message}. The builder has a card about it. Don't work around it: end your turn now.`;
  if (error instanceof z.ZodError)
    return `Invalid input: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  const opId = z.object({ opId: z.string() }).safeParse(args);
  deps.log.error(
    { err: error, tool, opId: opId.success ? opId.data.opId : null },
    'mcp tool failed',
  );
  return `The ${tool} call failed inside 10db and was not completed. Check that your input is valid for the current repository state; if it keeps failing, report the problem to the builder with ask_human.`;
}

/** Stateless streamable-HTTP MCP endpoint; the bearer token identifies the calling session. */
export function createMcpHandler(deps: McpDeps): (req: Request) => Promise<Response> {
  // Every session's claim waits in one place, so a deadlock check sees the waits of all of them.
  const claimWaits = deps.claimWaits ?? new ClaimWaits();
  return async (req) => {
    const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
    const session = token ? getLiveSessionByTokenHash(deps.state.db, hashToken(token)) : undefined;
    if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

    const handlers = createToolHandlers(deps, session.id, session.workstreamId, claimWaits);
    const server = new McpServer({ name: '10db', version: '0.1.0' });
    for (const name of Object.values(McpToolName)) {
      const schema = McpToolInputs[name];
      server.registerTool(
        name,
        { description: TOOL_DESCRIPTIONS[name], inputSchema: schema },
        async (args: unknown) => {
          try {
            // Each handler takes its own tool's parsed input; the registry pairs them by name.
            const handler = handlers[name] as (input: unknown) => Promise<unknown>;
            const output = await handler(schema.parse(args));
            return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
          } catch (error) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: errorText(error, deps, name, args) }],
            };
          }
        },
      );
    }
    // No sessionIdGenerator means stateless mode; passing `undefined` explicitly fails exactOptionalPropertyTypes.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void server.close();
    }
  };
}
