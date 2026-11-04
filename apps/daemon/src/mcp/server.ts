import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  DomainError,
  McpToolInputs,
  McpToolName,
  ShapeToolInputs,
  ShapeToolName,
  type SessionId,
  type ShapeId,
  type WorkstreamId,
} from '@10db/contracts';
import { getLiveSessionByTokenHash, isLaneSession } from '@10db/db';
import { z } from 'zod';
import { GitTrustError } from '../git';
import { ParkedError } from '../inbox';
import { hashToken } from './tokens';
import { ClaimWaits } from './claim-wait';
import { SHAPE_TOOL_DESCRIPTIONS } from './shape-tools';
import { ToolImages } from './tool-images';
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

/** A tool as the endpoint registers it: its name, words, input schema and what running it does. */
interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType;
  run(input: unknown): Promise<unknown>;
}

function laneTools(
  deps: McpDeps,
  sessionId: SessionId,
  workstreamId: WorkstreamId,
  claimWaits: ClaimWaits,
): RegisteredTool[] {
  const handlers = createToolHandlers(deps, sessionId, workstreamId, claimWaits);
  return Object.values(McpToolName).map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    schema: McpToolInputs[name],
    // Each handler takes its own tool's parsed input; the registry pairs them by name.
    run: (input) => (handlers[name] as (input: unknown) => Promise<unknown>)(input),
  }));
}

/** The tools of a conversation's session, or null when 10db was given none to offer. */
function shapeTools(
  deps: McpDeps,
  sessionId: SessionId,
  shapeId: ShapeId,
): RegisteredTool[] | null {
  if (!deps.shapeTools) return null;
  const handlers = deps.shapeTools({ sessionId, shapeId });
  const tools = Object.values(ShapeToolName).flatMap((name) => {
    const handler = handlers[name] as ((input: unknown) => Promise<unknown>) | undefined;
    return handler
      ? [
          {
            name,
            description: SHAPE_TOOL_DESCRIPTIONS[name],
            schema: ShapeToolInputs[name],
            run: handler,
          },
        ]
      : [];
  });
  return tools.length > 0 ? tools : null;
}

/** Stateless streamable-HTTP MCP endpoint; the bearer token identifies the calling session. */
export function createMcpHandler(deps: McpDeps): (req: Request) => Promise<Response> {
  // Every session's claim waits in one place, so a deadlock check sees the waits of all of them.
  const claimWaits = deps.claimWaits ?? new ClaimWaits();
  return async (req) => {
    const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
    const session = token ? getLiveSessionByTokenHash(deps.state.db, hashToken(token)) : undefined;
    if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

    // A session's tool set comes from its row: a lane's tools for a workstream, a conversation's for
    // a shape. A Shape session holds no lane, claim or area, so it never gets a lane's tools.
    const tools = isLaneSession(session)
      ? laneTools(deps, session.id, session.workstreamId, claimWaits)
      : session.shapeId === null
        ? null
        : shapeTools(deps, session.id, session.shapeId);
    if (tools === null) return Response.json({ error: 'unauthorized' }, { status: 401 });

    const server = new McpServer({ name: '10db', version: '0.1.0' });
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.schema },
        async (args: unknown) => {
          try {
            const output = await tool.run(tool.schema.parse(args));
            // A tool whose result is pictures answers image blocks, which the session sees as its result.
            if (output instanceof ToolImages)
              return {
                content: [
                  { type: 'text' as const, text: output.text },
                  ...output.images.map((image) => ({
                    type: 'image' as const,
                    data: image.data,
                    mimeType: image.mediaType,
                  })),
                ],
              };
            return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
          } catch (error) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: errorText(error, deps, tool.name, args) }],
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
